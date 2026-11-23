// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { hasDwelled, isSeenMap, isUnseen, markSeen, SEEN_DWELL_MS, SEEN_MAX, type SeenMap } from './attention-seen.ts';

const at = (second: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

describe('the seen model', () => {
  it.each<[string, SeenMap, string, string | null, boolean]>([
    ['an id that was never seen', {}, 'a', at(1), true],
    ['a state later than the mark', { a: at(1) }, 'a', at(2), true],
    ['the marked state itself', { a: at(2) }, 'a', at(2), false],
    ['a state older than the mark', { a: at(2) }, 'a', at(1), false],
    ['a state without a time', { a: at(2) }, 'a', null, true],
    ['a name of the prototype', {}, 'constructor', at(1), true],
  ])('isUnseen: %s', (_title, seen, id, since, expected) => {
    expect(isUnseen(seen, id, since)).toBe(expected);
  });

  it('markSeen records the newer time and gives the same map back when nothing changes', () => {
    const seen: SeenMap = { a: at(5) };
    expect(markSeen(seen, 'a', at(6))).toEqual({ a: at(6) });
    expect(markSeen(seen, 'b', at(1))).toEqual({ a: at(5), b: at(1) });
    for (const [id, since] of [
      ['a', at(5)],
      ['a', at(4)],
      ['a', null],
      ['__proto__', at(9)],
      ['has space', at(9)],
      ['b', 'yesterday'],
    ] as const) {
      expect(markSeen(seen, id, since), `${id} ${String(since)}`).toBe(seen);
    }
  });

  it('keeps the 64 newest times', () => {
    let seen: SeenMap = {};
    for (let n = 0; n < SEEN_MAX + 6; n += 1) seen = markSeen(seen, `id-${String(n)}`, at(n));
    expect(Object.keys(seen)).toHaveLength(SEEN_MAX);
    expect(seen['id-5']).toBeUndefined();
    expect(seen['id-6']).toBe(at(6));
    expect(isSeenMap(seen)).toBe(true);
  });

  it('the validator takes ids and ISO times only, at most 64 of them', () => {
    expect(isSeenMap({})).toBe(true);
    expect(isSeenMap({ 'a.b:c-d_e': at(1) })).toBe(true);
    const many = Object.fromEntries(Array.from({ length: SEEN_MAX + 1 }, (_, n) => [`id-${String(n)}`, at(1)]));
    const bad: unknown[] = [
      null,
      'x',
      [at(1)],
      many,
      { a: 5 },
      { a: 'FIXTURE label' },
      { a: `${at(1)}${'0'.repeat(12)}` },
      { 'a b': at(1) },
      { ['x'.repeat(65)]: at(1) },
      JSON.parse(`{"__proto__": "${at(1)}"}`),
      { constructor: at(1) },
    ];
    for (const value of bad) expect(isSeenMap(value), JSON.stringify(value)).toBe(false);
  });

  it('a row is viewed after one second of the injected clock', () => {
    expect(SEEN_DWELL_MS).toBe(1000);
    expect(hasDwelled(null, 5000)).toBe(false);
    expect(hasDwelled(4001, 5000)).toBe(false);
    expect(hasDwelled(4000, 5000)).toBe(true);
  });
});
