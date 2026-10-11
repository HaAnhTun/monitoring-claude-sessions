// The lifecycle sweeper (02 4.10, 7.8; T-LF-50 sweeper part, T-LF-54): only rows past `next_check_at` are looked at, the work goes
// to the injected writer, `stop` waits for a running tick, and the timer runs on the interval of `lifecycle.sweepIntervalMs`.
import path from 'node:path';

import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_INSTANCE_ID } from '../../test/fixtures/hooks.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { SessionsRepo, type StoredView } from '../db/repos/sessions.ts';
import { withWriteTx } from '../db/write.ts';
import type { IngestBatch } from '../ingest/writer.ts';
import { createLifecycleSweeper, type SweeperContext, type SweeperWriter } from './sweeper.ts';

const tempDir = useTempDirs();
const SCOPE = { instanceId: FIXTURE_INSTANCE_ID };
const NOW = Date.UTC(2026, 9, 12, 8, 0, 0);
const uid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const dbs: InstanceDb[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs.splice(0)) db.close();
});

function viewOf(over: Partial<StoredView>): StoredView {
  return {
    state: 'waiting_input',
    presence: 'open',
    waitReason: 'user',
    staleKind: null,
    endReason: null,
    turnOutcome: null,
    basis: 'observed',
    confidence: 'high',
    ruleId: 'FIXTURE',
    evidence: [],
    since: NOW - 1000,
    evaluatedAt: NOW - 1000,
    nextCheckAt: null,
    ...over,
  };
}

interface SeedSession {
  readonly n: number;
  readonly nextCheckAt: number | null;
  readonly presence?: StoredView['presence'];
  readonly claudePid?: number;
}

function open(): { db: InstanceDb; clock: FakeClock } {
  const clock = new FakeClock(NOW);
  const db = openInstanceDb({
    path: path.join(tempDir('sweeper').path, 'monitor.db'),
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  dbs.push(db);
  return { db, clock };
}

function seed(db: InstanceDb, sessions: readonly SeedSession[]): void {
  const repo = new SessionsRepo(db);
  withWriteTx(db, SCOPE, (tx) => {
    for (const s of sessions) {
      const { id } = repo.ensure(SCOPE, tx, { sessionUid: uid(s.n), projectId: null, startedAt: NOW - 60_000 });
      repo.writeView(SCOPE, tx, id, viewOf({ nextCheckAt: s.nextCheckAt, presence: s.presence ?? 'open' }), '{}');
      if (s.claudePid !== undefined) repo.update(SCOPE, tx, id, { claudePid: s.claudePid }, null);
    }
  });
}

function context(db: InstanceDb, clock: FakeClock, sweepIntervalMs = 5000): SweeperContext & { pushed: string[] } {
  const pushed: string[] = [];
  return {
    db,
    scope: SCOPE,
    clock,
    config: { runtime: { lifecycle: { sweepIntervalMs } } },
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    errors: {
      push: (entry) => {
        pushed.push(entry.code);
      },
    },
    pushed,
  };
}

interface RecordingWriter extends SweeperWriter {
  readonly batches: IngestBatch[];
  /** The next `submit` answers false (a full queue) until `drain()`. */
  full: boolean;
  drain(): void;
}

function recordingWriter(): RecordingWriter {
  const listeners: (() => void)[] = [];
  const writer: RecordingWriter = {
    batches: [],
    full: false,
    submit(batch) {
      if (writer.full) return false;
      writer.batches.push(batch);
      return true;
    },
    onDrain(cb) {
      listeners.push(cb);
    },
    drain() {
      writer.full = false;
      for (const cb of listeners) cb();
    },
  };
  return writer;
}

const sessionsOf = (batch: IngestBatch): string[] =>
  batch.items.flatMap((item) => item.events.map((event) => event.sessionId));

describe('T-LF-50 the sweeper looks only at rows past next_check_at', () => {
  it('submits derive items for the due sessions of 1000 and for no other', async () => {
    const { db, clock } = open();
    const seeds: SeedSession[] = [];
    for (let n = 1; n <= 1000; n += 1) {
      // 10 due, 400 due later, 300 never, the rest well ahead
      const nextCheckAt = n <= 10 ? NOW - n * 1000 : n <= 410 ? NOW + 60_000 : n <= 710 ? null : NOW + 3_600_000;
      seeds.push({ n, nextCheckAt });
    }
    seed(db, seeds);
    const writer = recordingWriter();
    const sweeper = createLifecycleSweeper(context(db, clock), { writer });
    await sweeper.tickNow();
    expect(writer.batches).toHaveLength(1);
    const [batch] = writer.batches;
    expect(batch?.source).toBe('sweeper');
    // earliest due first
    expect(batch === undefined ? [] : sessionsOf(batch)).toEqual(Array.from({ length: 10 }, (_, i) => uid(10 - i)));
    expect(batch?.items.every((item) => item.kind === 'derive')).toBe(true);
    expect(batch?.cursor).toBeUndefined();
  });

  it('submits nothing when no row is due, and a row becomes due when the clock passes its time', async () => {
    const { db, clock } = open();
    seed(db, [{ n: 1, nextCheckAt: NOW + 30_000 }]);
    const writer = recordingWriter();
    const sweeper = createLifecycleSweeper(context(db, clock), { writer });
    await sweeper.tickNow();
    expect(writer.batches).toEqual([]);
    clock.advance(30_000);
    await sweeper.tickNow();
    expect(writer.batches.flatMap(sessionsOf)).toEqual([uid(1)]);
  });

  it('takes at most 200 rows per tick, the earliest first', async () => {
    const { db, clock } = open();
    seed(
      db,
      Array.from({ length: 250 }, (_, i) => ({ n: i + 1, nextCheckAt: NOW - 250_000 + i * 1000 })),
    );
    const writer = recordingWriter();
    await createLifecycleSweeper(context(db, clock), { writer }).tickNow();
    const ids = writer.batches.flatMap(sessionsOf);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe(uid(1));
    expect(ids[199]).toBe(uid(200));
  });

  it('probes the pid of an open session with a known process and re-derives the others', async () => {
    const { db, clock } = open();
    seed(db, [
      { n: 1, nextCheckAt: NOW - 1, claudePid: 4242 },
      { n: 2, nextCheckAt: NOW - 1, claudePid: 4243, presence: 'ended' },
      { n: 3, nextCheckAt: NOW - 1 },
    ]);
    const writer = recordingWriter();
    const probed: number[] = [];
    const sweeper = createLifecycleSweeper(
      context(db, clock),
      { writer },
      {
        pidAlive: (pid) => {
          probed.push(pid);
          return false;
        },
      },
    );
    await sweeper.tickNow();
    expect(probed).toEqual([4242]);
    const items = writer.batches.flatMap((batch) => batch.items);
    const external = items.find((item) => item.kind === 'external');
    expect(external?.events).toEqual([
      { k: 'external.pid', sessionId: uid(1), pid: 4242, alive: false, checkedAt: NOW },
    ]);
    expect(
      items.filter((item) => item.kind === 'derive').flatMap((item) => item.events.map((e) => e.sessionId)),
    ).toEqual([uid(2), uid(3)]);
  });
});

describe('T-LF-54 the sweeper service shape', () => {
  it('keeps a due row for the next tick when the queue is full, and gives up on stop', async () => {
    const { db, clock } = open();
    seed(db, [{ n: 1, nextCheckAt: NOW - 1 }]);
    const writer = recordingWriter();
    writer.full = true;
    const sweeper = createLifecycleSweeper(context(db, clock), { writer });
    const tick = sweeper.tickNow();
    await Promise.resolve();
    // the tick waits for room instead of dropping the work
    expect(writer.batches).toEqual([]);
    writer.drain();
    await tick;
    expect(writer.batches.flatMap(sessionsOf)).toEqual([uid(1)]);
  });

  it('stop waits for a running tick', async () => {
    vi.useFakeTimers();
    const { db, clock } = open();
    seed(db, [{ n: 1, nextCheckAt: NOW - 1 }]);
    const writer = recordingWriter();
    writer.full = true;
    const sweeper = createLifecycleSweeper(context(db, clock), { writer });
    const tick = sweeper.tickNow();
    let stopped = false;
    const stopping = sweeper.stop(clock.now() + 30_000).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(stopped).toBe(false);
    writer.drain();
    await tick;
    await stopping;
    expect(stopped).toBe(true);
  });

  it('stop gives up waiting when its deadline passes, and the abandoned tick ends without submitting', async () => {
    const { db, clock } = open();
    seed(db, [{ n: 1, nextCheckAt: NOW - 1 }]);
    const writer = recordingWriter();
    writer.full = true;
    const sweeper = createLifecycleSweeper(context(db, clock), { writer });
    const tick = sweeper.tickNow();
    const started = Date.now();
    await sweeper.stop(clock.now() + 30);
    expect(Date.now() - started).toBeLessThan(1500);
    await tick;
    expect(writer.batches).toEqual([]);
  });

  describe('timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('ticks every sweepIntervalMs from start, and stop clears the timer', async () => {
      const { db, clock } = open();
      seed(db, [{ n: 1, nextCheckAt: NOW - 1 }]);
      const writer = recordingWriter();
      const sweeper = createLifecycleSweeper(context(db, clock, 2000), { writer });
      sweeper.start();
      await vi.advanceTimersByTimeAsync(1999);
      expect(writer.batches).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(writer.batches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4000);
      expect(writer.batches).toHaveLength(3);
      await sweeper.stop(clock.now() + 1000);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writer.batches).toHaveLength(3);
    });

    it('start twice does not run two timers', async () => {
      const { db, clock } = open();
      seed(db, [{ n: 1, nextCheckAt: NOW - 1 }]);
      const writer = recordingWriter();
      const sweeper = createLifecycleSweeper(context(db, clock, 1000), { writer });
      sweeper.start();
      sweeper.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(writer.batches).toHaveLength(1);
      await sweeper.stop(clock.now() + 1000);
    });
  });

  it('a failing tick is reported to the error ring and never rejects', async () => {
    const { db, clock } = open();
    seed(db, [{ n: 1, nextCheckAt: NOW - 1 }]);
    const ctx = context(db, clock);
    const writer: SweeperWriter = {
      submit: () => {
        throw new Error('FIXTURE writer failed');
      },
      onDrain: () => undefined,
    };
    await expect(createLifecycleSweeper(ctx, { writer }).tickNow()).resolves.toBeUndefined();
    expect(ctx.pushed).toEqual(['SWEEPER_TICK_FAILED']);
  });

  it('tickNow while a tick runs returns that tick', async () => {
    const { db, clock } = open();
    seed(db, [{ n: 1, nextCheckAt: NOW - 1 }]);
    const writer = recordingWriter();
    writer.full = true;
    const sweeper = createLifecycleSweeper(context(db, clock), { writer });
    const first = sweeper.tickNow();
    const second = sweeper.tickNow();
    expect(second).toBe(first);
    writer.drain();
    await first;
    expect(writer.batches).toHaveLength(1);
  });
});
