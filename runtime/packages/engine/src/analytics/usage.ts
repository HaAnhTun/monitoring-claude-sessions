// `usage` and `sessionUsage` (03 8.2, 8.3, 12.1): token usage grouped by model, session, project, work item or agent, with the
// optional cost estimate of configured prices. Every sum comes from `tokens/aggregate.ts` (`aggregateGroups`); the only SQL
// of this file selects the sessions of a filter, the names of the groups and the contributing transcript files.
//
// Rules kept here:
//  - a field is `null` when every counted message misses it, and all fields are `null` without messages (never 0, DA-I9);
//  - the cost is an estimate of configured prices, `null` without prices; the provider's own figure is `reportedCost` and is
//    never added to it;
//  - the totals row counts every selected message (synthetic ones included, as the session rollups do); the rows of a model
//    group leave synthetic messages out (02 6.2 rule 10), so the model rows can add up to a little less than the totals;
//  - a window needs `ts` of the message in it; a session filter selects the owner sessions of the messages.
import type { PricingModel, UsageQuery, UsageReport, UsageRow, SessionUsageQuery, TokenUsage } from '@mcs/shared';
import { isoMsZ } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import { projectLabelOf } from '../query/sessions.ts';
import {
  Binder,
  FILE_COLUMNS,
  NotFoundError,
  idsParam,
  resolveWindow,
  sessionRowId,
  snapshot,
  tokenUsageOf,
  type FileFacts,
  type UsageTotals,
  type Window,
} from '../query/transitions.ts';
import type { QueryDeps } from '../runtime/context.ts';
import {
  aggregateGroups,
  mergeAggregates,
  usageFilterSql,
  type UsageAggregate,
  type UsageFilter,
  type UsageGroup,
} from '../tokens/aggregate.ts';
import {
  REPORTED_COST_LABEL,
  costRows,
  estimateCost,
  reportedCost,
  summarizeCost,
  type CostGroup,
  type OwnedCostGroup,
} from './cost.ts';

export interface UsageQueries {
  usage(ctx: RepoContext, q: UsageQuery): UsageReport;
  sessionUsage(ctx: RepoContext, sessionId: string, q: SessionUsageQuery): UsageReport;
}

/** The text of `UsageReport.source` (03 8.2). */
export const USAGE_SOURCE =
  "Token usage from transcript assistant records: one value per provider message (per-field maximum over all files), owned by the oldest file's session; subagents included; hooks add no tokens.";

const DEFAULT_RANGE = '7d';

// ---- the selection of a request ---------------------------------------------------------------------------------------------------

/** Which messages a request selects besides the window: the owner sessions, and the models. `undefined` = no restriction. */
export interface UsageScope {
  /** `sessions.id`; an empty list selects nothing. */
  readonly sessionIds?: readonly number[];
  readonly models?: readonly string[];
}

export interface ScopeQuery {
  readonly session?: readonly string[] | undefined;
  readonly project?: readonly string[] | undefined;
  readonly workItem?: number | undefined;
  readonly model?: readonly string[] | undefined;
}

/** The filters `session`, `project` and `workItem` combine with AND into the owner sessions; `model` is the model list (03 5.4). */
export function resolveUsageScope(db: InstanceDb, q: ScopeQuery): UsageScope {
  const models = q.model === undefined ? {} : { models: q.model };
  if (q.session === undefined && q.project === undefined && q.workItem === undefined) return models;
  const bind = new Binder();
  const where: string[] = [];
  if (q.session !== undefined) where.push(`s.session_uid IN ${bind.list(q.session)}`);
  if (q.project !== undefined) {
    where.push(`s.project_id IN (SELECT id FROM projects WHERE project_key IN ${bind.list(q.project)})`);
  }
  if (q.workItem !== undefined) {
    where.push(`s.id IN (SELECT session_id FROM work_item_sessions WHERE work_item_id = ${bind.bind(q.workItem)})`);
  }
  const ids = db.driver
    .prepare<{ id: number }>(`SELECT s.id AS id FROM sessions s WHERE ${where.join(' AND ')} ORDER BY s.id`)
    .all(bind.params)
    .map((row) => row.id);
  return { ...models, sessionIds: ids };
}

/** The aggregate filter of a window and a scope. `all` (no lower bound) selects every message and names no time index. */
export function usageFilterOf(window: Window | null, scope: UsageScope): UsageFilter {
  const fromMs = window?.fromMs ?? null;
  return {
    ...(window === null || fromMs === null ? {} : { fromMs, toMs: window.toMs }),
    ...(scope.sessionIds === undefined ? {} : { sessionIds: scope.sessionIds }),
    ...(scope.models === undefined ? {} : { models: scope.models }),
  };
}

/** The `window` member of a report: the lower bound as asked (`null` = none), and the upper bound never past now. */
export function reportWindow(window: Window | null, nowMs: number): { from: string | null; to: string } {
  const fromMs = window?.fromMs ?? null;
  return {
    from: fromMs === null ? null : isoMsZ(fromMs),
    to: isoMsZ(window === null ? nowMs : Math.min(window.toMs, nowMs)),
  };
}

// ---- projection -----------------------------------------------------------------------------------------------------------------

/** The counters of an aggregate as the projection of 02 6.3 reads them. */
export function totalsOf(agg: UsageAggregate): UsageTotals {
  return {
    messages: agg.messages,
    synthetic: agg.synthetic,
    unfinalized: agg.unfinalized,
    input: agg.sum.input,
    output: agg.sum.output,
    cacheRead: agg.sum.cacheRead,
    cacheCreation: agg.sum.cacheCreation,
    missingInput: agg.missing.input,
    missingOutput: agg.missing.output,
    missingCacheRead: agg.missing.cacheRead,
    missingCacheCreation: agg.missing.cacheCreation,
  };
}

/** A contributing transcript file, with the session and the agent that its messages belong to. */
export interface OwnedFile extends FileFacts {
  readonly sessionRowId: number;
  /** `agents.id` of the file's agent, else the main agent of its session. */
  readonly ownerAgentId: number | null;
}

/**
 * The transcript files that contribute to the messages a filter selects (03 8.2): those of the selected sessions, else those of
 * the sessions that overlap the window, else every tracked file that carries assistant messages.
 */
export function contributingFiles(db: InstanceDb, filter: UsageFilter): OwnedFile[] {
  const sql = usageFilterSql(filter);
  return db.driver
    .prepare<OwnedFile>(
      `SELECT ${FILE_COLUMNS}, f.session_id AS sessionRowId,
              coalesce(f.agent_id, (SELECT a.id FROM agents a WHERE a.session_id = f.session_id AND a.agent_uid = 'main'))
                AS ownerAgentId
         FROM transcript_files f
        WHERE f.kind IN ('session','subagent','workflow_agent') AND f.state <> 'retired' AND ${sql.files}`,
    )
    .all(sql.fileParams);
}

/** The projection of an aggregate over the files that contribute to it (02 6.3, 03 8.2). */
export function tokenUsageFor(agg: UsageAggregate, files: readonly FileFacts[]): TokenUsage {
  return tokenUsageOf(totalsOf(agg), files);
}

// ---- names of the groups --------------------------------------------------------------------------------------------------------

interface SessionInfo {
  readonly id: number;
  readonly uid: string;
  readonly label: string;
  readonly projectKey: string | null;
  readonly projectLabel: string | null;
  readonly itemId: number | null;
  readonly itemTitle: string | null;
}

function sessionInfos(db: InstanceDb, ids: readonly number[]): Map<number, SessionInfo> {
  const out = new Map<number, SessionInfo>();
  if (ids.length === 0) return out;
  const rows = db.driver
    .prepare<{
      id: number;
      uid: string;
      label: string;
      projectKey: string | null;
      root: string | null;
      dir: string | null;
      itemId: number | null;
      itemTitle: string | null;
    }>(
      `SELECT s.id AS id, s.session_uid AS uid, s.label AS label, p.project_key AS projectKey, p.root_path AS root,
              p.dir_name AS dir, wis.work_item_id AS itemId, wi.title AS itemTitle
         FROM sessions s
         LEFT JOIN projects p ON p.id = s.project_id
         LEFT JOIN work_item_sessions wis ON wis.session_id = s.id
         LEFT JOIN work_items wi ON wi.id = wis.work_item_id
        WHERE s.id IN (SELECT value FROM json_each(:ids))`,
    )
    .all({ ids: idsParam(ids) });
  for (const row of rows) {
    out.set(row.id, {
      id: row.id,
      uid: row.uid,
      label: row.label === '' ? row.uid : row.label,
      projectKey: row.projectKey,
      projectLabel: row.projectKey === null ? null : projectLabelOf(row.root, row.dir),
      itemId: row.itemId,
      itemTitle: row.itemTitle,
    });
  }
  return out;
}

interface AgentInfo {
  readonly id: number;
  readonly uid: string;
  readonly label: string;
  readonly sessionUid: string;
}

function agentInfos(db: InstanceDb, ids: readonly number[]): Map<number, AgentInfo> {
  const out = new Map<number, AgentInfo>();
  if (ids.length === 0) return out;
  const rows = db.driver
    .prepare<{ id: number; uid: string; label: string; type: string | null; sessionUid: string }>(
      `SELECT a.id AS id, a.agent_uid AS uid, a.label AS label, a.agent_type AS type, s.session_uid AS sessionUid
         FROM agents a JOIN sessions s ON s.id = a.session_id
        WHERE a.id IN (SELECT value FROM json_each(:ids))`,
    )
    .all({ ids: idsParam(ids) });
  for (const row of rows) {
    out.set(row.id, {
      id: row.id,
      uid: row.uid,
      label: row.label !== '' ? row.label : (row.type ?? row.uid),
      sessionUid: row.sessionUid,
    });
  }
  return out;
}

// ---- rows -------------------------------------------------------------------------------------------------------------------------

interface Draft {
  readonly key: string;
  readonly label: string;
  readonly agg: UsageAggregate;
  readonly sessions: number;
  readonly files: readonly FileFacts[];
  /** The (model, day) groups of the row, when the cost is asked for. */
  readonly cost: readonly CostGroup[] | null;
}

type GroupBy = UsageQuery['groupBy'];

interface Env {
  readonly db: InstanceDb;
  readonly ctx: RepoContext;
  readonly deps: QueryDeps;
  readonly filter: UsageFilter;
  readonly files: readonly OwnedFile[];
  readonly includeCost: boolean;
  /** Key of an agent row: the agent id inside one session, else `session/agent`. */
  readonly singleSession: boolean;
}

function costOf(env: Env, filter: UsageFilter, by: 'none' | 'session' | 'agent'): OwnedCostGroup[] | null {
  return env.includeCost && env.deps.config.runtime.pricing.models.length > 0
    ? costRows(env.db, env.ctx, filter, by)
    : null;
}

function ownedBy(groups: readonly OwnedCostGroup[] | null, owner: number): CostGroup[] | null {
  return groups === null ? null : groups.filter((group) => group.owner === owner);
}

function filesBySession(files: readonly OwnedFile[]): Map<number, OwnedFile[]> {
  const out = new Map<number, OwnedFile[]>();
  for (const file of files) {
    const list = out.get(file.sessionRowId);
    if (list === undefined) out.set(file.sessionRowId, [file]);
    else list.push(file);
  }
  return out;
}

function modelDrafts(env: Env): Draft[] {
  const cost = costOf(env, env.filter, 'none');
  return aggregateGroups(env.db, env.ctx, env.filter, { by: 'model' }).map((group) => {
    const model = String(group.key);
    return {
      key: model,
      label: model,
      agg: group.agg,
      sessions: group.sessions,
      files: env.files,
      cost: cost === null ? null : cost.filter((row) => row.model === model),
    };
  });
}

function sessionDrafts(env: Env): Draft[] {
  const groups = aggregateGroups(env.db, env.ctx, env.filter, { by: 'session' });
  const infos = sessionInfos(
    env.db,
    groups.map((group) => Number(group.key)),
  );
  const files = filesBySession(env.files);
  const cost = costOf(env, env.filter, 'session');
  return groups.map((group) => {
    const id = Number(group.key);
    const info = infos.get(id);
    return {
      key: info?.uid ?? String(id),
      label: info?.label ?? String(id),
      agg: group.agg,
      sessions: group.sessions,
      files: files.get(id) ?? [],
      cost: ownedBy(cost, id),
    };
  });
}

function agentDrafts(env: Env): Draft[] {
  const groups = aggregateGroups(env.db, env.ctx, env.filter, { by: 'agent' });
  const infos = agentInfos(
    env.db,
    groups.map((group) => Number(group.key)),
  );
  const cost = costOf(env, env.filter, 'agent');
  return groups.map((group) => {
    const id = Number(group.key);
    const info = infos.get(id);
    const key = info === undefined ? String(id) : env.singleSession ? info.uid : `${info.sessionUid}/${info.uid}`;
    return {
      key,
      label: info?.label ?? String(id),
      agg: group.agg,
      sessions: group.sessions,
      files: env.files.filter((file) => file.ownerAgentId === id),
      cost: ownedBy(cost, id),
    };
  });
}

/** Project and work item rows are the session groups merged (no second pass over `usage`). */
function mergedDrafts(env: Env, by: 'project' | 'workItem'): Draft[] {
  const groups = aggregateGroups(env.db, env.ctx, env.filter, { by: 'session' });
  const infos = sessionInfos(
    env.db,
    groups.map((group) => Number(group.key)),
  );
  const files = filesBySession(env.files);
  const cost = costOf(env, env.filter, 'session');
  const merged = new Map<string, { label: string; ids: number[]; groups: UsageGroup[] }>();
  for (const group of groups) {
    const info = infos.get(Number(group.key));
    if (info === undefined) continue;
    const key = by === 'project' ? info.projectKey : info.itemId === null ? null : String(info.itemId);
    if (key === null) continue; // a session without a project or work item is in the totals only
    const label = by === 'project' ? (info.projectLabel ?? key) : (info.itemTitle ?? key);
    const entry = merged.get(key) ?? { label, ids: [], groups: [] };
    entry.ids.push(info.id);
    entry.groups.push(group);
    merged.set(key, entry);
  }
  return [...merged.entries()].map(([key, entry]) => ({
    key,
    label: entry.label,
    agg: mergeAggregates(entry.groups.map((group) => group.agg)),
    sessions: entry.groups.length,
    files: entry.ids.flatMap((id) => files.get(id) ?? []),
    cost: cost === null ? null : entry.ids.flatMap((id) => ownedBy(cost, id) ?? []),
  }));
}

function rowOf(entries: readonly PricingModel[], currency: string, draft: Draft): UsageRow {
  return {
    key: draft.key,
    label: draft.label,
    usage: tokenUsageFor(draft.agg, draft.files),
    cost: draft.cost === null ? null : estimateCost(entries, currency, draft.cost),
    sessions: draft.sessions,
  };
}

/** Largest first by the sum of the counted fields; rows without a value last; the label breaks ties. */
function byUsage(a: UsageRow, b: UsageRow): number {
  const diff = (b.usage.total ?? -1) - (a.usage.total ?? -1);
  if (diff !== 0) return diff;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export interface ReportRequest {
  readonly groupBy: GroupBy;
  readonly limit: number;
  readonly includeCost: boolean;
  readonly singleSession: boolean;
  /** `null` = every message of the scope. */
  readonly window: Window | null;
  readonly scope: UsageScope;
}

/** The report of a request, read inside the snapshot that carries `asOfSeq`. */
export function buildUsageReport(
  db: InstanceDb,
  ctx: RepoContext,
  deps: QueryDeps,
  asOfSeq: number,
  req: ReportRequest,
): UsageReport {
  const filter = usageFilterOf(req.window, req.scope);
  const files = contributingFiles(db, filter);
  const env: Env = { db, ctx, deps, filter, files, includeCost: req.includeCost, singleSession: req.singleSession };
  const { currency, models: entries } = deps.config.runtime.pricing;
  const priced = req.includeCost && entries.length > 0;

  const [all] = aggregateGroups(db, ctx, filter, { by: 'none' });
  const totalGroups = priced ? costRows(db, ctx, filter, 'none') : null;
  const totals: UsageRow = {
    key: 'total',
    label: 'Total',
    usage: tokenUsageFor(all?.agg ?? emptyAggregate(), files),
    cost: totalGroups === null ? null : estimateCost(entries, currency, totalGroups),
    sessions: all?.sessions ?? 0,
  };

  let drafts: Draft[] = [];
  switch (req.groupBy) {
    case 'none':
      break;
    case 'model':
      drafts = modelDrafts(env);
      break;
    case 'session':
      drafts = sessionDrafts(env);
      break;
    case 'agent':
      drafts = agentDrafts(env);
      break;
    case 'project':
    case 'workItem':
      drafts = mergedDrafts(env, req.groupBy);
      break;
  }
  const rows = drafts.map((draft) => rowOf(entries, currency, draft)).sort(byUsage);

  const nowMs = deps.now();
  return {
    asOfSeq,
    window: reportWindow(req.window, nowMs),
    groupBy: req.groupBy,
    totals,
    rows: rows.slice(0, req.limit),
    rowsTruncated: rows.length > req.limit,
    source: USAGE_SOURCE,
    cost: totalGroups === null ? null : summarizeCost(entries, currency, totalGroups),
    reportedCost: reportedCostOf(db, req.window, req.scope),
  };
}

function emptyAggregate(): UsageAggregate {
  const zero = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    thinking: 0,
    webSearch: 0,
    webFetch: 0,
  };
  return {
    sum: zero,
    missing: { ...zero },
    messages: 0,
    synthetic: 0,
    unfinalized: 0,
    outputIsLowerBound: false,
    complete: true,
    copiedMessages: 0,
  };
}

/** The provider-reported cost of the sessions in scope that overlap the window (02 6.6), or `null` when none has one. */
function reportedCostOf(db: InstanceDb, window: Window | null, scope: UsageScope): UsageReport['reportedCost'] {
  const bind = new Binder();
  const where: string[] = [];
  if (scope.sessionIds !== undefined)
    where.push(`s.id IN (SELECT value FROM json_each(${bind.bind(idsParam(scope.sessionIds))}))`);
  if (window !== null && window.fromMs !== null) {
    where.push(`s.last_activity_at >= ${bind.bind(window.fromMs)}`, `s.started_at < ${bind.bind(window.toMs)}`);
  }
  const found = reportedCost(db, where.length === 0 ? '1 = 1' : where.join(' AND '), bind.params);
  if (found.amountUsd === null) return null;
  return {
    amountUsd: found.amountUsd,
    sessionsWithReport: found.sessionsWithReport,
    sessionsInScope: found.sessionsInScope,
    label: REPORTED_COST_LABEL,
  };
}

export function createUsageQueries(db: InstanceDb, deps: QueryDeps): UsageQueries {
  return {
    usage: (ctx, q) =>
      snapshot(db, ctx, (asOfSeq) => {
        const window = resolveWindow(deps, q, DEFAULT_RANGE, null);
        return buildUsageReport(db, ctx, deps, asOfSeq, {
          groupBy: q.groupBy,
          limit: q.limit,
          includeCost: q.includeCost === true,
          singleSession: q.session?.length === 1,
          window,
          scope: resolveUsageScope(db, q),
        });
      }),

    sessionUsage: (ctx, sessionId, q) =>
      snapshot(db, ctx, (asOfSeq) => {
        const id = sessionRowId(db, sessionId);
        if (id === undefined) throw new NotFoundError('session_not_found');
        // the whole life of the session: no window
        return buildUsageReport(db, ctx, deps, asOfSeq, {
          groupBy: q.groupBy,
          limit: 500,
          includeCost: q.includeCost === true,
          singleSession: true,
          window: null,
          scope: { sessionIds: [id] },
        });
      }),
  };
}
