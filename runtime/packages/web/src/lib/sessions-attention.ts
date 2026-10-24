// What needs attention in a list of sessions (ADR 0073 decision 7, ADR 0074 decision 8, review R-11 and R-34): the counts of the
// four tiles of the attention strip, where each count comes from, the "attention first" order and the way a tile maps to the
// address. Pure: no clock, no React.
//
// The tiles overlap on purpose. "Working" is every active session (what the server metric `sessions.active` and the filter
// `state=active` mean); "Quiet (inferred)" is the part of it that the engine only inferred from silence; "With errors" and
// "Waiting for input" cut across the states.
import { ACTIVE_STATES, type LifecycleState, type Overview } from '@mcs/shared';

import { hasQuestionMark } from './state-evidence.ts';
import type { SessionsUrlState } from './url-state.ts';

/** The fields of a session that this module reads; a `SessionSummary` satisfies it. */
export interface AttentionRow {
  state: { state: string; basis: string };
  errorCount: number;
  lastActivityAt?: string | null;
}

export const ATTENTION_TILES = ['working', 'quiet', 'errors', 'waiting'] as const;
export type AttentionTile = (typeof ATTENTION_TILES)[number];
/** The tile that is pressed, or none. */
export type AttentionFilter = AttentionTile | null;

const ACTIVE: ReadonlySet<string> = new Set(ACTIVE_STATES);

export function matchesAttention(row: AttentionRow, tile: AttentionTile): boolean {
  switch (tile) {
    case 'working':
      return ACTIVE.has(row.state.state);
    case 'quiet':
      return hasQuestionMark(row.state.state, row.state.basis);
    case 'errors':
      return row.errorCount > 0;
    case 'waiting':
      return row.state.state === 'waiting_input';
  }
}

export interface AttentionCounts extends Record<AttentionTile, number> {
  /** How many rows were counted. */
  loaded: number;
  /** The whole list was counted (no other page exists); otherwise every count is a lower bound. */
  exact: boolean;
}

/** The counts of the four tiles over the rows that are loaded; `complete` says that no page is left on the server. */
export function sessionsAttention(rows: readonly AttentionRow[], options: { complete: boolean }): AttentionCounts {
  const counts: AttentionCounts = {
    working: 0,
    quiet: 0,
    errors: 0,
    waiting: 0,
    loaded: rows.length,
    exact: options.complete,
  };
  for (const row of rows) {
    for (const tile of ATTENTION_TILES) if (matchesAttention(row, tile)) counts[tile] += 1;
  }
  return counts;
}

// ---- where a figure comes from --------------------------------------------------------------------------------------------

/**
 * The overview metric that answers a tile, when the server has one. At the V3 head the server counts the active and the waiting
 * sessions only; "quiet" and "with errors" are counted from the rows until it learns to (ADR 0074 consequences). A key added here
 * is all it takes to switch a tile to the server.
 */
export const ATTENTION_METRIC_KEYS: Readonly<Partial<Record<AttentionTile, string>>> = {
  working: 'sessions.active',
  waiting: 'sessions.waiting_input',
};

export interface AttentionFigure {
  /** Null when nothing is known: no server metric and no row loaded yet. Never zero for "unknown". */
  value: number | null;
  /** The value is "at least" this many. */
  lowerBound: boolean;
  /** `server`: the overview metric; `loaded`: counted in the rows of the list; `none`: not known. */
  source: 'server' | 'loaded' | 'none';
  /** The rows that were counted, for the tooltip of a lower bound. */
  loaded: number;
}

/**
 * The figure of every tile (deviation D-30 of ADR 0074 decision 8): the server metric when the overview returns one with a value,
 * else the count of the loaded rows, exact when the whole list is loaded and a lower bound when more pages exist. A tile is never
 * left out once a page is loaded; before that its value is null.
 */
export function attentionFigures(
  overview: Pick<Overview, 'metrics'> | null | undefined,
  rows: readonly AttentionRow[],
  options: { complete: boolean },
): Record<AttentionTile, AttentionFigure> {
  const counts = sessionsAttention(rows, options);
  const known = rows.length > 0 || options.complete;
  const figure = (tile: AttentionTile): AttentionFigure => {
    const key = ATTENTION_METRIC_KEYS[tile];
    const metric = key === undefined ? undefined : overview?.metrics.find((candidate) => candidate.key === key);
    if (metric !== undefined && metric.value !== null && metric.completeness !== 'unavailable') {
      return {
        value: metric.value,
        lowerBound: metric.completeness === 'partial',
        source: 'server',
        loaded: counts.loaded,
      };
    }
    if (!known) return { value: null, lowerBound: false, source: 'none', loaded: counts.loaded };
    return { value: counts[tile], lowerBound: !counts.exact, source: 'loaded', loaded: counts.loaded };
  };
  return { working: figure('working'), quiet: figure('quiet'), errors: figure('errors'), waiting: figure('waiting') };
}

// ---- the "attention first" order --------------------------------------------------------------------------------------------

/**
 * 0 errors (or failed), 1 waiting for input, 2 quiet (inferred), 3 working, 4 everything else. A lower rank is read first.
 */
export function attentionRank(row: AttentionRow): 0 | 1 | 2 | 3 | 4 {
  if (row.errorCount > 0 || row.state.state === 'failed') return 0;
  if (row.state.state === 'waiting_input') return 1;
  if (matchesAttention(row, 'quiet')) return 2;
  if (matchesAttention(row, 'working')) return 3;
  return 4;
}

function timeOf(row: AttentionRow): number {
  const ms =
    row.lastActivityAt === null || row.lastActivityAt === undefined ? Number.NaN : Date.parse(row.lastActivityAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** The comparator of "Attention first": by rank, then the newest activity first. Equal rows keep their order (stable sort). */
export function compareAttention(a: AttentionRow, b: AttentionRow): number {
  const byRank = attentionRank(a) - attentionRank(b);
  if (byRank !== 0) return byRank;
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta === tb) return 0;
  return ta > tb ? -1 : 1;
}

/** A copy of the rows in attention-first order. Applied to the rows that are loaded, never sent to the server. */
export function sortByAttention<R extends AttentionRow>(rows: readonly R[]): R[] {
  return [...rows].sort(compareAttention);
}

// ---- tile and address ---------------------------------------------------------------------------------------------------------

export type AttentionUrl = Pick<SessionsUrlState, 'state' | 'errors'>;

const QUIET_STATES: readonly LifecycleState[] = ['running', 'working'];

/**
 * The filter of the address that a tile stands for (`null` clears it). "Quiet" can only be a `running` or `working` session, so it
 * narrows the address to those two states; the page narrows the loaded rows further with `matchesAttention(row, 'quiet')`.
 */
export function attentionPatch(tile: AttentionFilter): AttentionUrl {
  switch (tile) {
    case null:
      return { state: [], errors: false };
    case 'working':
      return { state: [...ACTIVE_STATES], errors: false };
    case 'quiet':
      return { state: [...QUIET_STATES], errors: false };
    case 'errors':
      return { state: [], errors: true };
    case 'waiting':
      return { state: ['waiting_input'], errors: false };
  }
}

function sameStates(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((state) => b.includes(state));
}

/** The tile that the address presses, or null when the filter is something else. */
export function attentionFilterOf(url: AttentionUrl): AttentionFilter {
  for (const tile of ATTENTION_TILES) {
    const patch = attentionPatch(tile);
    if (patch.errors === url.errors && sameStates(patch.state, url.state)) return tile;
  }
  return null;
}
