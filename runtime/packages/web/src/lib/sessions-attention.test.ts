// @vitest-environment node
import { ACTIVE_STATES, LIFECYCLE_STATES, type LifecycleState, type SessionSummary } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { iso, makeMetric, makeOverview, makeSession, makeState } from '../test/fixtures/index.ts';
import {
  ATTENTION_TILES,
  attentionFigures,
  attentionFilterOf,
  attentionPatch,
  attentionRank,
  compareAttention,
  matchesAttention,
  sessionsAttention,
  sortByAttention,
} from './sessions-attention.ts';

function row(n: number, state: LifecycleState, over: Partial<SessionSummary> = {}): SessionSummary {
  return makeSession({
    label: `FIXTURE ${String(n)}`,
    lastActivityAt: iso(-n * 60),
    state: makeState(state),
    errorCount: 0,
    ...over,
  });
}

/** A `waiting_input` row as the rule `rule` decides it (S-6: a person has to act; S-8: the turn is over). */
const waiting = (n: number, rule: string, over: Partial<SessionSummary> = {}): SessionSummary =>
  row(n, 'waiting_input', { state: makeState('waiting_input', { rule, waitReason: 'user' }), ...over });

const quiet = (n: number, state: LifecycleState = 'working', over: Partial<SessionSummary> = {}): SessionSummary =>
  row(n, state, { state: makeState(state, { basis: 'inferred', confidence: 'medium' }), ...over });

describe('sessionsAttention (R-11)', () => {
  it('counts working, quiet (inferred), with errors, needs you and ready for prompt', () => {
    const rows = [
      row(1, 'working'),
      quiet(2),
      quiet(3, 'running'),
      row(4, 'waiting_tool'),
      row(5, 'waiting_input'),
      row(6, 'turn_ended', { errorCount: 2 }),
      row(7, 'failed', { errorCount: 1 }),
      row(8, 'completed'),
      waiting(9, 'S-6a'),
      waiting(10, 'S-8b'),
    ];
    expect(sessionsAttention(rows, { complete: true })).toEqual({
      working: 4,
      quiet: 2,
      errors: 2,
      needs: 2,
      ready: 1,
      loaded: 10,
      exact: true,
    });
  });

  it.each([
    ['S-6a', 'needs'],
    ['S-6b', 'needs'],
    ['S-6c', 'needs'],
    ['S-8b', 'ready'],
    ['S-8f', 'ready'],
    // a rule the classifier cannot place, and no rule at all: never filed under "ready"
    ['S-1', 'needs'],
    ['X-99', 'needs'],
    ['', 'needs'],
  ] as const)('needs and ready partition waiting_input: rule %s is %s', (rule, tile) => {
    const session = waiting(1, rule);
    expect(matchesAttention(session, 'needs')).toBe(tile === 'needs');
    expect(matchesAttention(session, 'ready')).toBe(tile === 'ready');
    expect(attentionRank(session)).toBe(tile === 'needs' ? 1 : 4);
  });

  it('files a row without a rule under needs, and no other state under either half', () => {
    const bare = { state: { state: 'waiting_input', basis: 'observed' }, errorCount: 0 };
    expect([matchesAttention(bare, 'needs'), matchesAttention(bare, 'ready')]).toEqual([true, false]);
    for (const state of ['turn_ended', 'working', 'completed', 'failed'] as const) {
      const other = row(1, state, { state: makeState(state, { rule: 'S-8b' }) });
      expect([matchesAttention(other, 'needs'), matchesAttention(other, 'ready')], state).toEqual([false, false]);
    }
  });

  it('counts every active state as working, as the server metric sessions.active does', () => {
    const rows = ACTIVE_STATES.map((state, i) => row(i, state));
    expect(sessionsAttention(rows, { complete: true }).working).toBe(ACTIVE_STATES.length);
    const others = LIFECYCLE_STATES.filter((state) => !ACTIVE_STATES.some((active) => active === state));
    const counts = sessionsAttention(
      others.map((state, i) => row(i, state)),
      { complete: true },
    );
    expect(counts.working).toBe(0);
  });

  it('calls only an inferred active turn quiet; an inferred stale, unknown or waiting state is not', () => {
    const rows = [
      quiet(1, 'working'),
      quiet(2, 'running'),
      quiet(3, 'waiting_tool'),
      quiet(4, 'stale'),
      quiet(5, 'unknown'),
      quiet(6, 'turn_ended'),
      row(7, 'working'),
    ];
    expect(sessionsAttention(rows, { complete: true }).quiet).toBe(2);
  });

  it('does not count a session that has only warnings as having errors', () => {
    const counts = sessionsAttention([row(1, 'working', { warningCount: 3, errorCount: 0 })], { complete: true });
    expect(counts.errors).toBe(0);
  });

  it('says whether the counts are exact: only a complete list is', () => {
    expect(sessionsAttention([row(1, 'working')], { complete: false }).exact).toBe(false);
    expect(sessionsAttention([row(1, 'working')], { complete: true }).exact).toBe(true);
  });

  it('is all zeros for no rows, and still has the exact flag it was given', () => {
    expect(sessionsAttention([], { complete: true })).toEqual({
      working: 0,
      quiet: 0,
      errors: 0,
      needs: 0,
      ready: 0,
      loaded: 0,
      exact: true,
    });
    expect(sessionsAttention([], { complete: false }).exact).toBe(false);
  });

  it('has one counter per tile', () => {
    expect([...ATTENTION_TILES]).toEqual(['working', 'quiet', 'errors', 'needs', 'ready']);
    const counts = sessionsAttention([], { complete: true });
    for (const tile of ATTENTION_TILES) expect(counts).toHaveProperty(tile, 0);
  });

  it('agrees with matchesAttention row by row', () => {
    const rows = [
      row(1, 'working'),
      quiet(2),
      row(3, 'waiting_input'),
      row(4, 'turn_ended', { errorCount: 1 }),
      row(5, 'completed'),
    ];
    const counts = sessionsAttention(rows, { complete: true });
    for (const tile of ATTENTION_TILES) {
      expect(rows.filter((r) => matchesAttention(r, tile)).length, tile).toBe(counts[tile]);
    }
  });
});

describe('attentionFigures: the server first, then the rows that are loaded (ADR 0074 decision 8, deviation D-30)', () => {
  const rows = [row(1, 'working'), quiet(2), row(3, 'turn_ended', { errorCount: 1 }), row(4, 'waiting_input')];

  it('prefers the server metric of a tile, even when the rows say something else', () => {
    const overview = makeOverview({
      metrics: [
        makeMetric({ key: 'sessions.active', value: 7 }),
        makeMetric({ key: 'sessions.waiting_input', value: 3 }),
      ],
    });
    const figures = attentionFigures(overview, rows, { complete: true });
    expect(figures.working).toEqual({ value: 7, lowerBound: false, source: 'server', loaded: 4 });
    // the server metric counts both halves of waiting_input, so neither tile reads it
    expect(figures.needs).toEqual({ value: 1, lowerBound: false, source: 'loaded', loaded: 4 });
    expect(figures.ready).toEqual({ value: 0, lowerBound: false, source: 'loaded', loaded: 4 });
  });

  it('counts a tile that has no server metric from the loaded rows: exact for a complete list', () => {
    const figures = attentionFigures(makeOverview({ metrics: [] }), rows, { complete: true });
    expect(figures.quiet).toEqual({ value: 1, lowerBound: false, source: 'loaded', loaded: 4 });
    expect(figures.errors).toEqual({ value: 1, lowerBound: false, source: 'loaded', loaded: 4 });
    expect(figures.working).toEqual({ value: 2, lowerBound: false, source: 'loaded', loaded: 4 });
  });

  it('shows a lower bound for an incomplete list, and keeps showing it', () => {
    const figures = attentionFigures(null, rows, { complete: false });
    for (const tile of ATTENTION_TILES) expect(figures[tile].lowerBound, tile).toBe(true);
    expect(figures.errors.value).toBe(1);
    expect(figures.errors.source).toBe('loaded');
  });

  it('ignores a metric whose value is null or unavailable and falls back to the rows', () => {
    const overview = makeOverview({
      metrics: [
        makeMetric({ key: 'sessions.active', value: null, completeness: 'unavailable' }),
        makeMetric({ key: 'sessions.waiting_input', value: 5, completeness: 'unavailable' }),
      ],
    });
    const figures = attentionFigures(overview, rows, { complete: true });
    expect(figures.working.source).toBe('loaded');
    expect(figures.needs.source).toBe('loaded');
    expect(figures.needs.value).toBe(1);
  });

  it('marks a partial server metric as a lower bound', () => {
    const overview = makeOverview({
      metrics: [makeMetric({ key: 'sessions.active', value: 4, completeness: 'partial' })],
    });
    expect(attentionFigures(overview, rows, { complete: true }).working).toMatchObject({
      value: 4,
      lowerBound: true,
      source: 'server',
    });
  });

  it('never invents a zero: with no rows loaded and no server metric the value is null', () => {
    const none = attentionFigures(undefined, [], { complete: false });
    for (const tile of ATTENTION_TILES) {
      expect(none[tile]).toEqual({ value: null, lowerBound: false, source: 'none', loaded: 0 });
    }
  });

  it('knows that an empty complete list is exactly zero', () => {
    const none = attentionFigures(undefined, [], { complete: true });
    for (const tile of ATTENTION_TILES) {
      expect(none[tile]).toEqual({ value: 0, lowerBound: false, source: 'loaded', loaded: 0 });
    }
  });

  it('uses the server metric while no row is loaded yet', () => {
    const overview = makeOverview({ metrics: [makeMetric({ key: 'sessions.active', value: 2 })] });
    expect(attentionFigures(overview, [], { complete: false }).working).toMatchObject({ value: 2, source: 'server' });
  });
});

describe('the attention-first order (R-34)', () => {
  it('ranks errors, then needs you, then quiet, then working, then the rest', () => {
    expect(attentionRank(row(1, 'turn_ended', { errorCount: 1 }))).toBe(0);
    expect(attentionRank(row(2, 'failed'))).toBe(0);
    expect(attentionRank(row(3, 'waiting_input'))).toBe(1);
    expect(attentionRank(quiet(4))).toBe(2);
    expect(attentionRank(row(5, 'working'))).toBe(3);
    expect(attentionRank(row(6, 'waiting_tool'))).toBe(3);
    expect(attentionRank(row(7, 'turn_ended'))).toBe(4);
    expect(attentionRank(row(8, 'completed'))).toBe(4);
    expect(attentionRank(row(9, 'stale'))).toBe(4);
  });

  it('puts a session with errors before a quiet one even when the quiet one is newer', () => {
    const errored = row(1, 'turn_ended', { errorCount: 1, lastActivityAt: iso(-3600) });
    const quietNow = quiet(2, 'working', { lastActivityAt: iso(-10) });
    expect(compareAttention(errored, quietNow)).toBeLessThan(0);
    expect(compareAttention(quietNow, errored)).toBeGreaterThan(0);
  });

  it('orders a whole list and breaks ties by the newest activity', () => {
    const rows = [
      row(1, 'completed', { lastActivityAt: iso(-10) }),
      row(2, 'working', { lastActivityAt: iso(-20) }),
      quiet(3, 'working', { lastActivityAt: iso(-30) }),
      row(4, 'waiting_input', { lastActivityAt: iso(-40) }),
      row(5, 'turn_ended', { errorCount: 2, lastActivityAt: iso(-50) }),
      row(6, 'turn_ended', { errorCount: 1, lastActivityAt: iso(-5) }),
      row(7, 'working', { lastActivityAt: iso(-1) }),
    ];
    expect(sortByAttention(rows).map((r) => r.label)).toEqual([
      'FIXTURE 6',
      'FIXTURE 5',
      'FIXTURE 4',
      'FIXTURE 3',
      'FIXTURE 7',
      'FIXTURE 2',
      'FIXTURE 1',
    ]);
  });

  it('does not change the list it was given and is stable for equal rows', () => {
    const rows = [row(1, 'completed', { lastActivityAt: iso(-10) }), row(2, 'completed', { lastActivityAt: iso(-10) })];
    const before = rows.map((r) => r.label);
    const sorted = sortByAttention(rows);
    expect(rows.map((r) => r.label)).toEqual(before);
    expect(sorted).not.toBe(rows);
    expect(sorted.map((r) => r.label)).toEqual(before);
  });

  it('is a total order that never throws for rows without a usable time', () => {
    const odd = [
      row(1, 'working', { lastActivityAt: '' }),
      row(2, 'working', { lastActivityAt: 'not a time' }),
      row(3, 'working'),
    ];
    expect(() => sortByAttention(odd)).not.toThrow();
    expect(sortByAttention(odd)).toHaveLength(3);
  });
});

describe('the tiles and the address', () => {
  it('maps each tile to the filter of the address', () => {
    expect(attentionPatch('working')).toEqual({ state: [...ACTIVE_STATES], errors: false, attn: 'any' });
    expect(attentionPatch('needs')).toEqual({ state: ['waiting_input'], errors: false, attn: 'needs' });
    expect(attentionPatch('ready')).toEqual({ state: ['waiting_input'], errors: false, attn: 'ready' });
    expect(attentionPatch('errors')).toEqual({ state: [], errors: true, attn: 'any' });
    expect(attentionPatch('quiet')).toEqual({ state: ['running', 'working'], errors: false, attn: 'any' });
    expect(attentionPatch(null)).toEqual({ state: [], errors: false, attn: 'any' });
  });

  it('reads the tile back from the address, and null for any other filter', () => {
    for (const tile of ATTENTION_TILES) expect(attentionFilterOf(attentionPatch(tile)), tile).toBe(tile);
    expect(attentionFilterOf({ state: [], errors: false, attn: 'any' })).toBeNull();
    expect(attentionFilterOf({ state: ['failed'], errors: false, attn: 'any' })).toBeNull();
    expect(attentionFilterOf({ state: [...ACTIVE_STATES], errors: true, attn: 'any' })).toBeNull();
    expect(attentionFilterOf({ state: ['waiting_input', 'failed'], errors: false, attn: 'needs' })).toBeNull();
    // the state filter alone (also an address from before the two tiles) lists both halves and presses no tile
    expect(attentionFilterOf({ state: ['waiting_input'], errors: false, attn: 'any' })).toBeNull();
    expect(attentionFilterOf({ state: ['failed'], errors: false, attn: 'ready' })).toBeNull();
  });

  it('reads the tile from a bookmarked state=active address', () => {
    const v3 = { state: ['running', 'working', 'waiting_tool', 'waiting_agent'] as LifecycleState[], errors: false };
    expect(attentionFilterOf({ ...v3, attn: 'any' })).toBe('working');
  });
});
