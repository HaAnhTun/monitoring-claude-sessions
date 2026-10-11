// Pure timeline logic: tool/result pairing, merging, follow state machine, error stepping, jump parsing.

/**
 * Pair events into display units. A `tool` unit carries its `result` (same id).
 * A result whose tool is not loaded becomes an orphan unit.
 * status: 'active' (no result yet) | 'completed' | 'failed' | null for non-tool units.
 */
export function pairEvents(events) {
  const resultsById = new Map();
  for (const ev of events) {
    if (ev.k === 'result' && ev.id !== undefined && ev.id !== null && !resultsById.has(ev.id)) resultsById.set(ev.id, ev);
  }
  const toolIds = new Set();
  const units = [];
  for (const ev of events) {
    if (ev.k === 'tool') {
      const result = ev.id !== undefined && ev.id !== null ? resultsById.get(ev.id) || null : null;
      if (ev.id !== undefined && ev.id !== null) toolIds.add(ev.id);
      units.push({ key: `e${ev.i}`, kind: 'tool', ev, result, status: result ? (result.err ? 'failed' : 'completed') : 'active', orphan: false });
    } else if (ev.k === 'result') {
      units.push({ key: `e${ev.i}`, kind: 'result', ev, result: null, status: null, orphan: true });
    } else {
      units.push({ key: `e${ev.i}`, kind: ev.k, ev, result: null, status: null, orphan: false });
    }
  }
  // Drop orphan units whose tool turned out to be loaded.
  return units.filter((u) => !(u.kind === 'result' && toolIds.has(u.ev.id)));
}

/** Changes whenever the rendered row of a unit must change. */
export function unitSig(u) {
  return `${u.kind}|${u.status || ''}|${u.result ? u.result.i : ''}`;
}

export function isErrorUnit(u) {
  return u.status === 'failed' || (u.kind === 'result' && !!u.ev.err);
}

/** Seconds a tool ran (completed) or has been running (active). null when unknown. */
export function toolDurationSec(u, nowMs) {
  const start = Date.parse(u.ev.t);
  if (Number.isNaN(start)) return null;
  const end = u.result ? Date.parse(u.result.t) : nowMs;
  if (Number.isNaN(end)) return null;
  return Math.max(0, (end - start) / 1000);
}

/** Merge events into an ascending, de-duplicated (by index) list. Incoming wins on conflicts. */
export function mergeEvents(existing, incoming) {
  if (!incoming.length) return { events: existing, added: 0, olderAdded: 0 };
  const lastExisting = existing.length ? existing[existing.length - 1].i : -1;
  const firstExisting = existing.length ? existing[0].i : Infinity;
  if (incoming[0].i > lastExisting) {
    return { events: existing.concat(incoming), added: incoming.length, olderAdded: 0 };
  }
  const map = new Map();
  for (const e of existing) map.set(e.i, e);
  let added = 0;
  let olderAdded = 0;
  for (const e of incoming) {
    if (!map.has(e.i)) { added += 1; if (e.i < firstExisting) olderAdded += 1; }
    map.set(e.i, e);
  }
  const events = [...map.values()].sort((a, b) => a.i - b.i);
  return { events, added, olderAdded };
}

/**
 * Follow state machine. state: { follow, unseen, away }.
 * - scroll away from the latest edge turns follow off (away = true);
 *   scrolling back to the edge resumes only if it was turned off by scrolling away;
 * - while follow is off, new events are counted in `unseen`;
 * - toggle/resume are explicit user actions.
 */
export const initialFollow = () => ({ follow: true, unseen: 0, away: false });

export function followReducer(state, action) {
  switch (action.type) {
    case 'scroll':
      if (state.follow && !action.atEdge) return { follow: false, unseen: state.unseen, away: true };
      if (!state.follow && state.away && action.atEdge) return { follow: true, unseen: 0, away: false };
      return state;
    case 'events':
      if (state.follow || !action.count) return state;
      return { ...state, unseen: state.unseen + action.count };
    case 'toggle':
      return state.follow ? { follow: false, unseen: state.unseen, away: false } : { follow: true, unseen: 0, away: false };
    case 'off':
      return state.follow ? { follow: false, unseen: state.unseen, away: false } : state;
    case 'resume':
      return { follow: true, unseen: 0, away: false };
    case 'reset':
      return initialFollow();
    default:
      return state;
  }
}

/** Is the scroller at the edge where the newest event sits? */
export function atLatestEdge({ scrollTop, scrollHeight, clientHeight }, newestFirst, tol = 24) {
  if (newestFirst) return scrollTop <= tol;
  return scrollHeight - scrollTop - clientHeight <= tol;
}

/**
 * Next/previous error in display order. keys: error unit keys in display order.
 * dir +1 = further down the list, -1 = further up. Returns null when there is none.
 */
export function stepError(keys, cursor, dir) {
  if (!keys.length) return null;
  const at = cursor === null || cursor === undefined ? -1 : keys.indexOf(cursor);
  if (at === -1) return dir > 0 ? keys[0] : keys[keys.length - 1];
  const n = at + (dir > 0 ? 1 : -1);
  return n >= 0 && n < keys.length ? keys[n] : null;
}

/**
 * Jump target from user text: "#42" / "42" -> index; "12:30[:15]" -> local time today;
 * an ISO / date string -> timestamp. Returns null when it is not understood.
 */
export function parseJump(text, now = new Date()) {
  const t = String(text || '').trim();
  if (!t) return null;
  let m = /^#?(\d{1,9})$/.exec(t);
  if (m) return { type: 'index', i: Number(m[1]) };
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) {
    const h = Number(m[1]); const mi = Number(m[2]); const s = Number(m[3] || 0);
    if (h > 23 || mi > 59 || s > 59) return null;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, s);
    return { type: 'time', ts: d.toISOString() };
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return { type: 'time', ts: new Date(ms).toISOString() };
  }
  return null;
}
