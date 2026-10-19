// `listSessions`, `getSession` and `sessionSummaries` (03 5.3, 5.4, 6.1, 6.3, 12.1). One page costs the page query plus a
// handful of indexed statements over the page ids (work items, active agents, the main agent's usage rollup, the transcript files
// and the reported cost state); nothing here reads a transcript or an event. `getSession` returns `auditRefs: []`: the
// route handler awaits `sessionAuditRefs` after the snapshot and attaches it (I-19).
//
// Not implemented here: `cost` is `null` (the cost estimate of 03 8.3 belongs to the analytics work package, WP-58; no
// prices ship, D15).
import {
  ACTIVE_STATES,
  LIFECYCLE_STATES,
  expandStateFilter,
  foldQuery,
  type DetailRecord,
  type Page,
  type SessionDetail,
  type SessionListQuery,
  type SessionSummary,
} from '@mcs/shared';

import type { SqlValue } from '../db/driver.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import type { QueryDeps } from '../runtime/context.ts';
import {
  Binder,
  FILE_COLUMNS,
  NO_USAGE,
  NotFoundError,
  TOTAL_CAP,
  assessmentOf,
  behindBytes,
  consumedBytes,
  filterOf,
  flatRecord,
  idsParam,
  iso,
  isoOrNull,
  numericKey,
  pageOf,
  readCursor,
  resolveWindow,
  snapshot,
  stringList,
  tokenUsageOf,
  viewColumns,
  writeCursor,
  type FileFacts,
  type PageSpec,
  type UsageTotals,
  type ViewRow,
} from './transitions.ts';

export interface SessionQueries {
  listSessions(ctx: RepoContext, q: SessionListQuery): Page<SessionSummary>;
  getSession(ctx: RepoContext, sessionId: string): SessionDetail & { asOfSeq: number };
  /** Hydration (03 9.3): the summaries of the rows that exist, in the order of `sessionRowIds`. */
  sessionSummaries(ctx: RepoContext, sessionRowIds: readonly number[]): SessionSummary[];
}

// ---- sorting ---------------------------------------------------------------------------------------------------------------

const STATE_RANK = `CASE s.state ${LIFECYCLE_STATES.map((state, index) => `WHEN '${state}' THEN ${String(index)}`).join(' ')} ELSE ${String(LIFECYCLE_STATES.length)} END`;

type SessionSort = SessionListQuery['sort'];

/**
 * The label sort compares the first 40 characters of the label, so the key of a cursor is bounded by construction: 40 code
 * points are at most 240 bytes of JSON (a control character is the widest, \u00XX), which with the rest of the payload stays
 * under the 512 characters of a cursor (03 5.3). Labels equal on those characters are ordered by id.
 */
const LABEL_KEY_CHARS = 40;

/** The sort expressions of 5.3. Each is a `NOT NULL` column or an expression over them, so the keyset is total. */
const SORT_EXPRESSIONS: Readonly<Record<SessionSort, string>> = {
  lastActivity: 's.last_activity_at',
  started: 's.started_at',
  duration: 'coalesce(s.ended_at, s.last_activity_at) - s.started_at',
  tokens: 's.tok_input + s.tok_output + s.tok_cache_read + s.tok_cache_creation',
  state: STATE_RANK,
  label: `substr(s.label, 1, ${String(LABEL_KEY_CHARS)}) COLLATE NOCASE`,
  errors: 's.error_count',
};

function defaultDir(sort: SessionSort): 'asc' | 'desc' {
  return sort === 'label' ? 'asc' : 'desc';
}

// ---- rows ------------------------------------------------------------------------------------------------------------------

interface SessionDbRow extends ViewRow {
  id: number;
  uid: string;
  label: string;
  labelSource: SessionSummary['labelSource'];
  matched: number;
  pinned: number;
  projectKey: string | null;
  projectDir: string | null;
  projectRoot: string | null;
  entrypoint: string | null;
  ccVersion: string | null;
  models: string;
  lastModel: string | null;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  lastHookAt: number | null;
  lastTranscriptAt: number | null;
  hookCoverage: SessionSummary['freshness']['hookCoverage'];
  agentCount: number;
  toolCallCount: number;
  openToolCount: number;
  errorCount: number;
  warningCount: number;
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
  reportedCostUsd: number | null;
  reportedCostAt: number | null;
  updatedSeq: number;
  sortKey?: string | number;
}

const SESSION_COLUMNS = `s.id AS id, s.session_uid AS uid, s.label AS label, s.label_source AS labelSource,
  s.matched AS matched, s.pinned AS pinned, p.project_key AS projectKey, p.dir_name AS projectDir, p.root_path AS projectRoot,
  s.entrypoint AS entrypoint, s.cc_version AS ccVersion, s.models AS models, s.last_model AS lastModel,
  s.started_at AS startedAt, s.last_activity_at AS lastActivityAt, s.ended_at AS endedAt, s.last_hook_at AS lastHookAt,
  s.last_transcript_at AS lastTranscriptAt, s.hook_coverage AS hookCoverage, s.agent_count AS agentCount,
  s.tool_call_count AS toolCallCount, s.open_tool_count AS openToolCount, s.error_count AS errorCount,
  s.warning_count AS warningCount, s.usage_messages AS usageMessages, s.usage_synthetic AS usageSynthetic,
  s.usage_unfinalized AS usageUnfinalized, s.tok_input AS tokInput, s.tok_output AS tokOutput,
  s.tok_cache_read AS tokCacheRead, s.tok_cache_creation AS tokCacheCreation, s.tok_input_missing AS missInput,
  s.tok_output_missing AS missOutput, s.tok_cache_read_missing AS missCacheRead,
  s.tok_cache_creation_missing AS missCacheCreation, s.reported_cost_usd AS reportedCostUsd,
  s.reported_cost_at AS reportedCostAt, s.updated_seq AS updatedSeq, ${viewColumns('s')}`;

const SESSION_FROM = 'sessions s LEFT JOIN projects p ON p.id = s.project_id';

/** The last path segment of a project root (either separator), else the folder name; the label of a project in lists. */
export function projectLabelOf(root: string | null, dir: string | null): string | null {
  const segments = (root ?? '').split(/[\\/]/).filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? dir;
}

// ---- side data of a set of sessions ----------------------------------------------------------------------------------------

interface SideData {
  readonly workItems: Map<number, number[]>;
  readonly activeAgents: Map<number, number>;
  readonly ownUsage: Map<number, UsageTotals>;
  readonly files: Map<string, FileFacts[]>;
  readonly trailing: Map<number, boolean>;
}

interface OwnUsageRow {
  sid: number;
  messages: number;
  synthetic: number;
  unfinalized: number;
  sInput: number;
  sOutput: number;
  sCacheRead: number;
  sCacheCreation: number;
  mInput: number;
  mOutput: number;
  mCacheRead: number;
  mCacheCreation: number;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** The five indexed statements of 6.3 for the sessions of a page, keyed by session row id (files by session uid). */
function loadSideData(db: InstanceDb, rows: readonly SessionDbRow[]): SideData {
  const ids = idsParam(rows.map((row) => row.id));
  const uids = idsParam(rows.map((row) => row.uid));
  const { driver } = db;
  const workItems = new Map<number, number[]>();
  for (const row of driver
    .prepare<{ sid: number; wid: number }>(
      `SELECT session_id AS sid, work_item_id AS wid FROM work_item_sessions
        WHERE session_id IN (SELECT value FROM json_each(:ids)) ORDER BY work_item_id`,
    )
    .all({ ids })) {
    push(workItems, row.sid, row.wid);
  }
  const activeAgents = new Map<number, number>();
  const activeList = ACTIVE_STATES.map((state) => `'${state}'`).join(', ');
  for (const row of driver
    .prepare<{ sid: number; n: number }>(
      `SELECT session_id AS sid, count(*) AS n FROM agents
        WHERE session_id IN (SELECT value FROM json_each(:ids)) AND kind NOT IN ('main', 'internal')
          AND state IN (${activeList}) GROUP BY session_id`,
    )
    .all({ ids })) {
    activeAgents.set(row.sid, row.n);
  }
  // the own usage is the rollup of the main agent row (03 6.3, DA-I6): one indexed row per session, no read of `usage`
  const ownUsage = new Map<number, UsageTotals>();
  for (const row of driver
    .prepare<OwnUsageRow>(
      `SELECT session_id AS sid, usage_messages AS messages, usage_synthetic AS synthetic, usage_unfinalized AS unfinalized,
              tok_input AS sInput, tok_output AS sOutput, tok_cache_read AS sCacheRead, tok_cache_creation AS sCacheCreation,
              tok_input_missing AS mInput, tok_output_missing AS mOutput, tok_cache_read_missing AS mCacheRead,
              tok_cache_creation_missing AS mCacheCreation
         FROM agents WHERE session_id IN (SELECT value FROM json_each(:ids)) AND agent_uid = 'main'`,
    )
    .all({ ids })) {
    ownUsage.set(row.sid, {
      messages: row.messages,
      synthetic: row.synthetic,
      unfinalized: row.unfinalized,
      input: row.sInput,
      output: row.sOutput,
      cacheRead: row.sCacheRead,
      cacheCreation: row.sCacheCreation,
      missingInput: row.mInput,
      missingOutput: row.mOutput,
      missingCacheRead: row.mCacheRead,
      missingCacheCreation: row.mCacheCreation,
    });
  }
  const files = new Map<string, FileFacts[]>();
  for (const file of driver
    .prepare<FileFacts>(
      `SELECT ${FILE_COLUMNS} FROM transcript_files f
        WHERE f.session_uid IN (SELECT value FROM json_each(:uids)) ORDER BY f.id`,
    )
    .all({ uids })) {
    push(files, file.sessionUid, file);
  }
  const trailing = new Map<number, boolean>();
  for (const row of driver
    .prepare<{ sid: number; trailing: number }>(
      `SELECT session_id AS sid, max(is_trailing) AS trailing FROM cost_states
        WHERE session_id IN (SELECT value FROM json_each(:ids)) GROUP BY session_id`,
    )
    .all({ ids })) {
    trailing.set(row.sid, row.trailing === 1);
  }
  return { workItems, activeAgents, ownUsage, files, trailing };
}

function summaryOf(row: SessionDbRow, side: SideData, nowMs: number): SessionSummary {
  const files = side.files.get(row.uid) ?? [];
  const mainFiles = files.filter((file) => file.kind === 'session');
  const total = tokenUsageOf(
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
    files,
  );
  const reported =
    row.reportedCostUsd === null || row.reportedCostAt === null
      ? null
      : {
          amountUsd: row.reportedCostUsd,
          at: iso(row.reportedCostAt),
          trailing: side.trailing.get(row.id) ?? false,
          label: 'Reported by Claude Code (cumulative, not a bill)',
        };
  const active = files.filter((file) => file.state === 'active');
  return {
    id: row.uid,
    seq: row.updatedSeq,
    label: row.label,
    labelSource: row.labelSource,
    matched: row.matched === 1,
    pinned: row.pinned === 1,
    projectId: row.projectKey,
    projectLabel: row.projectKey === null ? null : projectLabelOf(row.projectRoot, row.projectDir),
    workItemIds: side.workItems.get(row.id) ?? [],
    provider: 'claude-code',
    entrypoint: row.entrypoint,
    ccVersion: row.ccVersion,
    models: stringList(row.models),
    lastModel: row.lastModel,
    startedAt: iso(row.startedAt),
    lastActivityAt: iso(row.lastActivityAt),
    endedAt: isoOrNull(row.endedAt),
    durationMs: Math.max(0, (row.endedAt ?? row.lastActivityAt) - row.startedAt),
    state: assessmentOf(row, nowMs),
    agentCount: row.agentCount,
    activeAgentCount: side.activeAgents.get(row.id) ?? 0,
    toolCallCount: row.toolCallCount,
    pendingTools: row.openToolCount,
    errorCount: row.errorCount,
    warningCount: row.warningCount,
    usage: tokenUsageOf(side.ownUsage.get(row.id) ?? NO_USAGE, mainFiles),
    usageInclSubagents: total,
    cost: null,
    reportedCost: reported,
    partial: total.completeness !== 'complete',
    sources: { hooks: row.lastHookAt !== null, transcript: row.lastTranscriptAt !== null },
    freshness: {
      lastHookAt: isoOrNull(row.lastHookAt),
      lastTranscriptAt: isoOrNull(row.lastTranscriptAt),
      transcriptLagBytes: files.reduce((sum, file) => sum + behindBytes(file), 0),
      hookCoverage: row.hookCoverage,
      eventsComplete: active.every((file) => file.backfillOffset >= file.tailStart),
      usageComplete: total.completeness === 'complete',
    },
  };
}

function summariesOf(db: InstanceDb, deps: QueryDeps, rows: readonly SessionDbRow[]): SessionSummary[] {
  if (rows.length === 0) return [];
  const side = loadSideData(db, rows);
  const nowMs = deps.now();
  return rows.map((row) => summaryOf(row, side, nowMs));
}

// ---- the filter ------------------------------------------------------------------------------------------------------------

/** The filter keys of the session list that `filterSql` reads: the content search (03 7.4) selects its sessions with the same ones. */
export type SessionFilter = Pick<
  SessionListQuery,
  | 'q'
  | 'state'
  | 'presence'
  | 'project'
  | 'workItem'
  | 'model'
  | 'hasErrors'
  | 'tokensMin'
  | 'tokensMax'
  | 'includeUnmatched'
>;

/** The parts of the `WHERE` clause that make the result set (everything but the keyset), over `sessions s`. */
export function filterSql(
  deps: QueryDeps,
  q: SessionFilter,
  window: { fromMs: number | null; toMs: number; source: string },
  bind: Binder,
): string[] {
  const where: string[] = [];
  if (window.fromMs !== null) {
    // `window=1` always includes the pinned sessions (6.3, legacy `session_ids`)
    const pinned = window.source === 'window_hours' ? ' OR s.pinned = 1' : '';
    where.push(`(s.last_activity_at >= ${bind.bind(window.fromMs)}${pinned})`);
  }
  where.push(`s.started_at < ${bind.bind(window.toMs)}`);
  if (q.q !== undefined) where.push(`instr(s.search_text, ${bind.bind(foldQuery(q.q))}) > 0`);
  if (q.state !== undefined) where.push(`s.state IN ${bind.list(expandStateFilter(q.state))}`);
  if (q.presence !== undefined) where.push(`s.presence IN ${bind.list(q.presence)}`);
  if (q.project !== undefined) {
    where.push(`s.project_id IN (SELECT id FROM projects WHERE project_key IN ${bind.list(q.project)})`);
  }
  if (q.workItem !== undefined) {
    where.push(`s.id IN (SELECT session_id FROM work_item_sessions WHERE work_item_id = ${bind.bind(q.workItem)})`);
  }
  if (q.model !== undefined) {
    where.push(`EXISTS (SELECT 1 FROM json_each(s.models) j WHERE j.value IN ${bind.list(q.model)})`);
  }
  if (q.hasErrors === true) where.push('s.error_count > 0');
  const tokens = 's.tok_input + s.tok_output + s.tok_cache_read + s.tok_cache_creation';
  if (q.tokensMin !== undefined) where.push(`(${tokens}) >= ${bind.bind(q.tokensMin)}`);
  if (q.tokensMax !== undefined) where.push(`(${tokens}) <= ${bind.bind(q.tokensMax)}`);
  if (q.includeUnmatched !== true && !deps.config.monitor.include_unmatched) {
    where.push('(s.matched = 1 OR s.pinned = 1)');
  }
  return where;
}

// ---- getSession ------------------------------------------------------------------------------------------------------------

interface DetailDbRow extends SessionDbRow {
  cwd: string | null;
  gitBranch: string | null;
  permissionMode: string | null;
  claudePid: number | null;
  continuedIn: string | null;
  copiedFrom: string | null;
  hookMissingTools: number;
  hookMissingTurns: number;
}

const MAX_FILES = 500;
const MAX_RECONCILIATIONS = 20;

function detailOf(db: InstanceDb, deps: QueryDeps, row: DetailDbRow): SessionDetail {
  const summary = summariesOf(db, deps, [row])[0];
  if (summary === undefined) throw new Error('a session row produced no summary');
  const { driver } = db;
  const external = driver
    .prepare<{ source: 'registry' | 'job' | 'pid' | 'attempt'; observedAt: number; value: string }>(
      `SELECT source, observed_at AS observedAt, value_json AS value FROM external_observations
        WHERE session_id = :sid ORDER BY source`,
    )
    .all({ sid: row.id })
    .map((item) => ({ source: item.source, observedAt: iso(item.observedAt), value: flatRecord(item.value) }));
  const workItems = driver
    .prepare<{ id: number; title: string; state: SessionDetail['workItems'][number]['state'] }>(
      `SELECT w.id AS id, w.title AS title, w.state AS state FROM work_item_sessions ws
         JOIN work_items w ON w.id = ws.work_item_id WHERE ws.session_id = :sid ORDER BY w.id`,
    )
    .all({ sid: row.id });
  const files = driver
    .prepare<FileFacts>(
      `SELECT ${FILE_COLUMNS} FROM transcript_files f WHERE f.session_uid = :uid ORDER BY f.id LIMIT :limit`,
    )
    .all({ uid: row.uid, limit: MAX_FILES + 1 });
  const copied = driver
    .prepare<{ n: number }>(
      `SELECT count(*) AS n FROM usage_files uf JOIN usage u ON u.message_key = uf.message_key
        WHERE uf.file_id IN (SELECT id FROM transcript_files WHERE session_uid = :uid) AND u.session_id <> :sid`,
    )
    .get({ uid: row.uid, sid: row.id });
  const reconciliations = driver
    .prepare<{ kind: string; at: number; detail: string }>(
      `SELECT kind, at, detail FROM reconciliations WHERE session_id = :sid ORDER BY at DESC, id DESC LIMIT :limit`,
    )
    .all({ sid: row.id, limit: MAX_RECONCILIATIONS })
    .map((item): { kind: string; at: string; detail: DetailRecord } => ({
      kind: item.kind,
      at: iso(item.at),
      detail: flatRecord(item.detail),
    }));
  return {
    ...summary,
    cwd: row.cwd,
    gitBranch: row.gitBranch,
    permissionMode: row.permissionMode,
    claudePid: row.claudePid,
    continuedIn: row.continuedIn,
    copiedFrom: row.copiedFrom,
    hookMissing: { tools: row.hookMissingTools, turns: row.hookMissingTurns },
    external,
    workItems,
    files: files.slice(0, MAX_FILES).map((file) => ({
      agentId: file.agentUid ?? 'main',
      kind: file.kind,
      state: file.state,
      sizeBytes: file.sizeSeen,
      importedBytes: consumedBytes(file),
      behindBytes: behindBytes(file),
      entries: file.entriesTotal,
      usageState: file.usageState,
    })),
    filesTruncated: files.length > MAX_FILES,
    copiedMessages: copied?.n ?? 0,
    reconciliations,
    auditRefs: [],
  };
}

// ---- the part --------------------------------------------------------------------------------------------------------------

export function createSessionQueries(db: InstanceDb, deps: QueryDeps): SessionQueries {
  return {
    listSessions: (ctx, q) =>
      snapshot(db, ctx, (asOfSeq) => {
        const dir = q.dir ?? defaultDir(q.sort);
        const spec: PageSpec = { route: 'listSessions', sort: q.sort, dir, filter: filterOf(q) };
        const resume = readCursor(q.cursor, spec);
        const window = resolveWindow(deps, q, 'window', resume);
        const bind = new Binder();
        const where = filterSql(deps, q, window, bind);
        // the count of the whole filtered set (without the keyset) uses its own parameters
        let total: number | null = null;
        let lowerBound = false;
        if (q.includeTotal === true) {
          const countBind = new Binder();
          const countWhere = filterSql(deps, q, window, countBind);
          const counted =
            db.driver
              .prepare<{ n: number }>(
                `SELECT count(*) AS n FROM (SELECT 1 FROM ${SESSION_FROM} WHERE ${countWhere.join(' AND ')} LIMIT ${String(TOTAL_CAP + 1)})`,
              )
              .get(countBind.params)?.n ?? 0;
          lowerBound = counted > TOTAL_CAP;
          total = Math.min(counted, TOTAL_CAP);
        }
        const expression = SORT_EXPRESSIONS[q.sort];
        if (resume !== null) {
          const op = dir === 'desc' ? '<' : '>';
          const key: SqlValue = q.sort === 'label' ? String(resume.k) : numericKey(resume);
          const k = bind.bind(key);
          where.push(`(${expression} ${op} ${k} OR (${expression} = ${k} AND s.id ${op} ${bind.bind(resume.i)}))`);
        }
        const direction = dir.toUpperCase();
        const rows = db.driver
          .prepare<SessionDbRow>(
            `SELECT ${SESSION_COLUMNS}, ${expression} AS sortKey FROM ${SESSION_FROM}
              WHERE ${where.join(' AND ')} ORDER BY ${expression} ${direction}, s.id ${direction}
              LIMIT ${bind.bind(q.limit + 1)}`,
          )
          .all(bind.params);
        const pageRows = rows.slice(0, q.limit);
        const last = pageRows[pageRows.length - 1];
        const nextCursor =
          rows.length > q.limit && last?.sortKey !== undefined
            ? writeCursor(spec, last.sortKey, last.id, window)
            : null;
        return pageOf(summariesOf(db, deps, pageRows), { nextCursor, asOfSeq, limit: q.limit, total, lowerBound });
      }),

    getSession: (ctx, sessionId) =>
      snapshot(db, ctx, (asOfSeq) => {
        const row = db.driver
          .prepare<DetailDbRow>(
            `SELECT ${SESSION_COLUMNS}, s.cwd AS cwd, s.git_branch AS gitBranch, s.permission_mode AS permissionMode,
                    s.claude_pid AS claudePid, s.continued_in AS continuedIn, s.copied_from AS copiedFrom,
                    s.hook_missing_tools AS hookMissingTools, s.hook_missing_turns AS hookMissingTurns
               FROM ${SESSION_FROM} WHERE s.session_uid = :uid`,
          )
          .get({ uid: sessionId });
        if (row === undefined) throw new NotFoundError('session_not_found');
        return { ...detailOf(db, deps, row), asOfSeq };
      }),

    sessionSummaries: (ctx, sessionRowIds) =>
      snapshot(db, ctx, () => {
        if (sessionRowIds.length === 0) return [];
        const rows = db.driver
          .prepare<SessionDbRow>(
            `SELECT ${SESSION_COLUMNS} FROM ${SESSION_FROM} WHERE s.id IN (SELECT value FROM json_each(:ids))`,
          )
          .all({ ids: idsParam(sessionRowIds) });
        const byId = new Map(rows.map((row) => [row.id, row]));
        const ordered = [...new Set(sessionRowIds)].flatMap((id) => {
          const row = byId.get(id);
          return row === undefined ? [] : [row];
        });
        return summariesOf(db, deps, ordered);
      }),
  };
}
