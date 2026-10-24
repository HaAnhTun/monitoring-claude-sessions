// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { enMessages } from '../i18n/messages/en.ts';
import { viMessages } from '../i18n/messages/vi.ts';
import { createCatalogues, createT } from '../i18n/translate.ts';
import { msg } from '../test/msg.ts';
import {
  AGENT_PAGE,
  LAZY_AGENT_THRESHOLD,
  SWITCHER_MAX_ROWS,
  agentGroupTitle,
  diffStates,
  groupAgents,
  stateMap,
  stateSummaryParts,
  stateSummaryText,
  switcherView,
  type SwitcherSession,
  type ViewAgent,
  type ViewSession,
} from './sessions-view.ts';

const tEn = createT('en', createCatalogues({ initial: { en: enMessages, vi: viMessages } }));

function sess(id: string, state: string, extra: Partial<ViewSession> = {}): ViewSession {
  return { id, label: id, state: { state, evidence: [] }, ...extra };
}

function agent(id: string, label: string, state: string, workflow: ViewAgent['workflow'] = null): ViewAgent {
  return { id, label, model: null, state: { state, evidence: [] }, workflow };
}

function wf(name: string | null, runId = 'run-1'): NonNullable<ViewAgent['workflow']> {
  return { runId, name, phase: null, state: 'running' };
}

describe('agent groups', () => {
  it('groups workflows and plain subagents, no cap, with a per-group summary', () => {
    const agents: ViewAgent[] = [];
    for (let i = 0; i < 120; i += 1) {
      agents.push(
        agent(`a${String(i)}`, `a${String(i)}`, i % 2 ? 'running' : 'completed', i < 100 ? wf('wf-1') : null),
      );
    }
    const g = groupAgents(agents);
    expect(g.map((x) => [agentGroupTitle(x, tEn), x.agents.length])).toEqual([
      ['Subagents', 20],
      ['Workflow wf-1', 100],
    ]);
    expect(stateSummaryText(g[1]?.summaryParts ?? [], tEn)).toBe('50 running, 50 completed');
    expect(g[0]?.key).toBe('');
    expect(g[1]?.key).toBe('run-1');
    expect(
      stateSummaryText(stateSummaryParts([{ state: { state: 'failed' } }, { state: { state: 'bogus' } }]), tEn),
    ).toBe('1 failed, 1 unknown');
  });

  it('keys by run id, titles with the name or the run id and keeps the run state', () => {
    const agents = [
      agent('a1', 'one', 'running', wf('alpha', 'run-a')),
      agent('a2', 'two', 'running', wf(null, 'run-b')),
      agent('a3', 'three', 'completed', wf('alpha renamed', 'run-a')),
    ];
    const groups = groupAgents(agents);
    expect(groups.map((x) => [x.key, agentGroupTitle(x, tEn), x.agents.length])).toEqual([
      ['run-a', 'Workflow alpha', 2],
      ['run-b', 'Workflow run-b', 1],
    ]);
    expect(groups[0]?.workflowState).toBe('running');
    expect(groupAgents([])).toEqual([]);
    expect(LAZY_AGENT_THRESHOLD).toBe(30);
    expect(AGENT_PAGE).toBe(100);
  });

  it('describes a group by catalogue keys, so a language switch re-words it', () => {
    const [plain, run] = groupAgents([
      agent('a1', 'one', 'running'),
      agent('a2', 'two', 'completed', wf('alpha', 'run-a')),
    ]);
    if (plain === undefined || run === undefined) throw new Error('two groups expected');
    expect(plain.titleKey).toBe('shell.agents.subagents');
    expect(run.titleKey).toBe('shell.agents.workflow');
    expect(run.titleArgs).toEqual({ name: 'alpha' });
    const tVi = createT('vi', createCatalogues({ initial: { en: enMessages, vi: viMessages } }));
    expect(agentGroupTitle(plain, tVi)).toBe(msg('shell.agents.subagents', undefined, 'vi'));
    expect(agentGroupTitle(run, tVi)).toBe(msg('shell.agents.workflow', { name: 'alpha' }, 'vi'));
    expect(stateSummaryText(plain.summaryParts, tVi)).toBe(msg('shell.agents.summary.running', { count: 1 }, 'vi'));
  });

  it('keeps a stable order of the five legacy states in the summary', () => {
    const items = [
      { state: { state: 'failed' } },
      { state: { state: 'running' } },
      { state: { state: 'waiting_input' } },
      { state: { state: 'completed' } },
      { state: { state: 'working' } },
    ];
    expect(stateSummaryText(stateSummaryParts(items), tEn)).toBe('2 running, 1 idle, 1 completed, 1 failed');
    expect(stateSummaryParts([])).toEqual([]);
  });
});

describe('state changes', () => {
  it('detects a change of the five-state value', () => {
    const a = stateMap([sess('s1', 'running')]);
    const b = stateMap([sess('s1', 'completed'), sess('s2', 'running')]);
    expect(diffStates(a, b).map((c) => [c.label, c.from, c.to])).toEqual([['s1', 'RUNNING', 'COMPLETED']]);
  });

  it('ignores moves inside one legacy state and covers agents', () => {
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
});

function row(id: string, state: string, errorCount = 0): SwitcherSession {
  return { ...sess(id, state), errorCount };
}

const ids = (list: readonly { id: string }[]): string[] => list.map((s) => s.id);

describe('session switcher view (ADR 0073 decision 4)', () => {
  it('lists sessions with errors first, then the active ones, and leaves the others out', () => {
    const view = switcherView([
      row('run-1', 'working'),
      row('done-1', 'completed'),
      row('bad-1', 'failed', 2),
      row('idle-1', 'turn_ended'),
      row('run-2', 'waiting_tool'),
      row('wait-1', 'waiting_input'),
    ]);
    expect(view.groups.map((g) => [g.id, g.titleKey, ids(g.sessions)])).toEqual([
      ['errors', 'shell.switcher.errors', ['bad-1']],
      ['active', 'state.group.active', ['run-1', 'run-2']],
    ]);
    expect(view.hidden).toBe(0);
  });

  it('shows an active session that has errors once, in the errors group', () => {
    const view = switcherView([row('run-1', 'working', 1), row('run-2', 'working')]);
    expect(view.groups.map((g) => [g.id, ids(g.sessions)])).toEqual([
      ['errors', ['run-1']],
      ['active', ['run-2']],
    ]);
  });

  it('drops an empty group and gives no group for an empty list', () => {
    expect(switcherView([row('d', 'completed')]).groups).toEqual([]);
    expect(switcherView([]).groups).toEqual([]);
    expect(switcherView([row('r', 'working')]).groups.map((g) => g.id)).toEqual(['active']);
  });

  it('caps the rows, errors first, and counts what is left out', () => {
    const many = Array.from({ length: 1000 }, (_, i) => row(`r${String(i)}`, 'working', i % 10 === 0 ? 1 : 0));
    const view = switcherView(many);
    const shown = view.groups.flatMap((g) => g.sessions);
    expect(shown).toHaveLength(SWITCHER_MAX_ROWS);
    expect(view.hidden).toBe(1000 - SWITCHER_MAX_ROWS);
    expect(view.groups[0]?.id).toBe('errors');
    expect(shown.slice(0, 3).every((s) => s.errorCount > 0)).toBe(true);
  });

  it('keeps the open session in the list even when the cap would cut it', () => {
    const many = Array.from({ length: 50 }, (_, i) => row(`r${String(i)}`, 'working'));
    const view = switcherView(many, 5, 'r40');
    const shown = view.groups.flatMap((g) => g.sessions);
    expect(shown).toHaveLength(5);
    expect(ids(shown)).toContain('r40');
    expect(view.hidden).toBe(45);
  });

  it('keeps the open session out of the list when it is neither active nor failing', () => {
    const view = switcherView([row('r1', 'working'), row('done', 'completed')], 5, 'done');
    expect(ids(view.groups.flatMap((g) => g.sessions))).toEqual(['r1']);
  });

  it('keeps ids with percent signs and any text as they are', () => {
    const view = switcherView([row('50%-a b', 'working')]);
    expect(ids(view.groups.flatMap((g) => g.sessions))).toEqual(['50%-a b']);
  });
});
