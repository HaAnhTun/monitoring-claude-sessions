import type { StreamChange, StreamHello } from '@mcs/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeEventSources, type FakeEventSources } from '../test/fake-event-source.ts';
import { FIXTURE_EPOCH, FIXTURE_INSTANCE_ID, iso, sessionId } from '../test/fixtures/index.ts';
import {
  createStreamClient,
  type EpochInfo,
  type ResyncReason,
  type StreamClient,
  type StreamClientOptions,
} from './stream-client.ts';

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const NEW_EPOCH = 'ffeeddcc';

function hello(over: Partial<StreamHello> = {}): StreamHello {
  return {
    instanceId: FIXTURE_INSTANCE_ID,
    epoch: FIXTURE_EPOCH,
    headSeq: 10,
    heartbeatMs: 15_000,
    serverTime: iso(0),
    runtimeVersion: '3.0.0',
    codeStamp: 'fixture-stamp',
    ...over,
  };
}

function heartbeat(headSeq: number, epoch: string = FIXTURE_EPOCH) {
  return { headSeq, epoch, serverTime: iso(0) };
}

/** The smallest valid change frame: `usage/invalidate`. */
function change(seq: number): StreamChange {
  return {
    seq,
    at: iso(0),
    instanceId: FIXTURE_INSTANCE_ID,
    kind: 'usage',
    op: 'invalidate',
    sessionId: sessionId(1),
    data: { sessionId: sessionId(1) },
  };
}

interface Harness {
  sources: FakeEventSources;
  client: StreamClient;
  batches: StreamChange[][];
  resyncs: ResyncReason[];
  instanceChanged: string[];
  epochChanged: EpochInfo[];
  win: EventTarget;
}

function setup(over: Partial<StreamClientOptions> = {}): Harness {
  const sources = createFakeEventSources();
  const batches: StreamChange[][] = [];
  const resyncs: ResyncReason[] = [];
  const instanceChanged: string[] = [];
  const epochChanged: EpochInfo[] = [];
  const win = new EventTarget();
  const client = createStreamClient({
    url: '/api/v3/stream',
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    expectedEpoch: FIXTURE_EPOCH,
    startSeq: 10,
    heartbeatMs: 15_000,
    esFactory: sources.factory,
    requestFrame: null,
    cancelFrame: null,
    windowTarget: win,
    onBatch: (changes) => batches.push(changes),
    onResync: (reason) => resyncs.push(reason),
    onInstanceChanged: (id) => instanceChanged.push(id),
    onEpochChanged: (info) => epochChanged.push(info),
    ...over,
  });
  return { sources, client, batches, resyncs, instanceChanged, epochChanged, win };
}

/** start, browser open, server hello. */
function openStream(h: Harness, over: Partial<StreamHello> = {}): void {
  h.client.start();
  h.sources.last().open();
  h.sources.last().emit('hello', hello(over));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('state table: idle and connecting', () => {
  it('start() connects with since=startSeq and the expected epoch, and arms the connect timeout', () => {
    const h = setup();
    expect(h.client.snapshot().status).toBe('idle');
    h.client.start();
    expect(h.client.snapshot().status).toBe('connecting');
    expect(h.sources.urls()).toEqual([`/api/v3/stream?since=10&epoch=${FIXTURE_EPOCH}`]);
    expect(vi.getTimerCount()).toBe(1);
    h.client.stop();
  });

  it('listens for the four named events', () => {
    const h = setup();
    h.client.start();
    expect(h.sources.last().eventNames.sort()).toEqual(['change', 'heartbeat', 'hello', 'reset']);
    h.client.stop();
  });

  it('start() twice does not open a second source', () => {
    const h = setup();
    h.client.start();
    h.client.start();
    expect(h.sources.instances).toHaveLength(1);
    h.client.stop();
  });

  it('open: status open, attempt 0, openedAt set, watchdog armed', () => {
    const h = setup();
    h.client.start();
    h.sources.last().open();
    const s = h.client.snapshot();
    expect(s.status).toBe('open');
    expect(s.openedAt).toBe(T0);
    expect(s.attempt).toBe(0);
    h.client.stop();
  });

  it('connect timeout is max(10 s, 2 x heartbeat) and moves to backoff with a reason', () => {
    const h = setup({ heartbeatMs: 4_000 });
    h.client.start();
    vi.advanceTimersByTime(9_999);
    expect(h.client.snapshot().status).toBe('connecting');
    vi.advanceTimersByTime(1);
    const s = h.client.snapshot();
    expect(s.status).toBe('backoff');
    expect(s.lastError).toBe('connect timeout');
    expect(h.sources.last().closed).toBe(true);
    h.client.stop();
  });

  it('connect timeout scales with a long heartbeat (the default 15 s gives 30 s)', () => {
    const h = setup({ heartbeatMs: 30_000 });
    h.client.start();
    vi.advanceTimersByTime(59_999);
    expect(h.client.snapshot().status).toBe('connecting');
    vi.advanceTimersByTime(1);
    expect(h.client.snapshot().status).toBe('backoff');
    h.client.stop();
  });

  it('a first message before the open event counts as open', () => {
    const h = setup();
    h.client.start();
    h.sources.last().emit('hello', hello());
    expect(h.client.snapshot().status).toBe('open');
    h.client.stop();
  });
});

describe('state table: hello', () => {
  it('another instance id: stopped, source closed, onInstanceChanged, no timers left', () => {
    const h = setup();
    h.client.start();
    h.sources.last().open();
    h.sources.last().emit('hello', hello({ instanceId: '22222222-2222-4222-8222-222222222222' }));
    expect(h.client.snapshot().status).toBe('stopped');
    expect(h.sources.last().closed).toBe(true);
    expect(h.instanceChanged).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('same epoch: records epoch, head and heartbeat interval, no resync', () => {
    const h = setup();
    openStream(h, { headSeq: 42, heartbeatMs: 20_000 });
    vi.advanceTimersByTime(500);
    const s = h.client.snapshot();
    expect(s.instanceId).toBe(FIXTURE_INSTANCE_ID);
    expect(s.epoch).toBe(FIXTURE_EPOCH);
    expect(s.serverHeadSeq).toBe(42);
    expect(h.resyncs).toEqual([]);
    expect(h.epochChanged).toEqual([]);
    expect(s.lastSeq).toBeNull();
    h.client.stop();
  });

  it('hello heartbeat interval drives the watchdog', () => {
    const h = setup();
    openStream(h, { heartbeatMs: 4_000 });
    vi.advanceTimersByTime(10_000);
    expect(h.client.snapshot().status).toBe('open');
    vi.advanceTimersByTime(1_001);
    expect(h.client.snapshot().status).toBe('backoff');
    h.client.stop();
  });

  it('new epoch: adopts it, lastSeq = headSeq, one resync(epoch) and onEpochChanged', () => {
    const h = setup();
    openStream(h, { epoch: NEW_EPOCH, headSeq: 3, runtimeVersion: '3.1.0', codeStamp: 'stamp-2' });
    expect(h.client.snapshot().epoch).toBe(NEW_EPOCH);
    expect(h.client.snapshot().lastSeq).toBe(3);
    expect(h.epochChanged).toEqual([{ epoch: NEW_EPOCH, runtimeVersion: '3.1.0', codeStamp: 'stamp-2' }]);
    expect(h.resyncs).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual(['epoch']);
    h.client.stop();
  });

  it('the server reset(epoch_changed) that follows the hello runs R5 once', () => {
    const h = setup();
    openStream(h, { epoch: NEW_EPOCH, headSeq: 3 });
    h.sources.last().emit('reset', { headSeq: 3, reason: 'epoch_changed' });
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual(['epoch']);
    expect(h.client.snapshot().lastResetReason).toBe('epoch_changed');
    expect(h.client.snapshot().counters.resyncs).toBe(1);
    h.client.stop();
  });

  it('an invalid hello counts as invalid and resyncs', () => {
    const h = setup();
    h.client.start();
    h.sources.last().open();
    h.sources.last().emit('hello', { instanceId: 'nope' });
    vi.advanceTimersByTime(100);
    expect(h.client.snapshot().counters.invalid).toBe(1);
    expect(h.resyncs).toEqual(['invalid']);
    h.client.stop();
  });
});

describe('state table: change', () => {
  it('invalid JSON: counters.invalid and resync(invalid)', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', '{not json');
    vi.advanceTimersByTime(100);
    expect(h.client.snapshot().counters.invalid).toBe(1);
    expect(h.resyncs).toEqual(['invalid']);
    h.client.stop();
  });

  it('schema violation (extra field, wrong data for the kind) is invalid, not applied', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', { ...change(11), extra: 1 });
    h.sources.last().emit('change', { ...change(12), data: { sessionId: 5 } });
    vi.advanceTimersByTime(100);
    expect(h.client.snapshot().counters.invalid).toBe(2);
    expect(h.resyncs).toEqual(['invalid']);
    expect(h.batches).toEqual([]);
    h.client.stop();
  });

  it('first change with lastSeq null is accepted whatever its seq and enqueued', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    expect(h.client.snapshot().lastSeq).toBe(11);
    expect(h.batches).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(h.batches).toEqual([[change(11)]]);
    h.client.stop();
  });

  it('seq === lastSeq + 1 is queued and flushed together with its neighbours after 100 ms', () => {
    const h = setup();
    openStream(h);
    for (const seq of [11, 12, 13]) h.sources.last().emit('change', change(seq));
    vi.advanceTimersByTime(99);
    expect(h.batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.batches).toEqual([[change(11), change(12), change(13)]]);
    expect(h.client.snapshot().lastSeq).toBe(13);
    h.client.stop();
  });

  it('duplicate or older seq is ignored and counted', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('change', change(9));
    vi.advanceTimersByTime(100);
    expect(h.batches).toEqual([[change(11)]]);
    expect(h.client.snapshot().counters.duplicates).toBe(2);
    expect(h.resyncs).toEqual([]);
    h.client.stop();
  });

  it('a gap triggers exactly one resync, advances lastSeq and drops the frame', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('change', change(14));
    h.sources.last().emit('change', change(15));
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual(['gap']);
    expect(h.client.snapshot().lastSeq).toBe(15);
    expect(h.client.snapshot().counters.resyncs).toBe(1);
    // the resync supersedes everything queued before it; the refetch covers it
    expect(h.batches.flat().map((c) => c.seq)).not.toContain(14);
    h.client.stop();
  });

  it('after a resync the next in-order frame is applied again', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('change', change(14));
    vi.advanceTimersByTime(100);
    h.sources.last().emit('change', change(15));
    vi.advanceTimersByTime(100);
    expect(h.batches).toEqual([[change(15)]]);
    expect(h.resyncs).toEqual(['gap']);
    h.client.stop();
  });

  it('a queue of exactly maxQueue is fine, the next frame overflows: queue dropped and resync(overflow)', () => {
    const h = setup({ maxQueue: 1000 });
    openStream(h);
    for (let seq = 11; seq <= 1010; seq += 1) h.sources.last().emit('change', change(seq));
    expect(h.resyncs).toEqual([]);
    h.sources.last().emit('change', change(1011));
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual(['overflow']);
    expect(h.batches).toEqual([]);
    expect(h.client.snapshot().lastSeq).toBe(1011);
    h.client.stop();
  });

  it('an unknown kind advances the sequence, is counted, is not applied and does not reset', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('change', {
      seq: 12,
      at: iso(0),
      instanceId: FIXTURE_INSTANCE_ID,
      kind: 'future_thing',
      op: 'upsert',
      sessionId: null,
      data: { anything: true },
    });
    h.sources.last().emit('change', change(13));
    vi.advanceTimersByTime(100);
    expect(h.batches).toEqual([[change(11), change(13)]]);
    expect(h.client.snapshot().counters.unknownKinds).toBe(1);
    expect(h.client.snapshot().counters.invalid).toBe(0);
    expect(h.client.snapshot().lastSeq).toBe(13);
    expect(h.resyncs).toEqual([]);
    h.client.stop();
  });

  it('there is no config kind: a config frame is an unknown kind, never applied and never a reset (ADR 0032)', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', {
      seq: 11,
      at: iso(0),
      instanceId: FIXTURE_INSTANCE_ID,
      kind: 'config',
      op: 'upsert',
      sessionId: null,
      data: {},
    });
    vi.advanceTimersByTime(100);
    expect(h.client.snapshot().counters.unknownKinds).toBe(1);
    expect(h.batches).toEqual([]);
    expect(h.resyncs).toEqual([]);
    h.client.stop();
  });

  it('an envelope that is not an object or lacks a seq is invalid, even for an unknown kind', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', 'null');
    h.sources.last().emit('change', { kind: 'future_thing', op: 'upsert' });
    expect(h.client.snapshot().counters.invalid).toBe(2);
    expect(h.client.snapshot().counters.unknownKinds).toBe(0);
    h.client.stop();
  });

  it('flushes on the animation frame when it comes before the 100 ms timer', () => {
    const frames: (() => void)[] = [];
    const h = setup({
      requestFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelFrame: () => undefined,
    });
    openStream(h);
    h.sources.last().emit('change', change(11));
    expect(h.batches).toEqual([]);
    frames[0]?.();
    expect(h.batches).toEqual([[change(11)]]);
    vi.advanceTimersByTime(200);
    expect(h.batches).toHaveLength(1);
    h.client.stop();
  });

  it('inSyncAt moves after an applied batch', () => {
    const h = setup();
    openStream(h);
    expect(h.client.snapshot().inSyncAt).toBeNull();
    h.sources.last().emit('change', change(11));
    vi.advanceTimersByTime(100);
    expect(h.client.snapshot().inSyncAt).toBe(T0 + 100);
    h.client.stop();
  });

  it('a throwing onBatch does not stop the client: it resyncs instead', () => {
    const h = setup({
      onBatch: () => {
        throw new Error('apply failed');
      },
    });
    openStream(h);
    h.sources.last().emit('change', change(11));
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual(['invalid']);
    expect(h.client.snapshot().status).toBe('open');
    h.client.stop();
  });
});

describe('state table: heartbeat', () => {
  it('records the head and the time; equal to lastSeq means in sync', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(1_000);
    h.sources.last().emit('heartbeat', heartbeat(11));
    const s = h.client.snapshot();
    expect(s.lastHeartbeatAt).toBe(T0 + 1_100);
    expect(s.serverHeadSeq).toBe(11);
    expect(s.inSyncAt).toBe(T0 + 1_100);
    h.client.stop();
  });

  it('before any change the head is compared with startSeq', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('heartbeat', heartbeat(10));
    expect(h.client.snapshot().inSyncAt).toBe(T0);
    h.client.stop();
  });

  it('a head ahead of lastSeq on one heartbeat only waits; on two consecutive ones it resyncs and catches up', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    vi.advanceTimersByTime(100);
    h.sources.last().emit('heartbeat', heartbeat(15));
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual([]);
    expect(h.client.snapshot().inSyncAt).toBe(T0 + 100);
    h.sources.last().emit('heartbeat', heartbeat(15));
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual(['head-ahead']);
    expect(h.client.snapshot().lastSeq).toBe(15);
    h.client.stop();
  });

  it('a heartbeat that is in sync between two ahead ones resets the streak', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('heartbeat', heartbeat(13));
    h.sources.last().emit('heartbeat', heartbeat(11));
    h.sources.last().emit('heartbeat', heartbeat(13));
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual([]);
    h.client.stop();
  });

  it('a heartbeat with another epoch is handled like the hello epoch row', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('heartbeat', heartbeat(77, NEW_EPOCH));
    expect(h.client.snapshot().epoch).toBe(NEW_EPOCH);
    expect(h.client.snapshot().lastSeq).toBe(77);
    expect(h.epochChanged).toEqual([{ epoch: NEW_EPOCH, runtimeVersion: '', codeStamp: '' }]);
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual(['epoch']);
    h.client.stop();
  });
});

describe('state table: reset', () => {
  it('lastSeq = headSeq, the reason is kept, one resync(reset), and replayed frames at or below the head are duplicates', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('reset', { headSeq: 50, reason: 'cursor_too_old' });
    h.sources.last().emit('change', change(40));
    h.sources.last().emit('change', change(51));
    vi.advanceTimersByTime(100);
    const s = h.client.snapshot();
    expect(s.lastResetReason).toBe('cursor_too_old');
    expect(s.lastSeq).toBe(51);
    expect(s.counters.duplicates).toBe(1);
    expect(h.resyncs).toEqual(['reset']);
    h.client.stop();
  });

  it('an invalid reset counts as invalid', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('reset', { headSeq: 1, reason: 'because' });
    vi.advanceTimersByTime(100);
    expect(h.client.snapshot().counters.invalid).toBe(1);
    expect(h.resyncs).toEqual(['invalid']);
    h.client.stop();
  });
});

describe('state table: error, watchdog, backoff', () => {
  it('error closes the source and backs off 2, 4, 8, 16, 30, 30 s', () => {
    const h = setup();
    h.client.start();
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const before = h.sources.last();
      before.fail();
      const s = h.client.snapshot();
      expect(s.status).toBe('backoff');
      expect(before.closed).toBe(true);
      expect(before.closeCount).toBe(1);
      expect(s.attempt).toBe(i + 1);
      delays.push((s.nextRetryAt ?? 0) - Date.now());
      vi.advanceTimersByTime(s.nextRetryAt === null ? 0 : s.nextRetryAt - Date.now());
      expect(h.client.snapshot().status).toBe('connecting');
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    h.client.stop();
  });

  it('reconnects with the explicit lastSeq and the current epoch, and counts the reconnect', () => {
    const h = setup();
    openStream(h, { epoch: FIXTURE_EPOCH });
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('change', change(12));
    vi.advanceTimersByTime(100);
    h.sources.last().fail();
    vi.advanceTimersByTime(2_000);
    expect(h.sources.urls().at(-1)).toBe(`/api/v3/stream?since=12&epoch=${FIXTURE_EPOCH}`);
    expect(h.client.snapshot().counters.reconnects).toBe(1);
    h.client.stop();
  });

  it('a successful open resets the attempt counter', () => {
    const h = setup();
    h.client.start();
    h.sources.last().fail();
    vi.advanceTimersByTime(2_000);
    h.sources.last().open();
    expect(h.client.snapshot().attempt).toBe(0);
    h.sources.last().fail();
    expect((h.client.snapshot().nextRetryAt ?? 0) - Date.now()).toBe(2_000);
    h.client.stop();
  });

  it('an error event of a source the client already closed is ignored', () => {
    const h = setup();
    h.client.start();
    const old = h.sources.last();
    old.fail();
    vi.advanceTimersByTime(2_000);
    old.fail({ force: true });
    old.emit('change', change(11), { force: true });
    expect(h.client.snapshot().status).toBe('connecting');
    expect(h.client.snapshot().attempt).toBe(1);
    expect(h.client.snapshot().lastSeq).toBeNull();
    h.client.stop();
  });

  it('error while open keeps already queued frames: they are still applied', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().fail();
    vi.advanceTimersByTime(100);
    expect(h.batches).toEqual([[change(11)]]);
    h.client.stop();
  });

  it('watchdog: 2.5 x heartbeat without any message goes to backoff with "no heartbeat"', () => {
    const h = setup();
    openStream(h);
    vi.advanceTimersByTime(37_500);
    expect(h.client.snapshot().status).toBe('open');
    vi.advanceTimersByTime(1);
    const s = h.client.snapshot();
    expect(s.status).toBe('backoff');
    expect(s.lastError).toBe('no heartbeat');
    expect(h.sources.last().closed).toBe(true);
    h.client.stop();
  });

  it('watchdog: every message type keeps the connection alive', () => {
    const h = setup();
    openStream(h);
    vi.advanceTimersByTime(30_000);
    h.sources.last().emit('heartbeat', heartbeat(10));
    vi.advanceTimersByTime(30_000);
    h.sources.last().emit('change', change(11));
    vi.advanceTimersByTime(30_000);
    expect(h.client.snapshot().status).toBe('open');
    vi.advanceTimersByTime(7_501);
    expect(h.client.snapshot().status).toBe('backoff');
    h.client.stop();
  });

  it('retryNow() in backoff reconnects at once and cancels the retry timer', () => {
    const h = setup();
    h.client.start();
    h.sources.last().fail();
    h.client.retryNow();
    expect(h.client.snapshot().status).toBe('connecting');
    expect(h.sources.instances).toHaveLength(2);
    vi.advanceTimersByTime(2_000);
    expect(h.sources.instances).toHaveLength(2);
    h.client.stop();
  });

  it('retryNow() when not in backoff does nothing', () => {
    const h = setup();
    h.client.retryNow();
    expect(h.client.snapshot().status).toBe('idle');
    h.client.start();
    h.client.retryNow();
    expect(h.sources.instances).toHaveLength(1);
    h.client.stop();
  });
});

describe('state table: window online / offline', () => {
  it('offline closes the source, goes to backoff with no retry timer; online reconnects', () => {
    const h = setup();
    openStream(h);
    h.win.dispatchEvent(new Event('offline'));
    const s = h.client.snapshot();
    expect(s.status).toBe('backoff');
    expect(s.nextRetryAt).toBeNull();
    expect(s.lastError).toBe('offline');
    expect(h.sources.last().closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(h.sources.instances).toHaveLength(1);
    h.win.dispatchEvent(new Event('online'));
    expect(h.client.snapshot().status).toBe('connecting');
    expect(h.sources.instances).toHaveLength(2);
    h.client.stop();
  });

  it('offline during backoff cancels the pending retry', () => {
    const h = setup();
    h.client.start();
    h.sources.last().fail();
    h.win.dispatchEvent(new Event('offline'));
    expect(h.client.snapshot().nextRetryAt).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(h.sources.instances).toHaveLength(1);
    h.client.stop();
  });

  it('an online event without a preceding offline does nothing', () => {
    const h = setup();
    openStream(h);
    h.win.dispatchEvent(new Event('online'));
    expect(h.sources.instances).toHaveLength(1);
    expect(h.client.snapshot().status).toBe('open');
    h.client.stop();
  });
});

describe('stop()', () => {
  it('leaves zero timers from every state', () => {
    for (const prepare of [
      (h: Harness) => {
        h.client.start();
      },
      (h: Harness) => {
        openStream(h);
      },
      (h: Harness) => {
        openStream(h);
        h.sources.last().emit('change', change(11));
      },
      (h: Harness) => {
        h.client.start();
        h.sources.last().fail();
      },
      (h: Harness) => {
        openStream(h);
        h.sources.last().emit('change', change(14));
        h.sources.last().emit('change', change(20));
      },
    ]) {
      const h = setup();
      prepare(h);
      h.client.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.client.snapshot().status).toBe('stopped');
      expect(h.sources.instances.every((es) => es.closed)).toBe(true);
    }
  });

  it('drops queued frames and a pending resync: nothing is delivered after stop', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('change', change(20));
    h.client.stop();
    vi.advanceTimersByTime(1_000);
    expect(h.batches).toEqual([]);
    expect(h.resyncs).toEqual([]);
  });

  it('removes the window listeners', () => {
    const h = setup();
    openStream(h);
    h.client.stop();
    h.win.dispatchEvent(new Event('offline'));
    h.win.dispatchEvent(new Event('online'));
    expect(h.client.snapshot().status).toBe('stopped');
    expect(h.sources.instances).toHaveLength(1);
  });

  it('is idempotent, closes the source once, and start() afterwards creates a new source (Strict Mode)', () => {
    const h = setup();
    h.client.start();
    h.client.stop();
    h.client.stop();
    expect(h.sources.last().closeCount).toBe(1);
    h.client.start();
    expect(h.sources.instances).toHaveLength(2);
    expect(h.client.snapshot().status).toBe('connecting');
    h.client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores late events of its closed source', () => {
    const h = setup();
    openStream(h);
    const es = h.sources.last();
    h.client.stop();
    es.emit('change', change(11), { force: true });
    es.emit('hello', hello({ epoch: NEW_EPOCH }), { force: true });
    es.fail({ force: true });
    vi.advanceTimersByTime(1_000);
    expect(h.batches).toEqual([]);
    expect(h.epochChanged).toEqual([]);
    expect(h.client.snapshot().status).toBe('stopped');
  });
});

describe('snapshot() and subscribe()', () => {
  it('returns the same object until something changes and notifies subscribers on change', () => {
    const h = setup();
    const a = h.client.snapshot();
    expect(h.client.snapshot()).toBe(a);
    const seen = vi.fn();
    const off = h.client.subscribe(seen);
    h.client.start();
    expect(seen).toHaveBeenCalled();
    expect(h.client.snapshot()).not.toBe(a);
    off();
    seen.mockClear();
    h.sources.last().open();
    expect(seen).not.toHaveBeenCalled();
    h.client.stop();
  });

  it('does not notify once per change frame of a burst, only once per flush', () => {
    const h = setup();
    openStream(h);
    const seen = vi.fn();
    h.client.subscribe(seen);
    for (let seq = 11; seq <= 60; seq += 1) h.sources.last().emit('change', change(seq));
    expect(seen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(seen.mock.calls.length).toBeLessThanOrEqual(2);
    expect(h.client.snapshot().counters.messages).toBe(51);
    h.client.stop();
  });

  it('initial snapshot is idle with empty counters', () => {
    const h = setup();
    expect(h.client.snapshot()).toMatchObject({
      status: 'idle',
      instanceId: null,
      epoch: null,
      lastSeq: null,
      serverHeadSeq: null,
      lastResetReason: null,
      openedAt: null,
      lastMessageAt: null,
      lastHeartbeatAt: null,
      inSyncAt: null,
      attempt: 0,
      nextRetryAt: null,
      lastError: null,
      counters: { messages: 0, duplicates: 0, invalid: 0, unknownKinds: 0, resyncs: 0, reconnects: 0 },
    });
  });
});

describe('adversarial interleavings', () => {
  it('reset, heartbeat and hello interleaved inside one flush window run R5 once', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('reset', { headSeq: 40, reason: 'cursor_too_old' });
    h.sources.last().emit('heartbeat', heartbeat(40));
    h.sources.last().emit('hello', hello({ headSeq: 40 }));
    h.sources.last().emit('reset', { headSeq: 40, reason: 'cursor_too_old' });
    h.sources.last().emit('change', change(41));
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual(['reset']);
    expect(h.client.snapshot().counters.resyncs).toBe(1);
    expect(h.batches).toEqual([]);
    expect(h.client.snapshot().lastSeq).toBe(41);
    h.client.stop();
  });

  it('two resync requests in different windows run R5 twice', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('reset', { headSeq: 40, reason: 'cursor_too_old' });
    vi.advanceTimersByTime(100);
    h.sources.last().emit('reset', { headSeq: 60, reason: 'cursor_ahead' });
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual(['reset', 'reset']);
    h.client.stop();
  });

  it('epoch change in the middle of a replay: stale queued frames are dropped, later seqs follow the new head', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('change', change(12));
    // the server restarted: the new hello has another epoch and a head below the old frames
    h.sources.last().emit('hello', hello({ epoch: NEW_EPOCH, headSeq: 5 }));
    h.sources.last().emit('reset', { headSeq: 5, reason: 'epoch_changed' });
    h.sources.last().emit('change', change(6));
    h.sources.last().emit('change', change(7));
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual(['epoch']);
    expect(h.batches).toEqual([]);
    expect(h.client.snapshot().epoch).toBe(NEW_EPOCH);
    expect(h.client.snapshot().lastSeq).toBe(7);
    h.sources.last().emit('change', change(8));
    vi.advanceTimersByTime(100);
    expect(h.batches).toEqual([[change(8)]]);
    h.client.stop();
  });

  it('a gap and an overflow in the same window report the first reason once', () => {
    const h = setup({ maxQueue: 2 });
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().emit('change', change(20));
    h.sources.last().emit('change', change(21));
    h.sources.last().emit('change', change(22));
    h.sources.last().emit('change', change(23));
    h.sources.last().emit('change', change(24));
    vi.advanceTimersByTime(100);
    expect(h.resyncs).toEqual(['gap']);
    h.client.stop();
  });

  it('an error between a frame and its flush neither loses the frame nor leaves a timer behind after stop()', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('change', change(11));
    h.sources.last().fail();
    h.sources.last().emit('change', change(12), { force: true });
    h.client.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.batches).toEqual([]);
  });
});
