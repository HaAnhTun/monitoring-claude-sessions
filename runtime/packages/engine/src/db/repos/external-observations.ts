// `external_observations` (03 3.5; 02 7.10): the latest observation per session and source (`registry`, `job`, `pid`,
// `attempt`), last write wins by `observed_at`. SQL only.
import { z } from 'zod';

import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

export type ObservationSource = 'registry' | 'job' | 'pid' | 'attempt';

/** Numbers, short enum-like strings and booleans only (02 7.10); the column holds at most 2048 characters. */
export type ObservationValue = Readonly<Record<string, string | number | boolean | null>>;

const ValueSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export interface NewObservation {
  sessionId: number;
  source: ObservationSource;
  observedAt: number;
  value: ObservationValue;
}

export interface ObservationRow {
  sessionId: number;
  source: ObservationSource;
  observedAt: number;
  value: ObservationValue;
}

interface ObservationDbRow {
  sessionId: number;
  source: ObservationSource;
  observedAt: number;
  valueJson: string;
}

const COLUMNS = 'session_id AS sessionId, source, observed_at AS observedAt, value_json AS valueJson';

function toRow(row: ObservationDbRow): ObservationRow {
  let value: ObservationValue = {};
  try {
    const parsed = ValueSchema.safeParse(JSON.parse(row.valueJson));
    if (parsed.success) value = parsed.data;
  } catch {
    // a damaged value column reads as empty
  }
  return { sessionId: row.sessionId, source: row.source, observedAt: row.observedAt, value };
}

export class ExternalObservationsRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /**
   * Stores the observation when it is newer than the stored one. A time tie is broken by the larger serialized value,
   * so the stored value does not depend on the arrival order, and the same observation twice changes nothing.
   * Returns true when the row was written.
   */
  upsert(ctx: RepoContext, _tx: WriteTx, o: NewObservation): boolean {
    this.db.assertScope(ctx);
    return (
      this.db.driver
        .prepare(
          `INSERT INTO external_observations (session_id, source, observed_at, value_json)
           VALUES (:sessionId, :source, :observedAt, :valueJson)
           ON CONFLICT(session_id, source) DO UPDATE SET
             observed_at = excluded.observed_at, value_json = excluded.value_json
           WHERE excluded.observed_at > external_observations.observed_at
              OR (excluded.observed_at = external_observations.observed_at
                  AND excluded.value_json > external_observations.value_json)`,
        )
        .run({
          sessionId: o.sessionId,
          source: o.source,
          observedAt: o.observedAt,
          valueJson: JSON.stringify(o.value),
        }).changes > 0
    );
  }

  /** `external.attempt_cleared` removes the attempt observation. True when a row existed. */
  delete(ctx: RepoContext, _tx: WriteTx, sessionId: number, source: ObservationSource): boolean {
    this.db.assertScope(ctx);
    return (
      this.db.driver
        .prepare('DELETE FROM external_observations WHERE session_id = :sessionId AND source = :source')
        .run({ sessionId, source }).changes > 0
    );
  }

  get(ctx: RepoContext, sessionId: number, source: ObservationSource): ObservationRow | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver
      .prepare<ObservationDbRow>(
        `SELECT ${COLUMNS} FROM external_observations WHERE session_id = :sessionId AND source = :source`,
      )
      .get({ sessionId, source });
    return row === undefined ? undefined : toRow(row);
  }

  listBySession(ctx: RepoContext, sessionId: number): ObservationRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<ObservationDbRow>(
        `SELECT ${COLUMNS} FROM external_observations WHERE session_id = :sessionId ORDER BY source`,
      )
      .all({ sessionId })
      .map(toRow);
  }
}
