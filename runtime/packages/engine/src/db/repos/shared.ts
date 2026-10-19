// Helpers shared by the repositories (CR-WP-11-5): the patch statement of `sessions` and `agents`, the lifecycle view
// types and their key comparison, the soft reference checks, the `LIMIT` guard, the evidence column reader and the code
// point cut for column caps. SQL only, no repository class, so every repository file may import it without a cycle.
import type { LifecycleState } from '@mcs/shared';
import { z } from 'zod';

import { clipCodePoints } from '../../platform/fsx.ts';
import type { SqlValue } from '../driver.ts';
import { DbError } from '../errors.ts';
import type { InstanceDb } from '../open.ts';

export type Basis = 'observed' | 'inferred';
export type Confidence = 'high' | 'medium' | 'low';

/** The engine form of an evidence item (02 7.1 `LifecycleEvidence`): a source, a fact and a time, never content. */
export const ViewEvidenceSchema = z.object({
  source: z.string(),
  fact: z.string(),
  at: z.number().nullable(),
  count: z.number().optional(),
  value: z.string().optional(),
});
export type ViewEvidence = z.infer<typeof ViewEvidenceSchema>;

const EvidenceListSchema = z.array(ViewEvidenceSchema);

/**
 * The value bound to a `LIMIT` (or a trim size) of any repository statement: a non-negative integer. SQLite reads a
 * negative limit as "no limit" (03 3.7 rule 3: no unbounded query), so anything else is a `RangeError`.
 */
export function rowLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('a row limit is a non-negative integer');
  return limit;
}

/**
 * Checks a soft reference (03 3.4: an id column without REFERENCES, validated by the repository): throws the
 * `db_constraint` / `foreignkey` error of the other repositories when `sql` (a `SELECT 1 ... WHERE id = ?`) finds no row.
 * A caller that holds the id of an existing row is never blocked.
 */
export function requireRef(db: InstanceDb, what: string, sql: string, params: readonly SqlValue[]): void {
  if (db.driver.prepare(sql).get(params) === undefined) {
    throw new DbError('db_constraint', `the ${what} does not exist`, { constraint: 'foreignkey' });
  }
}

/** `requireRef` for a transcript file; a `null` or absent id is no reference. */
export function requireTranscriptFile(db: InstanceDb, fileId: number | null | undefined): void {
  if (fileId === null || fileId === undefined) return;
  requireRef(db, 'transcript file', 'SELECT 1 FROM transcript_files WHERE id = ?', [fileId]);
}

/**
 * Reads an evidence column. A damaged column (invalid JSON or an unexpected shape) reads as an empty list: it must never
 * block a lookup, and the next evaluation of the view rewrites the column.
 */
export function parseEvidence(text: string): ViewEvidence[] {
  try {
    const parsed = EvidenceListSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export type Presence = 'open' | 'ended' | 'unknown';
export type WaitReason = 'user' | 'permission' | 'elicitation' | 'agent_input' | 'idle_prompt';
export type StaleKind = 'silent' | 'abandoned' | 'process_gone' | 'parent_ended';
export type TurnOutcome = 'ok' | 'error' | 'interrupted';

/**
 * The stored form of a lifecycle view (02 7.1 `LifecycleView`: the same field names, so a `LifecycleView` is accepted
 * as is). The unevaluated defaults of a fresh row read as `evaluatedAt` 0.
 */
export interface StoredView {
  state: LifecycleState;
  presence: Presence;
  waitReason: WaitReason | null;
  staleKind: StaleKind | null;
  endReason: string | null;
  turnOutcome: TurnOutcome | null;
  basis: Basis;
  confidence: Confidence;
  ruleId: string;
  evidence: readonly ViewEvidence[];
  since: number | null;
  evaluatedAt: number;
  nextCheckAt: number | null;
}

export type PatchValue = string | number | boolean | null;

export type PatchEntries = readonly (readonly [column: string, value: PatchValue | undefined])[];

function sqlValue(value: PatchValue): SqlValue {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

/**
 * Shared by `SessionsRepo.update` and `AgentsRepo.update`: one `UPDATE` over the named columns. The column names come
 * from the literal lists of the two repositories, never from input. `updated_seq` is stamped only when `seq` is given
 * (the caller reserved a change), `updated_at` always.
 */
export function patchRow(
  db: InstanceDb,
  table: 'sessions' | 'agents',
  id: number,
  entries: PatchEntries,
  seq: number | null,
  now: number,
): boolean {
  const params: Record<string, SqlValue> = { id, updatedAt: now };
  const sets: string[] = [];
  for (const [column, value] of entries) {
    if (value === undefined) continue;
    sets.push(`${column} = :${column}`);
    params[column] = sqlValue(value);
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = :updatedAt');
  if (seq !== null) {
    sets.push('updated_seq = :updatedSeq');
    params['updatedSeq'] = seq;
  }
  return db.driver.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = :id`).run(params).changes > 0;
}

export interface ViewKeyRow {
  state: LifecycleState;
  presence: Presence;
  waitReason: WaitReason | null;
  staleKind: StaleKind | null;
  endReason: string | null;
  turnOutcome: TurnOutcome | null;
  basis: Basis;
  confidence: Confidence;
  ruleId: string;
}

/** The nine fields of `viewChanged` (02 7.8): time passing and evidence wording alone never count as a change. */
export function viewKeyChanged(old: ViewKeyRow, next: ViewKeyRow): boolean {
  return (
    old.state !== next.state ||
    old.presence !== next.presence ||
    old.waitReason !== next.waitReason ||
    old.staleKind !== next.staleKind ||
    old.endReason !== next.endReason ||
    old.turnOutcome !== next.turnOutcome ||
    old.basis !== next.basis ||
    old.confidence !== next.confidence ||
    old.ruleId !== next.ruleId
  );
}

export interface ViewDbRow extends Omit<StoredView, 'evidence'> {
  evidence: string;
}

export function viewFromRow(row: ViewDbRow): StoredView {
  return { ...row, evidence: parseEvidence(row.evidence) };
}

/** The first `n` code points of a column value, `null` stays `null`: a plain cut, never inside a surrogate pair, so the CHECK of the column always holds. */
export function cutOrNull(text: string | null | undefined, n: number): string | null {
  return text === null || text === undefined ? null : clipCodePoints(text, n);
}
