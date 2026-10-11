// Token accounting, read side (02 6.3, 03 8.2): aggregates over the instance values of the message keys (`usage`, one row per
// key, owner = the oldest file, 03 3.6). Missing is not zero: every field reports `sum` over the messages that have a value and
// `missing` = the messages that do not (rule 8). Synthetic messages count as messages and are left out of per-model rows.
//
// Differences from the signatures of 02 6.3 (a CR is filed for them): every function takes the database and the caller's
// `RepoContext` first (the engine has no global database; the scope is checked, DA-I3), sessions and agents are the row ids of
// `sessions` and `agents`, and `UsageFilter` is defined here.
//
// SQL: `usage` rows only, aggregated by SQLite; windowed queries name `idx_usage_ts_cover` (03 3.7 rule 1) so that a dropped
// index fails loudly. Every query returns one row per group, so the "no query without LIMIT" rule does not apply.
import type { SqlValue } from '../db/driver.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';

export interface UsageFields {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  thinking: number;
  webSearch: number;
  webFetch: number;
}

export interface UsageAggregate {
  /** Over the messages with a value. */
  sum: UsageFields;
  /** Messages without a value for the field. */
  missing: { [K in keyof UsageFields]: number };
  /** Counted message keys (owner scope). */
  messages: number;
  synthetic: number;
  unfinalized: number;
  outputIsLowerBound: boolean;
  /** Every contributing file is fully scanned (`usage_state = 'complete'`). */
  complete: boolean;
  /** Keys present in the files of this scope but owned elsewhere (not summed). Windowed aggregates report 0. */
  copiedMessages: number;
}

/** Filter of the windowed aggregates: `ts` is the first time of the message, `fromMs` inclusive, `toMs` exclusive. */
export interface UsageFilter {
  fromMs?: number | null;
  toMs?: number | null;
  /** `sessions.id` of the owner session. An empty list selects nothing. */
  sessionIds?: readonly number[];
  /** `usage.model`. An empty list selects nothing. */
  models?: readonly string[];
}

export type UsageScope = 'own' | 'agents' | 'total';

interface FieldColumn {
  readonly key: keyof UsageFields;
  readonly column: string;
}

const FIELD_COLUMNS: readonly FieldColumn[] = [
  { key: 'input', column: 'input_tokens' },
  { key: 'output', column: 'output_tokens' },
  { key: 'cacheRead', column: 'cache_read_tokens' },
  { key: 'cacheCreation', column: 'cache_creation_tokens' },
  { key: 'cacheCreation5m', column: 'cache_creation_5m_tokens' },
  { key: 'cacheCreation1h', column: 'cache_creation_1h_tokens' },
  { key: 'thinking', column: 'thinking_tokens' },
  { key: 'webSearch', column: 'web_search_requests' },
  { key: 'webFetch', column: 'web_fetch_requests' },
];

/** The columns of one aggregate row: counters, then a sum and a missing count per field. */
const AGGREGATE_COLUMNS = [
  'count(*) AS messages',
  'coalesce(sum(synthetic), 0) AS synthetic',
  'coalesce(sum(CASE WHEN synthetic = 0 AND finalized = 0 THEN 1 ELSE 0 END), 0) AS unfinalized',
  ...FIELD_COLUMNS.flatMap(({ key, column }) => [
    `coalesce(sum(${column}), 0) AS s_${key}`,
    `coalesce(sum(${column} IS NULL), 0) AS m_${key}`,
  ]),
].join(', ');

type AggregateDbRow = Record<string, SqlValue>;

/** The kinds of transcript file that carry assistant messages; journals and status files never do. */
const USAGE_FILE_KINDS = "('session','subagent','workflow_agent')";

/** `agents.id` of the main agent of the session named by the parameter that follows. */
const MAIN_AGENT_OF = (param: string): string =>
  `(SELECT a.id FROM agents a WHERE a.session_id = ${param} AND a.agent_uid = 'main')`;
/** The agent of a transcript file: its own agent, else the main agent of its session (the owner rule of 03 3.6). */
const FILE_AGENT = `coalesce(f.agent_id, (SELECT a.id FROM agents a WHERE a.session_id = f.session_id AND a.agent_uid = 'main'))`;

function num(row: AggregateDbRow, name: string): number {
  const value = row[name];
  return typeof value === 'number' ? value : 0;
}

function toAggregate(row: AggregateDbRow, complete: boolean, copiedMessages: number): UsageAggregate {
  const sum: UsageFields = {
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
  const missing: UsageFields = { ...sum };
  for (const { key } of FIELD_COLUMNS) {
    sum[key] = num(row, `s_${key}`);
    missing[key] = num(row, `m_${key}`);
  }
  const unfinalized = num(row, 'unfinalized');
  return {
    sum,
    missing,
    messages: num(row, 'messages'),
    synthetic: num(row, 'synthetic'),
    unfinalized,
    outputIsLowerBound: unfinalized > 0,
    complete,
    copiedMessages,
  };
}

/** Does any contributing file of `where` still lack a complete scan? `where` is a condition on `f` (transcript_files). */
function filesComplete(db: InstanceDb, where: string, params: readonly SqlValue[]): boolean {
  const row = db.driver
    .prepare<{ found: number }>(
      `SELECT 1 AS found FROM transcript_files f
        WHERE f.kind IN ${USAGE_FILE_KINDS} AND f.state <> 'retired' AND f.usage_state <> 'complete' AND ${where} LIMIT 1`,
    )
    .get(params);
  return row === undefined;
}

// ---- one session or one agent (owner scope) ---------------------------------------------------------------------------------

interface ScopeSql {
  /** Condition on `usage` rows (alias `usage`, columns `session_id`, `agent_id`). */
  readonly rows: string;
  /** The same scope as a condition on `transcript_files f`. */
  readonly files: string;
  readonly params: readonly SqlValue[];
}

function sessionScope(sessionId: number, scope: UsageScope): ScopeSql {
  const main = MAIN_AGENT_OF('?');
  if (scope === 'total') {
    return { rows: 'usage.session_id = ?', files: 'f.session_id = ?', params: [sessionId] };
  }
  const op = scope === 'own' ? 'IS' : 'IS NOT';
  return {
    rows: `usage.session_id = ? AND usage.agent_id ${op} ${main}`,
    files: `f.session_id = ? AND ${FILE_AGENT} ${op} ${main}`,
    params: [sessionId, sessionId],
  };
}

function agentScope(agentId: number): ScopeSql {
  return { rows: 'usage.agent_id = ?', files: `${FILE_AGENT} = ?`, params: [agentId] };
}

function scopedAggregate(db: InstanceDb, ctx: RepoContext, scope: ScopeSql): UsageAggregate {
  db.assertScope(ctx);
  const row = db.driver
    .prepare<AggregateDbRow>(`SELECT ${AGGREGATE_COLUMNS} FROM usage WHERE ${scope.rows}`)
    .get(scope.params);
  const complete = filesComplete(db, scope.files, scope.params);
  const copied = db.driver
    .prepare<{ n: number }>(
      `SELECT count(DISTINCT uf.message_key) AS n
         FROM usage_files uf
         JOIN transcript_files f ON f.id = uf.file_id
         JOIN usage ON usage.message_key = uf.message_key
        WHERE ${scope.files} AND NOT (${scope.rows})`,
    )
    .get([...scope.params, ...scope.params]);
  return toAggregate(row ?? {}, complete, copied?.n ?? 0);
}

/** A session's messages: `own` = the main agent's, `agents` = every other agent's, `total` = both (02 6.2 rule 7). */
export function aggregateSession(
  db: InstanceDb,
  ctx: RepoContext,
  sessionId: number,
  scope: UsageScope,
): UsageAggregate {
  return scopedAggregate(db, ctx, sessionScope(sessionId, scope));
}

/** The messages owned by one agent (`agents.id`). */
export function aggregateAgent(db: InstanceDb, ctx: RepoContext, agentId: number): UsageAggregate {
  return scopedAggregate(db, ctx, agentScope(agentId));
}

// ---- windows over the whole instance -----------------------------------------------------------------------------------------

interface FilterSql {
  readonly from: string;
  readonly where: string;
  readonly params: readonly SqlValue[];
  /** Condition on `transcript_files f` for the files that contribute to the filtered rows. */
  readonly files: string;
  readonly fileParams: readonly SqlValue[];
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

function isSet(value: number | null | undefined): value is number {
  return value !== undefined && value !== null;
}

function filterSql(filter: UsageFilter): FilterSql {
  const windowed = isSet(filter.fromMs) || isSet(filter.toMs);
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  if (windowed) {
    conditions.push('ts >= ?', 'ts < ?');
    params.push(filter.fromMs ?? 0, filter.toMs ?? Number.MAX_SAFE_INTEGER);
  }
  if (filter.sessionIds !== undefined) {
    conditions.push(`session_id IN (${placeholders(filter.sessionIds.length)})`);
    params.push(...filter.sessionIds);
  }
  if (filter.models !== undefined) {
    conditions.push(`model IN (${placeholders(filter.models.length)})`);
    params.push(...filter.models);
  }
  // contributing files (03 8.2): the files of the selected sessions, else of the sessions that overlap the window, else all
  const fileConditions: string[] = [];
  const fileParams: SqlValue[] = [];
  if (filter.sessionIds !== undefined) {
    fileConditions.push(`f.session_id IN (${placeholders(filter.sessionIds.length)})`);
    fileParams.push(...filter.sessionIds);
  }
  if (windowed) {
    fileConditions.push(
      'f.session_id IN (SELECT s.id FROM sessions s WHERE s.last_activity_at >= ? AND s.started_at < ?)',
    );
    fileParams.push(filter.fromMs ?? 0, filter.toMs ?? Number.MAX_SAFE_INTEGER);
  }
  return {
    from: windowed ? 'usage INDEXED BY idx_usage_ts_cover' : 'usage',
    where: conditions.length === 0 ? '1 = 1' : conditions.join(' AND '),
    params,
    files: fileConditions.length === 0 ? '1 = 1' : fileConditions.join(' AND '),
    fileParams,
  };
}

/** The aggregate of every message the filter selects (synthetic ones included, 02 6.2 rule 10 only concerns models). */
export function aggregateInstance(db: InstanceDb, ctx: RepoContext, filter: UsageFilter): UsageAggregate {
  db.assertScope(ctx);
  const sql = filterSql(filter);
  const row = db.driver
    .prepare<AggregateDbRow>(`SELECT ${AGGREGATE_COLUMNS} FROM ${sql.from} WHERE ${sql.where}`)
    .get(sql.params);
  return toAggregate(row ?? {}, filesComplete(db, sql.files, sql.fileParams), 0);
}

/** One aggregate per model, synthetic messages excluded, ordered by model. */
export function aggregateByModel(
  db: InstanceDb,
  ctx: RepoContext,
  filter: UsageFilter,
): { model: string; agg: UsageAggregate }[] {
  db.assertScope(ctx);
  const sql = filterSql(filter);
  const rows = db.driver
    .prepare<AggregateDbRow>(
      `SELECT model, ${AGGREGATE_COLUMNS} FROM ${sql.from} WHERE ${sql.where} AND synthetic = 0 GROUP BY model ORDER BY model`,
    )
    .all(sql.params);
  const complete = filesComplete(db, sql.files, sql.fileParams);
  return rows.map((row) => ({ model: String(row['model']), agg: toAggregate(row, complete, 0) }));
}

const HOUR_MS = 3_600_000;

/** One aggregate per hour (UTC), bucketed by the first time of the message, ordered by time; empty hours are left out. */
export function aggregateByHour(
  db: InstanceDb,
  ctx: RepoContext,
  filter: UsageFilter,
): { hourStart: number; agg: UsageAggregate }[] {
  db.assertScope(ctx);
  const sql = filterSql(filter);
  const rows = db.driver
    .prepare<AggregateDbRow>(
      `SELECT (ts / ${String(HOUR_MS)}) * ${String(HOUR_MS)} AS hour_start, ${AGGREGATE_COLUMNS}
         FROM ${sql.from} WHERE ${sql.where} GROUP BY hour_start ORDER BY hour_start`,
    )
    .all(sql.params);
  const complete = filesComplete(db, sql.files, sql.fileParams);
  return rows.map((row) => ({ hourStart: num(row, 'hour_start'), agg: toAggregate(row, complete, 0) }));
}
