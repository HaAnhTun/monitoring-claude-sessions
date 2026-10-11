// Spool replay (02 2.7 steps 1-4; registry C03, C04): plan which segments to read again, then reset their cursors in ONE
// write transaction. The segments stay on disk; the next drain reads them from byte 0, and dedupe D-1 (`event_uid`) makes
// the re-read a no-op for every line that was already ingested, so only lines that were never committed add rows.
//
// The audit entry (`ingest-replay`, the 01 7.2 template, C05) and the dry-run output belong to the CLI operation that calls
// these two functions; a running instance goes through `IngestService.replay`, which runs `applySpoolReplay` from the
// writer queue so it never interleaves with a drain transaction.
import type { InstanceDb, RepoContext } from '../../db/open.ts';
import { SpoolCursorsRepo } from '../../db/repos/spool-cursors.ts';
import { withWriteTx } from '../../db/write.ts';
import { SpoolSegmentNotFoundError } from '../errors.ts';
import { isSegmentName, listSegments } from './segments.ts';

export interface SpoolReplaySegment {
  readonly segment: string;
  readonly bytes: number;
  /** Where the cursor stands now (0 when the segment has no cursor yet). */
  readonly offset: number;
  readonly sealed: boolean;
}

export interface SpoolReplayPlan {
  readonly segments: SpoolReplaySegment[];
  readonly totalBytes: number;
}

/**
 * Every segment file on disk whose name sorts at or after `from` (all of them when `from` is null), with its cursor.
 * `from` must be a segment name and exist on disk, else `SpoolSegmentNotFoundError` (the CLI maps it to `NOT_FOUND`). Reads
 * the folder and the cursors; writes nothing.
 */
export async function planSpoolReplay(
  ctx: RepoContext,
  repos: { spoolCursors: SpoolCursorsRepo },
  spoolDir: string,
  from: string | null,
): Promise<SpoolReplayPlan> {
  const listing = await listSegments(spoolDir);
  if (from !== null && (!isSegmentName(from) || !listing.segments.some((file) => file.name === from))) {
    throw new SpoolSegmentNotFoundError(from);
  }
  const cursors = new Map(repos.spoolCursors.list(ctx).map((row) => [row.segment, row] as const));
  const segments: SpoolReplaySegment[] = [];
  let totalBytes = 0;
  for (const file of listing.segments) {
    if (from !== null && file.name < from) continue;
    const cursor = cursors.get(file.name);
    segments.push({
      segment: file.name,
      bytes: file.bytes,
      offset: cursor?.offsetBytes ?? 0,
      sealed: cursor?.sealed ?? false,
    });
    totalBytes += file.bytes;
  }
  return { segments, totalBytes };
}

/**
 * One `withWriteTx` that sets `offset_bytes = 0, partial_bytes = 0, sealed = 0, lines = 0` for every planned segment (rows
 * are created for segments without a cursor). Returns how many segments were reset; the CLI prints it and the control
 * operation `ingest-replay` replies it as `segments`.
 */
export function applySpoolReplay(db: InstanceDb, ctx: RepoContext, plan: SpoolReplayPlan): { segmentsReset: number } {
  const cursors = new SpoolCursorsRepo(db);
  const segmentsReset = withWriteTx(db, ctx, (tx) =>
    cursors.resetMany(
      ctx,
      tx,
      plan.segments.map((entry) => entry.segment),
    ),
  );
  return { segmentsReset };
}
