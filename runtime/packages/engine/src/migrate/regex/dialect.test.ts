// WP-138: the readable emission of the regex translator (ADR 0067, design 01 section 2.8). A migrated configuration has to
// read like a pattern a person wrote: printable characters stay literal, groups use the JavaScript syntax and the Python
// meanings of `$`, `\d`, `\w`, `\s` and `\b` are spelled out. Every text is also read through `compileRegex`, because the
// point of each row is that the text means what the Python pattern meant. The CPython proof of the same texts is the
// frozen corpus in `test/regex-translator.slow.test.ts`.
import { describe, expect, it } from 'vitest';

import { compileRegex } from '../../regex/index.ts';
import { parsePyRegex } from './parser.ts';
import { translateToDialect } from './translate.ts';
import type { DialectPattern, PyRegexContext } from './types.ts';

const BS = '\\';
/** Characters that need a backslash outside a class (the JavaScript syntax characters). */
const SYNTAX = '^$\\.*+?()[]{}|';
/** Characters that need a backslash inside a `v`-mode class. */
const CLASS_SYNTAX = '()[]{}/-\\|';
/** The punctuators that form a reserved double (`&&`, `!!`, ...) inside a `v`-mode class. */
const CLASS_DOUBLES = '&!#$%*+,.:;<=>?@^`~';
/** The members of Python's Unicode `\s` (29 code points), as the dialect writes them. */
const SPACE_MEMBERS = String.raw`\u{9}-\u{d}\u{1c}-\u{20}\u{85}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}`;

function ok(source: string, ctx: PyRegexContext): DialectPattern {
  const result = translateToDialect(source, ctx);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function run(
  source: string,
  ctx: PyRegexContext,
  input: string,
): { span: [number, number]; groups: (string | null)[] } | null {
  const m = compileRegex(ok(source, ctx).text, ctx).exec(input);
  return m === null ? null : { span: [m.start, m.end], groups: m.groups() };
}

function cp(...codes: number[]): string {
  return String.fromCodePoint(...codes);
}

/** Printable ASCII characters that are not letters or digits (a backslash before one of them is a plain escape in Python). */
function punctuators(): string[] {
  const found: string[] = [];
  for (let code = 0x20; code <= 0x7e; code++) {
    const c = String.fromCharCode(code);
    if (!/[A-Za-z0-9]/.test(c)) found.push(c);
  }
  return found;
}

const ATTEMPTS = '^(?P<time>[0-9:]{8}) JOB (?P<part>[A-Z0-9]+) END code=(?P<exit>[0-9]+)';
const START =
  '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB (?P<part>[A-Z0-9]+) BEGIN try (?P<n>[0-9]+) model (?P<model>[a-z]+) effort (?P<effort>[a-z]+)';
const END =
  '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB (?P<part>[A-Z0-9]+) END code=(?P<exit>[0-9]+) state=(?P<status>[A-Z ]+)';

describe('a V9-shaped pattern', () => {
  it('changes only the group syntax of an attempts pattern with named groups', () => {
    for (const source of [ATTEMPTS, START, END]) {
      expect(ok(source, 'attempts').text).toBe(source.replaceAll('(?P<', '(?<'));
    }
  });

  it('is kept as written for a session rule that uses a dot, a lazy quantifier and plain groups', () => {
    for (const source of ['run-job[.]md.*?PART=([A-Z0-9]+)', 'first.+second.+third', '^[A-Z][a-z]+ [a-z]+ [0-9]{3}']) {
      expect(ok(source, 'session_rule').text).toBe(source);
    }
  });

  it('keeps the group count and the group names of the parsed Python pattern', () => {
    for (const ctx of ['session_rule', 'attempts'] as const) {
      for (const source of [ATTEMPTS, START, END]) {
        const parsed = parsePyRegex(source, ctx);
        const t = ok(source, ctx);
        const compiled = compileRegex(t.text, ctx);
        expect(t.groupCount).toBe(parsed.groupCount);
        expect(t.groupNames).toEqual(parsed.groupNames);
        expect(compiled.groupCount).toBe(parsed.groupCount);
        expect(compiled.groupNames).toEqual(parsed.groupNames);
      }
    }
  });

  it('is never accepted again by the Python parser when it has a named group (no double migration)', () => {
    for (const source of [ATTEMPTS, START, END, '(?P<n>a)(?P=n)', '(?P<word>[a-z]+)']) {
      const t = ok(source, 'attempts');
      expect(translateToDialect(t.text, 'attempts').ok, t.text).toBe(false);
    }
  });
});

describe('literal characters', () => {
  it('keeps every printable ASCII character literal outside a class and escapes only the syntax characters', () => {
    for (const c of punctuators()) {
      const t = ok(BS + c, 'attempts');
      expect(t.text, JSON.stringify(c)).toBe(SYNTAX.includes(c) ? BS + c : c);
      expect(compileRegex(t.text, 'attempts').exec(c)?.end, JSON.stringify(c)).toBe(1);
    }
    expect(ok('a-b_9 c/d,e', 'attempts').text).toBe('a-b_9 c/d,e');
  });

  it('writes a brace that does not form a quantifier with a backslash', () => {
    expect(ok('a{', 'attempts').text).toBe(String.raw`a\{`);
    expect(ok('a{}', 'attempts').text).toBe(String.raw`a\{\}`);
    expect(ok('a{b}', 'attempts').text).toBe(String.raw`a\{b\}`);
    expect(ok('a{1,x}', 'attempts').text).toBe(String.raw`a\{1,x\}`);
    expect(ok(String.raw`a\]`, 'attempts').text).toBe(String.raw`a\]`);
  });

  it('keeps printable non-ASCII characters literal and writes everything else as a braced code point', () => {
    const letters = cp(0xe9, 0x4e2d, 0x1f600);
    expect(ok(letters, 'attempts').text).toBe(letters);
    expect(ok(cp(0xe9, 0x1f600) + '+', 'attempts').text).toBe(cp(0xe9, 0x1f600) + '+');
    expect(ok(String.raw`\x41\u0042\U00000043`, 'attempts').text).toBe('ABC');
    expect(ok(String.raw`\n\t\r\f\v\a\0`, 'attempts').text).toBe(String.raw`\u{a}\u{9}\u{d}\u{c}\u{b}\u{7}\u{0}`);
    for (const [code, escaped] of [
      [0x7f, String.raw`\u{7f}`],
      [0xa0, String.raw`\u{a0}`],
      [0x301, String.raw`\u{301}`],
      [0x200b, String.raw`\u{200b}`],
      [0x2028, String.raw`\u{2028}`],
      [0x3000, String.raw`\u{3000}`],
      [0xe000, String.raw`\u{e000}`],
      [0x3164, String.raw`\u{3164}`],
      [0x2800, String.raw`\u{2800}`],
      [0x10ffff, String.raw`\u{10ffff}`],
    ] as const) {
      const t = ok(cp(code), 'attempts');
      expect(t.text, code.toString(16)).toBe(escaped);
      expect(compileRegex(t.text, 'attempts').exec(cp(code))?.end, code.toString(16)).toBe(1);
    }
  });

  it('keeps the escaped extras of an ASCII letter under IGNORECASE (they would look like the letter if literal)', () => {
    expect(ok('(?i)k', 'attempts').text).toBe(String.raw`[kK\u{212a}]`);
    expect(ok('(?i)i', 'attempts').text).toBe(String.raw`[iI\u{130}\u{131}]`);
    expect(ok('(?i)s', 'attempts').text).toBe(String.raw`[sS\u{17f}]`);
  });
});

describe('the dot', () => {
  it('stays a dot for a session rule, where the dialect has the s flag', () => {
    expect(ok('a.b', 'session_rule').text).toBe('a.b');
    expect(ok('(?s)a.b', 'session_rule').text).toBe('a.b');
    expect(run('a.b', 'session_rule', 'a\nb')).toEqual({ span: [0, 3], groups: [] });
  });

  it('becomes a class without the line feed when the s flag is not in force', () => {
    expect(ok('a.b', 'attempts').text).toBe(String.raw`a[^\n]b`);
    expect(ok('(?-s:a.b)', 'session_rule').text).toBe(String.raw`(?:a[^\n]b)`);
    expect(run('a.b', 'attempts', 'a\nb')).toBeNull();
    expect(run('a.b', 'attempts', 'a\rb')).toEqual({ span: [0, 3], groups: [] });
    expect(run('(?-s:a.b)', 'session_rule', 'a\nb')).toBeNull();
  });

  it('becomes a class of everything for DOTALL in attempts, where the dialect has no s flag', () => {
    expect(ok('(?s)a.b', 'attempts').text).toBe(String.raw`a[\s\S]b`);
    expect(run('(?s)a.b', 'attempts', 'a\nb')).toEqual({ span: [0, 3], groups: [] });
  });
});

describe('anchors', () => {
  it('uses ^ and $ where they mean the same and a lookahead for the optional final line feed', () => {
    expect(ok('^a', 'attempts').text).toBe('^a');
    expect(ok(String.raw`\Aa\Z`, 'attempts').text).toBe('^a$');
    expect(ok('^a$', 'attempts').text).toBe(String.raw`^a(?=\n?$)`);
    expect(ok('a$', 'session_rule').text).toBe(String.raw`a(?=\n?$)`);
  });

  it('spells the multiline anchors without the m flag, which would also see CR and the Unicode separators', () => {
    expect(ok('(?m)^a$', 'attempts').text).toBe(String.raw`(?:^|(?<=\n))a(?=\n|$)`);
    expect(run('(?m)a$', 'session_rule', 'a\nb')).toEqual({ span: [0, 1], groups: [] });
    expect(run('(?m)^b', 'session_rule', 'a\r\nb')).toEqual({ span: [3, 4], groups: [] });
    expect(run('(?m)^b', 'session_rule', 'a\rb')).toBeNull();
  });

  it('keeps $ before a final line feed and the end-of-text anchor at the very end', () => {
    expect(run('a$', 'attempts', 'a\n')).toEqual({ span: [0, 1], groups: [] });
    expect(run('a$', 'attempts', 'a\nb')).toBeNull();
    expect(run(String.raw`a\Z`, 'attempts', 'a\n')).toBeNull();
    expect(run(String.raw`a\Z`, 'attempts', 'a')).toEqual({ span: [0, 1], groups: [] });
    expect(run(String.raw`\Aa`, 'session_rule', 'ba')).toBeNull();
  });
});

describe('the Unicode meaning of \\d, \\w, \\s and \\b', () => {
  it('spells \\d, \\w and \\s as explicit classes', () => {
    expect(ok(String.raw`\d`, 'attempts').text).toBe(String.raw`\p{Nd}`);
    expect(ok(String.raw`\D`, 'attempts').text).toBe(String.raw`\P{Nd}`);
    expect(ok(String.raw`\w`, 'attempts').text).toBe(String.raw`[\p{L}\p{N}_]`);
    expect(ok(String.raw`\W`, 'attempts').text).toBe(String.raw`[^\p{L}\p{N}_]`);
    expect(ok(String.raw`\s`, 'attempts').text).toBe(`[${SPACE_MEMBERS}]`);
    expect(ok(String.raw`\S`, 'attempts').text).toBe(`[^${SPACE_MEMBERS}]`);
  });

  it('spells \\b as a boundary of the word class', () => {
    const w = String.raw`[\p{L}\p{N}_]`;
    expect(ok(String.raw`\b`, 'attempts').text).toBe(`(?:(?<=${w})(?!${w})|(?<!${w})(?=${w}))`);
    expect(ok(String.raw`\B`, 'attempts').text).toBe(`(?:(?<=${w})(?=${w})|(?<!${w})(?!${w}))`);
  });

  it('matches what Python matches', () => {
    expect(run(String.raw`\d`, 'attempts', cp(0x663))).toEqual({ span: [0, 1], groups: [] });
    expect(run(String.raw`\w+`, 'attempts', `caf${cp(0xe9)}!`)).toEqual({ span: [0, 4], groups: [] });
    expect(run(String.raw`\s`, 'attempts', cp(0x3000))).toEqual({ span: [0, 1], groups: [] });
    expect(run(String.raw`\s`, 'attempts', cp(0x1c))).toEqual({ span: [0, 1], groups: [] });
    expect(run(String.raw`\s`, 'attempts', cp(0xfeff))).toBeNull();
    expect(run(String.raw`\bx\b`, 'session_rule', `${cp(0xe9)}x x`)).toEqual({ span: [3, 4], groups: [] });
  });

  it('uses the JavaScript escapes where the meaning is the same: the a flag', () => {
    expect(ok(String.raw`(?a)\d\D\w\W`, 'attempts').text).toBe(String.raw`\d\D\w\W`);
    expect(ok(String.raw`(?a)\b\B`, 'attempts').text).toBe(String.raw`\b\B`);
    expect(ok(String.raw`(?a)\s`, 'attempts').text).toBe(String.raw`[\u{9}-\u{d}\u{20}]`);
    expect(ok(String.raw`(?a)\S`, 'attempts').text).toBe(String.raw`[^\u{9}-\u{d}\u{20}]`);
    expect(ok(String.raw`(?a:\d)\d`, 'attempts').text).toBe(String.raw`(?:\d)\p{Nd}`);
    expect(run(String.raw`(?a)\d`, 'attempts', cp(0x663))).toBeNull();
    expect(run(String.raw`(?a)\w+`, 'attempts', `caf${cp(0xe9)}`)).toEqual({ span: [0, 3], groups: [] });
    expect(run(String.raw`(?a)\bx\b`, 'session_rule', `${cp(0xe9)}x x`)).toEqual({ span: [1, 2], groups: [] });
  });
});

describe('inline flags', () => {
  it('expands every case-insensitive letter to a class, so the text needs no i flag', () => {
    expect(ok('(?i)abc', 'attempts').text).toBe('[aA][bB][cC]');
    expect(ok('(?i)a1-b', 'attempts').text).toBe('[aA]1-[bB]');
    expect(ok('(?i:a)b', 'attempts').text).toBe('(?:[aA])b');
    expect(run('(?i)abc', 'attempts', 'AbC')).toEqual({ span: [0, 3], groups: [] });
    expect(run('(?i)k', 'attempts', cp(0x212a))).toEqual({ span: [0, 1], groups: [] });
    expect(run('(?i)abc', 'session_rule', 'x ABC')).toEqual({ span: [2, 5], groups: [] });
    expect(run('(?i)[a-c]+', 'attempts', 'aBcD')).toEqual({ span: [0, 3], groups: [] });
  });

  it('keeps case-sensitive text outside the scope that switches IGNORECASE on', () => {
    expect(ok('a(?i:b)c', 'attempts').text).toBe('a(?:[bB])c');
    expect(run('a(?i:b)c', 'attempts', 'aBc')).toEqual({ span: [0, 3], groups: [] });
    expect(run('a(?i:b)c', 'attempts', 'ABc')).toBeNull();
  });
});

describe('classes in v mode', () => {
  it('writes the members a person would write', () => {
    expect(ok('[a-z_]', 'attempts').text).toBe('[a-z_]');
    expect(ok('[^abc]', 'attempts').text).toBe('[^abc]');
    expect(ok('[0-9:]', 'attempts').text).toBe('[0-9:]');
    expect(ok('[A-Z ]+', 'attempts').text).toBe('[A-Z ]+');
    expect(ok('[.]', 'attempts').text).toBe('[.]');
    expect(ok('[+*?]', 'attempts').text).toBe('[+*?]');
    expect(ok(String.raw`[\d.]`, 'attempts').text).toBe(String.raw`[\p{Nd}.]`);
    expect(ok(String.raw`[\D\W]`, 'attempts').text).toBe(String.raw`[\P{Nd}[^\p{L}\p{N}_]]`);
    expect(ok(String.raw`[\S\d]`, 'attempts').text).toBe(`[[^${SPACE_MEMBERS}]${String.raw`\p{Nd}`}]`);
    expect(ok(String.raw`[\b]`, 'attempts').text).toBe(String.raw`[\u{8}]`);
    expect(ok(String.raw`(?a)[\d\W]`, 'attempts').text).toBe(String.raw`[\d\W]`);
  });

  it('escapes the characters that v mode reserves in a class', () => {
    expect(ok('[-(){}/|]+', 'attempts').text).toBe(String.raw`[\-\(\)\{\}\/\|]+`);
    expect(run('[-(){}/|]+', 'attempts', '-(){}/|')).toEqual({ span: [0, 7], groups: [] });
    expect(ok('[a-]', 'attempts').text).toBe(String.raw`[a\-]`);
    expect(ok('[]a]', 'attempts').text).toBe(String.raw`[\]a]`);
    expect(ok(String.raw`[a\[b]`, 'attempts').text).toBe(String.raw`[a\[b]`);
    expect(ok(String.raw`[\\]`, 'attempts').text).toBe(String.raw`[\\]`);
    expect(ok('[!-/]', 'attempts').text).toBe(String.raw`[!-\/]`);
    expect(ok(String.raw`[+-\-]`, 'attempts').text).toBe(String.raw`[+-\-]`);
    expect(run(String.raw`[+-\-]`, 'attempts', ',')).toEqual({ span: [0, 1], groups: [] });
  });

  it('escapes a caret that would negate the class or form a reserved double', () => {
    expect(ok(String.raw`[\^a]`, 'attempts').text).toBe(String.raw`[\^a]`);
    expect(ok(String.raw`[\^\^]`, 'attempts').text).toBe(String.raw`[\^\^]`);
    expect(ok(String.raw`[^\^]`, 'attempts').text).toBe(String.raw`[^\^]`);
    expect(ok('[a^]', 'attempts').text).toBe('[a^]');
    expect(run(String.raw`[\^a]`, 'attempts', '^')).toEqual({ span: [0, 1], groups: [] });
  });

  it('escapes the second punctuator of a pair that v mode reserves (set operations)', () => {
    expect(ok('[&&]', 'attempts').text).toBe(String.raw`[&\&]`);
    expect(ok('[!!]', 'attempts').text).toBe(String.raw`[!\!]`);
    expect(ok('[,,,]', 'attempts').text).toBe(String.raw`[,\,\,]`);
    expect(ok('[a&b&c]', 'attempts').text).toBe('[a&b&c]');
    expect(ok('[&!&]', 'attempts').text).toBe('[&!&]');
    expect(run('[&&]', 'attempts', '&')).toEqual({ span: [0, 1], groups: [] });
  });

  it('reads back every printable ASCII character in a class, alone and doubled', () => {
    for (const c of punctuators()) {
      const label = JSON.stringify(c);
      const single = ok(`[${BS}${c}]`, 'attempts');
      const escapedFirst = CLASS_SYNTAX.includes(c) || c === '^';
      expect(single.text, label).toBe(`[${escapedFirst ? BS : ''}${c}]`);
      expect(compileRegex(single.text, 'attempts').exec(c)?.end, label).toBe(1);

      const doubled = ok(`[${BS}${c}${BS}${c}]`, 'attempts');
      const second = CLASS_SYNTAX.includes(c) || CLASS_DOUBLES.includes(c) ? BS + c : c;
      expect(doubled.text, label).toBe(`[${escapedFirst ? BS : ''}${c}${second}]`);
      const compiled = compileRegex(doubled.text, 'attempts');
      expect(compiled.exec(c)?.end, label).toBe(1);
      expect(compiled.exec('x'), label).toBeNull();

      const range = ok(`[${BS}${c}-${BS}${c}]`, 'attempts');
      expect(compileRegex(range.text, 'attempts').exec(c)?.end, label).toBe(1);
    }
  });

  it('keeps the case expansion of a set free of i flags', () => {
    expect(ok('(?i)[a-c]', 'attempts').text).toBe('[a-cA-C]');
    expect(ok('(?i:[^k])', 'attempts').text).toBe(String.raw`(?:[^kK\u{212a}])`);
    expect(ok('(?i)[!-/]', 'attempts').text).toBe(String.raw`[!-\/]`);
  });
});

describe('groups and backreferences', () => {
  it('uses the JavaScript group syntax and the \\k<name> form for a named backreference', () => {
    expect(ok('(?P<n>a)(?P=n)', 'attempts').text).toBe(String.raw`(?<n>a)\k<n>`);
    expect(ok(String.raw`(?P<n>a)\1`, 'attempts').text).toBe(String.raw`(?<n>a)\k<n>`);
    expect(ok(String.raw`(a)(b)\2\1`, 'attempts').text).toBe(String.raw`(a)(b)\2\1`);
    expect(ok('(?:ab)+(c)?', 'attempts').text).toBe('(?:ab)+(c)?');
    expect(run('(?P<n>a+)b(?P=n)', 'attempts', 'aabaa')).toEqual({ span: [0, 5], groups: ['aa'] });
  });

  it('keeps a numbered backreference apart from a digit that follows it', () => {
    expect(ok(String.raw`(a)\1(?#note)0`, 'attempts').text).toBe(String.raw`(a)(?:\1)0`);
    const ten = '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)';
    const t = ok(`${ten}${String.raw`\1`}(?#note)0`, 'attempts');
    expect(t.text.endsWith(String.raw`(?:\1)0`)).toBe(true);
    expect(compileRegex(t.text, 'attempts').exec('abcdefghija0')?.end).toBe(12);
  });
});

describe('the text of every accepted pattern is a valid dialect pattern', () => {
  const PIECES = [
    'a',
    'b',
    '1',
    ' ',
    '-',
    '_',
    '&',
    '!',
    '~',
    '#',
    '/',
    '"',
    ',',
    ';',
    '<',
    '=',
    '@',
    '%',
    '^',
    '$',
    '.',
    '*',
    '+',
    '?',
    '|',
    '(',
    ')',
    '[',
    ']',
    '{',
    '}',
    '{2}',
    '{1,3}',
    '*?',
    String.raw`\.`,
    String.raw`\-`,
    String.raw`\[`,
    String.raw`\]`,
    String.raw`\d`,
    String.raw`\w`,
    String.raw`\s`,
    String.raw`\D`,
    String.raw`\b`,
    String.raw`\B`,
    String.raw`\A`,
    String.raw`\Z`,
    String.raw`\1`,
    String.raw`\n`,
    '(?:',
    '(?P<g>',
    '(?P=g)',
    '(?=',
    '(?!',
    '(?<=',
    '(?i)',
    '(?a)',
    '(?s:',
    '(?-s:',
    '(?m)',
    '[^',
    '[a-',
    '[\\d',
    '[\\W',
    '[&&',
    'x-y',
    String.raw`[&&]`,
    String.raw`[!!,,;;]`,
    String.raw`[^^]`,
    String.raw`[\^a]`,
    String.raw`[a\-z]`,
    String.raw`[\]\[]`,
    String.raw`[(){}|/]`,
    String.raw`[#%~]`,
    String.raw`[\d\W-]`,
    String.raw`[\S\d]`,
    String.raw`[+*?.]`,
    '\u00e9',
  ];

  /** A small deterministic generator (mulberry32), so a failure names a reproducible pattern. */
  function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('never yields JS_COMPILE for a random mix of tokens, and keeps the groups', () => {
    const next = generator(138);
    const codes = new Map<string, number>();
    let accepted = 0;
    for (let n = 0; n < 6000; n++) {
      const length = 1 + Math.floor(next() * 9);
      let source = '';
      for (let k = 0; k < length; k++) source += PIECES[Math.floor(next() * PIECES.length)] ?? '';
      const ctx: PyRegexContext = next() < 0.5 ? 'session_rule' : 'attempts';
      const result = translateToDialect(source, ctx);
      if (!result.ok) {
        codes.set(result.error.code, (codes.get(result.error.code) ?? 0) + 1);
        continue;
      }
      accepted += 1;
      const compiled = compileRegex(result.value.text, ctx);
      expect(compiled.groupCount, `${ctx} ${JSON.stringify(source)}`).toBe(result.value.groupCount);
      expect(compiled.groupNames, `${ctx} ${JSON.stringify(source)}`).toEqual(result.value.groupNames);
    }
    expect(codes.get('JS_COMPILE') ?? 0).toBe(0);
    expect(accepted).toBeGreaterThan(600);
  });
});
