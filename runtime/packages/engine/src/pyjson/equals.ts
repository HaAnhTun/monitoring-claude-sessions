// Python `==` on JSON values (design 01 section 1.9): the no-op detection of `configure`.
import type { PyJsonValue } from './value.ts';

type Numeric = { k: 'int'; v: bigint } | { k: 'float'; v: number };

function numeric(v: PyJsonValue): Numeric | undefined {
  if (v.k === 'int' || v.k === 'float') return v;
  if (v.k === 'bool') return { k: 'int', v: v.v ? 1n : 0n };
  return undefined;
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
 * Python equality: int, float and bool compare by numeric value exactly (`1 == 1.0 == True`, `10**20 == 1e20`), lists
 * compare in order, dicts by key set. `NaN` equals nothing, not even itself.
 */
export function pyEquals(a: PyJsonValue, b: PyJsonValue): boolean {
  const na = numeric(a);
  const nb = numeric(b);
  if (na !== undefined || nb !== undefined) return na !== undefined && nb !== undefined && numbersEqual(na, nb);
  if (a.k === 'null') return b.k === 'null';
  if (a.k === 'str') return b.k === 'str' && a.v === b.v;
  if (a.k === 'arr') {
    if (b.k !== 'arr' || a.v.length !== b.v.length) return false;
    return a.v.every((item, index) => {
      const other = b.v[index];
      return other !== undefined && pyEquals(item, other);
    });
  }
  if (a.k === 'obj' && b.k === 'obj') {
    const left = new Map(a.v);
    const right = new Map(b.v);
    if (left.size !== right.size) return false;
    for (const [key, value] of left) {
      const other = right.get(key);
      if (other === undefined || !pyEquals(value, other)) return false;
    }
    return true;
  }
  return false;
}
