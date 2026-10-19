// `externalState` (06 3.10.5): the table of the chain-log END line, written as literal expectations. The frozen vectors of the
// pre-4.0 engine (`test/fixtures/attempts/external-state.frozen.json`) are the only recorded expectations; the grid of that file
// is replayed below for every row whose values the parser can produce (text or absent).
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { OPEN_EVIDENCE, externalState, supersededEvidence } from './state.ts';

const FROZEN = new URL('../../../test/fixtures/attempts/external-state.frozen.json', import.meta.url);

describe('externalState: passing statuses', () => {
  it.each([
    ['PASS'],
    ['DONE'],
    ['OK'],
    ['COMPLETE'],
    ['COMPLETED'],
    ['SUCCESS'],
    ['pass'],
    ['Passed'],
    ['okay'],
    ['  DONE  '],
  ])('exit 0 with status %j is COMPLETED', (status) => {
    expect(externalState('0', status).state).toBe('COMPLETED');
  });

  it('a pass word needs no exit code at all', () => {
    expect(externalState(null, 'PASS')).toEqual({ state: 'COMPLETED', evidence: 'chain log: exit=none status=PASS' });
    expect(externalState('', 'SUCCESS')).toEqual({ state: 'COMPLETED', evidence: 'chain log: exit= status=SUCCESS' });
  });

  it('a status that only starts with a pass word passes (the legacy match is anchored at the start only)', () => {
    expect(externalState('0', 'COMPLETEDX').state).toBe('COMPLETED');
    expect(externalState('0', 'OKAY').state).toBe('COMPLETED');
  });

  it('white space before the pass word is ignored, any other text before it is not', () => {
    expect(externalState(null, '\n\tPASS').state).toBe('COMPLETED');
    expect(externalState(null, 'nopass').state).toBe('UNKNOWN');
  });
});

describe('externalState: failing runs', () => {
  it('a non-zero exit code is FAILED, whatever the status says', () => {
    expect(externalState('1', 'PASS')).toEqual({ state: 'FAILED', evidence: 'chain log: exit=1 status=PASS' });
    expect(externalState('137', null)).toEqual({ state: 'FAILED', evidence: 'chain log: exit=137 status=-' });
    expect(externalState('-1', 'DONE').state).toBe('FAILED');
  });

  it('exit 00 counts as non-zero, like the legacy comparison with the text 0', () => {
    expect(externalState('00', 'PASS')).toEqual({ state: 'FAILED', evidence: 'chain log: exit=00 status=PASS' });
    expect(externalState('00', null).state).toBe('FAILED');
  });

  it('an exit code that is not a number is non-zero', () => {
    expect(externalState('x', 'PASS').state).toBe('FAILED');
  });

  it.each([['FAIL'], ['failed'], ['BLOCKED'], ['abort'], ['aborted by user'], ['ERROR'], ['an Error occurred']])(
    'exit 0 with status %j is FAILED',
    (status) => {
      expect(externalState('0', status).state).toBe('FAILED');
    },
  );

  it('PASS_WITH_ERRORS is FAILED: a failure word anywhere beats the pass word', () => {
    expect(externalState('0', 'PASS_WITH_ERRORS')).toEqual({
      state: 'FAILED',
      evidence: 'chain log: exit=0 status=PASS_WITH_ERRORS',
    });
    expect(externalState('0', 'PASS (FAIL)').state).toBe('FAILED');
    expect(externalState('0', 'PASS\nFAIL later').state).toBe('FAILED');
  });
});

describe('externalState: blank and unknown statuses', () => {
  it('a blank status with exit 0 is COMPLETED', () => {
    for (const status of [null, '', '   ']) {
      expect(externalState('0', status)).toEqual({ state: 'COMPLETED', evidence: 'chain log: exit=0 status=-' });
    }
  });

  it('a blank status with no exit code (or an empty one) is UNKNOWN', () => {
    expect(externalState(null, null)).toEqual({
      state: 'UNKNOWN',
      evidence: "chain log: the run ended (exit=none) but its status '' is neither a pass nor a failure",
    });
    expect(externalState('', '')).toEqual({
      state: 'UNKNOWN',
      evidence: "chain log: the run ended (exit=) but its status '' is neither a pass nor a failure",
    });
    expect(externalState(null, '  ').state).toBe('UNKNOWN');
  });

  it('the evidence text for a missing exit code reads none', () => {
    expect(externalState(null, 'PASS').evidence).toContain('exit=none');
    expect(externalState(null, 'FAIL').evidence).toContain('exit=none');
    expect(externalState(null, 'RUNNING').evidence).toContain('exit=none');
  });

  it('a status that is neither a pass nor a failure is UNKNOWN and quoted in the evidence', () => {
    expect(externalState('0', 'RUNNING')).toEqual({
      state: 'UNKNOWN',
      evidence: "chain log: the run ended (exit=0) but its status 'RUNNING' is neither a pass nor a failure",
    });
    expect(externalState('0', '  x  ').evidence).toBe(
      "chain log: the run ended (exit=0) but its status 'x' is neither a pass nor a failure",
    );
  });

  it('quotes the status text like the legacy evidence did', () => {
    const unknown = (status: string): string => externalState('0', status).evidence;
    expect(unknown("it's")).toContain(`status "it's" is`);
    expect(unknown(`it's "x"`)).toContain(`status 'it\\'s "x"' is`);
    expect(unknown('a\tb')).toContain("status 'a\\tb' is");
    expect(unknown('a\u0001b')).toContain("status 'a\\x01b' is");
    const accented = `caf${String.fromCharCode(0xe9)}`;
    expect(unknown(accented)).toContain(`status '${accented}' is`);
    expect(unknown('back\\slash')).toContain("status 'back\\\\slash' is");
  });

  it('shows a trimmed status in the evidence of a pass and of a failure', () => {
    expect(externalState('0', ' pass ').evidence).toBe('chain log: exit=0 status=pass');
    expect(externalState('1', '\nFAIL\n').evidence).toBe('chain log: exit=1 status=FAIL');
  });
});

describe('externalState against the frozen vectors', () => {
  interface Vector {
    case: string;
    input: { row: Record<string, unknown> | null };
    output: { state: string; evidence: string } | { raises: string } | null;
  }
  const vectors: Vector[] = JSON.parse(readFileSync(FROZEN, 'utf8')) as Vector[];

  // The parser hands over text or nothing: rows whose exit or status is a number or a list belong to the Python call site.
  const isText = (value: unknown): boolean => value === undefined || value === null || typeof value === 'string';
  const usable = vectors.filter((v) => {
    const row = v.input.row;
    if (row === null) return false;
    const end = row['end'];
    return (
      end !== null &&
      end !== undefined &&
      isText(row['exit']) &&
      isText(row['status']) &&
      v.output !== null &&
      !('raises' in v.output)
    );
  });

  it('replays the grid (every row that has text or nothing for exit and status)', () => {
    expect(usable.length).toBeGreaterThan(100);
    for (const v of usable) {
      const row = v.input.row ?? {};
      const exit = typeof row['exit'] === 'string' ? row['exit'] : null;
      const status = typeof row['status'] === 'string' ? row['status'] : null;
      const got = externalState(exit, status);
      const want = v.output as { state: string; evidence: string };
      expect(got.state, v.case).toBe(want.state);
      // the only wording change of 4.0: a missing exit code reads none, no longer the Python word None
      expect(got.evidence, v.case).toBe(want.evidence.replace('exit=None', 'exit=none'));
    }
  });
});

describe('evidence texts of the other rows', () => {
  it('names the state of an open run and of a superseded one', () => {
    expect(OPEN_EVIDENCE).toBe('chain log: started, no END yet');
    expect(supersededEvidence('B')).toBe('chain log: a later START for part B superseded this attempt');
    expect(supersededEvidence('')).toBe('chain log: a later START for part  superseded this attempt');
  });
});
