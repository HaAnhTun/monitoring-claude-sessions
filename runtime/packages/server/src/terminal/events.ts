// The session event feed of the terminal (CAW-20, design 02 6, amendment A5): `GET /api/v3/terminal/events`. A client gets
// `retry: 3000`, `hello`, the full list of live sessions as a `sessions` frame, then a new full list after every change and a
// `heartbeat` every 15 s. Snapshots, not deltas: the list is tiny and terminal membership is process memory that dies with the
// instance, so there is no sequence to replay and no gap to handle.
//   - Changes of the list are coalesced: the first change opens a 50 ms window and one snapshot (the next `version`) goes out when
//     it closes, however many changes came in.
//   - Latest wins: a client has at most one pending frame. A write that the sink refuses stops the client until `drain`; frames
//     that come meanwhile replace the pending one, so nothing queues. A client undrained for 30 s is destroyed and reconnects.
//   - The feed subscribes to the session list and to the revocations only while at least one client is connected, so an instance
//     that nobody watches holds no listener and no timer. A revoked credential closes its streams.
//   - At most 8 streams: the 9th is `503 stream_limit`, answered before any byte of the stream is written.
// The module knows neither HTTP nor the cookie: it writes to a `TerminalEventSink` (the response, in the route) and is told who
// is connected by the credential id the access guard admitted. It never logs a session name, a folder or a credential: only a
// count or a reason.
import type { ServerResponse } from 'node:http';

import type { AccessService, Logger } from '@mcs/engine';
import {
  STREAM_HEARTBEAT_MS,
  STREAM_RETRY_MS,
  isoMsZ,
  routes,
  type TerminalHeartbeatEvent,
  type TerminalHelloEvent,
  type TerminalSessionInfo,
  type TerminalSessionsEvent,
} from '@mcs/shared';
import type { Response } from 'express';

import { ApiError } from '../errors.ts';
import { accessOf } from '../http/access-guard.ts';
import { registerRoute, type RouteModule } from '../route-adapter.ts';
import type { TerminalPorts, TerminalSessionsPort } from './ports.ts';

/** The limits of design 02 6. */
export const TERMINAL_EVENT_LIMITS = {
  /** Concurrent streams per instance; the 9th gets `503 stream_limit`. */
  maxStreams: 8,
  /** The window in which changes of the list become one frame. */
  coalesceMs: 50,
  heartbeatMs: STREAM_HEARTBEAT_MS,
  /** A client undrained for this long is destroyed. */
  stallMs: 30_000,
} as const;

/** The limits as numbers, so that a test can shorten one. */
export type TerminalEventLimits = { readonly [K in keyof typeof TERMINAL_EVENT_LIMITS]: number };

/** Where frames go: the response of one client. `write` answers false when its buffer is full, as `Writable.write` does. */
export interface TerminalEventSink {
  write(chunk: string): boolean;
  /** Calls `callback` once, when the sink can take data again. */
  onceDrain(callback: () => void): void;
  destroy(): void;
}

export interface TerminalEventsHandle {
  /** Removes the client and clears its timers. Idempotent; the sink is not touched. */
  close(): void;
}

export interface TerminalEvents {
  /** Number of connected clients. */
  readonly size: number;
  /** False when the limit of streams is reached. */
  hasCapacity(): boolean;
  /**
   * Registers a client and writes its opening frames; `null` when the limit is reached (the caller answers `503 stream_limit`
   * before it has written anything). `credentialId` is the credential the access guard admitted.
   */
  accept(sink: TerminalEventSink, credentialId: string): TerminalEventsHandle | null;
  /** Destroys every sink and removes every client (shutdown, tests). */
  closeAll(): void;
}

/** The part of the session list the feed reads. */
export type TerminalEventSessions = Pick<TerminalSessionsPort, 'list' | 'subscribe'>;

export interface TerminalEventsOptions {
  /** The live sessions of the host; a host without usable terminals passes an empty list. */
  readonly sessions: TerminalEventSessions;
  /** Where a revocation is announced. */
  readonly access: Pick<AccessService, 'onRevoked'>;
  readonly instanceId: string;
  /** The stream epoch of this process (the hello carries it, like the monitor stream). */
  readonly epoch: string;
  /** Epoch ms. */
  readonly now: () => number;
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  /** Tests may shorten the limits. */
  readonly limits?: Partial<TerminalEventLimits>;
}

interface Client {
  readonly sink: TerminalEventSink;
  readonly credentialId: string;
  closed: boolean;
  /** The version of the last snapshot written to or pending for this client. */
  version: number;
  /** True while a write was refused and the sink has not drained. */
  waiting: boolean;
  /** The one frame that waits for the drain (the newest snapshot), with its version. */
  pending: { readonly version: number; readonly text: string } | undefined;
  heartbeat: NodeJS.Timeout | undefined;
  stall: NodeJS.Timeout | undefined;
}

function field(name: string, value: string): string {
  return `${name}: ${value}\n`;
}

/** One SSE frame: the event name, the JSON data (never a raw newline), the blank line. */
function frameText(event: string, data: unknown): string {
  return `${field('event', event)}${field('data', JSON.stringify(data))}\n`;
}

export function createTerminalEvents(options: TerminalEventsOptions): TerminalEvents {
  const { sessions, logger } = options;
  const limits: TerminalEventLimits = { ...TERMINAL_EVENT_LIMITS, ...options.limits };
  const clients = new Set<Client>();
  let unsubscribeSessions: (() => void) | undefined;
  let unsubscribeRevoked: (() => void) | undefined;
  let window: NodeJS.Timeout | undefined;
  let version = 0;
  /** The snapshot of the current list, built once per change; `undefined` after a change until someone needs it. */
  let snapshot: { readonly version: number; readonly text: string } | undefined;

  // ---- frames ------------------------------------------------------------------------------------------------------------

  function snapshotFrame(): { readonly version: number; readonly text: string } {
    if (snapshot !== undefined) return snapshot;
    version += 1;
    const data: TerminalSessionsEvent = { version, sessions: [...sessions.list()] satisfies TerminalSessionInfo[] };
    snapshot = { version, text: frameText('sessions', data) };
    return snapshot;
  }

  function helloFrame(): string {
    const data: TerminalHelloEvent = {
      instanceId: options.instanceId,
      epoch: options.epoch,
      serverTime: isoMsZ(options.now()),
      heartbeatMs: limits.heartbeatMs,
    };
    return frameText('hello', data);
  }

  // ---- writing -----------------------------------------------------------------------------------------------------------

  function release(): void {
    if (clients.size > 0) return;
    unsubscribeSessions?.();
    unsubscribeSessions = undefined;
    unsubscribeRevoked?.();
    unsubscribeRevoked = undefined;
    clearTimeout(window);
    window = undefined;
    // nobody listens for changes any more, so the snapshot may be stale by the next client
    snapshot = undefined;
  }

  function remove(client: Client): boolean {
    if (client.closed) return false;
    client.closed = true;
    clearInterval(client.heartbeat);
    clearTimeout(client.stall);
    client.heartbeat = undefined;
    client.stall = undefined;
    client.pending = undefined;
    clients.delete(client);
    release();
    return true;
  }

  /** Removes the client and destroys its sink (a stall, a failed write, a revocation, shutdown). */
  function evict(client: Client, reason: string): void {
    if (!remove(client)) return;
    logger.warn('terminal_events_client_evicted', { reason });
    try {
      client.sink.destroy();
    } catch {
      // the socket is gone already
    }
  }

  /** Writes one chunk; a refused write (or a sink that throws) stops the client until the sink drains. */
  function send(client: Client, chunk: string): void {
    if (client.closed) return;
    let accepted: boolean;
    try {
      accepted = client.sink.write(chunk);
    } catch {
      evict(client, 'write_failed');
      return;
    }
    if (accepted || client.waiting) return;
    client.waiting = true;
    client.stall = setTimeout(() => {
      evict(client, 'stalled');
    }, limits.stallMs);
    client.sink.onceDrain(() => {
      if (client.closed) return;
      client.waiting = false;
      clearTimeout(client.stall);
      client.stall = undefined;
      const pending = client.pending;
      client.pending = undefined;
      if (pending !== undefined && pending.version > client.version) {
        client.version = pending.version;
        send(client, pending.text);
      }
    });
  }

  /** Latest wins: a client that is waiting keeps only the newest snapshot; any other gets it now. */
  function deliver(client: Client, frame: { readonly version: number; readonly text: string }): void {
    if (client.closed || client.version >= frame.version) return;
    if (client.waiting) {
      client.pending = frame;
      return;
    }
    client.version = frame.version;
    send(client, frame.text);
  }

  function heartbeat(client: Client): void {
    // a client that has not drained gets nothing more: its buffer stays bounded
    if (client.closed || client.waiting) return;
    const data: TerminalHeartbeatEvent = { serverTime: isoMsZ(options.now()) };
    send(client, frameText('heartbeat', data));
  }

  // ---- changes -----------------------------------------------------------------------------------------------------------

  function changed(): void {
    snapshot = undefined;
    if (window !== undefined || clients.size === 0) return;
    window = setTimeout(() => {
      window = undefined;
      if (clients.size === 0) return;
      const frame = snapshotFrame();
      for (const client of [...clients]) deliver(client, frame);
    }, limits.coalesceMs);
  }

  function revoked(credentialId: string): void {
    let closed = 0;
    for (const client of [...clients]) {
      if (client.credentialId !== credentialId) continue;
      evict(client, 'revoked');
      closed += 1;
    }
    if (closed > 0) logger.info('terminal_events_revoked', { count: closed });
  }

  // ---- the public side ---------------------------------------------------------------------------------------------------

  return {
    get size(): number {
      return clients.size;
    },

    hasCapacity: () => clients.size < limits.maxStreams,

    accept(sink, credentialId) {
      if (clients.size >= limits.maxStreams) return null;
      const client: Client = {
        sink,
        credentialId,
        closed: false,
        version: 0,
        waiting: false,
        pending: undefined,
        heartbeat: undefined,
        stall: undefined,
      };
      clients.add(client);
      unsubscribeSessions ??= sessions.subscribe(changed);
      unsubscribeRevoked ??= options.access.onRevoked(revoked);
      client.heartbeat = setInterval(() => {
        heartbeat(client);
      }, limits.heartbeatMs);
      send(client, `retry: ${String(STREAM_RETRY_MS)}\n\n`);
      send(client, helloFrame());
      deliver(client, snapshotFrame());
      return {
        close: () => {
          remove(client);
        },
      };
    },

    closeAll() {
      for (const client of [...clients]) {
        remove(client);
        try {
          client.sink.destroy();
        } catch {
          // already gone
        }
      }
    },
  };
}

// ---- the route -----------------------------------------------------------------------------------------------------------------

function sinkOf(res: Response): TerminalEventSink {
  return {
    write: (chunk) => res.write(chunk),
    onceDrain: (callback) => {
      res.once('drain', callback);
    },
    destroy: () => {
      res.destroy();
    },
  };
}

/** What the route module needs; the module reads the instance id and the logger from the context of the app. */
export interface TerminalEventsRouteOptions {
  /** The terminal host, or `null` when there is none: the feed then carries an empty list and no change ever comes. */
  readonly ports: TerminalPorts | null;
  readonly access: Pick<AccessService, 'onRevoked'>;
  /** The stream epoch of this process. */
  readonly epoch: string;
  /** Epoch ms. */
  readonly now: () => number;
  /** Shorter limits (tests). */
  readonly limits?: Partial<TerminalEventLimits>;
  /** Called once, with the feed, when the module is mounted (the shutdown closes it; tests look at it). */
  readonly onEvents?: (events: TerminalEvents) => void;
  /** Called with the response of every accepted stream (tests). */
  readonly onResponse?: (res: ServerResponse) => void;
}

const NO_SESSIONS: TerminalEventSessions = {
  list: () => [],
  subscribe: () => () => undefined,
};

/** The sessions the feed lists: nothing while the host cannot run a terminal (the state route says the same). */
function sessionsOf(ports: TerminalPorts | null): TerminalEventSessions {
  if (ports === null) return NO_SESSIONS;
  return {
    list: () => (ports.capabilities().available ? ports.sessions.list() : []),
    subscribe: (listener) => ports.sessions.subscribe(listener),
  };
}

/** The module that mounts `GET /api/v3/terminal/events`. The session guard has admitted a cookie before the handler runs. */
export function createTerminalEventsRoutes(options: TerminalEventsRouteOptions): RouteModule {
  return (app, { ctx }) => {
    const events = createTerminalEvents({
      sessions: sessionsOf(options.ports),
      access: options.access,
      instanceId: ctx.instanceId,
      epoch: options.epoch,
      now: options.now,
      logger: ctx.logger,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
    options.onEvents?.(events);

    registerRoute(app, routes.terminalEvents, ({ req, res }) => {
      const admitted = accessOf(res);
      // the session guard admits a cookie only; anything else here is a wiring fault and gets no stream
      if (admitted?.via !== 'cookie') throw new ApiError('access_required');
      if (!events.hasCapacity()) throw new ApiError('stream_limit');
      if (res.destroyed || req.socket.destroyed) {
        res.end(); // the client left before the answer began
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      req.socket.setNoDelay(true);
      req.socket.setTimeout(0);

      const handle = events.accept(sinkOf(res), admitted.session.credentialId);
      if (handle === null) {
        // another request took the last place between the check and here: single threaded, so it cannot happen, but never hang
        res.end();
        return;
      }
      options.onResponse?.(res);
      const leave = (): void => {
        handle.close();
      };
      res.once('close', leave);
      res.once('error', leave);
    });
  };
}
