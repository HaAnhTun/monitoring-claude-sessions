// A scripted WebSocket for the terminal client tests (happy-dom has none, ADR 0098). The test drives it with `open()`, `message()`,
// `closeFromServer()` and `error()`; the client under test sees what a browser would deliver: a binary frame is an `ArrayBuffer`
// only when the client asked for `binaryType = 'arraybuffer'` (otherwise a `Blob`, which a client that forgot the setting would
// not understand), `send()` while connecting throws and while closing or closed drops the data silently as the real one does, and
// nothing is delivered after `close()`.
// Not part of the app bundle; only tests import it. The class can also stand in for the global (`stubFakeWebSocketGlobal`).
import { vi } from 'vitest';

import type { WebSocketLike } from '../terminal/ws-client.ts';

export const FAKE_WS_CONNECTING = 0;
export const FAKE_WS_OPEN = 1;
export const FAKE_WS_CLOSING = 2;
export const FAKE_WS_CLOSED = 3;

/** What a client sent, kept in order: a text frame as its text, a binary frame as a copy of its bytes. */
export type SentFrame = { kind: 'text'; text: string } | { kind: 'binary'; bytes: Uint8Array };

export interface CloseCall {
  code: number | undefined;
  reason: string | undefined;
}

export class FakeWebSocket implements WebSocketLike {
  readyState: number = FAKE_WS_CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readonly url: string;
  readonly protocols: readonly string[];
  readonly sent: SentFrame[] = [];
  /** Every `close()` call of the client, with its arguments. */
  readonly closeCalls: CloseCall[] = [];

  constructor(url: string, protocols: string | readonly string[] = []) {
    this.url = url;
    this.protocols = typeof protocols === 'string' ? [protocols] : [...protocols];
  }

  /**
   * As the browser (WebSocket standard, `send()`): CONNECTING throws an `InvalidStateError`; OPEN sends; CLOSING and CLOSED drop the
   * data without an error (a real socket only counts it in `bufferedAmount`). A client that does not look at `readyState` itself
   * therefore loses the frame silently, and a test sees it in `sent`.
   */
  send(data: string | Uint8Array): void {
    if (this.readyState === FAKE_WS_CONNECTING) throw new Error('InvalidStateError: the socket is still connecting');
    if (this.readyState !== FAKE_WS_OPEN) return;
    if (typeof data === 'string') this.sent.push({ kind: 'text', text: data });
    else this.sent.push({ kind: 'binary', bytes: Uint8Array.from(data) });
  }

  /** As the browser: the closing handshake starts, no further event reaches the client's handlers unless the test sends one. */
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FAKE_WS_CLOSED;
  }

  get closed(): boolean {
    return this.readyState === FAKE_WS_CLOSED;
  }

  /** The text of every text frame sent, in order. */
  get sentText(): string[] {
    return this.sent.flatMap((frame) => (frame.kind === 'text' ? [frame.text] : []));
  }

  /** The bytes of every binary frame sent, in order. */
  get sentBinary(): Uint8Array[] {
    return this.sent.flatMap((frame) => (frame.kind === 'binary' ? [frame.bytes] : []));
  }

  /** The handshake succeeded. */
  open(): void {
    if (this.closed) return;
    this.readyState = FAKE_WS_OPEN;
    this.onopen?.(new Event('open'));
  }

  /**
   * The server sent a frame. A string is a text frame, an object a text frame of its JSON (a protocol message), bytes a binary
   * frame. A closed socket delivers nothing, as a browser does, unless `force` is set (to prove the client ignores late frames).
   */
  message(data: string | Uint8Array | ArrayBuffer | object, options: { force?: boolean } = {}): void {
    if (this.closed && options.force !== true) return;
    let payload: string | ArrayBuffer | Blob;
    if (typeof data === 'string') payload = data;
    else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      const bytes = data instanceof Uint8Array ? Uint8Array.from(data) : new Uint8Array(data.slice(0));
      payload = this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);
    } else payload = JSON.stringify(data);
    this.onmessage?.(new MessageEvent('message', { data: payload }));
  }

  /** The connection ended with `code`, from the server or the network (1006 is what a browser reports for a refused handshake). */
  closeFromServer(code: number, reason = '', options: { force?: boolean } = {}): void {
    if (this.closed && options.force !== true) return;
    this.readyState = FAKE_WS_CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean: code !== 1006 }));
  }

  /** The browser's `error` event (it always precedes the close of a failed connection). */
  error(options: { force?: boolean } = {}): void {
    if (this.closed && options.force !== true) return;
    this.onerror?.(new Event('error'));
  }
}

export interface FakeWebSockets {
  /** The `factory` to pass to the client. */
  factory: (url: string, protocols: readonly string[]) => FakeWebSocket;
  readonly instances: FakeWebSocket[];
  /** The most recently created socket; throws before the first one (a test bug, not a client state). */
  last(): FakeWebSocket;
  urls(): string[];
}

export function createFakeWebSockets(): FakeWebSockets {
  const instances: FakeWebSocket[] = [];
  return {
    factory(url, protocols) {
      const socket = new FakeWebSocket(url, protocols);
      instances.push(socket);
      return socket;
    },
    instances,
    last() {
      const socket = instances.at(-1);
      if (socket === undefined) throw new Error('no WebSocket was created yet');
      return socket;
    },
    urls() {
      return instances.map((socket) => socket.url);
    },
  };
}

/** Replaces the global `WebSocket` for the current test (Vitest restores it: `unstubGlobals`) and records every instance. */
export function stubFakeWebSocketGlobal(): FakeWebSockets {
  const registry = createFakeWebSockets();
  class StubbedWebSocket extends FakeWebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols);
      registry.instances.push(this);
    }
  }
  vi.stubGlobal('WebSocket', StubbedWebSocket);
  return registry;
}
