import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cloneDefault, sectionSchema } from './section.ts';

describe('cloneDefault (replaces structuredClone, which the shared build config has no lib for)', () => {
  it('returns primitives and null unchanged', () => {
    expect(cloneDefault(7)).toBe(7);
    expect(cloneDefault('a')).toBe('a');
    expect(cloneDefault(true)).toBe(true);
    expect(cloneDefault(null)).toBeNull();
  });

  it('copies nested arrays and objects at every level without sharing a reference', () => {
    const source = { a: [1, { b: [2, 3] }], c: { d: { e: null, f: 'x' } }, g: [] };
    const copy = cloneDefault(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
    expect(asRecord(copy)['a']).not.toBe(source.a);
    expect(asRecord(copy)['c']).not.toBe(source.c);
    expect(asRecord(asRecord(copy)['c'])['d']).not.toBe(source.c.d);
    expect(asRecord(copy)['g']).not.toBe(source.g);
  });

  it('leaves the source untouched when the copy is changed', () => {
    const source = { rules: { inactivity: { minutes: 30 } }, items: ['a'] };
    const copy = cloneDefault(source) as typeof source;
    copy.rules.inactivity.minutes = 999;
    copy.items.push('b');
    expect(source).toEqual({ rules: { inactivity: { minutes: 30 } }, items: ['a'] });
  });

  it('copies a frozen source into a mutable value', () => {
    const copy = cloneDefault(Object.freeze({ list: Object.freeze([1]) })) as { list: number[] };
    expect(Object.isFrozen(copy)).toBe(false);
    copy.list.push(2);
    expect(copy.list).toEqual([1, 2]);
  });

  it('keeps a key named __proto__ as an own data key and does not touch the prototype', () => {
    const source: unknown = JSON.parse('{"__proto__": {"polluted": true}, "k": 1}');
    const copy = cloneDefault(source) as Record<string, unknown>;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.hasOwn(copy, '__proto__')).toBe(true);
    expect(Object.hasOwn(copy, 'polluted')).toBe(false);
    expect(Object.getOwnPropertyDescriptor(copy, '__proto__')?.value).toEqual({ polluted: true });
  });

  it('refuses a value that is not JSON-like instead of copying it wrongly', () => {
    expect(() => cloneDefault(undefined)).toThrow(TypeError);
    expect(() => cloneDefault(() => 1)).toThrow(TypeError);
    expect(() => cloneDefault(new Date(0))).toThrow(TypeError);
    expect(() => cloneDefault(new Map())).toThrow(TypeError);
    expect(() => cloneDefault({ nested: [new Set()] })).toThrow(TypeError);
    expect(() => cloneDefault(1n)).toThrow(TypeError);
    expect(() => cloneDefault(Symbol('s'))).toThrow(TypeError);
  });
});

describe('sectionSchema defaults', () => {
  it('hands every parse a fresh copy of a nested default and never the key table value', () => {
    const keys = { rules: { schema: z.object({ a: z.object({ n: z.number() }) }), default: { a: { n: 1 } } } };
    const schema = sectionSchema(keys);
    const first = schema.parse({});
    first.rules.a.n = 99;
    const second = schema.parse({});
    expect(second.rules.a.n).toBe(1);
    expect(second.rules).not.toBe(first.rules);
    expect(keys.rules.default.a.n).toBe(1);
  });
});
