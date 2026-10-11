import { describe, expect, it } from 'vitest';

import { parsePyJson } from './parse.ts';
import { pyRepr, pyShort } from './repr.ts';

const BS = String.fromCharCode(92);

describe('pyShort', () => {
  it('returns the compact dump when it fits in 120 code points', () => {
    expect(pyShort(parsePyJson('{"a":1,"b":[1,2.0]}'))).toBe('{"a": 1, "b": [1, 2.0]}');
    const exactly = JSON.stringify('x'.repeat(118));
    expect(exactly.length).toBe(120);
    expect(pyShort(parsePyJson(exactly))).toBe(exactly);
  });

  it('cuts after 117 code points and appends three dots', () => {
    const text = JSON.stringify('x'.repeat(119));
    expect(pyShort(parsePyJson(text))).toBe(`${text.slice(0, 117)}...`);
  });

  it('counts code points, not UTF-16 units', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const sixty = emoji.repeat(59);
    const text = JSON.stringify(sixty);
    expect(Array.from(text).length).toBe(61);
    expect(pyShort(parsePyJson(text))).toBe(text);
    const long = JSON.stringify(emoji.repeat(130));
    expect(pyShort(parsePyJson(long))).toBe(`${Array.from(long).slice(0, 117).join('')}...`);
  });
});

describe('pyRepr', () => {
  it('uses single quotes by default', () => {
    expect(pyRepr('abc')).toBe("'abc'");
    expect(pyRepr('')).toBe("''");
  });

  it('switches to double quotes for a lone single quote, like Python', () => {
    expect(pyRepr("it's")).toBe('"it\'s"');
    expect(pyRepr('say "hi" it\'s')).toBe(`'say "hi" it${BS}'s'`);
    expect(pyRepr('"')).toBe(`'"'`);
  });

  it('escapes backslashes and the short control characters', () => {
    expect(pyRepr(`a${BS}b`)).toBe(`'a${BS}${BS}b'`);
    expect(pyRepr('\n\r\t')).toBe(`'${BS}n${BS}r${BS}t'`);
  });

  it('uses \\x, \\u and \\U escapes for non-printable code points', () => {
    expect(pyRepr(String.fromCharCode(0, 0x1f, 0x7f))).toBe(`'${BS}x00${BS}x1f${BS}x7f'`);
    expect(pyRepr(String.fromCharCode(0x80, 0xa0, 0xad))).toBe(`'${BS}x80${BS}xa0${BS}xad'`);
    expect(pyRepr(String.fromCharCode(0x2028, 0x3000, 0xfeff))).toBe(`'${BS}u2028${BS}u3000${BS}ufeff'`);
    expect(pyRepr(String.fromCodePoint(0xe0001, 0x10ffff))).toBe(`'${BS}U000e0001${BS}U0010ffff'`);
    expect(pyRepr(String.fromCharCode(0xd800))).toBe(`'${BS}ud800'`);
  });

  it('keeps printable non-ASCII text raw', () => {
    const text = `caf${String.fromCharCode(0xe9)} ${String.fromCodePoint(0x1f600)}`;
    expect(pyRepr(text)).toBe(`'${text}'`);
  });
});
