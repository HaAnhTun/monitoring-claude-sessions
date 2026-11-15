// The socket of one terminal session (ADR 0098, design 04 7.4): the browser `WebSocket` behind an injectable factory, with a
// client-owned reconnect. This is the only file that touches `WebSocket` (eslint rule `no-restricted-globals`); everything else
// gets the factory, a snapshot or the frames.
//
// Pure of React: a state machine over `start`/`stop`/`retryNow`, the frames of the socket, the `online` and `visibilitychange`
// events and its own timers. It speaks protocol v1 of ADR 0087: binary frames are terminal bytes in both directions (an input
// frame is at most 16 KiB), text frames of the server are protocol messages (`ready`, `live`, `size`, `exit`), validated with the
// shared schema; an invalid text frame is counted and dropped, never written to the terminal. After a close the client decides by
// `closePolicy`: the session ended, the credential ended, our own bug, or reconnect with the delays 0, 1, 2, 4, 8, 15 s (15 s from
// then on). It does not decide whether the session still exists after a refused handshake (the browser cannot tell why it failed):
// it counts the refusals and the owner asks the session list. What the person types and what the process prints are never logged.
import { TERMINAL_SUBPROTOCOL, type TerminalServerMessage } from '@mcs/shared';

import { nextDelay } from '../lib/backoff.ts';
import type { WindowLike } from '../stream/stream-client.ts';
import {
  chunkBytes,
  closePolicy,
  encodeInput,
  encodeResize,
  parseServerFrame,
  RECONNECT_CAP_MS,
  type VisibilityLike,
} from './protocol.ts';

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'backoff' | 'ended' | 'locked' | 'stopped';

/** The part of `WebSocket` the client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: BinaryType;
  onopen: ((e: Event) => void) | null;
  onmessage: ((e: MessageEvent) => void) | null;
  onclose: ((e: CloseEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface TerminalSocketOptions {
  /** `terminalSocketUrl(name, location)`. */
  url: string;
  /** Default: `[TERMINAL_SUBPROTOCOL]`. */
  protocols?: readonly string[];
  /** Default: `(url, protocols) => new WebSocket(url, [...protocols])`. */
  factory?: (url: string, protocols: readonly string[]) => WebSocketLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Default: the global `document` when there is one. `null`: no visibility handling. */
  visibility?: VisibilityLike | null;
  /** Default: the global `window` when there is one. `null`: no `online` handling. */
  windowTarget?: WindowLike | null;
  /** A binary frame of the server: bytes for the terminal, in the order they arrived. */
  onData(bytes: Uint8Array): void;
  /** A valid text frame of the server, in the order it arrived relative to the binary frames. */
  onControl(frame: TerminalServerMessage): void;
  /** Called after every change of the snapshot; `subscribe` serves the same purpose for a store. */
  onStatus?(snapshot: SocketSnapshot): void;
}

export interface SocketSnapshot {
  status: SocketStatus;
  /** Failed connections in a row since the last one that stayed open; it picks the next delay. */
  attempt: number;
  /** When the next connection attempt starts (epoch ms), while the status is `backoff`. */
  nextRetryAt: number | null;
  /** Some connection of this start reached `open`. */
  everOpened: boolean;
  /** Closes in a row that came before any open: handshakes that were refused. The owner asks the session list at two. */
  refusals: number;
  lastCloseCode: number | null;
  lastCloseAt: number | null;
  /** The `exit` frame of the session, once it arrived. */
  exit: { code: number | null; signal: string | null } | null;
  /** The view ended because of a bug of ours (the close code says bad message, too big, protocol error): Retry, not a loop. */
  failed: boolean;
  /** Text frames that were not valid protocol frames. Never their content. */
  invalidFrames: number;
  reconnects: number;
}

export interface TerminalSocket {
  /** Opens the connection. Nothing happens while one is connecting, open or waiting to reconnect. */
  start(): void;
  /** Closes with 1000 and clears every timer. Idempotent; `start()` may follow. */
  stop(): void;
  /** Skips the wait of a backoff, or retries after a failed ending; nothing otherwise. */
  retryNow(): void;
  /** Typed text as binary frames of at most 16 KiB. `false` (and nothing sent) unless the socket is open. */
  sendInput(data: string): boolean;
  /** Raw input bytes (mouse reports) in frames of at most 16 KiB. `false` unless the socket is open. */
  sendBinary(bytes: Uint8Array<ArrayBuffer>): boolean;
  /** The resize text frame, clamped. `false` unless the socket is open. */
  sendResize(cols: number, rows: number): boolean;
  snapshot(): SocketSnapshot;
  subscribe(fn: () => void): () => void;
}

const BASE_RETRY_MS = 1000;
/** `WebSocket.OPEN`, as a number so the fake socket of the tests needs no global. */
const READY_STATE_OPEN = 1;
/** A connection that stayed open this long counts as a working one: the next drop starts the delays over. */
const STABLE_OPEN_MS = 2000;

export function createTerminalSocket(o: TerminalSocketOptions): TerminalSocket {
  const protocols = o.protocols ?? [TERMINAL_SUBPROTOCOL];
  const factory = o.factory ?? ((url, subprotocols): WebSocketLike => new WebSocket(url, [...subprotocols]));
  const now = o.now ?? ((): number => Date.now());
  const setTimer = o.setTimer ?? ((fn, ms): TimerHandle => setTimeout(fn, ms));
  const clearTimer =
    o.clearTimer ??
    ((handle): void => {
      clearTimeout(handle);
    });
  const visibility: VisibilityLike | null =
    o.visibility === undefined ? (typeof document === 'undefined' ? null : document) : o.visibility;
  const win: WindowLike | null =
    o.windowTarget === undefined ? (typeof window === 'undefined' ? null : window) : o.windowTarget;

  let status: SocketStatus = 'idle';
  let socket: WebSocketLike | null = null;
  let openedThisConnection = false;
  let openedAt: number | null = null;
  let attempt = 0;
  let nextRetryAt: number | null = null;
  let everOpened = false;
  let refusals = 0;
  let lastCloseCode: number | null = null;
  let lastCloseAt: number | null = null;
  let exit: SocketSnapshot['exit'] = null;
  let failed = false;
  let invalidFrames = 0;
  let reconnects = 0;
  let retryTimer: TimerHandle | null = null;
  let environmentAttached = false;

  const listeners = new Set<() => void>();
  let cached: SocketSnapshot | null = null;

  function build(): SocketSnapshot {
    return {
      status,
      attempt,
      nextRetryAt,
      everOpened,
      refusals,
      lastCloseCode,
      lastCloseAt,
      exit,
      failed,
      invalidFrames,
      reconnects,
    };
  }

  function snapshot(): SocketSnapshot {
    cached ??= build();
    return cached;
  }

  /** A counter moved without a notification: the next `snapshot()` builds a new object. */
  function markDirty(): void {
    cached = null;
  }

  /** The state moved: new snapshot object, owner and subscribers told. */
  function publish(): void {
    cached = null;
    o.onStatus?.(snapshot());
    for (const fn of [...listeners]) fn();
  }

  function clearRetry(): void {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  // ---- connection ----------------------------------------------------------------------------------------------------------

  /** Detaches every handler of the current socket (an event of a socket we no longer own must do nothing). */
  function release(): WebSocketLike | null {
    const current = socket;
    socket = null;
    if (current !== null) {
      current.onopen = null;
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
    }
    return current;
  }

  function connect(): void {
    clearRetry();
    nextRetryAt = null;
    openedThisConnection = false;
    openedAt = null;
    status = 'connecting';
    let created: WebSocketLike;
    try {
      created = factory(o.url, protocols);
    } catch {
      // the constructor refuses an address it cannot use: a bug of ours, so no retry loop
      status = 'ended';
      failed = true;
      publish();
      return;
    }
    created.binaryType = 'arraybuffer';
    socket = created;
    created.onopen = (): void => {
      if (socket === created && status === 'connecting') markOpen();
    };
    created.onmessage = (e): void => {
      if (socket === created) handleMessage(e.data);
    };
    created.onclose = (e): void => {
      if (socket === created) handleClose(e.code);
    };
    publish();
  }

  function markOpen(): void {
    status = 'open';
    openedThisConnection = true;
    everOpened = true;
    openedAt = now();
    refusals = 0;
    publish();
  }

  function reconnect(): void {
    reconnects += 1;
    connect();
  }

  function handleMessage(data: unknown): void {
    if (status === 'connecting') markOpen();
    if (status !== 'open') return;
    if (typeof data === 'string') {
      const frame = parseServerFrame(data);
      if (frame === null) {
        invalidFrames += 1;
        markDirty();
        return;
      }
      if (frame.type === 'exit') {
        exit = { code: frame.code, signal: frame.signal };
        o.onControl(frame);
        publish();
        return;
      }
      o.onControl(frame);
      return;
    }
    if (data instanceof ArrayBuffer) o.onData(new Uint8Array(data));
  }

  function handleClose(code: number): void {
    release();
    lastCloseCode = code;
    lastCloseAt = now();
    if (!openedThisConnection) refusals += 1;
    if (openedAt !== null && now() - openedAt >= STABLE_OPEN_MS) attempt = 0;
    const policy = closePolicy(code);
    if (policy === 'locked') {
      status = 'locked';
    } else if (exit !== null || policy === 'end') {
      status = 'ended';
    } else if (policy === 'fail') {
      status = 'ended';
      failed = true;
    } else {
      const delay = attempt === 0 ? 0 : nextDelay(BASE_RETRY_MS, attempt - 1, RECONNECT_CAP_MS);
      attempt += 1;
      nextRetryAt = now() + delay;
      status = 'backoff';
      clearRetry();
      retryTimer = setTimer(() => {
        retryTimer = null;
        reconnect();
      }, delay);
    }
    publish();
  }

  /** The tab came back or the network did: a client that waits to reconnect does not wait any longer. */
  function wake(): void {
    if (status === 'backoff') reconnect();
  }

  function onVisibilityChange(): void {
    if (visibility !== null && visibility.visibilityState === 'visible') wake();
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

  // ---- sending -------------------------------------------------------------------------------------------------------------

  /** The socket when frames may be sent: open for us and for the browser. */
  function openSocket(): WebSocketLike | null {
    return status === 'open' && socket !== null && socket.readyState === READY_STATE_OPEN ? socket : null;
  }

  function sendAll(frames: readonly (string | Uint8Array<ArrayBuffer>)[]): boolean {
    const target = openSocket();
    if (target === null) return false;
    try {
      for (const frame of frames) target.send(frame);
    } catch {
      return false;
    }
    return true;
  }

  return {
    start() {
      if (status === 'connecting' || status === 'open' || status === 'backoff') return;
      attachEnvironment();
      attempt = 0;
      refusals = 0;
      everOpened = false;
      exit = null;
      failed = false;
      connect();
    },
    stop() {
      if (status === 'stopped') return;
      clearRetry();
      detachEnvironment();
      const current = release();
      if (current !== null) {
        try {
          current.close(1000);
        } catch {
          // a socket that cannot be closed is already gone
        }
      }
      nextRetryAt = null;
      status = 'stopped';
      publish();
    },
    retryNow() {
      if (status === 'backoff') {
        reconnect();
      } else if (status === 'ended' && failed) {
        attempt = 0;
        refusals = 0;
        failed = false;
        reconnect();
      }
    },
    sendInput(data) {
      return sendAll(encodeInput(data));
    },
    sendBinary(bytes) {
      return sendAll(chunkBytes(bytes));
    },
    sendResize(cols, rows) {
      return sendAll([encodeResize(cols, rows)]);
    },
    snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
