// TranscriptFilesRepo: the tracked transcript files, their identity, import cursors, counters and freshness (02 4.1, 5.3-5.5,
// 5.9; table `transcript_files`). SQL only: when a file is tracked, what the cursors mean and when an identity counts as
// changed is the importer's (02 section 5); this repository stores them and the DB keeps the invariant
// `0 <= head_end <= backfill_offset <= tail_start <= tail_offset <= size_seen` (CHECK, enforced while the file is active).
//
// `updateCursors` writes the cursors in the same transaction as the rows derived from the bytes the cursor passed, and, when
// `size_seen` grew, reserves `transcript/append` with the size, the tail and the agent (03 9.1) so that mounted transcript
// views refresh. Every public method takes the `RepoContext` first and asserts the scope (03 4.5).
import { DbError } from '../errors.ts';
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

export type TranscriptFileKind = 'session' | 'subagent' | 'workflow_agent' | 'workflow_journal' | 'workflow_status';
export type TranscriptFileState = 'active' | 'missing' | 'unreadable' | 'untracked' | 'retired';
export type UsageState = 'complete' | 'partial' | 'skipped_backfill';

/** What discovery knows about a file the first time it sees it (02 5.1.2). */
export interface NewTranscriptFile {
  readonly path: string;
  /** `routeKey`-style key of the path: unique, case-folded on a case-insensitive host. */
  readonly pathKey: string;
  readonly kind: TranscriptFileKind;
  readonly sessionUid: string;
  readonly agentUid: string | null;
  readonly runUid: string | null;
  /** Soft references (validated here): the rows the file belongs to, null while they are not known yet. */
  readonly sessionId: number | null;
  readonly agentId: number | null;
  readonly workflowRunId: number | null;
  /** Birth time of the file, null where the platform has none (02 6.2 rule 7). */
  readonly birthMs: number | null;
  /** mtime at the first sight: the age of a file without a birth time. */
  readonly firstSeenMtimeMs: number | null;
  readonly mtimeSeen: number | null;
}

export interface TranscriptFileRow {
  readonly id: number;
  readonly path: string;
  readonly pathKey: string;
  readonly kind: TranscriptFileKind;
  readonly sessionUid: string;
  readonly agentUid: string | null;
  readonly runUid: string | null;
  readonly sessionId: number | null;
  readonly agentId: number | null;
  readonly workflowRunId: number | null;
  readonly ino: string | null;
  readonly headLen: number;
  readonly headHash: string | null;
  readonly headEnd: number;
  readonly backfillOffset: number;
  readonly tailStart: number;
  readonly tailOffset: number;
  readonly partialBytes: number;
  readonly sizeSeen: number;
  readonly mtimeSeen: number | null;
  readonly birthMs: number | null;
  readonly firstSeenMtimeMs: number | null;
  readonly lineCount: number;
  readonly state: TranscriptFileState;
  readonly usageState: UsageState;
  readonly invalidJson: number;
  readonly notObject: number;
  readonly shapeInvalid: number;
  readonly oversized: number;
  readonly utf8Invalid: number;
  readonly bomStripped: number;
  readonly crlfLines: number;
  readonly unknownTypes: number;
  readonly readErrors: number;
  readonly identityResets: number;
  readonly classifiedLines: number;
  readonly labelCache: string | null;
  readonly firstTsInOrder: string | null;
  readonly maxTsString: string | null;
  readonly lastStopLegacy: string | null;
  readonly behindSince: number | null;
  readonly discoveredAt: number;
  readonly lastReadAt: number | null;
  readonly lastGrowthAt: number | null;
  readonly indexOffset: number;
  readonly indexHeadHash: string | null;
  readonly entriesTotal: number;
  readonly updatedAt: number;
}

export interface FileIdentity {
  /** Decimal text of the inode, null where there is none. */
  readonly ino: string | null;
  readonly headLen: number;
  readonly headHash: string | null;
}

/** Counters of the content read (02 5.9): the values are added to the stored ones. */
export interface CursorCounters {
  invalidJson?: number;
  notObject?: number;
  shapeInvalid?: number;
  oversized?: number;
  utf8Invalid?: number;
  bomStripped?: number;
  crlfLines?: number;
  unknownTypes?: number;
  readErrors?: number;
}

/** A partial update: only the fields that are present are written. A nullable field set to null is cleared. */
export interface FileCursorUpdate {
  headEnd?: number;
  backfillOffset?: number;
  tailStart?: number;
  tailOffset?: number;
  partialBytes?: number;
  sizeSeen?: number;
  mtimeSeen?: number | null;
  lineCount?: number;
  identity?: FileIdentity;
  usageState?: UsageState;
  classifiedLines?: number;
  labelCache?: string | null;
  firstTsInOrder?: string | null;
  maxTsString?: string | null;
  lastStopLegacy?: string | null;
  behindSince?: number | null;
  lastReadAt?: number | null;
  lastGrowthAt?: number | null;
  counters?: CursorCounters;
}

export interface CursorUpdateResult {
  /** `size_seen` grew: `transcript/append` was reserved. */
  readonly sizeGrew: boolean;
  readonly seq: number | null;
}

export interface IndexState {
  readonly indexOffset: number;
  readonly entriesTotal: number;
  readonly indexHeadHash: string | null;
}

interface FileDbRow {
  id: number;
  path: string;
  path_key: string;
  kind: TranscriptFileKind;
  session_uid: string;
  agent_uid: string | null;
  run_uid: string | null;
  session_id: number | null;
  agent_id: number | null;
  workflow_run_id: number | null;
  ino: string | null;
  head_len: number;
  head_hash: string | null;
  head_end: number;
  backfill_offset: number;
  tail_start: number;
  tail_offset: number;
  partial_bytes: number;
  size_seen: number;
  mtime_seen: number | null;
  birth_ms: number | null;
  first_seen_mtime_ms: number | null;
  line_count: number;
  state: TranscriptFileState;
  usage_state: UsageState;
  invalid_json: number;
  not_object: number;
  shape_invalid: number;
  oversized: number;
  utf8_invalid: number;
  bom_stripped: number;
  crlf_lines: number;
  unknown_types: number;
  read_errors: number;
  identity_resets: number;
  classified_lines: number;
  label_cache: string | null;
  first_ts_in_order: string | null;
  max_ts_string: string | null;
  last_stop_legacy: string | null;
  behind_since: number | null;
  discovered_at: number;
  last_read_at: number | null;
  last_growth_at: number | null;
  index_offset: number;
  index_head_hash: string | null;
  entries_total: number;
  updated_at: number;
}

function toRow(r: FileDbRow): TranscriptFileRow {
  return {
    id: r.id,
    path: r.path,
    pathKey: r.path_key,
    kind: r.kind,
    sessionUid: r.session_uid,
    agentUid: r.agent_uid,
    runUid: r.run_uid,
    sessionId: r.session_id,
    agentId: r.agent_id,
    workflowRunId: r.workflow_run_id,
    ino: r.ino,
    headLen: r.head_len,
    headHash: r.head_hash,
    headEnd: r.head_end,
    backfillOffset: r.backfill_offset,
    tailStart: r.tail_start,
    tailOffset: r.tail_offset,
    partialBytes: r.partial_bytes,
    sizeSeen: r.size_seen,
    mtimeSeen: r.mtime_seen,
    birthMs: r.birth_ms,
    firstSeenMtimeMs: r.first_seen_mtime_ms,
    lineCount: r.line_count,
    state: r.state,
    usageState: r.usage_state,
    invalidJson: r.invalid_json,
    notObject: r.not_object,
    shapeInvalid: r.shape_invalid,
    oversized: r.oversized,
    utf8Invalid: r.utf8_invalid,
    bomStripped: r.bom_stripped,
    crlfLines: r.crlf_lines,
    unknownTypes: r.unknown_types,
    readErrors: r.read_errors,
    identityResets: r.identity_resets,
    classifiedLines: r.classified_lines,
    labelCache: r.label_cache,
    firstTsInOrder: r.first_ts_in_order,
    maxTsString: r.max_ts_string,
    lastStopLegacy: r.last_stop_legacy,
    behindSince: r.behind_since,
    discoveredAt: r.discovered_at,
    lastReadAt: r.last_read_at,
    lastGrowthAt: r.last_growth_at,
    indexOffset: r.index_offset,
    indexHeadHash: r.index_head_hash,
    entriesTotal: r.entries_total,
    updatedAt: r.updated_at,
  };
}

const SELECT = 'SELECT * FROM transcript_files';

const INSERT = `INSERT INTO transcript_files (path, path_key, kind, session_uid, agent_uid, run_uid, session_id, agent_id,
    workflow_run_id, mtime_seen, birth_ms, first_seen_mtime_ms, discovered_at, updated_at)
  VALUES (:path, :pathKey, :kind, :sessionUid, :agentUid, :runUid, :sessionId, :agentId, :workflowRunId, :mtimeSeen,
    :birthMs, :firstSeenMtimeMs, :now, :now)`;

// A known file keeps its cursors, its state and the first sight; it learns the links and the age it did not have, and
// the spelling of its path. Nothing is written when there is nothing to learn.
const RELINK = `UPDATE transcript_files SET
    path = :path,
    session_id = coalesce(session_id, :sessionId),
    agent_id = coalesce(agent_id, :agentId),
    workflow_run_id = coalesce(workflow_run_id, :workflowRunId),
    birth_ms = coalesce(birth_ms, :birthMs),
    first_seen_mtime_ms = coalesce(first_seen_mtime_ms, :firstSeenMtimeMs),
    updated_at = :now
  WHERE id = :id AND (
    path IS NOT :path
    OR (session_id IS NULL AND :sessionId IS NOT NULL)
    OR (agent_id IS NULL AND :agentId IS NOT NULL)
    OR (workflow_run_id IS NULL AND :workflowRunId IS NOT NULL)
    OR (birth_ms IS NULL AND :birthMs IS NOT NULL)
    OR (first_seen_mtime_ms IS NULL AND :firstSeenMtimeMs IS NOT NULL))`;

type ScalarKey = Exclude<keyof FileCursorUpdate, 'identity' | 'counters'>;
type CounterKey = keyof CursorCounters;

// the fixed lists that turn a partial update into SQL: column names never come from a caller
const SCALARS: readonly (readonly [ScalarKey, string])[] = [
  ['headEnd', 'head_end'],
  ['backfillOffset', 'backfill_offset'],
  ['tailStart', 'tail_start'],
  ['tailOffset', 'tail_offset'],
  ['partialBytes', 'partial_bytes'],
  ['sizeSeen', 'size_seen'],
  ['mtimeSeen', 'mtime_seen'],
  ['lineCount', 'line_count'],
  ['usageState', 'usage_state'],
  ['classifiedLines', 'classified_lines'],
  ['labelCache', 'label_cache'],
  ['firstTsInOrder', 'first_ts_in_order'],
  ['maxTsString', 'max_ts_string'],
  ['lastStopLegacy', 'last_stop_legacy'],
  ['behindSince', 'behind_since'],
  ['lastReadAt', 'last_read_at'],
  ['lastGrowthAt', 'last_growth_at'],
];

const COUNTERS: readonly (readonly [CounterKey, string])[] = [
  ['invalidJson', 'invalid_json'],
  ['notObject', 'not_object'],
  ['shapeInvalid', 'shape_invalid'],
  ['oversized', 'oversized'],
  ['utf8Invalid', 'utf8_invalid'],
  ['bomStripped', 'bom_stripped'],
  ['crlfLines', 'crlf_lines'],
  ['unknownTypes', 'unknown_types'],
  ['readErrors', 'read_errors'],
];

// The file starts again from the initial plan of 02 5.5. The counters of the content restart with it; the read errors,
// the first sight, the discovery and the entry index (an independent identity of the transcript service) stay.
const RESET_IDENTITY = `UPDATE transcript_files SET
    ino = :ino, head_len = :headLen, head_hash = :headHash,
    head_end = 0, backfill_offset = 0, tail_start = 0, tail_offset = 0, partial_bytes = 0, line_count = 0,
    usage_state = 'partial', classified_lines = 0, label_cache = NULL, first_ts_in_order = NULL, max_ts_string = NULL,
    last_stop_legacy = NULL, behind_since = NULL,
    invalid_json = 0, not_object = 0, shape_invalid = 0, oversized = 0, utf8_invalid = 0, bom_stripped = 0, crlf_lines = 0,
    unknown_types = 0, identity_resets = identity_resets + 1, updated_at = :now
  WHERE id = :id`;

function notFound(what: string): DbError {
  return new DbError('db_constraint', `the ${what} does not exist`, { constraint: 'foreignkey' });
}

export class TranscriptFilesRepo {
  readonly #db: InstanceDb;

  constructor(db: InstanceDb) {
    this.#db = db;
  }

  /**
   * Records a file at its first sight, or learns what a known file (same `pathKey`) lacked. Returns its id and whether it
   * is new. A session, agent or workflow run that does not exist is a `db_constraint` error.
   */
  register(ctx: RepoContext, tx: WriteTx, file: NewTranscriptFile): { id: number; created: boolean } {
    this.#db.assertScope(ctx);
    this.#requireLinks(file);
    const params = {
      path: file.path,
      pathKey: file.pathKey,
      kind: file.kind,
      sessionUid: file.sessionUid,
      agentUid: file.agentUid,
      runUid: file.runUid,
      sessionId: file.sessionId,
      agentId: file.agentId,
      workflowRunId: file.workflowRunId,
      mtimeSeen: file.mtimeSeen,
      birthMs: file.birthMs,
      firstSeenMtimeMs: file.firstSeenMtimeMs,
      now: tx.now,
    };
    const known = this.#db.driver
      .prepare<{ id: number }>('SELECT id FROM transcript_files WHERE path_key = ?')
      .get([file.pathKey]);
    if (known === undefined) {
      const { lastInsertRowid } = this.#db.driver.prepare(INSERT).run(params);
      return { id: lastInsertRowid, created: true };
    }
    this.#db.driver.prepare(RELINK).run({
      id: known.id,
      path: file.path,
      sessionId: file.sessionId,
      agentId: file.agentId,
      workflowRunId: file.workflowRunId,
      birthMs: file.birthMs,
      firstSeenMtimeMs: file.firstSeenMtimeMs,
      now: tx.now,
    });
    return { id: known.id, created: false };
  }

  get(ctx: RepoContext, id: number): TranscriptFileRow | undefined {
    this.#db.assertScope(ctx);
    const row = this.#db.driver.prepare<FileDbRow>(`${SELECT} WHERE id = ?`).get([id]);
    return row === undefined ? undefined : toRow(row);
  }

  findByPathKey(ctx: RepoContext, pathKey: string): TranscriptFileRow | undefined {
    this.#db.assertScope(ctx);
    const row = this.#db.driver.prepare<FileDbRow>(`${SELECT} WHERE path_key = ?`).get([pathKey]);
    return row === undefined ? undefined : toRow(row);
  }

  /** Every file of a session (its main file, subagent and workflow files) in id order. */
  listForSession(ctx: RepoContext, sessionUid: string): TranscriptFileRow[] {
    this.#db.assertScope(ctx);
    return this.#db.driver
      .prepare<FileDbRow>(`${SELECT} WHERE session_uid = ? ORDER BY id`)
      .all([sessionUid])
      .map(toRow);
  }

  /** The files in any of `states`, in id order, at most `limit`. */
  listByStates(ctx: RepoContext, states: readonly TranscriptFileState[], limit: number): TranscriptFileRow[] {
    this.#db.assertScope(ctx);
    // a negative LIMIT means "no limit" in SQLite: never pass one on
    if (states.length === 0 || !(limit > 0)) return [];
    return this.#db.driver
      .prepare<FileDbRow>(`${SELECT} WHERE state IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?`)
      .all([JSON.stringify(states), Math.floor(limit)])
      .map(toRow);
  }

  /**
   * Writes the fields that are present in `update` (counters are added to the stored ones) and stamps `updated_at`. When
   * `size_seen` grew it reserves `transcript/append` with the new size, tail and agent (the last note of a transaction wins).
   */
  updateCursors(ctx: RepoContext, tx: WriteTx, id: number, update: FileCursorUpdate): CursorUpdateResult {
    this.#db.assertScope(ctx);
    const before = this.#db.driver
      .prepare<{ size_seen: number; session_uid: string; agent_uid: string | null }>(
        'SELECT size_seen, session_uid, agent_uid FROM transcript_files WHERE id = ?',
      )
      .get([id]);
    if (before === undefined) throw notFound('transcript file');

    const sets: string[] = ['updated_at = :now'];
    const params: Record<string, number | string | null> = { id, now: tx.now };
    for (const [key, column] of SCALARS) {
      const value = update[key];
      if (value === undefined) continue;
      sets.push(`${column} = :${key}`);
      params[key] = value;
    }
    if (update.identity !== undefined) {
      sets.push('ino = :ino', 'head_len = :headLen', 'head_hash = :headHash');
      params['ino'] = update.identity.ino;
      params['headLen'] = update.identity.headLen;
      params['headHash'] = update.identity.headHash;
    }
    for (const [key, column] of COUNTERS) {
      const delta = update.counters?.[key];
      if (delta === undefined) continue;
      sets.push(`${column} = ${column} + :c_${key}`);
      params[`c_${key}`] = delta;
    }
    this.#db.driver.prepare(`UPDATE transcript_files SET ${sets.join(', ')} WHERE id = :id`).run(params);

    if (update.sizeSeen === undefined || update.sizeSeen <= before.size_seen) return { sizeGrew: false, seq: null };
    const after = this.#db.driver
      .prepare<{ tail_offset: number }>('SELECT tail_offset FROM transcript_files WHERE id = ?')
      .get([id]);
    const seq = tx.changes.reserve('transcript', 'append', { entityId: id, sessionUid: before.session_uid });
    tx.changes.noteTranscript(seq, {
      sizeBytes: update.sizeSeen,
      tailOffset: after?.tail_offset ?? 0,
      agentUid: before.agent_uid,
    });
    return { sizeGrew: true, seq };
  }

  /** The file was truncated or replaced: a new identity, and the import starts again from the initial plan (02 5.3). */
  resetIdentity(ctx: RepoContext, tx: WriteTx, id: number, identity: FileIdentity): void {
    this.#db.assertScope(ctx);
    const { changes } = this.#db.driver.prepare(RESET_IDENTITY).run({
      id,
      ino: identity.ino,
      headLen: identity.headLen,
      headHash: identity.headHash,
      now: tx.now,
    });
    if (changes === 0) throw notFound('transcript file');
  }

  setState(ctx: RepoContext, tx: WriteTx, id: number, state: TranscriptFileState): void {
    this.#db.assertScope(ctx);
    const { changes } = this.#db.driver
      .prepare('UPDATE transcript_files SET state = ?, updated_at = ? WHERE id = ?')
      .run([state, tx.now, id]);
    if (changes === 0) throw notFound('transcript file');
  }

  /** The position of the entry index of the transcript service (03 7.2); independent of the import cursors. */
  setIndexState(ctx: RepoContext, tx: WriteTx, id: number, index: IndexState): void {
    this.#db.assertScope(ctx);
    const { changes } = this.#db.driver
      .prepare(
        'UPDATE transcript_files SET index_offset = ?, entries_total = ?, index_head_hash = ?, updated_at = ? WHERE id = ?',
      )
      .run([index.indexOffset, index.entriesTotal, index.indexHeadHash, tx.now, id]);
    if (changes === 0) throw notFound('transcript file');
  }

  #requireLinks(file: NewTranscriptFile): void {
    const exists = (sql: string, params: readonly number[]): boolean =>
      this.#db.driver.prepare<{ found: number }>(sql).get(params) !== undefined;
    if (file.sessionId !== null && !exists('SELECT 1 AS found FROM sessions WHERE id = ?', [file.sessionId])) {
      throw notFound('session');
    }
    if (file.agentId !== null) {
      const found =
        file.sessionId === null
          ? exists('SELECT 1 AS found FROM agents WHERE id = ?', [file.agentId])
          : exists('SELECT 1 AS found FROM agents WHERE id = ? AND session_id = ?', [file.agentId, file.sessionId]);
      if (!found) throw notFound('agent');
    }
    if (
      file.workflowRunId !== null &&
      !exists('SELECT 1 AS found FROM workflow_runs WHERE id = ?', [file.workflowRunId])
    ) {
      throw notFound('workflow run');
    }
  }
}
