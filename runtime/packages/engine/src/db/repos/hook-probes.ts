// `hook_probes` (03 3.5; 02 3.7): the record of a probe envelope. A probe never becomes a session or an event. SQL only.
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';
import { rowLimit } from './transitions.ts';

export interface HookProbeRow {
  probeSessionId: string;
  receivedAt: number;
  committedAt: number;
}

export class HookProbesRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /** Insert or ignore. True when the probe was new. */
  insert(ctx: RepoContext, _tx: WriteTx, p: HookProbeRow): boolean {
    this.db.assertScope(ctx);
    return (
      this.db.driver
        .prepare(
          `INSERT INTO hook_probes (probe_session_id, received_at, committed_at)
           VALUES (:probeSessionId, :receivedAt, :committedAt) ON CONFLICT(probe_session_id) DO NOTHING`,
        )
        .run({ probeSessionId: p.probeSessionId, receivedAt: p.receivedAt, committedAt: p.committedAt }).changes > 0
    );
  }

  /** The primary key lookup of the `ingestProbe` route (03 6.3). */
  get(ctx: RepoContext, probeSessionId: string): HookProbeRow | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<HookProbeRow>(
        `SELECT probe_session_id AS probeSessionId, received_at AS receivedAt, committed_at AS committedAt
         FROM hook_probes WHERE probe_session_id = :probeSessionId`,
      )
      .get({ probeSessionId });
  }

  /** Automatic retention (03 3.8): at most `limit` probes committed before the cutoff. Returns the count. */
  deleteCommittedBefore(ctx: RepoContext, _tx: WriteTx, cutoffAt: number, limit: number): number {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare(
        `DELETE FROM hook_probes WHERE probe_session_id IN (
           SELECT probe_session_id FROM hook_probes WHERE committed_at < :cutoffAt ORDER BY committed_at LIMIT :limit)`,
      )
      .run({ cutoffAt, limit: rowLimit(limit) }).changes;
  }
}
