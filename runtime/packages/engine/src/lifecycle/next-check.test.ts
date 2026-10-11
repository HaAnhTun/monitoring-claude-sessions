// nextCheckAt (02 7.8): the smallest future time at which a rule input crosses a threshold. The soundness property P7 over
// random scenarios is in properties.test.ts; these are the exact values for hand-built cases.
import type { Stamp } from '@mcs/shared/protocol';
import { describe, expect, it } from 'vitest';

import { deriveAgent } from './derive-agent.ts';
import { deriveSession } from './derive-session.ts';
import { deriveWorkflow } from './derive-workflow.ts';
import {
  DEFAULT_LIFECYCLE_CFG,
  agentFactsWith,
  emptyToolCallRow,
  sessionFactsWith,
  workflowFactsWith,
  type Lww,
  type SessionFacts,
  type ToolCallRow,
  type TurnEndInfo,
} from './facts.ts';
import { nextCheckAt } from './next-check.ts';
import type { AgentSummary, SessionRows } from './rules.ts';

const NOW = 1_791_727_200_000;
const SEC = 1000;
const MIN = 60 * SEC;
const CFG = DEFAULT_LIFECYCLE_CFG;
const st = (at: number, rank = 0, tie = ''): Stamp => ({ at, rank, tie });
const lww = <T>(stamp: Stamp, value: T): Lww<T> => ({ stamp, value });
const NO_ROWS: SessionRows = { tools: [], agents: [], workflows: [] };

const STOP: TurnEndInfo = {
  kind: 'stop',
  promptId: null,
  error: null,
  backgroundTasks: null,
  pendingBackgroundAgents: null,
  pendingWorkflows: null,
};

function session(
  facts: Partial<SessionFacts>,
  rows: Partial<SessionRows> = {},
): { view: ReturnType<typeof deriveSession>; next: number | null } {
  const full = sessionFactsWith(facts);
  const all = { ...NO_ROWS, ...rows };
  const view = deriveSession(full, all, NOW, CFG);
  const next = nextCheckAt(view, { kind: 'session', facts: full, rows: all }, CFG);
  expect(view.nextCheckAt, 'the view carries the same value as nextCheckAt()').toBe(next);
  return { view, next };
}

function promptFacts(ago: number, over: Partial<SessionFacts> = {}): Partial<SessionFacts> {
  const at = NOW - ago;
  return { firstSeenAt: at, lastHookAt: at, lastPromptHook: st(at, 10, 'p'), lastActivity: st(at, 10, 'p'), ...over };
}

function stoppedFacts(ago: number, over: Partial<SessionFacts> = {}): Partial<SessionFacts> {
  const at = NOW - ago;
  return {
    ...promptFacts(ago + 5000),
    lastHookAt: at,
    lastActivity: st(at - 1000, 20, 'a'),
    lastTurnEndHook: lww(st(at, 60, 's'), STOP),
    ...over,
  };
}

function openTool(startedAgo: number, over: Partial<ToolCallRow> = {}): ToolCallRow {
  return { ...emptyToolCallRow('t1'), name: 'Bash', startedAt: NOW - startedAgo, ...over };
}

describe('nextCheckAt of a session', () => {
  it('an open tool: the activeSeconds threshold, then the pending-tool grace, then nothing', () => {
    const facts = promptFacts(5 * MIN, { lastActivity: st(NOW - 30 * SEC, 20) });
    expect(session(facts, { tools: [openTool(30 * SEC)] }).next).toBe(NOW + 90 * SEC);
    const later = promptFacts(5 * MIN, { lastActivity: st(NOW - 130 * SEC, 20), lastHookAt: NOW - 130 * SEC });
    expect(session(later, { tools: [openTool(130 * SEC)] }).next).toBe(NOW - 130 * SEC + 900 * SEC);
    const old = promptFacts(20 * MIN, { lastActivity: st(NOW - 16 * MIN, 20), lastHookAt: NOW - 16 * MIN });
    // beyond the grace the call stays open until a turn end or a result arrives: nothing time-driven is left
    const beyond = session(old, { tools: [openTool(16 * MIN)] });
    expect(beyond.view.ruleId).toBe('S-7d');
    expect(beyond.next).toBeNull();
  });

  it('in a turn without tools: lastEvidence + staleAfter', () => {
    expect(session(promptFacts(60 * SEC)).next).toBe(NOW - 60 * SEC + CFG.staleAfterSeconds * SEC);
  });

  it('a silent turn (stale/silent) has nothing left to wait for', () => {
    const { view, next } = session(promptFacts(CFG.staleAfterSeconds * SEC + SEC));
    expect(view).toMatchObject({ state: 'stale', staleKind: 'silent' });
    expect(next).toBeNull();
  });

  it('a resting turn: lastEvidence + abandonedAfter; pending background work adds the staleAfter threshold', () => {
    expect(session(stoppedFacts(10 * MIN)).next).toBe(NOW - 10 * MIN + CFG.abandonedAfterSeconds * SEC);
    const pending = stoppedFacts(10 * MIN, {
      lastTurnEndHook: lww(st(NOW - 10 * MIN, 60, 's'), { ...STOP, backgroundTasks: 1 }),
    });
    expect(session(pending).next).toBe(NOW - 10 * MIN + CFG.staleAfterSeconds * SEC);
  });

  it('the transcript was written recently: mtime + activeSeconds (running from the file)', () => {
    const { view, next } = session({ hasRecords: true, firstSeenAt: NOW - MIN, transcriptMtime: NOW - 30 * SEC });
    expect(view.ruleId).toBe('S-9b');
    expect(next).toBe(NOW + 90 * SEC);
  });

  it('a live registry entry stops being live just after two poll intervals', () => {
    const facts = promptFacts(60 * SEC, {
      registry: lww(st(NOW - 3 * SEC), { status: 'waiting' as const, waitingFor: null, pid: 1, pidAlive: true }),
    });
    const { view, next } = session(facts);
    expect(view.ruleId).toBe('S-6b');
    expect(next).toBe(NOW - 3 * SEC + 2 * CFG.registryPollMs + 1);
  });

  it('a dead pid inside the grace period: lastEvidence + processGoneGrace', () => {
    const facts = stoppedFacts(10 * SEC, { pid: lww(st(NOW - 2 * SEC), { pid: 4242, alive: false }) });
    expect(session(facts).next).toBe(NOW - 10 * SEC + CFG.processGoneGraceSeconds * SEC);
  });

  it('a known Claude pid of an open session is re-checked every pidCheckIntervalMs', () => {
    const { view, next } = session(stoppedFacts(10 * MIN, { claudePid: lww(st(1), 4242) }));
    expect(view.presence).toBe('open');
    expect(next).toBe(NOW + CFG.pidCheckIntervalMs);
  });

  it('no pid re-check once the presence is not open', () => {
    const facts = stoppedFacts(CFG.abandonedAfterSeconds * SEC, { claudePid: lww(st(1), 4242) });
    const { view, next } = session(facts);
    expect(view).toMatchObject({ state: 'stale', staleKind: 'abandoned', presence: 'unknown' });
    expect(next).toBeNull();
  });

  it('a child agent that changes state sooner pulls the check forward', () => {
    const child: AgentSummary = {
      agentId: 'a1',
      state: 'working',
      basis: 'observed',
      lastActivityAt: NOW - 10 * SEC,
      fileMtime: null,
      nextCheckAt: NOW + 50 * SEC,
      workflowRunId: null,
    };
    const { next } = session(
      promptFacts(5 * MIN, { lastActivity: st(NOW - 10 * SEC, 20), lastHookAt: NOW - 10 * SEC }),
      { agents: [child] },
    );
    expect(next).toBe(NOW + 50 * SEC);
  });

  it.each([
    ['SessionEnd completes', { ...stoppedFacts(10 * MIN), end: { stamp: st(NOW - 9 * MIN, 90), reason: 'other' } }],
    ['a done job', { ...stoppedFacts(10 * MIN), job: lww(st(NOW - MIN), { jobId: 'j', state: 'done' }) }],
    [
      'an attempts row',
      {
        ...stoppedFacts(10 * MIN),
        attempt: lww(st(NOW, 1, 'k'), { state: 'FAILED' as const, evidence: 'e', rowKey: 'k', endedAt: NOW - 1 }),
      },
    ],
    ['no evidence at all', {}],
    ['a dead process', { ...stoppedFacts(5 * MIN), pid: lww(st(NOW - SEC), { pid: 1, alive: false }) }],
  ] as const)('is null when %s (terminal or time-invariant)', (_name, facts) => {
    expect(session(facts).next).toBeNull();
  });

  it('is never in the past', () => {
    for (const ago of [SEC, 30 * SEC, 2 * MIN, 15 * MIN, 31 * MIN, 25 * 3600 * SEC]) {
      const { next } = session(stoppedFacts(ago));
      if (next !== null) expect(next).toBeGreaterThan(NOW);
      const turn = session(promptFacts(ago));
      if (turn.next !== null) expect(turn.next).toBeGreaterThan(NOW);
    }
  });
});

describe('nextCheckAt of an agent', () => {
  const agentView = (facts: ReturnType<typeof agentFactsWith>, tools: readonly ToolCallRow[] = []) => {
    const rows = { tools, parentPresence: 'open' as const };
    const view = deriveAgent(facts, rows, NOW, CFG);
    const next = nextCheckAt(view, { kind: 'agent', facts, rows }, CFG);
    expect(view.nextCheckAt).toBe(next);
    return { view, next };
  };

  it('recent file activity: activity + subagentActiveSeconds', () => {
    const { view, next } = agentView(
      agentFactsWith({ started: st(NOW - 20 * SEC, 40), lastActivity: st(NOW - 10 * SEC), fileMtime: NOW - 10 * SEC }),
    );
    expect(view.ruleId).toBe('A-6');
    expect(next).toBe(NOW - 10 * SEC + CFG.subagentActiveSeconds * SEC);
  });

  it('an open tool of the agent: the activeSeconds threshold', () => {
    const { view, next } = agentView(
      agentFactsWith({ started: st(NOW - 60 * SEC, 40), lastActivity: st(NOW - 30 * SEC) }),
      [openTool(30 * SEC, { agentId: 'a1' })],
    );
    expect(view.ruleId).toBe('A-5');
    expect(next).toBe(NOW + 90 * SEC);
  });

  it('a stopped end_turn agent waits for the quiet threshold of the legacy override', () => {
    const facts = agentFactsWith({
      lastActivity: st(NOW - 10 * SEC),
      lastTurnEnd: lww(st(NOW - 10 * SEC, 20), { ...STOP, kind: 'end_turn' as const }),
    });
    expect(agentView(facts).next).toBe(NOW - 10 * SEC + CFG.subagentActiveSeconds * SEC);
  });

  it.each([
    ['completed by a notification', agentFactsWith({ notification: lww(st(NOW - SEC), 'completed' as const) })],
    ['failed by a notification', agentFactsWith({ notification: lww(st(NOW - SEC), 'failed' as const) })],
    ['stopped', agentFactsWith({ stopped: st(NOW - SEC, 44) })],
  ])('is null when the agent is %s', (_name, facts) => {
    expect(agentView(facts).next).toBeNull();
  });

  it('is null for an agent whose parent has ended', () => {
    const facts = agentFactsWith({ started: st(NOW - 31 * MIN, 40), lastActivity: st(NOW - 31 * MIN) });
    const rows = { tools: [], parentPresence: 'ended' as const };
    const view = deriveAgent(facts, rows, NOW, CFG);
    expect(view).toMatchObject({ state: 'stale', staleKind: 'parent_ended' });
    expect(nextCheckAt(view, { kind: 'agent', facts, rows }, CFG)).toBeNull();
  });
});

describe('nextCheckAt of a workflow run', () => {
  const runView = (facts: ReturnType<typeof workflowFactsWith>, agents: readonly AgentSummary[] = []) => {
    const rows = { parentPresence: 'open' as const, agents };
    const view = deriveWorkflow(facts, rows, NOW, CFG);
    const next = nextCheckAt(view, { kind: 'workflow', facts, rows }, CFG);
    expect(view.nextCheckAt).toBe(next);
    return { view, next };
  };

  it('agent activity: activity + subagentActiveSeconds', () => {
    const { view, next } = runView(
      workflowFactsWith({ launched: st(NOW - MIN, 20), lastAgentActivity: NOW - 10 * SEC }),
    );
    expect(view.ruleId).toBe('W-4');
    expect(next).toBe(NOW - 10 * SEC + CFG.subagentActiveSeconds * SEC);
  });

  it('launched and quiet: launched + staleAfterSeconds', () => {
    const { view, next } = runView(workflowFactsWith({ launched: st(NOW - 10 * MIN, 20) }));
    expect(view.ruleId).toBe('W-6');
    expect(next).toBe(NOW - 10 * MIN + CFG.staleAfterSeconds * SEC);
  });

  it('is null for a finished run and for a silent one', () => {
    expect(runView(workflowFactsWith({ fileStatus: lww(st(NOW - SEC), 'completed') })).next).toBeNull();
    expect(runView(workflowFactsWith({ launched: st(NOW - 2 * CFG.staleAfterSeconds * SEC, 20) })).next).toBeNull();
  });
});
