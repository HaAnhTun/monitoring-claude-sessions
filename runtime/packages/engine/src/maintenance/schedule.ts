// The database background schedule (03 11.4, registry C08): `createDbScheduler(ctx)` is wrapped by the composition root as the
// component `db-scheduler`. One unref'd timer polls every second; each job has its own interval and is due when `ctx.clock`
// says so, so a test drives every timer with a `FakeClock`. Jobs run one after the other; a job that throws is reported to the
// error ring and never stops the others. `stop` clears the timer and waits for the job that is running.
//
//   liveness       every 60 s      `meta.last_alive_at`, the input of the downtime reconciliation (02 8.1)
//   health         every 5 s       the ingestion health report and its `ingest_health` row (02 8.2)
//   announcements  every 1 s       the throttled session and agent announcements (03 3.6), when the writer binds a flush
//   wal            15 min / 64 MiB `PRAGMA wal_checkpoint(PASSIVE)`
//   optimize       every 6 h       `PRAGMA optimize` (the close of a writer connection does it too)
//   alert sweep    WP-59           empty block below
//   retention      WP-60           empty block below
import { statSync } from 'node:fs';
import path from 'node:path';

import type { Clock } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import { MetaRepo } from '../db/repos/meta.ts';
import { withWriteTx } from '../db/write.ts';
import { ingestHealthEvaluatorOf } from '../health/ingest-health.ts';
import type { Logger } from '../log/logger.ts';
import type { InstanceContext } from '../runtime/context.ts';
import type { ErrorRing } from '../runtime/error-ring.ts';

/** What a log line or the error ring may say about a failure: its code or its name, never its message (a path may be in it). */
function failureCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

const POLL_MS = 1000;
const LIVENESS_MS = 60_000;
const HEALTH_MS = 5000;
const ANNOUNCE_MS = 1000;
const WAL_CHECK_MS = 60_000;
const WAL_EVERY_MS = 15 * 60_000;
const WAL_LARGE_BYTES = 64 * 1024 * 1024;
const OPTIMIZE_MS = 6 * 60 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The part of `InstanceContext` the schedule reads (the context satisfies it, tests pass a plain object). */
export interface SchedulerContext {
  readonly db: InstanceDb;
  readonly scope: RepoContext;
  readonly clock: Clock;
  readonly instanceDir: string;
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  readonly errors: Pick<ErrorRing, 'push'>;
}

/** What the health job calls (`IngestHealthEvaluator` satisfies it). */
export interface HealthRefresher {
  refresh(): Promise<unknown>;
}

/** What a test replaces: the database calls and the time between two looks at the clock. */
export interface SchedulerSeams {
  readonly evaluator: HealthRefresher;
  /** Milliseconds between two looks at the clock (default 1000). */
  readonly pollMs?: number;
  /** The size of the WAL file in bytes (default: a stat of `<workspace>/data/monitor.db-wal`). */
  readonly walBytes?: () => number;
  readonly checkpoint?: () => void | Promise<void>;
  readonly optimize?: () => void | Promise<void>;
}

export interface DbScheduler {
  start(): void;
  /** Clears the timer and waits for the job that is running. */
  stop(): Promise<void>;
}

export interface DbSchedulerHandle extends DbScheduler {
  /** Runs one job now, whatever its schedule says (tests, maintenance commands). Rejects for an unknown name. */
  runJob(name: string): Promise<void>;
}

interface ScheduledJob {
  readonly name: string;
  readonly intervalMs: number;
  /** Delay of the first run after `start` (default: one interval). */
  readonly firstAfterMs?: number;
  /** `force` is true for `runJob`: the job does its work even when its own condition says "not yet". */
  run(now: number, force: boolean): void | Promise<void>;
}

// ---- the flush of the throttled announcements --------------------------------------------------------------------------------

const activityFlushes = new WeakMap<object, () => void | Promise<void>>();

/**
 * The ingest writer binds the function that announces the activity-only updates it held back (03 3.6); the one-second job
 * of the schedule calls it. Without a binding the job does nothing.
 */
export function bindActivityFlush(ctx: object, flush: () => void | Promise<void>): void {
  activityFlushes.set(ctx, flush);
}

// ---- the scheduler -----------------------------------------------------------------------------------------------------------

function walBytesOf(ctx: SchedulerContext): number {
  try {
    return statSync(path.join(ctx.instanceDir, 'data', 'monitor.db-wal')).size;
  } catch {
    return 0;
  }
}

export function createDbSchedulerWith(ctx: SchedulerContext, seams: SchedulerSeams): DbSchedulerHandle {
  const { db, scope, clock } = ctx;
  const pollMs = seams.pollMs ?? POLL_MS;
  const meta = new MetaRepo(db);
  const walBytes = seams.walBytes ?? ((): number => walBytesOf(ctx));
  const checkpoint = seams.checkpoint ?? ((): void => void db.driver.pragma('wal_checkpoint(PASSIVE)'));
  const optimize = seams.optimize ?? ((): void => void db.driver.pragma('optimize'));
  let lastCheckpointAt = clock.now();

  const jobs: ScheduledJob[] = [
    {
      name: 'liveness',
      intervalMs: LIVENESS_MS,
      firstAfterMs: 0,
      run: () => {
        withWriteTx(db, scope, (tx) => {
          meta.set(scope, tx, 'last_alive_at', String(tx.now));
        });
      },
    },
    {
      name: 'health',
      intervalMs: HEALTH_MS,
      firstAfterMs: 0,
      run: async () => {
        await seams.evaluator.refresh();
      },
    },
    {
      name: 'announcements',
      intervalMs: ANNOUNCE_MS,
      run: async () => {
        await activityFlushes.get(ctx)?.();
      },
    },
    {
      name: 'wal',
      intervalMs: WAL_CHECK_MS,
      run: async (now, force) => {
        if (!force && now - lastCheckpointAt < WAL_EVERY_MS && walBytes() <= WAL_LARGE_BYTES) return;
        lastCheckpointAt = now;
        await checkpoint();
      },
    },
    {
      name: 'optimize',
      intervalMs: OPTIMIZE_MS,
      run: async () => {
        await optimize();
      },
    },
    // @wp-begin WP-59
    // @wp-end WP-59
    // @wp-begin WP-60
    // @wp-end WP-60
  ];

  const dueAt = new Map<string, number>();
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;

  async function runOne(job: ScheduledJob, force: boolean): Promise<void> {
    try {
      await job.run(clock.now(), force);
    } catch (error) {
      ctx.logger.warn('schedule_job_failed', {
        phase: job.name,
        code: error instanceof Error ? error.name : 'unknown',
      });
      ctx.errors.push({
        source: 'maintenance',
        code: 'SCHEDULE_JOB_FAILED',
        where: `schedule.${job.name}`,
        message: `the job ${job.name} failed (${failureCode(error)})`,
      });
    }
  }

  /** Runs the jobs that are due, one after the other; a call while a pass runs returns that pass. */
  function runDue(): Promise<void> {
    if (running !== null) return running;
    const current = (async (): Promise<void> => {
      try {
        for (const job of jobs) {
          if (!armed) return;
          const now = clock.now();
          if ((dueAt.get(job.name) ?? Number.POSITIVE_INFINITY) > now) continue;
          // the next run is fixed before the job starts, so a job that throws does not run again at once
          dueAt.set(job.name, now + job.intervalMs);
          await runOne(job, false);
        }
      } finally {
        running = null;
      }
    })();
    running = current;
    return current;
  }

  function arm(delayMs: number): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = null;
        void runDue().then(() => {
          if (armed) arm(pollMs);
        });
      },
      Math.min(delayMs, MAX_TIMER_MS),
    );
    timer.unref();
  }

  return {
    start() {
      if (armed) return;
      armed = true;
      const now = clock.now();
      lastCheckpointAt = now;
      for (const job of jobs) dueAt.set(job.name, now + (job.firstAfterMs ?? job.intervalMs));
      arm(0);
    },
    async stop() {
      armed = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (running !== null) await running;
    },
    async runJob(name) {
      const job = jobs.find((candidate) => candidate.name === name);
      if (job === undefined) throw new RangeError(`no job named ${name}`);
      await runOne(job, true);
    },
  };
}

/** The factory of the composition root (03 11.4): the health refresh uses the evaluator of the context. */
export function createDbScheduler(ctx: InstanceContext): DbScheduler {
  return createDbSchedulerWith(ctx, { evaluator: ingestHealthEvaluatorOf(ctx) });
}
