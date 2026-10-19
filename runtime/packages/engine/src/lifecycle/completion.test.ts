// T-LF-57, CE-1..CE-17 (02 7.13): `explainCompletion` over an in-memory `CompletionLookup`. The sessions are built the way the
// transition table of 02 7.7 builds them (real envelopes through the normalizer, folded into a model and derived), so the stored
// view of a candidate is exactly what the writer would have stored, and the model behind it is what a re-derivation reads.
import { CompletionEvidenceSchema, type CompletionEvidence } from '@mcs/shared';
import type { HookEnvelopeV1 } from '@mcs/shared/protocol';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FIXTURE_SESSION_ID, fixtureEnvelope } from '../../test/fixtures/hooks.ts';
import type { LogicalEvent } from '../ingest/event-row.ts';
import { normalizeEnvelope } from '../ingest/hooks/normalize-envelope.ts';
import {
  CompletionTargetError,
  explainCompletion,
  validateCompletionTarget,
  type AttemptRowRef,
  type CompletionCandidate,
  type CompletionLookup,
  type CompletionTarget,
} from './completion.ts';
import { deriveModel, type ModelInputs } from './derive-session.ts';
import { DEFAULT_LIFECYCLE_CFG, type LifecycleEvidence, type LifecycleView } from './facts.ts';
import { applyEvent, emptyModel, type EventOrigin, type LifecycleModel } from './merge.ts';
import { renderEvidence } from './rules.ts';

const T = 1_791_727_200_000;
const CFG = DEFAULT_LIFECYCLE_CFG;
const SID = FIXTURE_SESSION_ID;
const sec = (n: number): number => n * 1000;
const min = (n: number): number => n * 60_000;
const HOUR = 3_600_000;

const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const ID_C = 'aaaaaaaa-0000-4000-8000-000000000003';

// ---- fixtures: the events of 02 7.7 -------------------------------------------------------------------------------------

interface Tagged {
  readonly event: LogicalEvent;
  readonly origin: EventOrigin;
}

function hook(event: string, dt: number, data?: Record<string, string | number | boolean>): Tagged[] {
  const envelope: HookEnvelopeV1 = fixtureEnvelope(event, {
    receivedAt: T + dt,
    eventUid: `uid-${event}-${String(dt)}`,
    ...(data === undefined ? {} : { data }),
  });
  return normalizeEnvelope(envelope).events.map((e) => ({ event: e, origin: 'hook' as const }));
}

const external = {
  attempt(state: 'COMPLETED' | 'FAILED', rowKey: string, observedDt: number): Tagged[] {
    return [
      {
        event: {
          k: 'external.attempt',
          sessionId: SID,
          state,
          evidence: `chain log: exit=${state === 'COMPLETED' ? '0' : '1'} status=${state}`,
          rowKey,
          endedAt: T + observedDt - 1000,
          observedAt: T + observedDt,
        },
        origin: 'external',
      },
    ];
  },
  cleared(observedDt: number): Tagged[] {
    return [
      { event: { k: 'external.attempt_cleared', sessionId: SID, observedAt: T + observedDt }, origin: 'external' },
    ];
  },
  job(state: string, observedDt: number): Tagged[] {
    return [
      {
        event: { k: 'external.job', sessionId: SID, jobId: 'job-1', state, observedAt: T + observedDt },
        origin: 'external',
      },
    ];
  },
  pid(alive: boolean, checkedDt: number): Tagged[] {
    return [
      { event: { k: 'external.pid', sessionId: SID, pid: 4242, alive, checkedAt: T + checkedDt }, origin: 'external' },
    ];
  },
};

const started = (): Tagged[] => hook('SessionStart', 0);
const prompted = (): Tagged[] => [...started(), ...hook('UserPromptSubmit', sec(5))];
const stopped = (): Tagged[] => [...prompted(), ...hook('Stop', sec(20), { background_task_count: 0 })];

function fold(events: readonly Tagged[]): LifecycleModel {
  return events.reduce((m, { event, origin }) => applyEvent(m, event, origin), emptyModel());
}

// ---- candidates and lookups -------------------------------------------------------------------------------------------------

interface Built {
  readonly candidate: CompletionCandidate;
  /** How many times the re-derivation inputs were asked for. */
  readonly asked: () => number;
}

interface BuildOptions {
  readonly label?: string;
  readonly startedAt?: number | null;
  readonly lastActivityAt?: number | null;
  readonly inputs?: ModelInputs;
  /** The model of the re-derivation, when it differs from the one the stored view was derived from. */
  readonly laterModel?: LifecycleModel;
  readonly view?: LifecycleView;
  readonly noFacts?: boolean;
}

/** A candidate whose stored view was derived by the writer at `evaluatedAt`. */
function candidate(sessionId: string, events: readonly Tagged[], evaluatedAt: number, o: BuildOptions = {}): Built {
  const model = fold(events);
  const inputs = o.inputs ?? {};
  const view = o.view ?? deriveModel(model, T + evaluatedAt, CFG, inputs).session;
  let asked = 0;
  return {
    asked: () => asked,
    candidate: {
      sessionId,
      label: o.label ?? 'nightly',
      startedAt: o.startedAt === undefined ? T : o.startedAt,
      lastActivityAt: o.lastActivityAt === undefined ? T + evaluatedAt : o.lastActivityAt,
      view,
      derivation: () => {
        asked += 1;
        return o.noFacts === true ? null : { model: o.laterModel ?? model, inputs, cfg: CFG };
      },
    },
  };
}

interface Memory {
  readonly sessions?: readonly CompletionCandidate[];
  readonly rows?: readonly AttemptRowRef[];
}

/** An in-memory lookup that records every call: exact, case-sensitive label equality like the repository. */
function lookupOf(memory: Memory): CompletionLookup & { readonly calls: string[] } {
  const calls: string[] = [];
  const sessions = memory.sessions ?? [];
  return {
    calls,
    sessionById(id) {
      calls.push('sessionById');
      return sessions.find((c) => c.sessionId === id) ?? null;
    },
    sessionsByLabel(label) {
      calls.push('sessionsByLabel');
      return sessions.filter((c) => c.label === label);
    },
    attemptRowsByPart(part) {
      calls.push('attemptRowsByPart');
      return (memory.rows ?? []).filter((r) => r.part === part);
    },
  };
}

function row(over: Partial<AttemptRowRef> & Pick<AttemptRowRef, 'id' | 'part'>): AttemptRowRef {
  return {
    startedAt: T,
    endedAt: T + sec(30),
    endReason: 'ended',
    state: 'COMPLETED',
    evidence: 'chain log: exit=0 status=PASS',
    sessionId: null,
    ...over,
  };
}

function explain(memory: Memory, target: CompletionTarget, atDt: number): CompletionEvidence {
  const result = explainCompletion(lookupOf(memory), target, T + atDt);
  expect(CompletionEvidenceSchema.safeParse(result).success).toBe(true);
  return result;
}

function summary(r: CompletionEvidence): Record<string, unknown> {
  return { outcome: r.outcome, state: r.state, ruleId: r.ruleId, sessionId: r.sessionId, candidates: r.candidates };
}

// ---- CE-1 .. CE-9: one session ----------------------------------------------------------------------------------------------

describe('explainCompletion, a session id (CE-1..CE-9)', () => {
  const cases: readonly {
    readonly id: string;
    readonly title: string;
    readonly events: readonly Tagged[];
    readonly at: number;
    readonly expected: { outcome: string; state: string; ruleId: string };
    readonly inputs?: ModelInputs;
    readonly basis?: string;
  }[] = [
    {
      id: 'CE-1',
      title: 'an attempts row COMPLETED completes the session',
      events: [...prompted(), ...external.attempt('COMPLETED', 'attempt:1', sec(26))],
      at: sec(30),
      expected: { outcome: 'completed', state: 'completed', ruleId: 'S-1' },
      basis: 'observed',
    },
    {
      id: 'CE-2',
      title: 'an attempts row FAILED fails the session',
      events: [...prompted(), ...external.attempt('FAILED', 'attempt:1', sec(26))],
      at: sec(30),
      expected: { outcome: 'failed', state: 'failed', ruleId: 'S-1' },
      basis: 'observed',
    },
    {
      id: 'CE-3',
      title: 'SessionEnd after a normal turn completes the session',
      events: [...stopped(), ...hook('SessionEnd', sec(30))],
      at: sec(40),
      expected: { outcome: 'completed', state: 'completed', ruleId: 'S-3b' },
    },
    {
      id: 'CE-4',
      title: 'StopFailure then SessionEnd fails the session',
      events: [...prompted(), ...hook('StopFailure', sec(20)), ...hook('SessionEnd', sec(30))],
      at: sec(40),
      expected: { outcome: 'failed', state: 'failed', ruleId: 'S-3a' },
    },
    {
      id: 'CE-5',
      title: 'a daemon job done completes a session whose turn ended',
      events: [...stopped(), ...external.job('done', sec(30))],
      at: sec(40),
      expected: { outcome: 'completed', state: 'completed', ruleId: 'S-4a' },
    },
    {
      id: 'CE-6',
      title: 'a Stop without SessionEnd is not terminal',
      events: stopped(),
      at: sec(30),
      expected: { outcome: 'not_terminal', state: 'turn_ended', ruleId: 'S-8e' },
      basis: 'observed',
    },
    {
      id: 'CE-7',
      title: 'a trailing cost state with no live process is an inferred end, never completed',
      events: stopped(),
      at: sec(30),
      inputs: { costStateTrailing: true },
      expected: { outcome: 'not_terminal', state: 'turn_ended', ruleId: 'S-8e' },
      basis: 'inferred',
    },
    {
      id: 'CE-8',
      title: 'a session inside a turn is working',
      events: prompted(),
      at: sec(10),
      expected: { outcome: 'not_terminal', state: 'working', ruleId: 'S-7e' },
    },
    {
      id: 'CE-9',
      title: 'a dead process without SessionEnd is stale, never completed',
      events: [...stopped(), ...external.pid(false, sec(45))],
      at: sec(50),
      expected: { outcome: 'not_terminal', state: 'stale', ruleId: 'S-5' },
      basis: 'inferred',
    },
  ];

  it.each(cases)('$id $title', ({ events, at, expected, inputs, basis }) => {
    const built = candidate(ID_A, events, at, inputs === undefined ? {} : { inputs });
    const result = explain({ sessions: [built.candidate] }, { sessionId: ID_A }, at);
    expect(summary(result)).toEqual({ ...expected, sessionId: ID_A, candidates: 1 });
    expect(result.resolvedBy).toBe('session_id');
    if (basis !== undefined) expect(result.basis).toBe(basis);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.length).toBeLessThanOrEqual(8);
    // a stored view that is not due is used as it is; only one that rests on a daemon job is checked against its facts
    expect(built.asked()).toBe(expected.ruleId === 'S-4a' ? 1 : 0);
  });

  it('copies state, basis, confidence and rule from the view of the session', () => {
    const built = candidate(ID_A, [...stopped(), ...hook('SessionEnd', sec(30))], sec(40));
    const result = explain({ sessions: [built.candidate] }, { sessionId: ID_A }, sec(40));
    expect(result).toMatchObject({
      state: built.candidate.view.state,
      basis: built.candidate.view.basis,
      confidence: built.candidate.view.confidence,
      ruleId: built.candidate.view.ruleId,
    });
  });

  it('answers an unknown session id with target_not_found', () => {
    const built = candidate(ID_A, stopped(), sec(30));
    expect(() => explain({ sessions: [built.candidate] }, { sessionId: ID_B }, sec(30))).toThrow(CompletionTargetError);
  });
});

// ---- D9: terminal only when observed -----------------------------------------------------------------------------------------

describe('explainCompletion, observed evidence only (D9)', () => {
  function withView(over: Partial<LifecycleView>): CompletionCandidate {
    const base = candidate(ID_A, stopped(), sec(30)).candidate;
    return { ...base, view: { ...base.view, ...over } };
  }

  it('an inferred completed or failed view is not terminal', () => {
    for (const state of ['completed', 'failed'] as const) {
      const c = withView({ state, basis: 'inferred', confidence: 'medium', ruleId: 'S-8e', nextCheckAt: null });
      const result = explain({ sessions: [c] }, { sessionId: ID_A }, sec(30));
      expect(result).toMatchObject({ outcome: 'not_terminal', state, basis: 'inferred' });
    }
  });

  it('an observed completed or failed view is terminal', () => {
    const done = withView({ state: 'completed', basis: 'observed', ruleId: 'S-3b', nextCheckAt: null });
    expect(explain({ sessions: [done] }, { sessionId: ID_A }, sec(30)).outcome).toBe('completed');
    const failed = withView({ state: 'failed', basis: 'observed', ruleId: 'S-3a', nextCheckAt: null });
    expect(explain({ sessions: [failed] }, { sessionId: ID_A }, sec(30)).outcome).toBe('failed');
  });

  it('no other state is terminal, whatever its basis', () => {
    for (const state of [
      'running',
      'working',
      'waiting_input',
      'waiting_tool',
      'waiting_agent',
      'turn_ended',
    ] as const) {
      for (const basis of ['observed', 'inferred'] as const) {
        const c = withView({ state, basis, ruleId: 'S-7e', nextCheckAt: null });
        expect(explain({ sessions: [c] }, { sessionId: ID_A }, sec(30)).outcome, `${state} ${basis}`).toBe(
          'not_terminal',
        );
      }
    }
  });
});

// ---- CE-10: label -------------------------------------------------------------------------------------------------------------

describe('explainCompletion, a label (CE-10)', () => {
  it('CE-10 the newest session decides: older completed, newer working', () => {
    const older = candidate(ID_A, [...stopped(), ...hook('SessionEnd', sec(30))], sec(40), { startedAt: T });
    const newerEvents = [...hook('SessionStart', HOUR), ...hook('UserPromptSubmit', HOUR + sec(5))];
    const newer = candidate(ID_B, newerEvents, HOUR + sec(10), { startedAt: T + HOUR, lastActivityAt: T + HOUR });
    for (const sessions of [
      [older.candidate, newer.candidate],
      [newer.candidate, older.candidate],
    ]) {
      const result = explain({ sessions }, { label: 'nightly' }, HOUR + sec(10));
      expect(summary(result)).toEqual({
        outcome: 'not_terminal',
        state: 'working',
        ruleId: 'S-7e',
        sessionId: ID_B,
        candidates: 2,
      });
      expect(result.resolvedBy).toBe('label');
    }
  });

  it('sorts by start (null last), then by last activity (null last), then by session id', () => {
    const make = (id: string, startedAt: number | null, lastActivityAt: number | null): CompletionCandidate =>
      candidate(id, stopped(), sec(30), { startedAt, lastActivityAt }).candidate;
    const pick = (cs: CompletionCandidate[]): string | null =>
      explain({ sessions: cs }, { label: 'nightly' }, sec(30)).sessionId;
    expect(pick([make(ID_A, null, T + 500), make(ID_B, T + 1, null)])).toBe(ID_B);
    expect(pick([make(ID_A, T, T + 1), make(ID_B, T, T + 2)])).toBe(ID_B);
    expect(pick([make(ID_A, T, null), make(ID_B, T, T)])).toBe(ID_B);
    expect(pick([make(ID_C, T, T), make(ID_B, T, T), make(ID_A, T, T)])).toBe(ID_A);
    expect(pick([make(ID_B, null, null), make(ID_A, null, null)])).toBe(ID_A);
  });

  it('matches the label exactly: case and wildcard characters are plain characters', () => {
    const wild = candidate(ID_A, stopped(), sec(30), { label: '100%_done' }).candidate;
    const other = candidate(ID_B, stopped(), sec(30), { label: '100 percent done' }).candidate;
    const sessions = [wild, other];
    expect(explain({ sessions }, { label: '100%_done' }, sec(30)).sessionId).toBe(ID_A);
    expect(() => explain({ sessions }, { label: '100%' }, sec(30))).toThrow(CompletionTargetError);
    expect(() => explain({ sessions }, { label: '%' }, sec(30))).toThrow(CompletionTargetError);
    expect(() => explain({ sessions }, { label: '100_' }, sec(30))).toThrow(CompletionTargetError);
    expect(() => explain({ sessions }, { label: '100%_DONE' }, sec(30))).toThrow(CompletionTargetError);
  });
});

// ---- CE-11 .. CE-14: attempt part --------------------------------------------------------------------------------------------

describe('explainCompletion, an attempt part (CE-11..CE-14)', () => {
  it('CE-11 the latest row is open: running, not terminal, two candidates', () => {
    const rows = [
      row({ id: 1, part: 'p', startedAt: T, endedAt: T + sec(30), endReason: 'ended', evidence: 'chain log: PASS' }),
      row({
        id: 2,
        part: 'p',
        startedAt: T + HOUR,
        endedAt: null,
        endReason: 'open',
        state: 'RUNNING',
        evidence: 'chain log: START',
        sessionId: ID_A,
      }),
    ];
    const result = explain({ rows }, { attemptPart: 'p' }, HOUR + sec(5));
    expect(summary(result)).toEqual({
      outcome: 'not_terminal',
      state: 'running',
      ruleId: 'C-ATT-OPEN',
      sessionId: ID_A,
      candidates: 2,
    });
    expect(result).toMatchObject({ basis: 'observed', confidence: 'medium', resolvedBy: 'attempt_part' });
    expect(result.evidence).toEqual([
      { kind: 'attempts:attempt_row', at: new Date(T + HOUR).toISOString(), text: 'chain log: START' },
    ]);
  });

  it('CE-12 the latest row ended FAIL and no session matched: failed, session null', () => {
    const rows = [
      row({
        id: 7,
        part: 'p',
        startedAt: T,
        endedAt: T + sec(40),
        state: 'FAILED',
        evidence: 'chain log: exit=1 status=FAIL',
      }),
    ];
    const result = explain({ rows }, { attemptPart: 'p' }, sec(60));
    expect(summary(result)).toEqual({
      outcome: 'failed',
      state: 'failed',
      ruleId: 'C-ATT-ENDED',
      sessionId: null,
      candidates: 1,
    });
    expect(result).toMatchObject({ basis: 'observed', confidence: 'high', resolvedBy: 'attempt_part' });
    expect(result.evidence).toEqual([
      { kind: 'attempts:attempt_row', at: new Date(T + sec(40)).toISOString(), text: 'chain log: exit=1 status=FAIL' },
    ]);
  });

  it('an ended COMPLETED row that no session matched is completed, an UNKNOWN row is not terminal', () => {
    const done = explain({ rows: [row({ id: 1, part: 'p' })] }, { attemptPart: 'p' }, sec(60));
    expect(summary(done)).toMatchObject({ outcome: 'completed', state: 'completed', ruleId: 'C-ATT-ENDED' });
    const unknown = explain({ rows: [row({ id: 1, part: 'p', state: 'UNKNOWN' })] }, { attemptPart: 'p' }, sec(60));
    expect(summary(unknown)).toMatchObject({ outcome: 'not_terminal', state: 'unknown', ruleId: 'C-ATT-ENDED' });
    expect(unknown).toMatchObject({ basis: 'observed', confidence: 'low' });
  });

  it('CE-13 the latest row is superseded: unknown, not terminal', () => {
    const rows = [
      row({ id: 1, part: 'p', startedAt: T, endedAt: T + sec(30), endReason: 'ended' }),
      row({
        id: 2,
        part: 'p',
        startedAt: T + sec(60),
        endedAt: null,
        endReason: 'superseded',
        state: 'UNKNOWN',
        evidence: 'chain log: superseded by a later START',
      }),
    ];
    const result = explain({ rows }, { attemptPart: 'p' }, sec(90));
    expect(summary(result)).toEqual({
      outcome: 'not_terminal',
      state: 'unknown',
      ruleId: 'C-ATT-SUPERSEDED',
      sessionId: null,
      candidates: 2,
    });
    expect(result).toMatchObject({ basis: 'observed', confidence: 'low' });
    expect(result.evidence[0]?.at).toBe(new Date(T + sec(60)).toISOString());
  });

  it('CE-14 an ended row matched to a session whose evidence was retracted: the session decides', () => {
    const retracted = candidate(
      ID_A,
      [...stopped(), ...external.attempt('COMPLETED', 'attempt:1', sec(26)), ...external.cleared(sec(40))],
      sec(50),
    );
    expect(retracted.candidate.view).toMatchObject({ state: 'turn_ended', ruleId: 'S-8e' });
    const rows = [row({ id: 1, part: 'p', sessionId: ID_A })];
    const result = explain({ sessions: [retracted.candidate], rows }, { attemptPart: 'p' }, sec(50));
    expect(summary(result)).toEqual({
      outcome: 'not_terminal',
      state: 'turn_ended',
      ruleId: 'S-8e',
      sessionId: ID_A,
      candidates: 1,
    });
    expect(result.resolvedBy).toBe('attempt_part');
  });

  it('an ended row matched to a live S-1 session is decided by S-1', () => {
    const live = candidate(ID_A, [...prompted(), ...external.attempt('COMPLETED', 'attempt:1', sec(26))], sec(30));
    const rows = [row({ id: 1, part: 'p', sessionId: ID_A }), row({ id: 0, part: 'p', startedAt: T - HOUR })];
    const result = explain({ sessions: [live.candidate], rows }, { attemptPart: 'p' }, sec(30));
    expect(summary(result)).toEqual({
      outcome: 'completed',
      state: 'completed',
      ruleId: 'S-1',
      sessionId: ID_A,
      candidates: 2,
    });
  });

  it('an ended row whose session is no longer known falls back to the row itself, with no session', () => {
    const rows = [row({ id: 1, part: 'p', sessionId: ID_B, state: 'FAILED', evidence: 'chain log: FAIL' })];
    const result = explain({ sessions: [], rows }, { attemptPart: 'p' }, sec(60));
    expect(summary(result)).toMatchObject({ outcome: 'failed', ruleId: 'C-ATT-ENDED', sessionId: null });
  });

  it('takes the row with the latest start, and the higher id when two start together', () => {
    const rows = [
      row({ id: 5, part: 'p', startedAt: T + 10, state: 'FAILED', evidence: 'five' }),
      row({ id: 9, part: 'p', startedAt: T + 10, state: 'COMPLETED', evidence: 'nine' }),
      row({ id: 12, part: 'p', startedAt: T - 5, state: 'FAILED', evidence: 'older start, higher id' }),
    ];
    const result = explain({ rows }, { attemptPart: 'p' }, sec(60));
    expect(result.evidence[0]?.text).toBe('nine');
    expect(result.candidates).toBe(3);
  });

  it('the empty part is a legal part (C17)', () => {
    const rows = [row({ id: 3, part: '' }), row({ id: 4, part: 'named' })];
    const result = explain({ rows }, { attemptPart: '' }, sec(60));
    expect(summary(result)).toMatchObject({ outcome: 'completed', ruleId: 'C-ATT-ENDED', candidates: 1 });
  });

  it('clips the evidence text of the row to 160 code points before it is rendered', () => {
    const long = 'x'.repeat(400);
    const result = explain({ rows: [row({ id: 1, part: 'p', evidence: long })] }, { attemptPart: 'p' }, sec(60));
    const item: LifecycleEvidence = {
      source: 'attempts',
      fact: 'attempt_row',
      at: T + sec(30),
      value: 'x'.repeat(160),
    };
    expect(result.evidence[0]?.text).toBe(renderEvidence(item, T + sec(60)));
    expect(Array.from(result.evidence[0]?.text ?? '').length).toBeLessThanOrEqual(120);
  });
});

// ---- CE-15: re-derivation --------------------------------------------------------------------------------------------------------

describe('explainCompletion, a stored view that is due (CE-15)', () => {
  it('CE-15 a working view past nextCheckAt is re-derived: stale', () => {
    const built = candidate(ID_A, prompted(), sec(10));
    const due = built.candidate.view.nextCheckAt;
    expect(built.candidate.view).toMatchObject({ state: 'working', ruleId: 'S-7e' });
    expect(due).not.toBeNull();
    const result = explain({ sessions: [built.candidate] }, { sessionId: ID_A }, sec(5) + min(40));
    expect(summary(result)).toEqual({
      outcome: 'not_terminal',
      state: 'stale',
      ruleId: 'S-7f',
      sessionId: ID_A,
      candidates: 1,
    });
    expect(built.asked()).toBe(1);
  });

  it('is re-derived exactly when nextCheckAt <= now, and not a millisecond before', () => {
    const built = candidate(ID_A, prompted(), sec(10));
    const due = (built.candidate.view.nextCheckAt ?? 0) - T;
    explain({ sessions: [built.candidate] }, { sessionId: ID_A }, due - 1);
    expect(built.asked()).toBe(0);
    explain({ sessions: [built.candidate] }, { sessionId: ID_A }, due);
    expect(built.asked()).toBe(1);
  });

  it('renders the evidence of the re-derived view at the time of the answer', () => {
    const built = candidate(ID_A, prompted(), sec(10));
    const at = sec(5) + min(40);
    const result = explain({ sessions: [built.candidate] }, { sessionId: ID_A }, at);
    expect(result.evidence.some((item) => item.kind === 'clock:quiet' && item.text === 'quiet 40m')).toBe(true);
  });

  it('keeps the stored view when the facts cannot be read', () => {
    const built = candidate(ID_A, prompted(), sec(10), { noFacts: true });
    const result = explain({ sessions: [built.candidate] }, { sessionId: ID_A }, sec(5) + min(40));
    expect(summary(result)).toMatchObject({ outcome: 'not_terminal', state: 'working', ruleId: 'S-7e' });
    expect(built.asked()).toBe(1);
  });

  it('never turns a re-derivation into a terminal outcome for lack of evidence', () => {
    const built = candidate(ID_A, stopped(), sec(30));
    const result = explain({ sessions: [built.candidate] }, { sessionId: ID_A }, sec(20) + 25 * HOUR);
    expect(summary(result)).toMatchObject({ outcome: 'not_terminal', state: 'stale', ruleId: 'S-8d' });
  });
});

// ---- a done job older than later activity -------------------------------------------------------------------------------------

describe('explainCompletion, a daemon job older than later activity (WP-97)', () => {
  const jobDone = (): Tagged[] => [...stopped(), ...external.job('done', sec(30))];
  const later = (): Tagged[] => [...jobDone(), ...hook('UserPromptSubmit', sec(60))];

  it('CE-5b a done job that later activity passed is not completion evidence', () => {
    // the view stored before the later activity said S-4a; the facts now say the job was passed
    const stale = candidate(ID_A, jobDone(), sec(40), { laterModel: fold(later()) });
    expect(stale.candidate.view).toMatchObject({ state: 'completed', ruleId: 'S-4a' });
    const result = explain({ sessions: [stale.candidate] }, { sessionId: ID_A }, sec(70));
    expect(summary(result)).toEqual({
      outcome: 'not_terminal',
      state: 'working',
      ruleId: 'S-7e',
      sessionId: ID_A,
      candidates: 1,
    });
    expect(stale.asked()).toBe(1);
  });

  it('a done job with no later activity stays completed', () => {
    const fresh = candidate(ID_A, jobDone(), sec(40));
    const result = explain({ sessions: [fresh.candidate] }, { sessionId: ID_A }, sec(45));
    expect(summary(result)).toMatchObject({ outcome: 'completed', state: 'completed', ruleId: 'S-4a' });
  });

  it('a failed job that later activity passed is not failure evidence either', () => {
    const jobFailed = [...stopped(), ...external.job('failed', sec(30))];
    const stale = candidate(ID_A, jobFailed, sec(40), {
      laterModel: fold([...jobFailed, ...hook('UserPromptSubmit', sec(60))]),
    });
    expect(stale.candidate.view).toMatchObject({ state: 'failed', ruleId: 'S-4b' });
    const result = explain({ sessions: [stale.candidate] }, { sessionId: ID_A }, sec(70));
    expect(result.outcome).toBe('not_terminal');
  });

  it('with facts that cannot be read the stored S-4a view is kept', () => {
    const stale = candidate(ID_A, jobDone(), sec(40), { noFacts: true });
    expect(explain({ sessions: [stale.candidate] }, { sessionId: ID_A }, sec(70)).outcome).toBe('completed');
  });
});

// ---- CE-16: validation ---------------------------------------------------------------------------------------------------------

describe('explainCompletion, target errors (CE-16)', () => {
  function failure(target: CompletionTarget, memory: Memory = {}): CompletionTargetError {
    try {
      explainCompletion(lookupOf(memory), target, T);
    } catch (error) {
      if (error instanceof CompletionTargetError) return error;
      throw error;
    }
    throw new Error('expected a CompletionTargetError');
  }

  it('CE-16 an invalid session id, an unknown label and an unknown part', () => {
    expect(failure({ sessionId: 'not-a-session' }).code).toBe('target_invalid');
    expect(failure({ sessionId: ID_A.toUpperCase() }).code).toBe('target_invalid');
    expect(failure({ sessionId: '' }).code).toBe('target_invalid');
    expect(failure({ label: 'nobody' }).code).toBe('target_not_found');
    expect(failure({ attemptPart: 'nothing' }).code).toBe('target_not_found');
    expect(failure({ sessionId: ID_A }).code).toBe('target_not_found');
  });

  it('refuses a label outside 1..200 and a part longer than 512 code points before any lookup', () => {
    for (const target of [
      { label: '' },
      { label: 'a'.repeat(201) },
      { label: 'a'.repeat(10_000) },
      { attemptPart: 'p'.repeat(513) },
      { attemptPart: '\u{1F600}'.repeat(513) },
    ]) {
      const lookup = lookupOf({});
      expect(() => explainCompletion(lookup, target, T)).toThrow(CompletionTargetError);
      expect(lookup.calls, JSON.stringify(Object.keys(target))).toEqual([]);
    }
  });

  it('accepts the edges: a label of 1 and of 200, a part of 0 and of 512 code points', () => {
    for (const target of [
      { label: 'a' },
      { label: 'a'.repeat(200) },
      { label: '\u{1F600}'.repeat(200) },
      { attemptPart: '' },
      { attemptPart: 'p'.repeat(512) },
      { attemptPart: '\u{1F600}'.repeat(512) },
    ]) {
      expect(failure(target).code, JSON.stringify(Object.keys(target))).toBe('target_not_found');
    }
  });

  it('a target that names none or several selectors is invalid', () => {
    const none: unknown = {};
    const two: unknown = { sessionId: ID_A, label: 'x' };
    const wrongType: unknown = { label: 5 };
    for (const target of [none, two, wrongType]) {
      const lookup = lookupOf({});
      const call = (): CompletionEvidence => explainCompletion(lookup, target as CompletionTarget, T);
      expect(call).toThrow(CompletionTargetError);
      expect(lookup.calls).toEqual([]);
    }
  });

  it('carries the code and the target, and a message that holds neither', () => {
    const error = failure({ label: 'secret label text' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CompletionTargetError');
    expect(error.code).toBe('target_not_found');
    expect(error.target).toEqual({ label: 'secret label text' });
    expect(error.message).toBe('target_not_found');
    expect(String(error.stack)).not.toContain('secret label text');
  });

  it('validateCompletionTarget throws the same invalid errors without any lookup', () => {
    expect(() => {
      validateCompletionTarget({ label: 'a'.repeat(201) });
    }).toThrow(CompletionTargetError);
    expect(() => {
      validateCompletionTarget({ sessionId: ID_A });
    }).not.toThrow();
    expect(() => {
      validateCompletionTarget({ attemptPart: '' });
    }).not.toThrow();
  });
});

// ---- CE-17: the words of the evidence ----------------------------------------------------------------------------------------------

describe('explainCompletion, the evidence text (CE-17)', () => {
  it('CE-17 every item is the API form of the engine item, rendered at the time of the answer', () => {
    const events = [...stopped(), ...hook('SessionEnd', sec(30))];
    const built = candidate(ID_A, events, sec(40));
    for (const at of [sec(40), sec(40) + min(7), sec(40) + 5 * HOUR]) {
      const result = explain({ sessions: [built.candidate] }, { sessionId: ID_A }, at);
      expect(result.evidence).toHaveLength(built.candidate.view.evidence.length);
      result.evidence.forEach((item, i) => {
        const source = built.candidate.view.evidence[i];
        if (source === undefined) throw new Error('evidence item missing');
        expect(item.kind).toBe(`${source.source}:${source.fact}`);
        expect(item.text).toBe(renderEvidence(source, T + at));
        expect(item.at).toBe(source.at === null ? null : new Date(source.at).toISOString());
      });
    }
  });

  it('keeps at most eight evidence items', () => {
    const base = candidate(ID_A, stopped(), sec(30)).candidate;
    const item: LifecycleEvidence = { source: 'clock', fact: 'quiet', at: T };
    const crowded: CompletionCandidate = { ...base, view: { ...base.view, evidence: Array(12).fill(item) } };
    expect(explain({ sessions: [crowded] }, { sessionId: ID_A }, sec(30)).evidence).toHaveLength(8);
  });

  it('is deterministic: the same lookup, target and time give the same answer', () => {
    const built = candidate(ID_A, stopped(), sec(30));
    const first = explain({ sessions: [built.candidate] }, { sessionId: ID_A }, sec(30));
    const second = explain({ sessions: [built.candidate] }, { sessionId: ID_A }, sec(30));
    expect(second).toEqual(first);
  });
});

// ---- purity -------------------------------------------------------------------------------------------------------------------------

describe('completion.ts is pure', () => {
  const source = readFileSync(new URL('./completion.ts', import.meta.url), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('reads no clock, no file, no process and no random source', () => {
    for (const forbidden of [
      /Date\.now/,
      /new Date\b/,
      /\bperformance\b/,
      /Math\.random/,
      /\bsetTimeout\b/,
      /from 'node:/,
      /from 'fs'/,
      /\bprocess\./,
      /\brequire\(/,
      /\bawait\b/,
    ]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('does not import the database layer other than for types', () => {
    const imports = code.split('\n').filter((line) => line.startsWith('import ') && line.includes('/db/'));
    for (const line of imports) expect(line.startsWith('import type'), line).toBe(true);
  });
});
