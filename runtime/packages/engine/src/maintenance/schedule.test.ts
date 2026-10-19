// The database background schedule (03 11.4): every timer runs on `ctx.clock`, a failing job never stops the others, and `stop`
// clears the timer and waits for a running job. Time is driven with a `FakeClock` and fake timers.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { RuntimeFileSchema } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_INSTANCE_ID } from '../../test/fixtures/hooks.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { MetaRepo } from '../db/repos/meta.ts';
import {
  bindActivityFlush,
  createDbSchedulerWith,
  type DbSchedulerHandle,
  type SchedulerContext,
  type SchedulerSeams,
} from './schedule.ts';

const tempDir = useTempDirs();
const SCOPE = { instanceId: FIXTURE_INSTANCE_ID };
const NOW = Date.UTC(2026, 9, 12, 8, 0, 0);
const MIN = 60_000;

const dbs: InstanceDb[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs.splice(0)) db.close();
});

interface Rig {
  readonly db: InstanceDb;
  readonly clock: FakeClock;
  readonly ctx: SchedulerContext;
  /** `ctx.errors.push` codes. */
  readonly pushed: string[];
  /** The clock time of every health refresh. */
  readonly refreshes: number[];
  scheduler(seams?: Partial<Omit<SchedulerSeams, 'evaluator'>>): DbSchedulerHandle;
  /** Lets the timer of `setTimeout(0)` fire: the first poll of a started scheduler. */
  settle(): Promise<void>;
  /** Moves the fake clock and the fake timers forward together, `step` milliseconds at a time. */
  advance(ms: number, step?: number): Promise<void>;
}

function rig(): Rig {
  const root = tempDir('schedule').path;
  const clock = new FakeClock(NOW);
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = openInstanceDb({
    path: path.join(root, 'data', 'monitor.db'),
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  dbs.push(db);
  const pushed: string[] = [];
  const refreshes: number[] = [];
  const ctx: SchedulerContext = {
    db,
    scope: SCOPE,
    clock,
    config: { runtime: RuntimeFileSchema.parse({ schema_version: 1 }) },
    instanceDir: root,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    errors: {
      push: (entry) => {
        pushed.push(entry.code);
      },
    },
  };
  return {
    db,
    clock,
    ctx,
    pushed,
    refreshes,
    scheduler: (seams = {}) =>
      createDbSchedulerWith(ctx, {
        evaluator: {
          refresh: () => {
            refreshes.push(clock.now());
            return Promise.resolve(null);
          },
        },
        ...seams,
      }),
    settle: async () => {
      await vi.advanceTimersByTimeAsync(0);
    },
    advance: async (ms, step = 1000) => {
      for (let left = ms; left > 0; left -= step) {
        const by = Math.min(step, left);
        clock.advance(by);
        await vi.advanceTimersByTimeAsync(by);
      }
    },
  };
}

describe('createDbSchedulerWith', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('runs the liveness mark at start and then every 60 s, on the clock of the context', async () => {
    const r = rig();
    const scheduler = r.scheduler();
    scheduler.start();
    await r.settle();
    const meta = new MetaRepo(r.db);
    expect(meta.get(SCOPE, 'last_alive_at')).toBe(String(NOW));
    await r.advance(59_000);
    expect(meta.get(SCOPE, 'last_alive_at')).toBe(String(NOW));
    await r.advance(1000);
    expect(meta.get(SCOPE, 'last_alive_at')).toBe(String(NOW + MIN));
    await scheduler.stop();
  });

  it('refreshes the ingestion health at start and every 5 s', async () => {
    const r = rig();
    const scheduler = r.scheduler();
    scheduler.start();
    await r.settle();
    await r.advance(20_000);
    expect(r.refreshes).toEqual([NOW, NOW + 5000, NOW + 10_000, NOW + 15_000, NOW + 20_000]);
    await scheduler.stop();
  });

  it('flushes the throttled announcements every second once something is bound', async () => {
    const r = rig();
    const scheduler = r.scheduler();
    let flushes = 0;
    bindActivityFlush(r.ctx, () => {
      flushes += 1;
    });
    scheduler.start();
    await r.settle();
    await r.advance(5000);
    expect(flushes).toBe(5);
    await scheduler.stop();
  });

  it('does nothing for the announcements while nothing is bound', async () => {
    const r = rig();
    const scheduler = r.scheduler();
    scheduler.start();
    await r.settle();
    await r.advance(3000);
    expect(r.pushed).toEqual([]);
    await scheduler.stop();
  });

  it('checkpoints the WAL every 15 minutes, or at once when it exceeds 64 MiB', async () => {
    const r = rig();
    let wal = 0;
    const checkpoints: number[] = [];
    const scheduler = r.scheduler({
      pollMs: MIN,
      walBytes: () => wal,
      checkpoint: () => {
        checkpoints.push(r.clock.now());
      },
    });
    scheduler.start();
    await r.settle();
    await r.advance(14 * MIN, MIN);
    expect(checkpoints).toEqual([]);
    wal = 64 * 1024 * 1024 + 1;
    await r.advance(MIN, MIN);
    expect(checkpoints).toEqual([NOW + 15 * MIN]);
    wal = 0;
    await r.advance(14 * MIN, MIN);
    expect(checkpoints).toHaveLength(1);
    await r.advance(MIN, MIN);
    expect(checkpoints).toEqual([NOW + 15 * MIN, NOW + 30 * MIN]);
    await scheduler.stop();
  });

  it('checkpoints early when the WAL grows large between two quarter hours', async () => {
    const r = rig();
    let wal = 0;
    const checkpoints: number[] = [];
    const scheduler = r.scheduler({
      pollMs: MIN,
      walBytes: () => wal,
      checkpoint: () => {
        checkpoints.push(r.clock.now());
      },
    });
    scheduler.start();
    await r.settle();
    await r.advance(3 * MIN, MIN);
    wal = 65 * 1024 * 1024;
    await r.advance(MIN, MIN);
    expect(checkpoints).toEqual([NOW + 4 * MIN]);
    await scheduler.stop();
  });

  it('optimizes every 6 hours', async () => {
    const r = rig();
    let optimizes = 0;
    const scheduler = r.scheduler({
      pollMs: MIN,
      optimize: () => {
        optimizes += 1;
      },
    });
    scheduler.start();
    await r.settle();
    await r.advance(5 * 60 * MIN, MIN);
    expect(optimizes).toBe(0);
    await r.advance(60 * MIN, MIN);
    expect(optimizes).toBe(1);
    await scheduler.stop();
  });

  it('keeps going when a job fails and reports the failure by job name', async () => {
    const r = rig();
    const scheduler = r.scheduler({
      pollMs: MIN,
      optimize: () => {
        throw new Error('FIXTURE optimize failed');
      },
    });
    scheduler.start();
    await r.settle();
    await r.advance(6 * 60 * MIN + 5 * MIN, MIN);
    expect(r.pushed).toEqual(['SCHEDULE_JOB_FAILED']);
    // the other jobs went on after the failure
    expect(r.refreshes.some((at) => at > NOW + 6 * 60 * MIN)).toBe(true);
    await scheduler.stop();
  });

  it('stop clears every timer and no job runs afterwards', async () => {
    const r = rig();
    const scheduler = r.scheduler();
    scheduler.start();
    await r.settle();
    await r.advance(2000);
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    const before = r.refreshes.length;
    await r.advance(30_000);
    expect(r.refreshes.length).toBe(before);
  });

  it('stop waits for a job that is running', async () => {
    const r = rig();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = r.scheduler({ pollMs: MIN, optimize: () => gate });
    scheduler.start();
    await r.settle();
    await r.advance(6 * 60 * MIN, MIN);
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('start twice runs one timer chain', async () => {
    const r = rig();
    const scheduler = r.scheduler();
    scheduler.start();
    scheduler.start();
    await r.settle();
    await r.advance(5000);
    expect(r.refreshes).toEqual([NOW, NOW + 5000]);
    await scheduler.stop();
  });

  it('runs the real checkpoint and optimize on a database without error', async () => {
    const r = rig();
    const scheduler = r.scheduler();
    await expect(scheduler.runJob('wal')).resolves.toBeUndefined();
    await expect(scheduler.runJob('optimize')).resolves.toBeUndefined();
    expect(r.pushed).toEqual([]);
  });

  it('refuses a job name it does not have', async () => {
    const r = rig();
    await expect(r.scheduler().runJob('unknown')).rejects.toThrow(/no job named/);
  });
});

describe('the shared file', () => {
  it('holds the empty marker blocks of WP-59 (alert sweep) and WP-60 (bookkeeping retention) in order', () => {
    const text = readFileSync(new URL('./schedule.ts', import.meta.url), 'utf8');
    const markers = [...text.matchAll(/\/\/ @wp-(begin|end) (WP-\d+)/g)].map((m) => `${m[1] ?? ''} ${m[2] ?? ''}`);
    expect(markers).toEqual(['begin WP-59', 'end WP-59', 'begin WP-60', 'end WP-60']);
  });
});
