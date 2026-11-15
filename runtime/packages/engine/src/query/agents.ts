// `sessionAgents`, `listAgents`, `agentNode` and `workflowRun` (03 5.3, 5.4, 6.1, 12.1). An `AgentNode` is read from the
// `agents` row, its rollup columns (usage), its parent, its workflow run and its transcript file; nothing here reads
// transcript content. Agent labels fall back to the agent type, then to the agent id (03 5.5).
import {
  foldQuery,
  expandStateFilter,
  type AgentListQuery,
  type AgentNode,
  type Page,
  type SessionAgentsQuery,
  type StateAssessment,
  type WorkflowRunItem,
} from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import { instanceKindOfConfig, unmatchedVisible } from '../projects/scope.ts';
import type { QueryDeps } from '../runtime/context.ts';
import {
  Binder,
  FILE_COLUMNS,
  NotFoundError,
  assessmentOf,
  consumedBytes,
  filterOf,
  idsParam,
  iso,
  isoOrNull,
  legacyOf,
  likeContains,
  numericKey,
  apiEvidence,
  pageOf,
  readCursor,
  resolveWindow,
  sessionRowId,
  snapshot,
  tokenUsageOf,
  viewColumns,
  writeCursor,
  type FileFacts,
  type PageSpec,
  type ViewRow,
} from './transitions.ts';

export interface AgentQueries {
  sessionAgents(ctx: RepoContext, sessionId: string, q: SessionAgentsQuery): Page<AgentNode>;
  listAgents(ctx: RepoContext, q: AgentListQuery): Page<AgentNode>;
  /** Hydration (03 9.3): `null` when the row no longer exists. */
  agentNode(ctx: RepoContext, agentRowId: number): AgentNode | null;
  workflowRun(ctx: RepoContext, runRowId: number): WorkflowRunItem | null;
}

interface AgentDbRow extends ViewRow {
  id: number;
  uid: string;
  sessionUid: string;
  kind: AgentNode['kind'];
  depth: number;
  parentUid: string | null;
  spawnToolUseId: string | null;
  agentType: string | null;
  label: string;
  requestShape: AgentNode['requestShape'];
  workflowPhase: string | null;
  runUid: string | null;
  runName: string | null;
  runState: NonNullable<AgentNode['workflow']>['state'] | null;
  model: string | null;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  toolCallCount: number;
  errorCount: number;
  usageMessages: number;
  usageSynthetic: number;
  usageUnfinalized: number;
  tokInput: number;
  tokOutput: number;
  tokCacheRead: number;
  tokCacheCreation: number;
  missInput: number;
  missOutput: number;
  missCacheRead: number;
  missCacheCreation: number;
  fileId: number | null;
  updatedSeq: number;
  sortKey?: number;
}

const AGENT_COLUMNS = `a.id AS id, a.agent_uid AS uid, s.session_uid AS sessionUid, a.kind AS kind, a.depth AS depth,
  pa.agent_uid AS parentUid, a.spawn_tool_use_id AS spawnToolUseId, a.agent_type AS agentType, a.label AS label,
  a.request_shape AS requestShape, a.workflow_phase AS workflowPhase, wr.run_uid AS runUid,
  wr.workflow_name AS runName, wr.state AS runState, a.model AS model, a.started_at AS startedAt,
  a.last_activity_at AS lastActivityAt, a.ended_at AS endedAt, a.tool_call_count AS toolCallCount,
  a.error_count AS errorCount, a.usage_messages AS usageMessages, a.usage_synthetic AS usageSynthetic,
  a.usage_unfinalized AS usageUnfinalized, a.tok_input AS tokInput, a.tok_output AS tokOutput,
  a.tok_cache_read AS tokCacheRead, a.tok_cache_creation AS tokCacheCreation, a.tok_input_missing AS missInput,
  a.tok_output_missing AS missOutput, a.tok_cache_read_missing AS missCacheRead,
  a.tok_cache_creation_missing AS missCacheCreation, a.transcript_file_id AS fileId, a.updated_seq AS updatedSeq,
  ${viewColumns('a')}`;

const AGENT_FROM = `agents a JOIN sessions s ON s.id = a.session_id LEFT JOIN agents pa ON pa.id = a.parent_agent_id
  LEFT JOIN workflow_runs wr ON wr.id = a.workflow_run_id`;

function agentNodes(db: InstanceDb, deps: QueryDeps, rows: readonly AgentDbRow[]): AgentNode[] {
  if (rows.length === 0) return [];
  const fileIds = rows.flatMap((row) => (row.fileId === null ? [] : [row.fileId]));
  const files = new Map<number, FileFacts>();
  if (fileIds.length > 0) {
    for (const file of db.driver
      .prepare<FileFacts>(
        `SELECT ${FILE_COLUMNS} FROM transcript_files f WHERE f.id IN (SELECT value FROM json_each(:ids))`,
      )
      .all({ ids: idsParam(fileIds) })) {
      files.set(file.fileId, file);
    }
  }
  const nowMs = deps.now();
  return rows.map((row): AgentNode => {
    const file = row.fileId === null ? undefined : files.get(row.fileId);
    return {
      id: row.uid,
      seq: row.updatedSeq,
      sessionId: row.sessionUid,
      kind: row.kind,
      depth: row.depth,
      parentAgentId: row.parentUid,
      parentToolUseId: row.spawnToolUseId,
      agentType: row.agentType,
      label: row.label !== '' ? row.label : (row.agentType ?? row.uid),
      workflow:
        row.runUid === null || row.runState === null
          ? null
          : { runId: row.runUid, name: row.runName, phase: row.workflowPhase, state: row.runState },
      requestShape: row.requestShape,
      model: row.model,
      startedAt: iso(row.startedAt),
      lastActivityAt: iso(row.lastActivityAt),
      endedAt: isoOrNull(row.endedAt),
      state: assessmentOf(row, nowMs),
      usage: tokenUsageOf(
        {
          messages: row.usageMessages,
          synthetic: row.usageSynthetic,
          unfinalized: row.usageUnfinalized,
          input: row.tokInput,
          output: row.tokOutput,
          cacheRead: row.tokCacheRead,
          cacheCreation: row.tokCacheCreation,
          missingInput: row.missInput,
          missingOutput: row.missOutput,
          missingCacheRead: row.missCacheRead,
          missingCacheCreation: row.missCacheCreation,
        },
        file === undefined ? [] : [file],
      ),
      toolCallCount: row.toolCallCount,
      errorCount: row.errorCount,
      transcript:
        file === undefined ? null : { state: file.state, sizeBytes: file.sizeSeen, importedBytes: consumedBytes(file) },
    };
  });
}

// ---- workflow runs ---------------------------------------------------------------------------------------------------------

interface RunDbRow {
  runUid: string;
  updatedSeq: number;
  sessionUid: string;
  name: string | null;
  agentCount: number | null;
  started: number;
  results: number;
  failed: number;
  startedAt: number | null;
  endedAt: number | null;
  state: StateAssessment['state'];
  staleKind: StateAssessment['staleKind'];
  basis: StateAssessment['basis'];
  confidence: StateAssessment['confidence'];
  ruleId: string;
  evidence: string;
  since: number | null;
  evaluatedAt: number | null;
}

function runItem(row: RunDbRow, nowMs: number): WorkflowRunItem {
  return {
    runId: row.runUid,
    seq: row.updatedSeq,
    sessionId: row.sessionUid,
    name: row.name,
    // a run has no presence axis, wait reason, end reason or turn outcome (02 7.1): they read as unknown or null
    state: {
      state: row.state,
      presence: 'unknown',
      waitReason: null,
      staleKind: row.staleKind,
      endReason: null,
      turnOutcome: null,
      basis: row.basis,
      confidence: row.confidence,
      rule: row.ruleId,
      evidence: apiEvidence(row.evidence, nowMs),
      since: isoOrNull(row.since),
      evaluatedAt: row.evaluatedAt === null || row.evaluatedAt === 0 ? null : isoOrNull(row.evaluatedAt),
      legacyState: legacyOf(row.state),
    },
    agentCount: row.agentCount,
    started: row.started,
    results: row.results,
    failed: row.failed,
    startedAt: isoOrNull(row.startedAt),
    endedAt: isoOrNull(row.endedAt),
  };
}

// ---- the part --------------------------------------------------------------------------------------------------------------

/** `depth` and `started_at` as one number, so that the agents of a session page by one keyset key (started_at < 1e13). */
const DEPTH_STEP = 10_000_000_000_000;
const TREE_KEY = `(a.depth * ${String(DEPTH_STEP)} + a.started_at)`;

export function createAgentQueries(db: InstanceDb, deps: QueryDeps): AgentQueries {
  return {
    sessionAgents: (ctx, sessionId, q) =>
      snapshot(db, ctx, (asOfSeq) => {
        const sid = sessionRowId(db, sessionId);
        if (sid === undefined) throw new NotFoundError('session_not_found');
        const spec: PageSpec = {
          route: 'sessionAgents',
          sort: 'tree',
          dir: 'asc',
          filter: filterOf(q, { sessionId }),
        };
        const resume = readCursor(q.cursor, spec);
        const bind = new Binder();
        const where = [`a.session_id = ${bind.bind(sid)}`];
        if (q.state !== undefined) where.push(`a.state IN ${bind.list(expandStateFilter(q.state))}`);
        if (q.includeInternal !== true) where.push("a.kind <> 'internal'");
        if (resume !== null) {
          const k = bind.bind(numericKey(resume));
          where.push(`(${TREE_KEY} > ${k} OR (${TREE_KEY} = ${k} AND a.id > ${bind.bind(resume.i)}))`);
        }
        const rows = db.driver
          .prepare<AgentDbRow>(
            `SELECT ${AGENT_COLUMNS}, ${TREE_KEY} AS sortKey FROM ${AGENT_FROM}
              WHERE ${where.join(' AND ')} ORDER BY ${TREE_KEY}, a.id LIMIT ${bind.bind(q.limit + 1)}`,
          )
          .all(bind.params);
        const page = rows.slice(0, q.limit);
        const last = page[page.length - 1];
        const nextCursor =
          rows.length > q.limit && last?.sortKey !== undefined ? writeCursor(spec, last.sortKey, last.id, null) : null;
        return pageOf(agentNodes(db, deps, page), { nextCursor, asOfSeq, limit: q.limit });
      }),

    listAgents: (ctx, q) =>
      snapshot(db, ctx, (asOfSeq) => {
        const dir = q.dir ?? 'desc';
        const spec: PageSpec = { route: 'listAgents', sort: q.sort, dir, filter: filterOf(q) };
        const resume = readCursor(q.cursor, spec);
        const window = resolveWindow(deps, q, 'window', resume);
        const bind = new Binder();
        const where: string[] = [];
        if (window.fromMs !== null) {
          const pinned = window.source === 'window_hours' ? ' OR s.pinned = 1' : '';
          where.push(`(a.last_activity_at >= ${bind.bind(window.fromMs)}${pinned})`);
        }
        where.push(`a.started_at < ${bind.bind(window.toMs)}`);
        if (q.state !== undefined) where.push(`a.state IN ${bind.list(expandStateFilter(q.state))}`);
        if (q.kind !== undefined) where.push(`a.kind IN ${bind.list(q.kind)}`);
        if (q.q !== undefined) {
          const pattern = bind.bind(likeContains(foldQuery(q.q)));
          where.push(`(a.label LIKE ${pattern} ESCAPE '\\' OR a.agent_type LIKE ${pattern} ESCAPE '\\')`);
        }
        if (q.session !== undefined) where.push(`s.session_uid IN ${bind.list(q.session)}`);
        if (q.project !== undefined) {
          where.push(`s.project_id IN (SELECT id FROM projects WHERE project_key IN ${bind.list(q.project)})`);
        }
        if (q.hasErrors === true) where.push('a.error_count > 0');
        if (q.includeInternal !== true && q.kind?.includes('internal') !== true) where.push("a.kind <> 'internal'");
        if (!unmatchedVisible(deps.config, instanceKindOfConfig(deps.config), q)) {
          where.push('(s.matched = 1 OR s.pinned = 1)');
        }
        const expression = q.sort === 'started' ? 'a.started_at' : 'a.last_activity_at';
        if (resume !== null) {
          const op = dir === 'desc' ? '<' : '>';
          const k = bind.bind(numericKey(resume));
          where.push(`(${expression} ${op} ${k} OR (${expression} = ${k} AND a.id ${op} ${bind.bind(resume.i)}))`);
        }
        const direction = dir.toUpperCase();
        const rows = db.driver
          .prepare<AgentDbRow>(
            `SELECT ${AGENT_COLUMNS}, ${expression} AS sortKey FROM ${AGENT_FROM}
              WHERE ${where.join(' AND ')} ORDER BY ${expression} ${direction}, a.id ${direction}
              LIMIT ${bind.bind(q.limit + 1)}`,
          )
          .all(bind.params);
        const page = rows.slice(0, q.limit);
        const last = page[page.length - 1];
        const nextCursor =
          rows.length > q.limit && last?.sortKey !== undefined
            ? writeCursor(spec, last.sortKey, last.id, window)
            : null;
        return pageOf(agentNodes(db, deps, page), { nextCursor, asOfSeq, limit: q.limit });
      }),

    agentNode: (ctx, agentRowId) =>
      snapshot(db, ctx, () => {
        const row = db.driver
          .prepare<AgentDbRow>(`SELECT ${AGENT_COLUMNS} FROM ${AGENT_FROM} WHERE a.id = :id`)
          .get({ id: agentRowId });
        return row === undefined ? null : (agentNodes(db, deps, [row])[0] ?? null);
      }),

    workflowRun: (ctx, runRowId) =>
      snapshot(db, ctx, () => {
        const row = db.driver
          .prepare<RunDbRow>(
            `SELECT wr.run_uid AS runUid, wr.updated_seq AS updatedSeq, s.session_uid AS sessionUid,
                    wr.workflow_name AS name, wr.agent_count AS agentCount, wr.started_count AS started,
                    wr.result_count AS results, wr.failed_count AS failed, wr.started_at AS startedAt,
                    wr.ended_at AS endedAt, wr.state AS state, wr.stale_kind AS staleKind, wr.state_basis AS basis,
                    wr.state_confidence AS confidence, wr.state_rule AS ruleId, wr.state_evidence AS evidence,
                    wr.state_since AS since, wr.evaluated_at AS evaluatedAt
               FROM workflow_runs wr JOIN sessions s ON s.id = wr.session_id WHERE wr.id = :id`,
          )
          .get({ id: runRowId });
        return row === undefined ? null : runItem(row, deps.now());
      }),
  };
}
