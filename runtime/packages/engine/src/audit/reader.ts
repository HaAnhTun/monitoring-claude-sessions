// Reading the audit trail (01 7.1, I-19). `audit/changes.md` and `audit/decisions.md` are written by both engines in the
// legacy format; this module parses them with the legacy block rule and turns blocks into `AuditRef`s for the session
// detail of the API. Everything read is workspace text written by the operator's commands, never transcript text.
import path from 'node:path';

import { isoMsZ, isoSecondsZ } from '@mcs/shared';

import { isMissingFileError, readTextTail } from '../workspace/fsio.ts';
import type { WorkspaceRef } from '../workspace/paths.ts';

export type AuditFile = 'changes' | 'decisions';

/** Both files, in the order that breaks ties between equal times (`changes` first). */
export const AUDIT_FILES: readonly AuditFile[] = ['changes', 'decisions'];

/** An audit file is read through its last 4 MiB (01 7.1 step 1). */
export const AUDIT_READ_BYTES = 4 * 1024 * 1024;

/** One block of an audit file as the session detail shows it (03 6.3 `SessionDetail.auditRefs`). */
export interface AuditRef {
  readonly file: AuditFile;
  /** ISO time with milliseconds, UTC. */
  readonly at: string;
  readonly title: string;
  readonly summary: string;
}

/** The part of a logger the reader uses; `audit_truncated` is logged at most once per file and process. */
export interface AuditLogSink {
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface EntriesOptions {
  readonly log?: AuditLogSink;
}

/** `<workspace>/audit/<file>.md`. */
export function auditFilePath(ws: Pick<WorkspaceRef, 'dir'>, file: AuditFile): string {
  return path.join(ws.dir, 'audit', `${file}.md`);
}

const truncationLogged = new Set<string>();

/**
 * The text of an audit file with universal newlines and no BOM, or `null` when the file does not exist. A file larger
 * than 4 MiB is read through its tail and the first, partial block is dropped; that is logged once as `audit_truncated`.
 */
export async function readAuditText(
  ws: Pick<WorkspaceRef, 'dir' | 'realDir'>,
  file: AuditFile,
  log?: AuditLogSink,
): Promise<string | null> {
  let tail: { text: string; truncated: boolean };
  try {
    tail = await readTextTail(auditFilePath(ws, file), AUDIT_READ_BYTES);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  if (!tail.truncated) return tail.text;
  const key = `${ws.realDir}|${file}`;
  if (!truncationLogged.has(key)) {
    truncationLogged.add(key);
    log?.warn('audit_truncated', { bytes: AUDIT_READ_BYTES });
  }
  // The cut falls inside a block: keep from the first block that starts on a line of its own.
  const at = tail.text.indexOf('\n## ');
  return at === -1 ? '' : tail.text.slice(at + 1);
}

/** Offsets of the blocks: where `## ` starts a line (the legacy split `(?m)^## `; only LF counts, the text is normalised). */
export function blockStarts(text: string): number[] {
  const starts: number[] = [];
  if (text.startsWith('## ')) starts.push(0);
  for (let from = 0; ;) {
    const at = text.indexOf('\n## ', from);
    if (at === -1) break;
    starts.push(at + 1);
    from = at + 1;
  }
  return starts;
}

/** Python `str.isspace()` for the code points `str.strip()` removes. */
function isPySpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Python `str.strip()` (JavaScript `trim` differs: it keeps NEL and the separators U+001C to U+001F and strips U+FEFF). */
export function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isPySpace(text.charCodeAt(start))) start += 1;
  while (end > start && isPySpace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

const HEADER = /^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \| ([^\n]*)$/;
const SUMMARY_PREFIX: Readonly<Record<AuditFile, string>> = { changes: '- Summary: ', decisions: '- Decision: ' };
const SUMMARY_MAX = 300;
const ELLIPSIS = '...';

function clipSummary(text: string): string {
  if (text.length <= SUMMARY_MAX) return text;
  const points = Array.from(text);
  return points.length <= SUMMARY_MAX ? text : `${points.slice(0, SUMMARY_MAX - ELLIPSIS.length).join('')}${ELLIPSIS}`;
}

interface Found {
  readonly file: AuditFile;
  readonly ms: number;
  readonly title: string;
  readonly summary: string;
}

function parseBlocks(file: AuditFile, text: string, fromMs: number, toMs: number): Found[] {
  const starts = blockStarts(text);
  const found: Found[] = [];
  starts.forEach((start, i) => {
    const block = text.slice(start, starts[i + 1] ?? text.length);
    const newline = block.indexOf('\n');
    const first = newline === -1 ? block : block.slice(0, newline);
    const match = HEADER.exec(first);
    if (match === null) return;
    const stamp = match[1] ?? '';
    const ms = Date.parse(stamp);
    // `Date.parse` rolls over impossible dates (30 February, hour 24); only a timestamp that reads back identically counts.
    if (Number.isNaN(ms) || isoSecondsZ(ms) !== stamp) return;
    if (ms < fromMs || ms > toMs) return;
    const prefix = SUMMARY_PREFIX[file];
    const line = (newline === -1 ? [] : block.slice(newline + 1).split('\n')).find((l) => l.startsWith(prefix));
    found.push({
      file,
      ms,
      title: (match[2] ?? '').trim(),
      summary: clipSummary(line === undefined ? '' : line.slice(prefix.length)),
    });
  });
  return found;
}

/**
 * The audit references of a time window (inclusive on both ends) over both files, newest first (equal times: `changes`
 * before `decisions`, then file order), at most `limit` (01 7.1). Missing files give no entries; a block whose header is
 * not `## <UTC second> | <title>` is skipped. Rejects with `RangeError` for a bound that is not a finite number or a limit
 * that is not a non-negative integer.
 */
export async function entriesBetween(
  ws: WorkspaceRef,
  fromMs: number,
  toMs: number,
  limit: number,
  o: EntriesOptions = {},
): Promise<AuditRef[]> {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new RangeError(
      `entriesBetween: fromMs and toMs must be finite numbers, got ${String(fromMs)} and ${String(toMs)}`,
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`entriesBetween: limit must be a non-negative integer, got ${String(limit)}`);
  }
  const found: Found[] = [];
  for (const file of AUDIT_FILES) {
    const text = await readAuditText(ws, file, o.log);
    if (text !== null) found.push(...parseBlocks(file, text, fromMs, toMs));
  }
  const rank = (file: AuditFile): number => AUDIT_FILES.indexOf(file);
  found.sort((a, b) => b.ms - a.ms || rank(a.file) - rank(b.file));
  return found.slice(0, limit).map((f) => ({ file: f.file, at: isoMsZ(f.ms), title: f.title, summary: f.summary }));
}
