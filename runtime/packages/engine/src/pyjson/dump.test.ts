import { describe, expect, it } from 'vitest';

import { dumpPyJson, escapePyString, pyJsonFileText } from './dump.ts';
import { parsePyJson } from './parse.ts';
import { PyJsonEncodeError } from './value.ts';

const BS = String.fromCharCode(92);

describe('dumpPyJson indent 2', () => {
  it('writes the layout of json.dump(indent=2, ensure_ascii=False)', () => {
    const value = parsePyJson('{"b":1,"2":2.0,"a":[1,[],{}],"c":{"d":null,"e":true}}');
    expect(dumpPyJson(value, { indent: 2 })).toBe(
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
    expect(dumpPyJson(parsePyJson('{}'), { indent: 2 })).toBe('{}');
    expect(dumpPyJson(parsePyJson('[]'), { indent: 2 })).toBe('[]');
    expect(dumpPyJson(parsePyJson('1.0'), { indent: 2 })).toBe('1.0');
  });

  it('adds exactly one LF for a file', () => {
    expect(pyJsonFileText(parsePyJson('{"a":1}'))).toBe('{\n  "a": 1\n}\n');
  });
});

describe('dumpPyJson compact', () => {
  it('uses the ", " and ": " separators of json.dumps', () => {
    expect(dumpPyJson(parsePyJson('{"a":1,"b":[1,2.0]}'), { compact: true })).toBe('{"a": 1, "b": [1, 2.0]}');
  });

  it('keeps non-ASCII text raw unless asciiOnly is set', () => {
    const value = parsePyJson(`["${String.fromCodePoint(0xe9, 0x1f600)}"]`);
    expect(dumpPyJson(value, { compact: true })).toBe(`["${String.fromCodePoint(0xe9, 0x1f600)}"]`);
    expect(dumpPyJson(value, { compact: true, asciiOnly: true })).toBe(`["${BS}u00e9${BS}ud83d${BS}ude00"]`);
  });
});

describe('numbers', () => {
  it('writes ints through BigInt and floats through pyFloatRepr', () => {
    const text = '[0, -0, 24, 24.0, 1e5, 1e16, 1e-5, 123456789012345678901234567890, 0.1]';
    expect(dumpPyJson(parsePyJson(text), { compact: true })).toBe(
      '[0, 0, 24, 24.0, 100000.0, 1e+16, 1e-05, 123456789012345678901234567890, 0.1]',
    );
  });

  it('writes the non-finite floats as the JSON tokens Python emits', () => {
    expect(dumpPyJson(parsePyJson('[NaN, Infinity, -Infinity]'), { compact: true })).toBe('[NaN, Infinity, -Infinity]');
  });
});

describe('escapePyString', () => {
  it('uses the short escapes and lowercase u00XX for other control characters', () => {
    const s = `${String.fromCharCode(8, 9, 10, 12, 13, 0, 31)}"${BS}`;
    expect(escapePyString(s, false)).toBe(`"${BS}b${BS}t${BS}n${BS}f${BS}r${BS}u0000${BS}u001f${BS}"${BS}${BS}"`);
  });

  it('leaves DEL, U+2028 and astral code points raw, and escapes them all in ASCII mode', () => {
    const s = String.fromCodePoint(0x7f, 0x2028, 0x1f600);
    expect(escapePyString(s, false)).toBe(`"${s}"`);
    expect(escapePyString(s, true)).toBe(`"${BS}u007f${BS}u2028${BS}ud83d${BS}ude00"`);
  });

  it('refuses a lone surrogate in UTF-8 mode and escapes it in ASCII mode', () => {
    const lone = String.fromCharCode(0xd800);
    expect(() => escapePyString(`a${lone}`, false)).toThrow(PyJsonEncodeError);
    expect(() => escapePyString(String.fromCharCode(0xdc00), false)).toThrow(PyJsonEncodeError);
    expect(escapePyString(lone, true)).toBe(`"${BS}ud800"`);
  });
});
