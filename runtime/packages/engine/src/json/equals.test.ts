import { describe, expect, it } from 'vitest';

import { jsonEquals } from './equals.ts';
import { parseJson } from './parse.ts';

function same(a: string, b: string): boolean {
  return jsonEquals(parseJson(a), parseJson(b));
}

describe('jsonEquals', () => {
  it('treats an int and a float of equal value as equal', () => {
    expect(same('1', '1.0')).toBe(true);
    expect(same('0', '-0.0')).toBe(true);
    expect(same('2', '2.5')).toBe(false);
    expect(same('"1"', '1')).toBe(false);
  });

  it('compares big integers and floats exactly', () => {
    expect(same('100000000000000000000', '1e20')).toBe(true);
    expect(same('9007199254740993', '9007199254740992.0')).toBe(false);
    expect(same('9007199254740992', '9007199254740992.0')).toBe(true);
    expect(same('1e300', '1e301')).toBe(false);
  });

  it('compares lists in order and dicts by key set', () => {
    expect(same('[1,2]', '[2,1]')).toBe(false);
    expect(same('[1]', '[1.0]')).toBe(true);
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

  it('never treats a boolean as a number', () => {
    expect(same('true', '1')).toBe(false);
    expect(same('false', '0')).toBe(false);
    expect(same('false', '0.0')).toBe(false);
    expect(same('[true]', '[1]')).toBe(false);
    expect(same('{"a": false}', '{"a": 0}')).toBe(false);
    expect(same('true', 'true')).toBe(true);
    expect(same('false', 'false')).toBe(true);
    expect(same('true', 'false')).toBe(false);
    expect(same('true', '"true"')).toBe(false);
  });
});
