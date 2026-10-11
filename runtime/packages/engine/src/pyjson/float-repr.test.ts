import { describe, expect, it } from 'vitest';

import { pyFloatRepr } from './float-repr.ts';

describe('pyFloatRepr', () => {
  it('writes integral floats with a trailing .0', () => {
    expect(pyFloatRepr(24)).toBe('24.0');
    expect(pyFloatRepr(100000)).toBe('100000.0');
    expect(pyFloatRepr(1e15)).toBe('1000000000000000.0');
    expect(pyFloatRepr(-3)).toBe('-3.0');
  });

  it('keeps the shortest round-trip digits', () => {
    expect(pyFloatRepr(0.1)).toBe('0.1');
    expect(pyFloatRepr(0.30000000000000004)).toBe('0.30000000000000004');
    expect(pyFloatRepr(123456789.12345679)).toBe('123456789.12345679');
    expect(pyFloatRepr(-2.5)).toBe('-2.5');
  });

  it('switches to exponent form at 1e16 and below 1e-4, like Python', () => {
    expect(pyFloatRepr(1e16)).toBe('1e+16');
    expect(pyFloatRepr(1.5e16)).toBe('1.5e+16');
    expect(pyFloatRepr(9999999999999998)).toBe('9999999999999998.0');
    expect(pyFloatRepr(0.0001)).toBe('0.0001');
    expect(pyFloatRepr(0.00001)).toBe('1e-05');
    expect(pyFloatRepr(1.5e-7)).toBe('1.5e-07');
    expect(pyFloatRepr(1e100)).toBe('1e+100');
    expect(pyFloatRepr(5e-324)).toBe('5e-324');
    expect(pyFloatRepr(1.7976931348623157e308)).toBe('1.7976931348623157e+308');
  });

  it('keeps the sign of zero', () => {
    expect(pyFloatRepr(0)).toBe('0.0');
    expect(pyFloatRepr(-0)).toBe('-0.0');
  });

  it('spells the non-finite values like float.__repr__', () => {
    expect(pyFloatRepr(Number.NaN)).toBe('nan');
    expect(pyFloatRepr(Number.POSITIVE_INFINITY)).toBe('inf');
    expect(pyFloatRepr(Number.NEGATIVE_INFINITY)).toBe('-inf');
  });
});
