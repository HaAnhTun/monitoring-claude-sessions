import { describe, expect, it } from 'vitest';

import { translatePyRegex } from './translate.ts';
import type { PyRegexContext, TranslatedPattern } from './types.ts';

function ok(source: string, ctx: PyRegexContext = 'session_rule'): TranslatedPattern {
  const result = translatePyRegex(source, ctx);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function fail(source: string, ctx: PyRegexContext = 'session_rule') {
  const result = translatePyRegex(source, ctx);
  if (result.ok) throw new Error(`accepted ${JSON.stringify(source)} as ${result.value.jsSource}`);
  return result.error;
}

describe('translatePyRegex result shape', () => {
  it('describes a search pattern', () => {
    expect(ok('abc')).toEqual({
      source: 'abc',
      jsSource: 'abc',
      jsFlags: 'v',
      groupCount: 0,
      groupNames: [],
      mode: 'search',
    });
  });

  it('uses the sticky flag and match mode for attempts', () => {
    const t = ok('abc', 'attempts');
    expect(t.jsFlags).toBe('vy');
    expect(t.mode).toBe('match');
  });

  it('adds the i flag for a leading (?i) and keeps the flag order canonical', () => {
    expect(ok('(?i)abc').jsFlags).toBe('iv');
    expect(ok('(?i)abc', 'attempts').jsFlags).toBe('ivy');
  });

  it('counts capture groups and lists group names in definition order', () => {
    const t = ok('(a)(?P<x>b)(?:c)(?P<y>d)((e))');
    expect(t.groupCount).toBe(5);
    expect(t.groupNames).toEqual(['x', 'y']);
  });
});

describe('literal emission', () => {
  it('writes [A-Za-z0-9_] raw and every other code point as a braced escape', () => {
    expect(ok('a-b_9').jsSource).toBe(String.raw`a\u{2d}b_9`);
    expect(ok(String.fromCodePoint(0xe9, 0x1f600)).jsSource).toBe(String.raw`\u{e9}\u{1f600}`);
    expect(ok(String.raw`\.\[\(`).jsSource).toBe(String.raw`\u{2e}\u{5b}\u{28}`);
  });

  it('keeps a brace that does not form a quantifier as a literal', () => {
    expect(ok('a{').jsSource).toBe(String.raw`a\u{7b}`);
    expect(ok('a{}').jsSource).toBe(String.raw`a\u{7b}\u{7d}`);
    expect(ok('a{b}').jsSource).toBe(String.raw`a\u{7b}b\u{7d}`);
    expect(ok('a{1,x}').jsSource).toBe(String.raw`a\u{7b}1\u{2c}x\u{7d}`);
  });

  it('decodes the str-pattern escapes', () => {
    expect(ok(String.raw`\x41\u0042\U00000043\n\t`).jsSource).toBe(String.raw`ABC\u{a}\u{9}`);
    expect(ok(String.raw`\0\012\101\377`).jsSource).toBe(String.raw`\u{0}\u{a}A\u{ff}`);
  });
});

describe('dot, anchors and line semantics', () => {
  it('emulates the Python dot: only LF is excluded unless DOTALL', () => {
    expect(ok('a.b', 'attempts').jsSource).toBe(String.raw`a[^\n]b`);
    expect(ok('a.b', 'session_rule').jsSource).toBe(String.raw`a[\s\S]b`);
    expect(ok('(?s)a.b', 'attempts').jsSource).toBe(String.raw`a[\s\S]b`);
  });

  it('emulates ^ and $ without the JS m flag', () => {
    expect(ok('^a$', 'attempts').jsSource).toBe(String.raw`(?<![\s\S])a(?=\n?(?![\s\S]))`);
    expect(ok('(?m)^a$', 'attempts').jsSource).toBe(String.raw`(?:(?<![\s\S])|(?<=\n))a(?=\n|(?![\s\S]))`);
    expect(ok(String.raw`\Aa\Z`, 'attempts').jsSource).toBe(String.raw`(?<![\s\S])a(?![\s\S])`);
  });

  it('never emits the JS m or s flags', () => {
    for (const source of ['(?m)^a', '(?s).', '(?ms)^.$']) expect(ok(source).jsFlags).toBe('v');
  });
});

describe('classes', () => {
  it('maps \\d, \\w and \\s to Unicode classes and \\b to lookarounds on \\w', () => {
    expect(ok(String.raw`\d`).jsSource).toBe(String.raw`[\p{Nd}]`);
    expect(ok(String.raw`\D`).jsSource).toBe(String.raw`[^\p{Nd}]`);
    expect(ok(String.raw`\w`).jsSource).toBe(String.raw`[\p{L}\p{N}_]`);
    expect(ok(String.raw`\W`).jsSource).toBe(String.raw`[^\p{L}\p{N}_]`);
    expect(ok(String.raw`\s`).jsSource).toBe(
      String.raw`[\u{9}-\u{d}\u{1c}-\u{20}\u{85}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]`,
    );
    const w = String.raw`[\p{L}\p{N}_]`;
    expect(ok(String.raw`\b`).jsSource).toBe(`(?:(?<=${w})(?!${w})|(?<!${w})(?=${w}))`);
    expect(ok(String.raw`\B`).jsSource).toBe(`(?:(?<=${w})(?=${w})|(?<!${w})(?!${w}))`);
  });

  it('switches to ASCII classes under the a flag', () => {
    expect(ok(String.raw`(?a)\d\w\s`).jsSource).toBe(String.raw`[0-9][A-Za-z0-9_][\u{9}-\u{d}\u{20}]`);
    expect(ok(String.raw`(?a:\d)\d`).jsSource).toBe(String.raw`(?:[0-9])[\p{Nd}]`);
  });

  it('emits sets with nested classes and braced escapes', () => {
    expect(ok('[a-z_]').jsSource).toBe('[a-z_]');
    expect(ok('[^abc]').jsSource).toBe('[^abc]');
    expect(ok('[]a]').jsSource).toBe(String.raw`[\u{5d}a]`);
    expect(ok('[a-]').jsSource).toBe(String.raw`[a\u{2d}]`);
    expect(ok(String.raw`[\d.]`).jsSource).toBe(String.raw`[\p{Nd}\u{2e}]`);
    expect(ok(String.raw`[\D\W]`).jsSource).toBe(String.raw`[[^\p{Nd}][^\p{L}\p{N}_]]`);
    expect(ok(String.raw`[\b]`).jsSource).toBe(String.raw`[\u{8}]`);
  });
});

describe('groups, quantifiers and flags', () => {
  it('translates named groups and backreferences', () => {
    expect(ok('(?P<n>a)(?P=n)').jsSource).toBe(String.raw`(?<n>a)(?:\1)`);
    expect(ok(String.raw`(a)(b)\2\1`).jsSource).toBe(String.raw`(a)(b)(?:\2)(?:\1)`);
  });

  it('wraps a repeated multi-token body and keeps lazy suffixes', () => {
    expect(ok('(?:ab)+').jsSource).toBe('(?:ab)+');
    expect(ok('a*?').jsSource).toBe('a*?');
    expect(ok('a{2,3}?').jsSource).toBe('a{2,3}?');
    expect(ok('a{,3}').jsSource).toBe('a{0,3}');
    expect(ok('a{2,}').jsSource).toBe('a{2,}');
    expect(ok('a{,}').jsSource).toBe('a*');
    expect(ok('a{0}').jsSource).toBe('a{0}');
  });

  it('removes comments and keeps a repeat after a comment on the previous item', () => {
    expect(ok('a(?#note)b').jsSource).toBe('ab');
    expect(ok('a(?#note)*').jsSource).toBe('a*');
  });

  it('translates lookarounds', () => {
    expect(ok('a(?=b)(?!c)').jsSource).toBe('a(?=b)(?!c)');
    expect(ok('(?<=a)(?<!b)c').jsSource).toBe('(?<=a)(?<!b)c');
  });

  it('expands letters by hand when a scoped group switches IGNORECASE (no i flag, no modifiers)', () => {
    const scoped = ok('(?i:a)b');
    expect(scoped.jsSource).toBe('(?:[aA])b');
    expect(scoped.jsFlags).toBe('v');
    const nested = ok('(?i)a(?-i:b)c');
    expect(nested.jsSource).toBe('[aA](?:b)[cC]');
    expect(nested.jsFlags).toBe('v');
    expect(ok('(?i:[a-c]x)y').jsSource).toBe('(?:[a-cA-C][xX])y');
    expect(ok('(?i:[^k])').jsSource).toBe(String.raw`(?:[^kK\u{212a}])`);
    expect(ok('(?i:[J-L])').jsSource).toBe(String.raw`(?:[J-Lj-l\u{212a}])`);
  });

  it('keeps a global (?i) as the JavaScript i flag when no scope switches the case mode', () => {
    expect(ok('(?i)(?i:a)b').jsFlags).toBe('iv');
    expect(ok('(?i)(?i:a)b').jsSource).toBe('(?:a)b');
    expect(ok('(?s:.)a(?-s:.)').jsSource).toBe(String.raw`(?:[\s\S])a(?:[^\n])`);
  });

  it('adds U+0130 and U+0131 wherever IGNORECASE letter i or I is matched', () => {
    expect(ok('(?i)i').jsSource).toBe(String.raw`[iI\u{130}\u{131}]`);
    expect(ok('(?i)[^i]').jsSource).toBe(String.raw`[^i\u{130}\u{131}]`);
    expect(ok('(?i)[h-j]').jsSource).toBe(String.raw`[h-j\u{130}\u{131}]`);
    expect(ok('(?i)[a-c]').jsSource).toBe('[a-c]');
    expect(ok('(?i:i)i').jsSource).toBe(String.raw`(?:[iI\u{130}\u{131}])i`);
  });
});

describe('uppercase ASCII letters under a scoped IGNORECASE switch (manual case expansion)', () => {
  it('expands an uppercase literal to its lowercase letter, itself and the extras', () => {
    expect(ok('(?i:A)b').jsSource).toBe('(?:[aA])b');
    expect(ok('(?i:K)b').jsSource).toBe(String.raw`(?:[kK\u{212a}])b`);
    expect(ok('(?i:S)b').jsSource).toBe(String.raw`(?:[sS\u{17f}])b`);
    expect(ok('(?i:I)b').jsSource).toBe(String.raw`(?:[iI\u{130}\u{131}])b`);
    expect(ok('(?i:Z)').jsFlags).toBe('v');
  });

  it('expands an uppercase letter that a case-sensitive scope of an (?i) pattern leaves alone', () => {
    expect(ok('(?i)(?-i:K)(?i:S)').jsSource).toBe(String.raw`(?:K)(?:[sS\u{17f}])`);
    expect(ok('(?i)A(?-i:B)').jsSource).toBe(String.raw`[aA](?:B)`);
  });

  it('expands uppercase set items and ranges', () => {
    expect(ok('(?i:[K])').jsSource).toBe(String.raw`(?:[kK\u{212a}])`);
    expect(ok('(?i:[A-C])').jsSource).toBe('(?:[A-Ca-c])');
    expect(ok('(?i:[Q-T])').jsSource).toBe(String.raw`(?:[Q-Tq-t\u{17f}])`);
    expect(ok('(?i:[^A])').jsSource).toBe('(?:[^aA])');
  });
});

describe('IGNORECASE with the word class (U+0345 does not fold into \\w for Python)', () => {
  it('emits no i flag when a global (?i) meets \\w, \\W, \\b, \\B or a set with \\w', () => {
    for (const source of [
      String.raw`(?i)\w`,
      String.raw`(?i)\W`,
      String.raw`(?i)\b`,
      String.raw`(?i)\B`,
      String.raw`(?i)[\w]`,
      String.raw`(?i)[^\W]`,
      String.raw`(?i)a\b`,
    ]) {
      expect(ok(source).jsFlags, source).toBe('v');
    }
    expect(ok(String.raw`(?i)\w`, 'attempts').jsFlags).toBe('vy');
  });

  it('keeps the i flag for a global (?i) that has no word class and expands the letters by hand elsewhere', () => {
    expect(ok(String.raw`(?i)\d`).jsFlags).toBe('iv');
    expect(ok(String.raw`(?i)\s`).jsFlags).toBe('iv');
    expect(ok(String.raw`(?i)abc`).jsFlags).toBe('iv');
    expect(ok(String.raw`\w`).jsFlags).toBe('v');
    expect(ok(String.raw`(?i)\wa`).jsSource).toBe(String.raw`[\p{L}\p{N}_][aA]`);
  });

  it('does not change a scoped (?i:...) around \\w that the pattern already expands by hand', () => {
    expect(ok(String.raw`(?i:\w)`).jsFlags).toBe('v');
  });
});

describe('scoped ASCII and Unicode switches under re.search (CPython pre-filter quirk)', () => {
  it.each([
    String.raw`(?a:\S)x`,
    String.raw`(?a:\D)`,
    String.raw`(?a:\W)`,
    String.raw`(?a:[^\d])`,
    String.raw`(?a:[\S])`,
    String.raw`(?a:x\S)`,
    String.raw`(?a:(?:\S))`,
    String.raw`(?a)(?u:\d)`,
    String.raw`(?a)(?u:\w)`,
    String.raw`(?a)(?u:x)`,
    String.raw`(?a:(?u:\d))`,
  ])('refuses %s with INEXACT_SEMANTICS that names the search pre-filter', (source) => {
    const error = fail(source, 'session_rule');
    expect(error.code).toBe('INEXACT_SEMANTICS');
    expect(error.message).toContain('pre-filter');
  });

  it.each([String.raw`(?a:\S)x`, String.raw`(?a)(?u:\d)`, String.raw`(?a:\W)`])('accepts %s for attempts', (source) => {
    expect(ok(source, 'attempts').mode).toBe('match');
  });

  it.each([
    String.raw`(?a:\w)\w`,
    String.raw`\w(?a:\w)`,
    String.raw`(?a:\d)`,
    String.raw`(?a:\s+)`,
    String.raw`(?a:x)y`,
    String.raw`(?a)(?a:\S)`,
    String.raw`(?u)(?u:\S)`,
    String.raw`(?u)\S(?a:\d)`,
    String.raw`(?a)\S`,
  ])('accepts %s for search (the pre-filter is a superset or the switch does not change the type)', (source) => {
    expect(ok(source, 'session_rule').mode).toBe('search');
  });
});

describe('rejections', () => {
  it('refuses verbose and locale flags', () => {
    expect(fail('(?x)a b').code).toBe('UNSUPPORTED_FLAG');
    expect(fail('(?L)a').code).toBe('UNSUPPORTED_FLAG');
    expect(fail('(?x:a)').code).toBe('UNSUPPORTED_FLAG');
  });

  it('refuses global flags that are not at the start', () => {
    expect(fail('a(?i)b').code).toBe('SYNTAX');
  });

  it('refuses \\Z lookalikes and Unicode names', () => {
    expect(fail(String.raw`\z`).code).toBe('UNSUPPORTED_CONSTRUCT');
    expect(fail(String.raw`\N{DASH}`).code).toBe('UNSUPPORTED_CONSTRUCT');
  });

  it('refuses possessive quantifiers, atomic groups and conditionals', () => {
    expect(fail('a*+').code).toBe('UNSUPPORTED_CONSTRUCT');
    expect(fail('(?>a)').code).toBe('UNSUPPORTED_CONSTRUCT');
    expect(fail('(a)(?(1)b|c)').code).toBe('UNSUPPORTED_CONSTRUCT');
  });

  it('refuses captures that an iteration can skip and loops over empty bodies', () => {
    expect(fail('(?:(a)|b)+').code).toBe('INEXACT_SEMANTICS');
    expect(fail('(?:a*)*').code).toBe('INEXACT_SEMANTICS');
    expect(fail('(?:|a)+').code).toBe('INEXACT_SEMANTICS');
  });

  it('refuses backreferences to groups that may not have taken part', () => {
    expect(fail(String.raw`(?:(a)|b)\1`).code).toBe('INEXACT_SEMANTICS');
    expect(fail(String.raw`(a)?\1`).code).toBe('INEXACT_SEMANTICS');
    expect(ok(String.raw`(a)\1`).groupCount).toBe(1);
    expect(ok(String.raw`(?:(a)b)+\1`).groupCount).toBe(1);
  });

  it('refuses IGNORECASE with non-ASCII literals and ranges', () => {
    expect(fail('(?i)' + String.fromCodePoint(0xe9)).code).toBe('INEXACT_SEMANTICS');
    expect(fail('(?i)[a-' + String.fromCodePoint(0xe9) + ']').code).toBe('INEXACT_SEMANTICS');
    expect(ok(String.fromCodePoint(0xe9)).groupCount).toBe(0);
  });

  it('reports the position of the offending token in code points', () => {
    expect(fail('*a').position).toBe(0);
    expect(fail('a**').position).toBe(2);
    expect(fail('(a').code).toBe('SYNTAX');
    expect(fail('(a').message).toContain('missing )');
    expect(fail(String.fromCodePoint(0x1f600) + '*' + '*').position).toBe(2);
  });

  it('refuses a pattern nested deeper than the parser limit instead of overflowing the stack', () => {
    const error = fail('('.repeat(400) + 'a' + ')'.repeat(400));
    expect(error.code).toBe('UNSUPPORTED_CONSTRUCT');
    expect(error.message).toContain('nested too deeply');
    expect(ok('('.repeat(100) + 'a' + ')'.repeat(100)).groupCount).toBe(100);
  });

  it('uses a documented limit, not SYNTAX, for valid Python that the translator refuses', () => {
    expect(fail('(?=a)*').code).toBe('UNSUPPORTED_CONSTRUCT');
    expect(fail('(?!a)+').code).toBe('UNSUPPORTED_CONSTRUCT');
    expect(fail('(?<=a)*b').code).toBe('UNSUPPORTED_CONSTRUCT');
    expect(fail('(?=a)*').message).toContain('lookaround');
    expect(fail('^*').code).toBe('SYNTAX');
  });

  it('forces the compilation of the translated pattern so that a V8 stack overflow is refused here', () => {
    const error = fail('(' + 'a?'.repeat(20000) + ')');
    expect(error.code).toBe('JS_COMPILE');
    expect(error.message).not.toContain('a?a?');
    expect(ok('(' + 'a?'.repeat(200) + ')').groupCount).toBe(1);
  });

  it('translates a very long literal pattern that V8 can compile and refuses one that it cannot (instead of failing on every later exec)', () => {
    expect(ok('a'.repeat(20000)).jsSource.length).toBe(20000);
    expect(fail('a'.repeat(50000)).code).toBe('JS_COMPILE');
  });

  it('refuses a lone surrogate in the pattern', () => {
    expect(fail('a' + String.fromCharCode(0xd800)).code).toBe('SYNTAX');
  });
});
