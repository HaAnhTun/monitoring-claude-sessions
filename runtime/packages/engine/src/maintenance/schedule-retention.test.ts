// The `retention` job of the schedule and the binding of jobs whose work comes later (03 11.4, WP-60): the job runs 60 s after
// start and then every 6 h on the clock of the context, a failing run is reported and does not stop the other jobs, and a stop
// ends a run in progress at its next batch. `bindScheduledJob` and `boundRun` are the way the alert sweep (WP-59) attaches its work.
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { RuntimeFileSchema } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_INSTANCE_ID } from '../../test/fixtures/hooks.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { MetaRepo } from '../db/repos/meta.ts';
import { bindScheduledJob, boundRun, createDbSchedulerWith, type SchedulerContext } from './schedule.ts';

const tempDir = useTempDirs();
const SCOPE = { instanceId: FIXTURE_INSTANCE_ID };
const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const dbs: InstanceDb[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs.splice(0)) db.close();
});

interface Rig {
  readonly db: InstanceDb;
  readonly clock: FakeClock;
  readonly ctx: SchedulerContext;
  readonly pushed: string[];
  readonly logged: { event: string; fields: unknown }[];
  scheduler(): ReturnType<typeof createDbSchedulerWith>;
  advance(ms: number, step?: number): Promise<void>;
  /** A hook probe committed `ageMs` before now; the retention removes those older than 24 h. */
  probe(n: number, ageMs: number): void;
  probes(): number;
}

function rig(): Rig {
  const root = tempDir('schedule-retention').path;
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
  const logged: { event: string; fields: unknown }[] = [];
  const ctx: SchedulerContext = {
    db,
    scope: SCOPE,
    clock,
    config: { runtime: RuntimeFileSchema.parse({ schema_version: 1 }) },
    instanceDir: root,
    logger: {
      debug: () => undefined,
      info: (event, fields) => {
        logged.push({ event, fields });
      },
      warn: () => undefined,
      error: () => undefined,
    },
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
    logged,
    scheduler: () => createDbSchedulerWith(ctx, { evaluator: { refresh: () => Promise.resolve(null) } }),
    advance: async (ms, step = 1000) => {
      for (let left = ms; left > 0; left -= step) {
        const by = Math.min(step, left);
        clock.advance(by);
        await vi.advanceTimersByTimeAsync(by);
      }
    },
    probe: (n, ageMs) => {
      const uid = `eeeeeeee-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
      db.driver
        .prepare('INSERT INTO hook_probes (probe_session_id, received_at, committed_at) VALUES (?, ?, ?)')
        .run([uid, clock.now() - ageMs, clock.now() - ageMs]);
    },
    probes: () => db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM hook_probes').get()?.n ?? -1,
  };
}

describe('the retention job', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('runs 60 s after start, then every 6 h, on the clock of the context', async () => {
    const r = rig();
    r.probe(1, 48 * HOUR);
    const scheduler = r.scheduler();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.advance(59_000);
    expect(r.probes()).toBe(1);
    await r.advance(1000);
    expect(r.probes()).toBe(0);

    // a probe that goes stale after the first run waits for the next one, 6 h after the first
    await r.advance(HOUR);
    r.probe(2, 48 * HOUR);
    await r.advance(5 * HOUR - MIN - 1000);
    expect(r.clock.now()).toBe(NOW + 6 * HOUR - 1000);
    expect(r.probes()).toBe(1);
    await r.advance(1000);
    expect(r.probes()).toBe(1);
    await r.advance(MIN);
    expect(r.probes()).toBe(0);
    await scheduler.stop();
  });

  it('says what it removed in one log line, and nothing when there was nothing to remove', async () => {
    const r = rig();
    const scheduler = r.scheduler();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.advance(MIN);
    expect(r.logged.filter((line) => line.event === 'retention_done')).toEqual([]);
    r.probe(1, 48 * HOUR);
    r.probe(2, 48 * HOUR);
    await r.advance(6 * HOUR);
    const done = r.logged.filter((line) => line.event === 'retention_done');
    expect(done).toHaveLength(1);
    expect(done[0]?.fields).toMatchObject({ count: 2 });
    await scheduler.stop();
  });

  it('reports a failing run to the error ring and goes on with the other jobs', async () => {
    const r = rig();
    r.db.driver.exec('DROP TABLE hook_probes');
    const scheduler = r.scheduler();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.advance(MIN);
    expect(r.pushed).toEqual(['SCHEDULE_JOB_FAILED']);
    // the liveness mark of the same minute was written
    expect(new MetaRepo(r.db).get(SCOPE, 'last_alive_at')).toBe(String(NOW + MIN));
    await scheduler.stop();
  });

  it('runJob runs it at once, whatever the schedule says', async () => {
    const r = rig();
    r.probe(1, 48 * HOUR);
    await r.scheduler().runJob('retention');
    expect(r.probes()).toBe(0);
  });
});

describe('a stop in the middle of a run', () => {
  it('ends the run at its next batch; what was removed stays and nothing is reported', async () => {
    const r = rig();
    const insert = r.db.driver.prepare(
      "INSERT INTO changes (at, kind, op, payload) VALUES (?, 'health', 'upsert', '{}')",
    );
    r.db.driver.transaction(() => {
      for (let i = 0; i < 12_000; i += 1) insert.run([NOW - 48 * HOUR]);
    });
    const scheduler = r.scheduler();

    // the first batch of 5,000 is deleted before the run yields; the stop then ends it before the second
    const running = scheduler.runJob('retention');
    const stopping = scheduler.stop();
    await Promise.all([running, stopping]);

    const left = r.db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM changes').get()?.n ?? -1;
    expect(left).toBe(7000);
    expect(r.pushed).toEqual([]);
  });
});

describe('bindScheduledJob', () => {
  it('a job declared with boundRun does nothing until its owner binds the work, then calls the latest binding', async () => {
    const owner = {};
    const calls: string[] = [];
    const run = boundRun(owner, 'sweep');
    await run(1000, false);
    bindScheduledJob(owner, 'sweep', (now, force) => {
      calls.push(`first ${String(now)} ${String(force)}`);
    });
    await run(2000, true);
    bindScheduledJob(owner, 'sweep', (now) => {
      calls.push(`second ${String(now)}`);
    });
    await run(3000, false);
    // another owner and another name are separate bindings
    await boundRun({}, 'sweep')(4000, false);
    await boundRun(owner, 'other')(5000, false);
    expect(calls).toEqual(['first 2000 true', 'second 3000']);
  });
});
