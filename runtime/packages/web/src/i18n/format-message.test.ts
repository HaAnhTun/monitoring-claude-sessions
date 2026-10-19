// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  MessageArgumentError,
  MessageSyntaxError,
  formatMessage,
  messageArguments,
  parseMessage,
} from './format-message.ts';
import type { Locale } from './types.ts';

const LOCALES_UNDER_TEST: readonly Locale[] = ['en', 'vi'];

/** A number the way the locale writes it, built from the locale argument. */
function n(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

describe('formatMessage: interpolation', () => {
  it('returns plain text unchanged, apostrophes and quotes included', () => {
    expect(formatMessage('It\'s a "plain" text, 100% # fine.', undefined, 'en')).toBe(
      'It\'s a "plain" text, 100% # fine.',
    );
    expect(formatMessage('', undefined, 'en')).toBe('');
  });

  it('replaces {name} with a string argument, also repeated and with spaces inside the braces', () => {
    expect(formatMessage('Hello {name}, bye {name}', { name: 'Ada' }, 'en')).toBe('Hello Ada, bye Ada');
    expect(formatMessage('{ a }-{b}', { a: 'x', b: 'y' }, 'en')).toBe('x-y');
  });

  it('formats a number argument for the locale and leaves a string argument alone', () => {
    for (const locale of LOCALES_UNDER_TEST) {
      expect(formatMessage('{total} items', { total: 1234567.5 }, locale)).toBe(`${n(locale, 1234567.5)} items`);
    }
    expect(formatMessage('{total} items', { total: '1234567.5' }, 'vi')).toBe('1234567.5 items');
  });

  it('does not interpret braces or markup inside an argument value', () => {
    expect(formatMessage('{x}', { x: '{y} {z, plural, other {#}} <b>' }, 'en')).toBe('{y} {z, plural, other {#}} <b>');
  });

  it('treats a pound sign outside a plural as text', () => {
    expect(formatMessage('Item #{id}', { id: 7 }, 'en')).toBe('Item #7');
  });
});

describe('formatMessage: plural', () => {
  const text = '{count, plural, =0 {No errors} one {# error} other {# errors}}';

  it('picks the form by the plural category of the locale and prints the number with #', () => {
    expect(formatMessage(text, { count: 1 }, 'en')).toBe('1 error');
    expect(formatMessage(text, { count: 2 }, 'en')).toBe('2 errors');
    expect(formatMessage(text, { count: 1234 }, 'en')).toBe(`${n('en', 1234)} errors`);
  });

  it('lets an exact =N form win over the category', () => {
    expect(formatMessage(text, { count: 0 }, 'en')).toBe('No errors');
    expect(formatMessage('{c, plural, =1 {just one} one {# one} other {# others}}', { c: 1 }, 'en')).toBe('just one');
  });

  it('falls back to other when the category has no form', () => {
    expect(formatMessage('{c, plural, one {# thing} other {# things}}', { c: 0 }, 'en')).toBe('0 things');
    expect(formatMessage('{c, plural, zero {none} other {# things}}', { c: 0 }, 'en')).toBe('0 things');
  });

  it('uses only other in Vietnamese, which has one plural category', () => {
    const vi = '{c, plural, one {# item} other {# item}}';
    for (const count of [0, 1, 2, 1000]) {
      expect(formatMessage(vi, { c: count }, 'vi')).toBe(`${n('vi', count)} item`);
    }
    expect(formatMessage('{c, plural, one {single} other {many}}', { c: 1 }, 'vi')).toBe('many');
  });

  it('formats the pound sign for the locale (decimal comma in Vietnamese)', () => {
    expect(formatMessage('{c, plural, other {# units}}', { c: 1234.5 }, 'vi')).toBe(`${n('vi', 1234.5)} units`);
  });

  it('accepts the number as a counter next to other placeholders, with spaces around the commas', () => {
    expect(formatMessage('{ n , plural , one {# row} other {# rows} } in {where}', { n: 3, where: 'A' }, 'en')).toBe(
      '3 rows in A',
    );
    expect(formatMessage('{n, plural, one{# row} other{# rows}}', { n: 1 }, 'en')).toBe('1 row');
  });

  it('copes with a negative, fractional, huge, infinite and NaN counter', () => {
    const rules = new Intl.PluralRules('en');
    for (const count of [-1, -2, 0.5, 1.5, 1e21, Number.MAX_SAFE_INTEGER * 4, Infinity, -Infinity, NaN]) {
      const expected = rules.select(count) === 'one' ? 'one' : 'other';
      const form = formatMessage('{c, plural, one {one:#} other {other:#}}', { c: count }, 'en');
      expect(form.startsWith(`${expected}:`)).toBe(true);
      expect(form).toBe(`${expected}:${n('en', count)}`);
    }
  });

  it('allows an empty form', () => {
    expect(formatMessage('a{c, plural, =0 {} other {b}}c', { c: 0 }, 'en')).toBe('ac');
  });
});

describe('formatMessage: arguments', () => {
  it('rejects a missing argument in strict mode, naming it', () => {
    expect(() => formatMessage('Hello {name}', {}, 'en')).toThrow(MessageArgumentError);
    expect(() => formatMessage('Hello {name}', undefined, 'en')).toThrow(/name/);
    expect(() => formatMessage('{c, plural, other {#}}', { d: 1 }, 'en')).toThrow(/"c"/);
  });

  it('writes nothing for a missing argument in lenient mode', () => {
    expect(formatMessage('Hello {name}!', {}, 'en', { strict: false })).toBe('Hello !');
    expect(formatMessage('{c, plural, other {# rows}}', {}, 'en', { strict: false })).toBe('');
  });

  it('rejects an argument of the wrong type', () => {
    for (const value of [null, undefined, true, {}, [], () => 1, 10n]) {
      expect(() => formatMessage('{x}', { x: value }, 'en')).toThrow(MessageArgumentError);
    }
    expect(() => formatMessage('{c, plural, other {#}}', { c: '3' }, 'en')).toThrow(MessageArgumentError);
    expect(formatMessage('{x}', { x: null }, 'en', { strict: false })).toBe('');
  });

  it('only reads own properties: names like constructor, toString and __proto__ are ordinary names', () => {
    expect(() => formatMessage('{constructor}', {}, 'en')).toThrow(MessageArgumentError);
    expect(() => formatMessage('{toString}', {}, 'en')).toThrow(MessageArgumentError);
    expect(() => formatMessage('{hasOwnProperty}', {}, 'en')).toThrow(MessageArgumentError);
    expect(() => formatMessage('{__proto__}', {}, 'en')).toThrow(MessageArgumentError);
    expect(formatMessage('{constructor}/{toString}', { constructor: 'c', toString: 't' }, 'en')).toBe('c/t');
    const own = JSON.parse('{"__proto__": "p"}') as Record<string, unknown>;
    expect(formatMessage('{__proto__}', own, 'en')).toBe('p');
    expect(formatMessage('{constructor, plural, one {# a} other {# b}}', { constructor: 1 }, 'en')).toBe('1 a');
  });

  it('is not fooled by a polluted prototype', () => {
    const args = Object.create({ name: 'inherited' }) as Record<string, unknown>;
    expect(() => formatMessage('{name}', args, 'en')).toThrow(MessageArgumentError);
  });
});

describe('parseMessage: malformed syntax is rejected', () => {
  const malformed: readonly [string, string][] = [
    ['an unterminated plural header', '{count, plural,'],
    ['an unterminated plural form', '{count, plural, one {# error'],
    ['a plural without other', '{count, plural, one {# error}}'],
    ['a plural without forms', '{count, plural, }'],
    ['an unterminated argument', 'Hello {name'],
    ['an empty argument', 'Hello {}'],
    ['a stray closing brace', 'Hello } there'],
    ['a stray opening brace', 'Hello { there'],
    ['an argument name with a space', '{two words}'],
    ['an argument name that starts with a digit', '{1st}'],
    ['an argument name with a dash', '{my-arg}'],
    ['select', '{kind, select, a {x} other {y}}'],
    ['a number type', '{n, number}'],
    ['an unknown selector', '{n, plural, several {x} other {y}}'],
    ['an invalid exact selector', '{n, plural, =x {a} other {b}}'],
    ['an exact selector without digits', '{n, plural, = {a} other {b}}'],
    ['a duplicate form', '{n, plural, one {a} one {b} other {c}}'],
    ['a duplicate exact form', '{n, plural, =1 {a} =1 {b} other {c}}'],
    ['a nested argument in a form', '{n, plural, one {# of {total}} other {#}}'],
    ['a nested plural', '{n, plural, other {{m, plural, other {#}}}}'],
    ['text after the plural keyword', '{n, plural extra, other {#}}'],
    ['a missing comma after the plural keyword', '{n, plural other {#}}'],
    ['a form without braces', '{n, plural, other text}'],
  ];

  it.each(malformed)('rejects %s', (_label, source) => {
    expect(() => parseMessage(source)).toThrow(MessageSyntaxError);
    expect(() => formatMessage(source, { name: 'x', count: 1, n: 1 }, 'en')).toThrow(MessageSyntaxError);
  });

  it('reports the position of the error', () => {
    try {
      parseMessage('ok {name');
      expect.unreachable('a message with an unterminated argument parsed');
    } catch (error) {
      expect(error).toBeInstanceOf(MessageSyntaxError);
      if (error instanceof MessageSyntaxError) expect(error.position).toBeGreaterThan(2);
    }
  });
});

describe('messageArguments', () => {
  it('lists the arguments and tells the plural counters', () => {
    const args = messageArguments('{a} {count, plural, one {# row} other {# rows}} {a} {b}');
    expect([...args.entries()].sort()).toEqual([
      ['a', false],
      ['b', false],
      ['count', true],
    ]);
  });

  it('marks a name used both ways as a plural counter and finds none in plain text', () => {
    expect(messageArguments('{n} {n, plural, other {#}}').get('n')).toBe(true);
    expect(messageArguments('Plain text').size).toBe(0);
  });

  it('accepts a very long message and many arguments', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `{a${String(i)}}`).join(' ');
    expect(messageArguments(many).size).toBe(2000);
    const long = 'word '.repeat(50000);
    expect(formatMessage(long, undefined, 'en')).toBe(long);
  });
});
