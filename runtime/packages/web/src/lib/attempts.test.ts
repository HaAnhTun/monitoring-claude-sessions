// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { attemptState, type AttemptStateInput } from './attempts.ts';

function row(over: Partial<AttemptStateInput> = {}): AttemptStateInput {
  return { state: null, endedAt: null, status: null, exit: null, ...over };
}

describe('attemptState', () => {
  it('uses the reported state when there is one', () => {
    expect(attemptState(row({ state: 'COMPLETED' }))).toBe('COMPLETED');
    expect(attemptState(row({ state: 'FAILED', endedAt: null }))).toBe('FAILED');
    expect(attemptState(row({ state: 'RUNNING', endedAt: '2026-10-11T10:00:00Z' }))).toBe('RUNNING');
  });

  it('a state outside the five legacy states becomes UNKNOWN', () => {
    expect(attemptState(row({ state: 'weird' }))).toBe('UNKNOWN');
    expect(attemptState(row({ state: 'UNKNOWN' }))).toBe('UNKNOWN');
  });

  it('without a state, an open attempt is RUNNING', () => {
    expect(attemptState(row())).toBe('RUNNING');
    expect(attemptState(row({ status: 'PASS', exit: 0 }))).toBe('RUNNING');
  });

  it('without a state, a finished PASS is COMPLETED', () => {
    expect(attemptState(row({ endedAt: '2026-10-11T10:00:00Z', status: 'PASS' }))).toBe('COMPLETED');
  });

  it('without a state, a finished attempt with another status or a non-zero exit is FAILED', () => {
    expect(attemptState(row({ endedAt: 't', status: 'FAIL' }))).toBe('FAILED');
    expect(attemptState(row({ endedAt: 't', exit: 2 }))).toBe('FAILED');
    expect(attemptState(row({ endedAt: 't', exit: -1 }))).toBe('FAILED');
  });

  it('without a state, a finished attempt with no status and exit 0 or null is UNKNOWN (legacy truthiness)', () => {
    expect(attemptState(row({ endedAt: 't', exit: 0 }))).toBe('UNKNOWN');
    expect(attemptState(row({ endedAt: 't' }))).toBe('UNKNOWN');
    expect(attemptState(row({ endedAt: 't', status: '' }))).toBe('UNKNOWN');
  });
});
