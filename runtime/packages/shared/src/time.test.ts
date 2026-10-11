/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Clock, isoMsZ, isoSecondsZ, systemClock } from './time.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('isoSecondsZ', () => {
  it('formats epoch milliseconds as YYYY-MM-DDTHH:MM:SSZ', () => {
    expect(isoSecondsZ(0)).toBe('1970-01-01T00:00:00Z');
    expect(isoSecondsZ(Date.UTC(2026, 9, 11, 8, 9, 10))).toBe('2026-10-11T08:09:10Z');
  });

  it('drops the milliseconds without rounding up', () => {
    expect(isoSecondsZ(Date.UTC(2026, 9, 11, 8, 9, 10, 999))).toBe('2026-10-11T08:09:10Z');
    expect(isoSecondsZ(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe('2026-12-31T23:59:59Z');
  });

  it('is always UTC, whatever the process time zone', () => {
    expect(isoSecondsZ(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01T00:00:00Z');
  });

  it('rejects values that have no four-digit-year representation', () => {
    expect(() => isoSecondsZ(Number.NaN)).toThrow(RangeError);
    expect(() => isoSecondsZ(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => isoSecondsZ(Date.UTC(10000, 0, 1))).toThrow(RangeError);
    expect(() => isoSecondsZ(-62198755200000)).toThrow(RangeError); // year -1
  });
});

describe('isoMsZ', () => {
  it('is Date#toISOString', () => {
    expect(isoMsZ(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(isoMsZ(Date.UTC(2026, 9, 11, 8, 9, 10, 5))).toBe('2026-10-11T08:09:10.005Z');
  });

  it('throws RangeError on an invalid time value', () => {
    expect(() => isoMsZ(Number.NaN)).toThrow(RangeError);
  });
});

describe('systemClock', () => {
  it('reads Date.now() at every call', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    const clock: Clock = systemClock;
    expect(clock.now()).toBe(1_760_000_000_000);
    vi.setSystemTime(1_760_000_001_234);
    expect(clock.now()).toBe(1_760_000_001_234);
  });
});

describe('shared source hygiene', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sources(full));
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  it('declares the Clock interface only in time.ts', () => {
    const offenders = sources(root).filter(
      (file) => !file.endsWith('time.ts') && /\b(interface|type)\s+Clock\b/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('imports no Node built-in module from production code', () => {
    const offenders = sources(root).filter((file) =>
      /from\s+['"](node:|fs['"]|path['"]|os['"])/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
