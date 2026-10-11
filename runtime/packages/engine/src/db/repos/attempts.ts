// `attempt_sources` and `attempt_runs` (03 3.5, 3.6 "Attempts"; 06 3.10): chain-log attempts. SQL only: the tick
// algorithm, the matching and the evidence rules are 06 3.10.3-3.10.8. One `withWriteTx` per attempts tick holds every
// write of this class.
//
// Change log (03 9.1, registry C40, N-10): this class reserves the `attempt/upsert` change itself, once per transaction
// (the recorder coalesces), and only when a row really changes, so a re-read that finds nothing new writes no change.
// Every changed `attempt_runs` row is stamped with that seq and named in the payload; a reset or a detach changes rows
// it cannot name and leaves the payload `truncated`.
//
// KNOWN LIMIT (CR-WP-11-2): the recorder cannot force `truncated`, so `truncated` is true only when no other run is
// noted in the same transaction. A reset or a detach that shares its transaction with an `insertRun`, `endRun`,
// `supersedeRun` or `setMatch` yields `truncated: false` and names only the noted runs (pinned by a test). The attempts
// panel is invalidated on any `attempt/upsert`, so the visible effect is nil; a consumer that needs the rows a reset
// removed must not rely on the payload alone.
//
// `attempt_sources` rows are bookkeeping, not an observable entity, and record no change.
import type { ATTEMPT_STATES } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';
import { requireRef, rowLimit } from './transitions.ts';

// The registry (98 2.6) lists `AttemptCandidate` with the attempts repository; `SessionsRepo.attemptCandidates` defines it.
export type { AttemptCandidate } from './sessions.ts';

export type AttemptEndReason = 'open' | 'ended' | 'superseded';
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export interface AttemptSourceRow {
  id: number;
  path: string;
  pathKey: string;
  generation: number;
  ino: string | null;
  headLen: number;
  headHash: string;
  readOffset: number;
  configSha256: string;
  updatedAt: number;
}

export type AttemptSourceInput = Omit<AttemptSourceRow, 'id' | 'updatedAt'>;

export interface AttemptRunRow {
  id: number;
  sourceId: number;
  generation: number;
  startOffset: number;
  part: string;
  nRaw: string | null;
  model: string | null;
  effort: string | null;
  startedAt: number;
  endOffset: number | null;
  endedAt: number | null;
  exitRaw: string | null;
  statusRaw: string | null;
  endReason: AttemptEndReason;
  state: AttemptState;
  evidence: string;
  /** `sessions.id`, `null` while unmatched or after the session was deleted. */
  sessionRowId: number | null;
  matchDeltaMs: number | null;
  updatedSeq: number;
  updatedAt: number;
}

export type NewAttemptRun = Pick<
  AttemptRunRow,
  'sourceId' | 'generation' | 'startOffset' | 'part' | 'nRaw' | 'model' | 'effort' | 'startedAt' | 'evidence'
>;

export interface AttemptEnd {
  endOffset: number;
  endedAt: number;
  exitRaw: string | null;
  statusRaw: string | null;
  state: 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  evidence: string;
}

/** `[02 7.13]` `AttemptRowRef`: the projection `explainCompletion` reads (every generation, I-08). */
export interface AttemptRowRef {
  id: number;
  part: string;
  startedAt: number;
  endedAt: number | null;
  endReason: AttemptEndReason;
  state: AttemptState;
  evidence: string;
  /** The provider session id (`sessions.session_uid`), `null` when unmatched or detached (N-10). */
  sessionId: string | null;
}

/** Column caps of 03 3.5 in code points. */
const CAPS = { part: 512, nRaw: 64, model: 128, effort: 64, exitRaw: 64, statusRaw: 512, evidence: 1024 } as const;

/** The first `n` code points (a plain cut, never inside a surrogate pair): the column CHECKs always hold. */
function cut(text: string, n: number): string {
  return Array.from(text).slice(0, n).join('');
}

function cutOrNull(text: string | null, n: number): string | null {
  return text === null ? null : cut(text, n);
}

/** Legacy `or None`: an empty model or effort is stored as NULL. */
function emptyToNull(text: string | null, n: number): string | null {
  const clipped = cutOrNull(text, n);
  return clipped === null || clipped === '' ? null : clipped;
}

const RUN_COLUMNS = `id, source_id AS sourceId, generation, start_offset AS startOffset, part, n_raw AS nRaw, model, effort,
  started_at AS startedAt, end_offset AS endOffset, ended_at AS endedAt, exit_raw AS exitRaw, status_raw AS statusRaw,
  end_reason AS endReason, state, evidence, session_id AS sessionRowId, match_delta_ms AS matchDeltaMs,
  updated_seq AS updatedSeq, updated_at AS updatedAt`;

const SOURCE_COLUMNS = `id, path, path_key AS pathKey, generation, ino, head_len AS headLen, head_hash AS headHash,
  read_offset AS readOffset, config_sha256 AS configSha256, updated_at AS updatedAt`;

export class AttemptsRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  getSource(ctx: RepoContext, pathKey: string): AttemptSourceRow | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<AttemptSourceRow>(`SELECT ${SOURCE_COLUMNS} FROM attempt_sources WHERE path_key = :pathKey`)
      .get({ pathKey });
  }

  /** Upsert by `path_key`; returns the id. */
  saveSource(ctx: RepoContext, tx: WriteTx, s: AttemptSourceInput): number {
    this.db.assertScope(ctx);
    const row = this.db.driver
      .prepare<{ id: number }>(
        `INSERT INTO attempt_sources (path, path_key, generation, ino, head_len, head_hash, read_offset, config_sha256, updated_at)
         VALUES (:path, :pathKey, :generation, :ino, :headLen, :headHash, :readOffset, :configSha256, :now)
         ON CONFLICT(path_key) DO UPDATE SET
           path = excluded.path, generation = excluded.generation, ino = excluded.ino, head_len = excluded.head_len,
           head_hash = excluded.head_hash, read_offset = excluded.read_offset, config_sha256 = excluded.config_sha256,
           updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get({
        path: s.path,
        pathKey: s.pathKey,
        generation: s.generation,
        ino: s.ino,
        headLen: s.headLen,
        headHash: s.headHash,
        readOffset: s.readOffset,
        configSha256: s.configSha256,
        now: tx.now,
      });
    if (row === undefined) throw new Error('INSERT ... RETURNING answered no row');
    return row.id;
  }

  /**
   * The configuration hash changed: deletes the runs of the source, sets generation 1 and offset 0, stores the new
   * hash, and returns the session row ids that had an ended, matched run (their `attempt` evidence must be cleared).
   * The change names no id and is `truncated`, except when another run is noted in the same transaction (the header
   * explains this limit, CR-WP-11-2).
   */
  resetSource(ctx: RepoContext, tx: WriteTx, sourceId: number, configSha256: string): number[] {
    this.db.assertScope(ctx);
    const { driver } = this.db;
    const sessions = driver
      .prepare<{ sessionId: number }>(
        `SELECT DISTINCT session_id AS sessionId FROM attempt_runs
         WHERE source_id = :sourceId AND end_reason = 'ended' AND session_id IS NOT NULL ORDER BY session_id`,
      )
      .all({ sourceId })
      .map((row) => row.sessionId);
    const present = driver.prepare('SELECT 1 FROM attempt_runs WHERE source_id = :sourceId LIMIT 1').get({ sourceId });
    if (present !== undefined) {
      // no id is named: the payload says `truncated`
      tx.changes.reserve('attempt', 'upsert', { entityId: null, sessionUid: null });
      driver.prepare('DELETE FROM attempt_runs WHERE source_id = :sourceId').run({ sourceId });
    }
    driver
      .prepare(
        `UPDATE attempt_sources SET generation = 1, read_offset = 0, config_sha256 = :configSha256, updated_at = :now
         WHERE id = :sourceId`,
      )
      .run({ sourceId, configSha256, now: tx.now });
    return sessions;
  }

  /** The newest open run of one part in one generation (`idx_attempt_runs_open`). */
  openRun(ctx: RepoContext, sourceId: number, generation: number, part: string): AttemptRunRow | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<AttemptRunRow>(
        `SELECT ${RUN_COLUMNS} FROM attempt_runs
         WHERE source_id = :sourceId AND generation = :generation AND part = :part AND end_reason = 'open'
         ORDER BY start_offset DESC LIMIT 1`,
      )
      .get({ sourceId, generation, part: cut(part, CAPS.part) });
  }

  /**
   * Inserts an open run; `undefined` = a run with this `(source, generation, start offset)` is already stored. A source
   * that does not exist is refused (03 3.4).
   */
  insertRun(ctx: RepoContext, tx: WriteTx, r: NewAttemptRun): number | undefined {
    this.db.assertScope(ctx);
    requireRef(this.db, 'attempt source', 'SELECT 1 FROM attempt_sources WHERE id = ?', [r.sourceId]);
    const { driver } = this.db;
    const known = driver
      .prepare(
        'SELECT 1 FROM attempt_runs WHERE source_id = :sourceId AND generation = :generation AND start_offset = :startOffset',
      )
      .get({ sourceId: r.sourceId, generation: r.generation, startOffset: r.startOffset });
    if (known !== undefined) return undefined;
    const seq = this.reserve(tx);
    const row = driver
      .prepare<{ id: number }>(
        `INSERT INTO attempt_runs (source_id, generation, start_offset, part, n_raw, model, effort, started_at, end_reason,
                                   state, evidence, updated_seq, updated_at)
         VALUES (:sourceId, :generation, :startOffset, :part, :nRaw, :model, :effort, :startedAt, 'open', 'RUNNING',
                 :evidence, :seq, :now)
         ON CONFLICT(source_id, generation, start_offset) DO NOTHING
         RETURNING id`,
      )
      .get({
        sourceId: r.sourceId,
        generation: r.generation,
        startOffset: r.startOffset,
        part: cut(r.part, CAPS.part),
        nRaw: cutOrNull(r.nRaw, CAPS.nRaw),
        model: emptyToNull(r.model, CAPS.model),
        effort: emptyToNull(r.effort, CAPS.effort),
        startedAt: r.startedAt,
        evidence: cut(r.evidence, CAPS.evidence),
        seq,
        now: tx.now,
      });
    if (row === undefined) return undefined;
    tx.changes.noteId(seq, row.id);
    return row.id;
  }

  /** Ends an open run. False when the run is not open (already ended, superseded or unknown). */
  endRun(ctx: RepoContext, tx: WriteTx, id: number, e: AttemptEnd): boolean {
    this.db.assertScope(ctx);
    if (!this.isOpen(id)) return false;
    const seq = this.reserve(tx);
    const changed =
      this.db.driver
        .prepare(
          `UPDATE attempt_runs SET end_reason = 'ended', state = :state, end_offset = :endOffset, ended_at = :endedAt,
                  exit_raw = :exitRaw, status_raw = :statusRaw, evidence = :evidence, updated_seq = :seq, updated_at = :now
           WHERE id = :id AND end_reason = 'open'`,
        )
        .run({
          id,
          state: e.state,
          endOffset: e.endOffset,
          endedAt: e.endedAt,
          exitRaw: cutOrNull(e.exitRaw, CAPS.exitRaw),
          statusRaw: cutOrNull(e.statusRaw, CAPS.statusRaw),
          evidence: cut(e.evidence, CAPS.evidence),
          seq,
          now: tx.now,
        }).changes > 0;
    if (changed) tx.changes.noteId(seq, id);
    return changed;
  }

  /** A newer START of the same part closed this run without an END (06 3.10.4). False when the run is not open. */
  supersedeRun(ctx: RepoContext, tx: WriteTx, id: number, evidence: string): boolean {
    this.db.assertScope(ctx);
    if (!this.isOpen(id)) return false;
    const seq = this.reserve(tx);
    const changed =
      this.db.driver
        .prepare(
          `UPDATE attempt_runs SET end_reason = 'superseded', state = 'UNKNOWN', evidence = :evidence, updated_seq = :seq,
                  updated_at = :now
           WHERE id = :id AND end_reason = 'open'`,
        )
        .run({ id, evidence: cut(evidence, CAPS.evidence), seq, now: tx.now }).changes > 0;
    if (changed) tx.changes.noteId(seq, id);
    return changed;
  }

  /**
   * A matched run keeps its session (06 3.10.6): false when the run is unknown or already matched. A session row that
   * does not exist is refused (03 3.4): `sessions.id` is not AUTOINCREMENT, so a dangling id could later name a stranger.
   */
  setMatch(ctx: RepoContext, tx: WriteTx, id: number, sessionRowId: number, matchDeltaMs: number): boolean {
    this.db.assertScope(ctx);
    requireRef(this.db, 'session', 'SELECT 1 FROM sessions WHERE id = ?', [sessionRowId]);
    const unmatched = this.db.driver
      .prepare('SELECT 1 FROM attempt_runs WHERE id = :id AND session_id IS NULL')
      .get({ id });
    if (unmatched === undefined) return false;
    const seq = this.reserve(tx);
    const changed =
      this.db.driver
        .prepare(
          `UPDATE attempt_runs SET session_id = :sessionRowId, match_delta_ms = :matchDeltaMs, updated_seq = :seq,
                  updated_at = :now
           WHERE id = :id AND session_id IS NULL`,
        )
        .run({ id, sessionRowId, matchDeltaMs, seq, now: tx.now }).changes > 0;
    if (changed) tx.changes.noteId(seq, id);
    return changed;
  }

  /**
   * Retention (03 3.8 step 3j): detaches the runs of deleted sessions (the rows stay: chain-log history). Writes one
   * `truncated` change when rows changed (the same limit as `resetSource` applies when other runs are noted in the
   * same transaction, CR-WP-11-2). Returns the number of runs detached.
   */
  detachSessions(ctx: RepoContext, tx: WriteTx, sessionRowIds: readonly number[]): number {
    this.db.assertScope(ctx);
    if (sessionRowIds.length === 0) return 0;
    const idsJson = JSON.stringify([...new Set(sessionRowIds)]);
    const attached = this.db.driver
      .prepare('SELECT 1 FROM attempt_runs WHERE session_id IN (SELECT value FROM json_each(:idsJson)) LIMIT 1')
      .get({ idsJson });
    if (attached === undefined) return 0;
    const seq = this.reserve(tx);
    return this.db.driver
      .prepare(
        `UPDATE attempt_runs SET session_id = NULL, match_delta_ms = NULL, updated_seq = :seq, updated_at = :now
         WHERE session_id IN (SELECT value FROM json_each(:idsJson))`,
      )
      .run({ idsJson, seq, now: tx.now }).changes;
  }

  /** Unmatched runs started at or after `startedSinceMs`, in start order (`idx_attempt_runs_start`). */
  runsToMatch(ctx: RepoContext, startedSinceMs: number, limit: number): AttemptRunRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<AttemptRunRow>(
        `SELECT ${RUN_COLUMNS} FROM attempt_runs WHERE started_at >= :since AND session_id IS NULL
         ORDER BY started_at, id LIMIT :limit`,
      )
      .all({ since: startedSinceMs, limit: rowLimit(limit) });
  }

  /** The newest `limit` runs, in start order. */
  latestRuns(ctx: RepoContext, limit: number): AttemptRunRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<AttemptRunRow>(
        `SELECT * FROM (SELECT ${RUN_COLUMNS} FROM attempt_runs ORDER BY started_at DESC, id DESC LIMIT :limit)
         ORDER BY startedAt, id`,
      )
      .all({ limit: rowLimit(limit) });
  }

  /** The newest ended run of a session: the legacy "latest START wins" rule (06 3.10.7). */
  evidenceRun(ctx: RepoContext, sessionRowId: number): AttemptRunRow | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<AttemptRunRow>(
        `SELECT ${RUN_COLUMNS} FROM attempt_runs WHERE session_id = :sessionRowId AND end_reason = 'ended'
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get({ sessionRowId });
  }

  /**
   * Every run of a part in every generation (02 7.13 `CompletionLookup.attemptRowsByPart`, I-08), with the provider id of
   * the matched session. Operator triggered (`verify-completion`), never polled: no index covers `part` (03 O-5).
   */
  runsByPart(ctx: RepoContext, part: string): AttemptRowRef[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<AttemptRowRef>(
        `SELECT r.id AS id, r.part AS part, r.started_at AS startedAt, r.ended_at AS endedAt, r.end_reason AS endReason,
                r.state AS state, r.evidence AS evidence, s.session_uid AS sessionId
         FROM attempt_runs r LEFT JOIN sessions s ON s.id = r.session_id
         WHERE r.part = :part ORDER BY r.started_at, r.id`,
      )
      .all({ part: cut(part, CAPS.part) });
  }

  private isOpen(id: number): boolean {
    return (
      this.db.driver.prepare("SELECT 1 FROM attempt_runs WHERE id = :id AND end_reason = 'open'").get({ id }) !==
      undefined
    );
  }

  private reserve(tx: WriteTx): number {
    return tx.changes.reserve('attempt', 'upsert', { entityId: null, sessionUid: null });
  }
}
