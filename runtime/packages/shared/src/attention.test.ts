// The acceptance table of the attention classifier (ADR 0107): rule table, transitions, levels, order, link rows.
import { describe, expect, it } from 'vitest';

import { LIFECYCLE_STATES, type LifecycleState } from './api/entities.ts';
import {
  ATTENTION_RULES,
  type AttentionClass,
  type AttentionInput,
  type AttentionLevel,
  type AttentionLinkInput,
  type AttentionPosture,
  type AttentionReason,
  attentionEventOf,
  attentionOf,
  attentionOfLink,
  compareAttention,
  levelOf,
  ruleFamily,
} from './attention.ts';

type Extra = Partial<Pick<AttentionInput, 'waitReason' | 'turnOutcome'>>;
const input = (rule: string, state: LifecycleState, extra: Extra = {}): AttentionInput => ({
  rule,
  state,
  waitReason: null,
  turnOutcome: null,
  ...extra,
});
const of = (rule: string, state: LifecycleState, extra: Extra = {}): AttentionClass =>
  attentionOf(input(rule, state, extra));

type Row = [
  rule: string,
  state: LifecycleState,
  extra: Extra,
  posture: AttentionPosture,
  reason: AttentionReason | null,
];

// Design table 2.2, one row per rule and distinguishing input.
const RULE_TABLE: Row[] = [
  ['S-1', 'completed', {}, 'ended', 'session_done'],
  ['S-1', 'failed', {}, 'failed', 'session_failed'],
  ['S-1', 'unknown', {}, 'unknown', null],
  ['S-1', 'working', {}, 'unknown', null],
  ['S-2', 'unknown', {}, 'unknown', null],
  ['S-3a', 'failed', {}, 'failed', 'session_failed'],
  ['S-3b', 'completed', {}, 'ended', 'session_done'],
  ['S-4a', 'completed', {}, 'ended', 'session_done'],
  ['S-4b', 'failed', {}, 'failed', 'session_failed'],
  ['S-5', 'stale', {}, 'unknown', null],
  ['S-6a', 'waiting_input', { waitReason: 'permission' }, 'needs_you', 'permission'],
  ['S-6b', 'waiting_input', { waitReason: 'permission' }, 'needs_you', 'permission'],
  ['S-6b', 'waiting_input', { waitReason: 'user' }, 'needs_you', 'question'],
  ['S-6c', 'waiting_input', { waitReason: 'elicitation' }, 'needs_you', 'question'],
  ['S-6c', 'waiting_input', { waitReason: 'agent_input' }, 'needs_you', 'question'],
  ['S-7a', 'waiting_agent', {}, 'working', null],
  ['S-7b', 'working', {}, 'working', null],
  ['S-7c', 'waiting_tool', {}, 'working', null],
  ['S-7d', 'unknown', {}, 'unknown', null],
  ['S-7e', 'working', {}, 'working', null],
  ['S-7f', 'stale', {}, 'unknown', null],
  ['S-8a', 'waiting_agent', {}, 'working', null],
  ['S-8b', 'waiting_input', { waitReason: 'user' }, 'ready', 'turn_done'],
  ['S-8c', 'waiting_input', { waitReason: 'idle_prompt' }, 'ready', 'turn_done'],
  ['S-8d', 'stale', {}, 'unknown', null],
  ['S-8e', 'turn_ended', { turnOutcome: 'ok' }, 'ready', 'turn_done'],
  ['S-8e', 'turn_ended', { turnOutcome: 'error' }, 'failed', 'turn_failed'],
  ['S-8e', 'turn_ended', { turnOutcome: 'interrupted' }, 'ready', 'interrupted'],
  ['S-8f', 'waiting_input', { waitReason: 'user' }, 'ready', 'first_prompt'],
  ['S-9a', 'running', {}, 'working', null],
  ['S-9b', 'waiting_agent', {}, 'working', null],
  ['S-9c', 'running', {}, 'working', null],
  ['S-10', 'unknown', {}, 'unknown', null],
];

describe('attentionOf', () => {
  it('TC-ATT-01 classifies every rule of the table, S-1 by its state', () => {
    for (const [rule, state, extra, posture, reason] of RULE_TABLE) {
      expect(of(rule, state, extra), `${rule} ${state} ${JSON.stringify(extra)}`).toEqual({
        posture,
        reason,
        family: ruleFamily(rule),
      });
    }
    expect(new Set(RULE_TABLE.map((row) => row[0]))).toEqual(new Set(Object.keys(ATTENTION_RULES)));
    expect([ruleFamily('S-8b'), ruleFamily('S-10'), ruleFamily('S-1'), ruleFamily('C-ATT-ENDED')]).toEqual([
      'S-8',
      'S-10',
      'S-1',
      'C-ATT-ENDED',
    ]);
  });

  it('TC-ATT-02 tells S-6b from S-8b although both are waiting_input with waitReason user', () => {
    expect(of('S-6b', 'waiting_input', { waitReason: 'user' }).posture).toBe('needs_you');
    expect(of('S-8b', 'waiting_input', { waitReason: 'user' }).posture).toBe('ready');
  });

  it('TC-ATT-03 never promotes unknown or stale, whatever the rule, and reads an unknown rule from its state', () => {
    for (const rule of [...Object.keys(ATTENTION_RULES), 'S-6z', 'S-99']) {
      for (const state of ['unknown', 'stale'] as const) {
        expect(of(rule, state, { waitReason: 'permission', turnOutcome: 'error' }).posture, `${rule} ${state}`).toBe(
          'unknown',
        );
      }
    }
    // A waiting_input of a rule the table does not know is unknown, never needs_you.
    expect(of('S-6z', 'waiting_input', { waitReason: 'permission' })).toEqual({
      posture: 'unknown',
      reason: null,
      family: 'S-6',
    });
    const byState: [LifecycleState, AttentionPosture][] = [
      ['running', 'working'],
      ['working', 'working'],
      ['waiting_tool', 'working'],
      ['waiting_agent', 'working'],
      ['turn_ended', 'ready'],
      ['completed', 'ended'],
      ['failed', 'failed'],
      ['waiting_input', 'unknown'],
      ['stale', 'unknown'],
      ['unknown', 'unknown'],
    ];
    expect(byState.map(([state]) => state).sort()).toEqual([...LIFECYCLE_STATES].sort());
    for (const [state, posture] of byState) expect(of('S-99', state).posture, state).toBe(posture);
  });
});

const working = of('S-7b', 'working');
const needsYou = of('S-6b', 'waiting_input', { waitReason: 'permission' });
const turnDone = of('S-8b', 'waiting_input', { waitReason: 'user' });
const sessionDone = of('S-4a', 'completed');
const sessionFailed = of('S-4b', 'failed');
const turnFailed = of('S-8e', 'turn_ended', { turnOutcome: 'error' });
const interrupted = of('S-8e', 'turn_ended', { turnOutcome: 'interrupted' });
const firstPrompt = of('S-8f', 'waiting_input', { waitReason: 'user' });
const background = of('S-8a', 'waiting_agent');
const unknown = of('S-10', 'unknown');

describe('attentionEventOf', () => {
  const live = { baseline: false };

  it('TC-ATT-04 fires needs_you and failed on entering the posture, not on staying in it', () => {
    expect(attentionEventOf(working, needsYou, live)).toBe('needs_you');
    expect(attentionEventOf(turnDone, needsYou, live)).toBe('needs_you');
    expect(attentionEventOf(needsYou, of('S-6c', 'waiting_input', { waitReason: 'elicitation' }), live)).toBeNull();
    expect(attentionEventOf(working, sessionFailed, live)).toBe('failed');
    expect(attentionEventOf(working, turnFailed, live)).toBe('failed');
    expect(attentionEventOf(of('S-1', 'unknown'), of('S-1', 'failed'), live)).toBe('failed');
    expect(attentionEventOf(turnFailed, sessionFailed, live)).toBeNull();
  });

  it('TC-ATT-05 fires done only after an active posture, and never for interrupted, S-8a or S-8f', () => {
    expect(attentionEventOf(working, turnDone, live)).toBe('done');
    expect(attentionEventOf(needsYou, turnDone, live)).toBe('done');
    expect(attentionEventOf(working, sessionDone, live)).toBe('done');
    expect(attentionEventOf(working, of('S-1', 'completed'), live)).toBe('done');
    expect(attentionEventOf(turnDone, of('S-8c', 'waiting_input'), live)).toBeNull();
    expect(attentionEventOf(turnDone, sessionDone, live)).toBeNull();
    expect(attentionEventOf(unknown, turnDone, live)).toBeNull();
    expect(attentionEventOf(working, interrupted, live)).toBeNull();
    expect(attentionEventOf(working, background, live)).toBeNull();
    expect(attentionEventOf(working, firstPrompt, live)).toBeNull();
    expect(attentionEventOf(working, unknown, live)).toBeNull();
  });

  it('TC-ATT-06 keeps the first snapshot silent and lets a new id fire only needs_you or failed', () => {
    for (const next of [needsYou, sessionFailed, turnDone, sessionDone, working]) {
      expect(attentionEventOf(null, next, { baseline: true })).toBeNull();
    }
    expect(attentionEventOf(null, needsYou, live)).toBe('needs_you');
    expect(attentionEventOf(null, turnFailed, live)).toBe('failed');
    expect(attentionEventOf(null, turnDone, live)).toBeNull();
    expect(attentionEventOf(null, sessionDone, live)).toBeNull();
  });
});

describe('levels and order', () => {
  it('TC-ATT-07 keeps needs_you while it holds and failed or done only while unseen', () => {
    const rows: [AttentionClass, AttentionLevel, AttentionLevel][] = [
      [needsYou, 'needs_you', 'needs_you'],
      [sessionFailed, 'failed', 'idle'],
      [turnFailed, 'failed', 'idle'],
      [turnDone, 'done', 'idle'],
      [sessionDone, 'done', 'idle'],
      [interrupted, 'idle', 'idle'],
      [firstPrompt, 'idle', 'idle'],
      [working, 'working', 'working'],
      [unknown, 'unknown', 'unknown'],
    ];
    for (const [cls, unseen, seen] of rows) {
      expect([levelOf(cls, true), levelOf(cls, false)], JSON.stringify(cls)).toEqual([unseen, seen]);
    }
  });

  it('TC-ATT-08 orders by level, the longest blocked first inside needs_you, the newest first elsewhere, null last', () => {
    const t = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, '0')}:00.000Z`;
    const rows: { id: string; level: AttentionLevel; since: string | null }[] = [
      { id: 'unknown', level: 'unknown', since: t(1) },
      { id: 'done-old', level: 'done', since: t(2) },
      { id: 'needs-null', level: 'needs_you', since: null },
      { id: 'idle', level: 'idle', since: t(9) },
      { id: 'needs-new', level: 'needs_you', since: t(8) },
      { id: 'working', level: 'working', since: t(3) },
      { id: 'done-new', level: 'done', since: t(7) },
      { id: 'failed', level: 'failed', since: t(4) },
      { id: 'needs-old', level: 'needs_you', since: t(5) },
      { id: 'done-null', level: 'done', since: null },
    ];
    expect(rows.sort(compareAttention).map((row) => row.id)).toEqual([
      'needs-old',
      'needs-new',
      'needs-null',
      'failed',
      'done-new',
      'done-old',
      'done-null',
      'working',
      'idle',
      'unknown',
    ]);
    expect(compareAttention(rows[0] ?? { level: 'idle', since: null }, rows[0] ?? { level: 'idle', since: null })).toBe(
      0,
    );
  });
});

describe('attentionOfLink', () => {
  it('TC-ATT-09 classifies a terminal row without a monitor row from its link', () => {
    const link = (patch: Partial<AttentionLinkInput>): AttentionLinkInput => ({
      status: 'linked',
      reason: null,
      transcript: 'none',
      registryStatus: null,
      waitingFor: null,
      ...patch,
    });
    const rows: [Partial<AttentionLinkInput>, AttentionPosture, AttentionReason | null][] = [
      [{ status: 'pending', reason: 'no_registry' }, 'needs_you', 'not_linked'],
      [{ status: 'pending' }, 'unknown', null],
      [{ status: 'pending', reason: 'registry_unreadable' }, 'unknown', null],
      [{ status: 'ambiguous', reason: 'ambiguous', registryStatus: 'waiting' }, 'unknown', null],
      [{ registryStatus: 'waiting', waitingFor: 'permission prompt' }, 'needs_you', 'permission'],
      [{ registryStatus: 'waiting', waitingFor: 'answer' }, 'needs_you', 'question'],
      [{ registryStatus: 'waiting' }, 'needs_you', 'question'],
      [{ registryStatus: 'idle' }, 'ready', 'first_prompt'],
      [{ registryStatus: 'busy' }, 'working', null],
      [{}, 'unknown', null],
      [{ transcript: 'tracked', registryStatus: 'waiting', waitingFor: 'permission prompt' }, 'unknown', null],
    ];
    for (const [patch, posture, reason] of rows) {
      expect(attentionOfLink(link(patch)), JSON.stringify(patch)).toEqual({ posture, reason, family: 'link' });
    }
  });
});
