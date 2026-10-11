// T-LF-49 (agent half): one test per row of the agent decision table (02 7.5, rules A-1 to A-10).
import type { Stamp } from '@mcs/shared/protocol';
import { describe, expect, it } from 'vitest';

import { deriveAgent } from './derive-agent.ts';
import {
  DEFAULT_LIFECYCLE_CFG,
  agentFactsWith,
  emptyToolCallRow,
  type AgentFacts,
  type LifecycleView,
  type Lww,
  type ToolCallRow,
  type TurnEndInfo,
} from './facts.ts';
import type { AgentRows } from './rules.ts';

const NOW = 1_791_727_200_000;
const SEC = 1000;
const MIN = 60 * SEC;
const CFG = DEFAULT_LIFECYCLE_CFG;
const st = (at: number, rank = 0, tie = ''): Stamp => ({ at, rank, tie });
const lww = <T>(stamp: Stamp, value: T): Lww<T> => ({ stamp, value });

function derive(facts: Partial<AgentFacts>, rows: Partial<AgentRows> = {}): LifecycleView {
  return deriveAgent(agentFactsWith(facts), { tools: [], parentPresence: 'open', ...rows }, NOW, CFG);
}

function kinds(view: LifecycleView): string[] {
  return view.evidence.map((e) => `${e.source}:${e.fact}`);
}

function tool(startedAgo: number, over: Partial<ToolCallRow> = {}): ToolCallRow {
  return { ...emptyToolCallRow('t1'), name: 'Read', agentId: 'a1', startedAt: NOW - startedAgo, ...over };
}

const END_TURN: TurnEndInfo = {
  kind: 'end_turn',
  promptId: null,
  error: null,
  backgroundTasks: null,
  pendingBackgroundAgents: null,
  pendingWorkflows: null,
};

describe('T-LF-49 agent table, A-1 to A-4: the episode ended', () => {
  it('A-1: a completed task notification completes the agent (observed, high)', () => {
    const view = derive({ started: st(NOW - 5 * MIN, 40), notification: lww(st(NOW - 4 * MIN), 'completed') });
    expect(view).toMatchObject({
      state: 'completed',
      ruleId: 'A-1',
      presence: 'ended',
      basis: 'observed',
      confidence: 'high',
    });
    expect(kinds(view)).toEqual(['transcript:agent_notification']);
    expect(view.evidence[0]?.value).toBe('completed');
  });

  it.each(['failed', 'killed', 'stopped'] as const)(
    'A-2: a %s task notification fails the agent and keeps the status',
    (status) => {
      const view = derive({ started: st(NOW - 5 * MIN, 40), notification: lww(st(NOW - 4 * MIN), status) });
      expect(view).toMatchObject({
        state: 'failed',
        ruleId: 'A-2',
        endReason: status,
        basis: 'observed',
        confidence: 'high',
      });
    },
  );

  it('A-3: a failed journal entry fails the agent', () => {
    const view = derive({ started: st(NOW - 5 * MIN, 40), stopped: st(NOW - 4 * MIN, 44), journal: 'failed' });
    expect(view).toMatchObject({ state: 'failed', ruleId: 'A-3' });
    expect(kinds(view)).toEqual(['journal:workflow_status']);
  });

  it.each([
    ['a journal result', { journal: 'result' as const }, 'journal:workflow_status'],
    ['a final output', { final: st(NOW - 4 * MIN, 30) }, 'transcript:agent_final'],
    ['a SubagentStop', { stopped: st(NOW - 4 * MIN, 44) }, 'hook:agent_stop'],
    ['a completed link', { link: lww(st(NOW - 4 * MIN, 30), 'completed') }, 'hook:agent_link'],
  ] as const)('A-4: %s completes the agent', (_name, patch, evidence) => {
    const view = derive({ started: st(NOW - 5 * MIN, 40), ...patch });
    expect(view).toMatchObject({ state: 'completed', ruleId: 'A-4', basis: 'observed', confidence: 'high' });
    expect(kinds(view)).toEqual([evidence]);
  });

  it('A-4: SubagentStop that arrives before SubagentStart still completes (O2)', () => {
    const view = derive({ started: st(NOW - 4 * MIN, 40), stopped: st(NOW - 4 * MIN + 1, 44) });
    expect(view.ruleId).toBe('A-4');
  });

  it('A-1 comes before A-3 and A-4; A-2 before A-4', () => {
    expect(
      derive({ notification: lww(st(NOW - MIN), 'failed'), stopped: st(NOW - 2 * MIN, 44), journal: 'result' }).ruleId,
    ).toBe('A-2');
    expect(derive({ journal: 'failed', stopped: st(NOW - 2 * MIN, 44) }).ruleId).toBe('A-3');
  });

  it('a SubagentStart after the episode end (a resume) reopens the agent: the end rules are skipped (O5)', () => {
    const resumed = derive({
      started: st(NOW - 10 * SEC, 40),
      stopped: st(NOW - 5 * MIN, 44),
      notification: lww(st(NOW - 5 * MIN), 'completed'),
      lastActivity: st(NOW - 10 * SEC, 40),
    });
    expect(resumed).toMatchObject({ state: 'working', ruleId: 'A-6' });
    // the start within the tolerance of the end is the same episode
    const same = derive({
      started: st(NOW - 5 * MIN + CFG.crossSourceToleranceMs, 40),
      stopped: st(NOW - 5 * MIN, 44),
    });
    expect(same).toMatchObject({ state: 'completed', ruleId: 'A-4' });
  });
});

describe('T-LF-49 agent table, A-5: open tool calls of the agent', () => {
  it.each([
    [119_999, 'working', 'observed', 'high'],
    [120_000, 'waiting_tool', 'observed', 'high'],
    [899_999, 'waiting_tool', 'observed', 'high'],
    [900_000, 'unknown', 'inferred', 'low'],
  ] as const)('an open tool of age %d ms gives %s', (age, state, basis, confidence) => {
    const view = derive({ started: st(NOW - 20 * MIN, 40), lastActivity: st(NOW - 1000) }, { tools: [tool(age)] });
    expect(view).toMatchObject({ state, basis, confidence, ruleId: 'A-5' });
    expect(view.evidence[0]).toMatchObject({ fact: 'tool_open', value: 'Read', at: NOW - age });
  });

  it('ended and batched calls are not open', () => {
    const closed = [tool(30 * SEC, { endedAt: NOW - SEC }), tool(30 * SEC, { toolUseId: 'b', batchAt: NOW - SEC })];
    expect(derive({ started: st(NOW - 20 * SEC, 40), lastActivity: st(NOW - 5 * SEC) }, { tools: closed }).ruleId).toBe(
      'A-6',
    );
  });
});

describe('T-LF-49 agent table, A-6 to A-10: no end observed', () => {
  it('A-6: file or hook activity within subagentActiveSeconds is working', () => {
    const fromHook = derive({ started: st(NOW - 30 * SEC, 40), lastActivity: st(NOW - 5 * SEC) });
    expect(fromHook).toMatchObject({
      state: 'working',
      ruleId: 'A-6',
      presence: 'open',
      basis: 'observed',
      confidence: 'medium',
    });
    const fromFile = derive({ fileMtime: NOW - 59_999, hasRecords: true });
    expect(fromFile).toMatchObject({ state: 'working', ruleId: 'A-6', basis: 'inferred', confidence: 'medium' });
    expect(derive({ fileMtime: NOW - 60_000, hasRecords: true }).ruleId).not.toBe('A-6');
  });

  it('A-6: a started agent with no end and quiet below staleAfter stays working', () => {
    const view = derive({ started: st(NOW - 10 * MIN, 40), lastActivity: st(NOW - 5 * MIN) });
    expect(view).toMatchObject({ state: 'working', ruleId: 'A-6', basis: 'observed' });
    expect(derive({ started: st(NOW - 40 * MIN, 40), lastActivity: st(NOW - 31 * MIN) }).ruleId).toBe('A-9');
  });

  it('A-7: the parent ended first', () => {
    const view = derive(
      { started: st(NOW - 40 * MIN, 40), lastActivity: st(NOW - 31 * MIN) },
      { parentPresence: 'ended' },
    );
    expect(view).toMatchObject({
      state: 'stale',
      staleKind: 'parent_ended',
      ruleId: 'A-7',
      basis: 'inferred',
      confidence: 'medium',
    });
    expect(kinds(view)).toContain('hook:parent_ended');
  });

  it('A-8: an end_turn agent that has been quiet for subagentActiveSeconds is completed (the legacy override, inferred)', () => {
    const facts = {
      lastActivity: st(NOW - 61 * SEC),
      fileMtime: NOW - 61 * SEC,
      lastTurnEnd: lww(st(NOW - 61 * SEC, 20), END_TURN),
    };
    const view = derive(facts);
    expect(view).toMatchObject({
      state: 'completed',
      ruleId: 'A-8',
      presence: 'ended',
      basis: 'inferred',
      confidence: 'medium',
    });
    expect(kinds(view)).toEqual(['transcript:end_turn']);
    expect(derive({ ...facts, lastActivity: st(NOW - 30 * SEC), fileMtime: NOW - 30 * SEC }).ruleId).toBe('A-6');
  });

  it('A-9: silence past staleAfter is stale/silent', () => {
    const view = derive({
      lastActivity: st(NOW - CFG.staleAfterSeconds * SEC),
      fileMtime: NOW - CFG.staleAfterSeconds * SEC,
    });
    expect(view).toMatchObject({
      state: 'stale',
      staleKind: 'silent',
      ruleId: 'A-9',
      presence: 'unknown',
      basis: 'inferred',
      confidence: 'medium',
    });
    expect(kinds(view)).toEqual(['clock:quiet']);
  });

  it('A-10: otherwise unknown (also an agent known by nothing but its meta)', () => {
    const view = derive({ lastActivity: st(NOW - 5 * MIN), fileMtime: NOW - 5 * MIN });
    expect(view).toMatchObject({
      state: 'unknown',
      ruleId: 'A-10',
      presence: 'unknown',
      basis: 'inferred',
      confidence: 'low',
    });
    expect(derive({})).toMatchObject({ state: 'unknown', ruleId: 'A-10' });
  });
});

describe('the agent view', () => {
  it('carries evaluatedAt, since and a pure result', () => {
    const facts = { started: st(NOW - 30 * SEC, 40), lastActivity: st(NOW - 5 * SEC) };
    const view = derive(facts);
    expect(view.evaluatedAt).toBe(NOW);
    expect(view.since).toBe(view.evidence[0]?.at);
    expect(derive(facts)).toEqual(view);
  });
});
