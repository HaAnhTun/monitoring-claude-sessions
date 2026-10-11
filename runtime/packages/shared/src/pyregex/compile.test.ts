import { describe, expect, it } from 'vitest';

import { McsError } from '../errors.ts';
import { compilePyRegex } from './compile.ts';

describe('compilePyRegex search (session_rule)', () => {
  it('finds the leftmost match and reports code point offsets', () => {
    const re = compilePyRegex('abc', 'session_rule');
    const m = re.exec('xxabcabc');
    expect(m).not.toBeNull();
    expect([m?.start, m?.end]).toEqual([2, 5]);
    expect(re.exec('nothing')).toBeNull();
  });

  it('counts astral characters as one position, like Python', () => {
    const re = compilePyRegex('b', 'session_rule');
    const m = re.exec(String.fromCodePoint(0x1f600) + 'b');
    expect([m?.start, m?.end]).toEqual([1, 2]);
  });

  it('lets the dot cross newlines (the legacy search uses re.S)', () => {
    expect(compilePyRegex('a.b', 'session_rule').exec('a\nb')?.group(0)).toBe('a\nb');
  });

  it('returns groups, unmatched groups as null and named groups by name', () => {
    const m = compilePyRegex('(?P<a>x)(y)?(?P<c>z)?', 'session_rule').exec('x');
    expect(m?.group(0)).toBe('x');
    expect(m?.groups()).toEqual(['x', null, null]);
    expect(m?.groupdict()).toEqual({ a: 'x', c: null });
    expect(m?.group(1)).toBe('x');
    expect(m?.group(2)).toBeNull();
  });

  it('rejects an unknown group number like Python IndexError', () => {
    const m = compilePyRegex('(a)', 'session_rule').exec('a');
    expect(() => m?.group(2)).toThrow(RangeError);
    expect(() => m?.group(-1)).toThrow(RangeError);
    expect(() => m?.group(1.5)).toThrow(RangeError);
  });

  it('keeps a group named __proto__ as an own key', () => {
    const m = compilePyRegex('(?P<__proto__>a)', 'session_rule').exec('a');
    const dict = m?.groupdict();
    expect(Object.keys(dict ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(dict)).toBe(Object.prototype);
  });

  it('gives the same answer when the compiled pattern is used again', () => {
    const re = compilePyRegex('a(b)', 'session_rule');
    for (let i = 0; i < 3; i++) expect(re.exec('xab')?.group(1)).toBe('b');
  });
});

describe('compilePyRegex search over astral characters (V8 mid-pair starts)', () => {
  const astral = String.fromCodePoint(0x1d49c);

  it('never starts a match between the halves of a surrogate pair', () => {
    expect(compilePyRegex(String.raw`\AB*\Z`, 'session_rule').exec(astral)).toBeNull();
    const m = compilePyRegex('A*$', 'session_rule').exec(`${astral}A`);
    expect([m?.start, m?.end]).toEqual([1, 2]);
  });

  it('keeps scanning after a discarded mid-pair result and finds a later boundary match', () => {
    const m = compilePyRegex('$', 'session_rule').exec(`${astral}${astral}`);
    expect([m?.start, m?.end]).toEqual([2, 2]);
    const empty = compilePyRegex('(?![sS])', 'session_rule').exec(astral);
    expect([empty?.start, empty?.end]).toEqual([0, 0]);
  });

  it('agrees with a plain search when the text has no astral characters', () => {
    const m = compilePyRegex('b*$', 'session_rule').exec('aabb');
    expect([m?.start, m?.end]).toEqual([2, 4]);
  });
});

describe('compilePyRegex scoped IGNORECASE (V8 modifier classes defect)', () => {
  it('keeps a class after an empty (?i:) group case-sensitive', () => {
    const m = compilePyRegex('(?i:)[a-b]*', 'session_rule').exec('A');
    expect([m?.start, m?.end]).toEqual([0, 0]);
  });

  it('keeps a class after (?-i:...) case-insensitive under a global (?i)', () => {
    const m = compilePyRegex('(?im)ba*(?-i:(a|b)a)[ab]', 'session_rule').exec('baaA');
    expect([m?.start, m?.end, m?.group(1)]).toEqual([0, 4, 'a']);
  });

  it('matches the Python special cases for k, s and i inside a scoped group', () => {
    const kelvin = String.fromCodePoint(0x212a);
    const longS = String.fromCodePoint(0x17f);
    expect(compilePyRegex('(?i:k)', 'attempts').exec(kelvin)?.end).toBe(1);
    expect(compilePyRegex('(?i:[r-t])', 'attempts').exec(longS)?.end).toBe(1);
    expect(compilePyRegex('(?i:[^i])', 'attempts').exec(String.fromCodePoint(0x130))).toBeNull();
    expect(compilePyRegex('(?i:[^i])x', 'attempts').exec('yx')?.end).toBe(2);
  });
});

describe('compilePyRegex match (attempts)', () => {
  it('matches only at position 0 and does not need the whole line', () => {
    const re = compilePyRegex('ab', 'attempts');
    expect(re.exec('xab')).toBeNull();
    const m = re.exec('abcd');
    expect([m?.start, m?.end]).toEqual([0, 2]);
    expect(re.exec('abcd')?.end).toBe(2);
  });

  it('keeps the dot from crossing LF only', () => {
    const re = compilePyRegex('a.b', 'attempts');
    expect(re.exec('a\nb')).toBeNull();
    expect(re.exec('a\rb')?.end).toBe(3);
    expect(re.exec(`a${String.fromCharCode(0x2028)}b`)?.end).toBe(3);
  });

  it('anchors with Python $ and \\Z semantics', () => {
    expect(compilePyRegex('a$', 'attempts').exec('a\n')?.end).toBe(1);
    expect(compilePyRegex('a$', 'attempts').exec('a\n\n')).toBeNull();
    expect(compilePyRegex('a$', 'attempts').exec('a\r\n')).toBeNull();
    expect(compilePyRegex(String.raw`a\Z`, 'attempts').exec('a\n')).toBeNull();
    expect(compilePyRegex(String.raw`a\Z`, 'attempts').exec('a')?.end).toBe(1);
  });

  it('uses Unicode word, digit and space classes', () => {
    const word = `caf${String.fromCodePoint(0xe9)}`;
    expect(
      compilePyRegex(String.raw`\w+`, 'attempts')
        .exec(`${word} x`)
        ?.group(0),
    ).toBe(word);
    const digits = String.fromCodePoint(0x663, 0x664);
    expect(
      compilePyRegex(String.raw`\d+`, 'attempts')
        .exec(`${digits}x`)
        ?.group(0),
    ).toBe(digits);
    expect(compilePyRegex(String.raw`\s`, 'attempts').exec(String.fromCodePoint(0x85))?.end).toBe(1);
    expect(compilePyRegex(String.raw`\s`, 'attempts').exec(String.fromCodePoint(0xfeff))).toBeNull();
    expect(
      compilePyRegex(String.raw`(?a)\w+`, 'attempts')
        .exec(word)
        ?.group(0),
    ).toBe('caf');
  });
});

describe('compilePyRegex errors', () => {
  it('throws McsError REGEX_UNSUPPORTED naming the construct code and position', () => {
    try {
      compilePyRegex('(?x) a', 'session_rule');
      expect.unreachable('compiled a verbose pattern');
    } catch (error) {
      expect(error).toBeInstanceOf(McsError);
      if (!(error instanceof McsError)) return;
      expect(error.code).toBe('REGEX_UNSUPPORTED');
      expect(error.details?.['code']).toBe('UNSUPPORTED_FLAG');
      expect(typeof error.details?.['position']).toBe('number');
      expect(error.message).toContain('verbose');
      expect(error.hint).toBeTruthy();
    }
  });

  it('does not echo the pattern text into the message', () => {
    const secretLike = 'tok' + 'en_value_123(';
    try {
      compilePyRegex(secretLike, 'session_rule');
      expect.unreachable('compiled an unbalanced pattern');
    } catch (error) {
      expect(error).toBeInstanceOf(McsError);
      if (!(error instanceof McsError)) return;
      expect(error.message).not.toContain('token_value');
      expect(JSON.stringify(error.details)).not.toContain('token_value');
    }
  });
});

describe('compilePyRegex IGNORECASE with the word class', () => {
  const ypogegrammeni = String.fromCodePoint(0x345);

  it('does not match U+0345 with (?i)\\w and matches it with (?i)\\W and (?i)\\B, like CPython', () => {
    expect(compilePyRegex(String.raw`(?i)\w`, 'session_rule').exec(ypogegrammeni)).toBeNull();
    expect(compilePyRegex(String.raw`(?i)\W`, 'session_rule').exec(ypogegrammeni)?.end).toBe(1);
    expect(compilePyRegex(String.raw`(?i)\B`, 'session_rule').exec(ypogegrammeni)?.end).toBe(0);
    expect(compilePyRegex(String.raw`(?i)[\w]`, 'attempts').exec(ypogegrammeni)).toBeNull();
    expect(
      compilePyRegex(String.raw`(?i)\w+`, 'session_rule')
        .exec('ab' + ypogegrammeni + 'c')
        ?.group(0),
    ).toBe('ab');
  });

  it('still folds ASCII letters next to (?i)\\w', () => {
    expect(
      compilePyRegex(String.raw`(?i)\wK`, 'session_rule')
        .exec('aK')
        ?.group(0),
    ).toBe('aK');
    expect(
      compilePyRegex(String.raw`(?i)\w[K]`, 'session_rule')
        .exec('ak')
        ?.group(0),
    ).toBe('ak');
    expect(compilePyRegex(String.raw`(?i)\w[K]`, 'session_rule').exec('a' + String.fromCodePoint(0x212a))?.end).toBe(2);
  });
});

describe('compilePyRegex compiles eagerly', () => {
  it('throws REGEX_UNSUPPORTED with JS_COMPILE for a pattern that V8 cannot compile, not a raw SyntaxError on the first exec', () => {
    const source = '(' + 'a?'.repeat(20000) + ')';
    let thrown: unknown;
    try {
      compilePyRegex(source, 'session_rule');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McsError);
    if (!(thrown instanceof McsError)) throw new Error('unreachable');
    expect(thrown.code).toBe('REGEX_UNSUPPORTED');
    expect(thrown.details).toEqual({ code: 'JS_COMPILE', position: null });
    expect(thrown.message).not.toContain('a?a?');
  });
});

describe('compilePyRegex scoped flags that CPython search evaluates with the enclosing flags', () => {
  it('accepts the exact attempts form and refuses the search form', () => {
    const ideographicSpace = String.fromCodePoint(0x3000);
    expect(compilePyRegex(String.raw`(?a:\S)`, 'attempts').exec(ideographicSpace + 'k')?.end).toBe(1);
    expect(() => compilePyRegex(String.raw`(?a:\S)`, 'session_rule')).toThrow(McsError);
  });
});
