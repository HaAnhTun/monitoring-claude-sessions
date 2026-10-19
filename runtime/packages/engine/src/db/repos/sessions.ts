// `sessions` (03 3.5, 3.6): the session row, its lifecycle view columns and the lookups that other designs name
// (`attemptCandidates` 06 3.10.6, `uidsByRowIds` N-10, `completionCandidates` 02 7.13). SQL only: which rows to write,
// and the rules that derive a view, live in the ingestion and lifecycle modules of 02.
import type { LifecycleState } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';
import {
  patchRow,
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

export type { Basis, Confidence, ViewEvidence } from './shared.ts';
export type {
  PatchEntries,
  PatchValue,
  Presence,
  StaleKind,
  StoredView,
  TurnOutcome,
  ViewDbRow,
  ViewKeyRow,
  WaitReason,
} from './shared.ts';

/** What `writeView` did. `seq` is the reserved change (`null` when nothing visible changed). */
export interface WriteViewResult {
  changed: boolean;
  transitioned: boolean;
  seq: number | null;
}

export interface SessionRow {
  id: number;
  sessionUid: string;
  projectId: number | null;
  transcriptFileId: number | null;
  label: string;
  labelSource: string;
  matched: boolean;
  pinned: boolean;
  cwd: string | null;
  claudePid: number | null;
  hookCoverage: string;
  firstSeenAt: number;
  startedAt: number;
  lastActivityAt: number;
  lastHookAt: number | null;
  lastTranscriptAt: number | null;
  endedAt: number | null;
  state: LifecycleState;
  agentCount: number;
  eventCount: number;
  toolCallCount: number;
  openToolCount: number;
  errorCount: number;
  warningCount: number;
  updatedSeq: number;
  updatedAt: number;
}

export interface AttemptCandidate {
  sessionRowId: number;
  sessionId: string;
  label: string;
  matched: boolean;
  firstRecordAtMs: number | null;
  lastActivityAtMs: number;
}

/** `[02 7.13]` `CompletionCandidate`. */
export interface CompletionCandidate {
  sessionId: string;
  label: string;
  startedAt: number | null;
  lastActivityAt: number | null;
  view: StoredView;
}

export interface NewSession {
  sessionUid: string;
  projectId: number | null;
  startedAt: number;
}

/**
 * Columns `update` may write. A key that is absent is not touched; `null` sets NULL where the column allows it.
 * Counters and rollups are written by the code that owns them (the writer, `UsageRepo`).
 */
export interface SessionPatch {
  transcriptFileId?: number | null;
  label?: string;
  labelSource?: string;
  matched?: boolean;
  ruleIndex?: number | null;
  pinned?: boolean;
  titleAi?: string | null;
  titleCustom?: string | null;
  searchText?: string;
  entrypoint?: string | null;
  ccVersion?: string | null;
  cwd?: string | null;
  gitBranch?: string | null;
  permissionMode?: string | null;
  lastModel?: string | null;
  claudePid?: number | null;
  continuedIn?: string | null;
  copiedFrom?: string | null;
  hookCoverage?: string;
  hookMissingTools?: number;
  hookMissingTurns?: number;
  startedAt?: number;
  lastActivityAt?: number;
  lastHookAt?: number | null;
  lastTranscriptAt?: number | null;
  endedAt?: number | null;
  agentCount?: number;
  eventCount?: number;
  toolCallCount?: number;
  openToolCount?: number;
  errorCount?: number;
  warningCount?: number;
  usageStatus?: string;
  reportedCostUsd?: number | null;
  reportedCostAt?: number | null;
}

function patchEntries(p: SessionPatch): PatchEntries {
  return [
    ['transcript_file_id', p.transcriptFileId],
    ['label', p.label],
    ['label_source', p.labelSource],
    ['matched', p.matched],
    ['rule_index', p.ruleIndex],
    ['pinned', p.pinned],
    ['title_ai', p.titleAi],
    ['title_custom', p.titleCustom],
    ['search_text', p.searchText],
    ['entrypoint', p.entrypoint],
    ['cc_version', p.ccVersion],
    ['cwd', p.cwd],
    ['git_branch', p.gitBranch],
    ['permission_mode', p.permissionMode],
    ['last_model', p.lastModel],
    ['claude_pid', p.claudePid],
    ['continued_in', p.continuedIn],
    ['copied_from', p.copiedFrom],
    ['hook_coverage', p.hookCoverage],
    ['hook_missing_tools', p.hookMissingTools],
    ['hook_missing_turns', p.hookMissingTurns],
    ['started_at', p.startedAt],
    ['last_activity_at', p.lastActivityAt],
    ['last_hook_at', p.lastHookAt],
    ['last_transcript_at', p.lastTranscriptAt],
    ['ended_at', p.endedAt],
    ['agent_count', p.agentCount],
    ['event_count', p.eventCount],
    ['tool_call_count', p.toolCallCount],
    ['open_tool_count', p.openToolCount],
    ['error_count', p.errorCount],
    ['warning_count', p.warningCount],
    ['usage_status', p.usageStatus],
    ['reported_cost_usd', p.reportedCostUsd],
    ['reported_cost_at', p.reportedCostAt],
  ];
}

const VIEW_KEY_COLUMNS = `state, presence, wait_reason AS waitReason, stale_kind AS staleKind, end_reason AS endReason,
  turn_outcome AS turnOutcome, state_basis AS basis, state_confidence AS confidence, state_rule AS ruleId`;

const VIEW_COLUMNS = `${VIEW_KEY_COLUMNS}, state_evidence AS evidence, state_since AS since,
  coalesce(evaluated_at, 0) AS evaluatedAt, next_check_at AS nextCheckAt`;

const WRITE_VIEW_SQL = `UPDATE sessions SET state = :state, presence = :presence, wait_reason = :waitReason,
    stale_kind = :staleKind, end_reason = :endReason, turn_outcome = :turnOutcome, state_basis = :basis,
    state_confidence = :confidence, state_rule = :ruleId, state_evidence = :evidence, state_since = :since,
    evaluated_at = :evaluatedAt, next_check_at = :nextCheckAt, facts_json = :factsJson, updated_at = :now,
    updated_seq = coalesce(:seq, updated_seq)
  WHERE id = :id`;

const SESSION_COLUMNS = `id, session_uid AS sessionUid, project_id AS projectId, transcript_file_id AS transcriptFileId,
  label, label_source AS labelSource, matched, pinned, cwd, claude_pid AS claudePid, hook_coverage AS hookCoverage,
  first_seen_at AS firstSeenAt, started_at AS startedAt, last_activity_at AS lastActivityAt, last_hook_at AS lastHookAt,
  last_transcript_at AS lastTranscriptAt, ended_at AS endedAt, state, agent_count AS agentCount,
  event_count AS eventCount, tool_call_count AS toolCallCount, open_tool_count AS openToolCount,
  error_count AS errorCount, warning_count AS warningCount, updated_seq AS updatedSeq, updated_at AS updatedAt`;

interface SessionDbRow extends Omit<SessionRow, 'matched' | 'pinned'> {
  matched: number;
  pinned: number;
}

/** Labels per `attemptCandidates` statement (03 3.6). */
const MAX_LABELS_PER_QUERY = 500;
/** The activity prefilter is widened by one hour; 06 3.10.6 applies the exact window (03 3.6). */
const ACTIVITY_SLACK_MS = 3_600_000;

/**
 * The statement of 03 3.6 (normative). It has no `ORDER BY`: with one the planner leaves `idx_sessions_activity` (03 3.7)
 * and scans every session on each attempts tick. `attemptCandidates` sorts the small result in code.
 */
export const ATTEMPT_CANDIDATES_SQL = `SELECT s.id AS sessionRowId, s.session_uid AS sessionId, s.label AS label,
        (s.matched = 1 OR s.pinned = 1) AS matched,
        f.first_ts_in_order AS firstTs, coalesce(f.mtime_seen, s.last_activity_at) AS lastActivityAt
 FROM sessions s LEFT JOIN transcript_files f ON f.id = s.transcript_file_id
 WHERE s.last_activity_at >= :since - ${String(ACTIVITY_SLACK_MS)}
   AND s.label IN (SELECT value FROM json_each(:labelsJson))`;

interface CandidateDbRow {
  sessionRowId: number;
  sessionId: string;
  label: string;
  matched: number;
  firstTs: string | null;
  lastActivityAt: number;
}

interface CompletionDbRow extends ViewDbRow {
  sessionId: string;
  label: string;
  startedAt: number;
  lastActivityAt: number;
}

export class SessionsRepo {
  private readonly db: InstanceDb;
  private readonly transitions: TransitionsRepo;

  constructor(db: InstanceDb) {
    this.db = db;
    this.transitions = new TransitionsRepo(db);
  }

  /**
   * The session and its main agent (03 3.6), idempotent: the earlier start wins and a known project stays.
   * `created` is true when the session row did not exist.
   */
  ensure(ctx: RepoContext, tx: WriteTx, s: NewSession): { id: number; agentId: number; created: boolean } {
    this.db.assertScope(ctx);
    const { driver } = this.db;
    const created =
      driver.prepare('SELECT 1 FROM sessions WHERE session_uid = :uid').get({ uid: s.sessionUid }) === undefined;
    const row = driver
      .prepare<{ id: number }>(
        `INSERT INTO sessions (session_uid, project_id, first_seen_at, started_at, last_activity_at, updated_at)
         VALUES (:uid, :projectId, :now, :startedAt, :startedAt, :now)
         ON CONFLICT(session_uid) DO UPDATE SET
           started_at = min(sessions.started_at, excluded.started_at),
           project_id = coalesce(sessions.project_id, excluded.project_id)
         RETURNING id`,
      )
      .get({ uid: s.sessionUid, projectId: s.projectId, startedAt: s.startedAt, now: tx.now });
    if (row === undefined) throw new Error('INSERT ... RETURNING answered no row');
    driver
      .prepare(
        `INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at)
         VALUES (:sessionId, 'main', NULL, 'main', 0, :now, :startedAt, :startedAt, :now)
         ON CONFLICT(session_id, agent_uid) DO NOTHING`,
      )
      .run({ sessionId: row.id, startedAt: s.startedAt, now: tx.now });
    const agent = driver
      .prepare<{ id: number }>("SELECT id FROM agents WHERE session_id = :sessionId AND agent_uid = 'main'")
      .get({ sessionId: row.id });
    if (agent === undefined) throw new Error('the main agent row is missing right after its insert');
    return { id: row.id, agentId: agent.id, created };
  }

  idByUid(ctx: RepoContext, sessionUid: string): number | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<{ id: number }>('SELECT id FROM sessions WHERE session_uid = :uid')
      .get({ uid: sessionUid })?.id;
  }

  byUid(ctx: RepoContext, sessionUid: string): SessionRow | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver
      .prepare<SessionDbRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_uid = :uid`)
      .get({ uid: sessionUid });
    return row === undefined ? undefined : { ...row, matched: row.matched === 1, pinned: row.pinned === 1 };
  }

  /**
   * True when a row was written. A transcript file that does not exist is refused (03 3.4). `seq` is the change the caller reserved for this write, or null to leave `updated_seq`. */
  update(ctx: RepoContext, tx: WriteTx, id: number, patch: SessionPatch, seq: number | null): boolean {
    this.db.assertScope(ctx);
    requireTranscriptFile(this.db, patch.transcriptFileId);
    return patchRow(this.db, 'sessions', id, patchEntries(patch), seq, tx.now);
  }

  /**
   * Stores the lifecycle view and the facts (03 3.6 "Lifecycle views"). A change is recorded only when one of the nine
   * fields of `viewChanged` differs: then `updated_seq` carries a reserved `session/upsert`, and a changed `state` also
   * writes one `state_transitions` row. Facts, evidence wording and times are stored every time and record nothing.
   * `undefined` = no such session.
   */
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
      .prepare<ViewKeyRow & { sessionUid: string }>(
        `SELECT session_uid AS sessionUid, ${VIEW_KEY_COLUMNS} FROM sessions WHERE id = :id`,
      )
      .get({ id });
    if (old === undefined) return undefined;
    const changed = viewKeyChanged(old, view);
    const seq = changed ? tx.changes.reserve('session', 'upsert', { entityId: id, sessionUid: old.sessionUid }) : null;
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
        sessionId: id,
        agentId: null,
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

  /** The stored view and facts, as the lifecycle sweeper reads them. */
  readView(ctx: RepoContext, id: number): { view: StoredView; factsJson: string } | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver
      .prepare<ViewDbRow & { factsJson: string }>(
        `SELECT ${VIEW_COLUMNS}, facts_json AS factsJson FROM sessions WHERE id = :id`,
      )
      .get({ id });
    if (row === undefined) return undefined;
    const { factsJson, ...view } = row;
    return { view: viewFromRow(view), factsJson };
  }

  /** Rows whose `next_check_at` has passed, earliest first (`idx_sessions_next_check`). */
  dueForCheck(ctx: RepoContext, now: number, limit: number): { id: number; sessionUid: string }[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<{ id: number; sessionUid: string }>(
        `SELECT id, session_uid AS sessionUid FROM sessions
         WHERE next_check_at IS NOT NULL AND next_check_at <= :now ORDER BY next_check_at, id LIMIT :limit`,
      )
      .all({ now, limit: rowLimit(limit) });
  }

  /** Row id -> `session_uid` for the ids that exist (06 3.10.2, N-10): the primary key through `json_each`. */
  uidsByRowIds(ctx: RepoContext, rowIds: readonly number[]): Map<number, string> {
    this.db.assertScope(ctx);
    const result = new Map<number, string>();
    if (rowIds.length === 0) return result;
    const rows = this.db.driver
      .prepare<{ id: number; sessionUid: string }>(
        'SELECT id, session_uid AS sessionUid FROM sessions WHERE id IN (SELECT value FROM json_each(:idsJson))',
      )
      .all({ idsJson: JSON.stringify([...new Set(rowIds)]) });
    for (const row of rows) result.set(row.id, row.sessionUid);
    return result;
  }

  /**
   * Sessions that may match an attempt label (06 3.10.6). The one hour of slack only widens the prefilter
   * (`idx_sessions_activity`); the caller applies the exact window and delta rules. At most 500 labels per statement.
   */
  attemptCandidates(ctx: RepoContext, labels: readonly string[], activeSinceMs: number): AttemptCandidate[] {
    this.db.assertScope(ctx);
    const distinct = [...new Set(labels)];
    const found: AttemptCandidate[] = [];
    const statement = this.db.driver.prepare<CandidateDbRow>(ATTEMPT_CANDIDATES_SQL);
    for (let start = 0; start < distinct.length; start += MAX_LABELS_PER_QUERY) {
      const chunk = distinct.slice(start, start + MAX_LABELS_PER_QUERY);
      for (const row of statement.all({ since: activeSinceMs, labelsJson: JSON.stringify(chunk) })) {
        const first = row.firstTs === null ? Number.NaN : Date.parse(row.firstTs);
        found.push({
          sessionRowId: row.sessionRowId,
          sessionId: row.sessionId,
          label: row.label,
          matched: row.matched === 1,
          firstRecordAtMs: Number.isNaN(first) ? null : first,
          lastActivityAtMs: row.lastActivityAt,
        });
      }
    }
    return found.sort((a, b) => a.sessionRowId - b.sessionRowId);
  }

  /**
   * The sessions `explainCompletion` may mean (02 7.13, I-08): by provider id (unique index) or by exact,
   * case-sensitive label (a scan of `sessions`, 03 O-5). The view is rebuilt from the stored columns.
   */
  completionCandidates(ctx: RepoContext, by: { sessionId: string } | { label: string }): CompletionCandidate[] {
    this.db.assertScope(ctx);
    const select = `SELECT session_uid AS sessionId, label, started_at AS startedAt, last_activity_at AS lastActivityAt,
        ${VIEW_COLUMNS} FROM sessions`;
    const rows =
      'sessionId' in by
        ? this.db.driver
            .prepare<CompletionDbRow>(`${select} WHERE session_uid = :id ORDER BY id`)
            .all({ id: by.sessionId })
        : this.db.driver
            .prepare<CompletionDbRow>(`${select} WHERE label = :label ORDER BY started_at, id`)
            .all({ label: by.label });
    return rows.map(({ sessionId, label, startedAt, lastActivityAt, ...view }) => ({
      sessionId,
      label,
      startedAt,
      lastActivityAt,
      view: viewFromRow(view),
    }));
  }
}
