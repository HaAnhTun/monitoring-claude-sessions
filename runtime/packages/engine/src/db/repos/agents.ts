// `agents` (03 3.5, registry 2.6): the main agent of a session (created by `SessionsRepo.ensure`) and its subagents,
// workflow agents, teammates and internal agents. SQL only.
import type { AGENT_KINDS, LifecycleState } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';
import type { WriteViewResult } from './sessions.ts';
import {
  patchRow,
  requireRef,
  requireTranscriptFile,
  rowLimit,
  viewFromRow,
  viewKeyChanged,
  type PatchEntries,
  type StoredView,
  type ViewDbRow,
  type ViewKeyRow,
} from './shared.ts';
import { TransitionsRepo } from './transitions.ts';

export type AgentKind = (typeof AGENT_KINDS)[number];

export interface AgentRow {
  id: number;
  sessionId: number;
  agentUid: string;
  parentAgentId: number | null;
  kind: AgentKind;
  depth: number;
  agentType: string | null;
  label: string;
  description: string | null;
  requestShape: string | null;
  spawnToolUseId: string | null;
  workflowRunId: number | null;
  workflowPhase: string | null;
  model: string | null;
  transcriptFileId: number | null;
  firstSeenAt: number;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  state: LifecycleState;
  toolCallCount: number;
  errorCount: number;
  updatedSeq: number;
  updatedAt: number;
}

export interface NewAgent {
  sessionId: number;
  agentUid: string;
  /** `null` only for the main agent. */
  parentAgentId: number | null;
  kind: AgentKind;
  depth: number;
  startedAt: number;
  agentType?: string | null;
  label?: string;
  description?: string | null;
  requestShape?: string | null;
  spawnToolUseId?: string | null;
  workflowRunId?: number | null;
  workflowPhase?: string | null;
  model?: string | null;
  transcriptFileId?: number | null;
}

/** Columns `update` may write (see `SessionPatch`). */
export interface AgentPatch {
  label?: string;
  model?: string | null;
  transcriptFileId?: number | null;
  workflowRunId?: number | null;
  startedAt?: number;
  lastActivityAt?: number;
  endedAt?: number | null;
  toolCallCount?: number;
  errorCount?: number;
}

function patchEntries(p: AgentPatch): PatchEntries {
  return [
    ['label', p.label],
    ['model', p.model],
    ['transcript_file_id', p.transcriptFileId],
    ['workflow_run_id', p.workflowRunId],
    ['started_at', p.startedAt],
    ['last_activity_at', p.lastActivityAt],
    ['ended_at', p.endedAt],
    ['tool_call_count', p.toolCallCount],
    ['error_count', p.errorCount],
  ];
}

const AGENT_COLUMNS = `id, session_id AS sessionId, agent_uid AS agentUid, parent_agent_id AS parentAgentId, kind, depth,
  agent_type AS agentType, label, description, request_shape AS requestShape, spawn_tool_use_id AS spawnToolUseId,
  workflow_run_id AS workflowRunId, workflow_phase AS workflowPhase, model, transcript_file_id AS transcriptFileId,
  first_seen_at AS firstSeenAt, started_at AS startedAt, last_activity_at AS lastActivityAt, ended_at AS endedAt, state,
  tool_call_count AS toolCallCount, error_count AS errorCount, updated_seq AS updatedSeq, updated_at AS updatedAt`;

const UPSERT_SQL = `INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, agent_type, label, description,
    request_shape, spawn_tool_use_id, workflow_run_id, workflow_phase, model, transcript_file_id, first_seen_at,
    started_at, last_activity_at, updated_seq, updated_at)
  VALUES (:sessionId, :agentUid, :parentAgentId, :kind, :depth, :agentType, :label, :description, :requestShape,
    :spawnToolUseId, :workflowRunId, :workflowPhase, :model, :transcriptFileId, :now, :startedAt, :startedAt,
    coalesce(:seq, 0), :now)
  ON CONFLICT(session_id, agent_uid) DO UPDATE SET
    parent_agent_id = coalesce(agents.parent_agent_id, excluded.parent_agent_id),
    agent_type = coalesce(agents.agent_type, excluded.agent_type),
    label = CASE WHEN agents.label = '' THEN excluded.label ELSE agents.label END,
    description = coalesce(agents.description, excluded.description),
    request_shape = coalesce(agents.request_shape, excluded.request_shape),
    spawn_tool_use_id = coalesce(agents.spawn_tool_use_id, excluded.spawn_tool_use_id),
    workflow_run_id = coalesce(agents.workflow_run_id, excluded.workflow_run_id),
    workflow_phase = coalesce(agents.workflow_phase, excluded.workflow_phase),
    model = coalesce(agents.model, excluded.model),
    transcript_file_id = coalesce(agents.transcript_file_id, excluded.transcript_file_id),
    started_at = min(agents.started_at, excluded.started_at),
    last_activity_at = max(agents.last_activity_at, excluded.last_activity_at),
    updated_seq = coalesce(:seq, agents.updated_seq),
    updated_at = excluded.updated_at
  RETURNING id`;

const WRITE_VIEW_SQL = `UPDATE agents SET state = :state, presence = :presence, wait_reason = :waitReason,
    stale_kind = :staleKind, end_reason = :endReason, turn_outcome = :turnOutcome, state_basis = :basis,
    state_confidence = :confidence, state_rule = :ruleId, state_evidence = :evidence, state_since = :since,
    evaluated_at = :evaluatedAt, next_check_at = :nextCheckAt, facts_json = :factsJson, updated_at = :now,
    updated_seq = coalesce(:seq, updated_seq)
  WHERE id = :id`;

const VIEW_KEY_COLUMNS = `a.state AS state, a.presence AS presence, a.wait_reason AS waitReason, a.stale_kind AS staleKind,
  a.end_reason AS endReason, a.turn_outcome AS turnOutcome, a.state_basis AS basis, a.state_confidence AS confidence,
  a.state_rule AS ruleId`;

const VIEW_COLUMNS = `state, presence, wait_reason AS waitReason, stale_kind AS staleKind, end_reason AS endReason,
  turn_outcome AS turnOutcome, state_basis AS basis, state_confidence AS confidence, state_rule AS ruleId,
  state_evidence AS evidence, state_since AS since, coalesce(evaluated_at, 0) AS evaluatedAt, next_check_at AS nextCheckAt`;

/** A workflow run of the same session; `null` or absent is no reference (03 3.4). */
function requireWorkflowRun(db: InstanceDb, runId: number | null | undefined, sessionId: number): void {
  if (runId === null || runId === undefined) return;
  requireRef(db, 'workflow run', 'SELECT 1 FROM workflow_runs WHERE id = ? AND session_id = ?', [runId, sessionId]);
}

export class AgentsRepo {
  private readonly db: InstanceDb;
  private readonly transitions: TransitionsRepo;

  constructor(db: InstanceDb) {
    this.db = db;
    this.transitions = new TransitionsRepo(db);
  }

  /**
   * Inserts the agent or merges into the existing row (first non-null metadata wins, the earlier start wins, the last
   * activity only grows). `seq` stamps `updated_seq` when the caller reserved an `agent/upsert` for this write.
   * The parent agent and the workflow run must exist in the same session and the transcript file must exist (03 3.4).
   */
  upsert(ctx: RepoContext, tx: WriteTx, a: NewAgent, seq: number | null): { id: number; created: boolean } {
    this.db.assertScope(ctx);
    if (a.parentAgentId !== null) {
      requireRef(this.db, 'parent agent', 'SELECT 1 FROM agents WHERE id = ? AND session_id = ?', [
        a.parentAgentId,
        a.sessionId,
      ]);
    }
    requireWorkflowRun(this.db, a.workflowRunId, a.sessionId);
    requireTranscriptFile(this.db, a.transcriptFileId);
    const created =
      this.db.driver
        .prepare('SELECT 1 FROM agents WHERE session_id = :sessionId AND agent_uid = :agentUid')
        .get({ sessionId: a.sessionId, agentUid: a.agentUid }) === undefined;
    const row = this.db.driver.prepare<{ id: number }>(UPSERT_SQL).get({
      sessionId: a.sessionId,
      agentUid: a.agentUid,
      parentAgentId: a.parentAgentId,
      kind: a.kind,
      depth: a.depth,
      agentType: a.agentType ?? null,
      label: a.label ?? '',
      description: a.description ?? null,
      requestShape: a.requestShape ?? null,
      spawnToolUseId: a.spawnToolUseId ?? null,
      workflowRunId: a.workflowRunId ?? null,
      workflowPhase: a.workflowPhase ?? null,
      model: a.model ?? null,
      transcriptFileId: a.transcriptFileId ?? null,
      startedAt: a.startedAt,
      now: tx.now,
      seq,
    });
    if (row === undefined) throw new Error('INSERT ... RETURNING answered no row');
    return { id: row.id, created };
  }

  byUid(ctx: RepoContext, sessionId: number, agentUid: string): AgentRow | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<AgentRow>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE session_id = :sessionId AND agent_uid = :agentUid`)
      .get({ sessionId, agentUid });
  }

  /** Creation order: the main agent first. */
  listBySession(ctx: RepoContext, sessionId: number): AgentRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<AgentRow>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE session_id = :sessionId ORDER BY id`)
      .all({ sessionId });
  }

  countBySession(ctx: RepoContext, sessionId: number): number {
    this.db.assertScope(ctx);
    return (
      this.db.driver
        .prepare<{ n: number }>('SELECT count(*) AS n FROM agents WHERE session_id = :sessionId')
        .get({ sessionId })?.n ?? 0
    );
  }

  /** A workflow run or a transcript file that does not exist (in the session of the agent) is refused (03 3.4). */
  update(ctx: RepoContext, tx: WriteTx, id: number, patch: AgentPatch, seq: number | null): boolean {
    this.db.assertScope(ctx);
    if (patch.workflowRunId !== undefined || patch.transcriptFileId !== undefined) {
      const owner = this.db.driver
        .prepare<{ sessionId: number }>('SELECT session_id AS sessionId FROM agents WHERE id = ?')
        .get([id]);
      if (owner === undefined) return false;
      requireWorkflowRun(this.db, patch.workflowRunId, owner.sessionId);
      requireTranscriptFile(this.db, patch.transcriptFileId);
    }
    return patchRow(this.db, 'agents', id, patchEntries(patch), seq, tx.now);
  }

  /** As `SessionsRepo.writeView`, with an `agent/upsert` change and agent level `state_transitions` rows. */
  writeView(
    ctx: RepoContext,
    tx: WriteTx,
    id: number,
    view: StoredView,
    factsJson: string,
  ): WriteViewResult | undefined {
    this.db.assertScope(ctx);
    const { driver } = this.db;
    const old = driver
      .prepare<ViewKeyRow & { sessionId: number; sessionUid: string }>(
        `SELECT a.session_id AS sessionId, s.session_uid AS sessionUid, ${VIEW_KEY_COLUMNS}
         FROM agents a JOIN sessions s ON s.id = a.session_id WHERE a.id = :id`,
      )
      .get({ id });
    if (old === undefined) return undefined;
    const changed = viewKeyChanged(old, view);
    const seq = changed ? tx.changes.reserve('agent', 'upsert', { entityId: id, sessionUid: old.sessionUid }) : null;
    driver.prepare(WRITE_VIEW_SQL).run({
      id,
      state: view.state,
      presence: view.presence,
      waitReason: view.waitReason,
      staleKind: view.staleKind,
      endReason: view.endReason,
      turnOutcome: view.turnOutcome,
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
    const transitioned = changed && old.state !== view.state;
    if (transitioned) {
      this.transitions.insert(ctx, tx, {
        sessionId: old.sessionId,
        agentId: id,
        fromState: old.state,
        toState: view.state,
        rule: view.ruleId,
        basis: view.basis,
        confidence: view.confidence,
        evidence: view.evidence,
        at: view.evaluatedAt,
      });
    }
    return { changed, transitioned, seq };
  }

  readView(ctx: RepoContext, id: number): { view: StoredView; factsJson: string } | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver
      .prepare<ViewDbRow & { factsJson: string }>(
        `SELECT ${VIEW_COLUMNS}, facts_json AS factsJson FROM agents WHERE id = :id`,
      )
      .get({ id });
    if (row === undefined) return undefined;
    const { factsJson, ...view } = row;
    return { view: viewFromRow(view), factsJson };
  }

  /** Rows whose `next_check_at` has passed, earliest first (`idx_agents_next_check`). */
  dueForCheck(ctx: RepoContext, now: number, limit: number): { id: number; sessionId: number; agentUid: string }[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<{ id: number; sessionId: number; agentUid: string }>(
        `SELECT id, session_id AS sessionId, agent_uid AS agentUid FROM agents
         WHERE next_check_at IS NOT NULL AND next_check_at <= :now ORDER BY next_check_at, id LIMIT :limit`,
      )
      .all({ now, limit: rowLimit(limit) });
  }
}
