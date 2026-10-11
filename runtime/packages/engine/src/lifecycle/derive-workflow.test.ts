// T-LF-49 (workflow half): one test per row of the workflow run decision table (02 7.6, rules W-1 to W-7).
import type { Stamp } from '@mcs/shared/protocol';
import { describe, expect, it } from 'vitest';

import { deriveWorkflow } from './derive-workflow.ts';
import { DEFAULT_LIFECYCLE_CFG, workflowFactsWith, type LifecycleView, type Lww, type WorkflowFacts } from './facts.ts';
import type { AgentSummary, WorkflowRows } from './rules.ts';

const NOW = 1_791_727_200_000;
const SEC = 1000;
const MIN = 60 * SEC;
const CFG = DEFAULT_LIFECYCLE_CFG;
const st = (at: number, rank = 0, tie = ''): Stamp => ({ at, rank, tie });
const lww = <T>(stamp: Stamp, value: T): Lww<T> => ({ stamp, value });

function derive(facts: Partial<WorkflowFacts>, rows: Partial<WorkflowRows> = {}): LifecycleView {
  return deriveWorkflow(workflowFactsWith(facts), { parentPresence: 'open', agents: [], ...rows }, NOW, CFG);
}

function kinds(view: LifecycleView): string[] {
  return view.evidence.map((e) => `${e.source}:${e.fact}`);
}

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agentId: 'a1',
    state: 'working',
    basis: 'observed',
    lastActivityAt: null,
    fileMtime: null,
    nextCheckAt: null,
    workflowRunId: 'wf_1',
    ...over,
  };
}

describe('T-LF-49 workflow table, W-1 to W-3: the run file says how it ended', () => {
  it('W-1: a completed run file completes the run (observed, high)', () => {
    const view = derive({ launched: st(NOW - 10 * MIN, 20), fileStatus: lww(st(NOW - MIN), 'completed') });
    expect(view).toMatchObject({
      state: 'completed',
      ruleId: 'W-1',
      presence: 'ended',
      basis: 'observed',
      confidence: 'high',
    });
    expect(kinds(view)).toEqual(['workflow_file:workflow_status']);
    expect(view.evidence[0]?.value).toBe('completed');
  });

  it.each(['failed', 'error', 'cancelled', 'killed'])('W-2: a %s run file fails the run', (status) => {
    const view = derive({ fileStatus: lww(st(NOW - MIN), status) });
    expect(view).toMatchObject({
      state: 'failed',
      ruleId: 'W-2',
      endReason: status,
      basis: 'observed',
      confidence: 'high',
    });
  });

  it('W-3: any other status is unknown, observed, low, and the value is shown', () => {
    const view = derive({ fileStatus: lww(st(NOW - MIN), 'paused') });
    expect(view).toMatchObject({ state: 'unknown', ruleId: 'W-3', basis: 'observed', confidence: 'low' });
    expect(view.evidence[0]?.value).toBe('paused');
  });

  it('the run file beats everything below it, even a busy agent or an ended parent', () => {
    const rows = { parentPresence: 'ended' as const, agents: [agent()] };
    expect(derive({ fileStatus: lww(st(NOW - MIN), 'completed') }, rows).ruleId).toBe('W-1');
  });
});

describe('T-LF-49 workflow table, W-4 to W-7: no run file', () => {
  it('W-4: an agent of the run that is working or waiting for a tool keeps the run running', () => {
    const view = derive({ launched: st(NOW - 40 * MIN, 20) }, { agents: [agent({ state: 'waiting_tool' })] });
    expect(view).toMatchObject({
      state: 'running',
      ruleId: 'W-4',
      presence: 'open',
      basis: 'observed',
      confidence: 'high',
    });
    expect(derive({ launched: st(NOW - 40 * MIN, 20) }, { agents: [agent({ state: 'completed' })] }).ruleId).toBe(
      'W-7',
    );
  });

  it('W-4: agent activity within subagentActiveSeconds keeps the run running', () => {
    expect(derive({ launched: st(NOW - 40 * MIN, 20), lastAgentActivity: NOW - 59_999 }).ruleId).toBe('W-4');
    // just past the window the inferred rule W-6 takes over while the activity is younger than staleAfter
    expect(derive({ launched: st(NOW - 40 * MIN, 20), lastAgentActivity: NOW - 60_000 }).ruleId).toBe('W-6');
    expect(
      derive({ launched: st(NOW - 40 * MIN, 20), lastAgentActivity: NOW - CFG.staleAfterSeconds * SEC }).ruleId,
    ).toBe('W-7');
    const fromAgents = derive(
      { launched: st(NOW - 40 * MIN, 20) },
      { agents: [agent({ state: 'completed', lastActivityAt: NOW - 10 * SEC })] },
    );
    expect(fromAgents.ruleId).toBe('W-4');
  });

  it('W-5: the parent session ended first', () => {
    const view = derive({ launched: st(NOW - 10 * MIN, 20) }, { parentPresence: 'ended' });
    expect(view).toMatchObject({
      state: 'stale',
      staleKind: 'parent_ended',
      ruleId: 'W-5',
      basis: 'inferred',
      confidence: 'medium',
    });
    expect(kinds(view)).toEqual(['hook:parent_ended']);
  });

  it('W-6: launched or agent-active within staleAfter is running (inferred)', () => {
    const view = derive({ launched: st(NOW - 10 * MIN, 20) });
    expect(view).toMatchObject({ state: 'running', ruleId: 'W-6', basis: 'inferred', confidence: 'medium' });
    expect(derive({ launched: st(NOW - CFG.staleAfterSeconds * SEC + 1, 20) }).ruleId).toBe('W-6');
  });

  it('W-7: otherwise stale/silent, and a run seen only by its agents counts their activity', () => {
    const view = derive({ launched: st(NOW - CFG.staleAfterSeconds * SEC, 20) });
    expect(view).toMatchObject({
      state: 'stale',
      staleKind: 'silent',
      ruleId: 'W-7',
      presence: 'unknown',
      basis: 'inferred',
      confidence: 'medium',
    });
    expect(kinds(view)).toEqual(['clock:quiet']);
    expect(derive({}).ruleId).toBe('W-7');
  });

  it('a run without a file is never completed (the file is written only for finished runs, TS:6.2)', () => {
    for (const ago of [SEC, MIN, 10 * MIN, 5 * 3600 * SEC]) {
      expect(derive({ launched: st(NOW - ago, 20), started: 3, results: 3 }).state).not.toBe('completed');
    }
  });

  it('carries evaluatedAt and a pure result', () => {
    const facts = { launched: st(NOW - 10 * MIN, 20) };
    expect(derive(facts).evaluatedAt).toBe(NOW);
    expect(derive(facts)).toEqual(derive(facts));
  });
});
