// ToolCallsRepo: one row per tool call (`tool_use_id`) merged from every source that saw it (03 3.6 "Tool calls", 02 4.1).
// SQL only. The merge rules are the statement of 03 3.6: `started_at` minimum, `ended_at` and `batch_at` maximum, `sources`
// OR-ed, the outcome by precedence error > denied > interrupted > ok, a hook duration preferred, every other column the first
// non-null value. Multi-argument `min()` / `max()` return NULL when an argument is NULL, so each is wrapped in `coalesce`, and
// the precedence is an inlined CASE (no custom SQL function, so the statement needs nothing beyond the driver seam).
//
// Deviation from the statement, which stamps `updated_seq = :seq` on every conflict (CR-WP-10-3): the update is guarded by a
// WHERE that is true only when a merged column would change, and the row is stamped after the change is reserved. A write that
// adds nothing (a hook or a transcript record delivered again, a replay) therefore leaves the row, `updated_seq`,
// `updated_at` and the change log as they were: no phantom `tool_call/upsert`, and a replay leaves an identical database.
//
// After a change the counters of the session are brought in line with indexed counts (`idx_tool_calls_open`, 03 3.6); the
// recount costs O(calls of the session) per changed write (5,000 calls: about 0.9 s in all, CR-WP-10-3).
// Every public method takes the `RepoContext` first and asserts the scope (03 4.5).
import { DbError } from '../errors.ts';
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

export type ToolOutcome = 'ok' | 'error' | 'denied' | 'interrupted';
export type DurationSource = 'hook' | 'timestamps';

/** What one source knows about a call; a source leaves what it does not know null. */
export interface ToolCallWrite {
  /** `sessions.id` */
  readonly sessionId: number;
  /** `agents.id` of an agent of the session (the main agent row for the main conversation). */
  readonly agentId: number;
  readonly promptId: string | null;
  readonly toolUseId: string;
  /** The name of the first write stays. */
  readonly name: string;
  readonly mcpServer: string | null;
  readonly summary: string | null;
  readonly inputHash: string | null;
  readonly inputBytes: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly batchAt: number | null;
  /** Needs `endedAt` (CHECK). */
  readonly outcome: ToolOutcome | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly durationSource: DurationSource | null;
  /** Bits: 1 hook_pre, 2 hook_post, 4 transcript_use, 8 transcript_result, 16 hook_batch. */
  readonly sources: number;
  readonly callFileId: number | null;
  readonly callOffset: number | null;
  readonly resultFileId: number | null;
  readonly resultOffset: number | null;
  /** `agents.id` of the agent this call started (Agent tool). */
  readonly subagentId: number | null;
  /** `workflow_runs.id` of the run this call launched (Workflow tool). */
  readonly workflowRunId: number | null;
}

export interface ToolCallRow extends ToolCallWrite {
  readonly id: number;
  readonly updatedSeq: number;
  readonly updatedAt: number;
}

export interface ToolCallUpsertResult {
  readonly id: number;
  /** `unchanged`: the write added nothing, so nothing was written, reserved or announced. */
  readonly outcome: 'inserted' | 'merged' | 'unchanged';
  /** The `tool_call/upsert` seq the row was stamped with, null when unchanged. */
  readonly seq: number | null;
  /** `sessions.open_tool_count` or `tool_call_count` changed: the session is a visible change. */
  readonly countersChanged: boolean;
}

interface ToolCallDbRow {
  id: number;
  session_id: number;
  agent_id: number;
  prompt_id: string | null;
  tool_use_id: string;
  name: string;
  mcp_server: string | null;
  summary: string | null;
  input_hash: string | null;
  input_bytes: number | null;
  started_at: number | null;
  ended_at: number | null;
  batch_at: number | null;
  outcome: ToolOutcome | null;
  exit_code: number | null;
  duration_ms: number | null;
  duration_source: DurationSource | null;
  sources: number;
  call_file_id: number | null;
  call_offset: number | null;
  result_file_id: number | null;
  result_offset: number | null;
  subagent_id: number | null;
  workflow_run_id: number | null;
  updated_seq: number;
  updated_at: number;
}

function toRow(r: ToolCallDbRow): ToolCallRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    promptId: r.prompt_id,
    toolUseId: r.tool_use_id,
    name: r.name,
    mcpServer: r.mcp_server,
    summary: r.summary,
    inputHash: r.input_hash,
    inputBytes: r.input_bytes,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    batchAt: r.batch_at,
    outcome: r.outcome,
    exitCode: r.exit_code,
    durationMs: r.duration_ms,
    durationSource: r.duration_source,
    sources: r.sources,
    callFileId: r.call_file_id,
    callOffset: r.call_offset,
    resultFileId: r.result_file_id,
    resultOffset: r.result_offset,
    subagentId: r.subagent_id,
    workflowRunId: r.workflow_run_id,
    updatedSeq: r.updated_seq,
    updatedAt: r.updated_at,
  };
}

/** Inlines the precedence of an outcome: error 4 > denied 3 > interrupted 2 > ok 1 > none 0. */
function rank(outcome: string): string {
  return `(CASE ${outcome} WHEN 'error' THEN 4 WHEN 'denied' THEN 3 WHEN 'interrupted' THEN 2 WHEN 'ok' THEN 1 ELSE 0 END)`;
}

const FIRST_NON_NULL = [
  'prompt_id',
  'mcp_server',
  'summary',
  'input_hash',
  'input_bytes',
  'exit_code',
  'call_file_id',
  'call_offset',
  'result_file_id',
  'result_offset',
  'subagent_id',
  'workflow_run_id',
] as const;

/** Every merged column and the expression of its new value (`excluded` = the write, `tool_calls` = the stored row). */
const MERGES: readonly (readonly [column: string, expression: string])[] = [
  [
    'started_at',
    'coalesce(min(tool_calls.started_at, excluded.started_at), tool_calls.started_at, excluded.started_at)',
  ],
  ['ended_at', 'coalesce(max(tool_calls.ended_at, excluded.ended_at), tool_calls.ended_at, excluded.ended_at)'],
  ['batch_at', 'coalesce(max(tool_calls.batch_at, excluded.batch_at), tool_calls.batch_at, excluded.batch_at)'],
  ['sources', 'tool_calls.sources | excluded.sources'],
  [
    'outcome',
    `CASE WHEN ${rank('excluded.outcome')} > ${rank('tool_calls.outcome')} THEN excluded.outcome ELSE tool_calls.outcome END`,
  ],
  [
    'duration_ms',
    "coalesce(CASE WHEN excluded.duration_source = 'hook' THEN excluded.duration_ms END, tool_calls.duration_ms, excluded.duration_ms)",
  ],
  [
    'duration_source',
    "CASE WHEN excluded.duration_source = 'hook' THEN 'hook' ELSE coalesce(tool_calls.duration_source, excluded.duration_source) END",
  ],
  ...FIRST_NON_NULL.map((column) => [column, `coalesce(tool_calls.${column}, excluded.${column})`] as const),
];

const SET_MERGED = MERGES.map(([column, expression]) => `${column} = ${expression}`).join(', ');
const CHANGES_SOMETHING = MERGES.map(([column, expression]) => `tool_calls.${column} IS NOT (${expression})`).join(
  ' OR ',
);

// The row is inserted with updated_seq 0 and stamped once the change is reserved; RETURNING says whether a row was written
// (a guarded conflict that changes nothing returns no row) and, from updated_seq, whether it was new.
const UPSERT = `INSERT INTO tool_calls (session_id, agent_id, prompt_id, tool_use_id, name, mcp_server, summary, input_hash,
    input_bytes, started_at, ended_at, batch_at, outcome, exit_code, duration_ms, duration_source, sources, call_file_id,
    call_offset, result_file_id, result_offset, subagent_id, workflow_run_id, updated_seq, updated_at)
  VALUES (:sessionId, :agentId, :promptId, :toolUseId, :name, :mcpServer, :summary, :inputHash, :inputBytes, :startedAt,
    :endedAt, :batchAt, :outcome, :exitCode, :durationMs, :durationSource, :sources, :callFileId, :callOffset,
    :resultFileId, :resultOffset, :subagentId, :workflowRunId, 0, :now)
  ON CONFLICT(tool_use_id) DO UPDATE SET ${SET_MERGED}
  WHERE ${CHANGES_SOMETHING}
  RETURNING id, updated_seq`;

const COUNTS = `SELECT s.open_tool_count AS stored_open, s.tool_call_count AS stored_total,
    (SELECT count(*) FROM tool_calls WHERE session_id = s.id AND ended_at IS NULL AND batch_at IS NULL) AS open_now,
    (SELECT count(*) FROM tool_calls WHERE session_id = s.id) AS total_now
  FROM sessions s WHERE s.id = ?`;

function notFound(what: string): DbError {
  return new DbError('db_constraint', `the ${what} does not exist`, { constraint: 'foreignkey' });
}

export class ToolCallsRepo {
  readonly #db: InstanceDb;

  constructor(db: InstanceDb) {
    this.#db = db;
  }

  /**
   * Inserts the call or merges the write into it. A write that changes a column reserves `tool_call/upsert` (one per
   * transaction and session, with the ids of up to 50 calls), stamps the row with its seq and refreshes the counters of
   * the session. A session, agent, subagent, workflow run or file that does not exist (or belongs to another session) is a
   * `db_constraint` error.
   */
  upsert(ctx: RepoContext, tx: WriteTx, call: ToolCallWrite): ToolCallUpsertResult {
    this.#db.assertScope(ctx);
    const sessionUid = this.#requireRefs(call);
    const written = this.#db.driver.prepare<{ id: number; updated_seq: number }>(UPSERT).get({
      sessionId: call.sessionId,
      agentId: call.agentId,
      promptId: call.promptId,
      toolUseId: call.toolUseId,
      name: call.name,
      mcpServer: call.mcpServer,
      summary: call.summary,
      inputHash: call.inputHash,
      inputBytes: call.inputBytes,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      batchAt: call.batchAt,
      outcome: call.outcome,
      exitCode: call.exitCode,
      durationMs: call.durationMs,
      durationSource: call.durationSource,
      sources: call.sources,
      callFileId: call.callFileId,
      callOffset: call.callOffset,
      resultFileId: call.resultFileId,
      resultOffset: call.resultOffset,
      subagentId: call.subagentId,
      workflowRunId: call.workflowRunId,
      now: tx.now,
    });
    if (written === undefined) {
      const known = this.#db.driver
        .prepare<{ id: number }>('SELECT id FROM tool_calls WHERE tool_use_id = ?')
        .get([call.toolUseId]);
      if (known === undefined) throw new DbError('db_io', 'database operation failed');
      return { id: known.id, outcome: 'unchanged', seq: null, countersChanged: false };
    }
    const seq = tx.changes.reserve('tool_call', 'upsert', { entityId: null, sessionUid });
    tx.changes.noteId(seq, written.id);
    this.#db.driver
      .prepare('UPDATE tool_calls SET updated_seq = ?, updated_at = ? WHERE id = ?')
      .run([seq, tx.now, written.id]);
    return {
      id: written.id,
      outcome: written.updated_seq === 0 ? 'inserted' : 'merged',
      seq,
      countersChanged: this.#refreshCounters(call.sessionId),
    };
  }

  get(ctx: RepoContext, toolUseId: string): ToolCallRow | undefined {
    this.#db.assertScope(ctx);
    const row = this.#db.driver
      .prepare<ToolCallDbRow>('SELECT * FROM tool_calls WHERE tool_use_id = ?')
      .get([toolUseId]);
    return row === undefined ? undefined : toRow(row);
  }

  /** The calls of a session with neither an end nor a batch, oldest first (`idx_tool_calls_open`). */
  openForSession(ctx: RepoContext, sessionId: number, limit: number): ToolCallRow[] {
    this.#db.assertScope(ctx);
    // a negative LIMIT means "no limit" in SQLite: never pass one on
    if (!(limit > 0)) return [];
    return this.#db.driver
      .prepare<ToolCallDbRow>(
        `SELECT * FROM tool_calls WHERE session_id = ? AND ended_at IS NULL AND batch_at IS NULL
           ORDER BY started_at, id LIMIT ?`,
      )
      .all([sessionId, Math.floor(limit)])
      .map(toRow);
  }

  /** Validates the soft references; returns the uid of the session for the change row. */
  #requireRefs(call: ToolCallWrite): string {
    const driver = this.#db.driver;
    const session = driver
      .prepare<{ session_uid: string }>('SELECT session_uid FROM sessions WHERE id = ?')
      .get([call.sessionId]);
    if (session === undefined) throw notFound('session');
    const inSession = (sql: string, id: number): boolean =>
      driver.prepare<{ found: number }>(sql).get([id, call.sessionId]) !== undefined;
    const agent = 'SELECT 1 AS found FROM agents WHERE id = ? AND session_id = ?';
    if (!inSession(agent, call.agentId)) throw notFound('agent');
    if (call.subagentId !== null && !inSession(agent, call.subagentId)) throw notFound('subagent');
    if (
      call.workflowRunId !== null &&
      !inSession('SELECT 1 AS found FROM workflow_runs WHERE id = ? AND session_id = ?', call.workflowRunId)
    ) {
      throw notFound('workflow run');
    }
    for (const fileId of [call.callFileId, call.resultFileId]) {
      if (fileId === null) continue;
      if (
        driver.prepare<{ found: number }>('SELECT 1 AS found FROM transcript_files WHERE id = ?').get([fileId]) ===
        undefined
      ) {
        throw notFound('transcript file');
      }
    }
    return session.session_uid;
  }

  /** Brings the counters of the session in line with the indexed counts; true when they changed. */
  #refreshCounters(sessionId: number): boolean {
    const counts = this.#db.driver
      .prepare<{ stored_open: number; stored_total: number; open_now: number; total_now: number }>(COUNTS)
      .get([sessionId]);
    if (counts === undefined || (counts.stored_open === counts.open_now && counts.stored_total === counts.total_now)) {
      return false;
    }
    this.#db.driver
      .prepare('UPDATE sessions SET open_tool_count = ?, tool_call_count = ? WHERE id = ?')
      .run([counts.open_now, counts.total_now, sessionId]);
    return true;
  }
}
