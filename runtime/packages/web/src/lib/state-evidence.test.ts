// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { FIXTURE_NOW_MS, iso, makeState } from '../test/fixtures/index.ts';
import { hasQuestionMark, isInferred, stateEvidence } from './state-evidence.ts';

const NOW = FIXTURE_NOW_MS;
const MINUTE = 60;

describe('stateEvidence', () => {
  it('an inferred working state that went quiet gets the question mark and "quiet 18m" from the clock', () => {
    const state = makeState('working', { basis: 'inferred', confidence: 'medium', rule: 'S-7e' });
    const result = stateEvidence(state, iso(-18 * MINUTE), NOW);
    expect(result.questionMark).toBe(true);
    expect(result.lineKind).toBe('quiet');
    expect(result.lineKey).toBe('evidence.inferredQuiet');
    expect(result.args.quietSeconds).toBe(18 * MINUTE);
    expect(result.basisKey).toBe('evidence.basis.inferredSilence');
    expect(result.confidenceKey).toBe('evidence.confidence.medium');
  });

  it('moves with the clock, not with the evaluation time of the server', () => {
    const state = makeState('running', { basis: 'inferred', evaluatedAt: iso(-3600) });
    const early = stateEvidence(state, iso(-300), NOW);
    const late = stateEvidence(state, iso(-300), NOW + 60_000);
    expect(early.args.quietSeconds).toBe(300);
    expect(late.args.quietSeconds).toBe(360);
    expect(early.questionMark).toBe(true);
  });

  it('an observed state has no question mark and no line, even an active one', () => {
    for (const state of [
      'working',
      'running',
      'turn_ended',
      'completed',
      'failed',
      'waiting_input',
      'waiting_agent',
    ] as const) {
      const result = stateEvidence(makeState(state), iso(-600), NOW);
      expect(result.questionMark, state).toBe(false);
      expect(result.lineKind, state).toBe('none');
      expect(result.lineKey, state).toBeNull();
      expect(result.basisKey, state).toBe('evidence.basis.observed');
    }
  });

  it('only working and running with basis inferred get the question mark', () => {
    expect(hasQuestionMark('working', 'inferred')).toBe(true);
    expect(hasQuestionMark('running', 'inferred')).toBe(true);
    for (const state of [
      'waiting_tool',
      'waiting_agent',
      'waiting_input',
      'turn_ended',
      'completed',
      'failed',
      'stale',
      'unknown',
      'bogus',
    ]) {
      expect(hasQuestionMark(state, 'inferred'), state).toBe(false);
    }
    expect(hasQuestionMark('working', 'observed')).toBe(false);
    expect(hasQuestionMark('working', undefined)).toBe(false);
    expect(hasQuestionMark(null, 'inferred')).toBe(false);
  });

  it('waiting_tool shows the first evidence item as the server line', () => {
    const state = makeState('waiting_tool', {
      evidence: [
        { kind: 'transcript:tool_open', at: iso(-300), text: 'tool Bash open for 5m' },
        { kind: 'hook:pre_tool_use', at: iso(-300), text: 'second item' },
      ],
    });
    const result = stateEvidence(state, iso(-300), NOW);
    expect(result.questionMark).toBe(false);
    expect(result.lineKind).toBe('server');
    expect(result.args.text).toBe('tool Bash open for 5m');
    expect(result.lineKey).toBeNull();
  });

  it('waiting_tool without evidence has no line', () => {
    expect(stateEvidence(makeState('waiting_tool'), iso(-30), NOW).lineKind).toBe('none');
  });

  it('an inferred state that is not an active turn shows its first evidence item', () => {
    const state = makeState('stale', {
      basis: 'inferred',
      staleKind: 'silent',
      evidence: [{ kind: 'clock:quiet', at: iso(-2700), text: 'quiet 45m' }],
    });
    const result = stateEvidence(state, iso(-2700), NOW);
    expect(result.questionMark).toBe(false);
    expect(result.lineKind).toBe('server');
    expect(result.args.text).toBe('quiet 45m');
    expect(result.basisKey).toBe('evidence.basis.inferredSilence');
  });

  it('an unknown state that is inferred and has no evidence says only "inferred"', () => {
    const result = stateEvidence(makeState('unknown', { basis: 'inferred', confidence: 'low' }), iso(-1980), NOW);
    expect(result.questionMark).toBe(false);
    expect(result.lineKind).toBe('inferred');
    expect(result.lineKey).toBe('evidence.inferred');
    expect(result.basisKey).toBe('evidence.basis.inferred');
    expect(result.confidenceKey).toBe('evidence.confidence.low');
  });

  it('an unknown observed state has no line', () => {
    expect(stateEvidence(makeState('unknown'), null, NOW).lineKind).toBe('none');
  });

  it('reads an inferred state from the transcript when the evidence says so and silence is not the reason', () => {
    const state = makeState('turn_ended', {
      basis: 'inferred',
      evidence: [{ kind: 'transcript:end_turn', at: null, text: 'last record ended the turn' }],
    });
    expect(stateEvidence(state, null, NOW).basisKey).toBe('evidence.basis.inferredTranscript');
  });

  it('falls back to `since` when the last activity is missing, and says only "inferred" when neither can be read', () => {
    const withSince = makeState('working', { basis: 'inferred', since: iso(-120) });
    expect(stateEvidence(withSince, null, NOW).args.quietSeconds).toBe(120);
    expect(stateEvidence(withSince, '', NOW).args.quietSeconds).toBe(120);

    const noSince = makeState('working', { basis: 'inferred', since: null });
    const result = stateEvidence(noSince, null, NOW);
    expect(result.questionMark).toBe(true);
    expect(result.lineKind).toBe('quiet');
    expect(result.lineKey).toBe('evidence.inferred');
    expect(result.args.quietSeconds).toBeNull();
    expect(stateEvidence(noSince, 'not a time', NOW).args.quietSeconds).toBeNull();
  });

  it('never reports a negative quiet time when the clocks disagree', () => {
    const state = makeState('working', { basis: 'inferred' });
    expect(stateEvidence(state, iso(90), NOW).args.quietSeconds).toBe(0);
  });

  it('ignores a blank evidence text', () => {
    const state = makeState('waiting_tool', { evidence: [{ kind: 'x:y', at: null, text: '   ' }] });
    expect(stateEvidence(state, null, NOW).lineKind).toBe('none');
  });

  it('isInferred reads the basis only', () => {
    expect(isInferred(makeState('working', { basis: 'inferred' }))).toBe(true);
    expect(isInferred(makeState('working'))).toBe(false);
    expect(isInferred(undefined)).toBe(false);
  });

  it('turns every confidence into a plain-word key', () => {
    for (const confidence of ['high', 'medium', 'low'] as const) {
      expect(stateEvidence(makeState('working', { confidence }), null, NOW).confidenceKey).toBe(
        `evidence.confidence.${confidence}`,
      );
    }
  });
});
