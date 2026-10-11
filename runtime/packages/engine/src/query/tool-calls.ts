// `listToolCalls` and `toolCallsByIds` (03 5.3, 5.4, 6.1, 12.1). One row per tool call (`tool_use_id`) with its derived
// status (03 5.5: the stored outcome, else pending or unknown). The `q` filter needs a session or a window of at most
// 7 days (`filter_requires_scope`, 03 3.7 rule 2); every statement has a `LIMIT`.
import { foldQuery, type Page, type ToolCallItem, type ToolCallListQuery } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import type { QueryDeps } from '../runtime/context.ts';
import {
  Binder,
  NotFoundError,
  QueryRefusal,
  agentRowId,
  filterOf,
  idsParam,
  isNarrow,
  isoOrNull,
  likeContains,
  numericKey,
  pageOf,
  readCursor,
  resolveWindow,
  snapshot,
  toolStatusOf,
  toolStatusSql,
  writeCursor,
  type PageSpec,
  type PathSessionOptions,
} from './transitions.ts';

export interface ToolCallQueries {
  listToolCalls(ctx: RepoContext, q: ToolCallListQuery, options?: PathSessionOptions): Page<ToolCallItem>;
  /** Hydration of a `tool_call/upsert` frame (03 9.3): the calls that exist, ascending by id. */
  toolCallsByIds(ctx: RepoContext, ids: readonly number[]): ToolCallItem[];
}

interface ToolCallDbRow {
  id: number;
  seq: number;
  toolUseId: string;
  sessionUid: string;
  agentUid: string | null;
  promptId: string | null;
  name: string;
  mcpServer: string | null;
  outcome: ToolCallItem['outcome'];
  summary: string | null;
  inputBytes: number | null;
  startedAt: number | null;
  endedAt: number | null;
  batchAt: number | null;
  durationMs: number | null;
  durationSource: ToolCallItem['durationSource'];
  exitCode: number | null;
  sources: number;
  subagentUid: string | null;
  runUid: string | null;
  callFileId: number | null;
  callOffset: number | null;
  resultFileId: number | null;
  resultOffset: number | null;
  sortKey?: number;
}

const TOOL_COLUMNS = `t.id AS id, t.updated_seq AS seq, t.tool_use_id AS toolUseId, s.session_uid AS sessionUid,
  a.agent_uid AS agentUid, t.prompt_id AS promptId, t.name AS name, t.mcp_server AS mcpServer, t.outcome AS outcome,
  t.summary AS summary, t.input_bytes AS inputBytes, t.started_at AS startedAt, t.ended_at AS endedAt,
  t.batch_at AS batchAt, t.duration_ms AS durationMs, t.duration_source AS durationSource, t.exit_code AS exitCode,
  t.sources AS sources, sa.agent_uid AS subagentUid, wr.run_uid AS runUid, t.call_file_id AS callFileId,
  t.call_offset AS callOffset, t.result_file_id AS resultFileId, t.result_offset AS resultOffset`;

const TOOL_FROM = `tool_calls t JOIN sessions s ON s.id = t.session_id LEFT JOIN agents a ON a.id = t.agent_id
  LEFT JOIN agents sa ON sa.id = t.subagent_id LEFT JOIN workflow_runs wr ON wr.id = t.workflow_run_id`;

const SORT_EXPRESSIONS: Readonly<Record<ToolCallListQuery['sort'], string>> = {
  started: 'coalesce(t.started_at, t.ended_at, 0)',
  duration: 'coalesce(t.duration_ms, -1)',
};

function sourcesOf(bits: number): ToolCallItem['sources'] {
  const out: ToolCallItem['sources'] = [];
  if ((bits & 1) !== 0) out.push('hook_pre');
  if ((bits & 2) !== 0) out.push('hook_post');
  if ((bits & 4) !== 0) out.push('transcript_use');
  if ((bits & 8) !== 0) out.push('transcript_result');
  if ((bits & 16) !== 0) out.push('hook_batch');
  return out;
}

function toolCallItems(rows: readonly ToolCallDbRow[]): ToolCallItem[] {
  return rows.map((row): ToolCallItem => {
    const agentId = row.agentUid ?? 'main';
    const call =
      row.callFileId !== null && row.callOffset !== null
        ? { agentId, offset: row.callOffset }
        : row.resultFileId !== null && row.resultOffset !== null
          ? { agentId, offset: row.resultOffset }
          : null;
    return {
      id: row.id,
      seq: row.seq,
      toolUseId: row.toolUseId,
      sessionId: row.sessionUid,
      agentId,
      promptId: row.promptId,
      name: row.name,
      mcpServer: row.mcpServer,
      status: toolStatusOf(row.outcome, row.endedAt, row.batchAt),
      outcome: row.outcome,
      summary: row.summary,
      inputBytes: row.inputBytes,
      startedAt: isoOrNull(row.startedAt),
      endedAt: isoOrNull(row.endedAt),
      batchAt: isoOrNull(row.batchAt),
      durationMs: row.durationMs,
      durationSource: row.durationSource,
      exitCode: row.exitCode,
      sources: sourcesOf(row.sources),
      subagentId: row.subagentUid,
      workflowRunId: row.runUid,
      transcriptRef: call,
    };
  });
}

/** The most `toolCallsByIds` answers in one call (a frame carries at most 50). */
const MAX_BY_IDS = 500;

export function createToolCallQueries(db: InstanceDb, deps: QueryDeps): ToolCallQueries {
  return {
    listToolCalls: (ctx, q, options = {}) =>
      snapshot(db, ctx, (asOfSeq) => {
        const dir = q.dir ?? 'desc';
        const spec: PageSpec = { route: 'listToolCalls', sort: q.sort, dir, filter: filterOf(q) };
        const resume = readCursor(q.cursor, spec);
        const window = resolveWindow(deps, q, options.pathSession === true ? 'all' : '24h', resume);
        if (q.q !== undefined && q.session === undefined && !isNarrow(window)) {
          throw new QueryRefusal('filter_requires_scope');
        }
        const bind = new Binder();
        const where: string[] = [];
        let sessionIds: number[] | null = null;
        if (q.session !== undefined) {
          const lookup = new Binder();
          sessionIds = db.driver
            .prepare<{ id: number }>(`SELECT id FROM sessions WHERE session_uid IN ${lookup.list(q.session)}`)
            .all(lookup.params)
            .map((row) => row.id);
          if (options.pathSession === true && sessionIds.length === 0) throw new NotFoundError('session_not_found');
          where.push(sessionIds.length === 0 ? '0' : `t.session_id IN ${bind.list(sessionIds)}`);
        }
        if (q.agent !== undefined) {
          const only = sessionIds?.[0];
          if (only === undefined) throw new NotFoundError('session_not_found');
          const found = agentRowId(db, only, q.agent);
          if (found === undefined) throw new NotFoundError('agent_not_found');
          where.push(`t.agent_id = ${bind.bind(found)}`);
        }
        if (q.project !== undefined) {
          where.push(
            `t.session_id IN (SELECT id FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE project_key IN ${bind.list(q.project)}))`,
          );
        }
        if (q.tool !== undefined) where.push(`t.name IN ${bind.list(q.tool)}`);
        if (q.status !== undefined) where.push(`${toolStatusSql('t')} IN ${bind.list(q.status)}`);
        if (q.q !== undefined) {
          const pattern = bind.bind(likeContains(foldQuery(q.q)));
          where.push(`(t.summary LIKE ${pattern} ESCAPE '\\' OR t.name LIKE ${pattern} ESCAPE '\\')`);
        }
        const when = 'coalesce(t.started_at, t.ended_at)';
        if (window.fromMs !== null) where.push(`${when} >= ${bind.bind(window.fromMs)}`);
        where.push(`(${when} IS NULL OR ${when} < ${bind.bind(window.toMs)})`);
        const expression = SORT_EXPRESSIONS[q.sort];
        if (resume !== null) {
          const op = dir === 'desc' ? '<' : '>';
          const k = bind.bind(numericKey(resume));
          where.push(`(${expression} ${op} ${k} OR (${expression} = ${k} AND t.id ${op} ${bind.bind(resume.i)}))`);
        }
        const direction = dir.toUpperCase();
        const rows = db.driver
          .prepare<ToolCallDbRow>(
            `SELECT ${TOOL_COLUMNS}, ${expression} AS sortKey FROM ${TOOL_FROM}
              WHERE ${where.join(' AND ')} ORDER BY ${expression} ${direction}, t.id ${direction}
              LIMIT ${bind.bind(q.limit + 1)}`,
          )
          .all(bind.params);
        const page = rows.slice(0, q.limit);
        const last = page[page.length - 1];
        const nextCursor =
          rows.length > q.limit && last?.sortKey !== undefined
            ? writeCursor(spec, last.sortKey, last.id, window)
            : null;
        return pageOf(toolCallItems(page), { nextCursor, asOfSeq, limit: q.limit });
      }),

    toolCallsByIds: (ctx, ids) =>
      snapshot(db, ctx, () => {
        if (ids.length === 0) return [];
        const rows = db.driver
          .prepare<ToolCallDbRow>(
            `SELECT ${TOOL_COLUMNS} FROM ${TOOL_FROM}
              WHERE t.id IN (SELECT value FROM json_each(:ids)) ORDER BY t.id LIMIT :limit`,
          )
          .all({ ids: idsParam(ids), limit: MAX_BY_IDS });
        return toolCallItems(rows);
      }),
  };
}
