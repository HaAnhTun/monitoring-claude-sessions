import { describe, expect, it } from 'vitest';

import { ACTIVITY_MARKS, activityMarkOf, parseDaTimestamp } from './activity.ts';

/** A local calendar time (the suite runs with TZ=UTC, but the helpers must follow whatever the local zone is). */
function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

describe('ACTIVITY_MARKS', () => {
  it('is the one definition, in the order full, half, none', () => {
    expect([...ACTIVITY_MARKS]).toEqual(['full', 'half', 'none']);
  });
});

describe('parseDaTimestamp (local time, strict)', () => {
  it('reads the DA memory format as local time', () => {
    expect(parseDaTimestamp('2026-11-14T09:30:05')).toBe(local(2026, 11, 14, 9, 30, 5));
    expect(parseDaTimestamp('2024-02-29T00:00:00')).toBe(local(2024, 2, 29));
    expect(parseDaTimestamp('1999-12-31T23:59:59')).toBe(local(1999, 12, 31, 23, 59, 59));
  });

  it.each([
    [''],
    ['2026-11-14'],
    ['2026-11-14 09:30:05'],
    ['2026-11-14T09:30'],
    ['2026-11-14T09:30:05Z'],
    ['2026-11-14T09:30:05+07:00'],
    ['2026-11-14T09:30:05.123'],
    [' 2026-11-14T09:30:05'],
    ['2026-11-14T09:30:05 '],
    ['2026-13-14T09:30:05'],
    ['2026-00-14T09:30:05'],
    ['2026-02-30T09:30:05'],
    ['2025-02-29T09:30:05'],
    ['2026-11-14T24:00:00'],
    ['2026-11-14T09:60:00'],
    ['2026-11-14T09:30:60'],
    ['0050-01-01T00:00:00'],
    ['２０２６-11-14T09:30:05'],
    ['not a time'],
  ])('refuses %j', (text) => {
    expect(parseDaTimestamp(text)).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const value of [null, undefined, 0, 1_700_000_000_000, {}, [], true, new Date()]) {
      expect(parseDaTimestamp(value)).toBeNull();
    }
  });
});

describe('activityMarkOf (MTOP activity_mark)', () => {
  const now = local(2026, 11, 14, 15, 0, 0);

  it('is full up to and including two hours', () => {
    expect(activityMarkOf(now, now)).toBe('full');
    expect(activityMarkOf(now - 7_200_000, now)).toBe('full');
    expect(activityMarkOf(now - 7_200_001, now)).toBe('half');
  });

  it('is half later on the same local calendar day, none on another day', () => {
    expect(activityMarkOf(local(2026, 11, 14, 0, 0, 0), now)).toBe('half');
    expect(activityMarkOf(local(2026, 11, 13, 23, 59, 59), now)).toBe('none');
    expect(activityMarkOf(local(2026, 11, 1), now)).toBe('none');
    expect(activityMarkOf(local(2025, 11, 14, 15), now)).toBe('none');
  });

  it('treats a time within two hours as full even on the day before (the clock decides, not the date)', () => {
    const early = local(2026, 11, 14, 1, 0, 0);
    expect(activityMarkOf(local(2026, 11, 13, 23, 30, 0), early)).toBe('full');
    expect(activityMarkOf(local(2026, 11, 13, 22, 59, 0), early)).toBe('none');
  });

  it('is full for a time in the future (a clock that is a little ahead)', () => {
    expect(activityMarkOf(now + 5000, now)).toBe('full');
  });

  it('is none when the time is unknown or not a finite number', () => {
    expect(activityMarkOf(null, now)).toBe('none');
    expect(activityMarkOf(Number.NaN, now)).toBe('none');
    expect(activityMarkOf(Number.POSITIVE_INFINITY, now)).toBe('none');
    expect(activityMarkOf(now, Number.NaN)).toBe('none');
  });
});
