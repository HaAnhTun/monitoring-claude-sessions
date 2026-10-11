// Spool segment names, sealing and retention (02 2.7).
//
// A segment is `hooks-<YYYYMMDD>T<HH>Z.ndjson`: the UTC hour of `received_at`. The hook handler appends; this module only
// names, lists and decides. Anything else in `data/spool/` is never read (it is counted once in health as
// `spool.foreignFiles`), and so is a symlink that carries a segment name.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { SPOOL_SEGMENT_RE, spoolSegmentName } from '@mcs/shared/protocol';

const HOUR_MS = 3_600_000;

/** True for `hooks-<YYYYMMDD>T<HH>Z.ndjson` with a real calendar day and an hour from 00 to 23. */
export function isSegmentName(name: string): boolean {
  return startOf(name) !== null;
}

function startOf(name: string): number | null {
  const match = SPOOL_SEGMENT_RE.exec(name);
  if (match === null) return null;
  const day = match[1] ?? '';
  const hour = Number(match[2]);
  if (hour > 23) return null;
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(4, 6));
  const date = Number(day.slice(6, 8));
  const at = Date.UTC(year, month - 1, date, hour);
  const check = new Date(at);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return at;
}

/** The segment `received_at` belongs to (the UTC hour). */
export function segmentNameOf(receivedAt: number): string {
  return spoolSegmentName(receivedAt);
}

/** The first millisecond after the hour of the segment. Throws a `RangeError` for a name that is not a segment name. */
export function hourEndOf(segment: string): number {
  const start = startOf(segment);
  if (start === null) throw new RangeError('not a spool segment name');
  return start + HOUR_MS;
}

export interface SealInput {
  readonly segment: string;
  readonly now: number;
  readonly sealGraceMs: number;
  /** Bytes consumed up to a line start. */
  readonly offset: number;
  /** Size of the file at the last look. */
  readonly size: number;
  /** Bytes of an unterminated last line. */
  readonly partialBytes: number;
}

/**
 * `seal`: past the hour and the grace, every byte consumed. `seal_torn`: past the grace, but an unterminated tail is left;
 * the caller counts `SPOOL_TORN_TAIL` once and seals anyway. Otherwise `keep`.
 */
export function sealDecision(input: SealInput): 'keep' | 'seal' | 'seal_torn' {
  if (input.now <= hourEndOf(input.segment) + input.sealGraceMs) return 'keep';
  if (input.partialBytes > 0 && input.offset + input.partialBytes === input.size) return 'seal_torn';
  return input.offset === input.size ? 'seal' : 'keep';
}

/** A sealed segment is deleted once `now` is past its hour plus `retainHours`. */
export function retentionExpired(segment: string, now: number, retainHours: number): boolean {
  return now > hourEndOf(segment) + retainHours * HOUR_MS;
}

export interface SegmentFile {
  readonly name: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface SegmentListing {
  /** Segment files by name (the names sort by hour). */
  readonly segments: SegmentFile[];
  /** Every other entry: never read. */
  readonly foreign: string[];
}

/**
 * The files of the spool folder. A folder that does not exist is an empty listing (no hook has written yet). A directory, a
 * symlink or any file whose name is not a segment name is `foreign`.
 */
export async function listSegments(spoolDir: string): Promise<SegmentListing> {
  let entries;
  try {
    entries = await readdir(spoolDir, { withFileTypes: true });
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
      return { segments: [], foreign: [] };
    }
    throw error;
  }
  const segments: SegmentFile[] = [];
  const foreign: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSegmentName(entry.name)) {
      foreign.push(entry.name);
      continue;
    }
    try {
      const info = await stat(join(spoolDir, entry.name));
      segments.push({ name: entry.name, bytes: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // deleted between the listing and the stat (retention, a test): not there any more
    }
  }
  segments.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { segments, foreign };
}
