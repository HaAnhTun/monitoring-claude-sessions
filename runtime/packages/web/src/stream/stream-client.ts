// The realtime client (04 5.6, ADR 0032): the browser `EventSource` behind an injectable factory, with a client-owned reconnect.
// On any `error` the client closes the source and reconnects itself with backoff and an explicit `since=<lastSeq>`, because the
// native auto-reconnect resends the original URL and gives up for good after a non-200 answer. This is the only file that
// touches `EventSource` (eslint rule `no-restricted-globals`); everything else gets the factory or a snapshot.
//
// Pure of React: a state machine over `start`/`stop`/`retryNow`, the frames of the source, the window `online`/`offline` events
// and its own timers. Frames are validated with the shared stream schemas, sequenced (duplicates ignored, a gap resyncs),
// queued and delivered in batches (animation frame or 100 ms, whichever comes first). Resync requests that arrive inside one
// flush window run R5 once, at the end of the window, and supersede the frames queued before them (the refetch covers them).
import {
  CHANGE_KINDS,
  safeParseStreamChange,
  StreamHeartbeatSchema,
  StreamHelloSchema,
  StreamResetSchema,
  type StreamChange,
  type StreamReset,
} from '@mcs/shared';

import { nextDelay } from '../lib/backoff.ts';
import type { StreamStatus } from '../lib/connection-health.ts';

export type { StreamStatus } from '../lib/connection-health.ts';

export type ResyncReason = 'reset' | 'gap' | 'invalid' | 'overflow' | 'head-ahead' | 'epoch';

export interface StreamCounters {
  messages: number;
  duplicates: number;
  invalid: number;
  unknownKinds: number;
  resyncs: number;
  reconnects: number;
}

export interface StreamSnapshot {
  status: StreamStatus;
  instanceId: string | null;
  epoch: string | null;
  lastSeq: number | null;
  serverHeadSeq: number | null;
  /** `cursor_too_old` | `cursor_ahead` | `epoch_changed` | `cursor_invalid` (03 9.2). */
  lastResetReason: StreamReset['reason'] | null;
  openedAt: number | null;
  lastMessageAt: number | null;
  lastHeartbeatAt: number | null;
  inSyncAt: number | null;
  attempt: number;
  nextRetryAt: number | null;
  lastError: string | null;
  counters: StreamCounters;
}

/** What `onEpochChanged` learns about the restarted server. A heartbeat carries no versions: both are `''` then. */
export interface EpochInfo {
  epoch: string;
  runtimeVersion: string;
  codeStamp: string;
}

export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void): void;
  close(): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/** The part of `window` the client listens to. */
export interface WindowLike {
  addEventListener(type: 'online' | 'offline', fn: () => void): void;
  removeEventListener(type: 'online' | 'offline', fn: () => void): void;
}

export interface StreamClientOptions {
  /** '/api/v3/stream' */
  url: string;
  /** From `GET /instance`: the instance, its epoch and the head sequence at the time of the read. */
  expectedInstanceId: string;
  expectedEpoch: string;
  startSeq: number;
  /** From the instance info (default 15000); the `hello` frame may change it. */
  heartbeatMs: number;
  /** Default: `(u) => new EventSource(u)`. */
  esFactory?: (url: string) => EventSourceLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Default: the global `requestAnimationFrame` when there is one. `null`: no frame, the 100 ms timer only. */
  requestFrame?: ((cb: () => void) => number) | null;
  cancelFrame?: ((handle: number) => void) | null;
  /** Default: the global `window` when there is one. `null`: no online/offline handling. */
  windowTarget?: WindowLike | null;
  /** 1000 */
  maxQueue?: number;
  /** Applied in one React batch. */
  onBatch(changes: StreamChange[]): void;
  /** Rule R5. */
  onResync(reason: ResyncReason): void;
  /** UI-I11: another instance now owns the address. */
  onInstanceChanged(newId: string): void;
  /** The server restarted: refetch the instance info; offer a reload when version or stamp differ. */
  onEpochChanged(info: EpochInfo): void;
}

export interface StreamClient {
  start(): void;
  stop(): void;
  retryNow(): void;
  snapshot(): StreamSnapshot;
  subscribe(fn: () => void): () => void;
}

/** One flush window: batches and resyncs are delivered at most this often. */
export const FLUSH_MS = 100;
export const DEFAULT_MAX_QUEUE = 1000;
const MIN_CONNECT_TIMEOUT_MS = 10_000;
const WATCHDOG_FACTOR = 2.5;
const BASE_RETRY_MS = 1000;

const KNOWN_KINDS: readonly string[] = CHANGE_KINDS;

interface Envelope {
  seq: number;
  kind: string;
}

/** The envelope of 03 9.2 that every frame must have, checked before the kind-specific schema (forward compatibility). */
function envelopeOf(value: unknown): Envelope | null {
  if (typeof value !== 'object' || value === null) return null;
  const seq: unknown = Reflect.get(value, 'seq');
  const at: unknown = Reflect.get(value, 'at');
  const instanceId: unknown = Reflect.get(value, 'instanceId');
  const kind: unknown = Reflect.get(value, 'kind');
  const op: unknown = Reflect.get(value, 'op');
  const sessionId: unknown = Reflect.get(value, 'sessionId');
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return null;
  if (typeof at !== 'string' || typeof instanceId !== 'string') return null;
  if (typeof kind !== 'string' || typeof op !== 'string') return null;
  if (sessionId !== null && typeof sessionId !== 'string') return null;
  return { seq, kind };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

export function createStreamClient(o: StreamClientOptions): StreamClient {
  const now = o.now ?? ((): number => Date.now());
  const setTimer = o.setTimer ?? ((fn, ms): TimerHandle => setTimeout(fn, ms));
  const clearTimer =
    o.clearTimer ??
    ((handle): void => {
      clearTimeout(handle);
    });
  const requestFrame =
    o.requestFrame === undefined
      ? typeof requestAnimationFrame === 'function'
        ? (cb: () => void): number => requestAnimationFrame(cb)
        : null
      : o.requestFrame;
  const cancelFrame =
    o.cancelFrame === undefined
      ? typeof cancelAnimationFrame === 'function'
        ? (handle: number): void => {
            cancelAnimationFrame(handle);
          }
        : null
      : o.cancelFrame;
  const maxQueue = o.maxQueue ?? DEFAULT_MAX_QUEUE;
  const factory = o.esFactory ?? ((url: string): EventSourceLike => new EventSource(url));
  const win: WindowLike | null =
    o.windowTarget === undefined ? (typeof window === 'undefined' ? null : window) : o.windowTarget;

  let status: StreamStatus = 'idle';
  let instanceId: string | null = null;
  let epoch: string | null = null;
  let lastSeq: number | null = null;
  let serverHeadSeq: number | null = null;
  let lastResetReason: StreamReset['reason'] | null = null;
  let openedAt: number | null = null;
  let lastMessageAt: number | null = null;
  let lastHeartbeatAt: number | null = null;
  let inSyncAt: number | null = null;
  let attempt = 0;
  let nextRetryAt: number | null = null;
  let lastError: string | null = null;
  let heartbeatMs = o.heartbeatMs;
  const counters: StreamCounters = {
    messages: 0,
    duplicates: 0,
    invalid: 0,
    unknownKinds: 0,
    resyncs: 0,
    reconnects: 0,
  };

  let es: EventSourceLike | null = null;
  let offline = false;
  let aheadStreak = 0;
  let queue: StreamChange[] = [];
  let pendingResync: ResyncReason | null = null;
  let connectTimer: TimerHandle | null = null;
  let watchdogTimer: TimerHandle | null = null;
  let retryTimer: TimerHandle | null = null;
  let flushTimer: TimerHandle | null = null;
  let flushFrame: number | null = null;
  let windowAttached = false;

  const listeners = new Set<() => void>();
  let cached: StreamSnapshot | null = null;

  function build(): StreamSnapshot {
    return {
      status,
      instanceId,
      epoch,
      lastSeq,
      serverHeadSeq,
      lastResetReason,
      openedAt,
      lastMessageAt,
      lastHeartbeatAt,
      inSyncAt,
      attempt,
      nextRetryAt,
      lastError,
      counters: { ...counters },
    };
  }

  /** The state moved without a notification (a change frame): the next `snapshot()` builds a new object. */
  function markDirty(): void {
    cached = null;
  }

  /** The state moved: new snapshot object, subscribers told. */
  function publish(): void {
    cached = null;
    for (const fn of [...listeners]) fn();
  }

  // ---- timers --------------------------------------------------------------------------------------------------------------

  function clearConnect(): void {
    if (connectTimer !== null) clearTimer(connectTimer);
    connectTimer = null;
  }
  function clearWatchdog(): void {
    if (watchdogTimer !== null) clearTimer(watchdogTimer);
    watchdogTimer = null;
  }
  function clearRetry(): void {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }
  function clearFlush(): void {
    if (flushTimer !== null) clearTimer(flushTimer);
    flushTimer = null;
    if (flushFrame !== null) cancelFrame?.(flushFrame);
    flushFrame = null;
  }

  function lastActivity(): number {
    return Math.max(openedAt ?? 0, lastMessageAt ?? 0, lastHeartbeatAt ?? 0);
  }

  function armWatchdog(): void {
    clearWatchdog();
    const limit = WATCHDOG_FACTOR * heartbeatMs;
    const remaining = limit - (now() - lastActivity());
    watchdogTimer = setTimer(onWatchdog, Math.max(1, Math.ceil(remaining) + 1));
  }

  function onWatchdog(): void {
    watchdogTimer = null;
    if (status !== 'open') return;
    if (now() - lastActivity() > WATCHDOG_FACTOR * heartbeatMs) fail('no heartbeat');
    else armWatchdog();
  }

  // ---- connection ----------------------------------------------------------------------------------------------------------

  function closeSource(): void {
    const source = es;
    es = null;
    if (source !== null) {
      source.onopen = null;
      source.onerror = null;
      source.close();
    }
  }

  function connect(): void {
    clearRetry();
    status = 'connecting';
    nextRetryAt = null;
    const url = `${o.url}${o.url.includes('?') ? '&' : '?'}since=${String(lastSeq ?? o.startSeq)}&epoch=${epoch ?? o.expectedEpoch}`;
    const source = factory(url);
    es = source;
    source.onopen = (): void => {
      if (es === source && status === 'connecting') markOpen();
    };
    source.onerror = (): void => {
      if (es === source) fail('stream error');
    };
    for (const type of ['hello', 'change', 'heartbeat', 'reset'] as const) {
      source.addEventListener(type, (e) => {
        if (es === source) handleMessage(type, e.data);
      });
    }
    clearConnect();
    connectTimer = setTimer(
      () => {
        connectTimer = null;
        if (status === 'connecting') fail('connect timeout');
      },
      Math.max(MIN_CONNECT_TIMEOUT_MS, 2 * heartbeatMs),
    );
    publish();
  }

  function markOpen(): void {
    status = 'open';
    openedAt = now();
    attempt = 0;
    clearConnect();
    armWatchdog();
    publish();
  }

  /** `error` event, watchdog or connect timeout: close, back off, retry with the explicit cursor. */
  function fail(reason: string): void {
    if (status !== 'connecting' && status !== 'open') return;
    closeSource();
    clearConnect();
    clearWatchdog();
    attempt += 1;
    const delay = nextDelay(BASE_RETRY_MS, attempt);
    nextRetryAt = now() + delay;
    lastError = reason;
    status = 'backoff';
    clearRetry();
    retryTimer = setTimer(() => {
      retryTimer = null;
      reconnect();
    }, delay);
    publish();
  }

  function reconnect(): void {
    counters.reconnects += 1;
    connect();
  }

  function goOffline(): void {
    if (status === 'idle' || status === 'stopped') return;
    offline = true;
    closeSource();
    clearConnect();
    clearWatchdog();
    clearRetry();
    status = 'backoff';
    nextRetryAt = null;
    lastError = 'offline';
    publish();
  }

  function goOnline(): void {
    if (!offline) return;
    offline = false;
    if (status === 'backoff') reconnect();
  }

  function attachWindow(): void {
    if (win === null || windowAttached) return;
    win.addEventListener('online', goOnline);
    win.addEventListener('offline', goOffline);
    windowAttached = true;
  }

  function detachWindow(): void {
    if (win === null || !windowAttached) return;
    win.removeEventListener('online', goOnline);
    win.removeEventListener('offline', goOffline);
    windowAttached = false;
  }

  /** Stops every source of work; the caller decides the final status. */
  function teardown(): void {
    closeSource();
    clearConnect();
    clearWatchdog();
    clearRetry();
    clearFlush();
    detachWindow();
    queue = [];
    pendingResync = null;
    offline = false;
    nextRetryAt = null;
  }

  // ---- batching and resync -------------------------------------------------------------------------------------------------

  function scheduleFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimer(flush, FLUSH_MS);
    if (requestFrame !== null) flushFrame = requestFrame(flush);
  }

  function flush(): void {
    clearFlush();
    const reason = pendingResync;
    pendingResync = null;
    const batch = queue;
    queue = [];
    try {
      if (reason !== null) {
        counters.resyncs += 1;
        o.onResync(reason);
      } else if (batch.length > 0) {
        o.onBatch(batch);
        inSyncAt = now();
      }
    } catch (error) {
      // The cache may be half patched: repair it with a refetch instead of leaving it as it is.
      lastError = error instanceof Error ? error.message : 'handler failed';
      if (reason === null) requestResync('invalid');
    }
    publish();
  }

  /** Coalesced: the first reason of the window wins, and everything queued so far is covered by the refetch. */
  function requestResync(reason: ResyncReason): void {
    pendingResync ??= reason;
    queue = [];
    scheduleFlush();
  }

  function invalid(): void {
    counters.invalid += 1;
    requestResync('invalid');
  }

  // ---- messages ------------------------------------------------------------------------------------------------------------

  function epochChanged(next: string, headSeq: number, info: EpochInfo): void {
    epoch = next;
    lastSeq = headSeq;
    aheadStreak = 0;
    requestResync('epoch');
    o.onEpochChanged(info);
  }

  function onHello(value: unknown): void {
    const parsed = StreamHelloSchema.safeParse(value);
    if (!parsed.success) {
      invalid();
      return;
    }
    const msg = parsed.data;
    if (msg.instanceId !== o.expectedInstanceId) {
      teardown();
      status = 'stopped';
      publish();
      o.onInstanceChanged(msg.instanceId);
      return;
    }
    instanceId = msg.instanceId;
    serverHeadSeq = msg.headSeq;
    if (msg.heartbeatMs > 0 && msg.heartbeatMs !== heartbeatMs) {
      heartbeatMs = msg.heartbeatMs;
      armWatchdog();
    }
    if (msg.epoch !== (epoch ?? o.expectedEpoch)) {
      epochChanged(msg.epoch, msg.headSeq, {
        epoch: msg.epoch,
        runtimeVersion: msg.runtimeVersion,
        codeStamp: msg.codeStamp,
      });
    } else {
      epoch = msg.epoch;
    }
  }

  function onChange(value: unknown): void {
    const envelope = envelopeOf(value);
    if (envelope === null) {
      invalid();
      return;
    }
    const known = KNOWN_KINDS.includes(envelope.kind);
    let change: StreamChange | null = null;
    if (known) {
      const parsed = safeParseStreamChange(value);
      if (!parsed.success) {
        invalid();
        return;
      }
      change = parsed.data;
    }
    const seq = envelope.seq;
    if (lastSeq !== null && seq <= lastSeq) {
      counters.duplicates += 1;
      return;
    }
    if (lastSeq !== null && seq > lastSeq + 1) {
      lastSeq = seq;
      requestResync('gap');
      return;
    }
    lastSeq = seq;
    if (change === null) {
      counters.unknownKinds += 1;
      return;
    }
    queue.push(change);
    if (queue.length > maxQueue) requestResync('overflow');
    else scheduleFlush();
  }

  function onHeartbeat(value: unknown): void {
    const parsed = StreamHeartbeatSchema.safeParse(value);
    if (!parsed.success) {
      invalid();
      return;
    }
    const msg = parsed.data;
    lastHeartbeatAt = now();
    if (msg.epoch !== (epoch ?? o.expectedEpoch)) {
      epochChanged(msg.epoch, msg.headSeq, { epoch: msg.epoch, runtimeVersion: '', codeStamp: '' });
      return;
    }
    serverHeadSeq = msg.headSeq;
    const known = lastSeq ?? o.startSeq;
    if (msg.headSeq === known) {
      inSyncAt = now();
      aheadStreak = 0;
    } else if (msg.headSeq > known) {
      aheadStreak += 1;
      if (aheadStreak >= 2) {
        aheadStreak = 0;
        lastSeq = msg.headSeq;
        requestResync('head-ahead');
      }
    } else {
      aheadStreak = 0;
    }
  }

  function onReset(value: unknown): void {
    const parsed = StreamResetSchema.safeParse(value);
    if (!parsed.success) {
      invalid();
      return;
    }
    lastSeq = parsed.data.headSeq;
    serverHeadSeq = parsed.data.headSeq;
    lastResetReason = parsed.data.reason;
    aheadStreak = 0;
    requestResync('reset');
  }

  function handleMessage(type: 'hello' | 'change' | 'heartbeat' | 'reset', text: string): void {
    if (status !== 'connecting' && status !== 'open') return;
    markDirty();
    counters.messages += 1;
    lastMessageAt = now();
    // A message proves the connection is open even if the browser's `open` event has not been seen.
    if (status === 'connecting') markOpen();
    const json = parseJson(text);
    if (!json.ok) {
      invalid();
    } else {
      switch (type) {
        case 'hello':
          onHello(json.value);
          break;
        case 'change':
          onChange(json.value);
          break;
        case 'heartbeat':
          onHeartbeat(json.value);
          break;
        case 'reset':
          onReset(json.value);
          break;
      }
    }
    // A burst of change frames is published once, by the flush, not once per frame.
    if (type !== 'change') publish();
  }

  // ---- public API ----------------------------------------------------------------------------------------------------------

  return {
    start() {
      if (status === 'connecting' || status === 'open') return;
      if (status === 'backoff') {
        attachWindow();
        reconnect();
        return;
      }
      attachWindow();
      attempt = 0;
      connect();
    },
    stop() {
      if (status === 'stopped') return;
      teardown();
      status = 'stopped';
      publish();
    },
    retryNow() {
      if (status !== 'backoff') return;
      reconnect();
    },
    snapshot() {
      cached ??= build();
      return cached;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
