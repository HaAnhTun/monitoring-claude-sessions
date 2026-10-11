// The incremental JSONL reader shared by the spool and the transcripts (02 5.3, ADR 0015).
//
// `readLines` reads one slice of a byte range and returns whole lines only: the offset it hands back is always the start
// of a line, so a record that is still being written is never half consumed (the CCAM torn-line loss, CC:13).
// `checkIdentity` (file-identity.ts) tells the caller when the bytes behind its cursors are gone. `JsonlTailer` wraps
// both for one file with a single cursor, which is all the spool and the tests need; the importer keeps three cursors
// per transcript and calls the two functions itself.
import { open, type FileHandle } from 'node:fs/promises';

import { MAX_LINE_BYTES } from '@mcs/shared/protocol';

import {
  IDENTITY_HEAD_BYTES,
  checkIdentity,
  classifyFsError,
  errorCodeOf,
  readIdentity,
  type FileIdentity,
} from './file-identity.ts';
import { LineSplitter, type RawLine, type TailCounters } from './line-splitter.ts';

export { checkIdentity, readIdentity, type FileIdentity, type IdentityCheck } from './file-identity.ts';
export type { RawLine, TailCounters } from './line-splitter.ts';

export interface ReadOptions {
  /** Bytes read per call to the file system (production: 1 MiB). */
  chunkBytes: number;
  /** Cap of one line; default `MAX_LINE_BYTES`. Tests and the chain-log reader pass a smaller one. */
  maxLineBytes?: number;
  /** Transcripts: a complete JSON object without its LF is consumed. The spool: never. */
  acceptValidUnterminatedTail: boolean;
  /** Number of the line at `from` (default 1); lets a caller that knows it keep `lineNo` exact. */
  firstLineNo?: number;
  /** Continue skipping an oversized line begun by the previous call (`ReadResult.skipping`); `from` is then mid-line. */
  resumeSkip?: boolean;
  /**
   * Stop after the line that brings the bytes consumed by this call to this many or more (default: no limit). The deadline
   * only sees the time spent splitting; a caller that parses the lines it gets back passes a limit of about one chunk so a
   * slice cannot return megabytes of lines to parse in one go (T-TR-11).
   */
  sliceBytes?: number;
}

export interface ReadResult {
  lines: RawLine[];
  /**
   * Where to continue: the start of a line (or the end of a consumed unterminated tail). While `skipping` is true it is
   * the end of the bytes read so far, inside an oversized line that has no LF yet.
   */
  nextOffset: number;
  /** Number of the line at `nextOffset` (an addition to the registry shape, so `lineNo` can continue across calls). */
  nextLineNo: number;
  /**
   * True when the range ended inside an oversized line that is still being written. The skipped bytes are consumed:
   * the caller continues at `nextOffset` with `resumeSkip: true`, so a growing line of up to 64 MiB is read once, not
   * once per poll.
   */
  skipping: boolean;
  /** Bytes of an unterminated tail that were left unconsumed. */
  partialBytes: number;
  /** True when the whole range was read; false when the deadline stopped the slice. */
  eof: boolean;
  counters: TailCounters;
}

function isJsonObject(bytes: Buffer): boolean {
  let text = bytes.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function checkRange(from: number, to: number, opts: ReadOptions): number {
  if (!Number.isSafeInteger(from) || from < 0) throw new RangeError(`readLines: bad start offset ${String(from)}`);
  if (!Number.isSafeInteger(to) || to < from) throw new RangeError(`readLines: bad end offset ${String(to)}`);
  if (opts.sliceBytes !== undefined && !(opts.sliceBytes >= 1)) {
    throw new RangeError(`readLines: bad slice size ${String(opts.sliceBytes)}`);
  }
  if (!Number.isSafeInteger(opts.chunkBytes) || opts.chunkBytes < 1) {
    throw new RangeError(`readLines: bad chunk size ${String(opts.chunkBytes)}`);
  }
  const cap = opts.maxLineBytes ?? MAX_LINE_BYTES;
  if (!Number.isSafeInteger(cap) || cap < 1) throw new RangeError(`readLines: bad line cap ${String(cap)}`);
  return cap;
}

/**
 * One slice of `[from, to)` (02 5.3): complete lines in file order, stopping after the line that makes
 * `performance.now() >= deadline` true. At least one line is processed per call, so a caller always progresses.
 * File system errors (a file that vanished) reject; the caller classifies them with `classifyFsError`.
 */
export async function readLines(
  path: string,
  from: number,
  to: number,
  deadline: number,
  opts: ReadOptions,
): Promise<ReadResult> {
  const maxLineBytes = checkRange(from, to, opts);
  const splitter = new LineSplitter({
    from,
    firstLineNo: opts.firstLineNo ?? 1,
    maxLineBytes,
    skipping: opts.resumeSkip ?? false,
  });
  const lines: RawLine[] = [];
  const sliceBytes = opts.sliceBytes ?? Number.POSITIVE_INFINITY;
  const timeUp = (): boolean => performance.now() >= deadline || splitter.lineStart - from >= sliceBytes;
  let pos = from;
  let stopped = false;
  if (from < to) {
    const handle = await open(path, 'r');
    try {
      while (pos < to) {
        const want = Math.min(opts.chunkBytes, to - pos);
        const buffer = Buffer.allocUnsafe(want);
        const { bytesRead } = await handle.read(buffer, 0, want, pos);
        if (bytesRead === 0) break; // the file is shorter than `to`: truncated while reading
        stopped = splitter.push(buffer.subarray(0, bytesRead), pos, timeUp, lines);
        pos += bytesRead;
        if (stopped) break;
      }
    } finally {
      await handle.close();
    }
  }
  // A stop on the very last line of the range leaves nothing unread: that is the end, not an interruption.
  if (stopped && pos >= to && splitter.lineStart >= pos) stopped = false;
  if (stopped) {
    return {
      lines,
      nextOffset: splitter.lineStart,
      nextLineNo: splitter.nextLineNo,
      skipping: false,
      partialBytes: 0,
      eof: false,
      counters: splitter.counters,
    };
  }
  const tail = splitter.takeUnterminated();
  if (tail !== null && opts.acceptValidUnterminatedTail && isJsonObject(tail)) {
    const line = splitter.acceptTail(tail);
    if (line !== null) lines.push(line);
    return {
      lines,
      nextOffset: splitter.lineStart,
      nextLineNo: splitter.nextLineNo,
      skipping: false,
      partialBytes: 0,
      eof: true,
      counters: splitter.counters,
    };
  }
  if (splitter.skipping) {
    return {
      lines,
      nextOffset: pos,
      nextLineNo: splitter.nextLineNo,
      skipping: true,
      partialBytes: 0,
      eof: true,
      counters: splitter.counters,
    };
  }
  return {
    lines,
    nextOffset: splitter.lineStart,
    nextLineNo: splitter.nextLineNo,
    skipping: false,
    partialBytes: pos - splitter.lineStart,
    eof: true,
    counters: splitter.counters,
  };
}

/**
 * Aligns `pos` forward to the start of a line (legacy `_line_start`): the line that contains `pos` is only partly inside a
 * window, so the window starts at the next line. Returns the file size when no LF follows, and `pos` when the file cannot
 * be read.
 */
export async function lineStartAtOrAfter(path: string, pos: number): Promise<number> {
  if (pos <= 0) return 0;
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    return pos;
  }
  try {
    const buffer = Buffer.allocUnsafe(65_536);
    let at = pos - 1;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
      if (bytesRead === 0) return (await handle.stat()).size;
      const lf = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (lf >= 0) return at + lf + 1;
      at += bytesRead;
    }
  } catch {
    return pos;
  } finally {
    await handle.close();
  }
}

// ---- JsonlTailer: one cursor over one file ------------------------------------------------------------------------

export interface JsonlTailerOptions {
  path: string;
  /** Default 1 MiB. */
  chunkBytes?: number;
  maxLineBytes?: number;
  acceptValidUnterminatedTail: boolean;
}

/** Everything a tailer needs to continue after a restart; the caller persists it with the rows derived from the bytes. */
export interface TailerState {
  /** Start of the first line not yet consumed. */
  offset: number;
  /** Number of the line at `offset` (the line being skipped while `skipping`). */
  lineNo: number;
  /** True when `offset` is inside an oversized line that has no LF yet (see `ReadResult.skipping`). */
  skipping: boolean;
  /** Size seen at the last successful poll. */
  size: number;
  mtimeMs: number | null;
  identity: FileIdentity | null;
}

export type TailPoll =
  | { status: 'missing' }
  | { status: 'unreadable'; code: string }
  | {
      status: 'ok';
      /** Set when the file was truncated or replaced: the per-file rows are stale and `lines` start again at offset 0. */
      reset: 'truncated' | 'replaced' | null;
      lines: RawLine[];
      partialBytes: number;
      eof: boolean;
      counters: TailCounters;
    };

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

export class JsonlTailer {
  readonly #opts: JsonlTailerOptions;
  #state: TailerState;

  constructor(opts: JsonlTailerOptions, state: Partial<TailerState> = {}) {
    this.#opts = opts;
    this.#state = {
      offset: state.offset ?? 0,
      lineNo: state.lineNo ?? 1,
      skipping: state.skipping ?? false,
      size: state.size ?? 0,
      mtimeMs: state.mtimeMs ?? null,
      identity: state.identity ?? null,
    };
  }

  get state(): Readonly<TailerState> {
    return { ...this.#state };
  }

  /**
   * Checks the identity, then reads from the cursor to the size seen now, until `deadline` (a `performance.now()` value).
   * The state moves only when the whole poll succeeded; `missing` and `unreadable` leave every cursor where it was.
   */
  async poll(deadline: number = Number.POSITIVE_INFINITY): Promise<TailPoll> {
    const { path } = this.#opts;
    const before = this.#state;
    const check = await checkIdentity(path, before.identity, before.size, before.offset, before.mtimeMs);
    if (check.kind === 'missing') return { status: 'missing' };
    if (check.kind === 'unreadable') return { status: 'unreadable', code: check.code };

    const reset = check.kind === 'reset' ? check.reason : null;
    let identity = reset === null ? before.identity : null;
    const size = Number(check.stat.size);
    try {
      if (identity === null || (identity.headLen < IDENTITY_HEAD_BYTES && size > identity.headLen)) {
        identity = await readIdentity(path, check.stat);
      }
      const from = reset === null ? before.offset : 0;
      const result = await readLines(path, from, size, deadline, {
        chunkBytes: this.#opts.chunkBytes ?? DEFAULT_CHUNK_BYTES,
        acceptValidUnterminatedTail: this.#opts.acceptValidUnterminatedTail,
        firstLineNo: reset === null ? before.lineNo : 1,
        resumeSkip: reset === null && before.skipping,
        ...(this.#opts.maxLineBytes === undefined ? {} : { maxLineBytes: this.#opts.maxLineBytes }),
      });
      this.#state = {
        offset: result.nextOffset,
        lineNo: result.nextLineNo,
        skipping: result.skipping,
        size,
        mtimeMs: Number(check.stat.mtimeMs),
        identity,
      };
      return {
        status: 'ok',
        reset,
        lines: result.lines,
        partialBytes: result.partialBytes,
        eof: result.eof,
        counters: result.counters,
      };
    } catch (error) {
      const code = errorCodeOf(error);
      return classifyFsError(code) === 'missing' ? { status: 'missing' } : { status: 'unreadable', code };
    }
  }
}
