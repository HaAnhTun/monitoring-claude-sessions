import { describe, expect, it } from 'vitest';

import { PYTHON_SYNTAX_HINT, RegexCompileError, compileRegex, pythonSyntaxHint, tryCompileRegex } from './compile.ts';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const astral = String.fromCodePoint(0x1d49c);

function refusal(source: string, context: 'session_rule' | 'attempts' = 'session_rule'): RegexCompileError {
  const result = tryCompileRegex(source, context);
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

describe('compileRegex flags per context', () => {
  it('uses v and s for a session rule, v and y for attempts', () => {
    expect(compileRegex('a', 'session_rule').regex.flags).toBe('sv');
    expect(compileRegex('a', 'attempts').regex.flags).toBe('vy');
    expect(compileRegex('a', 'attempts').context).toBe('attempts');
  });

  it('searches a session rule and matches attempts at position 0 only, without needing the whole line', () => {
    const rule = compileRegex('abc', 'session_rule');
    expect([rule.exec('xxabcabc')?.start, rule.exec('xxabcabc')?.end]).toEqual([2, 5]);
    expect(rule.exec('nothing')).toBeNull();
    const attempts = compileRegex('ab', 'attempts');
    expect(attempts.exec('xab')).toBeNull();
    expect([attempts.exec('abcd')?.start, attempts.exec('abcd')?.end]).toEqual([0, 2]);
  });

  it('lets the dot cross line breaks in session rules and not in attempts', () => {
    expect(compileRegex('a.b', 'session_rule').exec(`a${LF}b`)?.group(0)).toBe(`a${LF}b`);
    expect(compileRegex('a.b', 'attempts').exec(`a${LF}b`)).toBeNull();
    expect(compileRegex('a.b', 'attempts').exec(`a${CR}b`)).toBeNull();
    expect(compileRegex('a.b', 'attempts').exec('axb')?.end).toBe(3);
  });

  it('matches the empty pattern at position 0', () => {
    const m = compileRegex('', 'session_rule').exec('abc');
    expect([m?.start, m?.end]).toEqual([0, 0]);
  });
});

describe('compileRegex groups', () => {
  it('lists named groups in definition order and returns null for a group that did not take part', () => {
    const re = compileRegex('(?<b>x)(y)?(?<a>z)?', 'session_rule');
    expect(re.groupCount).toBe(3);
    expect(re.groupNames).toEqual(['b', 'a']);
    const m = re.exec('x');
    expect(m?.group(0)).toBe('x');
    expect(m?.groups()).toEqual(['x', null, null]);
    expect(m?.groupdict()).toEqual({ b: 'x', a: null });
    expect(Object.keys(m?.groupdict() ?? {})).toEqual(['b', 'a']);
    expect(m?.group(2)).toBeNull();
  });

  it('counts groups correctly with lookbehind, lookahead and non-capturing groups', () => {
    expect(compileRegex('(?<=(a))(?:b)(c)', 'session_rule').groupCount).toBe(2);
    expect(compileRegex('(?<!x)(?:y)(?=z)', 'session_rule').groupCount).toBe(0);
    expect(compileRegex(String.raw`\(?P<x>`, 'session_rule').groupCount).toBe(0);
    expect(compileRegex('(?<=(a))(?:b)(c)', 'session_rule').exec('abc')?.groups()).toEqual(['a', 'c']);
  });

  it('rejects an unknown group number', () => {
    const m = compileRegex('(a)', 'session_rule').exec('a');
    expect(() => m?.group(2)).toThrow(RangeError);
    expect(() => m?.group(-1)).toThrow(RangeError);
    expect(() => m?.group(1.5)).toThrow(RangeError);
  });

  it('keeps a group named __proto__ as an own key', () => {
    const dict = compileRegex('(?<__proto__>a)', 'session_rule').exec('a')?.groupdict();
    expect(Object.keys(dict ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(dict)).toBe(Object.prototype);
  });
});

describe('compileRegex offsets in code points', () => {
  it('counts an astral character as one position', () => {
    const m = compileRegex('b', 'session_rule').exec(`${String.fromCodePoint(0x1f600)}b`);
    expect([m?.start, m?.end]).toEqual([1, 2]);
  });

  it('counts a lone surrogate in the text as one position', () => {
    const m = compileRegex('b', 'session_rule').exec(`${String.fromCharCode(0xd800)}b`);
    expect([m?.start, m?.end]).toEqual([1, 2]);
    expect(compileRegex(String.fromCharCode(0xd800), 'attempts').exec(String.fromCharCode(0xd800))?.end).toBe(1);
  });

  it('never starts a match between the halves of a surrogate pair (V8 mid-pair starts)', () => {
    expect(compileRegex('^B*$', 'session_rule').exec(astral)).toBeNull();
    const tail = compileRegex('A*$', 'session_rule').exec(`${astral}A`);
    expect([tail?.start, tail?.end]).toEqual([1, 2]);
    const end = compileRegex('$', 'session_rule').exec(`${astral}${astral}`);
    expect([end?.start, end?.end]).toEqual([2, 2]);
    const empty = compileRegex(String.raw`(?![\s\S])`, 'session_rule').exec(astral);
    expect([empty?.start, empty?.end]).toEqual([1, 1]);
  });

  it('agrees with a plain search when the text has no astral characters', () => {
    const m = compileRegex('b*$', 'session_rule').exec('aabb');
    expect([m?.start, m?.end]).toEqual([2, 4]);
  });
});

describe('compileRegex state between calls', () => {
  it('resets lastIndex of the shared RegExp on every call', () => {
    const attempts = compileRegex('a(b)', 'attempts');
    expect(attempts.exec('abx')?.group(1)).toBe('b');
    expect(attempts.exec('abx')?.group(1)).toBe('b');
    attempts.regex.lastIndex = 2;
    expect(attempts.exec('abx')?.end).toBe(2);
    expect(attempts.regex.lastIndex).toBe(0);
    const rule = compileRegex('a(b)', 'session_rule');
    for (let i = 0; i < 3; i++) expect(rule.exec('xab')?.group(1)).toBe('b');
  });
});

describe('compileRegex refusals', () => {
  it('forces compilation, so a pattern V8 cannot compile is refused here and not on the first use', () => {
    const source = `(${'a?'.repeat(20000)})`;
    const error = refusal(source);
    expect(error).toBeInstanceOf(RegexCompileError);
    expect(error.pythonSyntax).toBe(false);
    expect(error.reason).not.toContain('a?a?');
    expect(error.message).not.toContain('a?a?');
  });

  it('applies the v-mode class rules', () => {
    expect(refusal('[a-]').reason).toBe('Invalid character in character class');
    expect(refusal('[(]').pythonSyntax).toBe(false);
    expect(compileRegex(String.raw`[a\-]`, 'session_rule').exec('-')?.end).toBe(1);
  });

  it('refuses duplicate group names in one alternative', () => {
    expect(refusal('(?<n>a)(?<n>b)').reason).toBe('Duplicate capture group name');
  });

  it('refuses inline modifier groups even when this Node accepts them', () => {
    for (const source of ['(?i:a)', '(?-i:a)', '(?i-m:a)']) {
      const error = refusal(source);
      expect(error.pythonSyntax, source).toBe(true);
      expect(error.reason, source).toContain('inline modifier groups');
    }
  });

  it('marks Python-only constructs as Python syntax and JavaScript errors as not', () => {
    for (const source of ['(?P<n>a)', '(?P=n)', '(?P>n)', '(?#comment)', '(?i)a', String.raw`\Aa`, String.raw`a\Z`]) {
      const error = refusal(source);
      expect(error.pythonSyntax, source).toBe(true);
      expect(pythonSyntaxHint(source), source).toBe(PYTHON_SYNTAX_HINT);
    }
    for (const source of ['(', 'a**', '[a-', ')', '[(?P<n>]']) {
      expect(refusal(source).pythonSyntax, source).toBe(false);
      expect(pythonSyntaxHint(source), source).toBeNull();
    }
    expect(pythonSyntaxHint(String.raw`\(?P<x>`)).toBeNull();
    expect(PYTHON_SYNTAX_HINT).toContain('mcs migrate-workspace');
  });

  it('never repeats the pattern text in the reason or the message', () => {
    const secretLike = ['tok', 'en_value_123('].join('');
    const error = refusal(secretLike);
    expect(error.reason).toBe('Unterminated group');
    expect(error.message).not.toContain('token_value');
    const slashy = refusal('a/v: b(');
    expect(slashy.reason).toBe('Unterminated group');
  });

  it('throws RegexCompileError from compileRegex', () => {
    expect(() => compileRegex('(', 'attempts')).toThrow(RegexCompileError);
  });
});
