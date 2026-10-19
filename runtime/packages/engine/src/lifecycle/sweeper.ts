// The lifecycle sweeper (02 4.10, 7.8, ADR 0019): time passing changes a view without any event (a tool that has been open too
// long, a session that went quiet, a subagent that stopped writing), so every `lifecycle.sweepIntervalMs` the sweeper looks at
// the rows whose `next_check_at` has passed (`idx_sessions_next_check`, `idx_agents_next_check`, `idx_workflow_runs_next_check`),
// probes the pid of the open sessions that have a known Claude Code process, and hands the writer one `derive` item per
// session. The item names the due subagents and workflow runs of that session; the writer re-derives the session inside its own
// transaction, writes the views of the named rows and publishes a change only when a view changed (`viewChanged`, 02 7.1), so
// time passing alone never creates churn (CR-WP-35-2).
//
// At most 200 sessions are taken per tick (02 4.7), and at most 200 subagents and 200 workflow runs are looked at: the earliest
// due come first, the rest wait for the next tick. A row that was derived has a new `next_check_at` after `now` (or none), so it
// is not selected again until its time has come. The main agent row mirrors its session: when it is due the session is
// re-derived and the agent is not named.
import type { Clock } from '@mcs/shared';

import type { RepoContext, InstanceDb } from '../db/open.ts';
import { AgentsRepo } from '../db/repos/agents.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { WorkflowRunsRepo } from '../db/repos/workflow-runs.ts';
import { pidEvents } from '../external/pid.ts';
import type { IngestBatch, IngestItem } from '../ingest/writer.ts';
import type { Logger } from '../log/logger.ts';
import type { ErrorRing } from '../runtime/error-ring.ts';
import { pidAlive as realPidAlive } from '../platform/process.ts';

/** The part of `InstanceContext` the sweeper reads (the context satisfies it, tests pass a plain object). */
export interface SweeperContext {
  readonly db: InstanceDb;
  readonly scope: RepoContext;
  readonly clock: Clock;
  readonly config: { readonly runtime: { readonly lifecycle: { readonly sweepIntervalMs: number } } };
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  readonly errors: Pick<ErrorRing, 'push'>;
}

/** What the sweeper needs of the one writer (the runtime passes the writer of the ingest service). */
export interface SweeperWriter {
  /** false = the queue is full and the batch was not taken. */
  submit(batch: IngestBatch): boolean;
  /** Called every time a queue that refused a batch has room again. */
  onDrain(cb: () => void): void;
}

export interface LifecycleSweeper {
  start(): void;
  /** `deadlineMs` is an absolute `clock.now()` value: stops the timer and waits for a running tick until then. */
  stop(deadlineMs: number): Promise<void>;
  /** One tick now (tests, and `ingestUntilIdle`); a call while a tick runs returns that tick. Never rejects. */
  tickNow(): Promise<void>;
}

export interface SweeperOptions {
  /** `pidAlive` of 06 4.2 (signal 0); tests pass a fake. */
  readonly pidAlive?: (pid: number) => boolean;
  /** Sessions per tick, and the most subagents and the most workflow runs looked at per tick (default 200, 02 4.7). */
  readonly maxPerTick?: number;
}

const DEFAULT_MAX_PER_TICK = 200;
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A rough size of one item in the writer queue (the queue bound counts bytes). */
const ITEM_BYTES = 200;

interface DueRow {
  readonly sessionUid: string;
  readonly claudePid: number | null;
  readonly presence: string;
}

/** What one tick does for one session: the session itself may be due, and so may some of its subagents and runs. */
interface SessionWork {
  readonly sessionUid: string;
  /** The row of the session if the session itself is due (it carries the pid to probe); null if only its children are. */
  readonly due: DueRow | null;
  readonly agents: string[];
  readonly runs: string[];
}

/** What a log line or the error ring may say about a failure: its code or its name, never its message (a path may be in it). */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

export function createLifecycleSweeper(
  ctx: SweeperContext,
  deps: { writer: SweeperWriter },
  options: SweeperOptions = {},
): LifecycleSweeper {
  const { db, clock, scope } = ctx;
  const { writer } = deps;
  const sessionsRepo = new SessionsRepo(db);
  const agentsRepo = new AgentsRepo(db);
  const runsRepo = new WorkflowRunsRepo(db);
  const intervalMs = ctx.config.runtime.lifecycle.sweepIntervalMs;
  const maxPerTick = options.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const alive = options.pidAlive ?? realPidAlive;

  let armed = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  const roomWaiters = new Set<() => void>();

  writer.onDrain(() => {
    for (const wake of [...roomWaiters]) wake();
  });

  function dueRows(now: number): DueRow[] {
    return db.driver
      .prepare<DueRow>(
        `SELECT session_uid AS sessionUid, claude_pid AS claudePid, presence FROM sessions
         WHERE next_check_at IS NOT NULL AND next_check_at <= :now ORDER BY next_check_at, id LIMIT :limit`,
      )
      .all({ now, limit: maxPerTick });
  }

  /**
   * The due work of this tick grouped by session: the sessions that are due themselves first (earliest due first), then the
   * sessions that are only due through a subagent or a workflow run. At most `maxPerTick` sessions; a child of a session that
   * did not fit stays due for the next tick.
   */
  function dueWork(now: number): SessionWork[] {
    const work = new Map<string, SessionWork>();
    for (const row of dueRows(now)) {
      work.set(row.sessionUid, { sessionUid: row.sessionUid, due: row, agents: [], runs: [] });
    }
    const agentRows = agentsRepo.dueForCheck(scope, now, maxPerTick);
    const runRows = runsRepo.dueForCheck(scope, now, maxPerTick);
    const uids = sessionsRepo.uidsByRowIds(scope, [
      ...agentRows.map((row) => row.sessionId),
      ...runRows.map((row) => row.sessionId),
    ]);
    const workOf = (sessionRowId: number): SessionWork | undefined => {
      const sessionUid = uids.get(sessionRowId);
      if (sessionUid === undefined) return undefined;
      const known = work.get(sessionUid);
      if (known !== undefined) return known;
      if (work.size >= maxPerTick) return undefined;
      const added: SessionWork = { sessionUid, due: null, agents: [], runs: [] };
      work.set(sessionUid, added);
      return added;
    };
    for (const row of agentRows) {
      // the main agent shows the state of its session: the session is re-derived and there is nothing to name
      if (row.agentUid === 'main') workOf(row.sessionId);
      else workOf(row.sessionId)?.agents.push(row.agentUid);
    }
    for (const row of runRows) workOf(row.sessionId)?.runs.push(row.runUid);
    return [...work.values()];
  }

  /**
   * The derive item of a session: the writer re-derives the session and writes the views of the named subagents and workflow
   * runs (02 4.6). It carries no event.
   */
  function deriveItem(work: SessionWork): IngestItem {
    return {
      kind: 'derive',
      events: [],
      rows: [],
      derive: {
        sessionId: work.sessionUid,
        ...(work.agents.length === 0 ? {} : { agents: work.agents }),
        ...(work.runs.length === 0 ? {} : { runs: work.runs }),
      },
    };
  }

  /** Hands the batch over; a full queue makes this wait for room. False: given up (the sweeper was stopped). */
  async function give(batch: IngestBatch): Promise<boolean> {
    while (!stopped) {
      if (writer.submit(batch)) return true;
      await new Promise<void>((resolve) => {
        roomWaiters.add(resolve);
      }).finally(() => {
        roomWaiters.clear();
      });
    }
    return false;
  }

  async function tick(): Promise<void> {
    const now = clock.now();
    const due = dueWork(now);
    if (due.length === 0) return;
    const items: IngestItem[] = [];
    for (const work of due) {
      const row = work.due;
      if (row !== null && row.claudePid !== null && row.presence === 'open') {
        // the pid probe re-derives the session through its event; the due children still need an item of their own
        const events = pidEvents([{ sessionUid: work.sessionUid, pid: row.claudePid }], now, alive);
        if (events.length > 0) {
          items.push({ kind: 'external', events, rows: [] });
          if (work.agents.length > 0 || work.runs.length > 0) items.push(deriveItem(work));
          continue;
        }
      }
      items.push(deriveItem(work));
    }
    await give({ source: 'sweeper', items, bytes: items.length * ITEM_BYTES });
  }

  function tickNow(): Promise<void> {
    if (running !== null) return running;
    const current = (async (): Promise<void> => {
      try {
        await tick();
      } catch (error) {
        ctx.logger.warn('sweeper_tick_failed', { code: errorCodeOf(error) });
        ctx.errors.push({
          source: 'lifecycle',
          code: 'SWEEPER_TICK_FAILED',
          where: 'lifecycle.sweeper',
          message: `the sweeper tick failed (${errorCodeOf(error)})`,
        });
      } finally {
        running = null;
      }
    })();
    running = current;
    return current;
  }

  function arm(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = null;
        void tickNow().then(() => {
          if (armed) arm();
        });
      },
      Math.min(intervalMs, MAX_TIMER_MS),
    );
    timer.unref();
  }

  return {
    start() {
      if (armed) return;
      armed = true;
      stopped = false;
      arm();
    },
    async stop(deadlineMs) {
      armed = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const pending = running;
      if (pending !== null) {
        // a tick that waits for room in the queue gets until the deadline; then it is abandoned
        let guard: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<void>((resolve) => {
          guard = setTimeout(resolve, Math.min(Math.max(0, deadlineMs - clock.now()), MAX_TIMER_MS));
        });
        try {
          await Promise.race([pending, expired]);
        } finally {
          if (guard !== undefined) clearTimeout(guard);
        }
      }
      stopped = true;
      for (const wake of [...roomWaiters]) wake();
    },
    tickNow,
  };
}
