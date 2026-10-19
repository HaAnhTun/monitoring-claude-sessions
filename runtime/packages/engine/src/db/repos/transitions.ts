// `state_transitions` (03 3.5, 3.6): one row each time the state of a session or an agent changes. SQL only: the rule
// that decides a state change lives in the lifecycle module of 02; `SessionsRepo.writeView` and `AgentsRepo.writeView`
// call `insert` when the stored state differs from the new one.
import type { LifecycleState } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';
import { parseEvidence, requireRef, rowLimit, type Basis, type Confidence, type ViewEvidence } from './shared.ts';

// The shared helpers used to live here; the other repositories and the query layer still import them from this file.
export {
  parseEvidence,
  requireRef,
  requireTranscriptFile,
  rowLimit,
  ViewEvidenceSchema,
  type Basis,
  type Confidence,
  type ViewEvidence,
} from './shared.ts';

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
