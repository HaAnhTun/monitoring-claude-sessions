// The server error ring (01 4.4a, 03 6.2): the last errors of this process, newest first, served as `HealthReport.errors`
// and `GET /errors`. It keeps one clipped line per error and never the object that caused it, so no stack, path or text
// of a transcript can reach the UI through it.
import { isoMsZ, type Clock, type ErrorItem } from '@mcs/shared';

import { firstLine } from '../platform/exec.ts';

/** How many errors the ring keeps (01 4.4a). */
export const ERROR_RING_CAPACITY = 20;

/** A message is its first line, clipped to this many code points (01 4.4a). */
export const ERROR_MESSAGE_MAX_CHARS = 200;

export interface ErrorRingEntry {
  readonly source: string;
  readonly code: string;
  readonly where: string | null;
  /** Any text: only its first line is kept, clipped to `ERROR_MESSAGE_MAX_CHARS` code points. */
  readonly message: string;
  readonly sessionId?: string | null;
}

export interface ErrorRing {
  push(e: ErrorRingEntry): void;
  /** Newest first; at most `limit` items (default: all of them); every call returns fresh copies. */
  list(limit?: number): ErrorItem[];
}

/** `capacity` is a positive integer (default 20). The time of an entry is `clock.now()` at `push`. */
export function createErrorRing(clock: Clock, capacity: number = ERROR_RING_CAPACITY): ErrorRing {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError(`createErrorRing: capacity must be a positive integer, got ${String(capacity)}`);
  }
  // oldest first; the oldest entry leaves when the ring is full
  const items: ErrorItem[] = [];
  return {
    push: (e) => {
      items.push({
        at: isoMsZ(clock.now()),
        source: e.source,
        code: e.code,
        where: e.where,
        message: firstLine(e.message, ERROR_MESSAGE_MAX_CHARS),
        sessionId: e.sessionId ?? null,
      });
      if (items.length > capacity) items.shift();
    },
    list: (limit) => {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
        throw new RangeError(`ErrorRing.list: limit must be a non-negative integer, got ${String(limit)}`);
      }
      const newestFirst = items.map((item) => ({ ...item })).reverse();
      return limit === undefined ? newestFirst : newestFirst.slice(0, limit);
    },
  };
}
