import { R_KEY_CATALOGUE, R_MERGED, RuntimeFileSchema } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { L_MERGED, mergeLayer, type PlainObject } from './merge.ts';
import { leafPaths, legacyProvenance, runtimeProvenance, type RuntimeLayer } from './provenance.ts';

describe('leafPaths', () => {
  it('lists scalar, null and array leaves of nested objects with dotted paths', () => {
    expect(leafPaths({ a: 1, b: { c: null, d: [1, 2], e: { f: 'x' } } }, '')).toEqual(['a', 'b.c', 'b.d', 'b.e.f']);
  });

  it('uses the prefix, and a scalar at the prefix is one leaf', () => {
    expect(leafPaths({ x: 1 }, 'p')).toEqual(['p.x']);
    expect(leafPaths(5, 'p')).toEqual(['p']);
    expect(leafPaths([], 'p')).toEqual(['p']);
    expect(leafPaths(null, 'p')).toEqual(['p']);
  });

  it('an empty object has no leaf', () => {
    expect(leafPaths({}, 'p')).toEqual([]);
    expect(leafPaths({ a: {} }, '')).toEqual([]);
  });
});

describe('legacyProvenance (01 2.5 rules 1 and 2)', () => {
  const defaults: PlainObject = {
    title: 'd',
    port: 8765,
    panels: { git: true, machine: true },
    ui: { theme: 'auto' },
    poll: { events_ms: 1 },
    limits: { max_events: 2 },
    session_rules: [],
  };

  it('tags a default key skill and a key that config.json sets config', () => {
    const prov = legacyProvenance(defaults, { title: 'x' });
    expect(prov['title']).toBe('config');
    expect(prov['port']).toBe('skill');
    expect(prov['session_rules']).toBe('skill');
  });

  it('gives merged dict keys one entry per default sub-key and no entry for the dict itself', () => {
    const prov = legacyProvenance(defaults, { panels: { git: false }, ui: { theme: 'dark' } });
    expect(prov['panels.git']).toBe('config');
    expect(prov['panels.machine']).toBe('skill');
    expect(prov['ui.theme']).toBe('config');
    expect(prov['poll.events_ms']).toBe('skill');
    expect(prov['limits.max_events']).toBe('skill');
    expect(Object.keys(prov).filter((k) => ['panels', 'ui', 'poll', 'limits'].includes(k))).toEqual([]);
  });

  it('tags a key that is in config.json but not in the defaults config, and ignores underscore keys', () => {
    const prov = legacyProvenance(defaults, { extra: 1, _comment: 'x' });
    expect(prov['extra']).toBe('config');
    expect(prov).not.toHaveProperty('_comment');
  });

  it('does not list a sub-key that only config.json has (legacy behaviour)', () => {
    const prov = legacyProvenance(defaults, { poll: { custom_ms: 5 } });
    expect(prov).not.toHaveProperty(['poll.custom_ms']);
    expect(prov['poll.events_ms']).toBe('skill');
  });

  it('treats a merged key whose override is not an object as setting no sub-key', () => {
    expect(legacyProvenance(defaults, { panels: null })['panels.git']).toBe('skill');
  });

  it('the key set equals the legacy provenance(): defaults (sub-keys for merged dicts) plus override-only top keys', () => {
    const prov = legacyProvenance(defaults, { zzz: 1 });
    expect(Object.keys(prov)).toEqual([
      'title',
      'port',
      'panels.git',
      'panels.machine',
      'ui.theme',
      'poll.events_ms',
      'limits.max_events',
      'session_rules',
      'zzz',
    ]);
  });
});

/** Merges the layers the way `resolveConfig` does and parses the result, so a test sees the final configuration. */
function finalOf(layers: readonly RuntimeLayer[]): unknown {
  let merged: PlainObject = {};
  for (const l of layers) merged = mergeLayer(merged, l.overrides, R_MERGED);
  const parsed = RuntimeFileSchema.parse({ schema_version: 1, ...merged });
  const { schema_version: marker, ...runtime } = parsed;
  expect(marker).toBe(1);
  return runtime;
}

describe('runtimeProvenance (01 2.5 rule 3)', () => {
  it('tags every leaf of the final configuration builtin when no layer sets anything', () => {
    const prov = runtimeProvenance([], finalOf([]));
    expect(new Set(Object.values(prov))).toEqual(new Set(['builtin']));
    expect(prov['server.port']).toBe('builtin');
    expect(prov['logLevel']).toBe('builtin');
    expect(prov['alerts.rules.inactivity.minutes']).toBe('builtin');
    expect(prov['board.items']).toBe('builtin');
  });

  it('covers every leaf of the catalogue (an alerts rule is covered through its parameters)', () => {
    const prov = runtimeProvenance([], finalOf([]));
    for (const entry of R_KEY_CATALOGUE) {
      const covered = entry.key in prov || Object.keys(prov).some((k) => k.startsWith(`${entry.key}.`));
      expect(covered, entry.key).toBe(true);
    }
  });

  it('records the highest layer that set each leaf: cli over env over runtime over skill over builtin', () => {
    const layers: RuntimeLayer[] = [
      {
        source: 'skill',
        overrides: { server: { portScan: 3, requestTimeoutMs: 5000 }, backup: { keep: 2 }, logLevel: 'warn' },
      },
      { source: 'runtime', overrides: { server: { portScan: 4 }, logLevel: 'info' } },
      { source: 'env', overrides: { logLevel: 'debug' } },
      { source: 'cli', overrides: { logLevel: 'error' } },
    ];
    const prov = runtimeProvenance(layers, finalOf(layers));
    expect(prov['server.portScan']).toBe('runtime');
    expect(prov['server.requestTimeoutMs']).toBe('skill');
    expect(prov['server.shutdownGraceMs']).toBe('builtin');
    expect(prov['backup.keep']).toBe('skill');
    expect(prov['logLevel']).toBe('cli');
  });

  it('tags env when env is the highest layer that set logLevel', () => {
    const layers: RuntimeLayer[] = [
      { source: 'runtime', overrides: { logLevel: 'info' } },
      { source: 'env', overrides: { logLevel: 'debug' } },
    ];
    expect(runtimeProvenance(layers, finalOf(layers))['logLevel']).toBe('env');
  });

  it('tags an array leaf as a whole', () => {
    const layers: RuntimeLayer[] = [
      { source: 'runtime', overrides: { board: { items: [{ key: 'a', title: 'A', match: {} }] } } },
    ];
    const prov = runtimeProvenance(layers, finalOf(layers));
    expect(prov['board.items']).toBe('runtime');
    expect(Object.keys(prov).filter((k) => k.startsWith('board.items.'))).toEqual([]);
  });

  it('tags the parameters an alert rule override sets, and the schema-completed ones builtin', () => {
    const layers: RuntimeLayer[] = [
      { source: 'runtime', overrides: { alerts: { rules: { inactivity: { minutes: 5 } } } } },
    ];
    const prov = runtimeProvenance(layers, finalOf(layers));
    expect(prov['alerts.rules.inactivity.minutes']).toBe('runtime');
    expect(prov['alerts.rules.inactivity.enabled']).toBe('builtin');
    expect(prov['alerts.rules.import_lag.enabled']).toBe('builtin');
    expect(prov['alerts.enabled']).toBe('builtin');
  });

  it('a later layer that replaces alerts.rules resets what an earlier layer set below it (merge is one level deep)', () => {
    const layers: RuntimeLayer[] = [
      { source: 'skill', overrides: { alerts: { rules: { inactivity: { minutes: 5 } } } } },
      { source: 'runtime', overrides: { alerts: { rules: { import_lag: { cooldownMinutes: 3 } } } } },
    ];
    const prov = runtimeProvenance(layers, finalOf(layers));
    expect(prov['alerts.rules.import_lag.cooldownMinutes']).toBe('runtime');
    expect(prov['alerts.rules.inactivity.minutes']).toBe('builtin');
  });

  it('a derived key takes the source it is given, even when a layer set it to null', () => {
    const layers: RuntimeLayer[] = [{ source: 'runtime', overrides: { import: { lookbackHours: null } } }];
    const prov = runtimeProvenance(layers, finalOf(layers), { 'import.lookbackHours': 'config' });
    expect(prov['import.lookbackHours']).toBe('config');
    expect(prov['import.tailWindowBytes']).toBe('builtin');
  });

  it('an explicit value for a derived key keeps its layer', () => {
    const layers: RuntimeLayer[] = [{ source: 'runtime', overrides: { import: { tailWindowBytes: 2097152 } } }];
    expect(runtimeProvenance(layers, finalOf(layers))['import.tailWindowBytes']).toBe('runtime');
  });

  it('does not use the L merge set for the runtime sections', () => {
    expect(L_MERGED.has('server')).toBe(false);
  });
});
