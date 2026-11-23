// The contracts of `events` and `wait` (ADR 0108): the caw.event/1 line, the wait result, durations and exit codes.
import { describe, expect, it } from 'vitest';

import type { StateAssessment } from '../api/entities.ts';
import {
  CLI_EVENT_SCHEMA,
  CLI_EVENT_TYPES,
  CliEventSchema,
  WAIT_EXIT_CODES,
  WAIT_OUTCOMES,
  WAIT_TIMEOUT_MAX_MS,
  WaitResultSchema,
  cliEventSessionOf,
  parseDuration,
  waitExitCode,
  waitStateOf,
} from './watch.ts';

const INSTANCE = '0b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d11';
const SESSION = '11111111-2222-4333-8444-555555555555';
const AT = '2026-11-20T10:00:00.000Z';

const assessment: StateAssessment = {
  state: 'waiting_input',
  presence: 'open',
  waitReason: 'permission',
  staleKind: null,
  endReason: null,
  turnOutcome: null,
  basis: 'observed',
  confidence: 'high',
  rule: 'S-6b',
  evidence: [{ kind: 'registry:waiting', at: AT, text: 'evidence words that must not leave' }],
  since: AT,
  evaluatedAt: AT,
  legacyState: 'IDLE',
};

const session = cliEventSessionOf(assessment);
const tag = { schema: CLI_EVENT_SCHEMA };
const events = {
  hello: { ...tag, type: 'hello', instanceId: INSTANCE, epoch: '0a1b2c3d', headSeq: 7, serverTime: AT },
  change: { ...tag, type: 'change', seq: 8, at: AT, kind: 'session', op: 'upsert', sessionId: SESSION, session },
  reset: { ...tag, type: 'reset', reason: 'cursor_too_old', headSeq: 9 },
  end: { ...tag, type: 'end', headSeq: 9, count: 2 },
} as const;

describe('caw.event/1', () => {
  it('TC-EVW-03 accepts each line type and is strict about every one', () => {
    expect(CLI_EVENT_SCHEMA).toBe('caw.event/1');
    expect(Object.keys(events)).toEqual([...CLI_EVENT_TYPES]);
    for (const [type, event] of Object.entries(events)) {
      expect(CliEventSchema.safeParse(event).success, type).toBe(true);
      expect(CliEventSchema.safeParse({ ...event, label: 'x' }).success, `${type} extra key`).toBe(false);
      expect(CliEventSchema.safeParse({ ...event, schema: 'mcs.cli/1' }).success, `${type} schema`).toBe(false);
      const partial = Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'headSeq' && key !== 'seq'));
      expect(CliEventSchema.safeParse(partial).success, `${type} missing key`).toBe(false);
    }
    expect(CliEventSchema.safeParse({ ...events.end, type: 'heartbeat' }).success).toBe(false);
  });

  it('TC-EVW-03 carries the state and the attention of a session upsert and nothing else of it', () => {
    expect(session).toEqual({
      state: 'waiting_input',
      rule: 'S-6b',
      basis: 'observed',
      confidence: 'high',
      presence: 'open',
      waitReason: 'permission',
      turnOutcome: null,
      since: AT,
      attention: { posture: 'needs_you', reason: 'permission' },
    });
    const change = events.change;
    expect(CliEventSchema.safeParse({ ...change, session: { ...session, evidence: [] } }).success).toBe(false);
    expect(CliEventSchema.safeParse({ ...change, session: null }).success).toBe(true);
    expect(CliEventSchema.safeParse({ ...change, kind: 'event', op: 'append', session: null }).success).toBe(true);
    expect(CliEventSchema.safeParse({ ...change, kind: 'event', op: 'append' }).success).toBe(false);
    expect(CliEventSchema.safeParse({ ...change, op: 'delete' }).success).toBe(false);
  });
});

describe('wait contracts', () => {
  it('TC-EVW-05 maps each outcome to its exit code: met 0, timeout 4, ended 5, missing 6', () => {
    expect(WAIT_EXIT_CODES).toEqual({ met: 0, timeout: 4, ended: 5, missing: 6 });
    expect(WAIT_OUTCOMES.map((outcome) => waitExitCode(outcome))).toEqual([0, 4, 5, 6]);
  });

  it('TC-EVW-05 validates the wait result strictly', () => {
    const result = {
      outcome: 'met',
      until: 'needs_you',
      sessionId: SESSION,
      state: waitStateOf(assessment),
      attention: session.attention,
      completion: null,
      waitedMs: 1200,
      alreadyTrue: false,
    };
    expect(WaitResultSchema.safeParse(result).success).toBe(true);
    const missing = { ...result, outcome: 'missing', sessionId: null, state: null, attention: null };
    expect(WaitResultSchema.safeParse(missing).success).toBe(true);
    const completion = { outcome: 'not_terminal', ruleId: 'S-8e' };
    expect(WaitResultSchema.safeParse({ ...result, until: 'completed', completion }).success).toBe(true);
    expect(WaitResultSchema.safeParse({ ...result, outcome: 'done' }).success).toBe(false);
    expect(WaitResultSchema.safeParse({ ...result, until: 'idle' }).success).toBe(false);
    expect(WaitResultSchema.safeParse({ ...result, state: assessment }).success).toBe(false);
    expect(WaitResultSchema.safeParse({ ...result, label: 'x' }).success).toBe(false);
    expect(WaitResultSchema.safeParse({ ...result, waitedMs: -1 }).success).toBe(false);
  });

  it('TC-EVW-05 parses durations from 0 to 7 days and refuses the rest', () => {
    const cases: [string, number | null][] = [
      ['0', 0],
      ['0s', 0],
      ['45', 45_000],
      ['45s', 45_000],
      ['30m', 1_800_000],
      ['2h', 7_200_000],
      ['7d', WAIT_TIMEOUT_MAX_MS],
      ['168h', WAIT_TIMEOUT_MAX_MS],
      ['8d', null],
      ['604801s', null],
      ['', null],
      ['-1s', null],
      ['1.5h', null],
      ['1e3', null],
      ['10 s', null],
      ['5w', null],
      ['1h30m', null],
      ['9999999999', null],
    ];
    for (const [text, expected] of cases) expect(parseDuration(text), JSON.stringify(text)).toBe(expected);
    expect(parseDuration('61s', 60_000)).toBeNull();
    expect(parseDuration('60', 60_000)).toBe(60_000);
  });
});
