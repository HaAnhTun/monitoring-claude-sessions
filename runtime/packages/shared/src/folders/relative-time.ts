// The age of a folder's last activity as a structured value (CAW design 03 section 3). The contract carries no localized
// text: the web maps `RelativeTime` to its messages.
import { sameLocalDay } from './activity.ts';

export type RelativeTime =
  | { readonly kind: 'now' }
  | { readonly kind: 'minutes' | 'hours' | 'days'; readonly value: number }
  | { readonly kind: 'yesterday' }
  | { readonly kind: 'unknown' };

/**
 * MTOP `rel_time`: under 60 seconds is `now` (a time in the future too); under an hour `minutes`; under 24 hours and on the
 * same local calendar day `hours`; otherwise `days = floor(seconds / 86400)`, where 0 and 1 read as `yesterday`. The quirk is
 * kept on purpose: 23:00 yesterday seen at 01:00 is two hours old but another date, so `days` is 0 and it is `yesterday`.
 * A missing or non-finite time is `unknown`.
 */
export function relativeTimeOf(thenMs: number | null, nowMs: number): RelativeTime {
  if (thenMs === null || !Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return { kind: 'unknown' };
  const sec = (nowMs - thenMs) / 1000;
  if (sec < 60) return { kind: 'now' };
  if (sec < 3600) return { kind: 'minutes', value: Math.floor(sec / 60) };
  if (sec < 86_400 && sameLocalDay(thenMs, nowMs)) return { kind: 'hours', value: Math.floor(sec / 3600) };
  const days = Math.floor(sec / 86_400);
  return days <= 1 ? { kind: 'yesterday' } : { kind: 'days', value: days };
}
