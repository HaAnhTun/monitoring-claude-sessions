import type { AgentNode } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { agentId, iso, makeAgent, makeState, makeUsage, runId, sessionId } from '../../test/fixtures/index.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { AgentTree } from './AgentTree.tsx';

const SID = sessionId(1);
const RULE = 'A subagent ending never completes its parent.';

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

function renderTree(agents: AgentNode[], selectedAgentId: string | null = null) {
  return renderWithProviders(<AgentTree sessionId={SID} agents={agents} selectedAgentId={selectedAgentId} />);
}

function rowOf(label: string): HTMLElement {
  const row = screen.getByText(label).closest('li');
  if (row === null) throw new Error(`no row for ${label}`);
  return row;
}

describe('AgentTree', () => {
  it('says so when the session has no subagents', () => {
    renderTree([main()]);
    expect(screen.getByText('This session has no subagents.')).toBeInTheDocument();
  });

  it('lists plain subagents under a "Subagents" group with a state summary', () => {
    renderTree([
      main(),
      sub(1, { state: makeState('working') }),
      sub(2, { state: makeState('completed') }),
      sub(3, { state: makeState('completed') }),
    ]);
    const toggle = screen.getByRole('button', { name: /Subagents/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('3');
    expect(toggle).toHaveTextContent('1 running, 2 completed');
    expect(screen.getByText('FIXTURE subagent 2')).toBeInTheDocument();
  });

  it('groups workflow agents under their run with the state of the run', () => {
    const workflow = { runId: runId(1), name: 'FIXTURE flow', phase: null, state: 'running' as const };
    renderTree([main(), sub(1), sub(2, { kind: 'workflow_agent', workflow })]);
    const toggle = screen.getByRole('button', { name: /Workflow FIXTURE flow/ });
    expect(toggle).toHaveTextContent('Running');
    expect(screen.getByRole('button', { name: /^Subagents/ })).toBeInTheDocument();
  });

  it('collapses a group and removes its rows', async () => {
    renderTree([main(), sub(1)]);
    const toggle = screen.getByRole('button', { name: /Subagents/ });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('FIXTURE subagent 1')).toBeNull();
  });

  it('nests children under their parent and tags an orphan whose parent is not loaded', () => {
    renderTree([
      main(),
      sub(1),
      sub(2, { parentAgentId: agentId(1), label: 'FIXTURE child' }),
      sub(3, { parentAgentId: 'agent-9999', label: 'FIXTURE lost' }),
    ]);
    expect(within(rowOf('FIXTURE subagent 1')).getByText('FIXTURE child')).toBeInTheDocument();
    expect(within(rowOf('FIXTURE lost')).getByText('parent not loaded')).toBeInTheDocument();
  });

  it('marks the selected agent and links every row to its transcript', () => {
    renderTree([main(), sub(1), sub(2)], agentId(2));
    const selected = rowOf('FIXTURE subagent 2');
    expect(selected).toHaveAttribute('aria-current', 'true');
    expect(rowOf('FIXTURE subagent 1')).not.toHaveAttribute('aria-current');
    const link = within(selected).getByRole('link', { name: /Open transcript/ });
    expect(link).toHaveAttribute('href', `/sessions/${SID}?tab=transcript&agent=${agentId(2)}`);
  });

  it('marks the main agent as selected when no agent is chosen', () => {
    renderTree([main(), sub(1)], null);
    const row = rowOf('FIXTURE main agent');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(within(row).getByRole('link', { name: /Open transcript/ })).toHaveAttribute(
      'href',
      `/sessions/${SID}?tab=transcript`,
    );
  });

  it('labels token numbers of an agent as a lower bound from usage.lowerBound', () => {
    renderTree([
      main(),
      sub(1, { usage: makeUsage({ lowerBound: true, completeness: 'partial', scannedPct: 40 }) }),
      sub(2),
    ]);
    expect(within(rowOf('FIXTURE subagent 1')).getByText('lower bound')).toBeInTheDocument();
    expect(within(rowOf('FIXTURE subagent 2')).queryByText('lower bound')).toBeNull();
  });

  it('shows the error count of an agent', () => {
    renderTree([main(), sub(1, { errorCount: 3 })]);
    expect(within(rowOf('FIXTURE subagent 1')).getByText('3 errors')).toBeInTheDocument();
  });

  it('starts a group of more than 30 agents collapsed, then pages it by 100', async () => {
    const many = Array.from({ length: 250 }, (_, n) => sub(n + 1));
    renderTree([main(), ...many]);
    const toggle = screen.getByRole('button', { name: /Subagents/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    // 100 agents and the main row
    expect(screen.getAllByRole('link', { name: /Open transcript/ })).toHaveLength(101);
    await userEvent.click(screen.getByRole('button', { name: 'Show 100 more' }));
    expect(screen.getAllByRole('link', { name: /Open transcript/ })).toHaveLength(201);
    expect(screen.getByRole('button', { name: 'Show 50 more' })).toBeInTheDocument();
  });

  it('explains that a subagent ending never completes its parent', () => {
    renderTree([
      main({ state: makeState('working') }),
      sub(1, { state: makeState('completed') }),
      sub(2, { state: makeState('failed') }),
    ]);
    expect(screen.getByText(RULE)).toBeInTheDocument();
  });

  it('does not show the rule while a child is still running or when the parent has ended', () => {
    const first = renderTree([main({ state: makeState('working') }), sub(1, { state: makeState('working') })]);
    expect(screen.queryByText(RULE)).toBeNull();
    first.unmount();
    renderTree([main({ state: makeState('completed') }), sub(1, { state: makeState('completed') })]);
    expect(screen.queryByText(RULE)).toBeNull();
  });
});
