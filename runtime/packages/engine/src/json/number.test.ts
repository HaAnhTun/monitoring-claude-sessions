import { describe, expect, it } from 'vitest';

import { formatFloat } from './number.ts';

describe('formatFloat', () => {
  it('writes integral floats with a trailing .0', () => {
    expect(formatFloat(24)).toBe('24.0');
    expect(formatFloat(100000)).toBe('100000.0');
    expect(formatFloat(1e15)).toBe('1000000000000000.0');
    expect(formatFloat(-3)).toBe('-3.0');
  });

  it('keeps the shortest round-trip digits', () => {
    expect(formatFloat(0.1)).toBe('0.1');
    expect(formatFloat(0.30000000000000004)).toBe('0.30000000000000004');
    expect(formatFloat(123456789.12345679)).toBe('123456789.12345679');
    expect(formatFloat(-2.5)).toBe('-2.5');
  });

  it('switches to exponent form at 1e16 and below 1e-4', () => {
    expect(formatFloat(1e16)).toBe('1e+16');
    expect(formatFloat(1.5e16)).toBe('1.5e+16');
    expect(formatFloat(9999999999999998)).toBe('9999999999999998.0');
    expect(formatFloat(0.0001)).toBe('0.0001');
    expect(formatFloat(0.00001)).toBe('1e-05');
    expect(formatFloat(1.5e-7)).toBe('1.5e-07');
    expect(formatFloat(1e100)).toBe('1e+100');
    expect(formatFloat(5e-324)).toBe('5e-324');
    expect(formatFloat(1.7976931348623157e308)).toBe('1.7976931348623157e+308');
  });

  it('keeps the sign of zero', () => {
    expect(formatFloat(0)).toBe('0.0');
    expect(formatFloat(-0)).toBe('-0.0');
  });

  it('spells the non-finite values for messages (they are never written to a file)', () => {
    expect(formatFloat(Number.NaN)).toBe('nan');
    expect(formatFloat(Number.POSITIVE_INFINITY)).toBe('inf');
    expect(formatFloat(Number.NEGATIVE_INFINITY)).toBe('-inf');
  });
});
