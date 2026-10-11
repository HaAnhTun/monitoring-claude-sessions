// UsageRepo: token usage at two levels (03 3.6 "Usage, two levels", ADR 0017, 0024; the rules are 02 6.2). SQL only.
//
// Level 1, `usage_files (file_id, message_key)`: the per-field maximum over the records of one file; a NULL field is "missing"
// and stays missing until a record has a value. Level 2, `usage (message_key)`: the instance value of the key, the per-field
// maximum over its files, owned by the oldest file (`birth_ms`, else the mtime of its first sight, then the path) and so by
// the session and agent of that file. The rollup columns of sessions and agents (message count, synthetic, unfinalized,
// token sums and the number of messages without a value, per main field) are maintained by deltas in the same
// transaction: when the owner changes, the contribution moves; `verifyRollups` proves rollup = sum of the `usage` rows.
//
// The order of the records, of the files and of the transactions cannot change the result (200 shuffled orders in the tests):
// every step recomputes the instance value from the file rows and applies the difference to the rollups.
//
// Where this differs from the text of 03 3.6 (CR-WP-10-1, CR-WP-10-3): `applyRecord` takes the `WriteTx` (the change it
// reserves and `updated_at` need it); a file whose age is unknown loses the ownership to one that has an age (the statement
// would let NULL sort first); a message with no model at all is stored as `unknown` (`usage.model` is NOT NULL); `last_model`
// is the model of the message that was added to the owner session or changed its model last (arrival order); nothing is
// rewritten when a record changes neither the instance value nor a rollup.
//
// Every public method takes the `RepoContext` first and asserts the scope (03 4.5).
import { DbError } from '../errors.ts';
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

export type UsageSource = 'top' | 'iterations';

/** The effective values of one record of one message in one file (02 6.2 rules 1-5, 11). A field that is null is missing. */
export interface UsageValues {
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly cacheCreation5mTokens: number | null;
  readonly cacheCreation1hTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly webSearchRequests: number | null;
  readonly webFetchRequests: number | null;
  /** Top-level integers only, missing = 0: the inputs of the legacy parity projection (02 6.5). */
  readonly legacyIn: number;
  readonly legacyOut: number;
  readonly legacyCr: number;
  readonly legacyCc: number;
  /** The record has a stop reason or an `iterations` array. */
  readonly finalized: boolean;
  readonly usageSource: UsageSource;
  readonly synthetic: boolean;
  /** The record time (epoch ms), null when the record has none. */
  readonly ts: number | null;
  /** How many fields of the record were present but not valid numbers (02 6.2 rule 2). */
  readonly invalidValues: number;
}

export interface UsageFileRow extends Omit<UsageValues, 'ts'> {
  readonly fileId: number;
  readonly messageKey: string;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  readonly recordCount: number;
}

export interface UsageRow {
  readonly id: number;
  readonly messageKey: string;
  readonly sessionId: number;
  readonly agentId: number;
  readonly ownerFileId: number;
  readonly model: string;
  readonly ts: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly cacheCreation5mTokens: number | null;
  readonly cacheCreation1hTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly webSearchRequests: number | null;
  readonly webFetchRequests: number | null;
  readonly finalized: boolean;
  readonly usageSource: UsageSource;
  readonly synthetic: boolean;
  /** How many files hold the key. */
  readonly files: number;
  readonly updatedAt: number;
}

export interface UsageOwner {
  readonly fileId: number;
  readonly sessionId: number;
  readonly agentId: number;
}

export interface UsageApplyResult {
  /** The instance value of the key or a rollup changed (and `usage/invalidate` was reserved). */
  readonly changed: boolean;
  /** The owner after the call; null when no file of the key can own it (the instance row is gone). */
  readonly owner: UsageOwner | null;
  /** `sessions.id` and `agents.id` whose rollup columns were rewritten: the writer announces them as visible changes. */
  readonly touchedSessionIds: readonly number[];
  readonly touchedAgentIds: readonly number[];
}

/** The rollup columns of a session or an agent (03 3.5). */
export interface UsageRollup {
  readonly messages: number;
  readonly synthetic: number;
  readonly unfinalized: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly inputMissing: number;
  readonly outputMissing: number;
  readonly cacheReadMissing: number;
  readonly cacheCreationMissing: number;
}

export interface RollupMismatch {
  readonly scope: 'session' | 'agent';
  readonly id: number;
  readonly stored: UsageRollup;
  readonly expected: UsageRollup;
}

interface UsageDbRow {
  id: number;
  message_key: string;
  session_id: number;
  agent_id: number;
  owner_file_id: number;
  model: string;
  ts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_creation_5m_tokens: number | null;
  cache_creation_1h_tokens: number | null;
  thinking_tokens: number | null;
  web_search_requests: number | null;
  web_fetch_requests: number | null;
  finalized: number;
  usage_source: UsageSource;
  synthetic: number;
  files: number;
  updated_at: number;
}

interface UsageFileDbRow {
  file_id: number;
  message_key: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_creation_5m_tokens: number | null;
  cache_creation_1h_tokens: number | null;
  thinking_tokens: number | null;
  web_search_requests: number | null;
  web_fetch_requests: number | null;
  legacy_in: number;
  legacy_out: number;
  legacy_cr: number;
  legacy_cc: number;
  finalized: number;
  usage_source: UsageSource;
  synthetic: number;
  first_ts: number | null;
  last_ts: number | null;
  record_count: number;
  invalid_values: number;
}

interface OwnerDbRow {
  file_id: number;
  session_id: number;
  session_uid: string;
  agent_id: number | null;
  discovered_at: number;
  model: string | null;
}

interface AggregateDbRow {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_creation_5m_tokens: number | null;
  cache_creation_1h_tokens: number | null;
  thinking_tokens: number | null;
  web_search_requests: number | null;
  web_fetch_requests: number | null;
  finalized: number | null;
  synthetic: number | null;
  iterations: number | null;
  any_model: string | null;
  files: number;
  first_ts: number | null;
}

/** The numeric fields of a message, in the order of the columns of `usage_files` and `usage`. */
const NUMERIC_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cache_creation_5m_tokens',
  'cache_creation_1h_tokens',
  'thinking_tokens',
  'web_search_requests',
  'web_fetch_requests',
] as const;

/** A NULL field is missing: the maximum of a NULL and a value is the value, and of two NULLs it is NULL. */
const MAX_OF_FIELDS = NUMERIC_FIELDS.map(
  (column) =>
    `${column} = coalesce(max(usage_files.${column}, excluded.${column}), usage_files.${column}, excluded.${column})`,
).join(',\n    ');

const UPSERT_FILE = `INSERT INTO usage_files (file_id, message_key, model, input_tokens, output_tokens, cache_read_tokens,
    cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, thinking_tokens, web_search_requests,
    web_fetch_requests, legacy_in, legacy_out, legacy_cr, legacy_cc, finalized, usage_source, synthetic, first_ts, last_ts,
    record_count, invalid_values)
  VALUES (:fileId, :messageKey, :model, :input, :output, :cacheRead, :cacheCreation, :cacheCreation5m, :cacheCreation1h,
    :thinking, :webSearch, :webFetch, :legacyIn, :legacyOut, :legacyCr, :legacyCc, :finalized, :usageSource, :synthetic,
    :ts, :ts, 1, :invalid)
  ON CONFLICT(file_id, message_key) DO UPDATE SET
    model = coalesce(usage_files.model, excluded.model),
    ${MAX_OF_FIELDS},
    legacy_in = max(usage_files.legacy_in, excluded.legacy_in),
    legacy_out = max(usage_files.legacy_out, excluded.legacy_out),
    legacy_cr = max(usage_files.legacy_cr, excluded.legacy_cr),
    legacy_cc = max(usage_files.legacy_cc, excluded.legacy_cc),
    finalized = max(usage_files.finalized, excluded.finalized),
    usage_source = CASE WHEN 'iterations' IN (usage_files.usage_source, excluded.usage_source) THEN 'iterations' ELSE 'top' END,
    synthetic = max(usage_files.synthetic, excluded.synthetic),
    first_ts = coalesce(min(usage_files.first_ts, excluded.first_ts), usage_files.first_ts, excluded.first_ts),
    last_ts = coalesce(max(usage_files.last_ts, excluded.last_ts), usage_files.last_ts, excluded.last_ts),
    record_count = usage_files.record_count + 1,
    invalid_values = usage_files.invalid_values + excluded.invalid_values`;

// The owner of a key (02 6.2 rule 7): the oldest file by birth time, else by the mtime of its first sight, then by path. A
// file of which nothing is known sorts last; a file without a session, or of a session that is gone, cannot own. The agent
// of a main file is the main agent row of its session.
const OWNER = `SELECT f.id AS file_id, f.session_id AS session_id, s.session_uid AS session_uid,
    coalesce(f.agent_id, (SELECT a.id FROM agents a WHERE a.session_id = f.session_id AND a.agent_uid = 'main')) AS agent_id,
    f.discovered_at AS discovered_at, u.model AS model
  FROM usage_files u
  JOIN transcript_files f ON f.id = u.file_id
  JOIN sessions s ON s.id = f.session_id
  WHERE u.message_key = ?
  ORDER BY coalesce(CASE WHEN f.birth_ms > 0 THEN f.birth_ms ELSE f.first_seen_mtime_ms END, 9007199254740991), f.path
  LIMIT 1`;

// The instance value of a key: the maximum of every field over its files (aggregate max ignores NULL, so a field stays NULL
// only when every file misses it), finalized and synthetic when any file says so, the earliest first record.
const AGGREGATE = `SELECT ${NUMERIC_FIELDS.map((column) => `max(${column}) AS ${column}`).join(', ')},
    max(finalized) AS finalized, max(synthetic) AS synthetic, max(usage_source = 'iterations') AS iterations,
    max(model) AS any_model, count(*) AS files, min(first_ts) AS first_ts
  FROM usage_files WHERE message_key = ?`;

const UPSERT_USAGE = `INSERT INTO usage (message_key, session_id, agent_id, owner_file_id, model, ts, input_tokens, output_tokens,
    cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, thinking_tokens,
    web_search_requests, web_fetch_requests, finalized, usage_source, synthetic, files, updated_at)
  VALUES (:messageKey, :sessionId, :agentId, :ownerFileId, :model, :ts, :input_tokens, :output_tokens, :cache_read_tokens,
    :cache_creation_tokens, :cache_creation_5m_tokens, :cache_creation_1h_tokens, :thinking_tokens, :web_search_requests,
    :web_fetch_requests, :finalized, :usageSource, :synthetic, :files, :now)
  ON CONFLICT(message_key) DO UPDATE SET
    session_id = excluded.session_id, agent_id = excluded.agent_id, owner_file_id = excluded.owner_file_id,
    model = excluded.model, ts = excluded.ts, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
    cache_read_tokens = excluded.cache_read_tokens, cache_creation_tokens = excluded.cache_creation_tokens,
    cache_creation_5m_tokens = excluded.cache_creation_5m_tokens, cache_creation_1h_tokens = excluded.cache_creation_1h_tokens,
    thinking_tokens = excluded.thinking_tokens, web_search_requests = excluded.web_search_requests,
    web_fetch_requests = excluded.web_fetch_requests, finalized = excluded.finalized, usage_source = excluded.usage_source,
    synthetic = excluded.synthetic, files = excluded.files, updated_at = excluded.updated_at`;

/** What one message adds to the rollup of its owner (03 3.6 step 3). */
interface Contribution {
  messages: number;
  synthetic: number;
  unfinalized: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  inputMissing: number;
  outputMissing: number;
  cacheReadMissing: number;
  cacheCreationMissing: number;
}

const CONTRIBUTION_KEYS = [
  'messages',
  'synthetic',
  'unfinalized',
  'input',
  'output',
  'cacheRead',
  'cacheCreation',
  'inputMissing',
  'outputMissing',
  'cacheReadMissing',
  'cacheCreationMissing',
] as const satisfies readonly (keyof Contribution)[];

function zero(): Contribution {
  return {
    messages: 0,
    synthetic: 0,
    unfinalized: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    inputMissing: 0,
    outputMissing: 0,
    cacheReadMissing: 0,
    cacheCreationMissing: 0,
  };
}

function contributionOf(row: UsageDbRow): Contribution {
  const synthetic = row.synthetic === 1 ? 1 : 0;
  return {
    messages: 1,
    synthetic,
    unfinalized: synthetic === 1 ? 0 : 1 - row.finalized,
    input: row.input_tokens ?? 0,
    output: row.output_tokens ?? 0,
    cacheRead: row.cache_read_tokens ?? 0,
    cacheCreation: row.cache_creation_tokens ?? 0,
    inputMissing: row.input_tokens === null ? 1 : 0,
    outputMissing: row.output_tokens === null ? 1 : 0,
    cacheReadMissing: row.cache_read_tokens === null ? 1 : 0,
    cacheCreationMissing: row.cache_creation_tokens === null ? 1 : 0,
  };
}

/** `sign` times the contribution, added into the delta of `id`. */
function accumulate(deltas: Map<number, Contribution>, id: number, c: Contribution, sign: 1 | -1): void {
  let delta = deltas.get(id);
  if (delta === undefined) {
    delta = zero();
    deltas.set(id, delta);
  }
  for (const key of CONTRIBUTION_KEYS) delta[key] += sign * c[key];
}

function isZero(c: Contribution): boolean {
  return CONTRIBUTION_KEYS.every((key) => c[key] === 0);
}

/** The rollup columns, in the order of `CONTRIBUTION_KEYS`; the same on `sessions` and `agents` (03 3.5). */
const ROLLUP_COLUMNS = [
  'usage_messages',
  'usage_synthetic',
  'usage_unfinalized',
  'tok_input',
  'tok_output',
  'tok_cache_read',
  'tok_cache_creation',
  'tok_input_missing',
  'tok_output_missing',
  'tok_cache_read_missing',
  'tok_cache_creation_missing',
] as const;

function addDeltaSql(table: 'sessions' | 'agents'): string {
  const sets = ROLLUP_COLUMNS.map((column, i) => `${column} = ${column} + :d${String(i)}`).join(', ');
  return `UPDATE ${table} SET ${sets} WHERE id = :id`;
}

function deltaParams(id: number, c: Contribution): Record<string, number> {
  const params: Record<string, number> = { id };
  CONTRIBUTION_KEYS.forEach((key, i) => {
    params[`d${String(i)}`] = c[key];
  });
  return params;
}

const ADD_TO_SESSION = addDeltaSql('sessions');
const ADD_TO_AGENT = addDeltaSql('agents');

// The model joins the list of the owner session when it is new there (at most 16, within the 1 KiB column) and becomes its last model.
const NOTE_MODEL = `UPDATE sessions SET
    models = CASE WHEN json_array_length(models) < 16
                   AND NOT EXISTS (SELECT 1 FROM json_each(models) WHERE value = :model)
                   AND length(json_insert(models, '$[#]', :model)) <= 1024
                  THEN json_insert(models, '$[#]', :model) ELSE models END,
    last_model = :model
  WHERE id = :id AND (last_model IS NOT :model OR NOT EXISTS (SELECT 1 FROM json_each(models) WHERE value = :model))`;

/** The model that stands for "no model known" in a `usage` row (the column is NOT NULL). */
const UNKNOWN_MODEL = 'unknown';
const SYNTHETIC_MODEL = '<synthetic>';

function verifySql(table: 'sessions' | 'agents', ownerColumn: 'session_id' | 'agent_id'): string {
  return `SELECT t.id AS id,
      ${ROLLUP_COLUMNS.map((column, i) => `t.${column} AS s${String(i)}`).join(', ')},
      coalesce(u.messages, 0) AS e0, coalesce(u.synthetic, 0) AS e1, coalesce(u.unfinalized, 0) AS e2,
      coalesce(u.input, 0) AS e3, coalesce(u.output, 0) AS e4, coalesce(u.cache_read, 0) AS e5,
      coalesce(u.cache_creation, 0) AS e6, coalesce(u.input_missing, 0) AS e7, coalesce(u.output_missing, 0) AS e8,
      coalesce(u.cache_read_missing, 0) AS e9, coalesce(u.cache_creation_missing, 0) AS e10
    FROM ${table} t
    LEFT JOIN (
      SELECT ${ownerColumn} AS owner, count(*) AS messages, sum(synthetic) AS synthetic,
        sum(CASE WHEN synthetic = 1 THEN 0 ELSE 1 - finalized END) AS unfinalized,
        sum(coalesce(input_tokens, 0)) AS input, sum(coalesce(output_tokens, 0)) AS output,
        sum(coalesce(cache_read_tokens, 0)) AS cache_read, sum(coalesce(cache_creation_tokens, 0)) AS cache_creation,
        sum(input_tokens IS NULL) AS input_missing, sum(output_tokens IS NULL) AS output_missing,
        sum(cache_read_tokens IS NULL) AS cache_read_missing, sum(cache_creation_tokens IS NULL) AS cache_creation_missing
      FROM usage GROUP BY ${ownerColumn}) u ON u.owner = t.id
    ORDER BY t.id`;
}

const VERIFY_SESSIONS = verifySql('sessions', 'session_id');
const VERIFY_AGENTS = verifySql('agents', 'agent_id');

type VerifyDbRow = Record<string, number>;

function rollupFrom(row: VerifyDbRow, prefix: 's' | 'e'): UsageRollup {
  const at = (i: number): number => row[`${prefix}${String(i)}`] ?? 0;
  return {
    messages: at(0),
    synthetic: at(1),
    unfinalized: at(2),
    input: at(3),
    output: at(4),
    cacheRead: at(5),
    cacheCreation: at(6),
    inputMissing: at(7),
    outputMissing: at(8),
    cacheReadMissing: at(9),
    cacheCreationMissing: at(10),
  };
}

function sameRollup(a: UsageRollup, b: UsageRollup): boolean {
  return (
    a.messages === b.messages &&
    a.synthetic === b.synthetic &&
    a.unfinalized === b.unfinalized &&
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheCreation === b.cacheCreation &&
    a.inputMissing === b.inputMissing &&
    a.outputMissing === b.outputMissing &&
    a.cacheReadMissing === b.cacheReadMissing &&
    a.cacheCreationMissing === b.cacheCreationMissing
  );
}

function toUsageRow(r: UsageDbRow): UsageRow {
  return {
    id: r.id,
    messageKey: r.message_key,
    sessionId: r.session_id,
    agentId: r.agent_id,
    ownerFileId: r.owner_file_id,
    model: r.model,
    ts: r.ts,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheCreation5mTokens: r.cache_creation_5m_tokens,
    cacheCreation1hTokens: r.cache_creation_1h_tokens,
    thinkingTokens: r.thinking_tokens,
    webSearchRequests: r.web_search_requests,
    webFetchRequests: r.web_fetch_requests,
    finalized: r.finalized === 1,
    usageSource: r.usage_source,
    synthetic: r.synthetic === 1,
    files: r.files,
    updatedAt: r.updated_at,
  };
}

function toUsageFileRow(r: UsageFileDbRow): UsageFileRow {
  return {
    fileId: r.file_id,
    messageKey: r.message_key,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheCreation5mTokens: r.cache_creation_5m_tokens,
    cacheCreation1hTokens: r.cache_creation_1h_tokens,
    thinkingTokens: r.thinking_tokens,
    webSearchRequests: r.web_search_requests,
    webFetchRequests: r.web_fetch_requests,
    legacyIn: r.legacy_in,
    legacyOut: r.legacy_out,
    legacyCr: r.legacy_cr,
    legacyCc: r.legacy_cc,
    finalized: r.finalized === 1,
    usageSource: r.usage_source,
    synthetic: r.synthetic === 1,
    invalidValues: r.invalid_values,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    recordCount: r.record_count,
  };
}

/** The columns of the instance value that a record can change: every column except `files` and `updated_at`. */
function sameInstanceValue(a: UsageDbRow, b: UsageDbRow): boolean {
  return (
    a.session_id === b.session_id &&
    a.agent_id === b.agent_id &&
    a.owner_file_id === b.owner_file_id &&
    a.model === b.model &&
    a.ts === b.ts &&
    NUMERIC_FIELDS.every((column) => a[column] === b[column]) &&
    a.finalized === b.finalized &&
    a.usage_source === b.usage_source &&
    a.synthetic === b.synthetic
  );
}

function notFound(what: string): DbError {
  return new DbError('db_constraint', `the ${what} does not exist`, { constraint: 'foreignkey' });
}

export class UsageRepo {
  readonly #db: InstanceDb;

  constructor(db: InstanceDb) {
    this.#db = db;
  }

  /**
   * Applies one record of one message in one file (03 3.6 steps 1-5): the per-file maximum, the instance value of the key, its
   * owner, the rollups of the owner session and agent (the previous owner gives its contribution back) and the model list.
   * Reserves `usage/invalidate` for the sessions whose usage changed. A file that does not exist, has no session, or has no
   * agent row to own the message is a `db_constraint` error and nothing is written.
   */
  applyRecord(
    ctx: RepoContext,
    tx: WriteTx,
    fileId: number,
    messageKey: string,
    values: UsageValues,
  ): UsageApplyResult {
    this.#db.assertScope(ctx);
    const eligible = this.#db.driver
      .prepare<{ agent_id: number | null }>(
        `SELECT coalesce(f.agent_id, (SELECT a.id FROM agents a WHERE a.session_id = f.session_id AND a.agent_uid = 'main')) AS agent_id
           FROM transcript_files f JOIN sessions s ON s.id = f.session_id WHERE f.id = ?`,
      )
      .get([fileId]);
    if ((eligible?.agent_id ?? null) === null) throw notFound('transcript file, with its session and agent');
    this.#db.driver.prepare(UPSERT_FILE).run({
      fileId,
      messageKey,
      model: values.model,
      input: values.inputTokens,
      output: values.outputTokens,
      cacheRead: values.cacheReadTokens,
      cacheCreation: values.cacheCreationTokens,
      cacheCreation5m: values.cacheCreation5mTokens,
      cacheCreation1h: values.cacheCreation1hTokens,
      thinking: values.thinkingTokens,
      webSearch: values.webSearchRequests,
      webFetch: values.webFetchRequests,
      legacyIn: values.legacyIn,
      legacyOut: values.legacyOut,
      legacyCr: values.legacyCr,
      legacyCc: values.legacyCc,
      finalized: values.finalized ? 1 : 0,
      usageSource: values.usageSource,
      synthetic: values.synthetic ? 1 : 0,
      ts: values.ts,
      invalid: values.invalidValues,
    });
    return this.#recompute(tx, messageKey);
  }

  /**
   * Recomputes the instance value, the owner and the rollups of a key from the rows of its files (03 3.6 steps 2-5). Called
   * after the files of a key changed behind the repository's back: an owner session deleted by retention, a file retired.
   */
  recomputeKey(ctx: RepoContext, tx: WriteTx, messageKey: string): UsageApplyResult {
    this.#db.assertScope(ctx);
    return this.#recompute(tx, messageKey);
  }

  /**
   * Deletes the per-file rows of a file (an identity reset, 02 5.3; data retention, 03 3.8) and recomputes every key it held:
   * a key that other files hold moves to the oldest of them, a key that no file holds disappears and its owner gives the
   * contribution back. `maxKeys` bounds the work of one call; `more` says that keys remain and the call must be repeated.
   */
  removeFile(
    ctx: RepoContext,
    tx: WriteTx,
    fileId: number,
    options: { maxKeys?: number } = {},
  ): { keys: string[]; more: boolean } {
    this.#db.assertScope(ctx);
    const limit = options.maxKeys === undefined ? -1 : Math.max(1, Math.floor(options.maxKeys));
    const driver = this.#db.driver;
    const keys = driver
      .prepare<{ message_key: string }>(
        'SELECT message_key FROM usage_files WHERE file_id = ? ORDER BY message_key LIMIT ?',
      )
      .all([fileId, limit])
      .map((row) => row.message_key);
    const remove = driver.prepare('DELETE FROM usage_files WHERE file_id = ? AND message_key = ?');
    for (const key of keys) {
      remove.run([fileId, key]);
      this.#recompute(tx, key);
    }
    const more = driver.prepare('SELECT 1 FROM usage_files WHERE file_id = ? LIMIT 1').get([fileId]) !== undefined;
    return { keys, more };
  }

  /** The rows where a rollup of a session or an agent differs from the sums of the `usage` rows it owns (maintenance, tests). */
  verifyRollups(ctx: RepoContext): RollupMismatch[] {
    this.#db.assertScope(ctx);
    const mismatches: RollupMismatch[] = [];
    for (const [scope, sql] of [
      ['session', VERIFY_SESSIONS],
      ['agent', VERIFY_AGENTS],
    ] as const) {
      for (const row of this.#db.driver.prepare<VerifyDbRow>(sql).all()) {
        const stored = rollupFrom(row, 's');
        const expected = rollupFrom(row, 'e');
        if (!sameRollup(stored, expected)) mismatches.push({ scope, id: row['id'] ?? 0, stored, expected });
      }
    }
    return mismatches;
  }

  /** The instance value of a message key. */
  get(ctx: RepoContext, messageKey: string): UsageRow | undefined {
    this.#db.assertScope(ctx);
    const row = this.#db.driver.prepare<UsageDbRow>('SELECT * FROM usage WHERE message_key = ?').get([messageKey]);
    return row === undefined ? undefined : toUsageRow(row);
  }

  /** The values of a message key in one file. */
  getFile(ctx: RepoContext, fileId: number, messageKey: string): UsageFileRow | undefined {
    this.#db.assertScope(ctx);
    const row = this.#db.driver
      .prepare<UsageFileDbRow>('SELECT * FROM usage_files WHERE file_id = ? AND message_key = ?')
      .get([fileId, messageKey]);
    return row === undefined ? undefined : toUsageFileRow(row);
  }

  #recompute(tx: WriteTx, messageKey: string): UsageApplyResult {
    const driver = this.#db.driver;
    const old = driver.prepare<UsageDbRow>('SELECT * FROM usage WHERE message_key = ?').get([messageKey]);
    const owner = driver.prepare<OwnerDbRow>(OWNER).get([messageKey]);
    if (owner === undefined) return this.#release(tx, old);
    if (owner.agent_id === null) throw notFound('main agent of the owner session');
    const aggregate = driver.prepare<AggregateDbRow>(AGGREGATE).get([messageKey]);
    if (aggregate === undefined) throw new DbError('db_io', 'database operation failed');

    const next: UsageDbRow = {
      id: old?.id ?? 0,
      message_key: messageKey,
      session_id: owner.session_id,
      agent_id: owner.agent_id,
      owner_file_id: owner.file_id,
      model: owner.model ?? aggregate.any_model ?? UNKNOWN_MODEL,
      ts: aggregate.first_ts ?? owner.discovered_at,
      input_tokens: aggregate.input_tokens,
      output_tokens: aggregate.output_tokens,
      cache_read_tokens: aggregate.cache_read_tokens,
      cache_creation_tokens: aggregate.cache_creation_tokens,
      cache_creation_5m_tokens: aggregate.cache_creation_5m_tokens,
      cache_creation_1h_tokens: aggregate.cache_creation_1h_tokens,
      thinking_tokens: aggregate.thinking_tokens,
      web_search_requests: aggregate.web_search_requests,
      web_fetch_requests: aggregate.web_fetch_requests,
      finalized: aggregate.finalized ?? 0,
      usage_source: aggregate.iterations === 1 ? 'iterations' : 'top',
      synthetic: aggregate.synthetic ?? 0,
      files: aggregate.files,
      updated_at: tx.now,
    };

    const valueChanged = old === undefined || !sameInstanceValue(old, next);
    if (valueChanged || old.files !== next.files) {
      driver.prepare(UPSERT_USAGE).run({
        messageKey,
        sessionId: next.session_id,
        agentId: next.agent_id,
        ownerFileId: next.owner_file_id,
        model: next.model,
        ts: next.ts,
        input_tokens: next.input_tokens,
        output_tokens: next.output_tokens,
        cache_read_tokens: next.cache_read_tokens,
        cache_creation_tokens: next.cache_creation_tokens,
        cache_creation_5m_tokens: next.cache_creation_5m_tokens,
        cache_creation_1h_tokens: next.cache_creation_1h_tokens,
        thinking_tokens: next.thinking_tokens,
        web_search_requests: next.web_search_requests,
        web_fetch_requests: next.web_fetch_requests,
        finalized: next.finalized,
        usageSource: next.usage_source,
        synthetic: next.synthetic,
        files: next.files,
        now: tx.now,
      });
    }

    // the rollups move by the difference between what the message contributed and what it contributes now
    const sessions = new Map<number, Contribution>();
    const agents = new Map<number, Contribution>();
    const fresh = contributionOf(next);
    if (old !== undefined) {
      const previous = contributionOf(old);
      accumulate(sessions, old.session_id, previous, -1);
      accumulate(agents, old.agent_id, previous, -1);
    }
    accumulate(sessions, next.session_id, fresh, 1);
    accumulate(agents, next.agent_id, fresh, 1);
    const touchedSessionIds = this.#applyDeltas(ADD_TO_SESSION, sessions);
    const touchedAgentIds = this.#applyDeltas(ADD_TO_AGENT, agents);

    if (
      (old?.session_id !== next.session_id || old.model !== next.model) &&
      next.model !== UNKNOWN_MODEL &&
      next.model !== SYNTHETIC_MODEL
    ) {
      driver.prepare(NOTE_MODEL).run({ id: next.session_id, model: next.model });
    }

    const changed = valueChanged || touchedSessionIds.length > 0 || touchedAgentIds.length > 0;
    if (changed) {
      this.#announce(tx, next.session_id, owner.session_uid);
      if (old !== undefined && old.session_id !== next.session_id) this.#announceById(tx, old.session_id);
    }
    return {
      changed,
      owner: { fileId: owner.file_id, sessionId: next.session_id, agentId: next.agent_id },
      touchedSessionIds,
      touchedAgentIds,
    };
  }

  /** No file of the key can own it any more: its instance row goes and the owner gives the contribution back. */
  #release(tx: WriteTx, old: UsageDbRow | undefined): UsageApplyResult {
    if (old === undefined) return { changed: false, owner: null, touchedSessionIds: [], touchedAgentIds: [] };
    const sessions = new Map<number, Contribution>();
    const agents = new Map<number, Contribution>();
    const previous = contributionOf(old);
    accumulate(sessions, old.session_id, previous, -1);
    accumulate(agents, old.agent_id, previous, -1);
    const touchedSessionIds = this.#applyDeltas(ADD_TO_SESSION, sessions);
    const touchedAgentIds = this.#applyDeltas(ADD_TO_AGENT, agents);
    this.#db.driver.prepare('DELETE FROM usage WHERE id = ?').run([old.id]);
    this.#announceById(tx, old.session_id);
    return { changed: true, owner: null, touchedSessionIds, touchedAgentIds };
  }

  /** Writes the non-zero deltas; returns the ids whose rollup was rewritten, in ascending order. */
  #applyDeltas(sql: string, deltas: ReadonlyMap<number, Contribution>): number[] {
    const statement = this.#db.driver.prepare(sql);
    const touched: number[] = [];
    for (const [id, delta] of deltas) {
      if (isZero(delta)) continue;
      statement.run(deltaParams(id, delta));
      touched.push(id);
    }
    return touched.sort((a, b) => a - b);
  }

  #announce(tx: WriteTx, sessionId: number, sessionUid: string): void {
    tx.changes.reserve('usage', 'invalidate', { entityId: sessionId, sessionUid });
  }

  /** The session of a previous owner may be gone with its rows (retention): then there is nobody to tell. */
  #announceById(tx: WriteTx, sessionId: number): void {
    const session = this.#db.driver
      .prepare<{ session_uid: string }>('SELECT session_uid FROM sessions WHERE id = ?')
      .get([sessionId]);
    if (session !== undefined) this.#announce(tx, sessionId, session.session_uid);
  }
}
