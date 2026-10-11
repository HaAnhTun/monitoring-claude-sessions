// Splits a byte stream into JSONL lines (02 5.3). Lines are cut on byte 0x0A BEFORE any decoding, so a multi-byte UTF-8
// character is never split (0x0A cannot occur inside one). One trailing CR and a BOM at offset 0 are stripped, empty
// lines are skipped, invalid UTF-8 is counted, and a line over the cap is skipped without being accumulated.
import { isUtf8 } from 'node:buffer';

const LF = 0x0a;
const CR = 0x0d;

/** What a read saw besides the lines it returned (02 5.3 `TailCounters`). */
export interface TailCounters {
  bomStripped: number;
  crlfLines: number;
  oversized: number;
  utf8Invalid: number;
}

export function emptyCounters(): TailCounters {
  return { bomStripped: 0, crlfLines: 0, oversized: 0, utf8Invalid: 0 };
}

/**
 * One line of content. `offset` is the first byte of the content (after a BOM at offset 0) and `length` the byte count
 * without LF, trailing CR and BOM, so `[offset, offset + length)` is exactly `bytes` and a later `readEntryText` can
 * parse it as it is. `lineNo` is 1-based and counts every LF-terminated segment the reader walked, empty ones included.
 */
export interface RawLine {
  offset: number;
  length: number;
  lineNo: number;
  bytes: Buffer;
}

export interface SplitterOptions {
  /** Absolute offset of the first byte that will be pushed (a line start). */
  from: number;
  /** Number of the line that starts at `from`. */
  firstLineNo: number;
  /** A line longer than this many bytes (without its LF) is skipped and counted. */
  maxLineBytes: number;
  /**
   * The bytes at `from` continue an oversized line that an earlier read already began to skip (`skipping` of its result):
   * they are dropped up to the next LF without being accumulated or read twice.
   */
  skipping?: boolean;
}

/** True when the three bytes at the start of `bytes` are a UTF-8 byte order mark. */
function hasBom(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

export class LineSplitter {
  readonly counters: TailCounters = emptyCounters();
  readonly #maxLineBytes: number;
  #parts: Buffer[] = [];
  #pendingLen = 0;
  #lineStart: number;
  #lineNo: number;
  #skipping = false;

  constructor(opts: SplitterOptions) {
    this.#maxLineBytes = opts.maxLineBytes;
    this.#lineStart = opts.from;
    this.#lineNo = opts.firstLineNo;
    this.#skipping = opts.skipping ?? false;
  }

  /** True while the bytes of an oversized line are being dropped; the line has no LF yet. */
  get skipping(): boolean {
    return this.#skipping;
  }

  /** Offset where the next (possibly incomplete) line starts: every byte before it is consumed. */
  get lineStart(): number {
    return this.#lineStart;
  }

  /** Number of the line that starts at `lineStart`. */
  get nextLineNo(): number {
    return this.#lineNo;
  }

  /** Bytes of the incomplete line held back (0 while an oversized line is being skipped). */
  get pendingBytes(): number {
    return this.#pendingLen;
  }

  /**
   * Adds the bytes at `chunkStart` (which must continue the previous chunk) and appends the finished lines to `out`.
   * `stop` is asked after every finished line; when it answers true the rest of the chunk is left unread, `lineStart`
   * names the next unread line and the method returns true.
   */
  push(chunk: Buffer, chunkStart: number, stop: () => boolean, out: RawLine[]): boolean {
    let from = 0;
    for (;;) {
      const lf = chunk.indexOf(LF, from);
      if (lf < 0) {
        this.#hold(chunk.subarray(from));
        return false;
      }
      const lineEnd = chunkStart + lf + 1;
      if (this.#skipping) {
        this.#skipping = false;
        this.counters.oversized += 1;
        this.#advance(lineEnd);
      } else {
        const body =
          this.#parts.length === 0
            ? chunk.subarray(from, lf)
            : Buffer.concat([...this.#parts, chunk.subarray(from, lf)]);
        this.#parts = [];
        this.#pendingLen = 0;
        if (body.length > this.#maxLineBytes) {
          this.counters.oversized += 1;
        } else {
          const line = this.#finish(body);
          if (line !== null) out.push(line);
        }
        this.#advance(lineEnd);
      }
      from = lf + 1;
      if (stop()) return true;
    }
  }

  /**
   * The bytes of the incomplete line (null when there are none, or when the line is being skipped for its length).
   * Does not consume them: the caller decides what to do with an unterminated tail.
   */
  takeUnterminated(): Buffer | null {
    if (this.#skipping || this.#pendingLen === 0) return null;
    return Buffer.concat(this.#parts);
  }

  /** Turns the bytes of an unterminated tail into a line (CR and BOM rules apply) and moves the cursor past them. */
  acceptTail(bytes: Buffer): RawLine | null {
    const line = this.#finish(bytes);
    this.#parts = [];
    this.#pendingLen = 0;
    this.#advance(this.#lineStart + bytes.length);
    return line;
  }

  #hold(rest: Buffer): void {
    if (this.#skipping || rest.length === 0) return;
    this.#parts.push(rest);
    this.#pendingLen += rest.length;
    if (this.#pendingLen > this.#maxLineBytes) {
      // the line can no longer fit: forget what was held and skip to its LF without accumulating
      this.#skipping = true;
      this.#parts = [];
      this.#pendingLen = 0;
    }
  }

  #advance(nextLineStart: number): void {
    this.#lineStart = nextLineStart;
    this.#lineNo += 1;
  }

  /** CR and BOM stripping, the empty-line rule and the UTF-8 count for one finished line. */
  #finish(raw: Buffer): RawLine | null {
    let content = raw;
    let offset = this.#lineStart;
    let crStripped = false;
    if (content.length > 0 && content[content.length - 1] === CR) {
      content = content.subarray(0, content.length - 1);
      crStripped = true;
    }
    let bomStripped = false;
    if (offset === 0 && hasBom(content)) {
      content = content.subarray(3);
      offset += 3;
      bomStripped = true;
    }
    if (content.length === 0) return null;
    if (crStripped) this.counters.crlfLines += 1;
    if (bomStripped) this.counters.bomStripped += 1;
    if (!isUtf8(content)) this.counters.utf8Invalid += 1;
    return { offset, length: content.length, lineNo: this.#lineNo, bytes: content };
  }
}
