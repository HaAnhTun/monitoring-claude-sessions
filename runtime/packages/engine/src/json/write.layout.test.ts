// The file layout of `jsonFileText`, pinned by tables written by hand (not produced by the code under test). A change
// here rewrites every workspace file of every user, so each row is a promise (ADR 0067).
import { describe, expect, it } from 'vitest';

import { fromPlain } from './convert.ts';
import { parseJson } from './parse.ts';
import { jsonFileText } from './write.ts';

const BS = String.fromCharCode(92);
const LF = String.fromCharCode(10);

/** Lines joined with LF, plus the one trailing LF every file ends with. */
function file(...lines: string[]): string {
  return `${lines.join(LF)}${LF}`;
}

describe('jsonFileText layout', () => {
  const rows: [string, string, string][] = [
    ['empty object', '{}', file('{}')],
    ['empty array', '[]', file('[]')],
    ['one entry', '{"a":1}', file('{', '  "a": 1', '}')],
    ['two levels', '{"a":{"b":2}}', file('{', '  "a": {', '    "b": 2', '  }', '}')],
    ['array of scalars', '[1,"x",null,true]', file('[', '  1,', '  "x",', '  null,', '  true', ']')],
    [
      'nested empties stay inline',
      '{"a":[],"b":{},"c":[[],{}]}',
      file('{', '  "a": [],', '  "b": {},', '  "c": [', '    [],', '    {}', '  ]', '}'),
    ],
    [
      'array of objects',
      '[{"a":1},{"b":[2]}]',
      file('[', '  {', '    "a": 1', '  },', '  {', '    "b": [', '      2', '    ]', '  }', ']'),
    ],
    [
      'key order is the order of the document, integer-like keys included',
      '{"b":1,"10":2,"a":3,"2":4}',
      file('{', '  "b": 1,', '  "10": 2,', '  "a": 3,', '  "2": 4', '}'),
    ],
    [
      'a duplicate key keeps its first place and the last value',
      '{"a":1,"b":2,"a":3}',
      file('{', '  "a": 3,', '  "b": 2', '}'),
    ],
    ['a bare scalar still ends with one line feed', '"x"', file('"x"')],
    ['null', 'null', file('null')],
  ];
  it.each(rows)('%s', (_name, source, expected) => {
    expect(jsonFileText(parseJson(source))).toBe(expected);
  });

  it('ends with exactly one line feed and holds no carriage return', () => {
    const text = jsonFileText(parseJson('{"a":[1,{"b":null}],"c":"d"}'));
    expect(text.endsWith(`}${LF}`)).toBe(true);
    expect(text.endsWith(`${LF}${LF}`)).toBe(false);
    expect(text.includes('\r')).toBe(false);
  });
});

describe('jsonFileText numbers', () => {
  const rows: [string, string][] = [
    ['0', '0'],
    ['-0', '0'],
    ['24', '24'],
    ['-7', '-7'],
    ['24.0', '24.0'],
    ['1e5', '100000.0'],
    ['1E5', '100000.0'],
    ['0.1', '0.1'],
    ['-0.0', '-0.0'],
    ['1e16', '1e+16'],
    ['1.5e16', '1.5e+16'],
    ['9999999999999998.0', '9999999999999998.0'],
    ['0.0001', '0.0001'],
    ['0.00001', '1e-05'],
    ['1.5e-7', '1.5e-07'],
    ['1e100', '1e+100'],
    ['5e-324', '5e-324'],
    ['0.30000000000000004', '0.30000000000000004'],
    ['9007199254740993', '9007199254740993'],
    ['-123456789012345678901234567890', '-123456789012345678901234567890'],
  ];
  it.each(rows)('number %s is written as %s', (source, expected) => {
    expect(jsonFileText(parseJson(`[${source}]`))).toBe(file('[', `  ${expected}`, ']'));
  });

  it('keeps an integer and a float apart, also for a value built from plain data', () => {
    expect(jsonFileText(fromPlain({ a: 24, b: 2.5 }))).toBe(file('{', '  "a": 24,', '  "b": 2.5', '}'));
  });
});

describe('jsonFileText strings', () => {
  it('keeps non-ASCII text, U+2028 and astral code points as they are', () => {
    const text = `caf${String.fromCharCode(0xe9)} ${String.fromCharCode(0x2028)} ${String.fromCodePoint(0x1f600)}`;
    expect(jsonFileText({ k: 'str', v: text })).toBe(file(`"${text}"`));
  });

  it('writes the short escapes for quote, backslash and the five named control characters', () => {
    const text = `"${BS}${String.fromCharCode(8, 9, 10, 12, 13)}`;
    expect(jsonFileText({ k: 'str', v: text })).toBe(file(`"${BS}"${BS}${BS}${BS}b${BS}t${BS}n${BS}f${BS}r"`));
  });

  it('writes the other control characters as lowercase u00xx escapes', () => {
    const text = String.fromCharCode(0, 1, 0x1f);
    expect(jsonFileText({ k: 'str', v: text })).toBe(file(`"${BS}u0000${BS}u0001${BS}u001f"`));
  });

  it('leaves the forward slash and DEL unescaped', () => {
    const text = `a/b${String.fromCharCode(0x7f)}`;
    expect(jsonFileText({ k: 'str', v: text })).toBe(file(`"${text}"`));
  });

  it('writes a key with the same escaping as a value', () => {
    expect(jsonFileText({ k: 'obj', v: [[`a"b${String.fromCharCode(10)}`, { k: 'null' }]] })).toBe(
      file('{', `  "a${BS}"b${BS}n": null`, '}'),
    );
  });
});
