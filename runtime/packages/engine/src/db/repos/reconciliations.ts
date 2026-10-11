// `reconciliations` (03 3.5, 3.6; 02 8.1): append-only records of where the monitor may have missed data. SQL only.
// A new session level row also inserts the `monitor.gap` / `monitor.reconcile` timeline event so timelines and the
// activity feed show the gap (brief 8.4); instance level rows reach the UI as alerts and through `GET /health/ingest`.
import { z } from 'zod';

import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';
import { rowLimit } from './transitions.ts';

export type ReconciliationKind =
  'activity_after_end' | 'hook_gap' | 'runtime_unavailable' | 'identity_reset' | 'copied_records' | 'handler_failing';

export type ReconciliationDetail = Record<string, string | number | boolean | null>;

const DetailSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export interface NewReconciliation {
  /** `null` = instance level. */
  sessionId: number | null;
  /** The session uid, or `instance`. */
  scopeKey: string;
  kind: ReconciliationKind;
  at: number;
  detail: ReconciliationDetail;
  /** 32 hex characters computed by the caller; with `scopeKey` and `kind` it makes a record unique. */
  detailHash: string;
}

export interface ReconciliationRow {
  id: number;
  sessionId: number | null;
  scopeKey: string;
  kind: ReconciliationKind;
  at: number;
  detail: ReconciliationDetail;
}

interface ReconciliationDbRow extends Omit<ReconciliationRow, 'detail'> {
  detail: string;
}

const COLUMNS = 'id, session_id AS sessionId, scope_key AS scopeKey, kind, at, detail';

function toRow(row: ReconciliationDbRow): ReconciliationRow {
  let detail: ReconciliationDetail = {};
  try {
    const parsed = DetailSchema.safeParse(JSON.parse(row.detail));
    if (parsed.success) detail = parsed.data;
  } catch {
    // a damaged detail column reads as empty; the row itself stays usable
  }
  return { ...row, detail };
}

/** `runtime_unavailable` and `hook_gap` are gaps of the record; every other kind is a reconciliation note. */
function eventKindOf(kind: ReconciliationKind): 'monitor.gap' | 'monitor.reconcile' {
  return kind === 'runtime_unavailable' || kind === 'hook_gap' ? 'monitor.gap' : 'monitor.reconcile';
}

export class ReconciliationsRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /**
   * Inserts the record unless one with the same `(scope_key, kind, detail_hash)` exists (`undefined` = duplicate, nothing
   * written). For a new session level record it also inserts the timeline event (`sources 4`, `severity 1`,
   * `natural_key 'recon:<id>'`), reserves the session's `event/append` change for it and counts it in
   * `sessions.event_count`. `eventId` is `null` for an instance level record. A session level `scopeKey` that is not the
   * uid of its session is a `RangeError` and writes nothing.
   */
  insert(ctx: RepoContext, tx: WriteTx, r: NewReconciliation): { id: number; eventId: number | null } | undefined {
    this.db.assertScope(ctx);
    const { driver } = this.db;
    if (r.sessionId !== null) {
      // the scope key becomes `changes.session_uid` and the unique key: it must be the uid of the session
      const owner = driver
        .prepare<{ sessionUid: string }>('SELECT session_uid AS sessionUid FROM sessions WHERE id = :sessionId')
        .get({ sessionId: r.sessionId });
      if (owner !== undefined && owner.sessionUid !== r.scopeKey) {
        throw new RangeError('the scope key of a session level reconciliation is the uid of its session');
      }
    }
    const detail = JSON.stringify(r.detail);
    const inserted = driver
      .prepare<{ id: number }>(
        `INSERT INTO reconciliations (session_id, scope_key, kind, at, detail, detail_hash)
         VALUES (:sessionId, :scopeKey, :kind, :at, :detail, :detailHash)
         ON CONFLICT(scope_key, kind, detail_hash) DO NOTHING
         RETURNING id`,
      )
      .get({
        sessionId: r.sessionId,
        scopeKey: r.scopeKey,
        kind: r.kind,
        at: r.at,
        detail,
        detailHash: r.detailHash,
      });
    if (inserted === undefined) return undefined;
    if (r.sessionId === null) return { id: inserted.id, eventId: null };
    const seq = tx.changes.reserve('event', 'append', { entityId: r.sessionId, sessionUid: r.scopeKey });
    const event = driver
      .prepare<{ id: number }>(
        `INSERT INTO events (session_id, kind, severity, sources, ts, ts_source, received_at, natural_key, summary, detail, change_seq)
         VALUES (:sessionId, :eventKind, 1, 4, :at, 'derived', :now, :naturalKey, :summary, :detail, :seq)
         RETURNING id`,
      )
      .get({
        sessionId: r.sessionId,
        eventKind: eventKindOf(r.kind),
        at: r.at,
        now: tx.now,
        naturalKey: `recon:${String(inserted.id)}`,
        summary: r.kind,
        detail,
        seq,
      });
    if (event === undefined) throw new Error('INSERT ... RETURNING answered no row');
    tx.changes.noteId(seq, event.id);
    driver
      .prepare('UPDATE sessions SET event_count = event_count + 1 WHERE id = :sessionId')
      .run({ sessionId: r.sessionId });
    return { id: inserted.id, eventId: event.id };
  }

  /** Newest first (`idx_reconciliations_session`). */
  listBySession(ctx: RepoContext, sessionId: number, limit: number): ReconciliationRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<ReconciliationDbRow>(
        `SELECT ${COLUMNS} FROM reconciliations WHERE session_id = :sessionId ORDER BY at DESC, id DESC LIMIT :limit`,
      )
      .all({ sessionId, limit: rowLimit(limit) })
      .map(toRow);
  }

  /** Records of one kind strictly newer than `at`, newest first (`idx_reconciliations_kind_at`). */
  newerThan(ctx: RepoContext, kind: ReconciliationKind, at: number, limit: number): ReconciliationRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<ReconciliationDbRow>(
        `SELECT ${COLUMNS} FROM reconciliations WHERE kind = :kind AND at > :at ORDER BY at DESC, id DESC LIMIT :limit`,
      )
      .all({ kind, at, limit: rowLimit(limit) })
      .map(toRow);
  }

  /** Automatic retention (03 3.8): at most `limit` instance level rows older than the cutoff. Returns the count. */
  deleteInstanceLevelBefore(ctx: RepoContext, _tx: WriteTx, cutoffAt: number, limit: number): number {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare(
        `DELETE FROM reconciliations WHERE id IN (
           SELECT id FROM reconciliations WHERE session_id IS NULL AND at < :cutoffAt ORDER BY at, id LIMIT :limit)`,
      )
      .run({ cutoffAt, limit: rowLimit(limit) }).changes;
  }
}
