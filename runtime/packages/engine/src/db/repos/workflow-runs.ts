// `workflow_runs` (03 3.5): one row per workflow run of a session. SQL only. A run has no presence, wait reason or end
// reason of its own, and `state_transitions` has no column for it, so `writeView` records a change but no transition
// (a deviation from 03 3.6, CR-WP-11-4).
import type { LifecycleState } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';
import {
  parseEvidence,
  rowLimit,
  type Basis,
  type Confidence,
  type StaleKind,
  type StoredView,
  type ViewEvidence,
} from './shared.ts';

/** The columns of a lifecycle view that a workflow run stores. */
export type WorkflowView = Pick<
  StoredView,
  'state' | 'staleKind' | 'basis' | 'confidence' | 'ruleId' | 'evidence' | 'since' | 'evaluatedAt' | 'nextCheckAt'
>;

export interface WorkflowRunRow {
  id: number;
  sessionId: number;
  runUid: string;
  workflowName: string | null;
  launchToolUseId: string | null;
  statusFile: string | null;
  agentCount: number | null;
  startedCount: number;
  resultCount: number;
  failedCount: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  state: LifecycleState;
  updatedSeq: number;
  updatedAt: number;
}

export interface NewWorkflowRun {
  sessionId: number;
  /** `wf_...` (the column checks the shape). */
  runUid: string;
  workflowName?: string | null;
  launchToolUseId?: string | null;
  statusFile?: string | null;
  agentCount?: number | null;
  startedCount?: number;
  resultCount?: number;
  failedCount?: number;
  startedAt?: number | null;
  endedAt?: number | null;
  durationMs?: number | null;
}

const RUN_COLUMNS = `id, session_id AS sessionId, run_uid AS runUid, workflow_name AS workflowName,
  launch_tool_use_id AS launchToolUseId, status_file AS statusFile, agent_count AS agentCount,
  started_count AS startedCount, result_count AS resultCount, failed_count AS failedCount, started_at AS startedAt,
  ended_at AS endedAt, duration_ms AS durationMs, state, updated_seq AS updatedSeq, updated_at AS updatedAt`;

const UPSERT_SQL = `INSERT INTO workflow_runs (session_id, run_uid, workflow_name, launch_tool_use_id, status_file, agent_count,
    started_count, result_count, failed_count, started_at, ended_at, duration_ms, updated_seq, updated_at)
  VALUES (:sessionId, :runUid, :workflowName, :launchToolUseId, :statusFile, :agentCount, :startedCount, :resultCount,
    :failedCount, :startedAt, :endedAt, :durationMs, coalesce(:seq, 0), :now)
  ON CONFLICT(session_id, run_uid) DO UPDATE SET
    workflow_name = coalesce(workflow_runs.workflow_name, excluded.workflow_name),
    launch_tool_use_id = coalesce(workflow_runs.launch_tool_use_id, excluded.launch_tool_use_id),
    status_file = coalesce(excluded.status_file, workflow_runs.status_file),
    agent_count = coalesce(excluded.agent_count, workflow_runs.agent_count),
    started_count = max(workflow_runs.started_count, excluded.started_count),
    result_count = max(workflow_runs.result_count, excluded.result_count),
    failed_count = max(workflow_runs.failed_count, excluded.failed_count),
    started_at = coalesce(min(workflow_runs.started_at, excluded.started_at), workflow_runs.started_at, excluded.started_at),
    ended_at = coalesce(max(workflow_runs.ended_at, excluded.ended_at), workflow_runs.ended_at, excluded.ended_at),
    duration_ms = coalesce(excluded.duration_ms, workflow_runs.duration_ms),
    updated_seq = coalesce(:seq, workflow_runs.updated_seq),
    updated_at = excluded.updated_at
  RETURNING id`;

const WRITE_VIEW_SQL = `UPDATE workflow_runs SET state = :state, stale_kind = :staleKind, state_basis = :basis,
    state_confidence = :confidence, state_rule = :ruleId, state_evidence = :evidence, state_since = :since,
    evaluated_at = :evaluatedAt, next_check_at = :nextCheckAt, facts_json = :factsJson, updated_at = :now,
    updated_seq = coalesce(:seq, updated_seq)
  WHERE id = :id`;

interface ViewKeyDbRow {
  state: LifecycleState;
  staleKind: StaleKind | null;
  basis: Basis;
  confidence: Confidence;
  ruleId: string;
}

function keyChanged(old: ViewKeyDbRow, next: WorkflowView): boolean {
  return (
    old.state !== next.state ||
    old.staleKind !== next.staleKind ||
    old.basis !== next.basis ||
    old.confidence !== next.confidence ||
    old.ruleId !== next.ruleId
  );
}

interface ViewDbRow extends ViewKeyDbRow {
  evidence: string;
  since: number | null;
  evaluatedAt: number;
  nextCheckAt: number | null;
}

export class WorkflowRunsRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /**
   * Inserts the run or merges into it: counters only grow, the first known name stays, the earlier start and the later
   * end win, a newer status file or agent count replaces the old one. `seq` stamps `updated_seq` (caller reserved it).
   */
  upsert(ctx: RepoContext, tx: WriteTx, r: NewWorkflowRun, seq: number | null): { id: number; created: boolean } {
    this.db.assertScope(ctx);
    const created =
      this.db.driver
        .prepare('SELECT 1 FROM workflow_runs WHERE session_id = :sessionId AND run_uid = :runUid')
        .get({ sessionId: r.sessionId, runUid: r.runUid }) === undefined;
    const row = this.db.driver.prepare<{ id: number }>(UPSERT_SQL).get({
      sessionId: r.sessionId,
      runUid: r.runUid,
      workflowName: r.workflowName ?? null,
      launchToolUseId: r.launchToolUseId ?? null,
      statusFile: r.statusFile ?? null,
      agentCount: r.agentCount ?? null,
      startedCount: r.startedCount ?? 0,
      resultCount: r.resultCount ?? 0,
      failedCount: r.failedCount ?? 0,
      startedAt: r.startedAt ?? null,
      endedAt: r.endedAt ?? null,
      durationMs: r.durationMs ?? null,
      now: tx.now,
      seq,
    });
    if (row === undefined) throw new Error('INSERT ... RETURNING answered no row');
    return { id: row.id, created };
  }

  byUid(ctx: RepoContext, sessionId: number, runUid: string): WorkflowRunRow | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<WorkflowRunRow>(
        `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE session_id = :sessionId AND run_uid = :runUid`,
      )
      .get({ sessionId, runUid });
  }

  listBySession(ctx: RepoContext, sessionId: number): WorkflowRunRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<WorkflowRunRow>(`SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE session_id = :sessionId ORDER BY id`)
      .all({ sessionId });
  }

  /**
   * As `SessionsRepo.writeView` for a workflow run: a `workflow/upsert` change when `state`, `staleKind`, `basis`,
   * `confidence` or `ruleId` differs, nothing for a facts-only or time-only update. `undefined` = no such run.
   */
  writeView(
    ctx: RepoContext,
    tx: WriteTx,
    id: number,
    view: WorkflowView,
    factsJson: string,
  ): { changed: boolean; seq: number | null } | undefined {
    this.db.assertScope(ctx);
    const { driver } = this.db;
    const old = driver
      .prepare<ViewKeyDbRow & { sessionUid: string }>(
        `SELECT s.session_uid AS sessionUid, w.state AS state, w.stale_kind AS staleKind, w.state_basis AS basis,
                w.state_confidence AS confidence, w.state_rule AS ruleId
         FROM workflow_runs w JOIN sessions s ON s.id = w.session_id WHERE w.id = :id`,
      )
      .get({ id });
    if (old === undefined) return undefined;
    const changed = keyChanged(old, view);
    const seq = changed ? tx.changes.reserve('workflow', 'upsert', { entityId: id, sessionUid: old.sessionUid }) : null;
    driver.prepare(WRITE_VIEW_SQL).run({
      id,
      state: view.state,
      staleKind: view.staleKind,
      basis: view.basis,
      confidence: view.confidence,
      ruleId: view.ruleId,
      evidence: JSON.stringify(view.evidence),
      since: view.since,
      evaluatedAt: view.evaluatedAt,
      nextCheckAt: view.nextCheckAt,
      factsJson,
      now: tx.now,
      seq,
    });
    return { changed, seq };
  }

  readView(ctx: RepoContext, id: number): { view: WorkflowView; factsJson: string } | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver
      .prepare<ViewDbRow & { factsJson: string }>(
        `SELECT state, stale_kind AS staleKind, state_basis AS basis, state_confidence AS confidence, state_rule AS ruleId,
                state_evidence AS evidence, state_since AS since, coalesce(evaluated_at, 0) AS evaluatedAt,
                next_check_at AS nextCheckAt, facts_json AS factsJson
         FROM workflow_runs WHERE id = :id`,
      )
      .get({ id });
    if (row === undefined) return undefined;
    const { factsJson, evidence, ...rest } = row;
    const parsed: ViewEvidence[] = parseEvidence(evidence);
    return { view: { ...rest, evidence: parsed }, factsJson };
  }

  /** Rows whose `next_check_at` has passed, earliest first (`idx_workflow_runs_next_check`). */
  dueForCheck(ctx: RepoContext, now: number, limit: number): { id: number; sessionId: number; runUid: string }[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<{ id: number; sessionId: number; runUid: string }>(
        `SELECT id, session_id AS sessionId, run_uid AS runUid FROM workflow_runs
         WHERE next_check_at IS NOT NULL AND next_check_at <= :now ORDER BY next_check_at, id LIMIT :limit`,
      )
      .all({ now, limit: rowLimit(limit) });
  }
}
