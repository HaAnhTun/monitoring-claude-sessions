// @vitest-environment node
import type { Metric, TokenUsage } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import {
  fmtAge,
  fmtBytes,
  fmtClock,
  fmtDuration,
  fmtMB,
  fmtMetric,
  fmtPct,
  fmtRelative,
  fmtTok,
  fmtTokOrNa,
  plural,
  timeTitle,
  tokenLine,
  tokenParts,
  usageBadge,
} from './format.ts';

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    total: 0,
    missing: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    turns: 1,
    synthetic: 0,
    unfinalized: 0,
    completeness: 'complete',
    scannedPct: null,
    lowerBound: false,
    ...over,
  };
}

function metric(over: Partial<Metric> = {}): Metric {
  return {
    key: 'sessions.active',
    label: 'Active sessions',
    value: 3,
    unit: 'count',
    source: 'invented source',
    rule: 'invented rule',
    completeness: 'complete',
    asOf: '2026-10-11T12:00:00.000Z',
    link: null,
    ...over,
  };
}

describe('format', () => {
  it('legacy: fmtAge', () => {
    expect(fmtAge(0)).toBe('0s');
    expect(fmtAge(45)).toBe('45s');
    expect(fmtAge(120)).toBe('2m');
    expect(fmtAge(7200)).toBe('2h');
    expect(fmtAge(200000)).toBe('2d');
    expect(fmtAge(-5)).toBe('0s');
    expect(fmtAge(null)).toBe('');
  });

  it('fmtAge keeps the legacy thresholds at their edges', () => {
    expect(fmtAge(89)).toBe('89s');
    expect(fmtAge(90)).toBe('2m');
    expect(fmtAge(5399)).toBe('90m');
    expect(fmtAge(5400)).toBe('2h');
    expect(fmtAge(129599)).toBe('36h');
    expect(fmtAge(129600)).toBe('2d');
    expect(fmtAge(undefined)).toBe('');
    expect(fmtAge(Number.NaN)).toBe('');
  });

  it('legacy: fmtBytes / fmtTok / fmtDuration', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(5 * 1048576)).toBe('5.0 MB');
    expect(fmtBytes(300 * 1048576)).toBe('300 MB');
    expect(fmtBytes(-1)).toBe('');
    expect(fmtTok(999)).toBe('999');
    expect(fmtTok(12345)).toBe('12k');
    expect(fmtTok(2500000)).toBe('2.5M');
    expect(fmtTok(undefined)).toBe('0');
    expect(fmtDuration(8)).toBe('8s');
    expect(fmtDuration(125)).toBe('2m 05s');
    expect(fmtDuration(3900)).toBe('1h 05m');
  });

  it('legacy: fmtClock is local HH:MM:SS and tolerates garbage', () => {
    const iso = '2026-10-11T12:34:56Z';
    const d = new Date(iso);
    const p = (n: number): string => String(n).padStart(2, '0');
    expect(fmtClock(iso)).toBe(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
    expect(fmtClock('not a date')).toBe('');
    expect(fmtClock('')).toBe('');
    expect(fmtClock(null)).toBe('');
  });

  it('legacy: relative age and tooltip', () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    expect(fmtRelative('2026-10-11T11:57:00Z', now)).toBe('3m ago');
    expect(fmtRelative('2026-10-11T11:59:58Z', now)).toBe('just now');
    expect(timeTitle('2026-10-11T11:57:00Z', now)).toBe('2026-10-11T11:57:00Z (3m ago)');
    expect(fmtRelative(null, now)).toBe('');
    expect(fmtRelative('garbage', now)).toBe('');
    expect(timeTitle(null, now)).toBe('');
    expect(timeTitle('garbage', now)).toBe('garbage');
  });

  it('legacy: token line uses out / new input / cache read and never "processed"', () => {
    const u = usage({ input: 100, cacheCreation: 900, output: 2000, cacheRead: 5000000 });
    expect(tokenParts(u)).toEqual({ out: 2000, newInput: 1000, cacheRead: 5000000 });
    const line = tokenLine(u);
    expect(line).toMatch(/out 2k/);
    expect(line).toMatch(/new input 1k/);
    expect(line).toMatch(/cache read 5\.0M/);
    expect(line).not.toMatch(/processed/i);
    expect(tokenLine(null)).toBe('tokens n/a');
    expect(tokenParts(null)).toBeNull();
  });

  it('token parts: a null part is shown as n/a (UI-I9), never as zero', () => {
    const u = usage({ input: null, cacheCreation: 900, output: 2000, cacheRead: null });
    expect(tokenParts(u)).toEqual({ out: 2000, newInput: null, cacheRead: null });
    expect(tokenLine(u)).toBe('out 2k · new input n/a · cache read n/a');
    const onlyCacheCreationMissing = usage({ input: 5, cacheCreation: null, output: 1, cacheRead: 0 });
    expect(tokenParts(onlyCacheCreationMissing)?.newInput).toBeNull();
    expect(fmtTokOrNa(null)).toBe('n/a');
    expect(fmtTokOrNa(12345)).toBe('12k');
    expect(fmtTokOrNa(0)).toBe('0');
  });

  it('legacy: usageBadge: partial, unavailable, complete', () => {
    expect(usageBadge(usage())).toBeNull();
    const p = usageBadge(usage({ completeness: 'partial', scannedPct: 42 }));
    expect(p?.kind).toBe('partial');
    expect(p?.text).toBe('lower bound');
    expect(p?.tip).toBe('lower bound, scan 42% complete');
    expect(usageBadge(usage({ completeness: 'partial', scannedPct: 7 }))?.tip).toBe('lower bound, scan 7% complete');
    expect(usageBadge(usage({ completeness: 'partial', scannedPct: null }))?.tip).toBe(
      'lower bound, scan not complete',
    );
    const u = usageBadge(usage({ completeness: 'unavailable' }));
    expect(u?.kind).toBe('unavailable');
    expect(u?.tip).toBe('not available');
    expect(usageBadge(null)?.kind).toBe('unavailable');
  });

  it('usageBadge marks a lower-bound subagent total as partial even when the scan is complete', () => {
    const b = usageBadge(usage({ lowerBound: true }));
    expect(b?.kind).toBe('partial');
    expect(b?.text).toBe('lower bound');
    expect(b?.tip).toBe('lower bound, scan not complete');
  });

  it('legacy: plural', () => {
    expect(plural(1, 'error')).toBe('1 error');
    expect(plural(2, 'error')).toBe('2 errors');
    expect(plural(0, 'match', 'matches')).toBe('0 matches');
  });

  it('fmtMB and fmtPct', () => {
    expect(fmtMB(5 * 1048576)).toBe('5.0 MB');
    expect(fmtMB(20 * 1048576)).toBe('20 MB');
    expect(fmtMB(Number.NaN)).toBe('');
    expect(fmtPct(41.6)).toBe('42%');
    expect(fmtPct(null)).toBe('n/a');
    expect(fmtPct(undefined)).toBe('n/a');
    expect(fmtPct(12.345, 1)).toBe('12.3%');
  });

  it('fmtMetric formats by unit and says "not available" for null', () => {
    expect(fmtMetric(metric({ value: null }))).toBe('not available');
    expect(fmtMetric(metric({ value: 3 }))).toBe('3');
    expect(fmtMetric(metric({ value: 12345, unit: 'tokens' }))).toBe('12k');
    expect(fmtMetric(metric({ value: 125000, unit: 'ms' }))).toBe('2m 05s');
    expect(fmtMetric(metric({ value: 2048, unit: 'bytes' }))).toBe('2.0 KB');
    expect(fmtMetric(metric({ value: 1.5, unit: 'currency', currency: 'USD' }))).toBe('1.50 USD');
    expect(fmtMetric(metric({ value: 1.5, unit: 'currency' }))).toBe('1.50');
  });
});
