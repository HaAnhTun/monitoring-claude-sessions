// `ingest_errors` (03 3.5; 02 4.8): one row per ingest error occurrence, references and numbers only (never a body, a
// query or a token). SQL only; retention keeps the newest rows (`trimToNewest`).
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';
import { cutOrNull, rowLimit } from './shared.ts';

export type IngestErrorSource = 'spool' | 'transcript' | 'external' | 'writer' | 'handler' | 'alerts' | 'db';

export interface NewIngestError {
  at: number;
  source: IngestErrorSource;
  /** Upper case (the column checks it), at most 64 characters. */
  code: string;
  fileId?: number | null;
  segment?: string | null;
  byteOffset?: number | null;
  sessionUid?: string | null;
  /** Clipped to the column cap of 200 code points. */
  detail?: string | null;
}

export interface IngestErrorRow {
  id: number;
  at: number;
  source: IngestErrorSource;
  code: string;
  fileId: number | null;
  segment: string | null;
  byteOffset: number | null;
  sessionUid: string | null;
  detail: string | null;
}

const COLUMNS = `id, at, source, code, file_id AS fileId, segment, byte_offset AS byteOffset, session_uid AS sessionUid, detail`;

/** Column caps of 03 3.5, in code points (SQLite `length()` counts characters). */
const DETAIL_CAP = 200;
const SEGMENT_CAP = 128;

export class IngestErrorsRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /** Appends one occurrence and returns its id. */
  insert(ctx: RepoContext, _tx: WriteTx, e: NewIngestError): number {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare(
        `INSERT INTO ingest_errors (at, source, code, file_id, segment, byte_offset, session_uid, detail)
         VALUES (:at, :source, :code, :fileId, :segment, :byteOffset, :sessionUid, :detail)`,
      )
      .run({
        at: e.at,
        source: e.source,
        code: e.code,
        fileId: e.fileId ?? null,
        segment: cutOrNull(e.segment, SEGMENT_CAP),
        byteOffset: e.byteOffset ?? null,
        sessionUid: e.sessionUid ?? null,
        detail: cutOrNull(e.detail, DETAIL_CAP),
      }).lastInsertRowid;
  }

  /** Newest first; `beforeId` continues after the last id of the previous page (keyset, `idx_ingest_errors_at`). */
  recent(ctx: RepoContext, limit: number, beforeId: number | null): IngestErrorRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<IngestErrorRow>(
        `SELECT ${COLUMNS} FROM ingest_errors
         WHERE (:beforeId IS NULL OR id < :beforeId) ORDER BY id DESC LIMIT :limit`,
      )
      .all({ beforeId, limit: rowLimit(limit) });
  }

  /** Occurrences of one code at or after `sinceAt` (alert input, `idx_ingest_errors_code`). */
  countByCodeSince(ctx: RepoContext, code: string, sinceAt: number): number {
    this.db.assertScope(ctx);
    return (
      this.db.driver
        .prepare<{ n: number }>('SELECT count(*) AS n FROM ingest_errors WHERE code = :code AND at >= :sinceAt')
        .get({ code, sinceAt })?.n ?? 0
    );
  }

  /** Occurrences per code at or after `sinceAt`, most frequent first (ties by code). */
  codeCountsSince(ctx: RepoContext, sinceAt: number): { code: string; count: number }[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<{ code: string; count: number }>(
        `SELECT code, count(*) AS count FROM ingest_errors WHERE at >= :sinceAt GROUP BY code ORDER BY count DESC, code`,
      )
      .all({ sinceAt });
  }

  /**
   * Automatic retention (03 3.8): deletes everything but the newest `maxRows` rows, or, with `limit`, at most that many of
   * the oldest ones beyond them (the retention job deletes in batches). Returns the count.
   */
  trimToNewest(ctx: RepoContext, _tx: WriteTx, maxRows: number, limit?: number): number {
    this.db.assertScope(ctx);
    const batch = limit === undefined ? -1 : rowLimit(limit);
    return this.db.driver
      .prepare(
        `DELETE FROM ingest_errors WHERE id IN (
           SELECT id FROM (SELECT id FROM ingest_errors ORDER BY at DESC, id DESC LIMIT -1 OFFSET :maxRows)
            ORDER BY id LIMIT :batch)`,
      )
      .run({ maxRows: rowLimit(maxRows), batch }).changes;
  }
}
