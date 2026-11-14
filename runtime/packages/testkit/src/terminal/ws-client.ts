// A WebSocket client for the terminal tests (design 08, section 3.2), written on node:net and node:crypto only. It is an oracle
// that does not share code with the `ws` package of the server, and it can send what a library refuses to send: unmasked frames,
// reserved bits, a length that lies, oversize frames, a ping nobody answers. It speaks the subprotocol of design 02 by default.
import { createHash, randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';

import { scaled } from './pty-support.ts';

/** The GUID of RFC 6455 section 1.3. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The subprotocol of the terminal socket (`TERMINAL_SUBPROTOCOL` of design 02). */
export const TERMINAL_SUBPROTOCOL_V1 = 'caw.terminal.v1';

/** `Sec-WebSocket-Accept` for a `Sec-WebSocket-Key`. */
export function acceptKeyFor(key: string): string {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

export interface ConnectOptions {
  path: string;
  host?: string;
  /** Default `http://127.0.0.1:<port>`; `null` sends no Origin header. */
  origin?: string | null;
  /** The value of the Cookie header. */
  cookie?: string;
  headers?: Record<string, string>;
  /** Default `['caw.terminal.v1']`; an empty list sends no subprotocol header. */
  protocols?: string[];
  /** The `Sec-WebSocket-Key` (default: 16 random bytes in base64). */
  key?: string;
  /** Answer a ping with a pong carrying the same payload (default true). */
  autoPong?: boolean;
  /** Budget of the handshake in ms (default 10 s times `QA_TIME_SCALE`). */
  timeoutMs?: number;
}

export interface FrameSpec {
  opcode: number;
  /** Default true. */
  fin?: boolean;
  /** Default true: a client frame must be masked. */
  mask?: boolean;
  /** The three reserved bits as a number 0..7 (default 0). */
  rsv?: number;
  payload: Uint8Array;
  /** Written into the length field instead of the real length. */
  lengthLie?: number | bigint;
}

export interface WsMessage {
  opcode: number;
  payload: Buffer;
}

const OP_CONTINUATION = 0;
const OP_TEXT = 1;
const OP_BINARY = 2;
const OP_CLOSE = 8;
const OP_PING = 9;
const OP_PONG = 10;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const HEAD_END = Buffer.from('\r\n\r\n');

function encodeFrame(spec: FrameSpec): Buffer {
  const fin = spec.fin ?? true;
  const mask = spec.mask ?? true;
  const rsv = (spec.rsv ?? 0) & 7;
  const length: bigint = spec.lengthLie === undefined ? BigInt(spec.payload.length) : BigInt(spec.lengthLie);
  const first = (fin ? 0x80 : 0) | (rsv << 4) | (spec.opcode & 0x0f);
  const maskBit = mask ? 0x80 : 0;
  let head: Buffer;
  if (length < 126n) {
    head = Buffer.from([first, maskBit | Number(length)]);
  } else if (length <= 0xffffn) {
    head = Buffer.alloc(4);
    head.writeUInt8(first, 0);
    head.writeUInt8(maskBit | 126, 1);
    head.writeUInt16BE(Number(length), 2);
  } else {
    head = Buffer.alloc(10);
    head.writeUInt8(first, 0);
    head.writeUInt8(maskBit | 127, 1);
    head.writeBigUInt64BE(length, 2);
  }
  if (!mask) return Buffer.concat([head, spec.payload]);
  const key = randomBytes(4);
  const body = Buffer.from(spec.payload);
  for (let i = 0; i < body.length; i += 1) body[i] = (body[i] ?? 0) ^ (key[i % 4] ?? 0);
  return Buffer.concat([head, key, body]);
}

function parseHead(head: string): { status: number; headers: Record<string, string> } {
  const lines = head.split('\r\n');
  const status = Number.parseInt(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? '', 10);
  if (!Number.isInteger(status)) throw new Error('RawWsClient: the answer is not an HTTP response');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers };
}

interface MessageWaiter {
  resolve: (message: WsMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface DataWaiter {
  test: () => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RawWsClient {
  /** The HTTP status of the answer to the upgrade request (101 when it was accepted). */
  readonly status: number;
  /** The response headers, names in lower case. */
  readonly headers: Record<string, string>;
  /** True for status 101 with the `Sec-WebSocket-Accept` of the key that was sent (RFC 6455 section 4.2.2). */
  readonly acceptOk: boolean;
  /** The body of a refused upgrade (status other than 101); empty otherwise. */
  readonly body: string;

  readonly #socket: Socket;
  readonly #autoPong: boolean;
  #buffer: Buffer = Buffer.alloc(0);
  #fragment: { opcode: number; parts: Buffer[] } | null = null;
  readonly #queue: WsMessage[] = [];
  readonly #messageWaiters: MessageWaiter[] = [];
  readonly #dataWaiters = new Set<DataWaiter>();
  #binary: Buffer[] = [];
  readonly #texts: unknown[] = [];
  #closeInfo: { code: number; reason: string } | null = null;
  #closeSent = false;
  #closed = false;
  readonly #closedWaiters: (() => void)[] = [];

  private constructor(
    socket: Socket,
    head: { status: number; headers: Record<string, string>; acceptOk: boolean; body: string },
    autoPong: boolean,
    leftover: Buffer,
  ) {
    this.#socket = socket;
    this.#autoPong = autoPong;
    this.status = head.status;
    this.headers = head.headers;
    this.acceptOk = head.acceptOk;
    this.body = head.body;
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    socket.on('error', () => undefined);
    socket.once('close', () => {
      this.#markClosed();
    });
    if (head.status === 101) {
      socket.on('data', (chunk: Buffer) => {
        this.#onData(chunk);
      });
      socket.resume();
      if (leftover.length > 0) this.#onData(leftover);
    } else {
      socket.resume();
      if (socket.destroyed) this.#markClosed();
      else socket.destroy();
    }
  }

  /** Opens the connection and performs the handshake. A refused upgrade resolves too: read `status`, `headers` and `body`. */
  static connect(port: number, opts: ConnectOptions): Promise<RawWsClient> {
    const host = opts.host ?? '127.0.0.1';
    const key = opts.key ?? randomBytes(16).toString('base64');
    const protocols = opts.protocols ?? [TERMINAL_SUBPROTOCOL_V1];
    const origin = opts.origin === undefined ? `http://127.0.0.1:${String(port)}` : opts.origin;
    const lines = [
      `GET ${opts.path} HTTP/1.1`,
      `Host: ${host}:${String(port)}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...(protocols.length > 0 ? [`Sec-WebSocket-Protocol: ${protocols.join(', ')}`] : []),
      ...(origin === null ? [] : [`Origin: ${origin}`]),
      ...(opts.cookie === undefined ? [] : [`Cookie: ${opts.cookie}`]),
      ...Object.entries(opts.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ];
    const timeoutMs = opts.timeoutMs ?? scaled(10_000);
    return new Promise((resolve, reject) => {
      const socket = netConnect({ port, host });
      socket.setNoDelay(true);
      let received: Buffer = Buffer.alloc(0);
      let head: { status: number; headers: Record<string, string> } | null = null;
      let bodyStart = 0;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const finish = (bodyText: string, leftover: Buffer): void => {
        if (settled || head === null) return;
        settled = true;
        clearTimeout(timer);
        const acceptOk = head.status === 101 && head.headers['sec-websocket-accept'] === acceptKeyFor(key);
        resolve(new RawWsClient(socket, { ...head, acceptOk, body: bodyText }, opts.autoPong ?? true, leftover));
      };
      const timer = setTimeout(() => {
        fail(new Error(`RawWsClient.connect: no answer to the upgrade request within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      socket.once('connect', () => {
        socket.write(lines.join('\r\n'));
      });
      socket.on('error', (error: Error) => {
        fail(new Error(`RawWsClient.connect: ${codeOf(error) ?? 'connection error'}`));
      });
      socket.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (head === null) {
          const end = received.indexOf(HEAD_END);
          if (end < 0) return;
          try {
            head = parseHead(received.subarray(0, end).toString('latin1'));
          } catch (error) {
            fail(error instanceof Error ? error : new Error('RawWsClient.connect: the answer cannot be read'));
            return;
          }
          bodyStart = end + HEAD_END.length;
          if (head.status === 101) {
            socket.pause();
            finish('', received.subarray(bodyStart));
            return;
          }
        }
        const declared = Number.parseInt(head.headers['content-length'] ?? '', 10);
        const body = received.subarray(bodyStart);
        if (Number.isInteger(declared) && body.length >= declared) {
          socket.pause();
          finish(body.subarray(0, declared).toString('utf8'), Buffer.alloc(0));
        }
      });
      socket.on('close', () => {
        if (head !== null) finish(received.subarray(bodyStart).toString('utf8'), Buffer.alloc(0));
        else fail(new Error('RawWsClient.connect: the connection closed before the upgrade answer'));
      });
    });
  }

  // ---- sending ---------------------------------------------------------------------------------------------------

  #write(frame: Buffer): void {
    if (!this.#socket.destroyed && this.#socket.writable) this.#socket.write(frame);
  }

  sendText(text: string): void {
    this.sendFrame({ opcode: OP_TEXT, payload: Buffer.from(text, 'utf8') });
  }

  sendBinary(data: Uint8Array): void {
    this.sendFrame({ opcode: OP_BINARY, payload: data });
  }

  sendPing(data: Uint8Array = new Uint8Array(0)): void {
    this.sendFrame({ opcode: OP_PING, payload: data });
  }

  sendPong(data: Uint8Array = new Uint8Array(0)): void {
    this.sendFrame({ opcode: OP_PONG, payload: data });
  }

  /** A close frame with a code and a reason, or an empty one when `code` is undefined. Does not wait for anything. */
  sendCloseFrame(code?: number, reason = ''): void {
    this.#closeSent = true;
    if (code === undefined) {
      this.sendFrame({ opcode: OP_CLOSE, payload: new Uint8Array(0) });
      return;
    }
    const reasonBytes = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.sendFrame({ opcode: OP_CLOSE, payload });
  }

  /** Any frame, including the ones a conforming client never sends (see `FrameSpec`). */
  sendFrame(spec: FrameSpec): void {
    this.#write(encodeFrame(spec));
  }

  // ---- receiving -------------------------------------------------------------------------------------------------

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const buf = this.#buffer;
      if (buf.length < 2) return;
      const b0 = buf.readUInt8(0);
      const b1 = buf.readUInt8(1);
      let length = BigInt(b1 & 0x7f);
      let offset = 2;
      if (length === 126n) {
        if (buf.length < 4) return;
        length = BigInt(buf.readUInt16BE(2));
        offset = 4;
      } else if (length === 127n) {
        if (buf.length < 10) return;
        length = buf.readBigUInt64BE(2);
        offset = 10;
      }
      if (length > BigInt(MAX_FRAME_BYTES)) {
        this.#socket.destroy();
        return;
      }
      const masked = (b1 & 0x80) !== 0;
      const keyLength = masked ? 4 : 0;
      const total = offset + keyLength + Number(length);
      if (buf.length < total) return;
      const payload = Buffer.from(buf.subarray(offset + keyLength, total));
      if (masked) {
        const key = buf.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i += 1) payload[i] = (payload[i] ?? 0) ^ (key[i % 4] ?? 0);
      }
      this.#buffer = buf.subarray(total);
      this.#onFrame((b0 & 0x80) !== 0, b0 & 0x0f, payload);
    }
  }

  #onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode >= OP_CLOSE) {
      this.#onControl(opcode, payload);
      return;
    }
    let fragment = this.#fragment;
    if (opcode === OP_CONTINUATION) {
      if (fragment === null) return;
      fragment.parts.push(payload);
    } else {
      fragment = { opcode, parts: [payload] };
      this.#fragment = fragment;
    }
    if (!fin) return;
    const message = { opcode: fragment.opcode, payload: Buffer.concat(fragment.parts) };
    this.#fragment = null;
    if (message.opcode === OP_BINARY) {
      this.#binary.push(message.payload);
    } else if (message.opcode === OP_TEXT) {
      const text = message.payload.toString('utf8');
      try {
        this.#texts.push(JSON.parse(text));
      } catch {
        this.#texts.push(text);
      }
    }
    this.#deliver(message);
    this.#checkDataWaiters();
  }

  #onControl(opcode: number, payload: Buffer): void {
    if (opcode === OP_PING && this.#autoPong) this.sendPong(payload);
    if (opcode === OP_CLOSE) {
      this.#closeInfo =
        payload.length >= 2
          ? { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') }
          : { code: 1005, reason: '' };
      if (!this.#closeSent) {
        this.#closeSent = true;
        this.#write(encodeFrame({ opcode: OP_CLOSE, payload: payload.subarray(0, 2) }));
      }
      this.#socket.end();
    }
    this.#deliver({ opcode, payload });
  }

  #deliver(message: WsMessage): void {
    const waiter = this.#messageWaiters.shift();
    if (waiter === undefined) {
      this.#queue.push(message);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#messageWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('RawWsClient.next: the socket is closed'));
    }
    for (const waiter of [...this.#dataWaiters]) {
      this.#dataWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(new Error('RawWsClient.until: the socket closed before the data arrived'));
    }
    for (const done of this.#closedWaiters.splice(0)) done();
  }

  #checkDataWaiters(): void {
    for (const waiter of [...this.#dataWaiters]) {
      if (!waiter.test()) continue;
      this.#dataWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  /**
   * The next message or control frame the server sent that `next` has not returned yet. A fragmented data message is one
   * message; pings, pongs and the close frame are messages too. Rejects after `timeoutMs` (default 10 s times
   * `QA_TIME_SCALE`) and, once nothing is left, when the socket is closed.
   */
  next(timeoutMs: number = scaled(10_000)): Promise<WsMessage> {
    const message = this.#queue.shift();
    if (message !== undefined) return Promise.resolve(message);
    if (this.#closed) return Promise.reject(new Error('RawWsClient.next: the socket is closed'));
    return new Promise((resolve, reject) => {
      const waiter: MessageWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = this.#messageWaiters.indexOf(waiter);
          if (at >= 0) this.#messageWaiters.splice(at, 1);
          reject(new Error(`RawWsClient.next: timed out after ${String(timeoutMs)} ms`));
        }, timeoutMs),
      };
      this.#messageWaiters.push(waiter);
    });
  }

  /**
   * Waits until the binary data received so far (all binary frames joined, see `collected`) holds `needle`: a string or bytes
   * (searched as bytes) or a regular expression (searched in the UTF-8 text). Text frames are not consumed. Resolves with
   * `collected()`. Rejects after `timeoutMs` (default 10 s times `QA_TIME_SCALE`) or when the socket closes first.
   */
  until(needle: string | RegExp | Uint8Array, opts: { timeoutMs?: number } = {}): Promise<Buffer> {
    const timeoutMs = opts.timeoutMs ?? scaled(10_000);
    const matches = matcherOf(needle);
    const test = (): boolean => matches(this.collected());
    if (test()) return Promise.resolve(this.collected());
    if (this.#closed) return Promise.reject(new Error('RawWsClient.until: the socket is closed'));
    return new Promise((resolve, reject) => {
      const waiter: DataWaiter = {
        test,
        resolve: () => {
          resolve(this.collected());
        },
        reject,
        timer: setTimeout(() => {
          this.#dataWaiters.delete(waiter);
          reject(
            new Error(
              `RawWsClient.until: timed out after ${String(timeoutMs)} ms; ${String(this.collected().length)} bytes of data received`,
            ),
          );
        }, timeoutMs),
      };
      this.#dataWaiters.add(waiter);
    });
  }

  /** Every byte of the binary messages received so far, joined. */
  collected(): Buffer {
    if (this.#binary.length > 1) this.#binary = [Buffer.concat(this.#binary)];
    return this.#binary[0] ?? Buffer.alloc(0);
  }

  /** Forgets the binary data received so far, so that the next `until` sees only what arrives after. */
  clearCollected(): void {
    this.#binary = [];
  }

  /** The text messages received so far, parsed as JSON (a text that is not JSON stays a string). */
  texts(): unknown[] {
    return [...this.#texts];
  }

  /** The code and reason of the close frame the server sent (code 1005 for an empty one); null before one arrives. */
  closeInfo(): { code: number; reason: string } | null {
    return this.#closeInfo;
  }

  pauseReading(): void {
    this.#socket.pause();
  }

  resumeReading(): void {
    this.#socket.resume();
  }

  isClosed(): boolean {
    return this.#closed;
  }

  /** Resolves when the connection is closed (at once when it is). */
  waitClosed(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.#closedWaiters.push(resolve);
    });
  }

  /**
   * Sends a close frame with `code` (default 1000) and resolves when the connection is closed; when the server does not
   * close it within `graceMs` (default 5 s times `QA_TIME_SCALE`) the socket is destroyed.
   */
  async close(code = 1000, opts: { reason?: string; graceMs?: number } = {}): Promise<void> {
    if (this.#closed) return;
    if (!this.#closeSent) this.sendCloseFrame(code, opts.reason ?? '');
    const graceMs = opts.graceMs ?? scaled(5000);
    const timer = setTimeout(() => {
      this.#socket.destroy();
    }, graceMs);
    try {
      await this.waitClosed();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Closes the socket at once, without a close frame. */
  destroy(): void {
    this.#socket.destroy();
  }
}

export interface OpenedTerminalSocket {
  client: RawWsClient;
  /** The `ready` message of the server. */
  ready: { type: 'ready'; v: number; cols: number; rows: number; replayBytes: number; viewers: number };
  /** The binary data between `ready` and `live`. */
  replay: Buffer;
}

/**
 * Opens `GET /api/v3/terminal/sessions/<name>/socket` with the cookie, reads `ready`, then the replay up to `live`, and leaves
 * the socket open for live output. Throws (and closes the socket) when the upgrade is refused (the error names the status,
 * never the body), when the first message is not `ready` or when the socket closes before `live`.
 */
export async function openTerminalSocket(
  port: number,
  name: string,
  opts: { cookie: string; origin?: string },
): Promise<OpenedTerminalSocket> {
  const client = await RawWsClient.connect(port, {
    path: `/api/v3/terminal/sessions/${encodeURIComponent(name)}/socket`,
    cookie: opts.cookie,
    ...(opts.origin === undefined ? {} : { origin: opts.origin }),
  });
  try {
    if (client.status !== 101)
      throw new Error(`openTerminalSocket: the upgrade was refused with status ${String(client.status)}`);
    const first = await client.next();
    const ready = first.opcode === OP_TEXT ? readyOf(safeJson(first.payload.toString('utf8'))) : null;
    if (ready === null) throw new Error('openTerminalSocket: the first message of the server is not ready');
    const replay: Buffer[] = [];
    for (;;) {
      let message: WsMessage;
      try {
        message = await client.next();
      } catch {
        throw new Error('openTerminalSocket: the socket closed before live');
      }
      if (message.opcode === OP_BINARY) replay.push(message.payload);
      else if (message.opcode === OP_TEXT) {
        if (typeOf(safeJson(message.payload.toString('utf8'))) === 'live') break;
      } else if (message.opcode === OP_CLOSE) {
        throw new Error('openTerminalSocket: the socket closed before live');
      }
    }
    return { client, ready, replay: Buffer.concat(replay) };
  } catch (error) {
    client.destroy();
    throw error;
  }
}

/** A needle as a test of the data: bytes (string or Uint8Array) are searched as bytes, a regular expression in the UTF-8 text. */
function matcherOf(needle: string | RegExp | Uint8Array): (data: Buffer) => boolean {
  if (needle instanceof RegExp) {
    const pattern = new RegExp(needle.source, needle.flags.replace(/[gy]/g, ''));
    return (data) => pattern.test(data.toString('utf8'));
  }
  const bytes = typeof needle === 'string' ? Buffer.from(needle, 'utf8') : Buffer.from(needle);
  return (data) => data.includes(bytes);
}

function codeOf(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

/** The `type` of a parsed server text message, or null. */
function typeOf(value: unknown): string | null {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
    ? value.type
    : null;
}

function numberField(value: object, name: string): number | null {
  const field: unknown = Object.entries(value).find(([key]) => key === name)?.[1];
  return typeof field === 'number' ? field : null;
}

/** The `ready` message with its fields checked, or null when `value` is not one. */
function readyOf(value: unknown): OpenedTerminalSocket['ready'] | null {
  if (typeOf(value) !== 'ready' || typeof value !== 'object' || value === null) return null;
  const v = numberField(value, 'v');
  const cols = numberField(value, 'cols');
  const rows = numberField(value, 'rows');
  const replayBytes = numberField(value, 'replayBytes');
  const viewers = numberField(value, 'viewers');
  if (v === null || cols === null || rows === null || replayBytes === null || viewers === null) return null;
  return { type: 'ready', v, cols, rows, replayBytes, viewers };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
