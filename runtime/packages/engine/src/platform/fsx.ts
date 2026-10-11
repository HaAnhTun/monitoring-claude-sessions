// The one file-I/O module of the engine for atomic replace and short read-and-close reads (06 4.3, 3.9.1, ADR 0058).
// Bytes in, bytes out: nothing here serializes or re-encodes. Workspace rules (links, PyJson, universal newlines) are
// added by 01's workspace/fsio.ts, which wraps these functions.
import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { setTimeout as sleepMs } from 'node:timers/promises';

export interface AtomicWriteOptions {
  /** How long to keep retrying a sharing violation (default 3000 ms). */
  budgetMs?: number;
  /** Permission bits of the new file (default 0o644, ignored on Windows). */
  mode?: number;
}

export class AtomicWriteError extends Error {
  readonly code: 'E_ATOMIC_WRITE_BUSY' | 'E_ATOMIC_WRITE_IO';
  readonly path: string;

  constructor(code: 'E_ATOMIC_WRITE_BUSY' | 'E_ATOMIC_WRITE_IO', file: string, cause?: unknown) {
    super(
      code === 'E_ATOMIC_WRITE_BUSY'
        ? `${file} is held open by another program; the replace gave up after retrying`
        : `could not write ${file}: ${describeCause(cause)}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'AtomicWriteError';
    this.code = code;
    this.path = file;
  }
}

export class SmallFileError extends Error {
  readonly code: 'E_FILE_TOO_LARGE' | 'E_FILE_BUSY';
  readonly path: string;

  constructor(code: 'E_FILE_TOO_LARGE' | 'E_FILE_BUSY', file: string, cause?: unknown) {
    super(
      code === 'E_FILE_TOO_LARGE' ? `${file} is larger than the allowed size` : `${file} stayed busy while it was read`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'SmallFileError';
    this.code = code;
    this.path = file;
  }
}

/** The part of a file handle these functions use; tests pass a stub. */
export interface FsxFile {
  stat(): Promise<{ size: number }>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  writeAll(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Everything the functions need from the outside world (file system, time, process id). */
export interface FsxDeps {
  open(file: string, flags: string, mode?: number): Promise<FsxFile>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** A monotonic clock in ms (budgets are measured with it). */
  now(): number;
  pid: number;
}

const DEFAULT_BUDGET_MS = 3000;
const REPLACE_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const READ_RETRIES = 10;
const READ_RETRY_DELAY_MS = 20;
const TAIL_QUIET_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'EISDIR', 'EPERM']);
const MIN_TAIL_WINDOW = 65_536;
const TAIL_BYTES_PER_LINE = 400;
const READ_CHUNK = 65_536;
/** However many lines are asked for, `tailLines` never reads more than this from the end of a file. */
const MAX_TAIL_WINDOW = 64 * 1024 * 1024;

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

function describeCause(cause: unknown): string {
  const code = errorCode(cause);
  if (code !== undefined) return code;
  return cause instanceof Error ? cause.name : 'unknown error';
}

function isReplaceBusy(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && REPLACE_RETRY_CODES.has(code);
}

/** 50, 100, 200, 250, 250 ... ms. */
function backoffMs(attempt: number): number {
  return Math.min(50 * 2 ** Math.min(attempt, 10), 250);
}

const LINE_TERMINATORS: ReadonlySet<string> = new Set([
  '\n',
  '\r',
  '\u000b',
  '\u000c',
  '\u001c',
  '\u001d',
  '\u001e',
  '\u0085',
  // Built from code points: LS and PS are invisible in an editor and easily lost by tools that normalise separators.
  String.fromCodePoint(0x2028),
  String.fromCodePoint(0x2029),
]);

/**
 * Python `str.splitlines()`: splits on CRLF, LF, CR, VT, FF, FS, GS, RS, NEL, LS and PS; a trailing terminator does not
 * create an empty last element and the empty string gives an empty list.
 */
export function pySplitlines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (LINE_TERMINATORS.has(ch)) {
      lines.push(text.slice(start, i));
      i += ch === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** The first `n` code points of `text` (Python slicing, no marker, never inside a surrogate pair). */
export function clipCodePoints(text: string, n: number): string {
  if (n <= 0) return '';
  return Array.from(text).slice(0, n).join('');
}

export interface Fsx {
  atomicWriteFile(file: string, data: string | Uint8Array, opts?: AtomicWriteOptions): Promise<void>;
  readSmallFile(file: string, maxBytes: number): Promise<Buffer>;
  unlinkWithRetry(file: string, budgetMs?: number): Promise<'deleted' | 'absent'>;
  tailLines(file: string, n: number): Promise<string[]>;
}

/** Builds the file functions over `deps`. The exports of this module are the instance over the real file system. */
export function createFsx(deps: FsxDeps): Fsx {
  async function closeQuietly(handle: FsxFile): Promise<void> {
    try {
      await handle.close();
    } catch {
      // The handle is being abandoned after another failure; that failure is the one worth reporting.
    }
  }

  async function unlinkQuietly(file: string): Promise<void> {
    try {
      await deps.unlink(file);
    } catch {
      // A temp file that cannot be removed now is cleaned by `mcs cleanup --scope stale-state` (01 4.13).
    }
  }

  async function atomicWriteFile(
    file: string,
    data: string | Uint8Array,
    opts: AtomicWriteOptions = {},
  ): Promise<void> {
    const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    const mode = opts.mode ?? 0o644;
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const tmp = `${file}.${String(deps.pid)}.${randomBytes(4).toString('hex')}.tmp`;

    let handle: FsxFile;
    try {
      // `wx`: never follows or reuses an existing file. When this fails there is nothing of ours to remove.
      handle = await deps.open(tmp, 'wx', mode);
    } catch (cause) {
      throw new AtomicWriteError('E_ATOMIC_WRITE_IO', file, cause);
    }
    try {
      await handle.writeAll(bytes);
      await handle.sync();
    } catch (cause) {
      await closeQuietly(handle);
      await unlinkQuietly(tmp);
      throw new AtomicWriteError('E_ATOMIC_WRITE_IO', file, cause);
    }
    try {
      await handle.close();
    } catch (cause) {
      await unlinkQuietly(tmp);
      throw new AtomicWriteError('E_ATOMIC_WRITE_IO', file, cause);
    }

    const started = deps.now();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await deps.rename(tmp, file);
        return;
      } catch (cause) {
        if (!isReplaceBusy(cause)) {
          await unlinkQuietly(tmp);
          throw new AtomicWriteError('E_ATOMIC_WRITE_IO', file, cause);
        }
        if (deps.now() - started >= budgetMs) {
          await unlinkQuietly(tmp);
          throw new AtomicWriteError('E_ATOMIC_WRITE_BUSY', file, cause);
        }
        await deps.sleep(backoffMs(attempt));
      }
    }
  }

  async function unlinkWithRetry(file: string, budgetMs: number = DEFAULT_BUDGET_MS): Promise<'deleted' | 'absent'> {
    const started = deps.now();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await deps.unlink(file);
        return 'deleted';
      } catch (cause) {
        if (errorCode(cause) === 'ENOENT') return 'absent';
        if (!isReplaceBusy(cause)) throw new AtomicWriteError('E_ATOMIC_WRITE_IO', file, cause);
        if (deps.now() - started >= budgetMs) throw new AtomicWriteError('E_ATOMIC_WRITE_BUSY', file, cause);
        await deps.sleep(backoffMs(attempt));
      }
    }
  }

  async function readOnce(file: string, maxBytes: number): Promise<Buffer> {
    const handle = await deps.open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (size > maxBytes) throw new SmallFileError('E_FILE_TOO_LARGE', file);
      // Read to the end instead of trusting `size`: procfs-style files report 0, and a file may grow after the stat.
      const limit = maxBytes + 1;
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const want = Math.min(READ_CHUNK, limit - total);
        if (want <= 0) throw new SmallFileError('E_FILE_TOO_LARGE', file);
        const chunk = Buffer.allocUnsafe(want);
        const { bytesRead } = await handle.read(chunk, 0, want, total);
        if (bytesRead === 0) break;
        chunks.push(bytesRead === want ? chunk : chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      return Buffer.concat(chunks, total);
    } finally {
      await closeQuietly(handle);
    }
  }

  async function readSmallFile(file: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError(`readSmallFile: maxBytes must be a non-negative integer, got ${String(maxBytes)}`);
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await readOnce(file, maxBytes);
      } catch (error) {
        if (error instanceof SmallFileError || !isReplaceBusy(error)) throw error;
        if (attempt >= READ_RETRIES) throw new SmallFileError('E_FILE_BUSY', file, error);
        await deps.sleep(READ_RETRY_DELAY_MS);
      }
    }
  }

  async function tailLines(file: string, n: number): Promise<string[]> {
    if (!(n > 0)) return [];
    let handle: FsxFile;
    try {
      handle = await deps.open(file, 'r');
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && TAIL_QUIET_CODES.has(code)) return [];
      throw error;
    }
    try {
      const { size } = await handle.stat();
      const want = Math.min(Math.max(MIN_TAIL_WINDOW, n * TAIL_BYTES_PER_LINE), MAX_TAIL_WINDOW);
      const start = Math.max(0, size - want);
      const length = size - start;
      const buffer = Buffer.allocUnsafe(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await handle.read(buffer, got, length - got, start + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      // Like Python `bytes.decode('utf-8', errors='replace')`: invalid sequences become U+FFFD and a BOM stays a character.
      const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(buffer.subarray(0, got));
      return pySplitlines(text).slice(-n);
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && TAIL_QUIET_CODES.has(code)) return [];
      throw error;
    } finally {
      await closeQuietly(handle);
    }
  }

  return { atomicWriteFile, readSmallFile, unlinkWithRetry, tailLines };
}

const realDeps: FsxDeps = {
  open: async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    return {
      stat: async () => {
        const stats = await handle.stat();
        return { size: stats.size };
      },
      read: async (buffer, offset, length, position) => {
        const { bytesRead } = await handle.read(buffer, offset, length, position);
        return { bytesRead };
      },
      writeAll: (data) => handle.writeFile(data),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename,
  unlink,
  sleep: (ms) => sleepMs(ms),
  now: () => performance.now(),
  pid: process.pid,
};

const real = createFsx(realDeps);

/** Writes `data` next to `file` and renames it over `file`, retrying Windows sharing violations for `budgetMs`. */
export function atomicWriteFile(file: string, data: string | Uint8Array, opts?: AtomicWriteOptions): Promise<void> {
  return real.atomicWriteFile(file, data, opts);
}

/** Opens, reads and closes at once; at most `maxBytes`; `EPERM | EACCES | EBUSY` are retried 10 x 20 ms. */
export function readSmallFile(file: string, maxBytes: number): Promise<Buffer> {
  return real.readSmallFile(file, maxBytes);
}

/** Deletes a file, retrying sharing violations; `absent` when it was not there. */
export function unlinkWithRetry(file: string, budgetMs?: number): Promise<'deleted' | 'absent'> {
  return real.unlinkWithRetry(file, budgetMs);
}

/** Python-compatible `tail`: the last `n` lines; an unreadable or missing file gives `[]` (06 3.9.1). */
export function tailLines(file: string, n: number): Promise<string[]> {
  return real.tailLines(file, n);
}
