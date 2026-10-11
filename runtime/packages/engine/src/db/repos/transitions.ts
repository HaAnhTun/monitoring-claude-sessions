// `state_transitions` (03 3.5, 3.6): one row each time the state of a session or an agent changes. SQL only: the rule
// that decides a state change lives in the lifecycle module of 02; `SessionsRepo.writeView` and `AgentsRepo.writeView`
// call `insert` when the stored state differs from the new one.
import type { LifecycleState } from '@mcs/shared';
import { z } from 'zod';

import type { SqlValue } from '../driver.ts';
import { DbError } from '../errors.ts';
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

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

export interface NewTransition {
  sessionId: number;
  /** `null` = the session level. */
  agentId: number | null;
  fromState: LifecycleState | null;
  toState: LifecycleState;
  rule: string;
  basis: Basis;
  confidence: Confidence;
  evidence: readonly ViewEvidence[];
  at: number;
}

export interface TransitionRow extends Omit<NewTransition, 'evidence'> {
  id: number;
  evidence: ViewEvidence[];
}

interface TransitionDbRow {
  id: number;
  sessionId: number;
  agentId: number | null;
  fromState: LifecycleState | null;
  toState: LifecycleState;
  rule: string;
  basis: Basis;
  confidence: Confidence;
  evidence: string;
  at: number;
}

const INSERT_SQL = `INSERT INTO state_transitions (session_id, agent_id, from_state, to_state, rule, basis, confidence, evidence, at)
  VALUES (:sessionId, :agentId, :fromState, :toState, :rule, :basis, :confidence, :evidence, :at)`;

const LIST_SQL = `SELECT id, session_id AS sessionId, agent_id AS agentId, from_state AS fromState, to_state AS toState,
    rule, basis, confidence, evidence, at
  FROM state_transitions WHERE session_id = :sessionId ORDER BY at DESC, id DESC LIMIT :limit`;

export class TransitionsRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /** Appends a transition and returns its id. The agent, when given, must belong to the session (03 3.4). */
  insert(ctx: RepoContext, _tx: WriteTx, t: NewTransition): number {
    this.db.assertScope(ctx);
    if (t.agentId !== null) {
      requireRef(this.db, 'agent', 'SELECT 1 FROM agents WHERE id = ? AND session_id = ?', [t.agentId, t.sessionId]);
    }
    return this.db.driver.prepare(INSERT_SQL).run({
      sessionId: t.sessionId,
      agentId: t.agentId,
      fromState: t.fromState,
      toState: t.toState,
      rule: t.rule,
      basis: t.basis,
      confidence: t.confidence,
      evidence: JSON.stringify(t.evidence),
      at: t.at,
    }).lastInsertRowid;
  }

  /** Newest first (`idx_transitions_session`). */
  listBySession(ctx: RepoContext, sessionId: number, limit: number): TransitionRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<TransitionDbRow>(LIST_SQL)
      .all({ sessionId, limit: rowLimit(limit) })
      .map((row) => ({ ...row, evidence: parseEvidence(row.evidence) }));
  }

  countBySession(ctx: RepoContext, sessionId: number): number {
    this.db.assertScope(ctx);
    return (
      this.db.driver
        .prepare<{ n: number }>('SELECT count(*) AS n FROM state_transitions WHERE session_id = :sessionId')
        .get({ sessionId })?.n ?? 0
    );
  }
}
