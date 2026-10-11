import { R_MERGED } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { L_MERGED, isPlainObject, mergeLayer, type PlainObject } from './merge.ts';

function obj(value: unknown): PlainObject {
  if (!isPlainObject(value)) throw new Error('expected an object');
  return value;
}

describe('L_MERGED (legacy MERGED_DICTS)', () => {
  it('lists exactly panels, ui, poll and limits', () => {
    expect([...L_MERGED].sort()).toEqual(['limits', 'panels', 'poll', 'ui']);
  });
});

describe('isPlainObject', () => {
  it('accepts objects and rejects null, arrays and scalars', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe('mergeLayer with the legacy rule (C-3, 01 2.2)', () => {
  const base: PlainObject = {
    title: 'base',
    port: 8765,
    panels: { git: true, machine: true, logs: true },
    ui: { theme: 'auto', density: 'comfortable' },
    poll: { events_ms: 1500, sessions_ms: 6000 },
    limits: { max_events: 20000 },
    session_rules: [{ match: 'a' }],
    chain_log: null,
  };

  it('merges the four dict keys per sub-key', () => {
    const out = mergeLayer(base, { panels: { git: false }, poll: { events_ms: 900 } }, L_MERGED);
    expect(out['panels']).toEqual({ git: false, machine: true, logs: true });
    expect(out['poll']).toEqual({ events_ms: 900, sessions_ms: 6000 });
    expect(out['ui']).toEqual({ theme: 'auto', density: 'comfortable' });
  });

  it('adds a sub-key that the base does not have', () => {
    const out = mergeLayer(base, { limits: { custom: 7 } }, L_MERGED);
    expect(out['limits']).toEqual({ max_events: 20000, custom: 7 });
  });

  it('replaces lists, scalars and null instead of merging them', () => {
    const out = mergeLayer(base, { session_rules: [{ match: 'b' }], port: 9000, chain_log: 'x.log' }, L_MERGED);
    expect(out['session_rules']).toEqual([{ match: 'b' }]);
    expect(out['port']).toBe(9000);
    expect(out['chain_log']).toBe('x.log');
    expect(mergeLayer(base, { title: null }, L_MERGED)['title']).toBeNull();
  });

  it('replaces a merged key when either side is not an object', () => {
    expect(mergeLayer(base, { panels: null }, L_MERGED)['panels']).toBeNull();
    expect(mergeLayer(base, { panels: [1] }, L_MERGED)['panels']).toEqual([1]);
    expect(mergeLayer({ panels: 5 }, { panels: { git: true } }, L_MERGED)['panels']).toEqual({ git: true });
  });

  it('does not merge a dict that is not in the merged set', () => {
    const out = mergeLayer(
      { attempts: { start: 'a', end: 'b', label_prefix: 'x' } },
      { attempts: { start: 'c' } },
      L_MERGED,
    );
    expect(out['attempts']).toEqual({ start: 'c' });
  });

  it('skips keys that start with an underscore, in the override only', () => {
    const out = mergeLayer({ title: 't' }, { _comment: 'x', title: 'u', _other: { a: 1 } }, L_MERGED);
    expect(out).toEqual({ title: 'u' });
    expect(mergeLayer({ _kept: 1 }, {}, L_MERGED)).toEqual({ _kept: 1 });
  });

  it('does not skip an underscore sub-key inside a merged dict (legacy dict.update)', () => {
    const out = mergeLayer({ ui: { theme: 'auto' } }, { ui: { _x: true } }, L_MERGED);
    expect(out['ui']).toEqual({ theme: 'auto', _x: true });
  });

  it('never mutates its inputs and returns independent copies', () => {
    const b = structuredClone(base);
    const o: PlainObject = { panels: { git: false }, session_rules: [{ match: 'z' }] };
    const o0 = structuredClone(o);
    const out = mergeLayer(b, o, L_MERGED);
    expect(b).toEqual(base);
    expect(o).toEqual(o0);
    obj(out['panels'])['git'] = true;
    const rules = out['session_rules'];
    if (!Array.isArray(rules)) throw new Error('expected a list');
    rules[0] = { match: 'changed' };
    expect(o).toEqual(o0);
    expect(b).toEqual(base);
  });

  it('keeps the key order of the base, then new keys in override order', () => {
    const out = mergeLayer({ a: 1, b: 2 }, { c: 3, a: 9 }, L_MERGED);
    expect(Object.keys(out)).toEqual(['a', 'b', 'c']);
    expect(out['a']).toBe(9);
  });

  it('treats a top-level __proto__ as a comment key and stores a __proto__ sub-key as data, never touching the prototype', () => {
    const over = obj(JSON.parse('{"__proto__": {"polluted": true}, "panels": {"__proto__": {"x": 1}}}'));
    const out = mergeLayer({ panels: {} }, over, L_MERGED);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(obj({})['polluted']).toBeUndefined();
    expect(Object.hasOwn(out, '__proto__')).toBe(false);
    const panels = obj(out['panels']);
    expect(Object.getPrototypeOf(panels)).toBe(Object.prototype);
    expect(Object.hasOwn(panels, '__proto__')).toBe(true);
  });
});

describe('mergeLayer with the runtime rule (R_MERGED, one level deep)', () => {
  it('merges every runtime section per sub-key and replaces logLevel', () => {
    const base: PlainObject = { logLevel: 'info', server: { port: null, portScan: 19 }, backup: { keep: 5 } };
    const out = mergeLayer(base, { logLevel: 'debug', server: { portScan: 3 } }, R_MERGED);
    expect(out).toEqual({ logLevel: 'debug', server: { port: null, portScan: 3 }, backup: { keep: 5 } });
  });

  it('replaces a sub-key as a whole: alerts.rules does not merge below its first level', () => {
    const base: PlainObject = {
      alerts: { enabled: true, rules: { inactivity: { enabled: true, minutes: 30 }, import_lag: { enabled: true } } },
    };
    const out = mergeLayer(base, { alerts: { rules: { inactivity: { minutes: 5 } } } }, R_MERGED);
    expect(out['alerts']).toEqual({ enabled: true, rules: { inactivity: { minutes: 5 } } });
  });

  it('replaces arrays of a section (board.items, pricing.models)', () => {
    const out = mergeLayer({ board: { items: [{ key: 'a' }] } }, { board: { items: [] } }, R_MERGED);
    expect(out['board']).toEqual({ items: [] });
  });
});
