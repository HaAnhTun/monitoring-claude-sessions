// The legacy five-state view (02 7.9): `toLegacy` (T-LF-56), the port of `classify_state` checked against the golden
// outputs of the pre-4.0 engine, frozen as committed JSON (T-LF-51, ADR 0066), the agent override, `legacyDone`, and the choice between the two paths.
import { readFileSync } from 'node:fs';

import { LIFECYCLE_STATES, type LegacyState } from '@mcs/shared';
import type { Stamp } from '@mcs/shared/protocol';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIFECYCLE_CFG,
  emptyToolCallRow,
  sessionFactsWith,
  type Lww,
  type SessionFacts,
  type ToolCallRow,
} from './facts.ts';
import {
  classifyLegacy,
  classifyLegacyAgent,
  classifyLegacyOfFacts,
  legacyAgentDone,
  legacyDone,
  legacyOfSession,
  pyFloorDiv,
  pyReprStr,
  toLegacy,
  type LegacyClassifyInput,
} from './legacy.ts';
import { deriveSession } from './derive-session.ts';

const BS = String.fromCharCode(92);
const CFG = DEFAULT_LIFECYCLE_CFG;
const st = (at: number, rank = 0, tie = ''): Stamp => ({ at, rank, tie });
const lww = <T>(stamp: Stamp, value: T): Lww<T> => ({ stamp, value });

describe('toLegacy (T-LF-56, 02 7.9 item 2)', () => {
  const table: readonly (readonly [(typeof LIFECYCLE_STATES)[number], LegacyState])[] = [
    ['running', 'RUNNING'],
    ['working', 'RUNNING'],
    ['waiting_agent', 'RUNNING'],
    ['waiting_tool', 'RUNNING'],
    ['waiting_input', 'IDLE'],
    ['turn_ended', 'IDLE'],
    ['completed', 'COMPLETED'],
    ['failed', 'FAILED'],
    ['stale', 'UNKNOWN'],
    ['unknown', 'UNKNOWN'],
  ];
  it.each(table)('%s -> %s', (state, legacy) => {
    expect(toLegacy({ state })).toBe(legacy);
  });

  it('maps every lifecycle state', () => {
    expect(table.map(([state]) => state).sort()).toEqual([...LIFECYCLE_STATES].sort());
  });
});

describe('Python helpers', () => {
  it('pyFloorDiv floors like Python, also for negative and fractional values', () => {
    expect(pyFloorDiv(119.5, 60)).toBe(1);
    expect(pyFloorDiv(60, 60)).toBe(1);
    expect(pyFloorDiv(59.999, 60)).toBe(0);
    expect(pyFloorDiv(-1, 60)).toBe(-1);
    expect(pyFloorDiv(-60, 60)).toBe(-1);
    expect(pyFloorDiv(-60.5, 60)).toBe(-2);
    expect(pyFloorDiv(100_000.5, 60)).toBe(1666);
    expect(Object.is(pyFloorDiv(0, 60), 0)).toBe(true);
  });

  it('pyReprStr picks quotes and escapes like repr()', () => {
    expect(pyReprStr('missing')).toBe("'missing'");
    expect(pyReprStr('END_TURN')).toBe("'END_TURN'");
    expect(pyReprStr("it's")).toBe('"it' + "'" + 's"');
    expect(pyReprStr(`a"b'c`)).toBe("'a" + '"' + 'b' + BS + "'" + "c'");
    expect(pyReprStr('a' + BS + 'b')).toBe("'a" + BS + BS + "b'");
    expect(pyReprStr('a' + String.fromCharCode(10) + 'b')).toBe("'a" + BS + "nb'");
    expect(pyReprStr('a' + String.fromCharCode(9) + String.fromCharCode(13))).toBe("'a" + BS + 't' + BS + "r'");
    expect(pyReprStr(String.fromCharCode(1) + String.fromCharCode(127))).toBe("'" + BS + 'x01' + BS + "x7f'");
    expect(pyReprStr(String.fromCodePoint(0xe9))).toBe("'" + String.fromCodePoint(0xe9) + "'");
    expect(pyReprStr(String.fromCodePoint(0xa0))).toBe("'" + BS + "xa0'");
    expect(pyReprStr(String.fromCodePoint(0x200b))).toBe("'" + BS + "u200b'");
    expect(pyReprStr(String.fromCodePoint(0x1f600))).toBe("'" + String.fromCodePoint(0x1f600) + "'");
    expect(pyReprStr('')).toBe("''");
  });
});

// ---- T-LF-51: the golden outputs of `classify_state` ---------------------------------------------------------------
// Frozen data of the pre-4.0 engine, ADR 0066: the captured outputs of the legacy `classify_state`, committed as JSON.

interface GoldenCase {
  readonly case: string;
  readonly input: {
    readonly now: number;
    readonly mtime: number;
    readonly active_seconds: number;
    readonly last_stop: string | null;
    readonly pending: number;
    readonly oldest_pending_ts: number | null;
    readonly agent_mtimes: readonly number[];
    readonly grace_seconds: number;
    readonly registry: { readonly status?: string | null } | null;
    readonly external: { readonly state?: string; readonly evidence?: string } | null;
    readonly has_records: boolean;
  };
  readonly output: readonly [string, string, string];
}

const GOLDEN_URL = new URL('../../test/fixtures/lifecycle/classify-state.frozen.json', import.meta.url);
const GOLDEN = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as GoldenCase[];

function inputOfGolden(g: GoldenCase['input']): LegacyClassifyInput {
  const external = g.external;
  // Python truthiness: an empty dict is "no external entry"
  const hasExternal = external?.state !== undefined && external.evidence !== undefined;
  return {
    mtime: g.mtime,
    activeSeconds: g.active_seconds,
    lastStop: g.last_stop,
    pending: g.pending,
    oldestPendingTs: g.oldest_pending_ts,
    agentMtimes: g.agent_mtimes,
    graceSeconds: g.grace_seconds,
    registry: g.registry,
    external: hasExternal ? { state: external.state as LegacyState, evidence: external.evidence ?? '' } : null,
    hasRecords: g.has_records,
  };
}

describe('classifyLegacy against the frozen golden (T-LF-51)', () => {
  it('has the whole golden file (every branch, boundary seconds, fractional ages, falsy values)', () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(130);
  });

  it.each(GOLDEN.map((g) => [g.case, g] as const))('%s', (_name, g) => {
    const out = classifyLegacy(inputOfGolden(g.input), g.input.now);
    expect([out.state, out.evidence, out.source]).toEqual(g.output);
  });
});

describe('classifyLegacy: the StateTest cases of tests/test_state_config_tasks.py', () => {
  const base: LegacyClassifyInput = {
    mtime: 1000,
    activeSeconds: 120,
    lastStop: 'end_turn',
    pending: 0,
    oldestPendingTs: 0,
    agentMtimes: [],
    graceSeconds: 900,
    registry: null,
    external: null,
    hasRecords: true,
  };
  const run = (over: Partial<LegacyClassifyInput>, now = 1000): string =>
    classifyLegacy({ ...base, ...over }, now).state;

  it('a recent write is RUNNING, a quiet end_turn is IDLE (never COMPLETED)', () => {
    expect(run({ mtime: 950 })).toBe('RUNNING');
    expect(run({ mtime: 500 })).toBe('IDLE');
  });

  it('COMPLETED and FAILED need external evidence', () => {
    expect(run({ mtime: 500, external: { state: 'COMPLETED', evidence: 'x' } })).toBe('COMPLETED');
    expect(run({ mtime: 500, external: { state: 'FAILED', evidence: 'x' } })).toBe('FAILED');
    for (const stop of ['end_turn', 'tool_use', '', null]) {
      expect(['COMPLETED', 'FAILED']).not.toContain(run({ mtime: 0, lastStop: stop }));
    }
  });

  it('subagent activity keeps the parent RUNNING', () => {
    expect(run({ mtime: 500, agentMtimes: [990] })).toBe('RUNNING');
    expect(run({ mtime: 500, agentMtimes: [800] })).toBe('IDLE');
  });

  it('a pending tool is RUNNING within the grace, then UNKNOWN', () => {
    expect(run({ mtime: 500, lastStop: 'tool_use', pending: 1, oldestPendingTs: 500 })).toBe('RUNNING');
    expect(run({ mtime: 500, lastStop: 'tool_use', pending: 1, oldestPendingTs: 500 }, 5000)).toBe('UNKNOWN');
  });

  it('the registry decides busy and idle; unreadable is UNKNOWN', () => {
    expect(run({ mtime: 0, registry: { status: 'busy' } })).toBe('RUNNING');
    expect(run({ mtime: 0, lastStop: '', registry: { status: 'idle' } })).toBe('IDLE');
    expect(run({ hasRecords: false })).toBe('UNKNOWN');
  });
});

describe('classifyLegacyAgent and the done flags', () => {
  const agentInput: LegacyClassifyInput = {
    mtime: 1000,
    activeSeconds: 120,
    lastStop: 'end_turn',
    pending: 0,
    oldestPendingTs: 0,
    agentMtimes: [],
    graceSeconds: 900,
    registry: null,
    external: null,
    hasRecords: true,
  };

  it('a quiet agent whose turn ended is COMPLETED with the legacy text (the sessions.py override)', () => {
    expect(classifyLegacyAgent({ ...agentInput, mtime: 500 }, 1000)).toEqual({
      state: 'COMPLETED',
      evidence: 'subagent ended its turn (end_turn); it continues only if its parent resumes it',
      source: 'transcript',
    });
    expect(classifyLegacyAgent({ ...agentInput, mtime: 950 }, 1000).state).toBe('RUNNING');
    expect(classifyLegacyAgent({ ...agentInput, mtime: 500, lastStop: 'tool_use' }, 1000).state).toBe('UNKNOWN');
  });

  it('legacyDone: age >= active_seconds, an end stop and no agent written within 60 s (int-truncated ages)', () => {
    const done = { age: 200, activeSeconds: 120, stop: 'end_turn', agentAges: [] as number[] };
    expect(legacyDone(done)).toBe(true);
    expect(legacyDone({ ...done, age: 119.9 })).toBe(false);
    expect(legacyDone({ ...done, stop: 'tool_use' })).toBe(false);
    expect(legacyDone({ ...done, stop: null })).toBe(false);
    expect(legacyDone({ ...done, stop: 'stop_sequence' })).toBe(true);
    expect(legacyDone({ ...done, agentAges: [59.9] })).toBe(false);
    expect(legacyDone({ ...done, agentAges: [60, 300] })).toBe(true);
  });

  it('legacyAgentDone: aage >= 60 and an end stop', () => {
    expect(legacyAgentDone(60, 'end_turn')).toBe(true);
    expect(legacyAgentDone(59.99, 'end_turn')).toBe(false);
    expect(legacyAgentDone(600, 'max_tokens')).toBe(false);
  });
});

// ---- from facts ----------------------------------------------------------------------------------------------------

const NOW = 1_791_727_200_000;

function row(over: Partial<ToolCallRow>): ToolCallRow {
  return { ...emptyToolCallRow('t'), ...over };
}

describe('classifyLegacyOfFacts (sessions without hook evidence)', () => {
  const facts = (over: Partial<SessionFacts>): SessionFacts =>
    sessionFactsWith({ hasRecords: true, firstSeenAt: NOW - 3_600_000, transcriptMtime: NOW - 10 * 60_000, ...over });

  it('a quiet transcript whose last stop is end_turn is IDLE (M6, N16)', () => {
    const out = classifyLegacyOfFacts(
      facts({ legacy: { lastStop: lww(st(1), 'end_turn'), fileFirstTs: null, fileMaxTs: null } }),
      { tools: [], agents: [] },
      NOW,
      CFG,
    );
    expect(out).toEqual({
      state: 'IDLE',
      evidence: 'turn ended (end_turn), quiet 10m; the transcript cannot show whether the job is finished or waiting',
      source: 'transcript',
    });
  });

  it('pending tool calls are the rows with a transcript tool_use and no tool_result of the main agent', () => {
    const rows = {
      tools: [
        row({ toolUseId: 'a', transcriptUse: true, startedAt: NOW - 5 * 60_000 }),
        row({ toolUseId: 'b', transcriptUse: true, startedAt: NOW - 3 * 60_000 }),
        row({ toolUseId: 'c', transcriptUse: true, transcriptResult: true, startedAt: NOW - 9 * 60_000 }),
        row({ toolUseId: 'd', transcriptUse: true, startedAt: NOW - 20 * 60_000, agentId: 'a1' }),
        row({ toolUseId: 'e', startedAt: NOW - 20 * 60_000 }),
      ],
      agents: [],
    };
    const out = classifyLegacyOfFacts(facts({}), rows, NOW, CFG);
    expect(out.state).toBe('RUNNING');
    expect(out.evidence).toBe('2 tool call(s) without result for 300s (within the 900s grace)');
  });

  it('agent file mtimes, the live registry and the attempts evidence are passed through', () => {
    const agents = [{ fileMtime: NOW - 20_000 }];
    expect(classifyLegacyOfFacts(facts({}), { tools: [], agents }, NOW, CFG)).toMatchObject({
      state: 'RUNNING',
      evidence: '1 subagent(s) written within the last minute',
    });
    const busy = facts({
      registry: lww(st(NOW - 1000), { status: 'busy' as const, waitingFor: null, pid: 1, pidAlive: true }),
    });
    expect(classifyLegacyOfFacts(busy, { tools: [], agents: [] }, NOW, CFG).source).toBe('registry');
    const deadRegistry = facts({
      registry: lww(st(NOW - 1000), { status: 'busy' as const, waitingFor: null, pid: 1, pidAlive: false }),
    });
    expect(classifyLegacyOfFacts(deadRegistry, { tools: [], agents: [] }, NOW, CFG).source).toBe('transcript');
    const waiting = facts({
      registry: lww(st(NOW - 1000), { status: 'waiting' as const, waitingFor: null, pid: 1, pidAlive: true }),
    });
    expect(classifyLegacyOfFacts(waiting, { tools: [], agents: [] }, NOW, CFG).source).toBe('transcript');
    const attempt = facts({
      attempt: lww(st(NOW, 1, 'k'), {
        state: 'FAILED' as const,
        evidence: 'chain log: exit=1 status=FAIL',
        rowKey: 'k',
        endedAt: NOW - 1,
      }),
    });
    expect(classifyLegacyOfFacts(attempt, { tools: [], agents: [] }, NOW, CFG)).toEqual({
      state: 'FAILED',
      evidence: 'chain log: exit=1 status=FAIL',
      source: 'external',
    });
    expect(classifyLegacyOfFacts(facts({ hasRecords: false }), { tools: [], agents: [] }, NOW, CFG).state).toBe(
      'UNKNOWN',
    );
  });
});

describe('legacyOfSession: the two paths of 02 7.9', () => {
  it('without hook evidence the classifier port decides', () => {
    const facts = sessionFactsWith({
      hasRecords: true,
      firstSeenAt: NOW - 3_600_000,
      transcriptMtime: NOW - 10_000,
    });
    const rows = { tools: [], agents: [], workflows: [] };
    const view = deriveSession(facts, rows, NOW, CFG);
    expect(legacyOfSession(facts, rows, view, NOW, CFG)).toEqual({
      state: 'RUNNING',
      evidence: 'transcript written 10s ago',
      source: 'transcript',
    });
  });

  it('with hook evidence the new state is mapped and its evidence is rendered (source hook)', () => {
    const at = NOW - 30_000;
    const facts = sessionFactsWith({
      firstSeenAt: at,
      lastHookAt: at,
      lastPromptHook: st(at, 10, 'p'),
      lastActivity: st(at, 10, 'p'),
    });
    const rows = { tools: [], agents: [], workflows: [] };
    const view = deriveSession(facts, rows, NOW, CFG);
    const legacy = legacyOfSession(facts, rows, view, NOW, CFG);
    expect(legacy.state).toBe('RUNNING');
    expect(legacy.source).toBe('hook');
    expect(legacy.evidence).toBe('prompt submitted 30s ago; quiet 30s');
  });
});
