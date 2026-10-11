// Conversions between PyJsonValue and plain JavaScript data (design 01 section 1.9).
import type { PyJsonValue } from './value.ts';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_DEPTH = 1000;

/**
 * PyJsonValue to plain data: int and float become numbers, objects become plain objects (integer-like keys are then
 * ordered by JavaScript, so write through the PyJsonValue, never through the plain copy). Throws `RangeError` for an
 * int beyond 2**53-1 in magnitude, which a numeric config key cannot hold.
 */
export function toPlain(v: PyJsonValue): unknown {
  switch (v.k) {
    case 'null':
      return null;
    case 'bool':
    case 'str':
    case 'float':
      return v.v;
    case 'int':
      if (v.v > MAX_SAFE || v.v < -MAX_SAFE) throw new RangeError('integer is beyond 2**53-1 in magnitude');
      return Number(v.v);
    case 'arr':
      return v.v.map((item) => toPlain(item));
    case 'obj':
      return Object.fromEntries(v.v.map(([key, item]) => [key, toPlain(item)]));
  }
}

function isPlainObject(x: object): boolean {
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function convert(x: unknown, depth: number): PyJsonValue {
  if (depth > MAX_DEPTH) throw new TypeError('value is nested too deeply');
  if (x === null) return { k: 'null' };
  if (typeof x === 'boolean') return { k: 'bool', v: x };
  if (typeof x === 'string') return { k: 'str', v: x };
  if (typeof x === 'bigint') return { k: 'int', v: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { k: 'int', v: BigInt(x) } : { k: 'float', v: x };
  if (typeof x === 'object') {
    if (Array.isArray(x)) {
      const items: unknown[] = x;
      const converted: PyJsonValue[] = [];
      for (let index = 0; index < items.length; index++) {
        if (!(index in items)) throw new TypeError('a hole in a sparse array cannot be converted to JSON');
        converted.push(convert(items[index], depth + 1));
      }
      return { k: 'arr', v: converted };
    }
    if (!isPlainObject(x)) throw new TypeError('only plain objects and arrays can be converted');
    const entries: [string, PyJsonValue][] = [];
    for (const [key, value] of Object.entries(x)) {
      if (value === undefined) continue;
      entries.push([key, convert(value, depth + 1)]);
    }
    return { k: 'obj', v: entries };
  }
  throw new TypeError(`a ${typeof x} cannot be converted to JSON`);
}

/**
 * Plain data to PyJsonValue. A number with no fraction becomes an int (so `24` stays `24`; use `parsePyJson` of the raw
 * text when `24.0` must survive), any other number a float. Properties whose value is `undefined` are skipped, like
 * `JSON.stringify`; `undefined` or a hole inside an array, functions, symbols and class instances throw `TypeError`.
 */
export function fromPlain(x: unknown): PyJsonValue {
  return convert(x, 0);
}
