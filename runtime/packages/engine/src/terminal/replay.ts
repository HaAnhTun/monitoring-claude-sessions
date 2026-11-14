// The replay buffer of a session and what is made of it at every attach (design 01 section 3.8). RAM only, never on disk.
// MTOP trimmed 256 KB of slack at an arbitrary byte, cutting UTF-8 characters and escape sequences; this buffer drops whole
// chunks, and `prepareReplay` restarts at a line boundary and removes the terminal queries of the snapshot.
import { REPLAY_FRAME_BYTES } from './limits.ts';

const ESC = 0x1b;
const BEL = 0x07;
const LF = 0x0a;
const LEFT_BRACKET = 0x5b;
const RIGHT_BRACKET = 0x5d;
const BACKSLASH = 0x5c;
const UPPER_P = 0x50;

/** A UTF-8 character has at most three continuation bytes after its start byte. */
const MAX_CONTINUATION_BYTES = 3;
/** `prepareReplay` looks for the first line feed only in this many bytes. */
const LINE_SEARCH_BYTES = 4096;
/** ESC [ 0 m: a colour run that the trim cut in half must not leak into the replay. */
const SGR_RESET = Buffer.from([ESC, LEFT_BRACKET, 0x30, 0x6d]);

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * The last output of a session, newest bytes kept. Chunk-granular: while the size is over the capacity the oldest whole
 * chunks go, so the size stays between the capacity minus one chunk (node-pty chunks are at most 8.3 KB) and the capacity.
 * After a trim the first byte is a UTF-8 start byte, so no character is cut.
 */
export class ReplayBuffer {
  readonly #capacity: number;
  #chunks: Buffer[] = [];
  #size = 0;
  #trimmed = false;

  constructor(capacityBytes: number) {
    if (!Number.isInteger(capacityBytes) || capacityBytes < 1) {
      throw new RangeError('The capacity of a replay buffer is a positive integer.');
    }
    this.#capacity = capacityBytes;
  }

  /** Bytes held now. */
  get size(): number {
    return this.#size;
  }

  /** True once output was dropped: the snapshot no longer starts at the beginning of the session. */
  get trimmed(): boolean {
    return this.#trimmed;
  }

  /** Keeps a copy of the chunk. A chunk larger than the capacity keeps only its tail, cut at a UTF-8 start byte. */
  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (chunk.length > this.#capacity) {
      this.#chunks = [Buffer.from(chunk.subarray(chunk.length - this.#capacity))];
      this.#size = this.#capacity;
      this.#trimmed = true;
      this.#alignHead();
      return;
    }
    this.#chunks.push(Buffer.from(chunk));
    this.#size += chunk.length;
    if (this.#size <= this.#capacity) return;
    let drop = 0;
    while (this.#size > this.#capacity && drop < this.#chunks.length) {
      this.#size -= this.#chunks[drop]?.length ?? 0;
      drop += 1;
    }
    this.#chunks = this.#chunks.slice(drop);
    this.#trimmed = true;
    this.#alignHead();
  }

  /** A copy of the bytes held. */
  snapshot(): Buffer {
    return Buffer.concat(this.#chunks, this.#size);
  }

  /** Releases the memory, as a session does when it ends. */
  clear(): void {
    this.#chunks = [];
    this.#size = 0;
    this.#trimmed = false;
  }

  /** Skips the stray continuation bytes of a character whose start byte was dropped (at most three, as in valid UTF-8). */
  #alignHead(): void {
    let skipped = 0;
    while (skipped < MAX_CONTINUATION_BYTES) {
      const head = this.#chunks[0];
      if (head === undefined) return;
      if (!isContinuationByte(head[0])) return;
      if (head.length === 1) this.#chunks.shift();
      else this.#chunks[0] = head.subarray(1);
      this.#size -= 1;
      skipped += 1;
    }
  }
}

/**
 * The bytes a viewer receives when it attaches. When the buffer was trimmed, the replay restarts just after the first line
 * feed within the first 4 KiB (when there is none, the snapshot stays as it is) and starts with `ESC [ 0 m`. Then the terminal
 * queries are removed, see `stripTerminalQueries`. The snapshot is not changed.
 */
export function prepareReplay(snapshot: Buffer, trimmed: boolean): Buffer {
  let bytes = snapshot;
  if (trimmed) {
    const lineFeed = bytes.subarray(0, LINE_SEARCH_BYTES).indexOf(LF);
    if (lineFeed !== -1) bytes = bytes.subarray(lineFeed + 1);
    bytes = Buffer.concat([SGR_RESET, stripTerminalQueries(bytes)]);
    return bytes;
  }
  return stripTerminalQueries(bytes);
}

// ---- terminal queries -------------------------------------------------------------------------------------------------
//
// The live `claude` TUI and ConPTY send queries that a terminal answers by writing a reply to the input. Replayed into a
// freshly attached xterm.js they make it answer again, and the answers (`ESC [ ? 1 ; 2 c`, `ESC [ 1 ; 1 R`) arrive in the
// prompt of `claude` as typed text. The live stream is never filtered: queries must reach the real terminal.

/** Where a scan resumes, and whether the sequence it looked at is a query to remove. */
interface Scan {
  end: number;
  query: boolean;
}

const MARKER_MIN = 0x3c; // < = > ?
const MARKER_MAX = 0x3f;
const QUESTION = 0x3f;
const GREATER = 0x3e;
const EQUALS = 0x3d;
const DOLLAR = 0x24;
const LOWER_Q = 0x71;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const SEMICOLON = 0x3b;
const COLON = 0x3a;

/** First parameters of `CSI Ps t` that ask the terminal to report something (xterm window operations 11 to 21). */
const WINDOW_REPORTS: ReadonlySet<number> = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);
/** `OSC Ps ; ... ; ? ST`: colour queries (4, 5, 10 to 19) and the clipboard query (52). */
const OSC_QUERY_NUMBERS: ReadonlySet<number> = new Set([4, 5, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 52]);

/** The number a run of decimal digits spells, or -1 for an empty run or a byte that is not a digit. */
function decimalValue(bytes: Buffer, start: number, end: number): number {
  if (start >= end || end - start > 6) return -1;
  let value = 0;
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte < DIGIT_ZERO || byte > DIGIT_NINE) return -1;
    value = value * 10 + (byte - DIGIT_ZERO);
  }
  return value;
}

/** True when every byte of the range is a digit, `;` or `:` (the parameter alphabet of CSI). */
function onlyParameterBytes(bytes: Buffer, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i] ?? 0;
    if ((byte < DIGIT_ZERO || byte > DIGIT_NINE) && byte !== SEMICOLON && byte !== COLON) return false;
  }
  return true;
}

/** Index of the first `;` or `:` in the range, or the end of it. */
function firstSeparator(bytes: Buffer, start: number, end: number): number {
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i];
    if (byte === SEMICOLON || byte === COLON) return i;
  }
  return end;
}

/** Classifies a complete CSI: parameter bytes in [pStart, pEnd), intermediate bytes in [iStart, iEnd), then the final byte. */
function isCsiQuery(bytes: Buffer, pStart: number, pEnd: number, iEnd: number, final: number): boolean {
  const first = bytes[pStart] ?? 0;
  const hasMarker = pStart < pEnd && first >= MARKER_MIN && first <= MARKER_MAX;
  const marker = hasMarker ? first : 0;
  const paramsStart = hasMarker ? pStart + 1 : pStart;
  if (!onlyParameterBytes(bytes, paramsStart, pEnd)) return false;
  const intermediates = iEnd - pEnd;
  switch (final) {
    case 0x63: // c: DA1 `CSI Ps c`, DA2 `CSI > Ps c`, DA3 `CSI = Ps c` (a `CSI ? ... c` is the reply, not the question)
      return intermediates === 0 && (marker === 0 || marker === GREATER || marker === EQUALS);
    case 0x6e: {
      // n: DSR `CSI 5 n` and `CSI 6 n`, DEC DSR `CSI ? Ps n` (a `CSI 0 n` is the reply)
      if (intermediates !== 0) return false;
      if (marker === QUESTION) return true;
      if (marker !== 0) return false;
      const ps = decimalValue(bytes, paramsStart, pEnd);
      return ps === 5 || ps === 6;
    }
    case 0x70: // p: DECRQM `CSI Ps $ p` and `CSI ? Ps $ p`
      return intermediates === 1 && bytes[pEnd] === DOLLAR && (marker === 0 || marker === QUESTION);
    case 0x75: // u: kitty keyboard flags query `CSI ? u` (`CSI ? 1 u` is the reply)
      return intermediates === 0 && marker === QUESTION && paramsStart === pEnd;
    case LOWER_Q: // q: XTVERSION `CSI > Ps q` (`CSI 2 SP q` sets the cursor style and is kept)
      return intermediates === 0 && marker === GREATER;
    case 0x74: {
      // t: window reports `CSI 11|13|14|15|16|18|19|20|21 [; Ps] t`
      if (intermediates !== 0 || marker !== 0) return false;
      const ps = decimalValue(bytes, paramsStart, firstSeparator(bytes, paramsStart, pEnd));
      return WINDOW_REPORTS.has(ps);
    }
    default:
      return false;
  }
}

/** `ESC [` at `esc`. A byte that cannot belong to a CSI ends the scan there, unconsumed: it may start the next sequence. */
function scanCsi(bytes: Buffer, esc: number, out: Scan): void {
  const n = bytes.length;
  const pStart = esc + 2;
  let p = pStart;
  while (p < n && (bytes[p] ?? 0) >= 0x30 && (bytes[p] ?? 0) <= 0x3f) p += 1;
  const pEnd = p;
  while (p < n && (bytes[p] ?? 0) >= 0x20 && (bytes[p] ?? 0) <= 0x2f) p += 1;
  out.query = false;
  if (p >= n) {
    out.end = n; // cut off: keep what there is
    return;
  }
  const final = bytes[p] ?? 0;
  if (final < 0x40 || final > 0x7e) {
    out.end = p;
    return;
  }
  out.end = p + 1;
  out.query = isCsiQuery(bytes, pStart, pEnd, p, final);
}

/** True when an OSC payload is a query: a known number and a field that is exactly `?`. */
function isOscQuery(bytes: Buffer, start: number, end: number): boolean {
  let semicolon = start;
  while (semicolon < end && bytes[semicolon] !== SEMICOLON) semicolon += 1;
  if (semicolon >= end || !OSC_QUERY_NUMBERS.has(decimalValue(bytes, start, semicolon))) return false;
  let field = semicolon + 1;
  for (let i = semicolon + 1; i <= end; i += 1) {
    if (i === end || bytes[i] === SEMICOLON) {
      if (i - field === 1 && bytes[field] === QUESTION) return true;
      field = i + 1;
    }
  }
  return false;
}

/** `ESC ]` at `esc`: ends at BEL or ST. A new ESC that is no ST ends the scan there, unconsumed (the terminal aborts the string). */
function scanOsc(bytes: Buffer, esc: number, out: Scan): void {
  const n = bytes.length;
  const start = esc + 2;
  out.query = false;
  for (let p = start; p < n; p += 1) {
    const byte = bytes[p];
    if (byte === BEL) {
      out.end = p + 1;
      out.query = isOscQuery(bytes, start, p);
      return;
    }
    if (byte === ESC) {
      if (p + 1 >= n) {
        out.end = n;
      } else if (bytes[p + 1] === BACKSLASH) {
        out.end = p + 2;
        out.query = isOscQuery(bytes, start, p);
      } else {
        out.end = p;
      }
      return;
    }
  }
  out.end = n;
}

/** `ESC P` at `esc`: only DECRQSS (`DCS $ q Pt ST`) is a query. Any other DCS is kept; its body is plain bytes to this scan. */
function scanDcs(bytes: Buffer, esc: number, out: Scan): void {
  const n = bytes.length;
  const start = esc + 2;
  out.query = false;
  const next = bytes.indexOf(ESC, start);
  if (next === -1 || next + 1 >= n) {
    out.end = n;
  } else if (bytes[next + 1] === BACKSLASH) {
    out.end = next + 2;
    out.query = next - start >= 2 && bytes[start] === DOLLAR && bytes[start + 1] === LOWER_Q;
  } else {
    out.end = next;
  }
}

/**
 * Removes the sequences that make a terminal answer: DA1, DA2 and DA3 (`CSI c`, `CSI > c`, `CSI = c`), DSR (`CSI 5 n`,
 * `CSI 6 n`, `CSI ? Ps n`), DECRQM (`CSI ? Ps $ p`, `CSI Ps $ p`), the kitty keyboard query (`CSI ? u`), XTVERSION
 * (`CSI > q`), the window reports (`CSI 11 t` to `CSI 21 t`), OSC colour and clipboard queries (`OSC Ps ; ? BEL|ST`) and
 * DECRQSS (`DCS $ q ... ST`). Every sequence that sets state or draws is kept, and so is a sequence that is cut off or broken
 * (a terminal would not answer it either). Only the 7-bit forms (ESC and a letter) are read.
 *
 * One pass over the bytes, never a regular expression over the buffer: this runs over up to 1 MiB at every attach in the process
 * that hosts all sessions, and an adversarial snapshot (`ESC [` a million times, an OSC that never ends) must cost time linear
 * in its size. A scan that fails resumes at the byte that stopped it, so no byte is scanned twice. The input is not changed;
 * when there is nothing to remove, the same Buffer comes back.
 */
export function stripTerminalQueries(bytes: Buffer): Buffer {
  const parts: Buffer[] = [];
  const scan: Scan = { end: 0, query: false };
  let copyFrom = 0;
  let i = bytes.indexOf(ESC);
  while (i !== -1 && i + 1 < bytes.length) {
    const introducer = bytes[i + 1];
    if (introducer === LEFT_BRACKET) scanCsi(bytes, i, scan);
    else if (introducer === RIGHT_BRACKET) scanOsc(bytes, i, scan);
    else if (introducer === UPPER_P) scanDcs(bytes, i, scan);
    else {
      i = bytes.indexOf(ESC, i + 1);
      continue;
    }
    if (scan.query) {
      if (i > copyFrom) parts.push(bytes.subarray(copyFrom, i));
      copyFrom = scan.end;
    }
    i = bytes.indexOf(ESC, scan.end);
  }
  if (parts.length === 0 && copyFrom === 0) return bytes;
  parts.push(bytes.subarray(copyFrom));
  return Buffer.concat(parts);
}

/**
 * The replay in frames of at most `maxFrame` bytes (default and cap: 65,536). A frame is a view into `bytes`. Frames may split
 * a character or an escape sequence: xterm.js keeps the unfinished part of its input between writes.
 */
export function* replayFrames(bytes: Buffer, maxFrame: number = REPLAY_FRAME_BYTES): Generator<Buffer> {
  if (!Number.isInteger(maxFrame) || maxFrame < 1) throw new RangeError('A replay frame holds at least one byte.');
  const size = Math.min(maxFrame, REPLAY_FRAME_BYTES);
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}
