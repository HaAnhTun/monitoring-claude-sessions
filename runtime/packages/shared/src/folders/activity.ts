// Activity of a folder from the DA memory (CAW design 03 section 3): the timestamp format, the three-step mark and the
// shared "same local day" test. Pure and isomorphic; the clock is always an argument.

/** The marks of a folder row, most recent first. The single definition: the zod enum of the contracts is built from it. */
export const ACTIVITY_MARKS = ['full', 'half', 'none'] as const;
export type ActivityMark = (typeof ACTIVITY_MARKS)[number];

const TWO_HOURS_MS = 7_200_000;

const DA_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/**
 * Reads a DA memory timestamp (`%Y-%m-%dT%H:%M:%S`, naive local time) to epoch milliseconds, or `null` when the text is
 * not exactly that format or names a time that does not exist (month 13, 30 February, hour 24, a DST gap). The check is
 * strict: a regular expression, then a round trip through `Date` so that nothing is silently rolled over.
 */
export function parseDaTimestamp(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = DA_TIMESTAMP.exec(text);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  // a year before the epoch is not a time the DA tool wrote (and `Date` reads two-digit years as 19xx)
  if (year < 1970) return null;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  const same =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute &&
    date.getSeconds() === second;
  return same ? date.getTime() : null;
}

/** True when both instants fall on the same calendar day of the local time zone. */
export function sameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * MTOP `activity_mark`: `full` up to two hours old (a time in the future counts as just now), `half` when it is still the
 * same local calendar day, otherwise `none`; a missing or non-finite time is `none`.
 */
export function activityMarkOf(thenMs: number | null, nowMs: number): ActivityMark {
  if (thenMs === null || !Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return 'none';
  if (nowMs - thenMs <= TWO_HOURS_MS) return 'full';
  return sameLocalDay(thenMs, nowMs) ? 'half' : 'none';
}
