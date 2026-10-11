// The handler's own log: `$MCS_HOME/logs/hook-handler.jsonl` (02 2.11). Never throws, never holds payload text.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';

/** Closed set of codes (registry 8, "Hook handler log code"). */
export type HandlerLogCode =
  | 'HANDLER_UNAVAILABLE'
  | 'STDIN_PARSE_ERROR'
  | 'ROUTES_UNREADABLE'
  | 'ROUTE_INVALID'
  | 'SPOOL_WRITE_FAILED'
  | 'SPOOL_FULL'
  | 'UNCAUGHT';

export interface HandlerLogEntry {
  code: HandlerLogCode;
  /** Event name from argv or the payload; `''` when unknown. */
  event: string;
  instanceId: string | null;
  /** At most 120 printable ASCII characters; no payload text and no paths except route file names. */
  detail?: string;
}

/** One line of the file. */
export interface HandlerLogLine {
  at: number;
  code: HandlerLogCode;
  event: string;
  instanceId: string | null;
  pid: number;
  detail: string;
}

/** The file is renamed to `hook-handler.1.jsonl` (replacing the old one) before an append that would pass this size. */
export const HANDLER_LOG_MAX_BYTES = 1024 * 1024;
export const HANDLER_LOG_DETAIL_MAX = 120;

const FIRST_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7e;

/** Printable ASCII only, cut to 120 characters. */
export function cleanDetail(text: string): string {
  let out = '';
  for (let i = 0; i < text.length && out.length < HANDLER_LOG_DETAIL_MAX; i += 1) {
    const code = text.charCodeAt(i);
    out += code >= FIRST_PRINTABLE && code <= LAST_PRINTABLE ? text.charAt(i) : '?';
  }
  return out;
}

export function handlerLogLine(entry: HandlerLogEntry, now: number, pid: number): string {
  const line: HandlerLogLine = {
    at: now,
    code: entry.code,
    event: cleanDetail(entry.event).slice(0, 64),
    instanceId: entry.instanceId,
    pid,
    detail: cleanDetail(entry.detail ?? ''),
  };
  return JSON.stringify(line) + String.fromCharCode(10);
}

/** Appends one line to `<mcsHome>/logs/hook-handler.jsonl`; `mcsHome === null` (no home found) and every I/O error are ignored. */
export function logHandler(
  mcsHome: string | null,
  entry: HandlerLogEntry,
  now: number = Date.now(),
  pid: number = process.pid,
): void {
  if (mcsHome === null) return;
  try {
    const dir = `${mcsHome}/logs`;
    const file = `${dir}/hook-handler.jsonl`;
    mkdirSync(dir, { recursive: true });
    try {
      if (statSync(file).size >= HANDLER_LOG_MAX_BYTES) renameSync(file, `${dir}/hook-handler.1.jsonl`);
    } catch {
      // No file yet, or a concurrent handler rotated it first: append below creates or reuses it.
    }
    appendFileSync(file, handlerLogLine(entry, now, pid));
  } catch {
    // The log is a diagnostic aid; a handler that cannot write it must still exit 0.
  }
}
