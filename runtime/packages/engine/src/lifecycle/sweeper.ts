// The lifecycle sweeper (02 4.10, 7.8, ADR 0019): time passing changes a view without any event (a tool that has been open too
// long, a session that went quiet), so every `lifecycle.sweepIntervalMs` the sweeper looks at the rows whose `next_check_at` has
// passed (`idx_sessions_next_check`), probes the pid of the open ones that have a known Claude Code process, and hands the
// writer one `derive` item per row; the writer re-derives inside its own transaction and publishes a change only when the view
// changed (`viewChanged`, 02 7.1), so time passing alone never creates churn.
//
// At most 200 rows are taken per tick (02 4.7). Only sessions are swept: a derive item names its session and the writer
// re-derives it with its main agent; due rows of subagents and workflow runs wait for the next event of their session (CR-WP-35-2).
import type { Clock } from '@mcs/shared';

import { pidEvents } from '../external/pid.ts';
import type { IngestBatch, IngestItem } from '../ingest/writer.ts';
import type { RepoContext, InstanceDb } from '../db/open.ts';
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
  /** Rows per tick (default 200, 02 4.7). */
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
  const { db, clock } = ctx;
  const { writer } = deps;
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

  /** A derive item names its session through one event; the writer opens the session and applies none of the events (02 4.6). */
  function deriveItem(sessionUid: string, now: number): IngestItem {
    return {
      kind: 'derive',
      events: [{ k: 'external.job', sessionId: sessionUid, jobId: 'sweeper', state: 'derive', observedAt: now }],
      rows: [],
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
    const due = dueRows(now);
    if (due.length === 0) return;
    const items: IngestItem[] = [];
    for (const row of due) {
      if (row.claudePid !== null && row.presence === 'open') {
        const events = pidEvents([{ sessionUid: row.sessionUid, pid: row.claudePid }], now, alive);
        if (events.length > 0) {
          items.push({ kind: 'external', events, rows: [] });
          continue;
        }
      }
      items.push(deriveItem(row.sessionUid, now));
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
