// The hook handler's own log as a summary (02 2.11, ADR 0070): `$MCS_HOME/logs/hook-handler.jsonl` and the file it is rotated to,
// read as a count and a last time per code. This is what `hooks status` and `doctor` show, and nothing more: the `detail`, the
// event, the instance id and the process id of a line are never copied out, because the log is a file that any process of the
// same user can write.
//
// The read is bounded. At most `HANDLER_LOG_TAIL_BYTES` (64 KiB) of the log are read in all: the tail of the current file, and
// when that is shorter than the budget the tail of the rotated file for the rest. A line cut by the start of a window and a line
// torn by a concurrent append are skipped, so the counts are those of the lines read, not of the whole history.
import { open } from 'node:fs/promises';
import path from 'node:path';

/** The budget of one summary, in bytes, for the log and its rotated file together. */
export const HANDLER_LOG_TAIL_BYTES = 64 * 1024;
export const HANDLER_LOG_FILE = 'hook-handler.jsonl';
/** More distinct codes than this are counted under `UNKNOWN`. */
export const HANDLER_LOG_MAX_CODES = 64;
/** The code under which a line of a shape that is not a code of the handler is counted. */
export const UNKNOWN_LOG_CODE = 'UNKNOWN';

// A code of the handler is upper case words joined by underscores (`SPOOL_FULL`); anything else may be hostile text.
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,39}$/;
const LF = String.fromCharCode(10);

export interface HandlerLogCount {
  readonly code: string;
  readonly count: number;
  /** The newest `at` (epoch ms) among the lines of this code that were read. */
  readonly lastAt: number;
}

/** `<mcsHome>/logs/hook-handler.jsonl` */
export function handlerLogPath(mcsHome: string): string {
  return path.join(mcsHome, 'logs', HANDLER_LOG_FILE);
}

/** The file the handler renames a full log to: `hook-handler.jsonl` becomes `hook-handler.1.jsonl` in the same folder. */
export function rotatedLogPath(file: string): string {
  return file.endsWith('.jsonl') ? `${file.slice(0, -'.jsonl'.length)}.1.jsonl` : `${file}.1`;
}

export interface FileTail {
  /** The bytes read, as text. */
  readonly text: string;
  /** The window starts inside the file: the first line may be cut and must not be used. */
  readonly cutAtStart: boolean;
  /** Bytes read. */
  readonly bytes: number;
}

/**
 * The last `maxBytes` bytes of a regular file, or `null` when it does not exist, is not a file or cannot be read. Never throws.
 * A link is followed (the file behind it is read).
 */
export async function readFileTail(file: string, maxBytes: number): Promise<FileTail | null> {
  if (maxBytes <= 0) return { text: '', cutAtStart: false, bytes: 0 };
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, info.size - length + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { text: buffer.subarray(0, filled).toString('utf8'), cutAtStart: info.size > length, bytes: filled };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The lines of a tail that can be trusted to be whole: the first one is dropped when the window cut it. A last piece that no
 * newline ends is torn unless it parses on its own (the handler appends the newline with the line); the JSON parse decides.
 */
export function wholeLines(tail: FileTail): string[] {
  const lines = tail.text.split(LF);
  if (tail.cutAtStart) lines.shift();
  return lines;
}

interface Tally {
  count: number;
  lastAt: number;
}

function addLine(tally: Map<string, Tally>, text: string): void {
  if (text === '') return;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const at: unknown = Reflect.get(value, 'at');
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return;
  const raw: unknown = Reflect.get(value, 'code');
  let code = typeof raw === 'string' && CODE_SHAPE.test(raw) ? raw : UNKNOWN_LOG_CODE;
  if (!tally.has(code) && code !== UNKNOWN_LOG_CODE && tally.size >= HANDLER_LOG_MAX_CODES) code = UNKNOWN_LOG_CODE;
  const known = tally.get(code);
  if (known === undefined) tally.set(code, { count: 1, lastAt: at });
  else {
    known.count += 1;
    known.lastAt = Math.max(known.lastAt, at);
  }
}

/**
 * Count and last time per code from the tail of the log at `file` and of its rotated file (at most 64 KiB in all). The result
 * is sorted by the newest time first, then by code. A missing, empty or unreadable log gives an empty list. Never throws.
 */
export async function summarizeHandlerLog(file: string): Promise<HandlerLogCount[]> {
  const tally = new Map<string, Tally>();
  const current = await readFileTail(file, HANDLER_LOG_TAIL_BYTES);
  const room = HANDLER_LOG_TAIL_BYTES - (current?.bytes ?? 0);
  // The rotated file is older: it is read only for the part of the budget the current file did not use.
  const rotated = room > 0 ? await readFileTail(rotatedLogPath(file), room) : null;
  for (const tail of [rotated, current]) {
    if (tail === null) continue;
    for (const text of wholeLines(tail)) addLine(tally, text);
  }
  return [...tally.entries()]
    .map(([code, t]): HandlerLogCount => ({ code, count: t.count, lastAt: t.lastAt }))
    .sort((a, b) => b.lastAt - a.lastAt || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
