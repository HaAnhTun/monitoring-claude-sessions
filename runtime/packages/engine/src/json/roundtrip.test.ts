import { describe, expect, it } from 'vitest';

import { dumpJson, jsonFileText } from './write.ts';
import { parseJson } from './parse.ts';
import { jsonEquals } from './equals.ts';
import { formatFloat } from './number.ts';
import type { JsonDoc } from './value.ts';

/** mulberry32: a tiny seeded generator so that a failure reproduces from the printed seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  'a',
  'Z',
  '0',
  ' ',
  '"',
  String.fromCharCode(92),
  '/',
  '\n',
  '\t',
  String.fromCharCode(0),
  String.fromCharCode(31),
  String.fromCharCode(127),
  String.fromCharCode(0xe9),
  String.fromCharCode(0x2028),
  String.fromCodePoint(0x1f600),
  String.fromCodePoint(0x10ffff),
];

function randomString(rand: () => number): string {
  const n = Math.floor(rand() * 8);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)] ?? 'a';
  return s;
}

function randomFloat(rand: () => number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, Math.floor(rand() * 4294967296));
  view.setUint32(4, Math.floor(rand() * 4294967296));
  const x = view.getFloat64(0);
  return Number.isFinite(x) ? x : 0.5;
}

function randomValue(rand: () => number, depth: number): JsonDoc {
  const pick = Math.floor(rand() * (depth >= 4 ? 6 : 8));
  switch (pick) {
    case 0:
      return { k: 'null' };
    case 1:
      return { k: 'bool', v: rand() < 0.5 };
    case 2:
      return { k: 'str', v: randomString(rand) };
    case 3: {
      const digits = 1 + Math.floor(rand() * 30);
      let text = String(1 + Math.floor(rand() * 9));
      for (let i = 1; i < digits; i++) text += String(Math.floor(rand() * 10));
      return { k: 'int', v: BigInt(rand() < 0.5 ? `-${text}` : text) };
    }
    case 4:
      return { k: 'float', v: randomFloat(rand) };
    case 5:
      return { k: 'float', v: [0, -0, 1, 24, 1e16, 1e-5, 0.1, 1e21][Math.floor(rand() * 8)] ?? 0 };
    case 6: {
      const n = Math.floor(rand() * 4);
      return { k: 'arr', v: Array.from({ length: n }, () => randomValue(rand, depth + 1)) };
    }
    default: {
      const n = Math.floor(rand() * 4);
      const entries: [string, JsonDoc][] = [];
      const seen = new Set<string>();
      for (let i = 0; i < n; i++) {
        const key = rand() < 0.3 ? String(Math.floor(rand() * 12)) : randomString(rand);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push([key, randomValue(rand, depth + 1)]);
      }
      return { k: 'obj', v: entries };
    }
  }
}

describe('round trip properties (seeded)', () => {
  const SEED = 20261011;

  it('parse(dump(v)) returns v for the indent, compact and ASCII forms', () => {
    const rand = prng(SEED);
    for (let i = 0; i < 1500; i++) {
      const v = randomValue(rand, 0);
      for (const options of [{ indent: 2 }, { compact: true }, { compact: true, escapeNonAscii: true }] as const) {
        const text = dumpJson(v, options);
        expect(parseJson(text), `seed ${String(SEED)} case ${String(i)} ${JSON.stringify(options)}`).toEqual(v);
      }
    }
  });

  it('dump(parse(dump(v))) is stable and equal to the original dump', () => {
    const rand = prng(SEED + 1);
    for (let i = 0; i < 1500; i++) {
      const v = randomValue(rand, 0);
      const once = dumpJson(v, { indent: 2 });
      expect(dumpJson(parseJson(once), { indent: 2 })).toBe(once);
      const file = jsonFileText(v);
      expect(file.endsWith('}\n') || file.endsWith(']\n') || !file.slice(0, -1).includes('\n')).toBe(true);
      expect(file.includes('\r')).toBe(false);
    }
  });

  it('jsonEquals holds for a value and its re-parsed dump', () => {
    const rand = prng(SEED + 2);
    for (let i = 0; i < 800; i++) {
      const v = randomValue(rand, 0);
      const text = dumpJson(v, { compact: true });
      expect(jsonEquals(v, parseJson(text))).toBe(true);
    }
  });

  it('formatFloat parses back to the same double', () => {
    const rand = prng(SEED + 3);
    for (let i = 0; i < 5000; i++) {
      const x = randomFloat(rand);
      expect(Object.is(Number(formatFloat(x)), x)).toBe(true);
    }
  });
});
