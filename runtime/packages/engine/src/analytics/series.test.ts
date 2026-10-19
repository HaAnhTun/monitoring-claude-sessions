// DA-T-A-3 (03 19.6, 8.2), the pure part: the bucket of a time for hour and day buckets with the offsets -480, 0 and +420 minutes,
// and how many buckets a range spans. The grouped sums are proved against a database in `test/analytics.int.test.ts`.
import { describe, expect, it } from 'vitest';

import { DAY_MS, HOUR_MS, MAX_BUCKETS, bucketSpan, bucketStart } from './series.ts';

const MINUTE = 60_000;
const T = Date.UTC(2026, 9, 11, 14, 5, 7); // 2026-10-11T14:05:07Z

describe('bucketStart', () => {
  it.each([
    // [size, offset minutes, expected start]
    [HOUR_MS, 0, Date.UTC(2026, 9, 11, 14)],
    [HOUR_MS, -480, Date.UTC(2026, 9, 11, 14)],
    [HOUR_MS, 420, Date.UTC(2026, 9, 11, 14)],
    [HOUR_MS, 330, Date.UTC(2026, 9, 11, 13, 30)], // a half-hour zone: the hour starts at :30 UTC
    [HOUR_MS, -210, Date.UTC(2026, 9, 11, 13, 30)],
    [DAY_MS, 0, Date.UTC(2026, 9, 11)],
    [DAY_MS, 420, Date.UTC(2026, 9, 10, 17)], // 21:05 local on the 11th: the local day began at 00:00 local = 17:00Z of the 10th
    [DAY_MS, -480, Date.UTC(2026, 9, 11, 8)], // 06:05 local: the local day began at 08:00Z
  ])('puts %i ms buckets at offset %i minutes', (size, offsetMinutes, expected) => {
    expect(bucketStart(T, size, offsetMinutes * MINUTE)).toBe(expected);
  });

  it('is a floor: the start is never after the time and less than one bucket before it', () => {
    for (const size of [HOUR_MS, DAY_MS]) {
      for (const offsetMinutes of [-840, -480, -1, 0, 1, 330, 420, 840]) {
        for (const ts of [0, 1, T, T + 1, Date.UTC(2026, 9, 11, 23, 59, 59, 999), 14 * HOUR_MS]) {
          const start = bucketStart(ts, size, offsetMinutes * MINUTE);
          expect(start).toBeLessThanOrEqual(ts);
          expect(ts - start).toBeLessThan(size);
          expect(Math.abs((start + offsetMinutes * MINUTE) % size)).toBe(0);
        }
      }
    }
  });

  it('floors a time before the shifted epoch instead of truncating towards zero', () => {
    // 1970-01-01T00:00:00Z at -480 minutes is 1969-12-31T16:00 local: the local day began at 1969-12-31T08:00Z
    expect(bucketStart(0, DAY_MS, -480 * MINUTE)).toBe(-16 * HOUR_MS);
    expect(bucketStart(0, DAY_MS, 420 * MINUTE)).toBe(-7 * HOUR_MS);
  });
});

describe('bucketSpan', () => {
  it('counts the buckets that the half-open range touches', () => {
    expect(bucketSpan(T, T, HOUR_MS, 0)).toBe(0);
    expect(bucketSpan(T, T + 1, HOUR_MS, 0)).toBe(1);
    expect(bucketSpan(Date.UTC(2026, 9, 11, 14), Date.UTC(2026, 9, 11, 15), HOUR_MS, 0)).toBe(1);
    expect(bucketSpan(Date.UTC(2026, 9, 11, 14), Date.UTC(2026, 9, 11, 15, 0, 0, 1), HOUR_MS, 0)).toBe(2);
    expect(bucketSpan(T - 7 * DAY_MS, T + 1, DAY_MS, 0)).toBe(8);
  });

  it('puts the limit at 2000 buckets', () => {
    const from = Date.UTC(2026, 0, 1);
    expect(bucketSpan(from, from + MAX_BUCKETS * HOUR_MS, HOUR_MS, 0)).toBe(MAX_BUCKETS);
    expect(bucketSpan(from, from + MAX_BUCKETS * HOUR_MS + 1, HOUR_MS, 0)).toBe(MAX_BUCKETS + 1);
    // an offset that is not a whole number of hours splits the first and the last hour
    expect(bucketSpan(from, from + MAX_BUCKETS * HOUR_MS, HOUR_MS, 30 * MINUTE)).toBe(MAX_BUCKETS + 1);
  });
});
