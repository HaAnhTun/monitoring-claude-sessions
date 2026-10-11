import { describe, expect, it } from 'vitest';

import { compareStamp, type Stamp } from './stamp.ts';

const s = (at: number, rank: number, tie: string): Stamp => ({ at, rank, tie });

describe('compareStamp', () => {
  it('orders by time first', () => {
    expect(compareStamp(s(1, 90, 'z'), s(2, 0, 'a'))).toBeLessThan(0);
    expect(compareStamp(s(2, 0, 'a'), s(1, 90, 'z'))).toBeGreaterThan(0);
  });

  it('then by rank when the times are equal', () => {
    expect(compareStamp(s(5, 10, 'z'), s(5, 20, 'a'))).toBeLessThan(0);
    expect(compareStamp(s(5, 60, 'a'), s(5, 20, 'z'))).toBeGreaterThan(0);
  });

  it('then by the tie string (code unit order) when time and rank are equal', () => {
    expect(compareStamp(s(5, 20, 'a'), s(5, 20, 'b'))).toBeLessThan(0);
    expect(compareStamp(s(5, 20, 'b'), s(5, 20, 'a'))).toBeGreaterThan(0);
    expect(compareStamp(s(5, 20, 't:2:10'), s(5, 20, 't:2:9'))).toBeLessThan(0);
  });

  it('is zero only for identical stamps', () => {
    expect(compareStamp(s(5, 20, 'a'), s(5, 20, 'a'))).toBe(0);
  });

  it('is antisymmetric and transitive over a mixed sample (total order)', () => {
    const sample = [s(1, 0, 'a'), s(1, 0, 'b'), s(1, 10, 'a'), s(2, 0, 'a'), s(2, 60, 'z'), s(2, 60, 'zz')];
    for (const a of sample) {
      for (const b of sample) {
        expect(Math.sign(compareStamp(a, b)) + Math.sign(compareStamp(b, a))).toBe(0);
      }
    }
    const sorted = [...sample].reverse().sort(compareStamp);
    expect(sorted).toEqual(sample);
  });

  it('returns exactly -1, 0 or 1', () => {
    expect([compareStamp(s(1, 0, 'a'), s(9, 0, 'a')), compareStamp(s(9, 0, 'a'), s(1, 0, 'a'))]).toEqual([-1, 1]);
  });
});
