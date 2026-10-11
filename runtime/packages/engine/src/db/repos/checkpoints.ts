// CheckpointsRepo: the sparse entry index of a transcript file (03 7.2, table `transcript_checkpoints`). SQL only: when to
// write a checkpoint (about every `CHECKPOINT_EVERY_ENTRIES` display entries, always at a line start) and how to read a
// window from one is the job of the transcript service (WP-33). Checkpoints are monotonic in both `entry_index` and
// `byte_offset`, so a seek by either column is a range scan of the primary key `(file_id, entry_index)`.
//
// Every public method takes the `RepoContext` first and asserts the scope before it touches a statement (03 4.5). A
// write takes the `WriteTx` of `withWriteTx`: that is the type-level proof that the caller is inside the one write
// transaction (03 4.5); the checkpoint table has no change kind, so the transaction itself is not used.
import { DbError } from '../errors.ts';
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

export interface Checkpoint {
  readonly fileId: number;
  /** Absolute index of the first display entry of the block that starts at `byteOffset`. */
  readonly entryIndex: number;
  readonly byteOffset: number;
  /** Earliest and latest record time (epoch ms) of the block; null when the block has no timestamps. */
  readonly minTs: number | null;
  readonly maxTs: number | null;
}

export type CheckpointInput = Omit<Checkpoint, 'fileId'>;

interface CheckpointDbRow {
  file_id: number;
  entry_index: number;
  byte_offset: number;
  min_ts: number | null;
  max_ts: number | null;
}

const COLUMNS = 'file_id, entry_index, byte_offset, min_ts, max_ts';

const UPSERT = `INSERT INTO transcript_checkpoints (file_id, entry_index, byte_offset, min_ts, max_ts)
  VALUES (:fileId, :entryIndex, :byteOffset, :minTs, :maxTs)
  ON CONFLICT(file_id, entry_index) DO UPDATE SET
    byte_offset = excluded.byte_offset, min_ts = excluded.min_ts, max_ts = excluded.max_ts`;

const SEEK_BY_ENTRY = `SELECT ${COLUMNS} FROM transcript_checkpoints
  WHERE file_id = ? AND entry_index <= ? ORDER BY entry_index DESC LIMIT 1`;

// byte_offset grows with entry_index, so the newest checkpoint that starts at or before the offset is also the last one
// by entry index; the scan walks back from the end of the file's key range and stops at the first row that matches
const SEEK_BY_OFFSET = `SELECT ${COLUMNS} FROM transcript_checkpoints
  WHERE file_id = ? AND byte_offset <= ? ORDER BY entry_index DESC LIMIT 1`;

const FIRST_REACHING_TS = `SELECT ${COLUMNS} FROM transcript_checkpoints
  WHERE file_id = ? AND max_ts >= ? ORDER BY entry_index LIMIT 1`;

const LIST_AFTER = `SELECT ${COLUMNS} FROM transcript_checkpoints
  WHERE file_id = ? AND entry_index > ? ORDER BY entry_index LIMIT ?`;

const LAST = `SELECT ${COLUMNS} FROM transcript_checkpoints WHERE file_id = ? ORDER BY entry_index DESC LIMIT 1`;

function toCheckpoint(row: CheckpointDbRow): Checkpoint {
  return {
    fileId: row.file_id,
    entryIndex: row.entry_index,
    byteOffset: row.byte_offset,
    minTs: row.min_ts,
    maxTs: row.max_ts,
  };
}

export class CheckpointsRepo {
  readonly #db: InstanceDb;

  constructor(db: InstanceDb) {
    this.#db = db;
  }

  /**
   * Writes the checkpoints of one file (a checkpoint that exists is replaced, so extending an index twice is harmless)
   * and returns how many rows were written. The file must exist (soft reference, validated here).
   */
  upsertMany(ctx: RepoContext, _tx: WriteTx, fileId: number, rows: readonly CheckpointInput[]): number {
    this.#db.assertScope(ctx);
    if (rows.length === 0) return 0;
    this.#requireFile(fileId);
    const statement = this.#db.driver.prepare(UPSERT);
    for (const row of rows) {
      statement.run({
        fileId,
        entryIndex: row.entryIndex,
        byteOffset: row.byteOffset,
        minTs: row.minTs,
        maxTs: row.maxTs,
      });
    }
    return rows.length;
  }

  /** Removes every checkpoint of the file (an index reset, or a file that was deleted). Returns how many. */
  deleteForFile(ctx: RepoContext, _tx: WriteTx, fileId: number): number {
    this.#db.assertScope(ctx);
    return this.#db.driver.prepare('DELETE FROM transcript_checkpoints WHERE file_id = ?').run([fileId]).changes;
  }

  /** The last checkpoint at or before the entry index: where to start reading to reach that entry. */
  seekByEntry(ctx: RepoContext, fileId: number, entryIndex: number): Checkpoint | undefined {
    this.#db.assertScope(ctx);
    return this.#one(SEEK_BY_ENTRY, [fileId, entryIndex]);
  }

  /** The last checkpoint that starts at or before the byte offset. */
  seekByOffset(ctx: RepoContext, fileId: number, byteOffset: number): Checkpoint | undefined {
    this.#db.assertScope(ctx);
    return this.#one(SEEK_BY_OFFSET, [fileId, byteOffset]);
  }

  /** The first block (lowest entry index) whose latest record time is at or after `tsMs`; blocks without times are skipped. */
  firstReachingTs(ctx: RepoContext, fileId: number, tsMs: number): Checkpoint | undefined {
    this.#db.assertScope(ctx);
    return this.#one(FIRST_REACHING_TS, [fileId, tsMs]);
  }

  /** Keyset page: the checkpoints after `afterEntryIndex` (pass -1 for the first page) in entry order, at most `limit`. */
  list(ctx: RepoContext, fileId: number, afterEntryIndex: number, limit: number): Checkpoint[] {
    this.#db.assertScope(ctx);
    // a negative LIMIT means "no limit" in SQLite: never pass one on
    if (!(limit > 0)) return [];
    return this.#db.driver
      .prepare<CheckpointDbRow>(LIST_AFTER)
      .all([fileId, afterEntryIndex, Math.floor(limit)])
      .map(toCheckpoint);
  }

  /** The checkpoint with the highest entry index of the file. */
  last(ctx: RepoContext, fileId: number): Checkpoint | undefined {
    this.#db.assertScope(ctx);
    return this.#one(LAST, [fileId]);
  }

  count(ctx: RepoContext, fileId: number): number {
    this.#db.assertScope(ctx);
    return (
      this.#db.driver
        .prepare<{ n: number }>('SELECT count(*) AS n FROM transcript_checkpoints WHERE file_id = ?')
        .get([fileId])?.n ?? 0
    );
  }

  #one(sql: string, params: readonly number[]): Checkpoint | undefined {
    const row = this.#db.driver.prepare<CheckpointDbRow>(sql).get(params);
    return row === undefined ? undefined : toCheckpoint(row);
  }

  #requireFile(fileId: number): void {
    const found = this.#db.driver.prepare<{ id: number }>('SELECT id FROM transcript_files WHERE id = ?').get([fileId]);
    if (found === undefined) {
      throw new DbError('db_constraint', 'the transcript file does not exist', { constraint: 'foreignkey' });
    }
  }
}
