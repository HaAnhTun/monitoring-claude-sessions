// Pure formatting helpers (port of legacy modules/format.js, 04 section 10). No DOM access, no locale argument: the wall
// clock is local time and every number is plain text, so a test under any TZ sees the same words.
import type { Metric, TokenUsage } from '@mcs/shared';

export const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local wall-clock time HH:MM:SS from an ISO timestamp; '' when missing or invalid. */
export function fmtClock(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Age in seconds -> "45s", "12m", "3h", "2d" (seconds below 90 s, minutes below 5400 s, hours below 129600 s). */
export function fmtAge(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${String(s)}s`;
  if (s < 5400) return `${String(Math.round(s / 60))}m`;
  if (s < 129600) return `${String(Math.round(s / 3600))}h`;
  return `${String(Math.round(s / 86400))}d`;
}

/** "3m ago" for an ISO timestamp relative to nowMs; '' when the timestamp is missing or invalid. */
export function fmtRelative(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diff = (nowMs - ms) / 1000;
  if (diff < 5) return 'just now';
  return `${fmtAge(diff)} ago`;
}

/** Tooltip text: the full ISO timestamp plus the relative age. */
export function timeTitle(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const rel = fmtRelative(iso, nowMs);
  return rel === '' ? iso : `${iso} (${rel})`;
}

/** Duration in seconds -> "8s", "2m 05s", "1h 07m". */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m ${pad2(s % 60)}s`;
  return `${String(Math.floor(s / 3600))}h ${pad2(Math.floor((s % 3600) / 60))}m`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${String(Math.round(n))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = n / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x < 10 ? x.toFixed(1) : String(Math.round(x))} ${units[i] ?? 'TB'}`;
}

/** Token count -> "999", "12k", "2.5M"; a missing value is 0 (use fmtTokOrNa where "not known" must be visible). */
export function fmtTok(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${String(Math.round(v / 1e3))}k`;
  return String(Math.round(v));
}

/** Like fmtTok, but a null (unknown) count is "n/a", never zero (UI-I9). */
export function fmtTokOrNa(n: number | null): string {
  return n === null ? 'n/a' : fmtTok(n);
}

export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  return `${n.toFixed(digits)}%`;
}

export function fmtMB(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '';
  return `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)} MB`;
}

/** A metric value in its unit; a null value is "not available". */
export function fmtMetric(m: Metric): string {
  if (m.value === null) return 'not available';
  switch (m.unit) {
    case 'count':
      return String(m.value);
    case 'tokens':
      return fmtTok(m.value);
    case 'ms':
      return fmtDuration(m.value / 1000);
    case 'bytes':
      return fmtBytes(m.value);
    case 'currency':
      return m.currency === undefined ? m.value.toFixed(2) : `${m.value.toFixed(2)} ${m.currency}`;
  }
}

export interface TokenParts {
  out: number | null;
  newInput: number | null;
  cacheRead: number | null;
}

/**
 * Token groups shown to the user: never "processed", three separate numbers. out = output, new input = input +
 * cacheCreation, cache read = cacheRead. A group with an unknown (null) member is null.
 */
export function tokenParts(u: TokenUsage | null | undefined): TokenParts | null {
  if (u === null || u === undefined) return null;
  return {
    out: u.output,
    newInput: u.input === null || u.cacheCreation === null ? null : u.input + u.cacheCreation,
    cacheRead: u.cacheRead,
  };
}

export function tokenLine(u: TokenUsage | null | undefined): string {
  const p = tokenParts(u);
  if (p === null) return 'tokens n/a';
  return `out ${fmtTokOrNa(p.out)} · new input ${fmtTokOrNa(p.newInput)} · cache read ${fmtTokOrNa(p.cacheRead)}`;
}

export interface UsageBadge {
  kind: 'partial' | 'unavailable';
  text: string;
  tip: string;
}

/** Completeness badge for token numbers; null when the numbers are complete. */
export function usageBadge(usage: TokenUsage | null | undefined): UsageBadge | null {
  if (usage === null || usage === undefined || usage.completeness === 'unavailable') {
    return { kind: 'unavailable', text: 'not available', tip: 'not available' };
  }
  if (usage.completeness === 'partial' || usage.lowerBound) {
    const tip =
      usage.scannedPct === null
        ? 'lower bound, scan not complete'
        : `lower bound, scan ${String(Math.round(usage.scannedPct))}% complete`;
    return { kind: 'partial', text: 'lower bound', tip };
  }
  return null;
}

export function plural(n: number, one: string, many?: string): string {
  return `${String(n)} ${n === 1 ? one : (many ?? `${one}s`)}`;
}
