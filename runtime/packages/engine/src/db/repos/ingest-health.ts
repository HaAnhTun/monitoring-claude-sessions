// `ingest_health` (03 3.5; 02 8.2): one row, the last computed ingestion report plus durable counters. SQL only. The
// `health/upsert` change on a status change is reserved by the caller (the sink), which gets `previousStatus` here.
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

export type IngestStatus = 'ok' | 'degraded' | 'down';

export interface NewIngestHealth {
  evaluatedAt: number;
  status: IngestStatus;
  lastEnvelopeAt: number | null;
  lastCommitAt: number | null;
  lastDrainAt: number | null;
  lastNudgeAt: number | null;
  lastScanAt: number | null;
  lastSyncAt: number | null;
  /** JSON text, at most 16 KiB; its shape belongs to 02 8.2. */
  countersJson: string;
  /** JSON text, at most 64 KiB: the last `IngestHealth` report. */
  reportJson: string;
}

export interface IngestHealthRow extends NewIngestHealth {
  updatedAt: number;
}

export class IngestHealthRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  get(ctx: RepoContext): IngestHealthRow | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<IngestHealthRow>(
        `SELECT evaluated_at AS evaluatedAt, status, last_envelope_at AS lastEnvelopeAt, last_commit_at AS lastCommitAt,
                last_drain_at AS lastDrainAt, last_nudge_at AS lastNudgeAt, last_scan_at AS lastScanAt,
                last_sync_at AS lastSyncAt, counters_json AS countersJson, report_json AS reportJson,
                updated_at AS updatedAt
         FROM ingest_health WHERE id = 1`,
      )
      .get();
  }

  /** Writes the single row. `previousStatus` is the stored status before this call (`null` for the first save). */
  save(ctx: RepoContext, tx: WriteTx, h: NewIngestHealth): { previousStatus: IngestStatus | null } {
    this.db.assertScope(ctx);
    const previous = this.db.driver
      .prepare<{ status: IngestStatus }>('SELECT status FROM ingest_health WHERE id = 1')
      .get();
    this.db.driver
      .prepare(
        `INSERT INTO ingest_health (id, evaluated_at, status, last_envelope_at, last_commit_at, last_drain_at, last_nudge_at,
                                    last_scan_at, last_sync_at, counters_json, report_json, updated_at)
         VALUES (1, :evaluatedAt, :status, :lastEnvelopeAt, :lastCommitAt, :lastDrainAt, :lastNudgeAt, :lastScanAt,
                 :lastSyncAt, :countersJson, :reportJson, :now)
         ON CONFLICT(id) DO UPDATE SET
           evaluated_at = excluded.evaluated_at, status = excluded.status, last_envelope_at = excluded.last_envelope_at,
           last_commit_at = excluded.last_commit_at, last_drain_at = excluded.last_drain_at,
           last_nudge_at = excluded.last_nudge_at, last_scan_at = excluded.last_scan_at,
           last_sync_at = excluded.last_sync_at, counters_json = excluded.counters_json,
           report_json = excluded.report_json, updated_at = excluded.updated_at`,
      )
      .run({
        evaluatedAt: h.evaluatedAt,
        status: h.status,
        lastEnvelopeAt: h.lastEnvelopeAt,
        lastCommitAt: h.lastCommitAt,
        lastDrainAt: h.lastDrainAt,
        lastNudgeAt: h.lastNudgeAt,
        lastScanAt: h.lastScanAt,
        lastSyncAt: h.lastSyncAt,
        countersJson: h.countersJson,
        reportJson: h.reportJson,
        now: tx.now,
      });
    return { previousStatus: previous?.status ?? null };
  }
}
