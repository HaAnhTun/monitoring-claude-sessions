import type { TerminalHelloEvent, TerminalSessionsEvent } from '@mcs/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeEventSources, type FakeEventSources } from '../test/fake-event-source.ts';
import { FIXTURE_EPOCH, FIXTURE_INSTANCE_ID, iso, makeTerminalSession } from '../test/fixtures/index.ts';
import {
  createEventsClient,
  HIDDEN_CLOSE_MS,
  TERMINAL_EVENTS_LOCK,
  type EventsClient,
  type EventsClientOptions,
  type LockManagerLike,
} from './events-client.ts';
import type { VisibilityLike } from './protocol.ts';

const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);
const URL_OF_EVENTS = '/api/v3/terminal/events';
const NEW_EPOCH = 'ffeeddcc';

class FakeVisibility extends EventTarget implements VisibilityLike {
  visibilityState = 'visible';
  setState(next: 'visible' | 'hidden'): void {
    this.visibilityState = next;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

/**
 * An exclusive Web Lock manager shared by the clients of one test, i.e. one browser. A request queues; the grant is asynchronous
 * like the real one (a microtask); the lock is held until the promise returned by the callback settles; an aborted request that
 * has not been granted rejects with an AbortError.
 */
class FakeLockManager implements LockManagerLike {
  readonly requests: { name: string; mode: string; signal: AbortSignal; granted: boolean }[] = [];
  private holder: Promise<void> | null = null;
  private readonly queue: {
    entry: { name: string; mode: string; signal: AbortSignal; granted: boolean };
    callback: () => Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];

  request(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry = { name, mode: options.mode, signal: options.signal, granted: false };
      this.requests.push(entry);
      const item = { entry, callback, resolve, reject };
      this.queue.push(item);
      options.signal.addEventListener('abort', () => {
        const at = this.queue.indexOf(item);
        if (at === -1) return;
        this.queue.splice(at, 1);
        reject(new DOMException('The lock request was aborted', 'AbortError'));
      });
      queueMicrotask(() => {
        this.grant();
      });
    });
  }

  /** How many requests wait for the lock right now. */
  get waiting(): number {
    return this.queue.length;
  }

  get held(): boolean {
    return this.holder !== null;
  }

  private grant(): void {
    if (this.holder !== null) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    next.entry.granted = true;
    const running = Promise.resolve(next.callback());
    this.holder = running.then(
      () => undefined,
      () => undefined,
    );
    void this.holder.then(() => {
      this.holder = null;
      next.resolve();
      this.grant();
    });
  }
}

function hello(over: Partial<TerminalHelloEvent> = {}): TerminalHelloEvent {
  return { instanceId: FIXTURE_INSTANCE_ID, epoch: FIXTURE_EPOCH, serverTime: iso(0), heartbeatMs: 15_000, ...over };
}

function sessionsEvent(version: number, names: readonly number[] = []): TerminalSessionsEvent {
  return { version, sessions: names.map((n) => makeTerminalSession(n)) };
}

interface Harness {
  sources: FakeEventSources;
  client: EventsClient;
  applied: TerminalSessionsEvent[];
  hellos: TerminalHelloEvent[];
  epochs: { epoch: string; previous: string }[];
  instanceChanged: string[];
  revoked: number;
  visibility: FakeVisibility;
  win: EventTarget;
}

function setup(
  over: Partial<EventsClientOptions> = {},
  shared?: { sources?: FakeEventSources; locks?: LockManagerLike | null; visibility?: FakeVisibility },
): Harness {
  const sources = shared?.sources ?? createFakeEventSources();
  const visibility = shared?.visibility ?? new FakeVisibility();
  const win = new EventTarget();
  const applied: TerminalSessionsEvent[] = [];
  const hellos: TerminalHelloEvent[] = [];
  const epochs: { epoch: string; previous: string }[] = [];
  const instanceChanged: string[] = [];
  const state = { revoked: 0 };
  const client = createEventsClient({
    url: URL_OF_EVENTS,
    esFactory: sources.factory,
    locks: shared?.locks === undefined ? null : shared.locks,
    visibility,
    windowTarget: win,
    onSessions: (event) => applied.push(event),
    onHello: (event) => hellos.push(event),
    onEpochChanged: (epoch, previous) => epochs.push({ epoch, previous }),
    onInstanceChanged: (id) => instanceChanged.push(id),
    onRevoked: () => {
      state.revoked += 1;
    },
    ...over,
  });
  return {
    sources,
    client,
    applied,
    hellos,
    epochs,
    instanceChanged,
    get revoked() {
      return state.revoked;
    },
    visibility,
    win,
  };
}

/** start, the browser's open event and the server's hello. */
function openStream(h: Harness, over: Partial<TerminalHelloEvent> = {}): void {
  h.client.start();
  h.sources.last().open();
  h.sources.last().emit('hello', hello(over));
}

/** Lets the lock manager grant and the client react (grants are asynchronous, like the browser's). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opening and the frames', () => {
  it('start() opens one source at the events path and listens for the three events', () => {
    const h = setup();
    expect(h.client.snapshot().status).toBe('idle');
    h.client.start();
    expect(h.client.snapshot().status).toBe('connecting');
    expect(h.sources.urls()).toEqual([URL_OF_EVENTS]);
    expect(h.sources.last().eventNames.sort()).toEqual(['heartbeat', 'hello', 'sessions']);
    h.client.stop();
  });

  it('goes open on the browser open event, and also when a frame arrives first', () => {
    const h = setup();
    h.client.start();
    h.sources.last().open();
    expect(h.client.snapshot().status).toBe('open');
    h.client.stop();
    const second = setup();
    second.client.start();
    second.sources.last().emit('hello', hello());
    expect(second.client.snapshot().status).toBe('open');
    second.client.stop();
  });

  it('start() twice does not open a second source', () => {
    const h = setup();
    h.client.start();
    h.client.start();
    expect(h.sources.instances).toHaveLength(1);
    h.client.stop();
  });

  it('records the instance and the epoch of the hello and passes it on', () => {
    const h = setup();
    openStream(h);
    const snapshot = h.client.snapshot();
    expect(snapshot.instanceId).toBe(FIXTURE_INSTANCE_ID);
    expect(snapshot.epoch).toBe(FIXTURE_EPOCH);
    expect(h.hellos).toEqual([hello()]);
    h.client.stop();
  });

  it('hands every newer list to the owner', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('sessions', sessionsEvent(1, [1]));
    h.sources.last().emit('sessions', sessionsEvent(2, [1, 2]));
    expect(h.applied.map((e) => [e.version, e.sessions.length])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(h.client.snapshot().version).toBe(2);
    h.client.stop();
  });

  it('latest wins: an older or equal version is ignored and counted', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('sessions', sessionsEvent(5, [1, 2]));
    h.sources.last().emit('sessions', sessionsEvent(4, [1]));
    h.sources.last().emit('sessions', sessionsEvent(5, [3]));
    h.sources.last().emit('sessions', sessionsEvent(6, []));
    expect(h.applied.map((e) => e.version)).toEqual([5, 6]);
    expect(h.client.snapshot().counters.stale).toBe(2);
    h.client.stop();
  });

  it('a frame with a repeated version after a reconnect inside one epoch is the same list: ignored', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('sessions', sessionsEvent(3, [1]));
    h.sources.last().fail();
    vi.advanceTimersByTime(2000);
    h.sources.last().open();
    h.sources.last().emit('hello', hello());
    h.sources.last().emit('sessions', sessionsEvent(3, [1]));
    expect(h.applied.map((e) => e.version)).toEqual([3]);
    h.sources.last().emit('sessions', sessionsEvent(4, [1, 2]));
    expect(h.applied.map((e) => e.version)).toEqual([3, 4]);
    expect(h.epochs).toEqual([]);
    h.client.stop();
  });

  it('a new epoch resets the version: version 1 of the restarted server wins over version 57 of the old one', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('sessions', sessionsEvent(57, [1, 2]));
    h.sources.last().fail();
    vi.advanceTimersByTime(2000);
    h.sources.last().open();
    h.sources.last().emit('hello', hello({ epoch: NEW_EPOCH }));
    h.sources.last().emit('sessions', sessionsEvent(1, []));
    expect(h.epochs).toEqual([{ epoch: NEW_EPOCH, previous: FIXTURE_EPOCH }]);
    expect(h.applied.map((e) => e.version)).toEqual([57, 1]);
    expect(h.applied.at(-1)?.sessions).toEqual([]);
    expect(h.client.snapshot().epoch).toBe(NEW_EPOCH);
    expect(h.client.snapshot().version).toBe(1);
    h.client.stop();
  });

  it('the first hello is not an epoch change', () => {
    const h = setup();
    openStream(h);
    expect(h.epochs).toEqual([]);
    h.client.stop();
  });

  it('stops and says so when another instance now owns the address', () => {
    const h = setup({ expectedInstanceId: FIXTURE_INSTANCE_ID });
    h.client.start();
    h.sources.last().open();
    h.sources.last().emit('hello', hello({ instanceId: '33333333-3333-4333-8333-333333333333' }));
    expect(h.instanceChanged).toEqual(['33333333-3333-4333-8333-333333333333']);
    expect(h.client.snapshot().status).toBe('stopped');
    expect(h.sources.last().closed).toBe(true);
    h.sources.last().emit('sessions', sessionsEvent(1, [1]), { force: true });
    expect(h.applied).toEqual([]);
  });

  it('accepts the hello of the expected instance', () => {
    const h = setup({ expectedInstanceId: FIXTURE_INSTANCE_ID });
    openStream(h);
    expect(h.instanceChanged).toEqual([]);
    expect(h.client.snapshot().status).toBe('open');
    h.client.stop();
  });

  it.each([
    ['text that is not JSON', 'sessions', 'not json'],
    ['a list with an extra key', 'sessions', { version: 1, sessions: [], extra: true }],
    ['a negative version', 'sessions', { version: -1, sessions: [] }],
    ['a session of the wrong shape', 'sessions', { version: 1, sessions: [{ name: 'x' }] }],
    ['a hello without an epoch', 'hello', { instanceId: FIXTURE_INSTANCE_ID, serverTime: iso(0), heartbeatMs: 1 }],
    ['a heartbeat without a time', 'heartbeat', {}],
  ] as const)('counts and ignores %s, and the stream stays open', (_label, type, data) => {
    const h = setup();
    openStream(h);
    h.sources.last().emit(type, data);
    expect(h.client.snapshot().counters.invalid).toBe(1);
    expect(h.client.snapshot().status).toBe('open');
    expect(h.applied).toEqual([]);
    h.sources.last().emit('sessions', sessionsEvent(1, [1]));
    expect(h.applied).toHaveLength(1);
    h.client.stop();
  });

  it('ignores an event of a source it closed', () => {
    const h = setup();
    openStream(h);
    const old = h.sources.last();
    old.fail();
    old.emit('sessions', sessionsEvent(9, [1]), { force: true });
    expect(h.applied).toEqual([]);
    h.client.stop();
  });
});

describe('heartbeat watchdog', () => {
  it('stays open while heartbeats arrive every heartbeatMs', () => {
    const h = setup();
    openStream(h);
    for (let i = 0; i < 8; i += 1) {
      vi.advanceTimersByTime(15_000);
      h.sources.last().emit('heartbeat', { serverTime: iso(0) });
    }
    expect(h.client.snapshot().status).toBe('open');
    expect(h.sources.instances).toHaveLength(1);
    h.client.stop();
  });

  it('closes the source and backs off after 2.5 heartbeat intervals of silence', () => {
    const h = setup();
    openStream(h);
    const source = h.sources.last();
    vi.advanceTimersByTime(37_000);
    expect(h.client.snapshot().status).toBe('open');
    vi.advanceTimersByTime(1000);
    expect(h.client.snapshot().status).toBe('backoff');
    expect(h.client.snapshot().lastError).toBe('no heartbeat');
    expect(source.closeCount).toBe(1);
    h.client.stop();
  });

  it('counts any frame as life, not only a heartbeat', () => {
    const h = setup();
    openStream(h);
    vi.advanceTimersByTime(30_000);
    h.sources.last().emit('sessions', sessionsEvent(1, [1]));
    vi.advanceTimersByTime(30_000);
    expect(h.client.snapshot().status).toBe('open');
    h.client.stop();
  });

  it('follows the heartbeat interval the hello announces', () => {
    const h = setup();
    openStream(h, { heartbeatMs: 2000 });
    vi.advanceTimersByTime(4900);
    expect(h.client.snapshot().status).toBe('open');
    vi.advanceTimersByTime(200);
    expect(h.client.snapshot().status).toBe('backoff');
    h.client.stop();
  });

  it('gives up on a connection that never opens after twice the heartbeat interval (at least 10 s)', () => {
    const h = setup();
    h.client.start();
    vi.advanceTimersByTime(29_999);
    expect(h.client.snapshot().status).toBe('connecting');
    vi.advanceTimersByTime(2);
    expect(h.client.snapshot().status).toBe('backoff');
    expect(h.client.snapshot().lastError).toBe('connect timeout');
    h.client.stop();
  });
});

describe('client-owned reconnect', () => {
  it('closes the failed source, waits 2, 4, 8 and 15 s, and counts the reconnects', () => {
    const h = setup();
    h.client.start();
    const delays = [2000, 4000, 8000, 15_000, 15_000];
    for (const [index, delay] of delays.entries()) {
      const failed = h.sources.last();
      failed.fail();
      expect(failed.closeCount).toBe(1);
      expect(h.client.snapshot().status).toBe('backoff');
      expect(h.client.snapshot().attempt).toBe(index + 1);
      expect(h.client.snapshot().nextRetryAt).toBe(Date.now() + delay);
      vi.advanceTimersByTime(delay - 1);
      expect(h.sources.instances).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(h.sources.instances).toHaveLength(index + 2);
    }
    expect(h.client.snapshot().counters.reconnects).toBe(delays.length);
    h.client.stop();
  });

  it('starts the delays over after an open', () => {
    const h = setup();
    h.client.start();
    h.sources.last().fail();
    vi.advanceTimersByTime(2000);
    h.sources.last().fail();
    vi.advanceTimersByTime(4000);
    h.sources.last().open();
    expect(h.client.snapshot().attempt).toBe(0);
    h.sources.last().fail();
    expect(h.client.snapshot().nextRetryAt).toBe(Date.now() + 2000);
    h.client.stop();
  });

  it('retryNow and the online event skip the wait; both do nothing otherwise', () => {
    const h = setup();
    h.client.retryNow();
    h.win.dispatchEvent(new Event('online'));
    expect(h.sources.instances).toHaveLength(0);
    h.client.start();
    h.client.retryNow();
    h.win.dispatchEvent(new Event('online'));
    expect(h.sources.instances).toHaveLength(1);
    h.sources.last().fail();
    h.client.retryNow();
    expect(h.sources.instances).toHaveLength(2);
    h.sources.last().fail();
    h.win.dispatchEvent(new Event('online'));
    expect(h.sources.instances).toHaveLength(3);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
    h.client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('stop', () => {
  it('closes the source exactly once, clears every timer and is idempotent', () => {
    const h = setup();
    openStream(h);
    const source = h.sources.last();
    h.client.stop();
    h.client.stop();
    expect(source.closeCount).toBe(1);
    expect(h.client.snapshot().status).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives StrictMode: start, stop, start leaves one open source', () => {
    const h = setup();
    h.client.start();
    const first = h.sources.last();
    h.client.stop();
    h.client.start();
    expect(first.closed).toBe(true);
    expect(h.sources.instances).toHaveLength(2);
    expect(h.sources.last().closed).toBe(false);
    h.sources.last().open();
    expect(h.client.snapshot().status).toBe('open');
    h.client.stop();
  });

  it('does not reconnect after stop, whatever the old source does', () => {
    const h = setup();
    h.client.start();
    const source = h.sources.last();
    h.client.stop();
    source.fail({ force: true });
    vi.advanceTimersByTime(60_000);
    expect(h.sources.instances).toHaveLength(1);
  });
});

describe('one stream per browser: the Web Lock', () => {
  it('asks for the lock caw-terminal-events in exclusive mode and opens a source only once it holds it', async () => {
    const locks = new FakeLockManager();
    const h = setup({}, { locks });
    h.client.start();
    expect(h.client.snapshot().status).toBe('waiting');
    expect(h.sources.instances).toHaveLength(0);
    await settle();
    expect(locks.requests).toHaveLength(1);
    expect(locks.requests[0]?.name).toBe(TERMINAL_EVENTS_LOCK);
    expect(locks.requests[0]?.name).toBe('caw-terminal-events');
    expect(locks.requests[0]?.mode).toBe('exclusive');
    expect(h.sources.instances).toHaveLength(1);
    expect(h.client.snapshot().status).toBe('connecting');
    expect(h.client.snapshot().holdsLock).toBe(true);
    h.client.stop();
    await settle();
  });

  it('two tabs hold ONE source: the second waits and opens nothing', async () => {
    const locks = new FakeLockManager();
    const sources = createFakeEventSources();
    const a = setup({}, { locks, sources });
    const b = setup({}, { locks, sources });
    a.client.start();
    b.client.start();
    await settle();
    expect(sources.instances).toHaveLength(1);
    expect(a.client.snapshot().holdsLock).toBe(true);
    expect(b.client.snapshot().status).toBe('waiting');
    expect(b.client.snapshot().holdsLock).toBe(false);
    expect(locks.waiting).toBe(1);
    a.client.stop();
    b.client.stop();
    await settle();
  });

  it('three tabs still hold one source', async () => {
    const locks = new FakeLockManager();
    const sources = createFakeEventSources();
    const tabs = [setup({}, { locks, sources }), setup({}, { locks, sources }), setup({}, { locks, sources })];
    for (const tab of tabs) tab.client.start();
    await settle();
    expect(sources.instances).toHaveLength(1);
    for (const tab of tabs) tab.client.stop();
    await settle();
  });

  it('when the holder stops, the waiting tab takes the lock and opens the source', async () => {
    const locks = new FakeLockManager();
    const sources = createFakeEventSources();
    const a = setup({}, { locks, sources });
    const b = setup({}, { locks, sources });
    a.client.start();
    b.client.start();
    await settle();
    sources.instances[0]?.open();
    a.client.stop();
    await settle();
    expect(sources.instances).toHaveLength(2);
    expect(sources.instances[0]?.closed).toBe(true);
    expect(b.client.snapshot().holdsLock).toBe(true);
    expect(b.client.snapshot().status).toBe('connecting');
    b.client.stop();
    await settle();
    expect(locks.held).toBe(false);
  });

  it('keeps the lock while its source is failing and backing off (no thrash through the queue)', async () => {
    const locks = new FakeLockManager();
    const sources = createFakeEventSources();
    const a = setup({}, { locks, sources });
    const b = setup({}, { locks, sources });
    a.client.start();
    b.client.start();
    await settle();
    sources.last().fail();
    expect(a.client.snapshot().status).toBe('backoff');
    expect(a.client.snapshot().holdsLock).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sources.instances).toHaveLength(2);
    expect(b.client.snapshot().status).toBe('waiting');
    a.client.stop();
    b.client.stop();
    await settle();
  });

  it('a tab hidden for 15 s closes its stream and releases the lock; a visible tab takes over', async () => {
    const locks = new FakeLockManager();
    const sources = createFakeEventSources();
    const a = setup({}, { locks, sources });
    const b = setup({}, { locks, sources });
    a.client.start();
    b.client.start();
    await settle();
    const first = sources.last();
    first.open();
    a.visibility.setState('hidden');
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS - 1);
    expect(first.closed).toBe(false);
    expect(a.client.snapshot().status).toBe('open');
    await vi.advanceTimersByTimeAsync(1);
    expect(first.closed).toBe(true);
    expect(a.client.snapshot().status).toBe('paused');
    expect(a.client.snapshot().holdsLock).toBe(false);
    expect(sources.instances).toHaveLength(2);
    expect(b.client.snapshot().holdsLock).toBe(true);
    a.client.stop();
    b.client.stop();
    await settle();
  });

  it('a tab hidden for less than 15 s keeps its stream', async () => {
    const h = setup();
    openStream(h);
    h.visibility.setState('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    h.sources.last().emit('heartbeat', { serverTime: iso(0) });
    h.visibility.setState('visible');
    // past the 15 s mark of the hidden timer, which must not fire any more, and short of the watchdog
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.sources.instances).toHaveLength(1);
    expect(h.sources.last().closed).toBe(false);
    h.client.stop();
  });

  it('a hidden tab that is waiting for the lock aborts its pending request after 15 s', async () => {
    const locks = new FakeLockManager();
    const sources = createFakeEventSources();
    const a = setup({}, { locks, sources });
    const b = setup({}, { locks, sources });
    a.client.start();
    b.client.start();
    await settle();
    const request = locks.requests[1];
    expect(request?.signal.aborted).toBe(false);
    b.visibility.setState('hidden');
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    expect(request?.signal.aborted).toBe(true);
    expect(b.client.snapshot().status).toBe('paused');
    expect(locks.waiting).toBe(0);
    a.client.stop();
    await settle();
    expect(sources.instances).toHaveLength(1);
    b.client.stop();
    await settle();
  });

  it('a waiting tab that becomes visible again in time keeps its place in the queue', async () => {
    const locks = new FakeLockManager();
    const sources = createFakeEventSources();
    const a = setup({}, { locks, sources });
    const b = setup({}, { locks, sources });
    a.client.start();
    b.client.start();
    await settle();
    b.visibility.setState('hidden');
    await vi.advanceTimersByTimeAsync(5000);
    b.visibility.setState('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(locks.requests[1]?.signal.aborted).toBe(false);
    expect(b.client.snapshot().status).toBe('waiting');
    a.client.stop();
    await settle();
    expect(b.client.snapshot().holdsLock).toBe(true);
    b.client.stop();
    await settle();
  });

  it('reopens on visible: a paused tab asks for the lock again and opens a fresh source', async () => {
    const locks = new FakeLockManager();
    const h = setup({}, { locks });
    h.client.start();
    await settle();
    h.sources.last().open();
    h.visibility.setState('hidden');
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    expect(h.client.snapshot().status).toBe('paused');
    await settle();
    expect(locks.held).toBe(false);
    h.visibility.setState('visible');
    await settle();
    expect(locks.requests).toHaveLength(2);
    expect(h.sources.instances).toHaveLength(2);
    expect(h.client.snapshot().status).toBe('connecting');
    expect(h.client.snapshot().attempt).toBe(0);
    h.client.stop();
    await settle();
  });

  it('a tab that starts hidden asks for nothing and opens nothing until it is visible', async () => {
    const locks = new FakeLockManager();
    const visibility = new FakeVisibility();
    visibility.visibilityState = 'hidden';
    const h = setup({}, { locks, visibility });
    h.client.start();
    await settle();
    expect(h.client.snapshot().status).toBe('paused');
    expect(locks.requests).toHaveLength(0);
    expect(h.sources.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    visibility.setState('visible');
    await settle();
    expect(locks.requests).toHaveLength(1);
    expect(h.sources.instances).toHaveLength(1);
    h.client.stop();
    await settle();
  });

  it('opens a source directly without a lock manager (a browser without Web Locks, and the tests)', () => {
    const sources = createFakeEventSources();
    const a = setup({}, { locks: null, sources });
    const b = setup({}, { locks: null, sources });
    a.client.start();
    b.client.start();
    expect(sources.instances).toHaveLength(2);
    expect(a.client.snapshot().holdsLock).toBe(false);
    a.client.stop();
    b.client.stop();
  });

  it('falls back to opening directly when the lock manager itself fails', async () => {
    const failing: LockManagerLike = {
      request: () => Promise.reject(new DOMException('no locks here', 'SecurityError')),
    };
    const h = setup({}, { locks: failing });
    h.client.start();
    await settle();
    expect(h.sources.instances).toHaveLength(1);
    expect(h.client.snapshot().status).toBe('connecting');
    h.client.stop();
  });

  it('falls back to opening directly when the lock manager throws at once', () => {
    const throwing: LockManagerLike = {
      request: () => {
        throw new TypeError('locks unavailable');
      },
    };
    const h = setup({}, { locks: throwing });
    h.client.start();
    expect(h.sources.instances).toHaveLength(1);
    h.client.stop();
  });

  it('gives a late grant back at once when the client was stopped meanwhile (no source, the lock is free)', async () => {
    // a manager that does not honour the abort: the grant of the abandoned request still arrives
    const state: { grant: (() => Promise<void>) | null } = { grant: null };
    const manual: LockManagerLike = {
      request: (_name, _options, callback) =>
        new Promise<void>((resolve) => {
          state.grant = async () => {
            await callback();
            resolve();
          };
        }),
    };
    const h = setup({}, { locks: manual });
    h.client.start();
    expect(h.client.snapshot().status).toBe('waiting');
    h.client.stop();
    await state.grant?.();
    expect(h.sources.instances).toHaveLength(0);
    expect(h.client.snapshot().status).toBe('stopped');
    expect(h.client.snapshot().holdsLock).toBe(false);
  });

  it('releases the lock when the client stops, so a restart of the same tab can take it again', async () => {
    const locks = new FakeLockManager();
    const h = setup({}, { locks });
    h.client.start();
    await settle();
    h.client.stop();
    await settle();
    expect(locks.held).toBe(false);
    h.client.start();
    await settle();
    expect(h.sources.instances).toHaveLength(2);
    h.client.stop();
    await settle();
  });
});

describe('credential revoked', () => {
  it('asks the access check after a failure; a negative answer stops the client and tells the owner once', async () => {
    const checkAccess = vi.fn(() => Promise.resolve(false));
    const h = setup({ checkAccess });
    openStream(h);
    h.sources.last().fail();
    expect(checkAccess).toHaveBeenCalledTimes(1);
    await settle();
    expect(h.client.snapshot().status).toBe('revoked');
    expect(h.revoked).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(h.sources.instances).toHaveLength(1);
    h.client.stop();
  });

  it('keeps backing off and retrying when the check says the session is fine', async () => {
    const checkAccess = vi.fn(() => Promise.resolve(true));
    const h = setup({ checkAccess });
    openStream(h);
    h.sources.last().fail();
    await settle();
    expect(h.client.snapshot().status).toBe('backoff');
    expect(h.revoked).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sources.instances).toHaveLength(2);
    h.client.stop();
  });

  it('keeps backing off when the check itself fails (the server may be restarting)', async () => {
    const checkAccess = vi.fn(() => Promise.reject(new Error('network')));
    const h = setup({ checkAccess });
    openStream(h);
    h.sources.last().fail();
    await settle();
    expect(h.client.snapshot().status).toBe('backoff');
    expect(h.revoked).toBe(0);
    h.client.stop();
  });

  it('asks again after each further failure', async () => {
    const checkAccess = vi.fn(() => Promise.resolve(true));
    const h = setup({ checkAccess });
    h.client.start();
    h.sources.last().fail();
    await vi.advanceTimersByTimeAsync(2000);
    h.sources.last().fail();
    expect(checkAccess).toHaveBeenCalledTimes(2);
    h.client.stop();
  });

  it('ignores an answer that arrives after stop()', async () => {
    let answer: (authenticated: boolean) => void = () => undefined;
    const checkAccess = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const h = setup({ checkAccess });
    openStream(h);
    h.sources.last().fail();
    h.client.stop();
    answer(false);
    await settle();
    expect(h.client.snapshot().status).toBe('stopped');
    expect(h.revoked).toBe(0);
  });

  it('ignores a negative answer to an old failure once the stream is open again', async () => {
    let answer: (authenticated: boolean) => void = () => undefined;
    const checkAccess = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const h = setup({ checkAccess });
    openStream(h);
    h.sources.last().fail();
    await vi.advanceTimersByTimeAsync(2000);
    h.sources.last().open();
    answer(false);
    await settle();
    expect(h.client.snapshot().status).toBe('open');
    expect(h.revoked).toBe(0);
    h.client.stop();
  });

  it('releases the lock when revoked', async () => {
    const locks = new FakeLockManager();
    const h = setup({ checkAccess: () => Promise.resolve(false) }, { locks });
    h.client.start();
    await settle();
    h.sources.last().open();
    h.sources.last().fail();
    await settle();
    expect(h.client.snapshot().status).toBe('revoked');
    expect(locks.held).toBe(false);
  });

  it('can be started again after a revoke (the person unlocked the page)', async () => {
    const h = setup({ checkAccess: () => Promise.resolve(false) });
    openStream(h);
    h.sources.last().fail();
    await settle();
    expect(h.client.snapshot().status).toBe('revoked');
    h.client.start();
    expect(h.sources.instances).toHaveLength(2);
    expect(h.client.snapshot().status).toBe('connecting');
    h.client.stop();
  });
});

describe('snapshot and subscribe', () => {
  it('keeps one snapshot object until something changes', () => {
    const h = setup();
    const idle = h.client.snapshot();
    expect(h.client.snapshot()).toBe(idle);
    h.client.start();
    expect(h.client.snapshot()).not.toBe(idle);
    h.client.stop();
  });

  it('notifies subscribers of each status change, and not after unsubscribe', () => {
    const h = setup();
    const statuses: string[] = [];
    const unsubscribe = h.client.subscribe(() => statuses.push(h.client.snapshot().status));
    h.client.start();
    h.sources.last().open();
    h.sources.last().fail();
    unsubscribe();
    h.client.stop();
    expect(statuses).toEqual(['connecting', 'open', 'backoff']);
  });

  it('counts messages', () => {
    const h = setup();
    openStream(h);
    h.sources.last().emit('sessions', sessionsEvent(1));
    h.sources.last().emit('heartbeat', { serverTime: iso(0) });
    expect(h.client.snapshot().counters.messages).toBe(3);
    h.client.stop();
  });
});
