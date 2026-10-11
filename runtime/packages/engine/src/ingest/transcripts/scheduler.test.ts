// The import scheduler (02 5.4, ADR 0015): one loop on the main thread that picks the next slice by priority, gives it a
// time budget, yields to the event loop after it, and keeps the backfill to its share of the wall time. The importer behind
// it is a port here, so the rules of choice and of time are tested without a database.
import { appendFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';

import {
  FakeClock,
  TranscriptBuilder,
  bigTranscript,
  buildClaudeHome,
  eventLoopLagProbe,
  useTempDirs,
  waitFor,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { FIXTURE_INSTANCE_ID } from '../../../test/fixtures/hook-sequences.ts';
import { openInstanceDb, type InstanceDb } from '../../db/open.ts';
import { createIngestWriter, type IngestWriterHandle } from '../writer.ts';
import { createTranscriptImporter, type ImportWork, type SliceOutcome, type TranscriptImporter } from './importer.ts';
import { createImportScheduler, pickWork, type ImporterPort, type ImportScheduler } from './scheduler.ts';

const work = (fileId: number, priority: 1 | 2 | 3): ImportWork => ({
  fileId,
  priority,
  phase: priority === 1 ? 'tail' : priority === 2 ? 'head' : 'backfill',
});

describe('pickWork', () => {
  it('takes the highest priority: tail before head before backfill', () => {
    const list = [work(1, 3), work(2, 2), work(3, 1), work(4, 3)];
    expect(pickWork(list, new Map(), true)?.fileId).toBe(3);
    expect(
      pickWork(
        list.filter((w) => w.priority > 1),
        new Map(),
        true,
      )?.fileId,
    ).toBe(2);
    expect(
      pickWork(
        list.filter((w) => w.priority > 2),
        new Map(),
        true,
      )?.fileId,
    ).toBe(1);
  });

  it('goes round-robin inside a priority', () => {
    const list = [work(5, 1), work(7, 1), work(9, 1)];
    const last = new Map<number, number>();
    const order: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const next = pickWork(list, last, true);
      if (next === null) throw new Error('nothing picked');
      order.push(next.fileId);
      last.set(next.priority, next.fileId);
    }
    expect(order).toEqual([5, 7, 9, 5, 7, 9]);
  });

  it('keeps going with a file that is still the only one, and skips backfill while it is not allowed', () => {
    const only = [work(4, 1)];
    expect(pickWork(only, new Map([[1, 4]]), true)?.fileId).toBe(4);
    expect(pickWork([work(1, 3)], new Map(), false)).toBeNull();
    expect(pickWork([work(1, 3), work(2, 2)], new Map(), false)?.fileId).toBe(2);
    expect(pickWork([], new Map(), true)).toBeNull();
  });
});

interface FakeImporter extends ImporterPort {
  readonly log: string[];
  queue: ImportWork[];
  elapsed: (w: ImportWork) => number;
  slow: Promise<void> | null;
}

function fakeImporter(queue: ImportWork[], clock: { t: number }): FakeImporter {
  const self: FakeImporter = {
    log: [],
    queue,
    elapsed: () => 0,
    slow: null,
    work: () => [...self.queue],
    runSlice: async (w, deadline): Promise<SliceOutcome> => {
      self.log.push(`slice:${String(w.fileId)}:${w.phase}:${String(deadline - clock.t)}`);
      clock.t += self.elapsed(w);
      if (self.slow !== null) await self.slow;
      self.queue = self.queue.filter((x) => x !== w);
      return { progressed: true, bytes: 100 };
    },
    statTick: () => {
      self.log.push('stat');
      return Promise.resolve();
    },
    discover: () => {
      self.log.push('discover');
      return Promise.resolve(undefined);
    },
    discoverSession: (id) => {
      self.log.push(`hint:${id}`);
      return Promise.resolve(true);
    },
    isIdle: () => self.queue.length === 0,
  };
  return self;
}

const schedulers: ImportScheduler[] = [];
afterEach(async () => {
  for (const s of schedulers.splice(0)) await s.stop();
});

function scheduler(
  importer: ImporterPort,
  clock: { t: number },
  over: Partial<Parameters<typeof createImportScheduler>[0]> = {},
): ImportScheduler {
  const s = createImportScheduler({
    importer,
    sliceMs: 20,
    scanIntervalMs: 1000,
    discoveryIntervalMs: 5000,
    backfillShare: 0.25,
    now: () => clock.t,
    ...over,
  });
  schedulers.push(s);
  return s;
}

describe('step: one decision of the scheduler', () => {
  it('runs the highest priority with a deadline of now + sliceMs', async () => {
    const clock = { t: 1000 };
    const imp = fakeImporter([work(1, 3), work(2, 2), work(3, 1)], clock);
    const s = scheduler(imp, clock);
    expect(await s.step()).toEqual({ kind: 'ran' });
    expect(imp.log).toEqual(['slice:3:tail:20']);
    await s.step();
    await s.step();
    expect(imp.log.map((l) => l.split(':').slice(0, 3).join(':'))).toEqual([
      'slice:3:tail',
      'slice:2:head',
      'slice:1:backfill',
    ]);
    expect(await s.step()).toEqual({ kind: 'idle' });
  });

  it('lets the backfill use its share of the wall time and no more', async () => {
    const clock = { t: 0 };
    const imp = fakeImporter([work(1, 3), work(2, 3), work(3, 3)], clock);
    imp.elapsed = () => 20; // every backfill slice takes 20 ms of the wall time
    const s = scheduler(imp, clock);
    // the bucket starts with one slice of allowance: the first slice runs at once
    expect(await s.step()).toEqual({ kind: 'ran' });
    // 20 ms were used and 0.25 x 20 ms came back: 15 ms of debt must be paid first
    const second = await s.step();
    expect(second.kind).toBe('throttled');
    expect(second.kind === 'throttled' ? second.waitMs : 0).toBeCloseTo(60, 5);
    clock.t += 59;
    expect((await s.step()).kind).toBe('throttled');
    clock.t += 2;
    expect((await s.step()).kind).toBe('ran');
    // over a long run the backfill takes 25 % of the time: 3 slices of 20 ms need about 240 ms
    clock.t += 1000;
    expect((await s.step()).kind).toBe('ran');
  });

  it('does not throttle tail and head work, and a full share means no throttling at all', async () => {
    const clock = { t: 0 };
    const imp = fakeImporter([work(1, 1), work(2, 1), work(3, 2), work(4, 3), work(5, 3)], clock);
    imp.elapsed = () => 50;
    const s = scheduler(imp, clock);
    const kinds: string[] = [];
    for (let i = 0; i < 4; i += 1) kinds.push((await s.step()).kind);
    expect(kinds).toEqual(['ran', 'ran', 'ran', 'ran']);
    const fast = fakeImporter([work(1, 3), work(2, 3), work(3, 3)], clock);
    fast.elapsed = () => 50;
    const full = scheduler(fast, clock, { backfillShare: 1 });
    expect([(await full.step()).kind, (await full.step()).kind, (await full.step()).kind]).toEqual([
      'ran',
      'ran',
      'ran',
    ]);
  });

  it('runs the spool first when it has something to drain', async () => {
    const clock = { t: 0 };
    const imp = fakeImporter([work(1, 1)], clock);
    let pending = true;
    const s = scheduler(imp, clock, {
      spool: {
        pending: () => pending,
        run: () => {
          imp.log.push('spool');
          pending = false;
          return Promise.resolve();
        },
      },
    });
    await s.step();
    await s.step();
    expect(imp.log.map((l) => l.split(':')[0])).toEqual(['spool', 'slice']);
  });

  it('survives a slice that throws, counts it, and tries the next one', async () => {
    const clock = { t: 0 };
    const imp = fakeImporter([work(1, 1), work(2, 1)], clock);
    const original = imp.runSlice.bind(imp);
    let calls = 0;
    imp.runSlice = (w, d) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('boom'));
      return original(w, d);
    };
    const s = scheduler(imp, clock);
    expect((await s.step()).kind).toBe('failed');
    expect((await s.step()).kind).toBe('ran');
    expect(s.stats().failures).toBe(1);
    expect(s.stats().slices).toBe(1);
  });

  it('survives an importer that throws while it lists the work, counts it, and goes on afterwards', async () => {
    const clock = { t: 0 };
    const imp = fakeImporter([work(1, 1)], clock);
    const original = imp.work.bind(imp);
    let calls = 0;
    imp.work = () => {
      calls += 1;
      if (calls === 1) throw new Error('database is busy');
      return original();
    };
    const s = scheduler(imp, clock);
    expect((await s.step()).kind).toBe('failed');
    expect(s.stats().failures).toBe(1);
    expect((await s.step()).kind).toBe('ran');
    expect(s.stats().slices).toBe(1);
  });

  it('survives a spool that throws when it is asked whether it has lines', async () => {
    const clock = { t: 0 };
    const imp = fakeImporter([work(1, 1)], clock);
    let calls = 0;
    const s = scheduler(imp, clock, {
      spool: {
        pending: () => {
          calls += 1;
          if (calls === 1) throw new Error('spool folder is gone');
          return false;
        },
        run: () => Promise.resolve(),
      },
    });
    expect((await s.step()).kind).toBe('failed');
    expect(s.stats().failures).toBe(1);
    expect((await s.step()).kind).toBe('ran');
  });
});

describe('the loop', () => {
  it('works through the queue, ticks the stat and discovery cycles, and answers a hint', async () => {
    const clock = { t: 0 };
    const imp = fakeImporter([work(1, 1), work(2, 2), work(3, 3)], clock);
    const s = scheduler(imp, clock, { scanIntervalMs: 5, discoveryIntervalMs: 5, now: () => performance.now() });
    s.start();
    await waitFor(() => imp.queue.length === 0 && imp.log.filter((l) => l === 'stat').length >= 2, {
      what: 'the queue and two stat ticks',
    });
    expect(imp.log.filter((l) => l === 'discover').length).toBeGreaterThanOrEqual(2);
    s.hint('22222222-2222-4222-8222-222222222222');
    await waitFor(() => imp.log.includes('hint:22222222-2222-4222-8222-222222222222'), { what: 'the hint' });
    expect(imp.log.indexOf('discover')).toBeLessThan(imp.log.findIndex((l) => l.startsWith('slice')));
    await s.stop();
  });

  it('yields to the event loop after every slice', async () => {
    const clock = { t: 0 };
    const imp = fakeImporter(
      Array.from({ length: 30 }, (_, i) => work(i + 1, 1)),
      clock,
    );
    const s = scheduler(imp, clock, {
      scanIntervalMs: 60_000,
      discoveryIntervalMs: 60_000,
      now: () => performance.now(),
    });
    let turns = 0;
    const flag = { running: true };
    const ticker = (async () => {
      while (flag.running) {
        await nextTurn();
        turns += 1;
      }
    })();
    s.start();
    await waitFor(() => imp.queue.length === 0, { what: 'the queue to be empty' });
    flag.running = false;
    await ticker;
    // a loop that did not yield would have finished its 30 slices before the ticker saw one turn
    expect(turns).toBeGreaterThanOrEqual(15);
    await s.stop();
  });

  it('stops after the slice in progress and does not start another', async () => {
    const clock = { t: 0 };
    const imp = fakeImporter([work(1, 1), work(2, 1), work(3, 1)], clock);
    let release: () => void = () => undefined;
    imp.slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = scheduler(imp, clock, {
      scanIntervalMs: 60_000,
      discoveryIntervalMs: 60_000,
      now: () => performance.now(),
    });
    s.start();
    await waitFor(() => imp.log.some((l) => l.startsWith('slice')), { what: 'the first slice' });
    const stopping = s.stop();
    release();
    await stopping;
    expect(imp.log.filter((l) => l.startsWith('slice'))).toHaveLength(1);
    expect(imp.queue).toHaveLength(2);
    // a stopped scheduler can be started again and goes on where it was
    imp.slow = null;
    s.start();
    await waitFor(() => imp.queue.length === 0, { what: 'the queue after a restart' });
  });

  it('keeps its loop alive when the importer throws while it lists the work, and stop() does not rethrow', async () => {
    const clock = { t: 0 };
    const imp = fakeImporter([work(1, 1), work(2, 1)], clock);
    const original = imp.work.bind(imp);
    let throwing = 2;
    imp.work = () => {
      if (throwing > 0) {
        throwing -= 1;
        throw new Error('database is busy');
      }
      return original();
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const s = scheduler(imp, clock, {
        scanIntervalMs: 60_000,
        discoveryIntervalMs: 60_000,
        now: () => performance.now(),
      });
      s.start();
      await waitFor(() => imp.queue.length === 0, { what: 'the queue after the failures' });
      expect(s.stats().failures).toBeGreaterThanOrEqual(2);
      expect(s.stats().slices).toBe(2);
      await s.stop();
      // let a rejection of the loop promise, if there were one, reach the process
      await nextTurn();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('never has two loops, however often it is started', async () => {
    const clock = { t: 0 };
    const imp = fakeImporter([work(1, 1), work(2, 1)], clock);
    const s = scheduler(imp, clock, {
      scanIntervalMs: 60_000,
      discoveryIntervalMs: 60_000,
      now: () => performance.now(),
    });
    s.start();
    s.start();
    await waitFor(() => imp.queue.length === 0, { what: 'the queue' });
    expect(imp.log.filter((l) => l.startsWith('slice'))).toHaveLength(2);
  });
});

// ---- the real importer behind the real scheduler ------------------------------------------------------------------------------

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const HOUR = 3_600_000;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const SCOPE = { instanceId: FIXTURE_INSTANCE_ID };

const dbs: InstanceDb[] = [];
const writers: IngestWriterHandle[] = [];
const importers: TranscriptImporter[] = [];
afterEach(async () => {
  for (const importer of importers.splice(0)) importer.close();
  for (const writer of writers.splice(0)) await writer.close();
  for (const db of dbs.splice(0)) db.close();
});

function realRig(files: { id: string; builder: TranscriptBuilder }[]): {
  db: InstanceDb;
  importer: TranscriptImporter;
  writer: IngestWriterHandle;
  tdir: string;
} {
  const root = makeTemp('sched').path;
  const home = path.join(root, 'home');
  buildClaudeHome(home, {
    nowMs: NOW,
    sessions: files.map((f) => ({
      id: f.id,
      project: 'p1',
      mtimeAgeMs: HOUR,
      build: () => undefined,
    })),
  });
  const tdir = path.join(home, 'projects', 'p1');
  for (const f of files) {
    const target = path.join(tdir, `${f.id}.jsonl`);
    f.builder.write(target);
    utimesSync(target, new Date(NOW - HOUR), new Date(NOW - HOUR));
  }
  const clock = new FakeClock(NOW);
  const db = openInstanceDb({
    path: path.join(root, 'monitor.db'),
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  dbs.push(db);
  const writer = createIngestWriter({
    db,
    scope: SCOPE,
    retryBaseMs: 1,
    retryMaxMs: 2,
    sleep: () => Promise.resolve(),
  });
  writers.push(writer);
  const importer = createTranscriptImporter({
    db,
    scope: SCOPE,
    writer,
    clock,
    transcriptsDir: tdir,
    settings: { tailWindowBytes: 1024 * 1024 },
  });
  importers.push(importer);
  return { db, importer, writer, tdir };
}

describe('the scheduler over the real importer', () => {
  it('imports two files by priority and keeps the event loop free while it does (T-TR-11 in small)', async () => {
    const big = bigTranscript({ sessionId: S1, targetBytes: 6 * 1024 * 1024 });
    const small = new TranscriptBuilder({ sessionId: S2, cwd: 'FIXTURE/x', startMs: NOW - 2 * HOUR });
    small.user('small').assistant({ messageId: 'small_1' });
    const r = realRig([
      { id: S1, builder: big },
      { id: S2, builder: small },
    ]);
    const s = createImportScheduler({
      importer: r.importer,
      sliceMs: 20,
      scanIntervalMs: 50,
      discoveryIntervalMs: 50,
      backfillShare: 0.25,
    });
    schedulers.push(s);
    const probe = eventLoopLagProbe();
    s.start();
    await waitFor(() => r.importer.isIdle() && r.importer.stats().lastScanAt !== null && s.stats().slices > 10, {
      timeoutMs: 40_000,
      intervalMs: 50,
      what: 'the import to finish',
    });
    await r.writer.flushNow();
    const lag = probe.stop();
    await s.stop();
    expect(r.db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM sessions').get()?.n).toBe(2);
    expect(
      r.db.driver
        .prepare<{ n: number }>("SELECT count(*) AS n FROM transcript_files WHERE usage_state = 'complete'")
        .get()?.n,
    ).toBe(2);
    // the design asks for no delay above 50 ms on a quiet machine with a 100 MB fixture; the bound here is for a shared one
    expect(lag.maxMs).toBeLessThan(250);
  }, 60_000);

  it('picks up a file that grows while the scheduler runs', async () => {
    const live = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - 2 * HOUR });
    live.user('first').assistant({ messageId: 'live_1' });
    const r = realRig([{ id: S1, builder: live }]);
    const s = createImportScheduler({
      importer: r.importer,
      sliceMs: 20,
      scanIntervalMs: 20,
      discoveryIntervalMs: 20,
      backfillShare: 1,
    });
    schedulers.push(s);
    s.start();
    const events = (): number => r.db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM events').get()?.n ?? 0;
    await waitFor(() => events() > 0, { what: 'the first records' });
    const before = events();
    const more = new TranscriptBuilder({ sessionId: S1, cwd: 'FIXTURE/x', startMs: NOW - HOUR, uuidSeed: 'grow' });
    more.user('second').assistant({ messageId: 'live_2' });
    const target = path.join(r.tdir, `${S1}.jsonl`);
    appendFileSync(target, `${more.lines().join('\n')}\n`);
    utimesSync(target, new Date(NOW - HOUR / 2), new Date(NOW - HOUR / 2));
    await waitFor(() => events() > before, { what: 'the appended records' });
    await s.stop();
  }, 30_000);
});
