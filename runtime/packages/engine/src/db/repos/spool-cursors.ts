// `spool_cursors` (03 3.5; 02 2.7): where the spool drainer stopped in each segment. SQL only. The cursor of a batch is
// committed in the same transaction as the rows derived from its lines (02 4.6).
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

export interface NewSpoolCursor {
  /** `hooks-<YYYYMMDD>T<HH>Z.ndjson` (the column checks the extension and refuses path characters). */
  segment: string;
  offsetBytes: number;
  sizeSeen: number;
  ino: string | null;
  headHash: string | null;
  lines: number;
  partialBytes: number;
  sealed: boolean;
  errors: number;
  oldestReceivedAt: number | null;
  newestReceivedAt: number | null;
  drainedAt: number | null;
}

export interface SpoolCursorRow extends NewSpoolCursor {
  firstSeenAt: number;
  updatedAt: number;
}

interface SpoolCursorDbRow extends Omit<SpoolCursorRow, 'sealed'> {
  sealed: number;
}

const COLUMNS = `segment, offset_bytes AS offsetBytes, size_seen AS sizeSeen, ino, head_hash AS headHash, lines,
  partial_bytes AS partialBytes, sealed, errors, oldest_received_at AS oldestReceivedAt,
  newest_received_at AS newestReceivedAt, first_seen_at AS firstSeenAt, drained_at AS drainedAt, updated_at AS updatedAt`;

function toRow(row: SpoolCursorDbRow): SpoolCursorRow {
  return { ...row, sealed: row.sealed === 1 };
}

export class SpoolCursorsRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /** Inserts the cursor or replaces its position and counters; the first-seen time stays. */
  save(ctx: RepoContext, tx: WriteTx, c: NewSpoolCursor): void {
    this.db.assertScope(ctx);
    this.db.driver
      .prepare(
        `INSERT INTO spool_cursors (segment, offset_bytes, size_seen, ino, head_hash, lines, partial_bytes, sealed, errors,
                                    oldest_received_at, newest_received_at, first_seen_at, drained_at, updated_at)
         VALUES (:segment, :offsetBytes, :sizeSeen, :ino, :headHash, :lines, :partialBytes, :sealed, :errors,
                 :oldestReceivedAt, :newestReceivedAt, :now, :drainedAt, :now)
         ON CONFLICT(segment) DO UPDATE SET
           offset_bytes = excluded.offset_bytes, size_seen = excluded.size_seen, ino = excluded.ino,
           head_hash = excluded.head_hash, lines = excluded.lines, partial_bytes = excluded.partial_bytes,
           sealed = excluded.sealed, errors = excluded.errors, oldest_received_at = excluded.oldest_received_at,
           newest_received_at = excluded.newest_received_at, drained_at = excluded.drained_at,
           updated_at = excluded.updated_at`,
      )
      .run({
        segment: c.segment,
        offsetBytes: c.offsetBytes,
        sizeSeen: c.sizeSeen,
        ino: c.ino,
        headHash: c.headHash,
        lines: c.lines,
        partialBytes: c.partialBytes,
        sealed: c.sealed ? 1 : 0,
        errors: c.errors,
        oldestReceivedAt: c.oldestReceivedAt,
        newestReceivedAt: c.newestReceivedAt,
        drainedAt: c.drainedAt,
        now: tx.now,
      });
  }

  get(ctx: RepoContext, segment: string): SpoolCursorRow | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver
      .prepare<SpoolCursorDbRow>(`SELECT ${COLUMNS} FROM spool_cursors WHERE segment = :segment`)
      .get({ segment });
    return row === undefined ? undefined : toRow(row);
  }

  /** Every cursor, by segment name (the names sort by hour). */
  list(ctx: RepoContext): SpoolCursorRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<SpoolCursorDbRow>(`SELECT ${COLUMNS} FROM spool_cursors ORDER BY segment`)
      .all()
      .map(toRow);
  }

  /** The segments a server start must drain (02 2.7: every segment whose cursor is not sealed). */
  listUnsealed(ctx: RepoContext): SpoolCursorRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<SpoolCursorDbRow>(`SELECT ${COLUMNS} FROM spool_cursors WHERE sealed = 0 ORDER BY segment`)
      .all()
      .map(toRow);
  }

  /**
   * Replay (02 2.7): `offset_bytes = 0, partial_bytes = 0, sealed = 0, lines = 0` for each segment; a segment without a
   * cursor gets a fresh row. Returns the number of segments handled.
   */
  resetMany(ctx: RepoContext, tx: WriteTx, segments: readonly string[]): number {
    this.db.assertScope(ctx);
    const statement = this.db.driver.prepare(
      `INSERT INTO spool_cursors (segment, first_seen_at, updated_at) VALUES (:segment, :now, :now)
       ON CONFLICT(segment) DO UPDATE SET
         offset_bytes = 0, partial_bytes = 0, sealed = 0, lines = 0, drained_at = NULL, updated_at = excluded.updated_at`,
    );
    for (const segment of segments) statement.run({ segment, now: tx.now });
    return segments.length;
  }

  /** True when the cursor existed. */
  delete(ctx: RepoContext, _tx: WriteTx, segment: string): boolean {
    this.db.assertScope(ctx);
    return this.db.driver.prepare('DELETE FROM spool_cursors WHERE segment = :segment').run({ segment }).changes > 0;
  }
}
