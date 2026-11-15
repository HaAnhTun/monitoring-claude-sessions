// The list of live terminals as a stream (ADR 0098, ADR 0087 decision 10, design 04 4.2 and amendment A2): the browser
// `EventSource` of `GET /api/v3/terminal/events` behind an injectable factory, with a client-owned reconnect like the monitor
// stream (`stream/stream-client.ts`), the second and last file that opens an `EventSource` (eslint rule `no-restricted-globals`).
//
// What it does that the monitor client does not:
// - Snapshots, not deltas: every `sessions` frame is the whole list with a `version`; the newest version wins within one epoch,
//   an older or equal one is dropped, and a new epoch (the server restarted) starts the versions over.
// - ONE stream per browser. A browser holds six HTTP/1.1 connections per origin across all its tabs and every tab already keeps
//   one for the monitor stream, so only the tab that holds the Web Lock `caw-terminal-events` opens the source; the other visible
//   tabs wait (status `waiting`) and poll the terminal state meanwhile. When the holder closes the browser hands the lock on. The
//   lock manager is a seam: without one (a browser without Web Locks, the tests) a client opens its source directly.
// - A tab that stays hidden for 15 s closes its source, releases the lock and aborts a pending request (status `paused`) and
//   opens again when it becomes visible, so a background tab never holds one of the streams.
// - The browser cannot tell why a stream failed. After a failure the client asks an injected access check; a negative answer
//   means the credential is gone (a logout, a restart), the client stops with the status `revoked` and tells its owner once.
// Pure of React. Frames are validated with the shared `TerminalEventSchemas`; an invalid frame is counted and ignored (the next
// snapshot repairs the list), never repeated in an error.
import {
  TERMINAL_EVENT_NAMES,
  TerminalEventSchemas,
  type TerminalHelloEvent,
  type TerminalSessionsEvent,
} from '@mcs/shared';

import { nextDelay } from '../lib/backoff.ts';
import type { EventSourceLike, WindowLike } from '../stream/stream-client.ts';
import { RECONNECT_CAP_MS, type VisibilityLike } from './protocol.ts';

export type EventsStatus = 'idle' | 'waiting' | 'connecting' | 'open' | 'backoff' | 'paused' | 'revoked' | 'stopped';

export interface EventsCounters {
  messages: number;
  /** Lists dropped because their version was not newer. */
  stale: number;
  invalid: number;
  reconnects: number;
}

export interface EventsSnapshot {
  status: EventsStatus;
  instanceId: string | null;
  epoch: string | null;
  /** The newest list version applied in this epoch. */
  version: number | null;
  /** This client holds the Web Lock (it is the one stream of the browser). */
  holdsLock: boolean;
  openedAt: number | null;
  lastMessageAt: number | null;
  attempt: number;
  nextRetryAt: number | null;
  lastError: string | null;
  counters: EventsCounters;
}

/** The part of `navigator.locks` the client uses: an exclusive request that is held until the callback's promise settles. */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface EventsClientOptions {
  /** `routes.terminalEvents.path`. */
  url: string;
  /** From `GET /instance`: a hello of another instance stops the client (`onInstanceChanged`). */
  expectedInstanceId?: string | null;
  /** The interval before the first hello says otherwise. Default 15000. */
  heartbeatMs?: number;
  /** How long a hidden tab keeps its stream. Default 15000. */
  hiddenCloseMs?: number;
  /** Default `caw-terminal-events`. */
  lockName?: string;
  /** Default: `navigator.locks` when the browser has it. `null`: none, open directly. */
  locks?: LockManagerLike | null;
  /** Default: the global `document` when there is one. `null`: the tab counts as always visible. */
  visibility?: VisibilityLike | null;
  /** Default: the global `window` when there is one. `null`: no `online` handling. */
  windowTarget?: WindowLike | null;
  /** Default: `(url) => new EventSource(url)`. */
  esFactory?: (url: string) => EventSourceLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** After a failure: is the session of this browser still valid? `false` revokes. A rejection means "unknown": keep trying. */
  checkAccess?: () => Promise<boolean>;
  /** The newest list of the epoch (never an older one). */
  onSessions(event: TerminalSessionsEvent): void;
  onHello?(event: TerminalHelloEvent): void;
  /** The server restarted: `epoch` is the new one. Not called for the first hello. */
  onEpochChanged?(epoch: string, previous: string): void;
  onInstanceChanged?(instanceId: string): void;
  /** The access check said the credential is gone. Once per revoke. */
  onRevoked?(): void;
}

export interface EventsClient {
  /** Opens the stream when the tab is visible (asking for the lock first). Nothing happens while it is already active or paused. */
  start(): void;
  /** Closes the source, releases the lock, clears every timer. Idempotent; `start()` may follow. */
  stop(): void;
  /** Skips the wait of a backoff; nothing otherwise. */
  retryNow(): void;
  snapshot(): EventsSnapshot;
  subscribe(fn: () => void): () => void;
}

/** The Web Lock that makes one tab of the browser the owner of the stream. */
export const TERMINAL_EVENTS_LOCK = 'caw-terminal-events';
/** A tab hidden this long closes its stream (design 04 A2). */
export const HIDDEN_CLOSE_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const WATCHDOG_FACTOR = 2.5;
const MIN_CONNECT_TIMEOUT_MS = 10_000;
const BASE_RETRY_MS = 1000;

function isLockManager(value: unknown): value is LockManagerLike {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'request') === 'function';
}

function browserLocks(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const manager: unknown = Reflect.get(navigator, 'locks');
  return isLockManager(manager) ? manager : null;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

export function createEventsClient(o: EventsClientOptions): EventsClient {
  const now = o.now ?? ((): number => Date.now());
  const setTimer = o.setTimer ?? ((fn, ms): TimerHandle => setTimeout(fn, ms));
  const clearTimer =
    o.clearTimer ??
    ((handle): void => {
      clearTimeout(handle);
    });
  const factory = o.esFactory ?? ((url: string): EventSourceLike => new EventSource(url));
  const locks: LockManagerLike | null = o.locks === undefined ? browserLocks() : o.locks;
  const lockName = o.lockName ?? TERMINAL_EVENTS_LOCK;
  const hiddenCloseMs = o.hiddenCloseMs ?? HIDDEN_CLOSE_MS;
  const visibility: VisibilityLike | null =
    o.visibility === undefined ? (typeof document === 'undefined' ? null : document) : o.visibility;
  const win: WindowLike | null =
    o.windowTarget === undefined ? (typeof window === 'undefined' ? null : window) : o.windowTarget;

  let status: EventsStatus = 'idle';
  let instanceId: string | null = null;
  let epoch: string | null = null;
  let version: number | null = null;
  let openedAt: number | null = null;
  let lastMessageAt: number | null = null;
  let attempt = 0;
  let nextRetryAt: number | null = null;
  let lastError: string | null = null;
  let heartbeatMs = o.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const counters: EventsCounters = { messages: 0, stale: 0, invalid: 0, reconnects: 0 };

  let es: EventSourceLike | null = null;
  /** Bumped by every teardown: a callback of an abandoned lock request or access check does nothing. */
  let token = 0;
  /** Bumped by every failure: only the answer to the latest check counts. */
  let failureCount = 0;
  let holdsLock = false;
  let releaseLock: (() => void) | null = null;
  let lockAbort: AbortController | null = null;
  let connectTimer: TimerHandle | null = null;
  let watchdogTimer: TimerHandle | null = null;
  let retryTimer: TimerHandle | null = null;
  let hiddenTimer: TimerHandle | null = null;
  let environmentAttached = false;

  const listeners = new Set<() => void>();
  let cached: EventsSnapshot | null = null;

  function build(): EventsSnapshot {
    return {
      status,
      instanceId,
      epoch,
      version,
      holdsLock,
      openedAt,
      lastMessageAt,
      attempt,
      nextRetryAt,
      lastError,
      counters: { ...counters },
    };
  }

  /** A counter moved without a notification: the next `snapshot()` builds a new object. */
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
  function clearHidden(): void {
    if (hiddenTimer !== null) clearTimer(hiddenTimer);
    hiddenTimer = null;
  }

  function lastActivity(): number {
    return Math.max(openedAt ?? 0, lastMessageAt ?? 0);
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

  // ---- the lock ------------------------------------------------------------------------------------------------------------

  function releaseHeldLock(): void {
    const release = releaseLock;
    releaseLock = null;
    holdsLock = false;
    release?.();
  }

  function abortPendingLock(): void {
    const controller = lockAbort;
    lockAbort = null;
    controller?.abort();
  }

  /** Asks for the lock; the source opens only once the browser grants it. The lock is held until `releaseHeldLock()`. */
  function requestLock(manager: LockManagerLike): void {
    const mine = token;
    const controller = new AbortController();
    lockAbort = controller;
    status = 'waiting';
    publish();
    const granted = (): Promise<void> => {
      // the request of a client that stopped or paused meanwhile: give the lock back at once
      if (mine !== token) return Promise.resolve();
      lockAbort = null;
      holdsLock = true;
      return new Promise<void>((resolve) => {
        releaseLock = resolve;
        openSource();
      });
    };
    const fallback = (): void => {
      if (mine !== token || controller.signal.aborted) return;
      lockAbort = null;
      openSource();
    };
    try {
      manager.request(lockName, { mode: 'exclusive', signal: controller.signal }, granted).then(undefined, fallback);
    } catch {
      fallback();
    }
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

  function openSource(): void {
    clearRetry();
    status = 'connecting';
    nextRetryAt = null;
    const source = factory(o.url);
    es = source;
    source.onopen = (): void => {
      if (es === source && status === 'connecting') markOpen();
    };
    source.onerror = (): void => {
      if (es === source) fail('stream error');
    };
    for (const type of TERMINAL_EVENT_NAMES) {
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

  /** `error` event, watchdog or connect timeout: close, back off, retry; and ask whether the session is still valid. */
  function fail(reason: string): void {
    if (status !== 'connecting' && status !== 'open') return;
    closeSource();
    clearConnect();
    clearWatchdog();
    attempt += 1;
    failureCount += 1;
    const delay = nextDelay(BASE_RETRY_MS, attempt, RECONNECT_CAP_MS);
    nextRetryAt = now() + delay;
    lastError = reason;
    status = 'backoff';
    clearRetry();
    retryTimer = setTimer(() => {
      retryTimer = null;
      reconnect();
    }, delay);
    publish();
    verifyAccess();
  }

  function reconnect(): void {
    counters.reconnects += 1;
    openSource();
  }

  /** The browser tells nothing about a failed stream: ask the open session route whether the credential is still there. */
  function verifyAccess(): void {
    const check = o.checkAccess;
    if (check === undefined) return;
    const failure = failureCount;
    const mine = token;
    void check().then(
      (authenticated) => {
        if (authenticated || mine !== token || failure !== failureCount) return;
        if (status !== 'backoff' && status !== 'connecting') return;
        revoke();
      },
      () => undefined,
    );
  }

  /** Stops every source of work of the connection; the caller decides the final status. */
  function teardownConnection(): void {
    token += 1;
    closeSource();
    clearConnect();
    clearWatchdog();
    clearRetry();
    releaseHeldLock();
    abortPendingLock();
    nextRetryAt = null;
  }

  function revoke(): void {
    teardownConnection();
    clearHidden();
    status = 'revoked';
    publish();
    o.onRevoked?.();
  }

  // ---- messages ------------------------------------------------------------------------------------------------------------

  function invalid(): void {
    counters.invalid += 1;
  }

  function onHello(value: unknown): void {
    const parsed = TerminalEventSchemas.hello.safeParse(value);
    if (!parsed.success) {
      invalid();
      return;
    }
    const hello = parsed.data;
    const expected = o.expectedInstanceId ?? null;
    if (expected !== null && hello.instanceId !== expected) {
      teardownConnection();
      clearHidden();
      detachEnvironment();
      status = 'stopped';
      publish();
      o.onInstanceChanged?.(hello.instanceId);
      return;
    }
    instanceId = hello.instanceId;
    if (hello.heartbeatMs > 0 && hello.heartbeatMs !== heartbeatMs) {
      heartbeatMs = hello.heartbeatMs;
      armWatchdog();
    }
    const previous = epoch;
    epoch = hello.epoch;
    if (previous !== null && previous !== hello.epoch) {
      // the server restarted: its versions start over, so the old ones must not hold the new list back
      version = null;
      o.onEpochChanged?.(hello.epoch, previous);
    }
    o.onHello?.(hello);
    publish();
  }

  function onSessions(value: unknown): void {
    const parsed = TerminalEventSchemas.sessions.safeParse(value);
    if (!parsed.success) {
      invalid();
      return;
    }
    const event = parsed.data;
    if (version !== null && event.version <= version) {
      counters.stale += 1;
      return;
    }
    version = event.version;
    o.onSessions(event);
  }

  function onHeartbeat(value: unknown): void {
    if (!TerminalEventSchemas.heartbeat.safeParse(value).success) invalid();
  }

  function handleMessage(type: (typeof TERMINAL_EVENT_NAMES)[number], text: string): void {
    if (status !== 'connecting' && status !== 'open') return;
    markDirty();
    counters.messages += 1;
    lastMessageAt = now();
    // A message proves the connection is open even if the browser's `open` event has not been seen.
    if (status === 'connecting') markOpen();
    const json = parseJson(text);
    if (!json.ok) {
      invalid();
      return;
    }
    switch (type) {
      case 'hello':
        onHello(json.value);
        break;
      case 'sessions':
        onSessions(json.value);
        break;
      case 'heartbeat':
        onHeartbeat(json.value);
        break;
    }
  }

  // ---- visibility, network and the public API ------------------------------------------------------------------------------

  function isVisible(): boolean {
    return visibility?.visibilityState !== 'hidden';
  }

  /** Visible: ask for the lock (or open directly). Hidden: wait for the visibility change. */
  function begin(): void {
    if (!isVisible()) {
      status = 'paused';
      publish();
      return;
    }
    if (locks === null) openSource();
    else requestLock(locks);
  }

  /** The tab was hidden for `hiddenCloseMs`: it must not hold a stream or a place in the queue. */
  function pause(): void {
    hiddenTimer = null;
    if (status === 'idle' || status === 'stopped' || status === 'revoked' || status === 'paused') return;
    teardownConnection();
    status = 'paused';
    publish();
  }

  function onVisibilityChange(): void {
    if (status === 'idle' || status === 'stopped' || status === 'revoked') return;
    if (isVisible()) {
      clearHidden();
      if (status === 'paused') {
        attempt = 0;
        begin();
      }
    } else if (status !== 'paused' && hiddenTimer === null) {
      hiddenTimer = setTimer(pause, hiddenCloseMs);
    }
  }

  /** The network came back: a client that waits to reconnect does not wait any longer. */
  function wake(): void {
    if (status !== 'backoff') return;
    clearRetry();
    reconnect();
  }

  function attachEnvironment(): void {
    if (environmentAttached) return;
    visibility?.addEventListener('visibilitychange', onVisibilityChange);
    win?.addEventListener('online', wake);
    environmentAttached = true;
  }

  function detachEnvironment(): void {
    if (!environmentAttached) return;
    visibility?.removeEventListener('visibilitychange', onVisibilityChange);
    win?.removeEventListener('online', wake);
    environmentAttached = false;
  }

  return {
    start() {
      if (
        status === 'waiting' ||
        status === 'connecting' ||
        status === 'open' ||
        status === 'backoff' ||
        status === 'paused'
      ) {
        return;
      }
      attachEnvironment();
      attempt = 0;
      lastError = null;
      begin();
    },
    stop() {
      if (status === 'stopped') return;
      teardownConnection();
      clearHidden();
      detachEnvironment();
      status = 'stopped';
      publish();
    },
    retryNow: wake,
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
