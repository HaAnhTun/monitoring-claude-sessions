// What the person has already seen (ADR 0107, design attention-trust 3.3). Pure: no clock, no storage. The map is kept in the
// preference `attentionSeen`; it holds session ids and times, never a label, a path or a terminal name.

/** At most this many sessions are remembered; the newest times stay. */
export const SEEN_MAX = 64;
/** A row counts as viewed once it was selected for this long on a visible and focused page. */
export const SEEN_DWELL_MS = 1000;

/** Session id -> the `since` of the state the person has seen (an API time, so text order is time order). */
export type SeenMap = Readonly<Record<string, string>>;

const SEEN_KEY = /^[A-Za-z0-9._:-]{1,64}$/;
const SEEN_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SEEN_TIME_MAX = 30;
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const isSeenKey = (id: string): boolean => SEEN_KEY.test(id) && !UNSAFE_KEYS.has(id);
const isSeenTime = (v: unknown): v is string => typeof v === 'string' && v.length <= SEEN_TIME_MAX && SEEN_TIME.test(v);

/** The validator of the preference: at most 64 entries, an id as key, an ISO time as value. */
export function isSeenMap(v: unknown): v is SeenMap {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= SEEN_MAX && entries.every(([id, time]) => isSeenKey(id) && isSeenTime(time));
}

/** True while the state that began at `since` is later than what the person saw. A state without a time is always unseen. */
export function isUnseen(seen: SeenMap, id: string, since: string | null): boolean {
  if (since === null) return true;
  const known = Object.hasOwn(seen, id) ? seen[id] : undefined;
  return known === undefined || since > known;
}

/**
 * Records that the person saw the state of `id` that began at `since`. The same map comes back when nothing changes (an older
 * or missing time, an id the store would refuse); past 64 entries the oldest times are dropped.
 */
export function markSeen(seen: SeenMap, id: string, since: string | null): SeenMap {
  if (since === null || !isSeenKey(id) || !isSeenTime(since) || !isUnseen(seen, id, since)) return seen;
  const entries = Object.entries({ ...seen, [id]: since });
  if (entries.length <= SEEN_MAX) return Object.fromEntries(entries);
  entries.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  return Object.fromEntries(entries.slice(0, SEEN_MAX));
}

/** Whether a row selected at `startedAt` (milliseconds of the injected clock) has been looked at long enough. */
export function hasDwelled(startedAt: number | null, now: number): boolean {
  return startedAt !== null && now - startedAt >= SEEN_DWELL_MS;
}
