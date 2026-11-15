// The WebSocket gateway of the terminal (CAW-25, design 02 5.3 to 5.5, ADR 0087): the one place that imports `ws` (ADR 0081). The
// socket route has already run every guard and admitted a credential; `accept` finishes the handshake (`ws` in `noServer`
// mode) and speaks protocol v1 on the socket:
//   - the subprotocol `caw.terminal.v1` is selected by its exact name (the route has already refused a handshake that does not offer
//     it, and `ws` would answer 101 without a subprotocol); no compression (a decompression bomb and CPU for nothing); `maxPayload` is the
//     one input limit of the whole path (`TERMINAL_INPUT_MAX_BYTES`), so a longer message is closed by `ws` with 1009;
//   - first the text frame `ready`, then the replay snapshot in binary chunks of at most 64 KiB, then the text frame `live`, then
//     live output as coalesced binary frames (`output-batcher.ts`: one frame of at most 64 KiB per tick). The snapshot and the
//     subscription are one synchronous `attach`, and everything is written in the same turn, so no byte is lost or doubled;
//   - client binary frames are input, written to the session unchanged; the one client text frame is `resize`, at most 256 bytes
//     (1009 above that), strict (1008 for anything else), clamped by `clampTerminalSize`;
//   - the process is never slowed down for a viewer: a viewer whose socket holds more than 4 MiB (`bufferedAmount`, beyond the replay
//     it was just sent, or the batcher's pending data) is closed with 1013 and may reconnect for the replay;
//   - an exit reaches the viewer after the last output: pending output is flushed, then the `exit` frame, then 4000 (4001 when the
//     kill route ended it);
//   - one interval pings every socket; a socket that did not pong since the last tick is terminated; the same tick makes the access
//     service sweep expired credentials, whose revocation closes their sockets with 4003, as a logout does;
//   - `closeAll` (shutdown) closes with 1001 and terminates what is still open after the grace period: `http.closeAllConnections()`
//     does not know an upgraded socket.
// The log carries counts and numeric close codes only: never a session name, a folder, a byte of input or output, a cookie.
import type { AccessService, Logger } from '@mcs/engine';
import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_SUBPROTOCOL,
  TERMINAL_TEXT_FRAME_MAX_BYTES,
  TerminalClientMessageSchema,
  clampTerminalSize,
  type TerminalServerMessage,
} from '@mcs/shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { ApiError } from '../errors.ts';
import { OUTPUT_FRAME_BYTES, createOutputBatcher, type OutputBatcher } from './output-batcher.ts';
import type {
  TerminalAttachment,
  TerminalExit,
  TerminalGateway,
  TerminalSessionPort,
  TerminalSocketRequest,
  TerminalViewer,
} from './ports.ts';

/** The limits of design 02 5.3; tests shorten the intervals and the water mark through `limits`. */
export const TERMINAL_SOCKET_LIMITS = {
  /** Sockets of the instance and of one session; the 33rd and the 9th get `503 stream_limit` before the upgrade. */
  maxClients: 32,
  maxPerSession: 8,
  /** The largest binary message (input); `ws` closes a longer one with 1009. One limit for the whole path. */
  maxMessageBytes: TERMINAL_INPUT_MAX_BYTES,
  /** The largest text frame; a longer one closes the socket with 1009. */
  maxControlBytes: TERMINAL_TEXT_FRAME_MAX_BYTES,
  outputFrameBytes: OUTPUT_FRAME_BYTES,
  replayChunkBytes: 65_536,
  /** A socket that holds more than this is too slow: 1013. */
  highWaterBytes: 4_194_304,
  pingIntervalMs: 30_000,
  /** How long a close handshake may take before the socket is terminated. */
  closeGraceMs: 1000,
} as const;

/** The limits as numbers, so that a test can shorten one. */
export type TerminalSocketLimits = { readonly [K in keyof typeof TERMINAL_SOCKET_LIMITS]: number };

/** The reason strings of a close frame: fixed tokens, never request data (design 02 5.4). */
export const TERMINAL_CLOSE_REASONS = {
  shuttingDown: 'shutting_down',
  badMessage: 'bad_message',
  tooBig: 'too_big',
  slowConsumer: 'slow_consumer',
  internalError: 'internal_error',
  exited: 'exited',
  killed: 'killed',
  signedOut: 'signed_out',
} as const;

export interface TerminalGatewayOptions {
  /**
   * `onRevoked` closes the sockets of a credential that was revoked, dropped or expired. `verify` is called without a credential
   * once per ping tick: it judges nobody and makes the service sweep the expired ones (their revocation reaches `onRevoked`).
   */
  readonly access: Pick<AccessService, 'onRevoked' | 'verify'>;
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  readonly limits?: Partial<TerminalSocketLimits>;
}

interface Client {
  readonly ws: WebSocket;
  readonly name: string;
  readonly credentialId: string;
  readonly session: TerminalSessionPort;
  readonly batcher: OutputBatcher;
  attachment: TerminalAttachment | undefined;
  /** False from a ping until the pong. */
  alive: boolean;
  /** A close was started: nothing more is read from the session or the socket. */
  closing: boolean;
  grace: NodeJS.Timeout | undefined;
}

/** The text of a message of the client as bytes, whatever shape `ws` gave it. */
function bytesOf(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}

/** The code of a `ws` protocol error (`WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`, ...) or `unknown`: never the message, which may quote the peer. */
function wsErrorCodeOf(error: unknown): string {
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' && /^WS_ERR_[A-Z_]{1,60}$/.test(code) ? code : 'unknown';
}

/** An exit code as the schema wants it: a whole number or `null`. */
function exitCodeOf(code: number | null): number | null {
  return typeof code === 'number' && Number.isSafeInteger(code) ? code : null;
}

/** A signal as the schema wants it: 1 to 32 plain characters or `null`. */
function signalOf(signal: string | null): string | null {
  return typeof signal === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(signal) ? signal : null;
}

export function createTerminalGateway(options: TerminalGatewayOptions): TerminalGateway {
  const { access, logger } = options;
  const limits: TerminalSocketLimits = { ...TERMINAL_SOCKET_LIMITS, ...options.limits };
  const clients = new Set<Client>();
  const perSession = new Map<string, number>();
  const idleWaiters: (() => void)[] = [];
  let unsubscribeRevoked: (() => void) | undefined;
  let pinger: NodeJS.Timeout | undefined;
  let draining = false;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxMessageBytes,
    perMessageDeflate: false,
    clientTracking: false,
    handleProtocols: (protocols) => (protocols.has(TERMINAL_SUBPROTOCOL) ? TERMINAL_SUBPROTOCOL : false),
  });

  // ---- writing ----------------------------------------------------------------------------------------------------------

  function sendText(client: Client, message: TerminalServerMessage): void {
    if (client.closing || client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(JSON.stringify(message));
  }

  function sendBinary(client: Client, frame: Buffer): void {
    if (client.closing || client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(frame, { binary: true });
  }

  /** Starts the close handshake with a code and a fixed reason; the socket is terminated when the peer does not answer in time. */
  function close(client: Client, code: number, reason: string): void {
    if (client.closing) return;
    client.closing = true;
    client.batcher.close();
    client.attachment?.detach();
    client.attachment = undefined;
    try {
      client.ws.close(code, reason);
    } catch {
      client.ws.terminate();
      return;
    }
    client.grace = setTimeout(() => {
      client.ws.terminate();
    }, limits.closeGraceMs);
    client.grace.unref();
  }

  // ---- the intervals ----------------------------------------------------------------------------------------------------

  function tick(): void {
    // a call with no credential judges nobody and sweeps the expired ones: their revocation closes their sockets (4003)
    access.verify(undefined);
    for (const client of [...clients]) {
      if (client.closing) continue;
      if (!client.alive) {
        logger.warn('terminal_socket_dead_peer', { count: clients.size });
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        client.ws.terminate();
      }
    }
  }

  function revoked(credentialId: string): void {
    gateway.closeByCredential(credentialId, TERMINAL_CLOSE_CODES.signedOut, TERMINAL_CLOSE_REASONS.signedOut);
  }

  function register(client: Client): void {
    clients.add(client);
    perSession.set(client.name, (perSession.get(client.name) ?? 0) + 1);
    unsubscribeRevoked ??= access.onRevoked(revoked);
    if (pinger === undefined) {
      pinger = setInterval(tick, limits.pingIntervalMs);
      pinger.unref();
    }
  }

  function unregister(client: Client, code: number): void {
    if (!clients.delete(client)) return;
    clearTimeout(client.grace);
    client.grace = undefined;
    client.closing = true;
    client.batcher.close();
    client.attachment?.detach();
    client.attachment = undefined;
    const left = (perSession.get(client.name) ?? 1) - 1;
    if (left > 0) perSession.set(client.name, left);
    else perSession.delete(client.name);
    logger.info('terminal_socket_close', { code, count: clients.size });
    if (clients.size > 0) return;
    unsubscribeRevoked?.();
    unsubscribeRevoked = undefined;
    clearInterval(pinger);
    pinger = undefined;
    for (const done of idleWaiters.splice(0)) done();
  }

  // ---- what the client sends --------------------------------------------------------------------------------------------

  function onMessage(client: Client, data: RawData, isBinary: boolean): void {
    if (client.closing) return;
    const bytes = bytesOf(data);
    try {
      if (isBinary) {
        if (bytes.length > 0) client.session.write(bytes);
        return;
      }
      if (bytes.length > limits.maxControlBytes) {
        close(client, TERMINAL_CLOSE_CODES.tooBig, TERMINAL_CLOSE_REASONS.tooBig);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        close(client, TERMINAL_CLOSE_CODES.badMessage, TERMINAL_CLOSE_REASONS.badMessage);
        return;
      }
      const checked = TerminalClientMessageSchema.safeParse(parsed);
      if (!checked.success) {
        close(client, TERMINAL_CLOSE_CODES.badMessage, TERMINAL_CLOSE_REASONS.badMessage);
        return;
      }
      const size = clampTerminalSize(checked.data.cols, checked.data.rows);
      client.session.resize(size.cols, size.rows);
    } catch {
      // the session refused (it ended between two frames, or the engine failed): the viewer cannot go on
      logger.warn('terminal_socket_session_failed', { count: clients.size });
      close(client, TERMINAL_CLOSE_CODES.internalError, TERMINAL_CLOSE_REASONS.internalError);
    }
  }

  // ---- one socket -------------------------------------------------------------------------------------------------------

  function start(ws: WebSocket, request: TerminalSocketRequest): void {
    ws.binaryType = 'nodebuffer';
    const holder: { client?: Client } = {};
    // The replay is written in one go, so for a moment the socket holds all of it: that is not the lag of the viewer. The
    // allowance is the size of the replay that was sent (bounded by `terminal.replayBytes`), so a large replay does not make the
    // first live frame look like a slow consumer.
    const allowance = { bytes: 0 };
    const batcher = createOutputBatcher({
      frameBytes: limits.outputFrameBytes,
      maxPendingBytes: limits.highWaterBytes,
      send: (frame) => {
        if (holder.client !== undefined) sendBinary(holder.client, frame);
      },
      congested: () => ws.bufferedAmount > limits.highWaterBytes + allowance.bytes,
      onHighWater: () => {
        logger.warn('terminal_socket_slow_consumer', { count: clients.size });
        if (holder.client !== undefined) {
          close(holder.client, TERMINAL_CLOSE_CODES.slowConsumer, TERMINAL_CLOSE_REASONS.slowConsumer);
        }
      },
    });
    const client: Client = {
      ws,
      name: request.name,
      credentialId: request.credentialId,
      session: request.session,
      batcher,
      attachment: undefined,
      alive: true,
      closing: false,
      grace: undefined,
    };
    holder.client = client;
    register(client);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      onMessage(client, data, isBinary);
    });
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('error', (error: Error) => {
      // `ws` closes the socket itself after a protocol error (1002, 1007, 1009); the log keeps the kind, never the message
      logger.info('terminal_socket_error', { count: clients.size, code: wsErrorCodeOf(error) });
    });
    ws.on('close', (code: number) => {
      unregister(client, code);
    });

    const viewer: TerminalViewer = {
      onData: (chunk) => {
        if (!client.closing) batcher.push(chunk);
      },
      onSize: (cols, rows) => {
        if (client.closing) return;
        // output written for the old size first, then the new size
        batcher.flush();
        const size = clampTerminalSize(cols, rows);
        sendText(client, { type: 'size', cols: size.cols, rows: size.rows });
      },
      onExit: (exit: TerminalExit) => {
        if (client.closing) return;
        // the last output comes before the end of the process
        batcher.flush();
        // a flush that met the high-water mark stopped the batcher and closed the socket (1013): no exit frame then
        if (batcher.closed) return;
        sendText(client, { type: 'exit', code: exitCodeOf(exit.code), signal: signalOf(exit.signal) });
        close(
          client,
          exit.killed ? TERMINAL_CLOSE_CODES.killed : TERMINAL_CLOSE_CODES.exited,
          exit.killed ? TERMINAL_CLOSE_REASONS.killed : TERMINAL_CLOSE_REASONS.exited,
        );
      },
    };

    let attachment: TerminalAttachment;
    try {
      attachment = request.session.attach(viewer);
    } catch {
      logger.warn('terminal_socket_attach_failed', { count: clients.size });
      close(client, TERMINAL_CLOSE_CODES.internalError, TERMINAL_CLOSE_REASONS.internalError);
      return;
    }
    client.attachment = attachment;

    const { replay } = attachment;
    allowance.bytes = replay.byteLength;
    const size = clampTerminalSize(attachment.cols, attachment.rows);
    sendText(client, {
      type: 'ready',
      v: 1,
      cols: size.cols,
      rows: size.rows,
      replayBytes: replay.byteLength,
      viewers: perSession.get(client.name) ?? 1,
    });
    for (let at = 0; at < replay.byteLength; at += limits.replayChunkBytes) {
      const length = Math.min(limits.replayChunkBytes, replay.byteLength - at);
      sendBinary(client, Buffer.from(replay.buffer, replay.byteOffset + at, length));
    }
    sendText(client, { type: 'live' });
    logger.info('terminal_socket_open', { count: clients.size });
  }

  // ---- the public side --------------------------------------------------------------------------------------------------

  const gateway: TerminalGateway = {
    get size(): number {
      return clients.size;
    },

    admit(name) {
      if (draining) throw new ApiError('shutting_down');
      if (clients.size >= limits.maxClients || (perSession.get(name) ?? 0) >= limits.maxPerSession) {
        throw new ApiError('stream_limit');
      }
    },

    accept(request) {
      wss.handleUpgrade(request.req, request.socket, request.head, (ws) => {
        start(ws, request);
      });
    },

    closeByCredential(credentialId, code, reason) {
      let closed = 0;
      for (const client of [...clients]) {
        if (client.credentialId !== credentialId || client.closing) continue;
        close(client, code, reason);
        closed += 1;
      }
      if (closed > 0) logger.info('terminal_socket_revoked', { count: closed });
      return closed;
    },

    closeAll(code, reason) {
      draining = true;
      for (const client of [...clients]) close(client, code, reason);
      if (clients.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
  return gateway;
}
