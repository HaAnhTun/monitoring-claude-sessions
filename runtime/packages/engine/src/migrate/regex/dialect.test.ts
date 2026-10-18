// The translator output read through the runtime compiler of the configuration dialect (ADR 0067). The readable
// emission (plan WP-92b) changes the text; these tests pin the meaning, which must not change with it.
import { describe, expect, it } from 'vitest';

import { compileRegex } from '../../regex/index.ts';
import { parsePyRegex } from './parser.ts';
import { translateToDialect } from './translate.ts';
import type { DialectPattern, PyRegexContext } from './types.ts';

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

const ATTEMPTS = '^(?P<time>[0-9:]{8}) JOB (?P<part>[A-Z0-9]+) END code=(?P<exit>[0-9]+)';

describe('dialect text of a translated pattern', () => {
  it('keeps the group count and the group names of the parsed Python pattern', () => {
    for (const ctx of ['session_rule', 'attempts'] as const) {
      const parsed = parsePyRegex(ATTEMPTS, ctx);
      const t = ok(ATTEMPTS, ctx);
      const compiled = compileRegex(t.text, ctx);
      expect(t.groupCount).toBe(parsed.groupCount);
      expect(t.groupNames).toEqual(parsed.groupNames);
      expect(compiled.groupCount).toBe(parsed.groupCount);
      expect(compiled.groupNames).toEqual(parsed.groupNames);
    }
  });

  it('is never accepted again by the Python parser when it has a named group (no double migration)', () => {
    for (const source of [ATTEMPTS, '(?P<n>a)(?P=n)', '(?P<word>[a-z]+)']) {
      const t = ok(source, 'attempts');
      const again = translateToDialect(t.text, 'attempts');
      expect(again.ok, t.text).toBe(false);
    }
  });

  it('matches case-insensitively without any flag', () => {
    expect(run('(?i)abc', 'attempts', 'AbC')).toEqual({ span: [0, 3], groups: [] });
    expect(run('(?i)k', 'attempts', 'K')).toEqual({ span: [0, 1], groups: [] });
    expect(run('(?i)k', 'attempts', String.fromCodePoint(0x212a))).toEqual({ span: [0, 1], groups: [] });
    expect(run('(?i)abc', 'session_rule', 'x ABC')).toEqual({ span: [2, 5], groups: [] });
  });

  it('keeps the Python dot per context: DOTALL for a session rule, no line feed for attempts', () => {
    expect(run('a.b', 'session_rule', 'a\nb')).toEqual({ span: [0, 3], groups: [] });
    expect(run('a.b', 'attempts', 'a\nb')).toBeNull();
    expect(run('a.b', 'attempts', 'a\rb')).toEqual({ span: [0, 3], groups: [] });
  });

  it('keeps $ before a final line feed and \\Z at the very end', () => {
    expect(run('a$', 'attempts', 'a\n')).toEqual({ span: [0, 1], groups: [] });
    expect(run('a$', 'attempts', 'a\nb')).toBeNull();
    expect(run(String.raw`a\Z`, 'attempts', 'a\n')).toBeNull();
    expect(run(String.raw`a\Z`, 'attempts', 'a')).toEqual({ span: [0, 1], groups: [] });
    expect(run('(?m)a$', 'session_rule', 'a\nb')).toEqual({ span: [0, 1], groups: [] });
  });

  it('keeps the Unicode meaning of \\d, \\w, \\s and \\b', () => {
    const arabicIndicThree = String.fromCodePoint(0x663);
    expect(run(String.raw`\d`, 'attempts', arabicIndicThree)).toEqual({ span: [0, 1], groups: [] });
    expect(run(String.raw`\w+`, 'attempts', `caf${String.fromCodePoint(0xe9)}!`)).toEqual({ span: [0, 4], groups: [] });
    expect(run(String.raw`\s`, 'attempts', String.fromCodePoint(0x3000))).toEqual({ span: [0, 1], groups: [] });
    expect(run(String.raw`\bx\b`, 'session_rule', `${String.fromCodePoint(0xe9)}x x`)).toEqual({
      span: [3, 4],
      groups: [],
    });
  });

  it('escapes class members that v mode reserves', () => {
    expect(run('[-(){}/|]+', 'attempts', '-(){}/|')).toEqual({ span: [0, 7], groups: [] });
    expect(run('[&&]', 'attempts', '&')).toEqual({ span: [0, 1], groups: [] });
  });
});
