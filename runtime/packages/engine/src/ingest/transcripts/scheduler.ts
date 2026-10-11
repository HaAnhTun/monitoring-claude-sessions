// The import scheduler (02 5.4, ADR 0015): parsing stays on the main thread, in slices of `import.sliceMs` that are separated by a
// turn of the event loop, so HTTP, SSE and timers are served between any two slices.
//
//   priorities   P0 spool drain | P1 tail of files that grew | P2 head of newly seen files | P3 backfill
//   stat cycle   every `scanIntervalMs`: async stat of the tracked files, which marks the P1 work
//   discovery    every `discoveryIntervalMs`, and at once on a hint (a session id from a hook)
//   backfill     at most `backfillShare` of the wall time: after a backfill slice of c ms the next one waits c (1 - s) / s ms
//
// The importer is a port (`ImporterPort`), which the real importer satisfies; the tests drive the rules of choice and of time with
// a fake one and a fake clock. `step()` is one scheduling decision, `start()` only runs `step()` in a loop with the two timers.
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn, setTimeout as sleepFor } from 'node:timers/promises';

import type { Logger } from '../../log/logger.ts';
import type { ImportWork, SliceOutcome } from './importer.ts';

/** What the scheduler needs from the importer (`TranscriptImporter` has all of it). */
export interface ImporterPort {
  work(): ImportWork[];
  runSlice(work: ImportWork, deadline: number): Promise<SliceOutcome>;
  statTick(): Promise<void>;
  discover(): Promise<unknown>;
  discoverSession(sessionId: string): Promise<boolean>;
  isIdle(): boolean;
}

/** P0: the spool drain. The ingest service passes the drainer; the scheduler gives it the first turn whenever it has lines. */
export interface SpoolPort {
  pending(): boolean;
  run(): Promise<void>;
}

export interface ImportSchedulerOptions {
  readonly importer: ImporterPort;
  /** `import.sliceMs`. */
  readonly sliceMs: number;
  /** `import.scanIntervalMs`. */
  readonly scanIntervalMs: number;
  /** `import.discoveryIntervalMs`. */
  readonly discoveryIntervalMs: number;
  /** `import.backfillShare`, 0.05..1. */
  readonly backfillShare: number;
  readonly spool?: SpoolPort;
  readonly logger?: Logger;
  /** A `performance.now()` source (milliseconds); tests pass a fake. */
  readonly now?: () => number;
}

export type StepResult =
  | { readonly kind: 'ran' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'throttled'; readonly waitMs: number }
  | { readonly kind: 'failed' };

export interface SchedulerStats {
  /** Slices that ran to the end. */
  slices: number;
  /** Slices (or ticks) that threw: logged by code, never rethrown. */
  failures: number;
  /** Bytes the slices passed. */
  bytes: number;
  /** Slices of priority 3 that waited for their share. */
  throttled: number;
}

export interface ImportScheduler {
  /** Runs the first discovery and stat cycle, then the loop and the two timers. Calling it again is a no-op. */
  start(): void;
  /** Stops the timers and the loop after the slice in progress; resolves when the loop has ended. */
  stop(): Promise<void>;
  /** A session id from a hook payload: discover that session folder at once. */
  hint(sessionId: string): void;
  /** Wakes an idle loop (new work may have appeared). */
  wake(): void;
  /** One scheduling decision: the spool, else the best slice, else idle or throttled. */
  step(): Promise<StepResult>;
  stats(): Readonly<SchedulerStats>;
}

/**
 * The next slice: the lowest priority number, round-robin inside it (the file after the one served last, else the first), and
 * no backfill while it is not allowed. `lastServed` maps a priority to the file id served last.
 */
export function pickWork(
  list: readonly ImportWork[],
  lastServed: ReadonlyMap<number, number>,
  backfillAllowed: boolean,
): ImportWork | null {
  for (const priority of [1, 2, 3] as const) {
    if (priority === 3 && !backfillAllowed) continue;
    const same = list.filter((w) => w.priority === priority).sort((a, b) => a.fileId - b.fileId);
    if (same.length === 0) continue;
    const last = lastServed.get(priority);
    return (last === undefined ? undefined : same.find((w) => w.fileId > last)) ?? same[0] ?? null;
  }
  return null;
}

/** Longest single sleep of a throttled loop: a timer that is cleared by `stop` at the latest this late. */
const MAX_THROTTLE_SLEEP_MS = 100;
/** After a failure the loop waits this long, so a slice that throws every time does not spin. */
const FAILURE_PAUSE_MS = 100;

export function createImportScheduler(options: ImportSchedulerOptions): ImportScheduler {
  const { importer, sliceMs, spool, logger } = options;
  const now = options.now ?? ((): number => performance.now());
  const share = Math.min(1, Math.max(0.05, options.backfillShare));
  const stats: SchedulerStats = { slices: 0, failures: 0, bytes: 0, throttled: 0 };
  const lastServed = new Map<number, number>();
  let backfillNotBefore = Number.NEGATIVE_INFINITY;
  let running = false;
  let stopped = true;
  let loop: Promise<void> | null = null;
  const timers = new Map<string, NodeJS.Timeout>();
  const sleepers = new Set<() => void>();

  function fail(event: string, error: unknown): void {
    stats.failures += 1;
    logger?.warn(event, { code: error instanceof Error ? error.name : 'unknown' });
  }

  function wake(): void {
    for (const resume of [...sleepers]) resume();
  }

  /** Sleeps until `wake()` or `ms` have passed, whichever comes first (a stopped scheduler does not sleep). */
  async function idleWait(ms: number): Promise<void> {
    if (stopped) return;
    const timer = new AbortController();
    let resume: () => void = () => undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          resume = resolve;
          sleepers.add(resolve);
        }),
        sleepFor(ms, undefined, { ref: false, signal: timer.signal }).catch(() => undefined),
      ]);
    } finally {
      timer.abort();
      sleepers.delete(resume);
    }
  }

  /** One scheduling decision. It never throws: whatever the spool, the importer or the clock does is counted and answered with `failed`. */
  async function step(): Promise<StepResult> {
    try {
      return await decide();
    } catch (error) {
      fail('import_work_failed', error);
      return { kind: 'failed' };
    }
  }

  async function decide(): Promise<StepResult> {
    if (spool?.pending() === true) {
      try {
        await spool.run();
        return { kind: 'ran' };
      } catch (error) {
        fail('import_spool_failed', error);
        return { kind: 'failed' };
      }
    }
    const list = importer.work();
    const t = now();
    const allowed = t >= backfillNotBefore;
    const next = pickWork(list, lastServed, allowed);
    if (next === null) {
      if (!allowed && list.some((w) => w.priority === 3)) {
        stats.throttled += 1;
        return { kind: 'throttled', waitMs: backfillNotBefore - t };
      }
      return { kind: 'idle' };
    }
    lastServed.set(next.priority, next.fileId);
    const started = now();
    try {
      const outcome = await importer.runSlice(next, started + sliceMs);
      stats.slices += 1;
      stats.bytes += outcome.bytes;
    } catch (error) {
      fail('import_slice_failed', error);
      return { kind: 'failed' };
    } finally {
      if (next.priority === 3) {
        const ended = now();
        backfillNotBefore = ended + ((ended - started) * (1 - share)) / share;
      }
    }
    return { kind: 'ran' };
  }

  async function tick(event: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      fail(event, error);
    }
    wake();
  }

  async function run(): Promise<void> {
    await tick('import_discovery_failed', () => importer.discover());
    await tick('import_stat_failed', () => importer.statTick());
    while (!stopped) {
      const result = await step();
      if (result.kind === 'ran') {
        await nextTurn();
      } else if (result.kind === 'throttled') {
        await idleWait(Math.min(result.waitMs, MAX_THROTTLE_SLEEP_MS));
      } else if (result.kind === 'failed') {
        await idleWait(FAILURE_PAUSE_MS);
      } else {
        await idleWait(options.scanIntervalMs);
      }
    }
  }

  function every(name: string, ms: number, event: string, fn: () => Promise<unknown>): void {
    const arm = (): void => {
      const timer = setTimeout(() => {
        void tick(event, fn).finally(() => {
          if (!stopped) arm();
        });
      }, ms);
      timer.unref();
      timers.set(name, timer);
    };
    arm();
  }

  return {
    start() {
      if (running) return;
      running = true;
      stopped = false;
      loop = run().finally(() => {
        running = false;
      });
      every('stat', options.scanIntervalMs, 'import_stat_failed', () => importer.statTick());
      every('discovery', options.discoveryIntervalMs, 'import_discovery_failed', () => importer.discover());
    },
    async stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      wake();
      await loop;
      loop = null;
    },
    hint(sessionId) {
      void tick('import_hint_failed', () => importer.discoverSession(sessionId));
    },
    wake,
    step,
    stats: () => ({ ...stats }),
  };
}
