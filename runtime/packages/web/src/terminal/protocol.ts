// The browser side of the terminal protocol v1 (ADR 0098, design 04 7.2): the constants, the URL of the socket, how typed text
// and a size become frames, how a text frame of the server is read, and what each close code means for the view. Pure: no
// React, no socket, no clock. The socket itself is `ws-client.ts`, the only file that opens a `WebSocket`.
import {
  buildPath,
  clampTerminalSize,
  routes,
  TERMINAL_CLOSE_CODES,
  TerminalServerMessageSchema,
  type TerminalServerMessage,
} from '@mcs/shared';

/** The way out of the terminal (WCAG 2.1.2): one key cap text, shown next to the pane and in the shortcuts dialog. */
export const RELEASE_CHORD = 'Ctrl+Shift+Space';

/** The most bytes one input frame carries. The server accepts 256 KiB; a smaller frame keeps one paste from holding the socket. */
export const MAX_INPUT_FRAME_BYTES = 16_384;

/** The trailing debounce of the fit after the pane changed size. */
export const FIT_DEBOUNCE_MS = 100;

/** The longest wait between two reconnect attempts of the socket. */
export const RECONNECT_CAP_MS = 15_000;

/**
 * The longest text frame of the server that is read at all. The largest real one (`ready`, or `exit` with a signal name) is under
 * 200 characters; a longer one is not a protocol frame, so it is counted as invalid and never parsed.
 */
export const MAX_CONTROL_FRAME_CHARS = 1024;

/** The part of `window.location` that decides the address of the socket. */
export interface LocationLike {
  readonly protocol: string;
  readonly host: string;
}

/** The part of `document` the clients watch: whether the tab is hidden, and when that changes. */
export interface VisibilityLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

/**
 * The address of the socket of one session: `ws` for an `http` page and `wss` for an `https` page, on the host of the page. It has
 * no query and no credential: the session cookie of the page travels with the handshake. A name that is not a session name, or a
 * page that is not served over http or https, is a programming error (the name was read from the address bar through the codec
 * of the page, which refuses it first); the message never repeats the name.
 */
export function terminalSocketUrl(name: string, location: LocationLike): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : location.protocol === 'http:' ? 'ws:' : null;
  if (scheme === null) throw new TypeError('The terminal socket needs a page served over http or https');
  return `${scheme}//${location.host}${buildPath(routes.terminalSocket, { name })}`;
}

const encoder = new TextEncoder();

/** The bit pattern of a UTF-8 continuation byte (`10xxxxxx`): a frame may not start with one. */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * Raw bytes in frames of at most `MAX_INPUT_FRAME_BYTES`, in order. The frames are views of the one buffer. Raw bytes may be cut
 * anywhere: the server writes every frame to the process unchanged and in order.
 */
export function chunkBytes(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let at = 0; at < bytes.length; at += MAX_INPUT_FRAME_BYTES) {
    frames.push(bytes.subarray(at, Math.min(bytes.length, at + MAX_INPUT_FRAME_BYTES)));
  }
  return frames;
}

/**
 * Typed or pasted text as the binary frames of the socket: its UTF-8 bytes, cut into frames of at most `MAX_INPUT_FRAME_BYTES`
 * that end at a code point boundary (a frame never starts or ends inside a character, so each one is valid UTF-8 on its own). A
 * lone surrogate is sent as U+FFFD, as the encoder writes it. No text, no frame.
 */
export function encodeInput(data: string): Uint8Array<ArrayBuffer>[] {
  const bytes = encoder.encode(data);
  const frames: Uint8Array<ArrayBuffer>[] = [];
  let at = 0;
  while (at < bytes.length) {
    let end = Math.min(bytes.length, at + MAX_INPUT_FRAME_BYTES);
    // a character is at most four bytes, so this stops long before `at`
    while (end < bytes.length && isContinuation(bytes[end] ?? 0)) end -= 1;
    frames.push(bytes.subarray(at, end));
    at = end;
  }
  return frames;
}

/** The one text frame a client sends: its size, clamped to the limits of the terminal first. */
export function encodeResize(cols: number, rows: number): string {
  const size = clampTerminalSize(cols, rows);
  return JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows });
}

/**
 * A text frame of the server: `ready`, `live`, `size` or `exit`. Anything else (text that is not JSON, a frame of another shape,
 * an extra key, a frame over the size cap) is `null`: the caller counts it and ignores it. Text is never terminal output, so an
 * invalid frame is never written to the terminal. Never throws.
 */
export function parseServerFrame(text: string): TerminalServerMessage | null {
  if (text.length > MAX_CONTROL_FRAME_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = TerminalServerMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * What a close of the socket means for the view:
 * - `end`: the session is over (4000 exited, 4001 killed) or the connection was left on purpose (1000);
 * - `locked`: the credential ended (4003), the page shows the locked state;
 * - `fail`: a bug of ours (1002 protocol error, 1007 not UTF-8, 1008 bad message, 1009 too big): the view says "failed" with Retry,
 *   because a reconnect would repeat it;
 * - `reconnect`: everything else (1001 shutting down, 1006 no status, 1011 internal error, 1013 slow consumer, and any code the
 *   table does not know). The replay rebuilds the screen, and the session list says whether the session is gone.
 */
export type ClosePolicy = 'end' | 'locked' | 'reconnect' | 'fail';

export function closePolicy(code: number): ClosePolicy {
  switch (code) {
    case TERMINAL_CLOSE_CODES.normal:
    case TERMINAL_CLOSE_CODES.exited:
    case TERMINAL_CLOSE_CODES.killed:
      return 'end';
    case TERMINAL_CLOSE_CODES.signedOut:
      return 'locked';
    case TERMINAL_CLOSE_CODES.protocolError:
    case 1007:
    case TERMINAL_CLOSE_CODES.badMessage:
    case TERMINAL_CLOSE_CODES.tooBig:
      return 'fail';
    default:
      return 'reconnect';
  }
}
