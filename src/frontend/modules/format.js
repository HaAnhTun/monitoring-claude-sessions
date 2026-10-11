// Pure formatting helpers (no DOM access).

export const pad2 = (n) => String(n).padStart(2, '0');

/** Local wall-clock time HH:MM:SS from an ISO timestamp; '' when missing or invalid. */
export function fmtClock(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Age in seconds -> "45s", "12m", "3h", "2d". */
export function fmtAge(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return '';
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** "3m ago" for an ISO timestamp relative to nowMs. */
export function fmtRelative(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diff = (nowMs - ms) / 1000;
  if (diff < 5) return 'just now';
  return `${fmtAge(diff)} ago`;
}

/** Tooltip text: full ISO timestamp plus relative age. */
export function timeTitle(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const rel = fmtRelative(iso, nowMs);
  return rel ? `${iso} (${rel})` : String(iso);
}

/** Duration in seconds -> "8s", "2m 05s", "1h 07m". */
export function fmtDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return '';
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`;
}

export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return `${Math.round(v)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`;
}

export function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(Math.round(v));
}

/** Token groups shown to the user. Never "processed": three separate numbers. */
export function tokenParts(u) {
  if (!u || u.skipped) return null;
  return {
    out: Number(u.out) || 0,
    newInput: (Number(u.in) || 0) + (Number(u.cc) || 0),
    cacheRead: Number(u.cr) || 0,
  };
}

export function tokenLine(u) {
  const p = tokenParts(u);
  if (!p) return 'tokens n/a';
  return `out ${fmtTok(p.out)} · new input ${fmtTok(p.newInput)} · cache read ${fmtTok(p.cacheRead)}`;
}

/**
 * Completeness badge for token numbers. Returns null when the numbers are complete.
 * kind: 'partial' | 'unavailable'; tip is the tooltip text.
 */
export function usageBadge(usage, completeness) {
  const c = completeness || {};
  if (!usage || usage.skipped || c.usage === 'unavailable') {
    return { kind: 'unavailable', text: 'not available', tip: 'not available' };
  }
  if (usage.complete === false || c.usage === 'partial') {
    const pct = usage.scanned_pct ?? c.usage_scanned_pct;
    const tip = pct === undefined || pct === null
      ? 'lower bound, scan not complete'
      : `lower bound, scan ${Math.round(pct)}% complete`;
    return { kind: 'partial', text: 'lower bound', tip };
  }
  return null;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : (many || `${one}s`)}`;
}

export function fmtMB(bytes) {
  const v = Number(bytes);
  if (!Number.isFinite(v)) return '';
  return `${(v / 1048576).toFixed(v >= 10485760 ? 0 : 1)} MB`;
}
