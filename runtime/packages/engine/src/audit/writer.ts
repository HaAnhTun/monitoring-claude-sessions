// The audit writer (01 7.1, 7.2): `audit/changes.md` and `audit/decisions.md`, byte-compatible with the legacy engine
// (`tasks.py` `audit_change`, `record_decision`, `last_change` and the `recent_audit` split of `cli.py`). Both engines
// append to the same files, so the header and the field order are never changed here.
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { isoSecondsZ } from '@mcs/shared';

import { appendWorkspaceFile, assertNotLink, isMissingFileError } from '../workspace/fsio.ts';
import { withTaskMutex, type WorkspaceRef } from '../workspace/paths.ts';
import { auditFilePath, blockStarts, pyStrip, readAuditText, type AuditFile, type AuditLogSink } from './reader.ts';

/** The actions of the Node-side catalogue (01 7.2). The legacy engine writes only `init-task` and `configure`. */
export const AUDIT_ACTIONS = [
  'init-task',
  'adopt-instance',
  'configure',
  'config-migrate',
  'config-import',
  'upgrade',
  'db-migrate',
  'backup',
  'backup-restore',
  'cleanup',
  'engine-switch',
  'hooks-enable',
  'hooks-disable',
  'hooks-install',
  'hooks-uninstall',
  'instances-repair',
  'db-rebuild',
  'ingest-replay',
  'migrate-workspace',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** One entry of `changes.md`. Every text field is written on one line. */
export interface ChangeEntry {
  readonly action: AuditAction;
  readonly summary: string;
  /** `null` or `''`: `not given` (legacy). */
  readonly reason: string | null;
  /** Empty: `none`. */
  readonly files: readonly string[];
  readonly validation: string;
  readonly outcome: string;
  /** Default `none`. */
  readonly unresolved?: string;
}

/** What a new `changes.md` starts with. */
export const CHANGES_HEADER = '# Changes\n\n';
/** What a new `decisions.md` starts with. */
export const DECISIONS_HEADER = '# Decisions\n\n';

const HEADERS: Readonly<Record<AuditFile, string>> = { changes: CHANGES_HEADER, decisions: DECISIONS_HEADER };
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

/**
 * A text field of an entry. The legacy reader splits at `## ` on a line start and reads universal newlines, so a line break
 * inside a field could forge an entry: `\r` and `\n` become a space (01 7.1). Nothing else is changed.
 */
function oneLine(text: string): string {
  return text.replace(/[\r\n]/g, ' ');
}

/** The exact bytes of a change entry, ending with the blank line (01 7.1). Throws `RangeError` for an action outside the catalogue or a time that is not a time. */
export function changeEntryText(e: ChangeEntry, nowMs: number): string {
  if (!KNOWN_ACTIONS.has(e.action))
    throw new RangeError(`audit action '${e.action}' is not in the catalogue of 01 7.2`);
  const time = isoSecondsZ(nowMs);
  const reason = e.reason === null || e.reason === '' ? 'not given' : oneLine(e.reason);
  const files = e.files.map(oneLine).join(', ');
  return (
    `## ${time} | ${e.action}\n` +
    `- Summary: ${oneLine(e.summary)}\n` +
    `- Reason: ${reason}\n` +
    `- Files changed: ${files === '' ? 'none' : files}\n` +
    `- Validation: ${oneLine(e.validation)}\n` +
    `- Outcome: ${oneLine(e.outcome)}\n` +
    `- Unresolved: ${oneLine(e.unresolved ?? 'none')}\n` +
    '\n'
  );
}

/** The exact bytes of a decision entry (01 7.1). */
export function decisionEntryText(title: string, decision: string, rejected: string | null, nowMs: number): string {
  const time = isoSecondsZ(nowMs);
  const alternatives = rejected === null || rejected === '' ? 'none recorded' : oneLine(rejected);
  return `## ${time} | ${oneLine(title)}\n- Decision: ${oneLine(decision)}\n- Rejected alternatives: ${alternatives}\n\n`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

/**
 * One `appendFile` of one buffer under the task mutex, with the file header when the file is new. Taking the mutex here is
 * safe inside a command that holds it already (it is reentrant for one call chain) and keeps two Node writers from
 * interleaving or doubling the header when it does not.
 */
async function appendAudit(ws: WorkspaceRef, file: AuditFile, entry: string): Promise<void> {
  await withTaskMutex(ws, async () => {
    const folder = path.join(ws.dir, 'audit');
    assertNotLink(folder);
    await mkdir(folder, { recursive: true });
    const target = auditFilePath(ws, file);
    assertNotLink(target);
    const isNew = !(await exists(target));
    await appendWorkspaceFile(target, isNew ? HEADERS[file] + entry : entry);
  });
}

/** Appends an entry to `audit/changes.md`. `nowMs` is `ctx.clock.now()` (I-36). */
export async function appendChange(ws: WorkspaceRef, e: ChangeEntry, nowMs: number): Promise<void> {
  await appendAudit(ws, 'changes', changeEntryText(e, nowMs));
}

/** Appends an entry to `audit/decisions.md`. */
export async function appendDecision(
  ws: WorkspaceRef,
  title: string,
  decision: string,
  rejected: string | null,
  nowMs: number,
): Promise<void> {
  await appendAudit(ws, 'decisions', decisionEntryText(title, decision, rejected, nowMs));
}

/**
 * The last block of `changes.md` as the legacy `last_change` reads it: the time before the first ` | ` of its header and the
 * text of the first `- Summary: ` of the block (the header line when there is none). `null` without a file or a block.
 */
export async function lastChange(ws: WorkspaceRef, log?: AuditLogSink): Promise<{ t: string; summary: string } | null> {
  const text = await readAuditText(ws, 'changes', log);
  if (text === null) return null;
  const starts = blockStarts(text);
  const start = starts[starts.length - 1];
  if (start === undefined) return null;
  const block = text.slice(start + '## '.length);
  const newline = block.indexOf('\n');
  const head = newline === -1 ? block : block.slice(0, newline);
  const rest = newline === -1 ? '' : block.slice(newline + 1);
  const match = /- Summary: ([^\n]*)/.exec(rest);
  return { t: pyStrip(head.split(' | ')[0] ?? ''), summary: match === null ? head : pyStrip(match[1] ?? '') };
}

/**
 * The last `blocks` pieces of `changes.md` joined, as `inspect` shows them: the legacy `re.split(r'(?m)^(?=## )', text)[-n:]`.
 * The file header is a piece of its own, so it is part of the result while the file has fewer than `blocks` entries.
 * The empty string without a file.
 */
export async function recentAudit(ws: WorkspaceRef, blocks = 3, log?: AuditLogSink): Promise<string> {
  if (!Number.isSafeInteger(blocks) || blocks < 1) {
    throw new RangeError(`recentAudit: blocks must be a positive integer, got ${String(blocks)}`);
  }
  const text = await readAuditText(ws, 'changes', log);
  if (text === null) return '';
  const cuts = blockStarts(text);
  const pieces =
    cuts.length === 0 ? [text] : [text.slice(0, cuts[0]), ...cuts.map((cut, i) => text.slice(cut, cuts[i + 1]))];
  return pieces.slice(-blocks).join('');
}
