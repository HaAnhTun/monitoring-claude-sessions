import type { Clock } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { FakeClock, FIXTURE_EPOCH_MS } from './clock.ts';

describe('FIXTURE_EPOCH_MS', () => {
  it('is 2026-01-01T00:00:00Z', () => {
    expect(FIXTURE_EPOCH_MS).toBe(Date.UTC(2026, 0, 1));
  });
});

describe('FakeClock', () => {
  it('starts where it was told to and implements Clock', () => {
    const clock: Clock = new FakeClock(FIXTURE_EPOCH_MS);
    expect(clock.now()).toBe(FIXTURE_EPOCH_MS);
  });

  it('only moves when advanced or set', () => {
    const clock = new FakeClock(1000);
    expect(clock.now()).not.toBe(Date.now());
    clock.advance(250);
    clock.advance(0);
    expect(clock.now()).toBe(1250);
    clock.set(5);
    expect(clock.now()).toBe(5);
  });

  it('rejects values that are not finite and negative advances', () => {
    expect(() => new FakeClock(Number.NaN)).toThrow(RangeError);
    const clock = new FakeClock(0);
    expect(() => {
      clock.advance(-1);
    }).toThrow(RangeError);
    expect(() => {
      clock.advance(Number.POSITIVE_INFINITY);
    }).toThrow(RangeError);
    expect(() => {
      clock.set(Number.NaN);
    }).toThrow(RangeError);
    expect(clock.now()).toBe(0);
  });
});
