// A synthetic replica of the construct inventory of a real chain task (named groups, ^ at position 0, ranges, counted
// quantifiers, greedy +, lazy *?, dot under DOTALL, one plain group; no backslashes, no flags, no lookarounds).
// Every name, pattern and text here is invented; the CPython comparison of the same shapes is in the parity golden test.
import { describe, expect, it } from 'vitest';

import { applyLabelTemplate, compileRegex, type CompiledRegex } from '../../regex/index.ts';
import { translateToDialect } from './translate.ts';
import type { PyRegexContext } from './types.ts';

/** The migration path: translate the Python pattern, then read the stored text with the runtime compiler. */
function compilePyRegex(source: string, ctx: PyRegexContext): CompiledRegex {
  const t = translateToDialect(source, ctx);
  if (!t.ok) throw new Error(`${t.error.code}: ${t.error.message}`);
  return compileRegex(t.value.text, ctx);
}

const START =
  '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB (?P<part>[A-Z0-9]+) BEGIN try (?P<n>[0-9]+) model (?P<model>[a-z]+) effort (?P<effort>[a-z]+)';
const END =
  '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB (?P<part>[A-Z0-9]+) END code=(?P<exit>[0-9]+) state=(?P<status>[A-Z ]+)';

describe('attempts patterns of a synthetic chain task', () => {
  it('parses a start line into its named fields', () => {
    const m = compilePyRegex(START, 'attempts').exec(
      '2026-01-02 03:04:05 JOB A1 BEGIN try 12 model alpha effort high tail',
    );
    expect(m?.groupdict()).toEqual({
      time: '2026-01-02 03:04:05',
      part: 'A1',
      n: '12',
      model: 'alpha',
      effort: 'high',
    });
    expect(m?.end).toBe(63);
  });

  it('parses an end line and keeps the trailing space of the status class', () => {
    const m = compilePyRegex(END, 'attempts').exec('2026-01-02 03:04:05 JOB A1 END code=137 state=KILLED BY TIMEOUT');
    expect(m?.groupdict()).toEqual({
      time: '2026-01-02 03:04:05',
      part: 'A1',
      exit: '137',
      status: 'KILLED BY TIMEOUT',
    });
  });

  it('refuses lines that do not start at position 0 or break a counted quantifier', () => {
    const start = compilePyRegex(START, 'attempts');
    expect(start.exec(' 2026-01-02 03:04:05 JOB A1 BEGIN try 1 model alpha effort high')).toBeNull();
    expect(start.exec('2026-01-02 03:04 JOB A1 BEGIN try 1 model alpha effort high')).toBeNull();
    expect(start.exec('2026-01-02 03:04:05 JOB a1 BEGIN try 1 model alpha effort high')).toBeNull();
  });

  it('keeps the group names in definition order', () => {
    const t = translateToDialect(START, 'attempts');
    expect(t.ok && t.value.groupNames).toEqual(['time', 'part', 'n', 'model', 'effort']);
    expect(compilePyRegex(START, 'attempts').groupNames).toEqual(['time', 'part', 'n', 'model', 'effort']);
  });
});

describe('session rules of a synthetic chain task', () => {
  it('uses a lazy dot under DOTALL across lines and labels with {1}', () => {
    const re = compilePyRegex('run-job[.]md.*?PART=([A-Z0-9]+)', 'session_rule');
    const m = re.exec('Please run-job.md\n\nthen PART=Z9 and PART=Q1');
    expect(m?.group(1)).toBe('Z9');
    expect(m === null ? '' : applyLabelTemplate('job part {1}', m)).toBe('job part Z9');
  });

  it('searches, so a rule can match in the middle of the first prompt', () => {
    const re = compilePyRegex('^[A-Z][a-z]+ [a-z]+ [0-9]{3}', 'session_rule');
    expect(re.exec('Alpha beta 123 rest')?.end).toBe(14);
    expect(re.exec('x Alpha beta 123')).toBeNull();
  });

  it('uses a greedy + between literal words', () => {
    const re = compilePyRegex('first.+second.+third', 'session_rule');
    expect(re.exec('first\nsecond\nthird')?.group(0)).toBe('first\nsecond\nthird');
    expect(re.exec('second first third')).toBeNull();
  });
});
