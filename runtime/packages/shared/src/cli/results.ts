// Per-command `data` types of the CLI (01 section 6.2, 6.4). WP-02 writes the configuration inspection, which the
// server also serves as `GET /api/v3/config` (03 6.1, I-20); the blocks below are filled by the owning work packages.
import { z } from 'zod';

import { R_TOP_KEYS } from '../config/runtime/index.ts';

export const CONFIG_SOURCES = ['builtin', 'skill', 'config', 'runtime', 'env', 'cli'] as const;

/** Where a configuration value comes from, highest layer last: builtin < skill < config / runtime < env < cli. */
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

export const ConfigSourceSchema = z.enum(CONFIG_SOURCES);

export const CONFIG_FILE_NAMES = ['defaults.json', 'runtime/defaults.json', 'config.json', 'runtime.json'] as const;

export const ConfigFileStatusSchema = z.strictObject({
  name: z.enum(CONFIG_FILE_NAMES),
  path: z.string(),
  schemaVersion: z.number().int().nullable(),
  present: z.boolean(),
  ok: z.boolean(),
});

export type ConfigFileStatus = z.infer<typeof ConfigFileStatusSchema>;

export const ConfigInspectionEntrySchema = z.strictObject({
  key: z.string(),
  value: z.unknown(),
  source: ConfigSourceSchema,
});

export type ConfigInspectionEntry = z.infer<typeof ConfigInspectionEntrySchema>;

export const ConfigInspectionSchema = z.strictObject({
  entries: z.array(ConfigInspectionEntrySchema),
  files: z.array(ConfigFileStatusSchema),
  effectivePort: z.number().int().min(1).max(65535),
  engine: z.enum(['node', 'legacy']),
});

export type ConfigInspection = z.infer<typeof ConfigInspectionSchema>;

/**
 * The part of the engine `ResolvedConfig` (01 2.3) that the projection reads. `ResolvedConfig` satisfies it, so
 * `toConfigInspection(ctx.config, 'node')` type-checks in the engine without shared depending on the engine.
 */
export interface ConfigInspectionSource {
  /** Merged legacy (L) keys. */
  readonly monitor: unknown;
  /** Merged runtime (R) keys. */
  readonly runtime: unknown;
  readonly effectivePort: number;
  /** Dotted key to source tag, including the extra entry `effectivePort` (01 2.5). */
  readonly provenance: Readonly<Record<string, ConfigSource>>;
  readonly files: readonly ConfigFileStatus[];
}

const R_TOP: ReadonlySet<string> = new Set(R_TOP_KEYS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep copy of a JSON-like value; `undefined` members are dropped and `undefined` itself becomes `null`. */
function toPlain(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((v: unknown) => toPlain(v));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toPlain(v);
    return out;
  }
  return value;
}

function valueAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (!isRecord(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Code-point order, so the result does not depend on the locale or on UTF-16 surrogate ordering. */
function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * Pure projection of a resolved configuration (01 6.4): one entry per provenance key except `effectivePort`, whose
 * value is read at the dotted path from the runtime (R) keys when the first segment is a runtime key, else from the
 * legacy (L) keys (the two name sets are disjoint). Entries are sorted by key in code-point order. No redaction:
 * loopback API, same user (D-C6).
 */
export function toConfigInspection(r: ConfigInspectionSource, engine: 'node' | 'legacy'): ConfigInspection {
  const entries: ConfigInspectionEntry[] = [];
  for (const [key, source] of Object.entries(r.provenance)) {
    if (key === 'effectivePort') continue;
    const root = R_TOP.has(key.split('.')[0] ?? '') ? r.runtime : r.monitor;
    entries.push({ key, value: toPlain(valueAt(root, key)), source });
  }
  entries.sort((a, b) => compareCodePoints(a.key, b.key));
  return { entries, files: r.files.map((f) => ({ ...f })), effectivePort: r.effectivePort, engine };
}

// @wp-begin WP-37
// @wp-end WP-37

// @wp-begin WP-61
// @wp-end WP-61

// @wp-begin WP-62
// @wp-end WP-62

// @wp-begin WP-64
// @wp-end WP-64
