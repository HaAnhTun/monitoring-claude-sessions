import { describe, expect, it } from 'vitest';

import { pyEquals } from './equals.ts';
import { parsePyJson } from './parse.ts';

function same(a: string, b: string): boolean {
  return pyEquals(parsePyJson(a), parsePyJson(b));
}

describe('pyEquals', () => {
  it('treats int, float and bool as numbers', () => {
    expect(same('1', '1.0')).toBe(true);
    expect(same('1', 'true')).toBe(true);
    expect(same('0', 'false')).toBe(true);
    expect(same('0', '-0.0')).toBe(true);
    expect(same('2', '2.5')).toBe(false);
    expect(same('"1"', '1')).toBe(false);
  });

  it('compares big integers and floats exactly', () => {
    expect(same('100000000000000000000', '1e20')).toBe(true);
    expect(same('9007199254740993', '9007199254740992.0')).toBe(false);
    expect(same('9007199254740992', '9007199254740992.0')).toBe(true);
    expect(same('1e999', 'Infinity')).toBe(true);
    expect(same('1e400', '123')).toBe(false);
  });

  it('compares lists in order and dicts by key set', () => {
    expect(same('[1,2]', '[2,1]')).toBe(false);
    expect(same('[1]', '[true]')).toBe(true);
    expect(same('{"a":1,"b":2}', '{"b":2,"a":1}')).toBe(true);
    expect(same('{"a":1}', '{"a":1,"b":2}')).toBe(false);
    expect(same('{"a":[1,{"b":2}]}', '{"a":[1.0,{"b":2.0}]}')).toBe(true);
    expect(same('[]', '{}')).toBe(false);
  });

  it('keeps null apart from every other value', () => {
    expect(same('null', 'null')).toBe(true);
    expect(same('null', '0')).toBe(false);
    expect(same('null', 'false')).toBe(false);
    expect(same('[null]', '[0]')).toBe(false);
  });

  it('never equates NaN with anything', () => {
    expect(same('NaN', 'NaN')).toBe(false);
    expect(same('[NaN]', '[1]')).toBe(false);
  });
});
