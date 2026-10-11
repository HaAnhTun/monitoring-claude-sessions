// Layer merge (01 section 2.2): the legacy `merge()` of config.py, extended to the runtime sections (challenge C-3).
export type PlainObject = Record<string, unknown>;

/** The legacy `MERGED_DICTS`: these dict-valued keys merge per sub-key; everything else replaces. */
export const L_MERGED: ReadonlySet<string> = new Set(['panels', 'ui', 'poll', 'limits']);

export function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stores `value` as an own data property. A plain assignment of the key `__proto__` would replace the prototype of
 * `target`; a configuration file may contain any key, so every write goes through here.
 */
export function setOwn(target: PlainObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * `base` with `over` applied: keys that start with `_` are skipped (comments); a key in `merged` whose two values are both
 * plain objects merges one level deep (`{...base[key], ...over[key]}`); every other value, lists, scalars and `null`
 * included, replaces. Neither input is modified and the result shares no object with them.
 */
export function mergeLayer(base: PlainObject, over: PlainObject, merged: ReadonlySet<string>): PlainObject {
  const out: PlainObject = structuredClone(base);
  for (const [key, value] of Object.entries(over)) {
    if (key.startsWith('_')) continue;
    const current = Object.hasOwn(out, key) ? out[key] : undefined;
    if (merged.has(key) && isPlainObject(value) && isPlainObject(current)) {
      const combined: PlainObject = {};
      for (const [k, v] of Object.entries(current)) setOwn(combined, k, v);
      for (const [k, v] of Object.entries(structuredClone(value))) setOwn(combined, k, v);
      setOwn(out, key, combined);
    } else {
      setOwn(out, key, structuredClone(value));
    }
  }
  return out;
}
