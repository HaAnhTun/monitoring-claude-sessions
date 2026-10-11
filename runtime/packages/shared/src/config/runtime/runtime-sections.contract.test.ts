/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AlertsSectionKeys } from './alerts.ts';
import {
  R_DERIVED_DEFAULTS,
  R_KEY_CATALOGUE,
  R_MERGED,
  R_TOP_KEYS,
  RuntimeFileSchema,
  RuntimeOverridesSchema,
  applyDerivedMap,
} from './index.ts';

const SKILL = new URL('../../../../../../', import.meta.url);

function readText(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, SKILL)), 'utf8');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return Object.fromEntries(Object.entries(value));
}

/** The 22 legacy keys: every non-comment key of the shipped defaults (`schema_version` is shared by both files). */
const LEGACY_DEFAULTS = asRecord(JSON.parse(readText('config/defaults.json')));
const L_KEYS = Object.keys(LEGACY_DEFAULTS).filter((k) => !k.startsWith('_'));

/** Dotted catalogue path -> value of the parsed default; `alerts.rules.<id>` is one leaf (a whole rule object). */
function leaves(value: unknown, prefix: string, depth: number, out: Map<string, unknown>): void {
  const stopAt = prefix.startsWith('alerts.rules') ? 3 : 2;
  if (depth >= stopAt || typeof value !== 'object' || value === null || Array.isArray(value)) {
    out.set(prefix, value);
    return;
  }
  for (const [k, v] of Object.entries(value)) leaves(v, `${prefix}.${k}`, depth + 1, out);
}

function parsedDefaultLeaves(): Map<string, unknown> {
  const parsed = asRecord(RuntimeFileSchema.parse({ schema_version: 1 }));
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(parsed)) {
    if (k === 'schema_version') continue;
    if (k === 'logLevel') out.set(k, v);
    else leaves(v, k, 1, out);
  }
  return out;
}

function dotted(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = asRecord(cur)[part];
  }
  return cur;
}

/** Builds `{section: {key: value}}` (or `{logLevel: value}`) for an override file from a catalogue path. */
function overrideFile(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  const file: Record<string, unknown> = { schema_version: 1 };
  let cur = file;
  parts.forEach((part, i) => {
    if (i === parts.length - 1) cur[part] = value;
    else {
      const next: Record<string, unknown> = {};
      cur[part] = next;
      cur = next;
    }
  });
  return file;
}

const accepts = (path: string, value: unknown) => RuntimeOverridesSchema.safeParse(overrideFile(path, value)).success;

const SECTION_NAMES = R_TOP_KEYS.filter((k) => k !== 'logLevel');

describe('runtime.json sections: composition', () => {
  it('R_TOP_KEYS is the registry list in order, and R_MERGED holds every section but logLevel', () => {
    expect([...R_TOP_KEYS]).toEqual([
      'logLevel',
      'server',
      'process',
      'backup',
      'lifecycle',
      'hooks',
      'ingest',
      'import',
      'spool',
      'health',
      'analytics',
      'board',
      'panelOptions',
      'retention',
      'alerts',
      'pricing',
    ]);
    expect([...R_MERGED].sort()).toEqual([...SECTION_NAMES].sort());
  });

  it('(5) R_TOP_KEYS is disjoint from the 22 legacy keys', () => {
    expect(L_KEYS).toHaveLength(22);
    for (const key of R_TOP_KEYS) expect(L_KEYS, key).not.toContain(key);
  });

  it('(1) the parsed default plus the derived defaults equals the catalogue default column', () => {
    const parsed = parsedDefaultLeaves();
    for (const [key, derived] of Object.entries(R_DERIVED_DEFAULTS)) {
      expect(parsed.get(key), `${key} must default to null before derivation`).toBeNull();
      const from = dotted(LEGACY_DEFAULTS, derived.from);
      expect(typeof from, `${derived.from} in config/defaults.json`).toBe('number');
      if (typeof from === 'number') parsed.set(key, applyDerivedMap(derived.map, from));
    }
    expect(Object.fromEntries(parsed)).toEqual(Object.fromEntries(R_KEY_CATALOGUE.map((e) => [e.key, e.default])));
  });

  it('(3) the leaf key set of the parsed default equals the catalogue key set', () => {
    expect([...parsedDefaultLeaves().keys()].sort()).toEqual(R_KEY_CATALOGUE.map((e) => e.key).sort());
    expect(new Set(R_KEY_CATALOGUE.map((e) => e.key)).size).toBe(R_KEY_CATALOGUE.length);
  });

  it('(3) import.maxLineBytes does not exist (I-32, C01): the line cap is a constant', () => {
    expect(R_KEY_CATALOGUE.some((e) => e.key.endsWith('maxLineBytes'))).toBe(false);
    expect(accepts('import.maxLineBytes', 1_048_576)).toBe(false);
    expect(accepts('import.headMaxBytes', 1_048_576)).toBe(true);
  });

  it('counts the keys of the 02 sections as the registry does', () => {
    const count = (section: string) => R_KEY_CATALOGUE.filter((e) => e.key.startsWith(`${section}.`)).length;
    expect(count('lifecycle')).toBe(12);
    expect(count('hooks')).toBe(1);
    expect(count('ingest')).toBe(2);
    expect(count('import')).toBe(9);
    expect(count('spool')).toBe(3);
    expect(count('health')).toBe(2);
    expect(count('analytics')).toBe(1);
  });

  it('records a valid owner and reference for every key', () => {
    for (const e of R_KEY_CATALOGUE) {
      expect(['01', '02', '03', '06'], e.key).toContain(e.owner);
      expect(e.ref, e.key).toMatch(/^0[1-6] \d+(\.\d+)*$/);
      expect(
        e.key.split('.').some((part) => part.startsWith('_')),
        e.key,
      ).toBe(false);
    }
    expect(R_KEY_CATALOGUE.find((e) => e.key === 'panelOptions.attemptsWindowHours')?.owner).toBe('06');
    expect(R_KEY_CATALOGUE.find((e) => e.key === 'spool.pollMs')?.owner).toBe('02');
    expect(R_KEY_CATALOGUE.find((e) => e.key === 'retention.changesMaxRows')?.owner).toBe('03');
    expect(R_KEY_CATALOGUE.find((e) => e.key === 'server.port')?.owner).toBe('01');
  });
});

describe('runtime.json sections: overrides schema', () => {
  it('(2) every catalogue key parses through RuntimeOverridesSchema with its sample and keeps it', () => {
    for (const e of R_KEY_CATALOGUE) {
      const r = RuntimeOverridesSchema.safeParse(overrideFile(e.key, e.sample));
      expect(r.success, `${e.key}: ${r.success ? '' : r.error.message}`).toBe(true);
      if (r.success) expect(dotted(asRecord(r.data), e.key), e.key).toEqual(e.sample);
    }
  });

  it('(2) the sample differs from the default so the test proves something', () => {
    for (const e of R_KEY_CATALOGUE) expect(e.sample, e.key).not.toEqual(e.default);
  });

  it('accepts a file with only schema_version and injects no defaults', () => {
    expect(RuntimeOverridesSchema.parse({ schema_version: 1 })).toEqual({ schema_version: 1 });
    expect(RuntimeOverridesSchema.parse({ schema_version: 1, spool: {} })).toEqual({ schema_version: 1, spool: {} });
    expect(RuntimeOverridesSchema.parse({ schema_version: 1, spool: { pollMs: 250 } })).toEqual({
      schema_version: 1,
      spool: { pollMs: 250 },
    });
  });

  it('a partial alert rule override stays partial (no injected sibling defaults)', () => {
    const file = { schema_version: 1, alerts: { rules: { inactivity: { minutes: 5 } } } };
    expect(RuntimeOverridesSchema.parse(file)).toEqual(file);
  });

  it('requires schema_version 1', () => {
    expect(RuntimeOverridesSchema.safeParse({}).success).toBe(false);
    expect(RuntimeOverridesSchema.safeParse({ schema_version: 2 }).success).toBe(false);
  });

  it('(4) rejects one misspelled key per section with unrecognized_keys', () => {
    for (const section of SECTION_NAMES) {
      const r = RuntimeOverridesSchema.safeParse({ schema_version: 1, [section]: { notAKey: 1 } });
      expect(r.success, section).toBe(false);
      expect(
        r.error?.issues.some((i) => i.code === 'unrecognized_keys' && i.path[0] === section),
        section,
      ).toBe(true);
    }
  });

  it('(4) rejects an unknown section and an unknown top-level key', () => {
    const r = RuntimeOverridesSchema.safeParse({ schema_version: 1, servers: {} });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.code).toBe('unrecognized_keys');
    expect(RuntimeOverridesSchema.safeParse({ schema_version: 1, port: 8765 }).success).toBe(false);
  });

  it('(4) rejects an unknown alert rule and an unknown rule key', () => {
    expect(accepts('alerts.rules', { nope: { enabled: true } })).toBe(false);
    expect(accepts('alerts.rules', { inactivity: { minutez: 5 } })).toBe(false);
  });

  it('(8) range edges of the 02 keys', () => {
    expect(accepts('spool.pollMs', 99)).toBe(false);
    expect(accepts('spool.pollMs', 100)).toBe(true);
    expect(accepts('spool.pollMs', 10_000)).toBe(true);
    expect(accepts('spool.pollMs', 10_001)).toBe(false);
    expect(accepts('hooks.spoolWhileStoppedHours', 0)).toBe(true);
    expect(accepts('hooks.spoolWhileStoppedHours', -1)).toBe(false);
    expect(accepts('hooks.spoolWhileStoppedHours', 720)).toBe(true);
    expect(accepts('hooks.spoolWhileStoppedHours', 721)).toBe(false);
    expect(accepts('import.lookbackHours', 1.5)).toBe(false);
    expect(accepts('import.lookbackHours', 1)).toBe(true);
    expect(accepts('import.lookbackHours', null)).toBe(true);
    expect(accepts('import.tailWindowBytes', 1_048_575)).toBe(false);
    expect(accepts('import.backfillMaxBytes', 0)).toBe(true);
  });

  it('rejects wrong types, NaN-like and unsafe numbers', () => {
    expect(accepts('spool.pollMs', '500')).toBe(false);
    expect(accepts('spool.pollMs', Number.NaN)).toBe(false);
    expect(accepts('spool.pollMs', Number.POSITIVE_INFINITY)).toBe(false);
    expect(accepts('analytics.usageTrend', 'true')).toBe(false);
    expect(accepts('logLevel', 'trace')).toBe(false);
    expect(accepts('logLevel', 'debug')).toBe(true);
  });
});

describe('runtime.json sections: merged schema', () => {
  it('RuntimeFileSchema.parse({schema_version: 1}) returns every default', () => {
    const parsed = asRecord(RuntimeFileSchema.parse({ schema_version: 1 }));
    expect(parsed['logLevel']).toBe('info');
    for (const section of SECTION_NAMES) expect(typeof parsed[section], section).toBe('object');
    expect(dotted(parsed, 'spool.pollMs')).toBe(500);
    expect(dotted(parsed, 'board.items')).toEqual([]);
    expect(dotted(parsed, 'pricing.models')).toEqual([]);
    expect(dotted(parsed, 'pricing.currency')).toBe('USD');
  });

  it('completes a partial section and a partial alert rule', () => {
    const merged = asRecord(
      RuntimeFileSchema.parse({
        schema_version: 1,
        spool: { pollMs: 250 },
        alerts: { rules: { inactivity: { minutes: 5 } } },
      }),
    );
    expect(dotted(merged, 'spool.pollMs')).toBe(250);
    expect(dotted(merged, 'spool.sealGraceMs')).toBe(120_000);
    expect(dotted(merged, 'alerts.rules.inactivity')).toEqual({ enabled: true, minutes: 5, cooldownMinutes: 10 });
    expect(dotted(merged, 'alerts.rules.hook_gap')).toEqual({ enabled: true, cooldownMinutes: 30 });
  });

  it('does not share default arrays between parses', () => {
    const a = asRecord(RuntimeFileSchema.parse({ schema_version: 1 }));
    const items = dotted(a, 'board.items');
    expect(Array.isArray(items)).toBe(true);
    if (Array.isArray(items)) items.push('x');
    expect(dotted(asRecord(RuntimeFileSchema.parse({ schema_version: 1 })), 'board.items')).toEqual([]);
  });

  it('does not share nested defaults between parses, the key table or the catalogue', () => {
    // Reflect keeps the references (asRecord copies one level, which would hide the shared object).
    const a = RuntimeFileSchema.parse({ schema_version: 1 });
    const rules: unknown = Reflect.get(Reflect.get(a, 'alerts'), 'rules');
    Reflect.set(Reflect.get(Object(rules), 'inactivity'), 'minutes', 999);
    Reflect.set(Reflect.get(Object(rules), 'token_threshold'), 'tokens', 12345);
    const b = asRecord(RuntimeFileSchema.parse({ schema_version: 1 }));
    expect(dotted(b, 'alerts.rules.inactivity.minutes')).toBe(30);
    expect(dotted(b, 'alerts.rules.token_threshold.tokens')).toBeNull();
    expect(AlertsSectionKeys.rules.default.inactivity.minutes).toBe(30);
    expect(AlertsSectionKeys.rules.default.token_threshold.tokens).toBeNull();
    const inactivity = R_KEY_CATALOGUE.find((e) => e.key === 'alerts.rules.inactivity')?.default;
    const threshold = R_KEY_CATALOGUE.find((e) => e.key === 'alerts.rules.token_threshold')?.default;
    expect(asRecord(inactivity)['minutes']).toBe(30);
    expect(asRecord(threshold)['tokens']).toBeNull();
  });

  it('is strict at every level', () => {
    expect(RuntimeFileSchema.safeParse({ schema_version: 1, spool: { x: 1 } }).success).toBe(false);
    expect(RuntimeFileSchema.safeParse({ schema_version: 1, extra: 1 }).success).toBe(false);
  });

  it('validates the board and pricing item shapes', () => {
    const item = {
      key: 'release',
      title: 'Release',
      match: { labels: ['a'], labelPrefix: 'rel-', sessionIds: ['s1'], attemptParts: ['p1'] },
    };
    expect(accepts('board.items', [item])).toBe(true);
    expect(accepts('board.items', [{ ...item, match: { unknown: [] } }])).toBe(false);
    expect(accepts('board.items', [{ key: 'k', title: 't' }])).toBe(false);
    const price = {
      match: 'claude-*',
      effectiveFrom: '2026-01-01',
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWrite5mPerMTok: 1.25,
      cacheWrite1hPerMTok: 2,
    };
    expect(accepts('pricing.models', [price])).toBe(true);
    expect(accepts('pricing.models', [{ ...price, inputPerMTok: -1 }])).toBe(false);
    expect(accepts('pricing.models', [{ ...price, effectiveFrom: 'yesterday' }])).toBe(false);
    expect(accepts('pricing.models', [{ ...price, extra: 1 }])).toBe(false);
  });

  it('typed access works on the output (compile-time check)', () => {
    const cfg = RuntimeFileSchema.parse({ schema_version: 1 });
    const poll: number = cfg.spool.pollMs;
    const port: number | null = cfg.server.port;
    const rule: boolean = cfg.alerts.rules.hook_gap.enabled;
    expect([poll, port, rule]).toEqual([500, null, true]);
  });
});

describe('(6) generated JSON Schema', () => {
  function everyObjectIsClosed(node: unknown, path: string, problems: string[]): void {
    if (Array.isArray(node)) {
      node.forEach((child, i) => {
        everyObjectIsClosed(child, `${path}[${i}]`, problems);
      });
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const rec = asRecord(node);
    if (rec['type'] === 'object' && 'properties' in rec && rec['additionalProperties'] !== false) problems.push(path);
    for (const [k, v] of Object.entries(rec)) everyObjectIsClosed(v, `${path}.${k}`, problems);
  }

  it('has additionalProperties: false on every object of the overrides and the merged schema', () => {
    for (const [name, schema] of [
      ['overrides', RuntimeOverridesSchema],
      ['merged', RuntimeFileSchema],
    ] as const) {
      const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      const problems: string[] = [];
      everyObjectIsClosed(json, name, problems);
      expect(problems, name).toEqual([]);
      expect(asRecord(asRecord(json)['properties'])['server'], name).toBeDefined();
    }
  });
});

interface RegistryRow {
  readonly key: string;
  readonly defaultCell: string;
  readonly range: string;
  readonly owner: string;
}

function registryRows(): RegistryRow[] {
  const text = readText('docs/design/98-contract-registry.md');
  const start = text.indexOf('### 6.2 Runtime R keys');
  const end = text.indexOf('\n### 6.3', start);
  expect(start).toBeGreaterThan(-1);
  const rows: RegistryRow[] = [];
  for (const line of text.slice(start, end).split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    const [keyCell, , defaultCell, range, owner] = cells;
    if (keyCell === undefined || defaultCell === undefined || range === undefined || owner === undefined) continue;
    rows.push({ key: keyCell.replace(/`/g, '').replace(/\[\]$/, ''), defaultCell, range, owner });
  }
  return rows;
}

const UNITS: Readonly<Record<string, number>> = { '': 1, KiB: 1024, MiB: 1_048_576, GiB: 1_073_741_824 };

function parseBound(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(?: (KiB|MiB|GiB))?$/.exec(text.trim());
  if (m?.[1] === undefined) throw new Error(`unparseable bound ${text}`);
  return Number(m[1]) * (UNITS[m[2] ?? ''] ?? 1);
}

function renderDefault(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return '[]';
  if (typeof value === 'object') {
    return Object.values(value)
      .map((v) => (typeof v === 'string' ? `'${v}'` : renderDefault(v)))
      .join(', ');
  }
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

describe('(7) catalogue equals the registry table 6.2', () => {
  const rows = registryRows();

  it('has one catalogue entry per registry row and the other way round', () => {
    expect(rows.length).toBeGreaterThan(55);
    expect(rows.map((r) => r.key).sort()).toEqual(R_KEY_CATALOGUE.map((e) => e.key).sort());
  });

  it('agrees on owner, default and range for every key', () => {
    for (const row of rows) {
      const entry = R_KEY_CATALOGUE.find((e) => e.key === row.key);
      if (entry === undefined) throw new Error(`missing catalogue entry ${row.key}`);

      // owner
      expect(row.owner.startsWith(entry.owner), `${row.key} owner ${row.owner} vs ${entry.owner}`).toBe(true);
      const section = /^0[1-6] (\d+(?:\.\d+)*)/.exec(row.owner)?.[1];
      if (section !== undefined) expect(entry.ref, `${row.key} ref`).toBe(`${entry.owner} ${section}`);

      // default
      const derived = R_DERIVED_DEFAULTS[row.key];
      const cell = row.defaultCell.replace(/`/g, '');
      if (derived !== undefined) {
        expect(cell, `${row.key} default cell`).toContain(`derived ${derived.from}`);
      } else if (row.key === 'pricing.models') {
        expect(cell.startsWith('[]')).toBe(true);
        expect(entry.default).toEqual([]);
      } else {
        expect(cell, `${row.key} default`).toBe(renderDefault(entry.default));
      }

      // range, probed through the schema
      const range = row.range.replace(/\(.*$/, '').trim();
      const between = /^(\d+(?:\.\d+)?(?: [KMG]iB)?)\.\.(\d+(?:\.\d+)?(?: [KMG]iB)?)$/.exec(range);
      if (between?.[1] !== undefined && between[2] !== undefined) {
        const lo = parseBound(between[1]);
        const hi = parseBound(between[2]);
        const step = row.key === 'import.backfillShare' ? 0.01 : 1;
        expect(accepts(row.key, lo), `${row.key} accepts ${lo}`).toBe(true);
        expect(accepts(row.key, hi), `${row.key} accepts ${hi}`).toBe(true);
        expect(accepts(row.key, lo - step), `${row.key} rejects ${lo - step}`).toBe(false);
        expect(accepts(row.key, hi + step), `${row.key} rejects ${hi + step}`).toBe(false);
      } else if (range === '> 0, <= 86400') {
        expect(accepts(row.key, 86_400)).toBe(true);
        expect(accepts(row.key, 0.5)).toBe(true);
        expect(accepts(row.key, 0)).toBe(false);
        expect(accepts(row.key, 86_401)).toBe(false);
      } else if (row.key === 'logLevel') {
        for (const level of ['error', 'warn', 'info', 'debug']) expect(accepts(row.key, level)).toBe(true);
        expect(range.replace(/`/g, '')).toBe('error warn info debug');
      }
    }
  });
});
