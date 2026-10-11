// `cost_states` (03 3.5; 02 6.6): the provider-reported cumulative cost per transcript file. Supplementary: never summed
// into token totals. Last write wins by byte offset. SQL only.
import { z } from 'zod';

import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';
import { requireTranscriptFile } from './transitions.ts';

/** Per model, a record of numeric usage fields (02 4.3 `cost_state`): numbers only, never content. */
export type ModelUsage = Readonly<Record<string, Readonly<Record<string, number>>>>;

const ModelUsageSchema = z.record(z.string(), z.record(z.string(), z.number()));

export interface NewCostState {
  fileId: number;
  sessionId: number;
  totalCostUsd: number | null;
  modelUsage: ModelUsage;
  byteOffset: number;
  isTrailing: boolean;
  observedAt: number;
}

export type CostStateRow = NewCostState;

interface CostStateDbRow {
  fileId: number;
  sessionId: number;
  totalCostUsd: number | null;
  modelUsageJson: string;
  byteOffset: number;
  isTrailing: number;
  observedAt: number;
}

const COLUMNS = `file_id AS fileId, session_id AS sessionId, total_cost_usd AS totalCostUsd,
  model_usage_json AS modelUsageJson, byte_offset AS byteOffset, is_trailing AS isTrailing, observed_at AS observedAt`;

function toRow(row: CostStateDbRow): CostStateRow {
  let modelUsage: ModelUsage = {};
  try {
    const parsed = ModelUsageSchema.safeParse(JSON.parse(row.modelUsageJson));
    if (parsed.success) modelUsage = parsed.data;
  } catch {
    // a damaged column reads as empty
  }
  return {
    fileId: row.fileId,
    sessionId: row.sessionId,
    totalCostUsd: row.totalCostUsd,
    modelUsage,
    byteOffset: row.byteOffset,
    isTrailing: row.isTrailing === 1,
    observedAt: row.observedAt,
  };
}

export class CostStatesRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /**
   * Keeps the state at the greater byte offset (an equal offset rewrites the same record). True when written. A
   * transcript file that does not exist is refused (03 3.4).
   */
  upsert(ctx: RepoContext, _tx: WriteTx, s: NewCostState): boolean {
    this.db.assertScope(ctx);
    requireTranscriptFile(this.db, s.fileId);
    return (
      this.db.driver
        .prepare(
          `INSERT INTO cost_states (file_id, session_id, total_cost_usd, model_usage_json, byte_offset, is_trailing, observed_at)
           VALUES (:fileId, :sessionId, :totalCostUsd, :modelUsageJson, :byteOffset, :isTrailing, :observedAt)
           ON CONFLICT(file_id) DO UPDATE SET
             session_id = excluded.session_id, total_cost_usd = excluded.total_cost_usd,
             model_usage_json = excluded.model_usage_json, byte_offset = excluded.byte_offset,
             is_trailing = excluded.is_trailing, observed_at = excluded.observed_at
           WHERE excluded.byte_offset >= cost_states.byte_offset`,
        )
        .run({
          fileId: s.fileId,
          sessionId: s.sessionId,
          totalCostUsd: s.totalCostUsd,
          modelUsageJson: JSON.stringify(s.modelUsage),
          byteOffset: s.byteOffset,
          isTrailing: s.isTrailing ? 1 : 0,
          observedAt: s.observedAt,
        }).changes > 0
    );
  }

  byFile(ctx: RepoContext, fileId: number): CostStateRow | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver
      .prepare<CostStateDbRow>(`SELECT ${COLUMNS} FROM cost_states WHERE file_id = :fileId`)
      .get({ fileId });
    return row === undefined ? undefined : toRow(row);
  }

  listBySession(ctx: RepoContext, sessionId: number): CostStateRow[] {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<CostStateDbRow>(`SELECT ${COLUMNS} FROM cost_states WHERE session_id = :sessionId ORDER BY file_id`)
      .all({ sessionId })
      .map(toRow);
  }

  /**
   * The latest trailing cost the provider reported for a session (the value `sessions.reported_cost_usd` mirrors):
   * the newest observation of a trailing state that has a total.
   */
  latestTrailing(ctx: RepoContext, sessionId: number): { totalCostUsd: number; observedAt: number } | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<{ totalCostUsd: number; observedAt: number }>(
        `SELECT total_cost_usd AS totalCostUsd, observed_at AS observedAt FROM cost_states
         WHERE session_id = :sessionId AND is_trailing = 1 AND total_cost_usd IS NOT NULL
         ORDER BY observed_at DESC, byte_offset DESC LIMIT 1`,
      )
      .get({ sessionId });
  }

  /** On a file identity reset (02 5.3). True when a row existed. */
  deleteByFile(ctx: RepoContext, _tx: WriteTx, fileId: number): boolean {
    this.db.assertScope(ctx);
    return this.db.driver.prepare('DELETE FROM cost_states WHERE file_id = :fileId').run({ fileId }).changes > 0;
  }
}
