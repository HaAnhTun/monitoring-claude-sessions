// The `alerts` job of the schedule (03 10.2, 11.4, WP-59): it wakes every 15 s, first 10 s after start, on the clock of the context,
// and does nothing until the alert service binds its work; the service then sweeps once `alerts.sweepSeconds` have passed.
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { RuntimeFileSchema } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_INSTANCE_ID } from '../../test/fixtures/hooks.ts';
import { createAlertService } from '../alerts/service.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { bindScheduledJob, createDbSchedulerWith, type SchedulerContext } from './schedule.ts';

const tempDir = useTempDirs();
const SCOPE = { instanceId: FIXTURE_INSTANCE_ID };
const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);

const dbs: InstanceDb[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs.splice(0)) db.close();
});

function rig(alerts: Record<string, unknown> = {}): {
  readonly ctx: SchedulerContext;
  readonly clock: FakeClock;
  readonly db: InstanceDb;
  readonly pushed: string[];
  advance(ms: number, step?: number): Promise<void>;
} {
  const root = tempDir('schedule-alerts').path;
  const clock = new FakeClock(NOW);
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = openInstanceDb({
    path: path.join(root, 'data', 'monitor.db'),
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '4.0.0',
    clock,
  });
  dbs.push(db);
  const pushed: string[] = [];
  const ctx: SchedulerContext = {
    db,
    scope: SCOPE,
    clock,
    config: { runtime: RuntimeFileSchema.parse({ schema_version: 1, alerts }) },
    instanceDir: root,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    errors: {
      push: (entry) => {
        pushed.push(entry.code);
      },
    },
  };
  return {
    ctx,
    clock,
    db,
    pushed,
    advance: async (ms, step = 1000) => {
      for (let left = ms; left > 0; left -= step) {
        const by = Math.min(step, left);
        clock.advance(by);
        await vi.advanceTimersByTimeAsync(by);
      }
    },
  };
}

function scheduler(ctx: SchedulerContext): ReturnType<typeof createDbSchedulerWith> {
  return createDbSchedulerWith(ctx, { evaluator: { refresh: () => Promise.resolve(null) } });
}

describe('the alerts job', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('first runs 10 s after start and then every 15 s, with the clock time and without force', async () => {
    const r = rig();
    const calls: { at: number; force: boolean }[] = [];
    bindScheduledJob(r.ctx, 'alerts', (now, force) => {
      calls.push({ at: now - NOW, force });
    });
    const handle = scheduler(r.ctx);
    handle.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.advance(9000);
    expect(calls).toEqual([]);
    await r.advance(1000);
    await r.advance(45_000);
    expect(calls).toEqual([
      { at: 10_000, force: false },
      { at: 25_000, force: false },
      { at: 40_000, force: false },
      { at: 55_000, force: false },
    ]);
    await handle.stop();
  });

  it('does nothing before the service binds its work, and runJob forces a run', async () => {
    const r = rig();
    const handle = scheduler(r.ctx);
    handle.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.advance(30_000);
    expect(r.pushed).toEqual([]);
    const calls: boolean[] = [];
    bindScheduledJob(r.ctx, 'alerts', (_now, force) => {
      calls.push(force);
    });
    await handle.runJob('alerts');
    expect(calls).toEqual([true]);
    await handle.stop();
  });

  it('sweeps through the service once alerts.sweepSeconds have passed: 10 s after start, then every 60 s', async () => {
    const r = rig();
    const sweeps: number[] = [];
    const service = createAlertService(
      {
        db: r.db,
        scope: SCOPE,
        clock: r.clock,
        config: r.ctx.config,
        instanceDir: r.ctx.instanceDir,
        logger: r.ctx.logger,
        errors: r.ctx.errors,
        health: () => null,
      },
      {
        evaluate: (rule) => {
          if (rule.kind === 'hook_gap') sweeps.push(r.clock.now() - NOW);
          return [];
        },
      },
    );
    bindScheduledJob(r.ctx, 'alerts', (now, force) => {
      service.sweepIfDue(now, force);
    });
    const handle = scheduler(r.ctx);
    handle.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.advance(140_000);
    expect(sweeps).toEqual([10_000, 70_000, 130_000]);
    expect(r.pushed).toEqual([]);
    await handle.stop();
  });

  it('keeps a failing sweep from stopping the other jobs and reports it', async () => {
    const r = rig();
    bindScheduledJob(r.ctx, 'alerts', () => {
      throw new Error('sweep boom');
    });
    const handle = scheduler(r.ctx);
    handle.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.advance(11_000);
    expect(r.pushed).toEqual(['SCHEDULE_JOB_FAILED']);
    await handle.stop();
  });
});
