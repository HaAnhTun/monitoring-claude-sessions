// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  AGENT_PAGE,
  LAZY_AGENT_THRESHOLD,
  buildSessionView,
  diffStates,
  groupAgents,
  pickDefaultSession,
  stateMap,
  stateSummary,
  type ViewAgent,
  type ViewSession,
} from './sessions-view.ts';

function sess(id: string, state: string, extra: Partial<ViewSession> = {}): ViewSession {
  return { id, label: id, state: { state, evidence: [] }, ...extra };
}

function agent(id: string, label: string, state: string, workflow: ViewAgent['workflow'] = null): ViewAgent {
  return { id, label, model: null, state: { state, evidence: [] }, workflow };
}

function wf(name: string | null, runId = 'run-1'): NonNullable<ViewAgent['workflow']> {
  return { runId, name, phase: null, state: 'running' };
}

describe('sessions view', () => {
  it('legacy: session view groups by state, filters, and keeps agents', () => {
    const planner = agent('x1', 'planner', 'running', wf('wf-1'));
    const coder = agent('x2', 'coder', 'completed');
    const list: ViewSession[] = [
      sess('s-run', 'running'),
      sess('s-wait', 'waiting_input'),
      sess('s-idle', 'turn_ended'),
      sess('s-ok', 'completed'),
      sess('s-bad', 'failed'),
      sess('s-unk', 'unknown'),
      sess('s-ag', 'turn_ended'),
      sess('s-nostate', 'not-a-state'),
    ];
    const agentsOf = (s: ViewSession): ViewAgent[] => (s.id === 's-ag' ? [planner, coder] : []);
    const view = buildSessionView(list, '', agentsOf);
    expect(view.map((g) => [g.id, g.entries.length])).toEqual([
      ['active', 1],
      ['needs-input', 1],
      ['idle', 2],
      ['done', 2],
      ['stale', 2],
    ]);
    expect(view.map((g) => g.title)).toEqual(['Active', 'Needs input', 'Idle', 'Done', 'Stale or unknown']);
    const f = buildSessionView(list, 'planner', agentsOf);
    expect(f).toHaveLength(1);
    expect(f[0]?.entries[0]?.s.id).toBe('s-ag');
    expect(f[0]?.entries[0]?.agents).toHaveLength(1);
    expect(f[0]?.entries[0]?.viaAgents).toBe(true);
    expect(buildSessionView(list, 'zzz', agentsOf)).toHaveLength(0);
    expect(buildSessionView(list, 'failed', agentsOf)).toHaveLength(1); // matches by state text
  });

  it('filter tokens are ANDed and match label, id, state, evidence and agent fields', () => {
    const evidence = [{ kind: 'hook:stop', at: null, text: 'Stop hook received' }];
    const a = sess('abc-1', 'completed', { label: 'Nightly build', state: { state: 'completed', evidence } });
    const b = sess('def-2', 'running', { label: 'Other job' });
    const reviewer = agent('r1', 'reviewer', 'running', wf('release', 'run-9'));
    reviewer.model = 'claude-sonnet';
    const list = [a, b];
    const agentsOf = (s: ViewSession): ViewAgent[] => (s.id === 'def-2' ? [reviewer] : []);
    const ids = (q: string): string[] =>
      buildSessionView(list, q, agentsOf).flatMap((g) => g.entries.map((e) => e.s.id));
    expect(ids('nightly')).toEqual(['abc-1']);
    expect(ids('NIGHTLY build')).toEqual(['abc-1']);
    expect(ids('nightly other')).toEqual([]);
    expect(ids('stop hook')).toEqual(['abc-1']);
    expect(ids('def-2')).toEqual(['def-2']);
    expect(ids('sonnet')).toEqual(['def-2']);
    expect(ids('release')).toEqual(['def-2']);
    expect(ids('run-9')).toEqual(['def-2']);
    expect(ids('   ')).toEqual(['def-2', 'abc-1']);
    expect(ids('')).toEqual(['def-2', 'abc-1']);
  });

  it('legacy: groupAgents: workflows, plain subagents, no cap, per-group summary', () => {
    const agents: ViewAgent[] = [];
    for (let i = 0; i < 120; i += 1) {
      agents.push(
        agent(`a${String(i)}`, `a${String(i)}`, i % 2 ? 'running' : 'completed', i < 100 ? wf('wf-1') : null),
      );
    }
    const g = groupAgents(agents);
    expect(g.map((x) => [x.title, x.agents.length])).toEqual([
      ['Subagents', 20],
      ['Workflow wf-1', 100],
    ]);
    expect(g[1]?.summary).toBe('50 running, 50 completed');
    expect(g[0]?.key).toBe('');
    expect(g[1]?.key).toBe('run-1');
    expect(stateSummary([{ state: { state: 'failed' } }, { state: { state: 'bogus' } }])).toBe('1 failed, 1 unknown');
  });

  it('groupAgents keys by run id, titles with the name or the run id and keeps the run state', () => {
    const agents = [
      agent('a1', 'one', 'running', wf('alpha', 'run-a')),
      agent('a2', 'two', 'running', wf(null, 'run-b')),
      agent('a3', 'three', 'completed', wf('alpha renamed', 'run-a')),
    ];
    const groups = groupAgents(agents);
    expect(groups.map((x) => [x.key, x.title, x.agents.length])).toEqual([
      ['run-a', 'Workflow alpha', 2],
      ['run-b', 'Workflow run-b', 1],
    ]);
    expect(groups[0]?.workflowState).toBe('running');
    expect(groupAgents([])).toEqual([]);
    expect(LAZY_AGENT_THRESHOLD).toBe(30);
    expect(AGENT_PAGE).toBe(100);
  });

  it('stateSummary keeps a stable order of the five legacy states', () => {
    const items = [
      { state: { state: 'failed' } },
      { state: { state: 'running' } },
      { state: { state: 'waiting_input' } },
      { state: { state: 'completed' } },
      { state: { state: 'working' } },
    ];
    expect(stateSummary(items)).toBe('2 running, 1 idle, 1 completed, 1 failed');
    expect(stateSummary([])).toBe('');
  });

  it('legacy: state change detection', () => {
    const a = stateMap([sess('s1', 'running')]);
    const b = stateMap([sess('s1', 'completed'), sess('s2', 'running')]);
    expect(diffStates(a, b).map((c) => [c.label, c.from, c.to])).toEqual([['s1', 'RUNNING', 'COMPLETED']]);
  });

  it('state change detection ignores moves inside one legacy state and covers agents', () => {
    const worker = agent('w1', 'worker', 'running');
    const agentsOf = (): ViewAgent[] => [worker];
    const before = stateMap([sess('s1', 'working')], agentsOf);
    const same = stateMap([sess('s1', 'waiting_tool')], agentsOf);
    expect(diffStates(before, same)).toEqual([]);
    const after = stateMap([sess('s1', 'working')], () => [agent('w1', 'worker', 'failed')]);
    expect(diffStates(before, after).map((c) => [c.key, c.label, c.from, c.to])).toEqual([
      ['s1|w1', 's1 / worker', 'RUNNING', 'FAILED'],
    ]);
  });

  it('pickDefaultSession prefers the first active session, then one that needs input, then the first listed', () => {
    const idleOnly = buildSessionView([sess('i1', 'turn_ended'), sess('d1', 'completed')], '');
    expect(pickDefaultSession(idleOnly)?.id).toBe('i1');
    const withWaiting = buildSessionView([sess('i1', 'turn_ended'), sess('w1', 'waiting_input')], '');
    expect(pickDefaultSession(withWaiting)?.id).toBe('w1');
    const withActive = buildSessionView(
      [sess('i1', 'turn_ended'), sess('w1', 'waiting_input'), sess('r1', 'running'), sess('r2', 'working')],
      '',
    );
    expect(pickDefaultSession(withActive)?.id).toBe('r1');
    expect(pickDefaultSession([])).toBeNull();
  });
});
