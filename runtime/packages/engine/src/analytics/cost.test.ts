// DA-T-A-4 (03 19.6, 8.3): the cost estimate of configured prices. No price ships (D15): without entries there is no estimate,
// the longest glob wins, `effectiveFrom` is read against the day of the message, an unpriced model is listed and left out, a
// missing 5m/1h split is priced at the 5m tier and says so.
import type { PricingModel } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import {
  COST_NOTE,
  estimateCost,
  literalLength,
  matchesModel,
  priceGroups,
  priceOf,
  resolvePrice,
  summarizeCost,
  type CostGroup,
} from './cost.ts';

/** A synthetic price list: every entry carries the neutral prices of its name, never a real price. */
function price(match: string, effectiveFrom: string, unit = 1): PricingModel {
  return {
    match,
    effectiveFrom,
    inputPerMTok: unit,
    outputPerMTok: unit * 5,
    cacheReadPerMTok: unit / 10,
    cacheWrite5mPerMTok: unit * 1.25,
    cacheWrite1hPerMTok: unit * 2,
  };
}

function group(over: Partial<CostGroup> & Pick<CostGroup, 'model'>): CostGroup {
  return {
    day: '2026-10-11',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    assumedTierMessages: 0,
    ...over,
  };
}

describe('matchesModel', () => {
  it.each([
    ['model-x', 'model-x', true],
    ['model-x', 'model-xy', false],
    ['model-*', 'model-x', true],
    ['model-*', 'model-', true],
    ['model-*', 'mode', false],
    ['*-x', 'model-x', true],
    ['*-x', 'model-xy', false],
    ['*', 'anything', true],
    ['a*b*c', 'aXXbYYc', true],
    ['a*b*c', 'aXXcYYb', false],
    ['a*b*c', 'abc', true],
    ['ab*bc', 'abc', false], // the literal ends overlap: the text is too short for both
    ['Model-*', 'model-x', false], // case-sensitive
    ['a.c*', 'abc', false], // a dot is a dot, not a wildcard
  ])('%s against %s is %s', (match, model, expected) => {
    expect(matchesModel(match, model)).toBe(expected);
  });

  it('counts the literal characters of a glob', () => {
    expect(literalLength('model-*')).toBe(6);
    expect(literalLength('*')).toBe(0);
    expect(literalLength('a*b*c')).toBe(3);
    expect(literalLength('exact')).toBe(5);
  });
});

describe('resolvePrice', () => {
  it('has no price without entries', () => {
    expect(resolvePrice([], 'model-x', '2026-10-11')).toBeUndefined();
  });

  it('prefers an exact id to any glob', () => {
    const entries = [price('model-*', '2026-01-01', 1), price('model-x', '2026-01-01', 2)];
    expect(resolvePrice(entries, 'model-x', '2026-10-11')?.inputPerMTok).toBe(2);
    expect(resolvePrice(entries, 'model-y', '2026-10-11')?.inputPerMTok).toBe(1);
  });

  it('prefers the glob with the most literal characters, whatever the order', () => {
    const entries = [
      price('*', '2026-01-01', 1),
      price('model-*', '2026-01-01', 2),
      price('model-x*', '2026-01-01', 3),
    ];
    expect(resolvePrice(entries, 'model-xy', '2026-10-11')?.inputPerMTok).toBe(3);
    expect(resolvePrice([...entries].reverse(), 'model-xy', '2026-10-11')?.inputPerMTok).toBe(3);
    expect(resolvePrice(entries, 'model-z', '2026-10-11')?.inputPerMTok).toBe(2);
    expect(resolvePrice(entries, 'other', '2026-10-11')?.inputPerMTok).toBe(1);
  });

  it('takes the first entry in file order when two globs of equal length match', () => {
    const tie = [price('abc*', '2026-01-01', 7), price('*xyz', '2026-01-01', 8)];
    expect(literalLength('abc*')).toBe(literalLength('*xyz'));
    expect(resolvePrice(tie, 'abc-xyz', '2026-10-11')?.inputPerMTok).toBe(7);
    expect(resolvePrice([...tie].reverse(), 'abc-xyz', '2026-10-11')?.inputPerMTok).toBe(8);
  });

  it('reads effectiveFrom against the day of the message: the latest entry in force wins', () => {
    const entries = [
      price('model-x', '2026-01-01', 1),
      price('model-x', '2026-06-01', 2),
      price('model-x', '2026-12-01', 3),
    ];
    expect(resolvePrice(entries, 'model-x', '2025-12-31')).toBeUndefined();
    expect(resolvePrice(entries, 'model-x', '2026-01-01')?.inputPerMTok).toBe(1);
    expect(resolvePrice(entries, 'model-x', '2026-05-31')?.inputPerMTok).toBe(1);
    expect(resolvePrice(entries, 'model-x', '2026-06-01')?.inputPerMTok).toBe(2);
    expect(resolvePrice(entries, 'model-x', '2026-11-30')?.inputPerMTok).toBe(2);
    expect(resolvePrice(entries, 'model-x', '2027-01-01')?.inputPerMTok).toBe(3);
  });

  it('ignores an entry that is not in force yet, even an exact one, and falls back to the glob that is', () => {
    const entries = [price('model-*', '2026-01-01', 1), price('model-x', '2026-12-01', 9)];
    expect(resolvePrice(entries, 'model-x', '2026-10-11')?.inputPerMTok).toBe(1);
    expect(resolvePrice([price('model-x', '2099-01-01')], 'model-x', '2026-10-11')).toBeUndefined();
  });
});

describe('priceOf and priceGroups', () => {
  const entries = [price('model-x', '2026-01-01', 1), price('model-y', '2026-01-01', 2)];

  it('prices (input x in + output x out + cache read x read + 5m x w5 + 1h x w1) / 1e6', () => {
    const g = group({
      model: 'model-x',
      input: 1_000_000,
      output: 2_000_000,
      cacheRead: 10_000_000,
      cacheWrite5m: 4_000_000,
      cacheWrite1h: 1_000_000,
    });
    // 1 + 2 x 5 + 10 x 0.1 + 4 x 1.25 + 1 x 2
    expect(priceOf(price('model-x', '2026-01-01', 1), g)).toBeCloseTo(1 + 10 + 1 + 5 + 2, 9);
  });

  it('sums the priced groups, lists a model without a price as unpriced and leaves its tokens out', () => {
    const totals = priceGroups(entries, [
      group({ model: 'model-x', input: 1_000_000 }),
      group({ model: 'model-y', output: 1_000_000 }),
      group({ model: 'model-other', input: 3_000_000 }),
    ]);
    expect(totals.amount).toBeCloseTo(1 + 2 * 5, 9);
    expect(totals.pricedModels).toEqual(['model-x', 'model-y']);
    expect(totals.unpricedModels).toEqual(['model-other']);
    expect(totals.pricedTokens).toBe(2_000_000);
    expect(totals.totalTokens).toBe(5_000_000);
  });

  it('prices a model by the day of its messages', () => {
    const dated = [price('model-x', '2026-10-11', 1)];
    const totals = priceGroups(dated, [
      group({ model: 'model-x', day: '2026-10-10', input: 1_000_000 }),
      group({ model: 'model-x', day: '2026-10-11', input: 1_000_000 }),
    ]);
    expect(totals.amount).toBeCloseTo(1, 9);
    expect(totals.pricedTokens).toBe(1_000_000);
    expect(totals.unpricedModels).toEqual(['model-x']); // unpriced on the first day
    expect(totals.pricedModels).toEqual(['model-x']);
  });

  it('ignores a group without a token: nothing to price, nothing to list', () => {
    const totals = priceGroups(entries, [group({ model: 'model-none' })]);
    expect(totals).toMatchObject({ amount: 0, totalTokens: 0, unpricedModels: [], pricedModels: [] });
  });

  it('flags the assumed cache write tier only for a priced group', () => {
    const assumed = priceGroups(entries, [group({ model: 'model-x', cacheWrite5m: 10, assumedTierMessages: 1 })]);
    expect(assumed.assumedCacheWriteTier).toBe(true);
    const unpriced = priceGroups(entries, [group({ model: 'nobody', cacheWrite5m: 10, assumedTierMessages: 1 })]);
    expect(unpriced.assumedCacheWriteTier).toBe(false);
  });
});

describe('summarizeCost and estimateCost', () => {
  const entries = [price('model-x', '2026-01-01', 1)];

  it('is null without configured prices, however much was used (no default table, never 0)', () => {
    const groups = [group({ model: 'model-x', input: 5_000_000 })];
    expect(summarizeCost([], 'USD', groups)).toBeNull();
    expect(estimateCost([], 'USD', groups)).toBeNull();
  });

  it('is null when no token was counted: an estimate of nothing is no estimate', () => {
    expect(summarizeCost(entries, 'USD', [])).toBeNull();
    expect(summarizeCost(entries, 'USD', [group({ model: 'model-x' })])).toBeNull();
    expect(estimateCost(entries, 'USD', [])).toBeNull();
  });

  it('labels the figure as an estimate of configured prices, with the note and the unpriced share', () => {
    const summary = summarizeCost(entries, 'EUR', [
      group({ model: 'model-x', input: 3_000_000 }),
      group({ model: 'model-q', input: 1_000_000 }),
    ]);
    expect(summary).toEqual({
      currency: 'EUR',
      basis: 'estimate',
      source: 'configured_prices',
      amount: 3,
      pricedTokensPct: 75,
      pricedModels: ['model-x'],
      unpricedModels: ['model-q'],
      assumedCacheWriteTier: false,
      note: COST_NOTE,
    });
    expect(COST_NOTE).toBe('Estimate from prices configured in runtime.json; not a bill.');
    expect(estimateCost(entries, 'EUR', [group({ model: 'model-x', input: 3_000_000 })])).toEqual({
      amount: 3,
      currency: 'EUR',
      basis: 'estimate',
      pricedTokensPct: 100,
      unpricedModels: [],
    });
  });

  it('reports 0 percent priced and an amount of 0 when no model has a price', () => {
    const summary = summarizeCost(entries, 'USD', [group({ model: 'model-q', input: 10 })]);
    expect(summary).toMatchObject({ amount: 0, pricedTokensPct: 0, pricedModels: [], unpricedModels: ['model-q'] });
  });
});
