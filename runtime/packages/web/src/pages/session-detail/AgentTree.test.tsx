import type { AgentNode } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { agentId, iso, makeAgent, makeState, makeUsage, runId, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { AgentTree } from './AgentTree.tsx';

const SID = sessionId(1);

function main(overrides: Partial<AgentNode> = {}): AgentNode {
  return makeAgent({
    id: 'main',
    seq: 100,
    kind: 'main',
    depth: 0,
    parentAgentId: null,
    label: 'FIXTURE main agent',
    state: makeState('working'),
    ...overrides,
  });
}

function sub(n: number, overrides: Partial<AgentNode> = {}): AgentNode {
  return makeAgent({
    id: agentId(n),
    seq: n,
    label: `FIXTURE subagent ${String(n)}`,
    startedAt: iso(-1000 + n),
    ...overrides,
  });
}

function renderTree(agents: AgentNode[], selectedAgentId: string | null = null, locale: 'en' | 'vi' = 'en') {
  return renderWithProviders(<AgentTree sessionId={SID} agents={agents} selectedAgentId={selectedAgentId} />, {
    locale,
  });
}

function rowOf(label: string): HTMLElement {
  const row = screen.getByText(label).closest('tr');
  if (row === null) throw new Error(`no row for ${label}`);
  return row;
}

describe('AgentTree: the counts', () => {
  it('says "Main agent only" for a session that has no subagents, and never "no subagents"', () => {
    renderTree([main()]);
    expect(screen.getByText(msg('tabs.agents.mainOnly'))).toBeInTheDocument();
    expect(screen.queryByText(/no subagents/i)).toBeNull();
    expect(rowOf('FIXTURE main agent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Subagents/ })).toBeNull();
  });

  it('counts one subagent in the singular and does not count the main agent', () => {
    renderTree([main(), sub(1)]);
    expect(screen.getByText(msg('tabs.agents.summary', { count: 1 }))).toBeInTheDocument();
    expect(msg('tabs.agents.summary', { count: 1 })).toBe('1 subagent');
    expect(screen.queryByText(msg('tabs.agents.mainOnly'))).toBeNull();
  });

  it('counts several subagents in the plural, and the count equals the rows of the groups', () => {
    renderTree([
      main(),
      sub(1, { state: makeState('working') }),
      sub(2, { state: makeState('completed') }),
      sub(3, { state: makeState('completed') }),
    ]);
    expect(screen.getByText('3 subagents')).toBeInTheDocument();
    expect(screen.getByText('1 running, 2 completed', { selector: '.agent-tree__summary *' })).toBeInTheDocument();
    const group = screen.getByRole('table', {
      name: msg('tabs.agents.captionGroup', { group: msg('shell.agents.subagents') }),
    });
    expect(within(group).getAllByRole('link')).toHaveLength(3);
  });

  it('says so when the list holds no agent at all', () => {
    renderTree([]);
    expect(screen.getByText(msg('tabs.agents.none'))).toBeInTheDocument();
  });

  it('counts the subagents when the list has no main agent', () => {
    renderTree([sub(1), sub(2)]);
    expect(screen.getByText('2 subagents')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: msg('tabs.agents.captionMain') })).toBeNull();
  });
});

describe('AgentTree: the tables', () => {
  it('draws the columns State, Agent, Model, Last seen and Tokens, and Errors after them', () => {
    renderTree([main(), sub(1, { model: 'fixture-model-b' })]);
    const table = screen.getByRole('table', { name: msg('tabs.agents.captionMain') });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers).toEqual([
      msg('tabs.agents.col.state'),
      msg('tabs.agents.col.agent'),
      msg('tabs.agents.col.model'),
      msg('tabs.agents.col.lastSeen'),
      msg('tabs.agents.col.tokens'),
      msg('tabs.agents.col.errors'),
    ]);
    expect(within(rowOf('FIXTURE subagent 1')).getByText('fixture-model-b')).toBeInTheDocument();
    expect(within(rowOf('FIXTURE subagent 1')).getByText(msg('state.working.label'))).toBeInTheDocument();
  });

  it('shows the output and the new input of an agent, with a "lower bound" mark for partial usage', () => {
    renderTree([
      main(),
      sub(1, { usage: makeUsage({ lowerBound: true, completeness: 'partial', scannedPct: 40 }) }),
      sub(2),
    ]);
    const first = rowOf('FIXTURE subagent 1');
    expect(within(first).getByText(msg('tokens.output'))).toBeInTheDocument();
    expect(within(first).getByText(msg('tokens.inputNew'))).toBeInTheDocument();
    expect(within(first).getAllByText(msg('tokens.lowerBound')).length).toBeGreaterThan(0);
    expect(within(rowOf('FIXTURE subagent 2')).queryByText(msg('tokens.lowerBound'))).toBeNull();
  });

  it('shows the error count of an agent, and nothing for an agent without errors', () => {
    renderTree([main(), sub(1, { errorCount: 3 }), sub(2)]);
    expect(
      within(rowOf('FIXTURE subagent 1')).getByText(msg('sessions.errors.count', { count: 3 })),
    ).toBeInTheDocument();
    expect(within(rowOf('FIXTURE subagent 2')).queryByText(/errors?$/)).toBeNull();
  });

  it('draws the same columns in the table of the main agent and in the tables of the groups, so that they line up', () => {
    renderTree([main(), sub(1)]);
    const headersOf = (name: string): (string | null)[] =>
      within(screen.getByRole('table', { name }))
        .getAllByRole('columnheader')
        .map((header) => header.textContent);
    expect(headersOf(msg('tabs.agents.captionMain'))).toEqual(
      headersOf(msg('tabs.agents.captionGroup', { group: msg('shell.agents.subagents') })),
    );
  });

  it('marks the selected agent and links every row to its transcript', () => {
    renderTree([main(), sub(1), sub(2)], agentId(2));
    const selected = rowOf('FIXTURE subagent 2');
    expect(selected).toHaveAttribute('aria-current', 'true');
    expect(rowOf('FIXTURE subagent 1')).not.toHaveAttribute('aria-current');
    expect(within(selected).getByRole('link')).toHaveAttribute(
      'href',
      `/sessions/${SID}?tab=transcript&agent=${agentId(2)}`,
    );
  });

  it('marks the main agent as selected when no agent is chosen', () => {
    renderTree([main(), sub(1)], null);
    const row = rowOf('FIXTURE main agent');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(within(row).getByRole('link')).toHaveAttribute('href', `/sessions/${SID}?tab=transcript`);
  });
});

describe('AgentTree: the groups', () => {
  it('summarises a group by the states of its agents', () => {
    renderTree([main(), sub(1, { state: makeState('working') }), sub(2, { state: makeState('completed') })]);
    const toggle = screen.getByRole('button', { name: /Subagents/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('(2)');
    expect(toggle).toHaveTextContent('1 running, 1 completed');
  });

  it('groups workflow agents under their run with the state of the run', () => {
    const workflow = { runId: runId(1), name: 'FIXTURE flow', phase: null, state: 'running' as const };
    renderTree([main(), sub(1), sub(2, { kind: 'workflow_agent', workflow })]);
    const toggle = screen.getByRole('button', { name: /Workflow FIXTURE flow/ });
    expect(toggle).toHaveTextContent(msg('state.running.label'));
    expect(screen.getByRole('button', { name: /^Subagents/ })).toBeInTheDocument();
  });

  it('collapses a group and removes its table', async () => {
    renderTree([main(), sub(1)]);
    const toggle = screen.getByRole('button', { name: /Subagents/ });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('FIXTURE subagent 1')).toBeNull();
  });

  it('puts a child right after its parent, indented, and tags an orphan whose parent is not loaded', () => {
    renderTree([
      main(),
      sub(1),
      sub(2, { parentAgentId: agentId(1), label: 'FIXTURE child', startedAt: iso(-900) }),
      sub(3, { parentAgentId: 'agent-9999', label: 'FIXTURE lost', startedAt: iso(-800) }),
    ]);
    const labels = [...document.querySelectorAll('.agent-cell__label')].map((label) => label.textContent);
    expect(labels).toEqual(['FIXTURE main agent', 'FIXTURE subagent 1', 'FIXTURE child', 'FIXTURE lost']);
    expect(rowOf('FIXTURE child').querySelector('.agent-cell')).toHaveAttribute('data-depth', '1');
    expect(rowOf('FIXTURE subagent 1').querySelector('.agent-cell')).toHaveAttribute('data-depth', '0');
    expect(rowOf('FIXTURE child').querySelector('.agent-cell')).toHaveAttribute(
      'style',
      expect.stringContaining('calc(1 * var(--sp-6))'),
    );
    expect(within(rowOf('FIXTURE lost')).getByText(msg('tabs.agents.orphan'))).toBeInTheDocument();
    expect(within(rowOf('FIXTURE child')).queryByText(msg('tabs.agents.orphan'))).toBeNull();
  });

  it('keeps agents on a parent cycle on screen, all tagged as orphans', () => {
    renderTree([
      main(),
      sub(1, { parentAgentId: agentId(2), label: 'FIXTURE loop one' }),
      sub(2, { parentAgentId: agentId(1), label: 'FIXTURE loop two' }),
    ]);
    expect(within(rowOf('FIXTURE loop one')).getByText(msg('tabs.agents.orphan'))).toBeInTheDocument();
    expect(within(rowOf('FIXTURE loop two')).getByText(msg('tabs.agents.orphan'))).toBeInTheDocument();
    expect(screen.getByText('2 subagents')).toBeInTheDocument();
  });

  it('starts a group of more than 30 agents collapsed, then pages it by 100', async () => {
    const many = Array.from({ length: 250 }, (_, n) => sub(n + 1));
    renderTree([main(), ...many]);
    const toggle = screen.getByRole('button', { name: /Subagents/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    // 100 agents and the main row
    expect(screen.getAllByRole('link')).toHaveLength(101);
    await userEvent.click(screen.getByRole('button', { name: msg('tabs.agents.showMore', { count: 100 }) }));
    expect(screen.getAllByRole('link')).toHaveLength(201);
    expect(screen.getByRole('button', { name: msg('tabs.agents.showMore', { count: 50 }) })).toBeInTheDocument();
    expect(screen.getByText('250 subagents')).toBeInTheDocument();
  });
});

describe('AgentTree: the rule of the parent', () => {
  function badgeTitle(label: string): string {
    return rowOf(label).querySelector('.badge--state')?.getAttribute('title') ?? '';
  }

  it('explains in a tooltip, not in the page, that a subagent ending never completes its parent', () => {
    renderTree([
      main({ state: makeState('working') }),
      sub(1, { state: makeState('completed') }),
      sub(2, { state: makeState('failed') }),
    ]);
    expect(screen.queryByText(msg('tabs.agents.rule'))).toBeNull();
    expect(badgeTitle('FIXTURE main agent')).toContain(msg('tabs.agents.rule'));
    expect(badgeTitle('FIXTURE subagent 1')).not.toContain(msg('tabs.agents.rule'));
  });

  it('gives no such tooltip while a child is still running or when the parent has ended', () => {
    const first = renderTree([main({ state: makeState('working') }), sub(1, { state: makeState('working') })]);
    expect(badgeTitle('FIXTURE main agent')).not.toContain(msg('tabs.agents.rule'));
    first.unmount();
    renderTree([main({ state: makeState('completed') }), sub(1, { state: makeState('completed') })]);
    expect(badgeTitle('FIXTURE main agent')).not.toContain(msg('tabs.agents.rule'));
  });

  it('applies the rule to a subagent that has children, too', () => {
    renderTree([
      main({ state: makeState('completed') }),
      sub(1, { state: makeState('working'), startedAt: iso(-900) }),
      sub(2, { parentAgentId: agentId(1), state: makeState('completed'), startedAt: iso(-800) }),
    ]);
    expect(badgeTitle('FIXTURE subagent 1')).toContain(msg('tabs.agents.rule'));
  });
});

describe('AgentTree: the language', () => {
  it('is worded in Vietnamese, with the count of one subagent not turned into a sentence about none', () => {
    renderTree([main(), sub(1)], null, 'vi');
    expect(screen.getByText(msg('tabs.agents.summary', { count: 1 }, 'vi'))).toBeInTheDocument();
    expect(
      screen.getAllByRole('columnheader', { name: msg('tabs.agents.col.lastSeen', undefined, 'vi') }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(msg('tabs.agents.mainOnly', undefined, 'vi'))).toBeNull();
  });

  it('says "Main agent only" in Vietnamese for a session without subagents', () => {
    renderTree([main()], null, 'vi');
    expect(screen.getByText(msg('tabs.agents.mainOnly', undefined, 'vi'))).toBeInTheDocument();
  });
});
