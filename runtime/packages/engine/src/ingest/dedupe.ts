// Dedupe rules D-1 to D-4 of the hook path (02 4.4). D-5 (usage) belongs to the usage repository, D-6 to D-8 to the facts
// merge, which is idempotent by construction (02 7.2).
//
//   D-1  `event_uid`        a spool line read twice (crash before the cursor moved, replay)   `ON CONFLICT DO NOTHING`
//   D-2  `natural_key`      the same hook registered twice (plugin and skill copy)             a stored row with the hook bit
//   D-3  content window     duplicate registration of an event that has no id                  same session, event, hash, 2 s
//   D-4  `record_uuid`      a transcript record read twice or copied into a resumed session    `ON CONFLICT DO NOTHING`
//
// D-1 and D-4 are the insert statement of `EventsRepo`; D-2 and D-3 need a lookup first, because the statement merges on a
// natural key (a transcript row and a hook row are one row) and must not merge two hook deliveries.
import type { RepoContext } from '../db/open.ts';
import type { ContentWindowQuery, EventRef } from '../db/repos/events.ts';
import type { EventRowWrite } from './event-row.ts';

/** D-3 window: two deliveries of one hook event closer than this are one (02 4.4). */
export const CONTENT_WINDOW_MS = 2000;

/** The bit of `events.sources` that marks a row written from a hook envelope. */
export const SOURCE_HOOK = 1;

export type DuplicateLayer = 'D-1' | 'D-2' | 'D-3' | 'D-4';

export interface DedupeLookup {
  findByNaturalKey(ctx: RepoContext, naturalKey: string): EventRef | null;
  findByContent(ctx: RepoContext, query: ContentWindowQuery): EventRef | null;
}

export type DedupeVerdict =
  | { readonly verdict: 'insert' }
  | { readonly verdict: 'duplicate'; readonly layer: 'D-2' | 'D-3'; readonly existingId: number };

/**
 * Whether a hook row is a second delivery of a row that a hook already wrote. A row from another source is never judged
 * here (a transcript row is a merge or a D-4 conflict, decided by the insert). An existing transcript-only row is a
 * cross-source merge: the verdict is `insert`, and the statement merges it.
 */
export function judgeHookRow(
  lookup: DedupeLookup,
  ctx: RepoContext,
  row: EventRowWrite,
  windowMs: number = CONTENT_WINDOW_MS,
): DedupeVerdict {
  if (row.sources !== SOURCE_HOOK) return { verdict: 'insert' };
  if (row.naturalKey !== null) {
    const found = lookup.findByNaturalKey(ctx, row.naturalKey);
    if (found !== null && (found.sources & SOURCE_HOOK) !== 0) {
      return { verdict: 'duplicate', layer: 'D-2', existingId: found.id };
    }
    return { verdict: 'insert' };
  }
  if (row.hookEvent !== null && row.contentHash !== null) {
    const found = lookup.findByContent(ctx, {
      sessionUid: row.sessionUid,
      hookEvent: row.hookEvent,
      contentHash: row.contentHash,
      receivedAt: row.receivedAt,
      windowMs,
    });
    if (found !== null && (found.sources & SOURCE_HOOK) !== 0) {
      return { verdict: 'duplicate', layer: 'D-3', existingId: found.id };
    }
  }
  return { verdict: 'insert' };
}

/** Which layer an insert that wrote nothing was: a record uuid (D-4) or an envelope uid (D-1). */
export function layerOfSilentInsert(row: EventRowWrite): 'D-1' | 'D-4' {
  return row.recordUuid !== null && row.eventUid === null ? 'D-4' : 'D-1';
}

/** Duplicates seen, by layer (the writer adds them to `ingest_health` counters). */
export type DuplicateCounts = Record<DuplicateLayer, number>;

export function emptyDuplicateCounts(): DuplicateCounts {
  return { 'D-1': 0, 'D-2': 0, 'D-3': 0, 'D-4': 0 };
}

export function totalDuplicates(counts: Readonly<DuplicateCounts>): number {
  return counts['D-1'] + counts['D-2'] + counts['D-3'] + counts['D-4'];
}
