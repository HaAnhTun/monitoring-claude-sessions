import { describe, expect, it } from 'vitest';

import { PyJsonSyntaxError, parsePyJson } from './parse.ts';
import type { PyJsonValue } from './value.ts';

const BS = String.fromCharCode(92);

function failure(text: string): PyJsonSyntaxError {
  try {
    parsePyJson(text);
  } catch (error) {
    if (error instanceof PyJsonSyntaxError) return error;
    throw error;
  }
  throw new Error(`expected a syntax error for ${JSON.stringify(text)}`);
}

describe('parsePyJson values', () => {
  it('decides int or float by the lexeme, like json.loads', () => {
    expect(parsePyJson('24')).toEqual({ k: 'int', v: 24n });
    expect(parsePyJson('24.0')).toEqual({ k: 'float', v: 24 });
    expect(parsePyJson('1e2')).toEqual({ k: 'float', v: 100 });
    expect(parsePyJson('1E-2')).toEqual({ k: 'float', v: 0.01 });
    expect(parsePyJson('-0')).toEqual({ k: 'int', v: 0n });
  });

  it('keeps integers beyond 2**53 exactly', () => {
    expect(parsePyJson('9007199254740993')).toEqual({ k: 'int', v: 9007199254740993n });
    expect(parsePyJson('-340282366920938463463374607431768211456')).toEqual({
      k: 'int',
      v: -340282366920938463463374607431768211456n,
    });
  });

  it('accepts the NaN and Infinity tokens of Python', () => {
    const value = parsePyJson('[NaN, Infinity, -Infinity, 1e999]');
    expect(value.k).toBe('arr');
    if (value.k !== 'arr') return;
    const floats = value.v.map((item) => (item.k === 'float' ? item.v : 'not a float'));
    expect(floats[0]).toBeNaN();
    expect(floats.slice(1)).toEqual([Infinity, -Infinity, Infinity]);
  });

  it('keeps the order of object entries, including integer-like keys', () => {
    const value = parsePyJson('{"b":1,"2":2,"a":3,"1":4}');
    expect(value).toEqual({
      k: 'obj',
      v: [
        ['b', { k: 'int', v: 1n }],
        ['2', { k: 'int', v: 2n }],
        ['a', { k: 'int', v: 3n }],
        ['1', { k: 'int', v: 4n }],
      ],
    });
  });

  it('lets a duplicate key keep its first position and take the last value, like a Python dict', () => {
    const value = parsePyJson('{"a":1,"b":2,"a":3}');
    expect(value).toEqual({
      k: 'obj',
      v: [
        ['a', { k: 'int', v: 3n }],
        ['b', { k: 'int', v: 2n }],
      ],
    });
  });

  it('keeps __proto__ as an ordinary key', () => {
    const value: PyJsonValue = parsePyJson('{"__proto__":1}');
    expect(value).toEqual({ k: 'obj', v: [['__proto__', { k: 'int', v: 1n }]] });
  });

  it('decodes escapes and surrogate pairs', () => {
    expect(parsePyJson(`"a${BS}n${BS}t${BS}"${BS}${BS}${BS}/${BS}b${BS}f${BS}r"`)).toEqual({
      k: 'str',
      v: 'a\n\t"' + BS + '/\b\f\r',
    });
    expect(parsePyJson(`"${BS}u00e9${BS}ud83d${BS}ude00"`)).toEqual({
      k: 'str',
      v: String.fromCodePoint(0xe9, 0x1f600),
    });
  });

  it('accepts raw U+2028, U+2029 and DEL inside strings, like Python', () => {
    const text = `"${String.fromCharCode(0x2028, 0x2029, 0x7f)}"`;
    expect(parsePyJson(text)).toEqual({ k: 'str', v: String.fromCharCode(0x2028, 0x2029, 0x7f) });
  });

  it('skips only the four JSON whitespace characters', () => {
    expect(parsePyJson(' \t\r\n[ 1 , 2 ] \n')).toEqual({
      k: 'arr',
      v: [
        { k: 'int', v: 1n },
        { k: 'int', v: 2n },
      ],
    });
    expect(() => parsePyJson(`${String.fromCharCode(0xa0)}1`)).toThrow(PyJsonSyntaxError);
  });
});

describe('parsePyJson errors', () => {
  it('reports the Python reason, line, column and offset', () => {
    const error = failure('{\n  "a": 1,\n  "b": \n}');
    expect(error.reason).toBe('Expecting value');
    expect([error.line, error.col, error.pos]).toEqual([4, 1, 20]);
    expect(error.message).toBe('Expecting value: line 4 column 1 (char 20)');
  });

  it('counts positions in code points, not UTF-16 units', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const error = failure(`["${emoji}" 1]`);
    expect(error.reason).toBe("Expecting ',' delimiter");
    expect(error.pos).toBe(5);
    expect(error.col).toBe(6);
  });

  it.each([
    ['', 'Expecting value'],
    ['[1,]', 'Illegal trailing comma before end of array'],
    ['{"a":1,}', 'Illegal trailing comma before end of object'],
    ['[1 2]', "Expecting ',' delimiter"],
    ['{"a" 1}', "Expecting ':' delimiter"],
    ['{a:1}', 'Expecting property name enclosed in double quotes'],
    ['1 2', 'Extra data'],
    ['01', 'Extra data'],
    ['"abc', 'Unterminated string starting at'],
    [`"${BS}x"`, `Invalid ${BS}escape`],
    [`"${BS}u12"`, `Invalid ${BS}uXXXX escape`],
    ['"a\tb"', 'Invalid control character at'],
    ['+1', 'Expecting value'],
    ['.5', 'Expecting value'],
    ['-', 'Expecting value'],
  ])('rejects %j with %j', (text, reason) => {
    expect(failure(text).reason).toBe(reason);
  });

  it('reports an invalid escape at the u when the text ends right after a complete four-digit escape (CPython end >= len rule)', () => {
    const complete = failure(`"${BS}u0041`);
    expect(complete.reason).toBe(`Invalid ${BS}uXXXX escape`);
    expect([complete.line, complete.col, complete.pos]).toEqual([1, 3, 2]);
    const inArray = failure(`["${BS}u0041`);
    expect(inArray.reason).toBe(`Invalid ${BS}uXXXX escape`);
    expect(inArray.pos).toBe(3);
    expect(failure(`"${BS}u0041x`).reason).toBe('Unterminated string starting at');
    expect(parsePyJson(`"${BS}u0041"`)).toEqual({ k: 'str', v: 'A' });
  });

  it('rejects a leading BOM like json.loads on text', () => {
    const error = failure(`${String.fromCharCode(0xfeff)}{}`);
    expect(error.reason).toBe('Unexpected UTF-8 BOM (decode using utf-8-sig)');
    expect([error.line, error.col, error.pos]).toEqual([1, 1, 0]);
  });

  it('rejects lone surrogate escapes, which Python would fail to write as UTF-8', () => {
    for (const text of [`"${BS}ud800"`, `"${BS}udc00"`, `"${BS}ud800${BS}u0041"`, `"${BS}udc00${BS}ud800"`]) {
      expect(failure(text).reason).toContain('lone surrogate');
    }
  });

  it('refuses documents nested deeper than the limit instead of overflowing the stack', () => {
    const deep = '['.repeat(1500) + ']'.repeat(1500);
    expect(failure(deep).reason).toBe('Maximum nesting depth exceeded');
    expect(parsePyJson('['.repeat(900) + ']'.repeat(900)).k).toBe('arr');
  });
});
