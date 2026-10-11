// Pure timeline logic (port of legacy modules/timeline-model.js, 04 section 10): tool/result pairing, merging, the follow
// state machine, error stepping and jump parsing.
import type { EntryKind, TranscriptEntry } from '@mcs/shared';

export type UnitStatus = 'active' | 'completed' | 'failed';

/** One display unit: a tool call carries its result; a result whose tool is not loaded is an orphan unit. */
export interface Unit {
  /** `e<index>`: stable across merges, used as the React key. */
  key: string;
  kind: EntryKind;
  ev: TranscriptEntry;
  result: TranscriptEntry | null;
  /** 'active' = no result yet; null for units that are not tool calls. */
  status: UnitStatus | null;
  orphan: boolean;
}

/** Pairs events (ascending by index) into display units. */
export function pairEvents(events: readonly TranscriptEntry[]): Unit[] {
  const resultsById = new Map<string, TranscriptEntry>();
  for (const ev of events) {
    if (ev.k === 'result' && ev.id !== undefined && !resultsById.has(ev.id)) resultsById.set(ev.id, ev);
  }
  const toolIds = new Set<string>();
  const units: Unit[] = [];
  for (const ev of events) {
    const key = `e${String(ev.i)}`;
    if (ev.k === 'tool') {
      const result = ev.id === undefined ? null : (resultsById.get(ev.id) ?? null);
      if (ev.id !== undefined) toolIds.add(ev.id);
      const status: UnitStatus = result === null ? 'active' : result.err === true ? 'failed' : 'completed';
      units.push({ key, kind: 'tool', ev, result, status, orphan: false });
    } else if (ev.k === 'result') {
      units.push({ key, kind: 'result', ev, result: null, status: null, orphan: true });
    } else {
      units.push({ key, kind: ev.k, ev, result: null, status: null, orphan: false });
    }
  }
  // Drop orphan units whose tool turned out to be loaded.
  return units.filter((u) => !(u.kind === 'result' && u.ev.id !== undefined && toolIds.has(u.ev.id)));
}

/** Changes whenever the rendered row of a unit must change. */
export function unitSig(u: Unit): string {
  return `${u.kind}|${u.status ?? ''}|${u.result === null ? '' : String(u.result.i)}`;
}

export function isErrorUnit(u: Unit): boolean {
  return u.status === 'failed' || (u.kind === 'result' && u.ev.err === true);
}

/** Seconds a tool ran (completed) or has been running (active); null when a timestamp is unknown. */
export function toolDurationSec(u: Unit, nowMs: number): number | null {
  const start = Date.parse(u.ev.t);
  if (Number.isNaN(start)) return null;
  const end = u.result === null ? nowMs : Date.parse(u.result.t);
  if (Number.isNaN(end)) return null;
  return Math.max(0, (end - start) / 1000);
}

export interface MergeResult {
  events: readonly TranscriptEntry[];
  added: number;
  olderAdded: number;
}

/** Merges events into an ascending list without duplicates (by index). Incoming wins on conflicts. */
export function mergeEvents(existing: readonly TranscriptEntry[], incoming: readonly TranscriptEntry[]): MergeResult {
  const firstIncoming = incoming[0];
  if (firstIncoming === undefined) return { events: existing, added: 0, olderAdded: 0 };
  const lastExisting = existing[existing.length - 1]?.i ?? -1;
  const firstExisting = existing[0]?.i ?? Infinity;
  if (firstIncoming.i > lastExisting) {
    return { events: existing.concat(incoming), added: incoming.length, olderAdded: 0 };
  }
  const byIndex = new Map<number, TranscriptEntry>();
  for (const e of existing) byIndex.set(e.i, e);
  let added = 0;
  let olderAdded = 0;
  for (const e of incoming) {
    if (!byIndex.has(e.i)) {
      added += 1;
      if (e.i < firstExisting) olderAdded += 1;
    }
    byIndex.set(e.i, e);
  }
  const events = [...byIndex.values()].sort((a, b) => a.i - b.i);
  return { events, added, olderAdded };
}

/**
 * Follow state machine.
 * - scrolling away from the latest edge turns follow off (away = true); scrolling back resumes only when it was turned
 *   off by scrolling away;
 * - while follow is off, new events are counted in `unseen`;
 * - toggle, off and resume are explicit user actions.
 */
export interface FollowState {
  follow: boolean;
  unseen: number;
  away: boolean;
}

export type FollowAction =
  | { type: 'scroll'; atEdge: boolean }
  | { type: 'events'; count: number }
  | { type: 'toggle' }
  | { type: 'off' }
  | { type: 'resume' }
  | { type: 'reset' };

export const initialFollow = (): FollowState => ({ follow: true, unseen: 0, away: false });

/** Returns the same object when nothing changes (React bail-out). */
export function followReducer(state: FollowState, action: FollowAction): FollowState {
  switch (action.type) {
    case 'scroll':
      if (state.follow && !action.atEdge) return { follow: false, unseen: state.unseen, away: true };
      if (!state.follow && state.away && action.atEdge) return { follow: true, unseen: 0, away: false };
      return state;
    case 'events':
      if (state.follow || action.count === 0) return state;
      return { ...state, unseen: state.unseen + action.count };
    case 'toggle':
      return state.follow
        ? { follow: false, unseen: state.unseen, away: false }
        : { follow: true, unseen: 0, away: false };
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

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Is the scroller at the edge where the newest event sits? */
export function atLatestEdge(m: ScrollMetrics, newestFirst: boolean, tol = 24): boolean {
  if (newestFirst) return m.scrollTop <= tol;
  return m.scrollHeight - m.scrollTop - m.clientHeight <= tol;
}

/**
 * Next or previous error in display order. `keys` are the error unit keys in display order; dir > 0 goes further down
 * the list, dir < 0 further up. Returns null when there is none (no wrapping).
 */
export function stepError(keys: readonly string[], cursor: string | null | undefined, dir: number): string | null {
  if (keys.length === 0) return null;
  const at = cursor === null || cursor === undefined ? -1 : keys.indexOf(cursor);
  if (at === -1) return (dir > 0 ? keys[0] : keys[keys.length - 1]) ?? null;
  const n = at + (dir > 0 ? 1 : -1);
  return keys[n] ?? null;
}

export type JumpTarget = { type: 'index'; i: number } | { type: 'time'; ts: string };

/**
 * Jump target from user text: "#42" or "42" is an entry index; "12:30[:15]" is a local time today; an ISO or date string
 * is a timestamp. Returns null when the text is not understood.
 */
export function parseJump(text: string | null | undefined, now: Date = new Date()): JumpTarget | null {
  const t = (text ?? '').trim();
  if (t === '') return null;
  const index = /^#?(\d{1,9})$/.exec(t);
  if (index?.[1] !== undefined) return { type: 'index', i: Number(index[1]) };
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (clock?.[1] !== undefined && clock[2] !== undefined) {
    const h = Number(clock[1]);
    const mi = Number(clock[2]);
    const s = Number(clock[3] ?? '0');
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
