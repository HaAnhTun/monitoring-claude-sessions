// The entry index of the transcript service (03 7.2, ADR 0016, ADR 0023). Legacy entry indexes `i` are absolute and stable, but the
// importer reads head, then tail, then backfill (02 5.5), so its cursors are not a prefix of the file. The transcript service
// therefore keeps its own sequential index, lazily: one pass over the file counts the display entries (`countEntries`), a
// checkpoint row `(entry_index, byte_offset, min_ts, max_ts)` is written about every `CHECKPOINT_EVERY_ENTRIES` entries, and
// `transcript_files.{index_offset, entries_total, index_head_hash}` say how far the index reaches. Only counts, offsets and times are
// stored; no text is read into the database and none is kept (ADR 0016).
//
// A checkpoint row describes the block that starts at its `(entry_index, byte_offset)`: `min_ts` and `max_ts` are the times of the
// entries of that block. The block that is still open when a pass ends is written with the times it has so far and written again
// when the index grows, so a reader can always seek by entry, by byte offset or by time.
//
// Deviation from the algorithm text of 7.2 step 1 (identity): the stored head hash covers the first `min(256, index_offset)` bytes,
// the part of the file that the index has consumed, not `min(256, size)` of the moment. A file that was shorter than 256 bytes
// when it was first indexed would otherwise look replaced as soon as it grew.
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import { CHECKPOINT_EVERY_ENTRIES } from '@mcs/shared';

import { withWriteTx } from '../db/write.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import { CheckpointsRepo, type CheckpointInput } from '../db/repos/checkpoints.ts';
import { TranscriptFilesRepo } from '../db/repos/transcript-files.ts';
import { IDENTITY_HEAD_BYTES, classifyFsError, errorCodeOf } from '../ingest/tail/file-identity.ts';
import { readLines } from '../ingest/tail/jsonl-tailer.ts';
import { countEntries, recordTimestamp } from './entries.ts';

/** Bytes per read and per persisted step of the index (03 7.2 step 2: 1 MiB async chunks). */
export const INDEX_CHUNK_BYTES = 1024 * 1024;

export type TranscriptErrorCode =
  'session_not_found' | 'agent_not_found' | 'transcript_gone' | 'event_not_found' | 'aborted';

/**
 * A refusal of the transcript service. The code is one of the API catalogue (`transcript_gone` is a 410, the others 404);
 * `aborted` means the caller went away. The server route turns it into the error envelope.
 */
export class TranscriptError extends Error {
  readonly code: TranscriptErrorCode;

  constructor(code: TranscriptErrorCode) {
    super(code);
    this.name = 'TranscriptError';
    this.code = code;
  }
}

export interface EntryIndexResult {
  entriesTotal: number;
  indexOffset: number;
  sizeBytes: number;
  complete: boolean;
  reset: boolean;
}

export interface EntryIndexService {
  /** Extends the index of a file from `index_offset` to the last complete line (up to `untilBytes`), within `budgetMs`. */
  ensureIndexed(
    ctx: RepoContext,
    fileId: number,
    opts: { untilBytes?: number; budgetMs: number; signal: AbortSignal },
  ): Promise<EntryIndexResult>;
}

export interface EntryIndexOptions {
  /** Read and step size; production 1 MiB. Tests use a small one to get many steps from a small file. */
  readonly chunkBytes?: number;
  /** Entries per block; production `CHECKPOINT_EVERY_ENTRIES`. */
  readonly checkpointEvery?: number;
}

/** The sha256 of the first `length` bytes of the file; rejects with the file system error. */
async function hashHead(path: string, length: number): Promise<string> {
  const hash = createHash('sha256');
  if (length > 0) {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      hash.update(buffer.subarray(0, filled));
    } finally {
      await handle.close();
    }
  }
  return hash.digest('hex');
}

/** Runs a file system call; a path that is gone becomes `transcript_gone`, any other failure passes on. */
async function orGone<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (classifyFsError(errorCodeOf(error)) === 'missing') throw new TranscriptError('transcript_gone');
    throw error;
  }
}

function headLength(offset: number): number {
  return Math.min(IDENTITY_HEAD_BYTES, offset);
}

export function createEntryIndexService(db: InstanceDb, options: EntryIndexOptions = {}): EntryIndexService {
  const files = new TranscriptFilesRepo(db);
  const checkpoints = new CheckpointsRepo(db);
  const chunkBytes = options.chunkBytes ?? INDEX_CHUNK_BYTES;
  const every = options.checkpointEvery ?? CHECKPOINT_EVERY_ENTRIES;
  // one pass per file at a time: two passes would both read the same state and the later write could move the index back
  const queues = new Map<number, Promise<unknown>>();

  function clear(ctx: RepoContext, fileId: number): void {
    withWriteTx(db, ctx, (tx) => {
      checkpoints.deleteForFile(ctx, tx, fileId);
      files.setIndexState(ctx, tx, fileId, { indexOffset: 0, entriesTotal: 0, indexHeadHash: null });
    });
  }

  async function pass(
    ctx: RepoContext,
    fileId: number,
    opts: { untilBytes?: number; budgetMs: number; signal: AbortSignal },
  ): Promise<EntryIndexResult> {
    const row = files.get(ctx, fileId);
    if (row === undefined) throw new RangeError('the transcript file is not tracked');
    const size = (await orGone(() => stat(row.path))).size;
    const resetResult = (): EntryIndexResult => ({
      entriesTotal: 0,
      indexOffset: 0,
      sizeBytes: size,
      complete: false,
      reset: true,
    });

    // 1. identity: the consumed head must still hash to the stored value, and the file must not be shorter than the index
    let offset = row.indexOffset;
    let total = row.entriesTotal;
    let hash = row.indexHeadHash;
    if (offset > 0 || hash !== null) {
      const same =
        hash !== null && size >= offset && (await orGone(() => hashHead(row.path, headLength(offset)))) === hash;
      if (!same) {
        clear(ctx, fileId);
        return resetResult();
      }
    }

    // the open block: the last checkpoint is where it began, and its times are those of the entries so far
    const last = checkpoints.last(ctx, fileId);
    if (last !== undefined && (last.entryIndex > total || last.byteOffset > offset)) {
      clear(ctx, fileId); // rows that do not belong to the stored position: start again
      return resetResult();
    }
    let block: { entryIndex: number; byteOffset: number } | null =
      last === undefined ? null : { entryIndex: last.entryIndex, byteOffset: last.byteOffset };
    let since = last === undefined ? 0 : total - last.entryIndex;
    let minTs = last?.minTs ?? null;
    let maxTs = last?.maxTs ?? null;

    // 2. forward, one step at a time, to the last complete line before `target`
    const target = Math.min(size, opts.untilBytes ?? size);
    const deadline = performance.now() + opts.budgetMs;
    let complete = false;
    while (!opts.signal.aborted) {
      if (offset >= target) {
        complete = true;
        break;
      }
      const result = await orGone(() =>
        readLines(row.path, offset, target, Number.POSITIVE_INFINITY, {
          chunkBytes,
          sliceBytes: chunkBytes,
          acceptValidUnterminatedTail: false,
        }),
      );
      const rows: CheckpointInput[] = [];
      const closeBlock = (): void => {
        if (block !== null) rows.push({ ...block, minTs, maxTs });
      };
      for (const line of result.lines) {
        if (block === null || since >= every) {
          closeBlock();
          block = { entryIndex: total, byteOffset: block === null ? 0 : line.offset };
          since = 0;
          minTs = null;
          maxTs = null;
        }
        let record: unknown;
        try {
          record = JSON.parse(line.bytes.toString('utf8'));
        } catch {
          continue; // an invalid line produces no entries (the importer counts it)
        }
        const n = countEntries(record);
        if (n === 0) continue;
        total += n;
        since += n;
        const ts = Date.parse(recordTimestamp(record));
        if (Number.isFinite(ts)) {
          minTs = minTs === null ? ts : Math.min(minTs, ts);
          maxTs = maxTs === null ? ts : Math.max(maxTs, ts);
        }
      }
      closeBlock(); // the open block is written with what it has now, and again when it grows

      // an oversized line that is still being written cannot be resumed inside: stop after the last whole line before it
      const lastLine = result.lines.at(-1);
      const next = result.skipping
        ? lastLine === undefined
          ? offset
          : lastLine.offset + lastLine.length
        : result.nextOffset;
      if (next !== offset || result.lines.length > 0) {
        const nextHash =
          headLength(next) > headLength(offset) ? await orGone(() => hashHead(row.path, headLength(next))) : hash;
        withWriteTx(db, ctx, (tx) => {
          checkpoints.upsertMany(ctx, tx, fileId, rows);
          files.setIndexState(ctx, tx, fileId, { indexOffset: next, entriesTotal: total, indexHeadHash: nextHash });
        });
        offset = next;
        hash = nextHash;
      }
      if (result.skipping) break;
      if (result.eof) {
        complete = true;
        break;
      }
      if (performance.now() >= deadline) break;
    }
    return { entriesTotal: total, indexOffset: offset, sizeBytes: size, complete, reset: false };
  }

  return {
    async ensureIndexed(ctx, fileId, opts) {
      db.assertScope(ctx);
      const previous = queues.get(fileId) ?? Promise.resolve();
      const run = previous.then(
        () => pass(ctx, fileId, opts),
        () => pass(ctx, fileId, opts),
      );
      const tail = run.catch(() => undefined);
      queues.set(fileId, tail);
      void tail.then(() => {
        if (queues.get(fileId) === tail) queues.delete(fileId);
      });
      return run;
    },
  };
}
