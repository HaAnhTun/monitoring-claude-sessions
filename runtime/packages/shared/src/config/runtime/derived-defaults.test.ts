/// <reference types="node" />
// Data part only (plan WP-02, P-1): the behavioural cases of 01 1.6 (CONFIG_INVALID messages, provenance, an explicit
// runtime value winning over the derivation) need `resolveConfig` and are tested in WP-12.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  R_DERIVED_DEFAULTS,
  R_KEY_CATALOGUE,
  RuntimeFileSchema,
  RuntimeOverridesSchema,
  applyDerivedMap,
} from './index.ts';

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return Object.fromEntries(Object.entries(value));
}

const defaultsPath = fileURLToPath(
  new URL('../../../../../../skills/monitoring-claude-sessions/config/defaults.json', import.meta.url),
);
const LEGACY = asRecord(JSON.parse(readFileSync(defaultsPath, 'utf8')));

function legacyValue(path: string): unknown {
  let cur: unknown = LEGACY;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = asRecord(cur)[part];
  }
  return cur;
}

function runtimeDefault(key: string): unknown {
  let cur: unknown = RuntimeFileSchema.parse({ schema_version: 1 });
  for (const part of key.split('.')) cur = asRecord(cur)[part];
  return cur;
}

describe('R_DERIVED_DEFAULTS (data)', () => {
  it('lists exactly the five keys of 01 1.6, in order', () => {
    expect(Object.keys(R_DERIVED_DEFAULTS)).toEqual([
      'lifecycle.activeSeconds',
      'lifecycle.pendingToolGraceSeconds',
      'import.lookbackHours',
      'import.tailWindowBytes',
      'import.backfillMaxBytes',
    ]);
    expect(R_DERIVED_DEFAULTS).toEqual({
      'lifecycle.activeSeconds': { from: 'active_seconds', map: 'identity' },
      'lifecycle.pendingToolGraceSeconds': { from: 'pending_tool_grace_seconds', map: 'identity' },
      'import.lookbackHours': { from: 'window_hours', map: 'identity' },
      'import.tailWindowBytes': { from: 'limits.event_window_mb', map: 'mib-to-bytes' },
      'import.backfillMaxBytes': { from: 'limits.usage_max_mb', map: 'mib-to-bytes' },
    });
  });

  it('names an existing R key and an existing numeric L key with a known map', () => {
    const catalogueKeys = new Set(R_KEY_CATALOGUE.map((e) => e.key));
    for (const [key, derived] of Object.entries(R_DERIVED_DEFAULTS)) {
      expect(catalogueKeys.has(key), `${key} in the catalogue`).toBe(true);
      expect(['identity', 'mib-to-bytes'], key).toContain(derived.map);
      expect(typeof legacyValue(derived.from), `${derived.from} in config/defaults.json`).toBe('number');
    }
  });

  it('the Zod default of every derived key is null, and the override schema accepts null', () => {
    for (const key of Object.keys(R_DERIVED_DEFAULTS)) {
      expect(runtimeDefault(key), key).toBeNull();
      const [section, name] = key.split('.');
      expect(
        RuntimeOverridesSchema.safeParse({ schema_version: 1, [String(section)]: { [String(name)]: null } }).success,
      ).toBe(true);
    }
  });

  it('no other key has a null default except the documented nullable ones', () => {
    const nullDefaults = R_KEY_CATALOGUE.filter((e) => e.default === null).map((e) => e.key);
    expect(nullDefaults.sort()).toEqual(['retention.eventsDays', 'retention.sessionsDays', 'server.port']);
  });

  it('the catalogue default of a derived key is the value derived from the shipped defaults', () => {
    const expected = {
      'lifecycle.activeSeconds': 120,
      'lifecycle.pendingToolGraceSeconds': 900,
      'import.lookbackHours': 8,
      'import.tailWindowBytes': 8 * 1_048_576,
      'import.backfillMaxBytes': 512 * 1_048_576,
    };
    for (const [key, derived] of Object.entries(R_DERIVED_DEFAULTS)) {
      const from = legacyValue(derived.from);
      if (typeof from !== 'number') throw new Error(derived.from);
      const value = applyDerivedMap(derived.map, from);
      expect(value, key).toBe(expected[key as keyof typeof expected]);
      expect(R_KEY_CATALOGUE.find((e) => e.key === key)?.default, key).toBe(value);
    }
  });
});

describe('applyDerivedMap', () => {
  it('identity returns the value unchanged', () => {
    expect(applyDerivedMap('identity', 1.5)).toBe(1.5);
    expect(applyDerivedMap('identity', 8)).toBe(8);
  });

  it('mib-to-bytes is Math.floor(v * 1048576)', () => {
    expect(applyDerivedMap('mib-to-bytes', 2)).toBe(2_097_152);
    expect(applyDerivedMap('mib-to-bytes', 0.5)).toBe(524_288);
    expect(applyDerivedMap('mib-to-bytes', 1.0000001)).toBe(1_048_576);
    expect(applyDerivedMap('mib-to-bytes', 0)).toBe(0);
  });
});

describe('derived values are validated by the key schema (the data behind CONFIG_INVALID)', () => {
  const accepts = (key: string, value: unknown) => {
    const [section, name] = key.split('.');
    return RuntimeOverridesSchema.safeParse({ schema_version: 1, [String(section)]: { [String(name)]: value } })
      .success;
  };

  it('event_window_mb 2 gives an accepted 2097152; 0.5 gives 524288, below 1 MiB, refused', () => {
    expect(accepts('import.tailWindowBytes', applyDerivedMap('mib-to-bytes', 2))).toBe(true);
    expect(accepts('import.tailWindowBytes', applyDerivedMap('mib-to-bytes', 0.5))).toBe(false);
  });

  it('window_hours 1.5 is not an integer and is refused; 8 is accepted', () => {
    expect(accepts('import.lookbackHours', applyDerivedMap('identity', 1.5))).toBe(false);
    expect(accepts('import.lookbackHours', applyDerivedMap('identity', 8))).toBe(true);
  });

  it('usage_max_mb 0 gives 0 bytes, which the backfill bound allows', () => {
    expect(accepts('import.backfillMaxBytes', applyDerivedMap('mib-to-bytes', 0))).toBe(true);
  });
});
