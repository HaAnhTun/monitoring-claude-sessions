// The stream hub over a fake change log and fake sinks (03 9.2, DA-T-RT-2..6, 8, 9, 10): replay, reset reasons, heartbeats with
// fake timers, the stream limit, pull-based fan-out with a slow client, eviction, timer cleanup, and hydration of a frame whose
// entity is gone. No HTTP and no database here; the integration tests run the same hub over a real instance.
import { StreamChangeSchema, StreamHeartbeatSchema, StreamHelloSchema, StreamResetSchema } from '@mcs/shared';
import type { StreamChange } from '@mcs/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHydrator, type ChangeRow, type HydrationQueries } from './hydrate.ts';
import { createStreamHub, type ChangeLog, type StreamCursor, type StreamHub, type StreamSink } from './hub.ts';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const EPOCH = 'a1b2c3d4';
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const SESSION_UID = 'cccccccc-0000-4000-8000-000000000001';

class FakeLog implements ChangeLog {
  rows: ChangeRow[] = [];

  push(over: Partial<ChangeRow> = {}): ChangeRow {
    const seq = this.head() + 1;
    const row: ChangeRow = {
      seq,
      at: NOW,
      kind: 'usage',
      op: 'invalidate',
      sessionUid: SESSION_UID,
      entityId: 1,
      payload: '{}',
      ...over,
    };
    this.rows.push(row);
    return row;
  }

  prune(throughSeq: number): void {
    // the head survives pruning (sqlite_sequence), so remember it
    this.pruned = this.head();
    this.rows = this.rows.filter((row) => row.seq > throughSeq);
  }

  private pruned = 0;

  head(): number {
    return Math.max(this.pruned, this.rows[this.rows.length - 1]?.seq ?? 0);
  }

  oldest(): number | undefined {
    return this.rows[0]?.seq;
  }

  since(afterSeq: number, limit: number): readonly ChangeRow[] {
    return this.rows.filter((row) => row.seq > afterSeq).slice(0, limit);
  }
}

class FakeSink implements StreamSink {
  readonly chunks: string[] = [];
  destroyed = false;
  /** When false, `write` answers false (a full socket buffer). */
  accepting = true;
  private waiters: (() => void)[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.accepting;
  }

  onceDrain(callback: () => void): void {
    this.waiters.push(callback);
  }

  destroy(): void {
    this.destroyed = true;
  }

  drain(): void {
    this.accepting = true;
    const waiting = this.waiters.splice(0);
    for (const callback of waiting) callback();
  }

  text(): string {
    return this.chunks.join('');
  }

  /** The frames as `{ id, event, data }`, `retry` blocks without data skipped. */
  frames(): { id?: string; event?: string; data: unknown }[] {
    return this.text()
      .split('\n\n')
      .filter((block) => block.includes('data: '))
      .map((block) => {
        const fields = new Map<string, string>();
        for (const line of block.split('\n')) {
          const colon = line.indexOf(': ');
          if (colon > 0) fields.set(line.slice(0, colon), line.slice(colon + 2));
        }
        const id = fields.get('id');
        const event = fields.get('event');
        return {
          ...(id === undefined ? {} : { id }),
          ...(event === undefined ? {} : { event }),
          data: JSON.parse(fields.get('data') ?? 'null') as unknown,
        };
      });
  }

  changeSeqs(): number[] {
    return this.frames()
      .filter((frame) => frame.event === 'change')
      .map((frame) => Number(frame.id));
  }
}

interface Rig {
  readonly log: FakeLog;
  readonly hub: StreamHub;
  readonly commit: () => void;
  readonly hydrate: ReturnType<typeof vi.fn<(row: ChangeRow) => StreamChange>>;
  readonly subscribed: () => number;
}

function rig(): Rig {
  const log = new FakeLog();
  let listeners: (() => void)[] = [];
  const hydrate = vi.fn((row: ChangeRow): StreamChange => ({
    seq: row.seq,
    at: new Date(row.at).toISOString(),
    instanceId: INSTANCE_ID,
    kind: 'usage',
    op: 'invalidate',
    sessionId: row.sessionUid,
    data: { sessionId: SESSION_UID },
  }));
  const none = (): void => undefined;
  const hub = createStreamHub({
    log,
    hydrate,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((known) => known !== listener);
      };
    },
    info: { instanceId: INSTANCE_ID, epoch: EPOCH, runtimeVersion: '3.0.0', codeStamp: 'abcdef0123' },
    now: () => NOW,
    logger: { debug: none, info: none, warn: none, error: none },
  });
  return {
    log,
    hub,
    commit: () => {
      for (const listener of [...listeners]) listener();
    },
    hydrate,
    subscribed: () => listeners.length,
  };
}

const live: StreamCursor = { kind: 'none' };
const at = (seq: number): StreamCursor => ({ kind: 'seq', seq });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('opening frames', () => {
  it('sends retry, then hello with the head, and goes live from the head when there is no cursor', () => {
    const { log, hub } = rig();
    log.push();
    log.push();
    const sink = new FakeSink();
    expect(hub.accept(sink, { cursor: live, epoch: undefined })).not.toBeNull();
    expect(sink.chunks[0]).toBe('retry: 3000\n\n');
    const [hello, ...rest] = sink.frames();
    expect(hello?.event).toBe('hello');
    expect(hello?.id).toBeUndefined();
    expect(StreamHelloSchema.parse(hello?.data)).toMatchObject({
      instanceId: INSTANCE_ID,
      epoch: EPOCH,
      headSeq: 2,
      heartbeatMs: 15_000,
      runtimeVersion: '3.0.0',
      codeStamp: 'abcdef0123',
    });
    expect(rest).toEqual([]);
  });

  it('accepts the epoch of this process', () => {
    const { log, hub } = rig();
    log.push();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: at(1), epoch: EPOCH });
    expect(sink.frames().map((frame) => frame.event)).toEqual(['hello']);
  });
});

describe('replay (DA-T-RT-2)', () => {
  it('replays the seqs after the cursor exactly once and in order, then goes live', () => {
    const { log, hub, commit } = rig();
    for (let i = 0; i < 5; i += 1) log.push();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: at(2), epoch: undefined });
    expect(sink.changeSeqs()).toEqual([3, 4, 5]);
    log.push();
    log.push();
    commit();
    commit(); // a second notification with nothing new sends nothing twice
    expect(sink.changeSeqs()).toEqual([3, 4, 5, 6, 7]);
    for (const frame of sink.frames().filter((f) => f.event === 'change')) StreamChangeSchema.parse(frame.data);
  });

  it('replays more than one batch of 100 without a gap', () => {
    const { log, hub } = rig();
    for (let i = 0; i < 350; i += 1) log.push();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: at(10), epoch: undefined });
    expect(sink.changeSeqs()).toEqual(Array.from({ length: 340 }, (_, i) => i + 11));
  });

  it('a cursor equal to the head replays nothing and is not a reset', () => {
    const { log, hub } = rig();
    log.push();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: at(1), epoch: undefined });
    expect(sink.frames().map((frame) => frame.event)).toEqual(['hello']);
  });

  it('builds a frame once per seq for every client (shared frames)', () => {
    const { log, hub, hydrate } = rig();
    for (let i = 0; i < 3; i += 1) log.push();
    const a = new FakeSink();
    const b = new FakeSink();
    hub.accept(a, { cursor: at(0), epoch: undefined });
    hub.accept(b, { cursor: at(0), epoch: undefined });
    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(a.changeSeqs()).toEqual([1, 2, 3]);
    expect(b.changeSeqs()).toEqual([1, 2, 3]);
  });

  it('keeps at most 512 frames and rebuilds an older one on demand', () => {
    const { log, hub, hydrate } = rig();
    for (let i = 0; i < 600; i += 1) log.push();
    const a = new FakeSink();
    hub.accept(a, { cursor: at(0), epoch: undefined });
    hydrate.mockClear();
    const b = new FakeSink();
    hub.accept(b, { cursor: at(500), epoch: undefined }); // inside the 512 newest
    expect(hydrate).not.toHaveBeenCalled();
    const c = new FakeSink();
    hub.accept(c, { cursor: at(10), epoch: undefined }); // older than the cache
    expect(hydrate).toHaveBeenCalled();
    expect(c.changeSeqs()).toHaveLength(590);
  });
});

describe('reset reasons (DA-T-RT-3, DA-T-RT-8)', () => {
  function reset(sink: FakeSink): { id: string | undefined; reason: string; headSeq: number } {
    const frames = sink.frames().filter((frame) => frame.event === 'reset');
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    const data = StreamResetSchema.parse(frame?.data);
    return { id: frame?.id, reason: data.reason, headSeq: data.headSeq };
  }

  it('a foreign epoch is epoch_changed, with id = head', () => {
    const { log, hub } = rig();
    log.push();
    log.push();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: at(1), epoch: 'deadbeef' });
    expect(reset(sink)).toEqual({ id: '2', reason: 'epoch_changed', headSeq: 2 });
    expect(sink.changeSeqs()).toEqual([]);
  });

  it('a cursor that is not an integer is cursor_invalid', () => {
    const { log, hub } = rig();
    log.push();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: { kind: 'invalid' }, epoch: undefined });
    expect(reset(sink)).toEqual({ id: '1', reason: 'cursor_invalid', headSeq: 1 });
  });

  it('a cursor ahead of the head is cursor_ahead', () => {
    const { log, hub } = rig();
    log.push();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: at(99), epoch: undefined });
    expect(reset(sink)).toEqual({ id: '1', reason: 'cursor_ahead', headSeq: 1 });
  });

  it('a pruned cursor is cursor_too_old', () => {
    const { log, hub } = rig();
    for (let i = 0; i < 10; i += 1) log.push();
    log.prune(6); // oldest = 7
    const sink = new FakeSink();
    hub.accept(sink, { cursor: at(3), epoch: undefined });
    expect(reset(sink).reason).toBe('cursor_too_old');
    const edge = new FakeSink();
    hub.accept(edge, { cursor: at(6), epoch: undefined }); // oldest - 1 is still replayable
    expect(edge.changeSeqs()).toEqual([7, 8, 9, 10]);
  });

  it('a cursor more than 2000 behind is cursor_too_old', () => {
    const { log, hub } = rig();
    for (let i = 0; i < 2105; i += 1) log.push();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: at(100), epoch: undefined });
    expect(reset(sink)).toEqual({ id: '2105', reason: 'cursor_too_old', headSeq: 2105 });
    const edge = new FakeSink();
    hub.accept(edge, { cursor: at(105), epoch: undefined }); // exactly 2000 behind is replayed
    expect(edge.changeSeqs()).toHaveLength(2000);
  });

  it('an empty log after pruning everything: the cursor of the head is live, an older one is too old', () => {
    const { log, hub } = rig();
    for (let i = 0; i < 4; i += 1) log.push();
    log.prune(4);
    const live4 = new FakeSink();
    hub.accept(live4, { cursor: at(4), epoch: undefined });
    expect(live4.frames().map((frame) => frame.event)).toEqual(['hello']);
    const old = new FakeSink();
    hub.accept(old, { cursor: at(2), epoch: undefined });
    expect(reset(old).reason).toBe('cursor_too_old');
  });

  it('goes live from the head after a reset: later commits are delivered', () => {
    const { log, hub, commit } = rig();
    log.push();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: at(50), epoch: undefined });
    log.push();
    commit();
    expect(sink.changeSeqs()).toEqual([2]);
  });

  it('a row pruned while a client lags is a reset, never a silent gap', () => {
    const { log, hub, commit } = rig();
    log.push();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: live, epoch: undefined });
    log.push();
    log.push();
    log.push();
    log.prune(2); // the client holds 1; seq 2 is gone
    commit();
    expect(sink.changeSeqs()).toEqual([]);
    expect(sink.frames().filter((frame) => frame.event === 'reset')).toHaveLength(1);
  });
});

describe('heartbeat (DA-T-RT-4)', () => {
  it('sends a named heartbeat every 15 s with the head and the epoch, and no id', () => {
    const { log, hub } = rig();
    log.push();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: live, epoch: undefined });
    vi.advanceTimersByTime(14_999);
    expect(sink.frames().filter((frame) => frame.event === 'heartbeat')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    log.push();
    vi.advanceTimersByTime(15_000);
    const beats = sink.frames().filter((frame) => frame.event === 'heartbeat');
    expect(beats).toHaveLength(2);
    expect(beats[0]?.id).toBeUndefined();
    expect(StreamHeartbeatSchema.parse(beats[0]?.data)).toMatchObject({ headSeq: 1, epoch: EPOCH });
    expect(StreamHeartbeatSchema.parse(beats[1]?.data)).toMatchObject({ headSeq: 2, epoch: EPOCH });
    expect(sink.text()).not.toMatch(/^:/m); // no comment lines
  });

  it('skips a heartbeat while the client has not drained (the buffer stays bounded)', () => {
    const { log, hub } = rig();
    log.push();
    const sink = new FakeSink();
    sink.accepting = false;
    hub.accept(sink, { cursor: live, epoch: undefined });
    const before = sink.chunks.length;
    vi.advanceTimersByTime(15_000);
    expect(sink.chunks.length).toBe(before);
  });
});

describe('limits (DA-T-RT-9)', () => {
  it('accepts 16 streams and refuses the 17th; a closed stream frees a place', () => {
    const { hub } = rig();
    const handles = Array.from({ length: 16 }, () => hub.accept(new FakeSink(), { cursor: live, epoch: undefined }));
    expect(handles.every((handle) => handle !== null)).toBe(true);
    expect(hub.hasCapacity()).toBe(false);
    expect(hub.accept(new FakeSink(), { cursor: live, epoch: undefined })).toBeNull();
    handles[3]?.close();
    expect(hub.hasCapacity()).toBe(true);
    expect(hub.accept(new FakeSink(), { cursor: live, epoch: undefined })).not.toBeNull();
  });
});

describe('slow clients (DA-T-RT-6)', () => {
  it('stops writing to a client that does not drain and keeps a fast client complete', () => {
    const { log, hub, commit } = rig();
    const slow = new FakeSink();
    const fast = new FakeSink();
    hub.accept(slow, { cursor: live, epoch: undefined });
    hub.accept(fast, { cursor: live, epoch: undefined });
    slow.accepting = false;
    for (let i = 0; i < 400; i += 1) log.push();
    commit();
    expect(fast.changeSeqs()).toHaveLength(400);
    // one write answered false, then the hub waited: at most one frame reached the slow sink
    expect(slow.changeSeqs()).toHaveLength(1);
    expect(slow.destroyed).toBe(false);
  });

  it('evicts a client that stays undrained for 30 s and clears its timers', () => {
    const { log, hub, commit, subscribed } = rig();
    const slow = new FakeSink();
    hub.accept(slow, { cursor: live, epoch: undefined });
    slow.accepting = false;
    log.push();
    log.push();
    commit();
    vi.advanceTimersByTime(29_999);
    expect(slow.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(slow.destroyed).toBe(true);
    expect(hub.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(subscribed()).toBe(0);
  });

  it('a drain before the deadline resumes the replay in order and cancels the eviction', () => {
    const { log, hub, commit } = rig();
    const sink = new FakeSink();
    hub.accept(sink, { cursor: live, epoch: undefined });
    sink.accepting = false;
    for (let i = 0; i < 5; i += 1) log.push();
    commit();
    expect(sink.changeSeqs()).toEqual([1]);
    vi.advanceTimersByTime(10_000);
    sink.drain();
    expect(sink.changeSeqs()).toEqual([1, 2, 3, 4, 5]);
    vi.advanceTimersByTime(60_000);
    expect(sink.destroyed).toBe(false);
  });
});

describe('disconnect cleanup (DA-T-RT-5)', () => {
  it('removes six aborted clients, clears every timer and unsubscribes from the commits', () => {
    const { hub, subscribed } = rig();
    const baseline = vi.getTimerCount();
    const handles = Array.from({ length: 6 }, () => hub.accept(new FakeSink(), { cursor: live, epoch: undefined }));
    expect(hub.size).toBe(6);
    expect(vi.getTimerCount()).toBeGreaterThan(baseline);
    expect(subscribed()).toBe(1);
    for (const handle of handles) handle?.close();
    expect(hub.size).toBe(0);
    expect(vi.getTimerCount()).toBe(baseline);
    expect(subscribed()).toBe(0);
    for (const handle of handles) handle?.close(); // closing twice is harmless
  });

  it('closeAll destroys every sink', () => {
    const { hub } = rig();
    const sinks = [new FakeSink(), new FakeSink()];
    for (const sink of sinks) hub.accept(sink, { cursor: live, epoch: undefined });
    hub.closeAll();
    expect(sinks.every((sink) => sink.destroyed)).toBe(true);
    expect(hub.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an abort storm of connect and close leaves nothing behind', () => {
    const { log, hub, subscribed } = rig();
    log.push();
    for (let i = 0; i < 500; i += 1) hub.accept(new FakeSink(), { cursor: at(0), epoch: undefined })?.close();
    expect(hub.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(subscribed()).toBe(0);
  });

  it('a sink that fails to write is closed and dropped, and the other client is served', () => {
    const { log, hub, commit } = rig();
    const bad = new FakeSink();
    bad.write = (): boolean => {
      throw new Error('socket closed');
    };
    const good = new FakeSink();
    hub.accept(good, { cursor: live, epoch: undefined });
    hub.accept(bad, { cursor: live, epoch: undefined });
    log.push();
    commit();
    expect(good.changeSeqs()).toEqual([1]);
    expect(hub.size).toBe(1);
    expect(bad.destroyed).toBe(true);
  });
});

describe('frame hydration of a deleted entity (DA-T-RT-10)', () => {
  function queries(over: Partial<HydrationQueries> = {}): HydrationQueries {
    return {
      sessionSummaries: () => [],
      agentNode: () => null,
      workflowRun: () => null,
      eventsByIdRange: () => [],
      toolCallsByIds: () => [],
      workItem: () => null,
      alert: () => null,
      health: () => {
        throw new Error('not needed');
      },
      ...over,
    };
  }

  function hydrator(over: Partial<HydrationQueries> = {}): (row: ChangeRow) => StreamChange {
    const none = (): void => undefined;
    return createHydrator({
      instanceId: INSTANCE_ID,
      queries: queries(over),
      now: () => NOW,
      logger: { warn: none },
    });
  }

  const base: ChangeRow = {
    seq: 7,
    at: NOW,
    kind: 'session',
    op: 'upsert',
    sessionUid: SESSION_UID,
    entityId: 41,
    payload: '{}',
  };

  it('a session deleted before hydration is data null with its own seq', () => {
    const frame = hydrator()(base);
    expect(StreamChangeSchema.parse(frame)).toMatchObject({
      seq: 7,
      kind: 'session',
      op: 'upsert',
      sessionId: SESSION_UID,
      data: null,
    });
  });

  it('agent, workflow, work item and alert entities that no longer exist are data null', () => {
    const h = hydrator();
    for (const kind of ['agent', 'workflow', 'work_item', 'alert'] as const) {
      const frame = h({ ...base, kind, op: 'upsert' });
      expect(StreamChangeSchema.parse(frame).data).toBeNull();
    }
  });

  it('a query that throws gives data null rather than a failed stream', () => {
    const frame = hydrator({
      sessionSummaries: () => {
        throw new Error('database is locked');
      },
    })(base);
    expect(frame.data).toBeNull();
  });

  it('event/append asks for at most 50 items and says truncated for a larger count', () => {
    let asked = 0;
    const frame = hydrator({
      eventsByIdRange: (_session, _from, _to, limit) => {
        asked = limit;
        return [];
      },
    })({ ...base, kind: 'event', op: 'append', payload: JSON.stringify({ from: 10, to: 1009, count: 1000 }) });
    expect(asked).toBe(50);
    expect(StreamChangeSchema.parse(frame).data).toEqual({ items: [], count: 1000, truncated: true });
  });

  it('tool_call/upsert carries the payload truncated flag and only the ids that still exist', () => {
    let asked: readonly number[] = [];
    const frame = hydrator({
      toolCallsByIds: (ids) => {
        asked = ids;
        return [];
      },
    })({
      ...base,
      kind: 'tool_call',
      op: 'upsert',
      payload: JSON.stringify({ ids: [1, 2], truncated: true }),
    });
    expect(asked).toEqual([1, 2]);
    expect(frame.data).toEqual({ items: [], truncated: true });
  });

  it('transcript/append and attempt/upsert need no database read', () => {
    const h = hydrator();
    expect(
      h({ ...base, kind: 'transcript', op: 'append', payload: '{"size":900,"tail":850,"agent":null}' }).data,
    ).toEqual({ agentId: 'main', sizeBytes: 900 });
    expect(
      h({ ...base, kind: 'transcript', op: 'append', payload: '{"size":9,"tail":8,"agent":"agent-abc"}' }).data,
    ).toEqual({ agentId: 'agent-abc', sizeBytes: 9 });
    expect(
      h({ ...base, kind: 'attempt', op: 'upsert', sessionUid: null, payload: '{"ids":[1,2,3,4],"truncated":false}' })
        .data,
    ).toEqual({ ids: [1, 2, 3, 4], truncated: false });
  });

  it('session/delete and usage/invalidate are built from the row alone', () => {
    const h = hydrator();
    expect(h({ ...base, op: 'delete' }).data).toBeNull();
    expect(h({ ...base, kind: 'usage', op: 'invalidate' }).data).toEqual({ sessionId: SESSION_UID });
  });

  it('a payload that is not valid JSON never fails the frame', () => {
    const frame = hydrator()({ ...base, kind: 'event', op: 'append', payload: 'not json' });
    expect(StreamChangeSchema.parse(frame).data).toEqual({ items: [], count: 0, truncated: true });
  });
});
