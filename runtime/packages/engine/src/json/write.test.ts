import { describe, expect, it } from 'vitest';

import { dumpJson, escapeJsonString, jsonFileText } from './write.ts';
import { parseJson } from './parse.ts';
import { JsonEncodeError, type JsonDoc } from './value.ts';

const BS = String.fromCharCode(92);

describe('dumpJson indent 2', () => {
  it('writes the indent-2 file layout', () => {
    const value = parseJson('{"b":1,"2":2.0,"a":[1,[],{}],"c":{"d":null,"e":true}}');
    expect(dumpJson(value, { indent: 2 })).toBe(
      [
        '{',
        '  "b": 1,',
        '  "2": 2.0,',
        '  "a": [',
        '    1,',
        '    [],',
        '    {}',
        '  ],',
        '  "c": {',
        '    "d": null,',
        '    "e": true',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('writes empty containers inline and scalars bare', () => {
    expect(dumpJson(parseJson('{}'), { indent: 2 })).toBe('{}');
    expect(dumpJson(parseJson('[]'), { indent: 2 })).toBe('[]');
    expect(dumpJson(parseJson('1.0'), { indent: 2 })).toBe('1.0');
  });

  it('adds exactly one LF for a file', () => {
    expect(jsonFileText(parseJson('{"a":1}'))).toBe('{\n  "a": 1\n}\n');
  });
});

describe('dumpJson compact', () => {
  it('uses the ", " and ": " separators', () => {
    expect(dumpJson(parseJson('{"a":1,"b":[1,2.0]}'), { compact: true })).toBe('{"a": 1, "b": [1, 2.0]}');
  });

  it('keeps non-ASCII text raw unless escapeNonAscii is set', () => {
    const value = parseJson(`["${String.fromCodePoint(0xe9, 0x1f600)}"]`);
    expect(dumpJson(value, { compact: true })).toBe(`["${String.fromCodePoint(0xe9, 0x1f600)}"]`);
    expect(dumpJson(value, { compact: true, escapeNonAscii: true })).toBe(`["${BS}u00e9${BS}ud83d${BS}ude00"]`);
  });
});

describe('numbers', () => {
  it('writes ints through BigInt and floats through formatFloat', () => {
    const text = '[0, -0, 24, 24.0, 1e5, 1e16, 1e-5, 123456789012345678901234567890, 0.1]';
    expect(dumpJson(parseJson(text), { compact: true })).toBe(
      '[0, 0, 24, 24.0, 100000.0, 1e+16, 1e-05, 123456789012345678901234567890, 0.1]',
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('refuses the non-finite float %s', (x) => {
    const doc: JsonDoc = { k: 'arr', v: [{ k: 'float', v: x }] };
    expect(() => dumpJson(doc, { compact: true })).toThrow(JsonEncodeError);
    expect(() => dumpJson(doc, { indent: 2 })).toThrow(JsonEncodeError);
    expect(() => jsonFileText(doc)).toThrow(JsonEncodeError);
  });
});

describe('escapeJsonString', () => {
  it('uses the short escapes and lowercase u00XX for other control characters', () => {
    const s = `${String.fromCharCode(8, 9, 10, 12, 13, 0, 31)}"${BS}`;
    expect(escapeJsonString(s, false)).toBe(`"${BS}b${BS}t${BS}n${BS}f${BS}r${BS}u0000${BS}u001f${BS}"${BS}${BS}"`);
  });

  it('leaves DEL, U+2028 and astral code points raw, and escapes them all in ASCII mode', () => {
    const s = String.fromCodePoint(0x7f, 0x2028, 0x1f600);
    expect(escapeJsonString(s, false)).toBe(`"${s}"`);
    expect(escapeJsonString(s, true)).toBe(`"${BS}u007f${BS}u2028${BS}ud83d${BS}ude00"`);
  });

  it('refuses a lone surrogate in UTF-8 mode and escapes it in ASCII mode', () => {
    const lone = String.fromCharCode(0xd800);
    expect(() => escapeJsonString(`a${lone}`, false)).toThrow(JsonEncodeError);
    expect(() => escapeJsonString(String.fromCharCode(0xdc00), false)).toThrow(JsonEncodeError);
    expect(escapeJsonString(lone, true)).toBe(`"${BS}ud800"`);
  });
});
