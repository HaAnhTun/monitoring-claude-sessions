// Equality of two JSON documents (design 01 section 1.9): the no-op detection of `configure`.
import type { JsonDoc } from './value.ts';

type Numeric = { k: 'int'; v: bigint } | { k: 'float'; v: number };

function numeric(v: JsonDoc): Numeric | undefined {
  return v.k === 'int' || v.k === 'float' ? v : undefined;
}

function numbersEqual(a: Numeric, b: Numeric): boolean {
  if (a.k === 'int' && b.k === 'int') return a.v === b.v;
  if (a.k === 'float' && b.k === 'float') return a.v === b.v;
  const int = a.k === 'int' ? a.v : b.k === 'int' ? b.v : 0n;
  const float = a.k === 'float' ? a.v : b.k === 'float' ? b.v : Number.NaN;
  if (!Number.isInteger(float)) return false;
  return BigInt(float) === int;
}

/**
 * Structural equality. An integer and a float of equal value are equal and compare exactly (`1` equals `1.0`,
 * `10**20` equals `1e20`); a boolean is never a number (`true` is not `1`). Arrays compare in order, objects by key set
 * (the order of entries does not matter). A string equals only a string, `null` only `null`.
 */
export function jsonEquals(a: JsonDoc, b: JsonDoc): boolean {
  const na = numeric(a);
  const nb = numeric(b);
  if (na !== undefined || nb !== undefined) return na !== undefined && nb !== undefined && numbersEqual(na, nb);
  if (a.k === 'null') return b.k === 'null';
  if (a.k === 'bool') return b.k === 'bool' && a.v === b.v;
  if (a.k === 'str') return b.k === 'str' && a.v === b.v;
  if (a.k === 'arr') {
    if (b.k !== 'arr' || a.v.length !== b.v.length) return false;
    return a.v.every((item, index) => {
      const other = b.v[index];
      return other !== undefined && jsonEquals(item, other);
    });
  }
  if (a.k === 'obj' && b.k === 'obj') {
    const left = new Map(a.v);
    const right = new Map(b.v);
    if (left.size !== right.size) return false;
    for (const [key, value] of left) {
      const other = right.get(key);
      if (other === undefined || !jsonEquals(value, other)) return false;
    }
    return true;
  }
  return false;
}
