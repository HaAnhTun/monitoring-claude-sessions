import { describe, expect, it } from 'vitest';

import { relativeTimeOf } from './relative-time.ts';

function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

describe('relativeTimeOf (MTOP rel_time, structured, no text)', () => {
  const now = local(2026, 11, 14, 15, 0, 0);
  const secondsAgo = (sec: number): number => now - sec * 1000;

  it('is now below 60 seconds and minutes from 60 seconds', () => {
    expect(relativeTimeOf(secondsAgo(0), now)).toEqual({ kind: 'now' });
    expect(relativeTimeOf(secondsAgo(59), now)).toEqual({ kind: 'now' });
    expect(relativeTimeOf(secondsAgo(59.999), now)).toEqual({ kind: 'now' });
    expect(relativeTimeOf(secondsAgo(60), now)).toEqual({ kind: 'minutes', value: 1 });
    expect(relativeTimeOf(secondsAgo(119), now)).toEqual({ kind: 'minutes', value: 1 });
    expect(relativeTimeOf(secondsAgo(3599), now)).toEqual({ kind: 'minutes', value: 59 });
  });

  it('is hours from 3600 seconds while it is still the same local day', () => {
    expect(relativeTimeOf(secondsAgo(3600), now)).toEqual({ kind: 'hours', value: 1 });
    expect(relativeTimeOf(secondsAgo(7199), now)).toEqual({ kind: 'hours', value: 1 });
    expect(relativeTimeOf(secondsAgo(15 * 3600), now)).toEqual({ kind: 'hours', value: 15 });
  });

  it('is a time in the future now (a clock that is a little ahead)', () => {
    expect(relativeTimeOf(now + 30_000, now)).toEqual({ kind: 'now' });
    expect(relativeTimeOf(now + 3 * 86_400_000, now)).toEqual({ kind: 'now' });
  });

  it('keeps the MTOP quirk: 23:00 yesterday seen at 01:00 is two hours old but another date, so it is yesterday', () => {
    const early = local(2026, 11, 14, 1, 0, 0);
    expect(relativeTimeOf(local(2026, 11, 13, 23, 0, 0), early)).toEqual({ kind: 'yesterday' });
    // the same age on the same date is hours
    expect(relativeTimeOf(local(2026, 11, 14, 0, 0, 0), early)).toEqual({ kind: 'hours', value: 1 });
  });

  it('is yesterday for one day or less and days from two full days', () => {
    // 23 h 59 m 59 s ago is the previous date: the same quirk, it reads as yesterday and never as 24 hours
    expect(relativeTimeOf(secondsAgo(86_400 - 1), now)).toEqual({ kind: 'yesterday' });
    expect(relativeTimeOf(local(2026, 11, 14, 0, 0, 1), local(2026, 11, 14, 23, 59, 59))).toEqual({
      kind: 'hours',
      value: 23,
    });
    expect(relativeTimeOf(local(2026, 11, 13, 14, 0, 0), now)).toEqual({ kind: 'yesterday' });
    expect(relativeTimeOf(secondsAgo(86_400), now)).toEqual({ kind: 'yesterday' });
    expect(relativeTimeOf(secondsAgo(2 * 86_400 - 1), now)).toEqual({ kind: 'yesterday' });
    expect(relativeTimeOf(secondsAgo(2 * 86_400), now)).toEqual({ kind: 'days', value: 2 });
    expect(relativeTimeOf(secondsAgo(40 * 86_400 + 5), now)).toEqual({ kind: 'days', value: 40 });
  });

  it('is unknown when the time is missing or not a finite number', () => {
    expect(relativeTimeOf(null, now)).toEqual({ kind: 'unknown' });
    expect(relativeTimeOf(Number.NaN, now)).toEqual({ kind: 'unknown' });
    expect(relativeTimeOf(Number.NEGATIVE_INFINITY, now)).toEqual({ kind: 'unknown' });
    expect(relativeTimeOf(now, Number.NaN)).toEqual({ kind: 'unknown' });
  });

  it('carries no localized text', () => {
    for (const sec of [0, 120, 7200, 100_000, 10_000_000]) {
      const value = relativeTimeOf(secondsAgo(sec), now);
      expect(Object.keys(value).sort()).toEqual(
        value.kind === 'minutes' || value.kind === 'hours' || value.kind === 'days' ? ['kind', 'value'] : ['kind'],
      );
    }
  });
});
