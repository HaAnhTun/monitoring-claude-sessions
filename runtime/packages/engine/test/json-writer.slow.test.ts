/// <reference types="node" />
// Golden test of the PyJson module (design 01 section 1.9, ADR 0003, plan WP-05).
// Data: test/fixtures/json-writer/golden.frozen.json, captured from CPython before 4.0 removed Python (ADR 0066).
// Every expectation below is a string that CPython 3.x produced; this file only compares.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PyJsonSyntaxError, dumpPyJson, parsePyJson, pyEquals, pyRepr, pyShort, type PyJsonValue } from '@mcs/engine';

const Golden = z.object({
  meta: z.object({ python: z.string(), unicode: z.string(), seed: z.number() }),
  numbers: z.array(z.tuple([z.string(), z.string()])),
  strings: z.array(
    z.object({ cps: z.array(z.number()), raw: z.string(), ascii: z.string(), repr: z.string(), cn: z.boolean() }),
  ),
  reprSweep: z.array(z.tuple([z.number(), z.string(), z.number()])),
  documents: z.array(
    z.object({
      text: z.string(),
      indent: z.string(),
      compact: z.string(),
      ascii: z.string(),
      ascii60: z.string(),
      short: z.string(),
    }),
  ),
  short: z.array(z.tuple([z.string(), z.string()])),
  equals: z.array(z.tuple([z.string(), z.string(), z.boolean()])),
  errors: z.array(z.tuple([z.string(), z.string(), z.number(), z.number(), z.number()])),
  loneSurrogates: z.array(z.string()),
});

const GOLDEN_URL = new URL('./fixtures/json-writer/golden.frozen.json', import.meta.url);
const golden = Golden.parse(JSON.parse(readFileSync(fileURLToPath(GOLDEN_URL), 'utf8')));

function describeValue(v: PyJsonValue): string {
  return dumpPyJson(v, { compact: true });
}

describe('PyJson golden: numbers (E6)', () => {
  it('has the documented corpus size', () => {
    expect(golden.numbers.length).toBeGreaterThanOrEqual(26000);
  });

  it('dump(parse(lexeme)) equals json.dumps(json.loads(lexeme)) for every lexeme: 0 mismatches', () => {
    const mismatches: string[] = [];
    for (const [lexeme, expected] of golden.numbers) {
      const actual = dumpPyJson(parsePyJson(lexeme), { compact: true });
      if (actual !== expected) mismatches.push(`${lexeme} -> ${actual} (python ${expected})`);
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(mismatches.length).toBe(0);
  });

  it('writes the same number inside indent-2 arrays', () => {
    const batch = golden.numbers.slice(0, 400);
    const text = `[${batch.map(([lexeme]) => lexeme).join(', ')}]`;
    const expected = `[\n${batch.map(([, dumps]) => `  ${dumps}`).join(',\n')}\n]`;
    expect(dumpPyJson(parsePyJson(text), { indent: 2 })).toBe(expected);
  });
});

describe('PyJson golden: strings', () => {
  it('writes every string like json.dumps with and without ensure_ascii', () => {
    const mismatches: string[] = [];
    for (const item of golden.strings) {
      const value: PyJsonValue = { k: 'str', v: String.fromCodePoint(...item.cps) };
      if (dumpPyJson(value, { compact: true }) !== item.raw) mismatches.push(`raw ${JSON.stringify(item.cps)}`);
      if (dumpPyJson(value, { compact: true, asciiOnly: true }) !== item.ascii)
        mismatches.push(`ascii ${JSON.stringify(item.cps)}`);
      if (describeValue(parsePyJson(item.raw)) !== item.raw) mismatches.push(`parse raw ${JSON.stringify(item.cps)}`);
      if (describeValue(parsePyJson(item.ascii)) !== item.raw)
        mismatches.push(`parse ascii ${JSON.stringify(item.cps)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('reproduces repr(str) for every code point that both Unicode tables assign', () => {
    const mismatches: string[] = [];
    let compared = 0;
    for (const item of golden.strings) {
      if (item.cn) continue;
      compared++;
      if (pyRepr(String.fromCodePoint(...item.cps)) !== item.repr) mismatches.push(JSON.stringify(item.cps));
    }
    for (const [cp, expected, cn] of golden.reprSweep) {
      if (cn === 1) continue;
      compared++;
      if (pyRepr(String.fromCodePoint(cp)) !== expected) mismatches.push(`U+${cp.toString(16)}`);
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(5000);
  });
});

describe('PyJson golden: documents', () => {
  it('reproduces json.dumps in the indent, compact and ASCII forms', () => {
    const mismatches: string[] = [];
    for (const doc of golden.documents) {
      const value = parsePyJson(doc.text);
      if (dumpPyJson(value, { indent: 2 }) !== doc.indent) mismatches.push(`indent ${JSON.stringify(doc.text)}`);
      if (dumpPyJson(value, { compact: true }) !== doc.compact) mismatches.push(`compact ${JSON.stringify(doc.text)}`);
      if (dumpPyJson(value, { compact: true, asciiOnly: true }) !== doc.ascii)
        mismatches.push(`ascii ${JSON.stringify(doc.text)}`);
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(golden.documents.length).toBeGreaterThan(400);
  });

  it('keeps the validation-message form: ASCII compact dump cut at 60', () => {
    for (const doc of golden.documents) {
      const value = parsePyJson(doc.text);
      expect(dumpPyJson(value, { compact: true, asciiOnly: true }).slice(0, 60)).toBe(doc.ascii60);
    }
  });

  it('reproduces the legacy _short for documents and for the 117/120 code point boundary', () => {
    for (const doc of golden.documents) expect(pyShort(parsePyJson(doc.text))).toBe(doc.short);
    for (const [text, expected] of golden.short) expect(pyShort(parsePyJson(text))).toBe(expected);
  });

  it('round-trips the Python output: parse(dump(parse(text))) equals parse(text)', () => {
    for (const doc of golden.documents) {
      const original = parsePyJson(doc.text);
      expect(parsePyJson(doc.indent)).toEqual(original);
      expect(parsePyJson(doc.compact)).toEqual(original);
      expect(parsePyJson(doc.ascii)).toEqual(original);
    }
  });
});

describe('PyJson golden: equality', () => {
  it('agrees with Python == on every pair', () => {
    for (const [a, b, expected] of golden.equals) {
      expect(pyEquals(parsePyJson(a), parsePyJson(b)), `${a} == ${b}`).toBe(expected);
    }
  });
});

describe('PyJson golden: errors', () => {
  it('rejects every text Python rejects, with the same reason, line, column and offset', () => {
    const mismatches: string[] = [];
    for (const [text, reason, line, col, pos] of golden.errors) {
      try {
        parsePyJson(text);
        mismatches.push(`accepted ${JSON.stringify(text)}`);
      } catch (error) {
        if (!(error instanceof PyJsonSyntaxError)) throw error;
        const actual = [error.reason, error.line, error.col, error.pos];
        if (JSON.stringify(actual) !== JSON.stringify([reason, line, col, pos])) {
          mismatches.push(
            `${JSON.stringify(text)}: node ${JSON.stringify(actual)} python ${JSON.stringify([reason, line, col, pos])}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('rejects the lone surrogate escapes that Python accepts (stricter on purpose)', () => {
    for (const text of golden.loneSurrogates)
      expect(() => parsePyJson(text), JSON.stringify(text)).toThrow(PyJsonSyntaxError);
  });

  it('was generated by the documented Python line', () => {
    expect(golden.meta.python).toMatch(/^3\.\d+\.\d+$/);
  });
});
