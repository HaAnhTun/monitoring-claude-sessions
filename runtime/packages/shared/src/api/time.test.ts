import { describe, expect, it } from 'vitest';

import { IsoTimeInputSchema, IsoTimeSchema, isoTimeToMs, toIsoTime } from './time.ts';

describe('API time (03 5.1)', () => {
  it('output form is the millisecond UTC Z form of Date.toISOString', () => {
    expect(toIsoTime(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(IsoTimeSchema.parse('2026-10-11T10:20:30.123Z')).toBe('2026-10-11T10:20:30.123Z');
    for (const bad of [
      '2026-10-11T10:20:30Z',
      '2026-10-11T10:20:30.123+00:00',
      '2026-10-11 10:20:30.123Z',
      '2026-02-31T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '',
    ]) {
      expect(IsoTimeSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('input accepts Z or an offset and normalises to the output form', () => {
    expect(IsoTimeInputSchema.parse('2026-10-11T17:00:00+07:00')).toBe('2026-10-11T10:00:00.000Z');
    expect(IsoTimeInputSchema.parse('2026-10-11T10:00:00Z')).toBe('2026-10-11T10:00:00.000Z');
    expect(IsoTimeInputSchema.parse('2026-10-11T10:00:00.5Z')).toBe('2026-10-11T10:00:00.500Z');
    expect(IsoTimeInputSchema.safeParse('2026-10-11').success).toBe(false);
    expect(IsoTimeInputSchema.safeParse('2026-10-11T10:00:00').success).toBe(false);
    expect(IsoTimeInputSchema.safeParse('not a time').success).toBe(false);
  });

  it('input refuses an instant whose normalised form leaves years 0000-9999 (03 5.1: output is always an IsoTime)', () => {
    for (const edge of ['9999-12-31T23:59:59.999-01:00', '0000-01-01T00:00:00+01:00']) {
      expect(IsoTimeInputSchema.safeParse(edge).success, edge).toBe(false);
    }
    expect(IsoTimeInputSchema.parse('9999-12-31T23:59:59.999Z')).toBe('9999-12-31T23:59:59.999Z');
    expect(IsoTimeInputSchema.parse('0000-01-01T00:00:00.000Z')).toBe('0000-01-01T00:00:00.000Z');
    expect(IsoTimeInputSchema.parse('0001-01-01T00:00:00+01:00')).toBe('0000-12-31T23:00:00.000Z');
  });

  it('converts both ways', () => {
    expect(isoTimeToMs('2026-10-11T10:00:00.000Z')).toBe(Date.UTC(2026, 9, 11, 10));
    expect(toIsoTime(isoTimeToMs('2026-10-11T10:00:00.007Z'))).toBe('2026-10-11T10:00:00.007Z');
  });
});
