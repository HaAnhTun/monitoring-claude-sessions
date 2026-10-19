// `parseChainLine` (06 3.10.3 steps 6a to 6c): the START and END lines of a chain log through the configured patterns. Every
// pattern is a real `compileRegex(..., 'attempts')` value; the clock-dependent part (local time) runs under TZ=UTC (vitest config).
import { describe, expect, it } from 'vitest';

import { compileRegex, type CompiledRegex } from '../../regex/index.ts';
import { DEFAULT_TIME_FORMAT, MAX_MATCH_CODE_POINTS, parseChainLine, type ChainPatterns } from './parse.ts';

const START_SOURCE =
  '^(?<time>\\S+ \\S+) STEP (?<part>[A-Z]) START attempt (?<n>[0-9]+) model (?<model>[a-z]*) effort (?<effort>[a-z]*)';
const END_SOURCE = '^(?<time>\\S+ \\S+) STEP (?<part>[A-Z]) END exit=(?<exit>[0-9]*) status=(?<status>[A-Za-z_]*)';

/** A compiled pattern that records every text it is asked to match. */
function spy(source: string): { regex: CompiledRegex; seen: string[] } {
  const real = compileRegex(source, 'attempts');
  const seen: string[] = [];
  return {
    seen,
    regex: {
      ...real,
      exec: (text) => {
        seen.push(text);
        return real.exec(text);
      },
    },
  };
}

function patterns(start = START_SOURCE, end = END_SOURCE, timeFormat = DEFAULT_TIME_FORMAT): ChainPatterns {
  return { start: compileRegex(start, 'attempts'), end: compileRegex(end, 'attempts'), timeFormat };
}

const T = Date.UTC(2026, 0, 1, 10, 0, 5);

describe('parseChainLine: START lines', () => {
  it('reads every group of a START line', () => {
    const line = '2026-01-01 10:00:05 STEP C START attempt 3 model haiku effort low';
    expect(parseChainLine(line, patterns(), '')).toEqual({
      kind: 'start',
      part: 'C',
      label: 'C',
      nRaw: '3',
      model: 'haiku',
      effort: 'low',
      startedAt: T,
    });
  });

  it('puts the label prefix in front of the part', () => {
    const line = '2026-01-01 10:00:05 STEP C START attempt 3 model haiku effort low';
    expect(parseChainLine(line, patterns(), 'build step ')).toMatchObject({ part: 'C', label: 'build step C' });
  });

  it('reads an absent group as null and an absent part as the empty part (an empty part is legal)', () => {
    const only = patterns('^(?<time>\\S+ \\S+) START');
    expect(parseChainLine('2026-01-01 10:00:05 START', only, 'p-')).toEqual({
      kind: 'start',
      part: '',
      label: 'p-',
      nRaw: null,
      model: null,
      effort: null,
      startedAt: T,
    });
  });

  it('reads an empty model or effort as null, like the legacy `or None`', () => {
    const line = '2026-01-01 10:00:05 STEP A START attempt 1 model  effort ';
    expect(parseChainLine(line, patterns(), '')).toMatchObject({ kind: 'start', model: null, effort: null, nRaw: '1' });
  });

  it('keeps the exact text of the n group', () => {
    const line = '2026-01-01 10:00:05 STEP A START attempt 007 model x effort y';
    expect(parseChainLine(line, patterns(), '')).toMatchObject({ nRaw: '007' });
  });

  it('uses the configured time format', () => {
    const format = patterns('^(?<time>\\S+) START (?<part>\\S+)', END_SOURCE, '%d/%m/%Y-%H.%M.%S');
    expect(parseChainLine('02/01/2026-03.04.05 START X', format, '')).toMatchObject({
      kind: 'start',
      startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
  });

  it('applies an explicit UTC offset of the time format', () => {
    const format = patterns('^(?<time>\\S+) START (?<part>\\S+)', END_SOURCE, '%Y-%m-%dT%H:%M:%S%z');
    expect(parseChainLine('2026-01-01T10:00:05+02:00 START X', format, '')).toMatchObject({
      startedAt: Date.UTC(2026, 0, 1, 8, 0, 5),
    });
  });

  it('matches at the start of the line only', () => {
    const line = 'noise 2026-01-01 10:00:05 STEP A START attempt 1 model x effort y';
    expect(parseChainLine(line, patterns(), '')).toBeNull();
  });
});

describe('parseChainLine: a time that does not parse', () => {
  it('skips a START line with a bad time without trying the END pattern', () => {
    const start = spy(START_SOURCE);
    const end = spy('^(?<time>\\S+ \\S+) STEP');
    const both: ChainPatterns = { start: start.regex, end: end.regex, timeFormat: DEFAULT_TIME_FORMAT };
    expect(parseChainLine('not-a-date 10:00:05 STEP A START attempt 1 model x effort y', both, '')).toBeNull();
    expect(start.seen).toHaveLength(1);
    expect(end.seen).toEqual([]);
  });

  it('skips a START line whose pattern has no time group at all', () => {
    const noTime = patterns('^STEP (?<part>[A-Z]) START');
    expect(parseChainLine('STEP A START', noTime, '')).toBeNull();
  });

  it('skips a START line with an impossible date', () => {
    expect(parseChainLine('2026-02-30 10:00:05 STEP A START attempt 1 model x effort y', patterns(), '')).toBeNull();
  });

  it('keeps an END line whose time does not parse and leaves the time to the caller', () => {
    const line = 'garbage 10:00:05 STEP A END exit=0 status=PASS';
    expect(parseChainLine(line, patterns(), '')).toEqual({
      kind: 'end',
      part: 'A',
      label: 'A',
      endedAt: null,
      exitRaw: '0',
      statusRaw: 'PASS',
    });
  });
});

describe('parseChainLine: END lines', () => {
  it('reads every group of an END line', () => {
    const line = '2026-01-01 10:00:05 STEP B END exit=1 status=FAIL';
    expect(parseChainLine(line, patterns(), 'step ')).toEqual({
      kind: 'end',
      part: 'B',
      label: 'step B',
      endedAt: T,
      exitRaw: '1',
      statusRaw: 'FAIL',
    });
  });

  it('reads absent exit and status groups as null and an absent part as null', () => {
    const bare = patterns(START_SOURCE, '^(?<time>\\S+ \\S+) STOP');
    expect(parseChainLine('2026-01-01 10:00:05 STOP', bare, 'x')).toEqual({
      kind: 'end',
      part: null,
      label: null,
      endedAt: T,
      exitRaw: null,
      statusRaw: null,
    });
  });

  it('keeps empty groups as empty text', () => {
    expect(parseChainLine('2026-01-01 10:00:05 STEP B END exit= status=', patterns(), '')).toMatchObject({
      exitRaw: '',
      statusRaw: '',
    });
  });

  it('answers null for a line that is neither', () => {
    expect(parseChainLine('2026-01-01 10:00:05 something else', patterns(), '')).toBeNull();
    expect(parseChainLine('', patterns(), '')).toBeNull();
  });

  it('prefers START when both patterns match', () => {
    const wide = patterns('^(?<time>\\S+ \\S+) (?<part>\\S+)', '^(?<time>\\S+ \\S+) (?<part>\\S+)');
    expect(parseChainLine('2026-01-01 10:00:05 X', wide, '')).toMatchObject({ kind: 'start', part: 'X' });
  });
});

describe('parseChainLine: hostile lines', () => {
  it('matches a line of a megabyte on its first 4096 code points only', () => {
    const start = spy(START_SOURCE);
    const end = spy(END_SOURCE);
    const huge = `2026-01-01 10:00:05 STEP A START attempt 1 model x effort y${'z'.repeat(1_048_576)}`;
    const both: ChainPatterns = { start: start.regex, end: end.regex, timeFormat: DEFAULT_TIME_FORMAT };
    expect(parseChainLine(huge, both, '')).toMatchObject({ kind: 'start', part: 'A' });
    expect(start.seen).toHaveLength(1);
    expect(Array.from(start.seen[0] ?? '')).toHaveLength(MAX_MATCH_CODE_POINTS);
    expect(MAX_MATCH_CODE_POINTS).toBe(4096);
  });

  it('clips by code points, never inside a surrogate pair', () => {
    const start = spy('^(?<time>\\S+ \\S+)');
    const end = spy('^x');
    const astral = String.fromCodePoint(0x1f642);
    const line = `2026-01-01 10:00:05 ${astral.repeat(6000)}`;
    parseChainLine(line, { start: start.regex, end: end.regex, timeFormat: DEFAULT_TIME_FORMAT }, '');
    const text = start.seen[0] ?? '';
    expect(Array.from(text)).toHaveLength(MAX_MATCH_CODE_POINTS);
    expect(text.endsWith(astral)).toBe(true);
    // 20 code points of the time column, then pairs of two UTF-16 units each
    expect(text.length).toBe(20 + (MAX_MATCH_CODE_POINTS - 20) * 2);
  });

  it('hands a short line over unchanged', () => {
    const start = spy(START_SOURCE);
    const end = spy(END_SOURCE);
    const line = '2026-01-01 10:00:05 STEP A END exit=0 status=PASS';
    parseChainLine(line, { start: start.regex, end: end.regex, timeFormat: DEFAULT_TIME_FORMAT }, '');
    expect(start.seen).toEqual([line]);
    expect(end.seen).toEqual([line]);
  });

  it('keeps no state between lines: the same line parses the same way twice', () => {
    const p = patterns();
    const line = '2026-01-01 10:00:05 STEP A START attempt 1 model x effort y';
    const first = parseChainLine(line, p, '');
    expect(parseChainLine('noise', p, '')).toBeNull();
    expect(parseChainLine(line, p, '')).toEqual(first);
  });

  it('refuses a time before year 1 or after year 9999 that an offset could produce', () => {
    const format = patterns('^(?<time>\\S+) START', END_SOURCE, '%Y-%m-%dT%H:%M:%S%z');
    expect(parseChainLine('9999-12-31T23:59:59-05:00 START', format, '')).toBeNull();
    expect(parseChainLine('9999-12-31T23:59:59Z START', format, '')).toMatchObject({ kind: 'start' });
  });
});
