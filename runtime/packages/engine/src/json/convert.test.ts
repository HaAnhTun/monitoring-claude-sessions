import { describe, expect, it } from 'vitest';

import { fromPlain, toPlain } from './convert.ts';
import { parseJson } from './parse.ts';

describe('toPlain', () => {
  it('converts every kind', () => {
    const value = parseJson('{"a":[1,2.5,"x",null,true],"b":{"c":3}}');
    expect(toPlain(value)).toEqual({ a: [1, 2.5, 'x', null, true], b: { c: 3 } });
  });

  it('throws for an int beyond 2**53-1 and accepts the boundary', () => {
    expect(toPlain(parseJson('9007199254740991'))).toBe(9007199254740991);
    expect(toPlain(parseJson('-9007199254740991'))).toBe(-9007199254740991);
    expect(() => toPlain(parseJson('9007199254740992'))).toThrow(RangeError);
    expect(() => toPlain(parseJson('[-9007199254740992]'))).toThrow(RangeError);
  });

  it('keeps __proto__ as an own property', () => {
    const plain = toPlain(parseJson('{"__proto__":{"x":1}}'));
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect(Object.keys(plain as object)).toEqual(['__proto__']);
  });
});

describe('fromPlain', () => {
  it('maps whole numbers to int and fractions to float', () => {
    expect(fromPlain(24)).toEqual({ k: 'int', v: 24n });
    expect(fromPlain(24.5)).toEqual({ k: 'float', v: 24.5 });
    expect(fromPlain(Number.NaN)).toEqual({ k: 'float', v: Number.NaN });
    expect(fromPlain(5n)).toEqual({ k: 'int', v: 5n });
  });

  it('converts nested plain data and keeps entry order', () => {
    expect(fromPlain({ b: [true, null], a: 'x' })).toEqual({
      k: 'obj',
      v: [
        ['b', { k: 'arr', v: [{ k: 'bool', v: true }, { k: 'null' }] }],
        ['a', { k: 'str', v: 'x' }],
      ],
    });
  });

  it('skips undefined properties and refuses what JSON cannot hold', () => {
    expect(fromPlain({ a: 1, b: undefined })).toEqual({ k: 'obj', v: [['a', { k: 'int', v: 1n }]] });
    expect(() => fromPlain([undefined])).toThrow(TypeError);
    expect(() => fromPlain(() => 1)).toThrow(TypeError);
    expect(() => fromPlain(Symbol('s'))).toThrow(TypeError);
    expect(() => fromPlain(new Date(0))).toThrow(TypeError);
    expect(() => fromPlain(new Map())).toThrow(TypeError);
  });

  it('refuses a hole in a sparse array like an undefined element instead of dropping it silently', () => {
    const holes: unknown[] = [1];
    holes[2] = 3;
    expect(1 in holes).toBe(false);
    expect(() => fromPlain(holes)).toThrow(TypeError);
    expect(() => fromPlain({ a: holes })).toThrow(TypeError);
  });

  it('refuses a cycle instead of overflowing the stack', () => {
    const loop: unknown[] = [];
    loop.push(loop);
    expect(() => fromPlain(loop)).toThrow(TypeError);
  });

  it('round-trips toPlain for safe data', () => {
    const value = parseJson('{"a":[1,2,{"b":"c"}],"d":null}');
    expect(fromPlain(toPlain(value))).toEqual(value);
  });
});
