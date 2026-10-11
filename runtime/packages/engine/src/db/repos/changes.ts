// `changes` (03 9.1): the read side of the change log and its retention. SQL only. Rows are written by the
// `ChangeRecorder` of `db/changes.ts` inside the transaction of the entity they describe, never through this class.
import type { ChangeKind, ChangeOp } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';
import { rowLimit } from './transitions.ts';

export interface ChangeRow {
  seq: number;
  at: number;
  kind: ChangeKind;
  op: ChangeOp;
  sessionUid: string | null;
  entityId: number | null;
  /** JSON text, at most 2048 bytes (03 9.1); the stream hub parses it with its own schema. */
  payload: string;
}

export class ChangesRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /** The head of the log, valid after pruning (`sqlite_sequence`). */
  headSeq(ctx: RepoContext): number {
    this.db.assertScope(ctx);
    return this.db.headSeq();
  }

  /** The oldest retained seq, `undefined` for an empty log. */
  oldestSeq(ctx: RepoContext): number | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver.prepare<{ seq: number | null }>('SELECT min(seq) AS seq FROM changes').get();
    return row?.seq ?? undefined;
  }

  /** The rows with `seq > afterSeq`, in order, at most `limit`. */
  since(ctx: RepoContext, afterSeq: number, limit: number): ChangeRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<ChangeRow>(
        `SELECT seq, at, kind, op, session_uid AS sessionUid, entity_id AS entityId, payload
         FROM changes WHERE seq > :afterSeq ORDER BY seq LIMIT :limit`,
      )
      .all({ afterSeq, limit: rowLimit(limit) });
  }

  /** Automatic retention (03 3.8 `changesMaxAgeHours`): at most `limit` rows older than the cutoff. Returns the count. */
  deleteOlderThan(ctx: RepoContext, _tx: WriteTx, cutoffAt: number, limit: number): number {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare(
        'DELETE FROM changes WHERE seq IN (SELECT seq FROM changes WHERE at < :cutoffAt ORDER BY seq LIMIT :limit)',
      )
      .run({ cutoffAt, limit: rowLimit(limit) }).changes;
  }

  /**
   * Automatic retention (03 3.8 `changesMaxRows`): at most `limit` rows beyond the newest `maxRows`. Returns the count.
   * `maxRows` is a non-negative integer: a negative value would delete the whole log, the resume source of the stream.
   */
  deleteBeyondMaxRows(ctx: RepoContext, _tx: WriteTx, maxRows: number, limit: number): number {
    this.db.assertScope(ctx);
    rowLimit(maxRows);
    return this.db.driver
      .prepare(
        `DELETE FROM changes WHERE seq IN (
           SELECT seq FROM changes WHERE seq <= (SELECT max(seq) FROM changes) - :maxRows ORDER BY seq LIMIT :limit)`,
      )
      .run({ maxRows, limit: rowLimit(limit) }).changes;
  }
}
