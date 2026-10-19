// @vitest-environment node
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ArgsTuple, MessageArgs, MessageKey, PluralArgNames, PlaceholderNames } from './types.ts';
import { LOCALES } from './types.ts';

// The type-level half of the catalogue contract (ADR 0072 decision 1): the arguments of `t(key, args)` come from the
// placeholders of the English text. The catalogue of this work package has no placeholder yet, so the cases below use literal
// texts; the helpers take the text, not the key.
describe('placeholder types', () => {
  it('finds no placeholder in plain text', () => {
    expectTypeOf<PlaceholderNames<'Close'>>().toEqualTypeOf<never>();
    expectTypeOf<PlaceholderNames<''>>().toEqualTypeOf<never>();
  });

  it('finds simple placeholders in order of appearance and ignores the spaces inside braces', () => {
    expectTypeOf<PlaceholderNames<'Hello {name}'>>().toEqualTypeOf<'name'>();
    expectTypeOf<PlaceholderNames<'{a} and { b } and {c}'>>().toEqualTypeOf<'a' | 'b' | 'c'>();
  });

  it('finds the counter of a plural and skips the text of its forms', () => {
    type Text = '{count, plural, =0 {none} one {# error} other {# errors}} in {where}';
    expectTypeOf<PlaceholderNames<Text>>().toEqualTypeOf<'count' | 'where'>();
    expectTypeOf<PluralArgNames<Text>>().toEqualTypeOf<'count'>();
  });

  it('does not take a one-word form for a placeholder', () => {
    type Text = '{n, plural, zero {none} other {many}}';
    expectTypeOf<PlaceholderNames<Text>>().toEqualTypeOf<'n'>();
  });

  it('keeps the arguments of the keys of the catalogue consistent', () => {
    expectTypeOf<ArgsTuple<'common.close'>>().toEqualTypeOf<[args?: undefined]>();
    expectTypeOf<MessageArgs<'common.close'>>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<MessageKey>().toExtend<string>();
  });
});

describe('locales', () => {
  it('lists the supported locales, English first', () => {
    expect(LOCALES).toEqual(['en', 'vi']);
  });
});
