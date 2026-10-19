// One test per row of the session decision table (02 7.4, rules S-1 to S-10) plus the rule order, written against facts
// built by hand so that a failure names the rule, not an event pipeline.
import type { Stamp } from '@mcs/shared/protocol';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIFECYCLE_CFG,
  emptyToolCallRow,
  sessionFactsWith,
  type AttemptFact,
  type LifecycleView,
  type Lww,
  type SessionFacts,
  type ToolCallRow,
  type TurnEndInfo,
} from './facts.ts';
import { deriveSession, isReopened } from './derive-session.ts';
import { renderEvidence, type AgentSummary, type SessionRows, type WorkflowSummary } from './rules.ts';

const NOW = 1_791_727_200_000;
const SEC = 1000;
const MIN = 60 * SEC;
const CFG = DEFAULT_LIFECYCLE_CFG;
const st = (at: number, rank = 0, tie = ''): Stamp => ({ at, rank, tie });
const lww = <T>(stamp: Stamp, value: T): Lww<T> => ({ stamp, value });
const NO_ROWS: SessionRows = { tools: [], agents: [], workflows: [] };

function info(kind: TurnEndInfo['kind'], over: Partial<TurnEndInfo> = {}): TurnEndInfo {
  return {
    kind,
    promptId: null,
    error: null,
    backgroundTasks: null,
    pendingBackgroundAgents: null,
    pendingWorkflows: null,
    ...over,
  };
}

function derive(facts: Partial<SessionFacts>, rows: Partial<SessionRows> = {}, now = NOW): LifecycleView {
  return deriveSession(sessionFactsWith(facts), { ...NO_ROWS, ...rows }, now, CFG);
}

function kinds(view: LifecycleView): string[] {
  return view.evidence.map((e) => `${e.source}:${e.fact}`);
}

/** Hook facts of a prompt submitted `ago` ms before NOW and nothing after it. */
function promptFacts(ago: number, over: Partial<SessionFacts> = {}): Partial<SessionFacts> {
  const at = NOW - ago;
  return { firstSeenAt: at, lastHookAt: at, lastPromptHook: st(at, 10, 'p'), lastActivity: st(at, 10, 'p'), ...over };
}

/** Hook facts of a prompt and the Stop that ended its turn, both `ago` ms before NOW. */
function stoppedFacts(ago: number, over: Partial<SessionFacts> = {}): Partial<SessionFacts> {
  const at = NOW - ago;
  return {
    ...promptFacts(ago + 5000),
    lastHookAt: at,
    lastActivity: st(at - 1000, 20, 'a'),
    lastTurnEndHook: lww(st(at, 60, 's'), info('stop')),
    ...over,
  };
}

function openTool(startedAgo: number, over: Partial<ToolCallRow> = {}): ToolCallRow {
  return { ...emptyToolCallRow('t1'), name: 'Bash', startedAt: NOW - startedAgo, ...over };
}

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agentId: 'a1',
    state: 'working',
    basis: 'observed',
    lastActivityAt: null,
    fileMtime: null,
    nextCheckAt: null,
    workflowRunId: null,
    ...over,
  };
}

function workflow(over: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return { runId: 'wf_1', state: 'running', basis: 'observed', lastAgentActivity: null, nextCheckAt: null, ...over };
}

const COMPLETED_ATTEMPT: AttemptFact = {
  state: 'COMPLETED',
  evidence: 'chain log: exit=0 status=PASS',
  rowKey: 'attempt:1',
  endedAt: NOW - 1000,
};

describe('S-1: attempts evidence', () => {
  it.each([
    ['COMPLETED', 'completed'],
    ['FAILED', 'failed'],
    ['UNKNOWN', 'unknown'],
  ] as const)('an attempts row %s gives %s, ended, observed, high', (row, state) => {
    const view = derive({
      ...stoppedFacts(10 * MIN),
      attempt: lww(st(NOW, 1, 'attempt:1'), { ...COMPLETED_ATTEMPT, state: row }),
    });
    expect(view).toMatchObject({ state, ruleId: 'S-1', presence: 'ended', basis: 'observed', confidence: 'high' });
    expect(view.evidence[0]).toMatchObject({
      source: 'attempts',
      fact: 'attempt_row',
      at: COMPLETED_ATTEMPT.endedAt,
      value: COMPLETED_ATTEMPT.evidence,
    });
    expect(view.since).toBe(COMPLETED_ATTEMPT.endedAt);
  });

  it('a register holding null (cleared) is no evidence at all', () => {
    const view = derive({ ...stoppedFacts(10 * MIN), attempt: lww(st(NOW, 0, ''), null) });
    expect(view).toMatchObject({ state: 'turn_ended', ruleId: 'S-8e' });
  });

  it('beats SessionEnd', () => {
    const view = derive({
      ...stoppedFacts(10 * MIN),
      end: { stamp: st(NOW - 9 * MIN, 90), reason: 'other' },
      attempt: lww(st(NOW, 1, 'attempt:1'), { ...COMPLETED_ATTEMPT, state: 'FAILED' }),
    });
    expect(view).toMatchObject({ state: 'failed', ruleId: 'S-1' });
  });
});

describe('S-2: no evidence at all', () => {
  it('a session without hooks and without records is unknown, inferred, low', () => {
    const view = derive({});
    expect(view).toMatchObject({
      state: 'unknown',
      ruleId: 'S-2',
      presence: 'unknown',
      basis: 'inferred',
      confidence: 'low',
      since: null,
    });
    expect(kinds(view)).toEqual(['transcript:no_records']);
  });

  it('records alone are enough to leave S-2', () => {
    expect(derive({ hasRecords: true, transcriptMtime: NOW - 10 * MIN }).ruleId).not.toBe('S-2');
  });
});

describe('S-3: SessionEnd', () => {
  const END = { stamp: st(NOW - 5 * MIN, 90, 'e'), reason: 'other' };

  it('S-3b: SessionEnd completes the session; the reason is kept', () => {
    const view = derive({ ...stoppedFacts(6 * MIN), end: END, lastHookAt: END.stamp.at });
    expect(view).toMatchObject({
      state: 'completed',
      ruleId: 'S-3b',
      presence: 'ended',
      endReason: 'other',
      basis: 'observed',
      confidence: 'high',
    });
    expect(kinds(view)).toEqual(['hook:session_end']);
    expect(view.evidence[0]?.value).toBe('other');
  });

  it('S-3a: SessionEnd after a StopFailure fails the session (medium)', () => {
    const view = derive({
      ...promptFacts(8 * MIN),
      lastTurnEndHook: lww(st(NOW - 6 * MIN, 60, 's'), info('stop_failure', { error: 'rate_limit' })),
      end: END,
    });
    expect(view).toMatchObject({
      state: 'failed',
      ruleId: 'S-3a',
      presence: 'ended',
      endReason: 'other',
      confidence: 'medium',
    });
    expect(kinds(view)).toEqual(['hook:session_end', 'hook:stop_failure']);
    expect(view.evidence[1]?.value).toBe('rate_limit');
  });

  it('S-3a: an unrecovered API error before SessionEnd fails the session; a later good reply recovers it', () => {
    const base = { ...stoppedFacts(6 * MIN), end: END, lastApiError: st(NOW - 7 * MIN, 20, 'x') };
    expect(derive(base)).toMatchObject({ state: 'failed', ruleId: 'S-3a' });
    expect(kinds(derive(base))).toEqual(['hook:session_end', 'transcript:api_error']);
    const recovered = derive({ ...base, lastAssistantOk: st(NOW - 6.5 * MIN, 20, 'y') });
    expect(recovered).toMatchObject({ state: 'completed', ruleId: 'S-3b' });
  });

  it('activity after SessionEnd by more than the reopen tolerance reopens the session (O4)', () => {
    const facts = sessionFactsWith({
      ...promptFacts(10 * SEC),
      end: { stamp: st(NOW - 60 * SEC, 90), reason: 'other' },
    });
    expect(isReopened(facts, CFG)).toBe(true);
    const view = deriveSession(facts, NO_ROWS, NOW, CFG);
    expect(view).toMatchObject({ state: 'working', ruleId: 'S-7e', endReason: null });
    expect(kinds(view)).toContain('hook:activity_after_end');
  });

  it('activity within the tolerance of SessionEnd does not reopen it (P4)', () => {
    const endAt = NOW - 60 * SEC;
    const facts = sessionFactsWith({
      ...promptFacts(61 * SEC),
      lastActivity: st(endAt + CFG.reopenToleranceMs, 30),
      end: { stamp: st(endAt, 90), reason: 'other' },
    });
    expect(isReopened(facts, CFG)).toBe(false);
    expect(deriveSession(facts, NO_ROWS, NOW, CFG)).toMatchObject({ state: 'completed', ruleId: 'S-3b' });
    const later = sessionFactsWith({ ...facts, lastActivity: st(endAt + CFG.reopenToleranceMs + 1, 30) });
    expect(isReopened(later, CFG)).toBe(true);
  });
});

describe('S-4: daemon job state', () => {
  it('S-4a: done completes the session', () => {
    const view = derive({ ...stoppedFacts(5 * MIN), job: lww(st(NOW - MIN), { jobId: 'j1', state: 'done' }) });
    expect(view).toMatchObject({
      state: 'completed',
      ruleId: 'S-4a',
      presence: 'ended',
      endReason: 'done',
      confidence: 'high',
    });
    expect(kinds(view)).toEqual(['job:job_state']);
  });

  it.each(['failed', 'error', 'killed', 'cancelled'])('S-4b: %s fails the session', (state) => {
    const view = derive({ ...stoppedFacts(5 * MIN), job: lww(st(NOW - MIN), { jobId: 'j1', state }) });
    expect(view).toMatchObject({ state: 'failed', ruleId: 'S-4b', endReason: state });
  });

  it('S-4a: evidence and since carry the time of the job, rendered "daemon job done 6d ago" (ADR 0069)', () => {
    const jobAt = NOW - 6 * 24 * 60 * MIN;
    const view = derive({
      ...stoppedFacts(6 * 24 * 60 * MIN + 10 * MIN),
      job: lww(st(jobAt), { jobId: 'j1', state: 'done' }),
    });
    expect(view).toMatchObject({ ruleId: 'S-4a', since: jobAt, nextCheckAt: null });
    expect(view.evidence[0]?.at).toBe(jobAt);
    expect(view.evidence[0] === undefined ? '' : renderEvidence(view.evidence[0], NOW)).toBe('daemon job done 6d ago');
  });

  it.each(['done', 'failed'])('later activity past the tolerance skips S-4 for a %s job (falls through)', (state) => {
    const jobAt = NOW - 2 * 60 * MIN;
    const later = jobAt + CFG.reopenToleranceMs + 1;
    const view = derive({ ...stoppedFacts(NOW - later), job: lww(st(jobAt), { jobId: 'j1', state }) });
    expect(view.ruleId).toBe('S-8e');
    expect(view.state).toBe('turn_ended');
  });

  it('activity exactly at the tolerance after the job still completes the session', () => {
    const jobAt = NOW - 2 * 60 * MIN;
    const facts = { ...stoppedFacts(5 * MIN), job: lww(st(jobAt), { jobId: 'j1', state: 'done' }) };
    const at = jobAt + CFG.reopenToleranceMs;
    const view = derive({
      ...facts,
      lastHookAt: at,
      lastActivity: st(at, 20, 'a'),
      lastTurnEndHook: lww(st(at, 60, 's'), info('stop')),
    });
    expect(view.ruleId).toBe('S-4a');
  });

  it('a running job is no evidence of an end', () => {
    expect(derive({ ...stoppedFacts(5 * MIN), job: lww(st(NOW - MIN), { jobId: 'j1', state: 'working' }) }).state).toBe(
      'turn_ended',
    );
  });
});

describe('S-5: the Claude process is gone', () => {
  const dead = lww(st(NOW - 5 * SEC), { pid: 4242, alive: false });

  it('a dead pid after the grace period is stale/process_gone, never completed', () => {
    const view = derive({ ...stoppedFacts(31 * SEC), pid: dead });
    expect(view).toMatchObject({
      state: 'stale',
      staleKind: 'process_gone',
      ruleId: 'S-5',
      presence: 'ended',
      basis: 'inferred',
      confidence: 'high',
    });
    expect(kinds(view)).toEqual(['pid:pid_dead', 'clock:quiet']);
  });

  it('within the grace period a spooled SessionEnd may still arrive: the turn rules decide', () => {
    expect(derive({ ...stoppedFacts(29 * SEC), pid: dead })).toMatchObject({ state: 'turn_ended', ruleId: 'S-8e' });
    expect(derive({ ...stoppedFacts(30 * SEC), pid: dead })).toMatchObject({ state: 'stale', ruleId: 'S-5' });
  });

  it('SessionEnd still wins over a dead pid', () => {
    const view = derive({
      ...stoppedFacts(10 * MIN),
      pid: dead,
      end: { stamp: st(NOW - 9 * MIN, 90), reason: 'other' },
    });
    expect(view).toMatchObject({ state: 'completed', ruleId: 'S-3b' });
  });
});

describe('S-6: a human is expected', () => {
  const PERM = { h1: { requested: st(NOW - 20 * SEC, 22, 'r'), resolved: null } };

  it('S-6a: an unresolved permission request in the turn', () => {
    const view = derive({ ...promptFacts(30 * SEC), permissions: PERM });
    expect(view).toMatchObject({
      state: 'waiting_input',
      waitReason: 'permission',
      ruleId: 'S-6a',
      presence: 'open',
      confidence: 'high',
    });
    expect(kinds(view)).toEqual(['hook:permission_request']);
  });

  it('S-6a: resolved by a fact, by an ended or batched tool row with the same input hash, or outside the turn: no wait', () => {
    expect(
      derive({
        ...promptFacts(30 * SEC),
        permissions: { h1: { requested: PERM.h1.requested, resolved: st(NOW - 10 * SEC, 30) } },
      }).ruleId,
    ).toBe('S-7e');
    const ended = {
      ...emptyToolCallRow('t1'),
      name: 'Bash',
      startedAt: NOW - 25 * SEC,
      endedAt: NOW - 10 * SEC,
      inputHash: 'h1',
    };
    expect(derive({ ...promptFacts(30 * SEC), permissions: PERM }, { tools: [ended] }).ruleId).toBe('S-7e');
    const batched = { ...ended, endedAt: null, batchAt: NOW - 10 * SEC };
    expect(derive({ ...promptFacts(30 * SEC), permissions: PERM }, { tools: [batched] }).ruleId).toBe('S-7e');
    const stopped = derive({ ...stoppedFacts(5 * SEC), permissions: PERM });
    expect(stopped.ruleId).toBe('S-8e');
  });

  it('S-6a: an end of the same hash BEFORE the request is not a resolution', () => {
    const earlier = {
      ...emptyToolCallRow('t0'),
      name: 'Bash',
      startedAt: NOW - 29 * SEC,
      endedAt: NOW - 28 * SEC,
      inputHash: 'h1',
    };
    expect(derive({ ...promptFacts(30 * SEC), permissions: PERM }, { tools: [earlier] }).ruleId).toBe('S-6a');
  });

  it('S-6b: a live registry entry that says waiting', () => {
    const registry = (waitingFor: string | null, at = NOW - 3 * SEC): Partial<SessionFacts> => ({
      registry: lww(st(at), { status: 'waiting' as const, waitingFor, pid: 1, pidAlive: true }),
    });
    expect(derive({ ...promptFacts(60 * SEC), ...registry('permission prompt') })).toMatchObject({
      state: 'waiting_input',
      waitReason: 'permission',
      ruleId: 'S-6b',
    });
    expect(derive({ ...promptFacts(60 * SEC), ...registry('input') })).toMatchObject({
      waitReason: 'user',
      ruleId: 'S-6b',
    });
    expect(derive({ ...promptFacts(60 * SEC), ...registry(null) })).toMatchObject({ waitReason: 'user' });
    // not live: older than two poll intervals, or its pid is dead
    expect(derive({ ...promptFacts(60 * SEC), ...registry(null, NOW - 2 * CFG.registryPollMs - 1) }).ruleId).toBe(
      'S-7e',
    );
    expect(derive({ ...promptFacts(60 * SEC), ...registry(null, NOW - 2 * CFG.registryPollMs) }).ruleId).toBe('S-6b');
    const deadPid = {
      registry: lww(st(NOW - SEC), { status: 'waiting' as const, waitingFor: null, pid: 1, pidAlive: false }),
    };
    expect(derive({ ...promptFacts(60 * SEC), ...deadPid }).ruleId).toBe('S-7e');
  });

  it.each([
    ['permission_prompt', 'permission'],
    ['elicitation_dialog', 'elicitation'],
    ['elicitation_url_dialog', 'elicitation'],
    ['agent_needs_input', 'agent_input'],
  ] as const)('S-6c: a blocking %s notification after the last activity gives wait reason %s', (type, reason) => {
    const view = derive({ ...promptFacts(60 * SEC), notifications: { [type]: st(NOW - 5 * SEC, 50) } });
    expect(view).toMatchObject({ state: 'waiting_input', waitReason: reason, ruleId: 'S-6c' });
    expect(kinds(view)).toEqual(['hook:notification']);
    expect(view.evidence[0]?.value).toBe(type);
  });

  it('S-6c: a notification older than the last activity does not block; idle_prompt is not blocking', () => {
    expect(
      derive({ ...promptFacts(60 * SEC), notifications: { permission_prompt: st(NOW - 120 * SEC, 50) } }).ruleId,
    ).toBe('S-7e');
    expect(derive({ ...promptFacts(60 * SEC), notifications: { idle_prompt: st(NOW - 5 * SEC, 50) } }).ruleId).toBe(
      'S-7e',
    );
  });

  it('S-6a comes before S-6b and S-6c', () => {
    const view = derive({
      ...promptFacts(60 * SEC),
      permissions: PERM,
      notifications: { elicitation_dialog: st(NOW - 5 * SEC, 50) },
      registry: lww(st(NOW - SEC), { status: 'waiting' as const, waitingFor: null, pid: 1, pidAlive: true }),
    });
    expect(view.ruleId).toBe('S-6a');
  });
});

describe('S-7: inside a turn', () => {
  const inTurn = promptFacts(10 * MIN);

  it('S-7a: the oldest open tool is a foreground Agent call', () => {
    const view = derive(inTurn, { tools: [openTool(30 * SEC, { name: 'Agent' })], agents: [agent()] });
    expect(view).toMatchObject({
      state: 'waiting_agent',
      ruleId: 'S-7a',
      presence: 'open',
      basis: 'observed',
      confidence: 'high',
    });
    expect(kinds(view)).toEqual(['hook:tool_open', 'transcript:child_active']);
    expect(view.evidence[0]).toMatchObject({ value: 'Agent', count: 1 });
  });

  it('S-7a also covers Task, and an async-launched agent is an ordinary open tool (S-7b)', () => {
    expect(derive(inTurn, { tools: [openTool(30 * SEC, { name: 'Task' })] }).ruleId).toBe('S-7a');
    const async = openTool(30 * SEC, { name: 'Agent', link: lww(st(NOW), 'async_launched') });
    expect(derive(inTurn, { tools: [async] })).toMatchObject({ state: 'working', ruleId: 'S-7b' });
  });

  it.each([
    [119_999, 'working', 'S-7b', 'open'],
    [120_000, 'waiting_tool', 'S-7c', 'open'],
    [899_999, 'waiting_tool', 'S-7c', 'open'],
    [900_000, 'unknown', 'S-7d', 'unknown'],
  ] as const)('an open tool of age %d ms gives %s (%s)', (age, state, rule, presence) => {
    const view = derive({ ...promptFacts(age + 5000), lastActivity: st(NOW - 1000, 20) }, { tools: [openTool(age)] });
    expect(view).toMatchObject({ state, ruleId: rule, presence });
    expect(view.evidence[0]).toMatchObject({ fact: 'tool_open', value: 'Bash', at: NOW - age });
    if (rule === 'S-7d') expect(view).toMatchObject({ basis: 'inferred', confidence: 'low' });
    else expect(view).toMatchObject({ basis: 'observed', confidence: 'high' });
  });

  it('only the open tools of the current turn count: ended, batched and older-than-the-prompt calls do not', () => {
    const facts = promptFacts(60 * SEC);
    const ended = openTool(30 * SEC, { toolUseId: 'e', endedAt: NOW - SEC });
    const batched = openTool(30 * SEC, { toolUseId: 'b', batchAt: NOW - SEC });
    const old = openTool(10 * MIN, { toolUseId: 'o' });
    expect(derive(facts, { tools: [ended, batched, old] }).ruleId).toBe('S-7e');
  });

  it('counts the open tools and reports the oldest', () => {
    const view = derive(promptFacts(60 * SEC), {
      tools: [openTool(10 * SEC, { toolUseId: 'b' }), openTool(40 * SEC, { toolUseId: 'a' })],
    });
    expect(view.evidence[0]).toMatchObject({ count: 2, at: NOW - 40 * SEC });
  });

  it("tool rows of an agent are not the session's open tools", () => {
    expect(derive(promptFacts(60 * SEC), { tools: [openTool(10 * SEC, { agentId: 'a1' })] }).ruleId).toBe('S-7e');
  });

  it('S-7e: no open tool, quiet below staleAfter is working; hooks know the turn (observed, high)', () => {
    const view = derive(promptFacts(60 * SEC));
    expect(view).toMatchObject({
      state: 'working',
      ruleId: 'S-7e',
      presence: 'open',
      basis: 'observed',
      confidence: 'high',
    });
    expect(kinds(view)).toEqual(['hook:prompt', 'clock:quiet']);
  });

  it('S-7e from the transcript alone (hooks installed mid-session) is inferred, medium (M5)', () => {
    const at = NOW - 60 * SEC;
    const view = derive({
      hasRecords: true,
      firstSeenAt: at,
      lastPromptTx: st(at, 10, 'p'),
      lastActivity: st(at, 10, 'p'),
    });
    expect(view).toMatchObject({ state: 'working', ruleId: 'S-7e', basis: 'inferred', confidence: 'medium' });
    expect(kinds(view)).toEqual(['transcript:prompt', 'clock:quiet']);
  });

  it('S-7f: in-turn silence past staleAfter is stale/silent (inferred; medium, low when the pid is alive)', () => {
    const facts = promptFacts(CFG.staleAfterSeconds * SEC);
    const silent = derive(facts);
    expect(silent).toMatchObject({
      state: 'stale',
      staleKind: 'silent',
      ruleId: 'S-7f',
      presence: 'unknown',
      basis: 'inferred',
      confidence: 'medium',
    });
    expect(kinds(silent)).toEqual(['hook:prompt', 'clock:quiet']);
    const alive = derive({ ...facts, pid: lww(st(NOW - SEC), { pid: 1, alive: true }) });
    expect(alive).toMatchObject({ ruleId: 'S-7f', confidence: 'low' });
    expect(kinds(alive)).toEqual(['hook:prompt', 'clock:quiet', 'pid:pid_alive']);
    expect(derive(promptFacts(CFG.staleAfterSeconds * SEC - 1)).ruleId).toBe('S-7e');
  });

  it('hookPath: a transcript turn boundary newer than the hook ones by more than the tolerance takes over', () => {
    const hookPrompt = NOW - 10 * MIN;
    const facts = sessionFactsWith({
      firstSeenAt: hookPrompt,
      lastHookAt: hookPrompt,
      hasRecords: true,
      lastPromptHook: st(hookPrompt, 10, 'h'),
      lastPromptTx: st(NOW - 5 * MIN, 10, 't'),
      lastTurnEndTx: lww(st(NOW - 4 * MIN, 20, 'x'), info('end_turn')),
      lastActivity: st(NOW - 4 * MIN, 20, 'x'),
    });
    const view = deriveSession(facts, NO_ROWS, NOW, CFG);
    expect(view).toMatchObject({ state: 'turn_ended', ruleId: 'S-8e' });
    expect(kinds(view)).toEqual(['transcript:end_turn']);
    // within the tolerance the hook path stays in charge
    const within = sessionFactsWith({
      ...facts,
      lastPromptTx: st(hookPrompt + CFG.crossSourceToleranceMs, 10, 't'),
      lastTurnEndTx: null,
    });
    const stillHook = deriveSession(within, NO_ROWS, NOW, CFG);
    expect(stillHook).toMatchObject({ state: 'working', ruleId: 'S-7e', basis: 'observed' });
    expect(kinds(stillHook)).toEqual(['hook:prompt', 'clock:quiet']);
  });
});

describe('S-8: after a turn end', () => {
  it('S-8a: pending background work reported by the Stop keeps the session waiting for agents', () => {
    const facts = stoppedFacts(2 * MIN, {
      lastTurnEndHook: lww(st(NOW - 2 * MIN, 60, 's'), info('stop', { backgroundTasks: 2 })),
    });
    const view = derive(facts);
    expect(view).toMatchObject({
      state: 'waiting_agent',
      ruleId: 'S-8a',
      presence: 'open',
      basis: 'observed',
      confidence: 'high',
    });
    expect(kinds(view)).toEqual(['hook:background_pending']);
    expect(view.evidence[0]).toMatchObject({ count: 2 });
  });

  it('S-8a: the transcript turn_duration counts agents and workflows together', () => {
    const at = NOW - MIN;
    const facts = sessionFactsWith({
      hasRecords: true,
      firstSeenAt: at - 5000,
      lastPromptTx: st(at - 5000, 10, 'p'),
      lastActivity: st(at, 20),
      lastTurnEndTx: lww(st(at, 61, 'd'), info('turn_duration', { pendingBackgroundAgents: 1, pendingWorkflows: 2 })),
    });
    const view = deriveSession(facts, NO_ROWS, NOW, CFG);
    expect(view).toMatchObject({ state: 'waiting_agent', ruleId: 'S-8a' });
    expect(view.evidence[0]).toMatchObject({ fact: 'background_pending', count: 3 });
  });

  it('S-8a: pending work is only believed while the session is not quiet beyond staleAfter', () => {
    const facts = stoppedFacts(CFG.staleAfterSeconds * SEC, {
      lastTurnEndHook: lww(st(NOW - CFG.staleAfterSeconds * SEC, 60, 's'), info('stop', { backgroundTasks: 1 })),
    });
    expect(derive(facts).ruleId).toBe('S-8e');
  });

  it('S-8a: active child agents keep the session waiting (observed when a child is observed, inferred otherwise)', () => {
    const facts = stoppedFacts(2 * MIN);
    expect(derive(facts, { agents: [agent({ basis: 'observed' })] })).toMatchObject({
      state: 'waiting_agent',
      ruleId: 'S-8a',
      basis: 'observed',
      confidence: 'high',
    });
    const inferred = derive(facts, { agents: [agent({ basis: 'inferred' })] });
    expect(inferred).toMatchObject({ state: 'waiting_agent', ruleId: 'S-8a', basis: 'inferred', confidence: 'medium' });
    expect(kinds(inferred)).toEqual(['transcript:child_active']);
    expect(derive(facts, { workflows: [workflow()] }).ruleId).toBe('S-8a');
    expect(
      derive(facts, { agents: [agent({ state: 'completed' }), agent({ agentId: 'a2', state: 'stale' })] }).ruleId,
    ).toBe('S-8e');
  });

  it('S-8b: a live registry entry that says idle', () => {
    const facts = stoppedFacts(10 * MIN, {
      registry: lww(st(NOW - SEC), { status: 'idle' as const, waitingFor: null, pid: 1, pidAlive: true }),
    });
    expect(derive(facts)).toMatchObject({
      state: 'waiting_input',
      waitReason: 'user',
      ruleId: 'S-8b',
      presence: 'open',
    });
  });

  it('S-8c: an idle_prompt notification after the turn end', () => {
    const facts = stoppedFacts(10 * MIN, { notifications: { idle_prompt: st(NOW - 5 * MIN, 50) } });
    const view = derive(facts);
    expect(view).toMatchObject({ state: 'waiting_input', waitReason: 'idle_prompt', ruleId: 'S-8c' });
    expect(derive(stoppedFacts(10 * MIN, { notifications: { idle_prompt: st(NOW - 11 * MIN, 50) } })).ruleId).toBe(
      'S-8e',
    );
  });

  it('S-8d: resting silence beyond abandonedAfter is stale/abandoned unless a pid or the registry is alive', () => {
    const facts = stoppedFacts(CFG.abandonedAfterSeconds * SEC);
    const view = derive(facts);
    expect(view).toMatchObject({
      state: 'stale',
      staleKind: 'abandoned',
      ruleId: 'S-8d',
      presence: 'unknown',
      basis: 'inferred',
      confidence: 'medium',
    });
    expect(kinds(view)).toEqual(['clock:quiet', 'hook:stop']);
    expect(derive({ ...facts, pid: lww(st(NOW - SEC), { pid: 1, alive: true }) }).ruleId).toBe('S-8e');
    expect(derive(stoppedFacts(CFG.abandonedAfterSeconds * SEC - 1)).ruleId).toBe('S-8e');
  });

  it.each([
    ['stop', info('stop'), 'ok', 'hook:stop'],
    ['stop_failure', info('stop_failure', { error: 'rate_limit' }), 'error', 'hook:stop_failure'],
  ] as const)('S-8e: a hook %s gives turn_ended with outcome %s', (_name, end, outcome, evidence) => {
    const view = derive(stoppedFacts(5 * MIN, { lastTurnEndHook: lww(st(NOW - 5 * MIN, 60, 's'), end) }));
    expect(view).toMatchObject({
      state: 'turn_ended',
      turnOutcome: outcome,
      ruleId: 'S-8e',
      presence: 'open',
      basis: 'observed',
      confidence: 'high',
    });
    expect(kinds(view)).toEqual([evidence]);
  });

  it('S-8e: a transcript end_turn and an interrupt marker', () => {
    const at = NOW - 5 * MIN;
    const base = {
      hasRecords: true,
      firstSeenAt: at - 9000,
      lastPromptTx: st(at - 9000, 10, 'p'),
      lastActivity: st(at, 20),
    };
    const ended = deriveSession(
      sessionFactsWith({ ...base, lastTurnEndTx: lww(st(at, 20, 'x'), info('end_turn')) }),
      NO_ROWS,
      NOW,
      CFG,
    );
    expect(ended).toMatchObject({ state: 'turn_ended', turnOutcome: 'ok' });
    expect(kinds(ended)).toEqual(['transcript:end_turn']);
    const interrupted = deriveSession(sessionFactsWith({ ...base, lastInterrupt: st(at, 20, 'i') }), NO_ROWS, NOW, CFG);
    expect(interrupted).toMatchObject({ state: 'turn_ended', turnOutcome: 'interrupted', ruleId: 'S-8e' });
    expect(kinds(interrupted)).toEqual(['transcript:interrupt']);
  });

  it('S-8e: a trailing cost-state record without a live pid or registry says the process ended (inferred, still turn_ended)', () => {
    const facts = stoppedFacts(5 * MIN);
    const trailing: Partial<SessionRows> = { costStateTrailing: true };
    expect(derive(facts, trailing)).toMatchObject({
      state: 'turn_ended',
      presence: 'ended',
      basis: 'inferred',
      confidence: 'medium',
    });
    expect(derive({ ...facts, pid: lww(st(NOW), { pid: 1, alive: true }) }, trailing)).toMatchObject({
      presence: 'open',
      basis: 'observed',
    });
    expect(derive(facts, { costStateTrailing: false })).toMatchObject({ presence: 'open', basis: 'observed' });
    // no input at all is the same as a flag that is not set
    expect(derive(facts)).toMatchObject({ presence: 'open', basis: 'observed' });
  });

  it('S-8e: the flag is an input of the derivation; the deprecated fact of an old database is read by nothing (CR-WP-28-2)', () => {
    const facts = stoppedFacts(5 * MIN, { costStateTrailing: lww(st(4096), true) });
    expect(derive(facts)).toMatchObject({ state: 'turn_ended', presence: 'open', basis: 'observed' });
    expect(derive(facts, { costStateTrailing: false })).toMatchObject({ presence: 'open' });
    expect(derive(facts, { costStateTrailing: true })).toMatchObject({ presence: 'ended', basis: 'inferred' });
  });

  it('S-8e: the flag moves nothing but the presence, and a later hour does not clear it by itself', () => {
    const facts = stoppedFacts(5 * MIN);
    const open = derive(facts, { costStateTrailing: false });
    const ended = derive(facts, { costStateTrailing: true });
    expect({ ...ended, presence: open.presence, basis: open.basis, confidence: open.confidence }).toEqual(open);
    expect(derive(facts, { costStateTrailing: true }, NOW + 30 * MIN)).toMatchObject({ presence: 'ended' });
  });

  it('S-8f: SessionStart with no prompt yet waits for the user (medium); a compact start alone does not', () => {
    const view = derive({
      firstSeenAt: NOW - 20 * SEC,
      lastHookAt: NOW - 20 * SEC,
      starts: { startup: st(NOW - 20 * SEC, 0, 'e') },
    });
    expect(view).toMatchObject({
      state: 'waiting_input',
      waitReason: 'user',
      ruleId: 'S-8f',
      presence: 'open',
      basis: 'observed',
      confidence: 'medium',
    });
    expect(kinds(view)).toEqual(['hook:session_start']);
    expect(view.evidence[0]?.value).toBe('startup');
    const compact = derive({
      firstSeenAt: NOW - 20 * SEC,
      lastHookAt: NOW - 20 * SEC,
      starts: { compact: st(NOW - 20 * SEC, 0, 'e') },
    });
    expect(compact.ruleId).toBe('S-10');
  });
});

describe('S-9 and S-10: no turn structure', () => {
  it('S-9a: a live registry entry that says busy', () => {
    const view = derive({
      lastHookAt: NOW - 10 * MIN,
      registry: lww(st(NOW - SEC), { status: 'busy' as const, waitingFor: null, pid: 1, pidAlive: true }),
    });
    expect(view).toMatchObject({
      state: 'running',
      ruleId: 'S-9a',
      presence: 'open',
      basis: 'observed',
      confidence: 'high',
    });
    expect(kinds(view)).toEqual(['registry:registry_status']);
  });

  it('S-9b: the transcript was written within activeSeconds', () => {
    const base = { hasRecords: true, firstSeenAt: NOW - 10 * MIN };
    const view = derive({ ...base, transcriptMtime: NOW - 119_999 });
    expect(view).toMatchObject({ state: 'running', ruleId: 'S-9b', basis: 'inferred', confidence: 'medium' });
    expect(kinds(view)).toEqual(['transcript:file_written']);
    expect(derive({ ...base, transcriptMtime: NOW - 120_000 }).ruleId).toBe('S-10');
  });

  it('S-9c: children active without any turn record', () => {
    const view = derive({ hasRecords: true, transcriptMtime: NOW - 10 * MIN }, { agents: [agent()] });
    expect(view).toMatchObject({ state: 'waiting_agent', ruleId: 'S-9c', basis: 'inferred', confidence: 'medium' });
  });

  it('S-10: anything else is unknown, inferred, low', () => {
    const view = derive({ hasRecords: true, transcriptMtime: NOW - 10 * MIN });
    expect(view).toMatchObject({
      state: 'unknown',
      ruleId: 'S-10',
      presence: 'unknown',
      basis: 'inferred',
      confidence: 'low',
    });
    expect(kinds(view)).toEqual(['clock:quiet']);
  });
});

describe('the view', () => {
  it('stamps evaluatedAt, keeps at most 8 evidence items and takes since from the first item', () => {
    const view = derive(promptFacts(60 * SEC));
    expect(view.evaluatedAt).toBe(NOW);
    expect(view.evidence.length).toBeLessThanOrEqual(8);
    expect(view.since).toBe(view.evidence[0]?.at);
  });

  it('is a pure function: same facts and time give the same view', () => {
    const facts = promptFacts(60 * SEC);
    expect(derive(facts)).toEqual(derive(facts));
  });

  it('a Stop is not a SessionEnd: no session state is completed without SessionEnd, a done job or an attempts row (P9)', () => {
    for (const ago of [
      SEC,
      MIN,
      10 * MIN,
      5 * 3600 * SEC,
      CFG.abandonedAfterSeconds * SEC,
      10 * CFG.abandonedAfterSeconds * SEC,
    ]) {
      expect(derive(stoppedFacts(ago)).state).not.toBe('completed');
    }
  });
});
