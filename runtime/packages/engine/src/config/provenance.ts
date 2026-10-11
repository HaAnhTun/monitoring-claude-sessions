// Per-key provenance (01 section 2.5): which layer produced each effective value.
import { R_MERGED, type ConfigSource } from '@mcs/shared';

import { L_MERGED, isPlainObject, type PlainObject } from './merge.ts';

/** Dotted paths of the leaves of `value`: scalars, `null` and arrays are leaves, objects are walked, `{}` has none. */
export function leafPaths(value: unknown, prefix: string): string[] {
  if (!isPlainObject(value)) return [prefix];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value))
    out.push(...leafPaths(child, prefix === '' ? key : `${prefix}.${key}`));
  return out;
}

/**
 * Rules 1 and 2 of 2.5. `defaults` are the shared defaults, `over` the workspace `config.json` object (both without `_`
 * keys). The keys of the four merged dicts produce one entry per default sub-key (`panels.git`): `config` when
 * `over` has that sub-key, else `skill`. Other defaults: `config` when `over` has the key, else `skill`. A key that only
 * `over` has is `config` (legacy behaviour; a sub-key that only `over` has is not listed, as in the legacy `provenance()`).
 */
export function legacyProvenance(defaults: PlainObject, over: PlainObject): Record<string, ConfigSource> {
  const out: Record<string, ConfigSource> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (L_MERGED.has(key) && isPlainObject(value)) {
      const set = over[key];
      const setKeys = isPlainObject(set) ? set : {};
      for (const sub of Object.keys(value)) out[`${key}.${sub}`] = Object.hasOwn(setKeys, sub) ? 'config' : 'skill';
    } else {
      out[key] = Object.hasOwn(over, key) ? 'config' : 'skill';
    }
  }
  for (const key of Object.keys(over)) if (!key.startsWith('_') && !Object.hasOwn(defaults, key)) out[key] = 'config';
  return out;
}

/** One runtime layer: the overrides it carries (no `schema_version`) and its tag. */
export interface RuntimeLayer {
  readonly source: ConfigSource;
  readonly overrides: PlainObject;
}

function clearUnder(tags: Map<string, ConfigSource>, prefix: string): void {
  for (const key of [...tags.keys()]) if (key === prefix || key.startsWith(`${prefix}.`)) tags.delete(key);
}

/**
 * Rule 3 of 2.5 for the runtime (R) keys. `layers` are applied lowest first (skill, runtime, env, cli); `runtime` is the
 * final configuration whose leaves are listed. The merge is one section level deep (2.2): a layer that sets a sub-key
 * replaces everything below it, so what an earlier layer set below that sub-key falls back to `builtin`. A leaf that no layer
 * set is `builtin`. `derived` gives the source of the keys that were derived from a legacy key (their provenance is that
 * of the legacy key), whatever a layer wrote for them.
 */
export function runtimeProvenance(
  layers: readonly RuntimeLayer[],
  runtime: unknown,
  derived: Readonly<Record<string, ConfigSource>> = {},
): Record<string, ConfigSource> {
  const tags = new Map<string, ConfigSource>();
  for (const layer of layers) {
    for (const [top, value] of Object.entries(layer.overrides)) {
      if (R_MERGED.has(top) && isPlainObject(value)) {
        for (const [sub, subValue] of Object.entries(value)) {
          const prefix = `${top}.${sub}`;
          clearUnder(tags, prefix);
          for (const leaf of leafPaths(subValue, prefix)) tags.set(leaf, layer.source);
        }
      } else {
        clearUnder(tags, top);
        for (const leaf of leafPaths(value, top)) tags.set(leaf, layer.source);
      }
    }
  }
  const out: Record<string, ConfigSource> = {};
  for (const leaf of leafPaths(runtime, '')) out[leaf] = tags.get(leaf) ?? 'builtin';
  for (const [key, source] of Object.entries(derived)) out[key] = source;
  return out;
}
