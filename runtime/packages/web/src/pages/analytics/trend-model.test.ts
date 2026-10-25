import { describe, expect, it } from 'vitest';

import { makeSeriesPoint, makeUsageSeries } from '../../test/fixtures/index.ts';
import { buildAxis, niceMax, peakSlot, tickSlots } from './trend-model.ts';

const DAY = 86_400_000;
const day = (n: number): string => new Date(Date.UTC(2026, 2, n)).toISOString();

describe('buildAxis', () => {
  it('places the points on the full axis of the window and leaves an omitted bucket as a gap', () => {
    const series = makeUsageSeries({
      bucket: 'day',
      window: { from: day(8), to: new Date(Date.UTC(2026, 2, 14, 12)).toISOString() },
      points: [
        makeSeriesPoint({ start: day(9) }),
        makeSeriesPoint({ start: day(10) }),
        makeSeriesPoint({ start: day(12) }),
      ],
    });
    const axis = buildAxis(series);
    expect(axis).not.toBeNull();
    expect(axis?.count).toBe(7);
    expect(axis?.startMs).toBe(Date.parse(day(8)));
    expect(axis?.stepMs).toBe(DAY);
    expect(axis?.slots.map((slot) => slot !== null)).toEqual([false, true, true, false, true, false, false]);
  });

  it('starts at the first point when the window has no start (all time)', () => {
    const series = makeUsageSeries({
      window: { from: null, to: day(12) },
      points: [makeSeriesPoint({ start: day(10) }), makeSeriesPoint({ start: day(11) })],
    });
    expect(buildAxis(series)?.count).toBe(3);
  });

  it('keeps the latest buckets and says so when the axis is longer than the limit', () => {
    const series = makeUsageSeries({
      window: { from: day(1), to: day(30) },
      points: [makeSeriesPoint({ start: day(1) }), makeSeriesPoint({ start: day(30) })],
    });
    const axis = buildAxis(series, 10);
    expect(axis?.count).toBe(10);
    expect(axis?.clipped).toBe(true);
    expect(axis?.slots[0]).toBeNull();
    expect(axis?.slots[9]).not.toBeNull();
    expect(axis?.startMs).toBe(Date.parse(day(21)));
  });

  it('has no axis without points', () => {
    expect(buildAxis(makeUsageSeries({ points: [] }))).toBeNull();
  });
});

describe('scale helpers', () => {
  it('rounds the top of a scale up to 1, 2, 5 or 10 times a power of ten', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.4)).toBe(2);
    expect(niceMax(41_000)).toBe(50_000);
    expect(niceMax(52_000)).toBe(100_000);
  });

  it('labels the first, the middle and the last slot', () => {
    expect(tickSlots(0)).toEqual([]);
    expect(tickSlots(1)).toEqual([0]);
    expect(tickSlots(2)).toEqual([0, 1]);
    expect(tickSlots(7)).toEqual([0, 3, 6]);
  });

  it('finds the slot of the largest value among the present buckets', () => {
    const slots = [null, makeSeriesPoint({ output: 5 }), null, makeSeriesPoint({ output: 9 })];
    expect(peakSlot(slots, 'output')).toBe(3);
    expect(peakSlot([null, null], 'output')).toBeNull();
  });
});
