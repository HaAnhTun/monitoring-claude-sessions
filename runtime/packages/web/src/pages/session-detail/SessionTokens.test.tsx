import type { AgentNode, SessionDetail } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { agentId, makeAgent, makeSessionDetail, makeUsage } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { SessionTokens } from './SessionTokens.tsx';

const TOTAL = makeUsage({ input: 1000, cacheCreation: 500, output: 2500, cacheRead: 3_000_000 });

/** The five tiles of the Tokens tab (the tiles of the page header are another element of the same kind). */
function tilesOf(): HTMLElement {
  const tiles = document.querySelector<HTMLElement>('.session-tokens .token-figures--tiles');
  if (tiles === null) throw new Error('the Tokens tab has no tiles');
  return tiles;
}

function agent(n: number, overrides: Partial<AgentNode> = {}): AgentNode {
  return makeAgent({ id: agentId(n), label: `FIXTURE agent ${String(n)}`, ...overrides });
}

function renderTokens(agents: AgentNode[], session: Partial<SessionDetail> = {}, locale: 'en' | 'vi' = 'en') {
  return renderWithIntl(
    <SessionTokens session={makeSessionDetail({ usageInclSubagents: TOTAL, ...session })} agents={agents} />,
    { locale },
  );
}

/** The labels of the first column of the body rows, in the order drawn. */
function rowLabels(): string[] {
  const table = screen.getByRole('table', { name: msg('tabs.tokens.caption') });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('td')?.textContent ?? '');
}

describe('SessionTokens: the tiles', () => {
  it('draws five tiles: Output, Input (new), Input, Cache write and Cache read, with the exact number in the title', () => {
    renderTokens([agent(1)]);
    const tiles = tilesOf();
    const terms = within(tiles)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(terms).toEqual([
      msg('tokens.output'),
      msg('tokens.inputNew'),
      msg('tokens.input'),
      msg('tokens.cacheWrite'),
      msg('tokens.cacheRead'),
    ]);
    const values = within(tiles).getAllByRole('definition');
    expect(values.map((value) => value.textContent)).toEqual(['2.5K', '1.5K', '1K', '500', '3M']);
    expect(values[2]?.querySelector('[title]')).toHaveAttribute('title', '1,000');
    expect(screen.getByRole('heading', { name: msg('tabs.tokens.totals') })).toBeInTheDocument();
  });

  it('labels the numbers as a lower bound when the usage says so', () => {
    renderTokens([agent(1)], {
      usageInclSubagents: makeUsage({ lowerBound: true, completeness: 'partial', scannedPct: 10 }),
    });
    expect(screen.getAllByText(msg('tokens.lowerBound')).length).toBeGreaterThan(0);
  });

  it('says "not available", never 0, for usage the monitor could not read', () => {
    renderTokens([agent(1)], { usageInclSubagents: makeUsage({ completeness: 'unavailable', output: null }) });
    const tiles = tilesOf();
    expect(within(tiles).getAllByText(msg('tokens.na')).length).toBe(5);
    expect(tiles).not.toHaveTextContent(/\b0\b/);
  });

  it('shows the estimated cost when prices are configured, and says how much of the tokens it covers', () => {
    renderTokens([agent(1)], {
      cost: { amount: 1.5, currency: 'USD', basis: 'estimate', pricedTokensPct: 80, unpricedModels: [] },
    });
    expect(screen.getByText(msg('analytics.cost.label'))).toBeInTheDocument();
    expect(screen.getByText('1.50 USD')).toBeInTheDocument();
    expect(screen.getByText(msg('analytics.cost.priced', { pct: '80%' }))).toBeInTheDocument();
  });

  it('shows no cost line without prices', () => {
    renderTokens([agent(1)], { cost: null });
    expect(screen.queryByText(msg('analytics.cost.label'))).toBeNull();
  });
});

describe('SessionTokens: the table', () => {
  it('has the columns Agent, Model, Output, Input, Cache write and Cache read, with a Total row last', () => {
    renderTokens([agent(1), agent(2)]);
    const table = screen.getByRole('table', { name: msg('tabs.tokens.caption') });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      msg('tabs.agents.col.agent'),
      msg('tabs.agents.col.model'),
      msg('tokens.output'),
      msg('tokens.input'),
      msg('tokens.cacheWrite'),
      msg('tokens.cacheRead'),
    ]);
    expect(rowLabels()).toEqual(['FIXTURE agent 1', 'FIXTURE agent 2', msg('tabs.tokens.total')]);
  });

  it('puts the numbers of the session in the Total row, the numbers of the Sessions list', () => {
    renderTokens([agent(1)]);
    const total = screen.getByText(msg('tabs.tokens.total')).closest('tr') as HTMLElement;
    const cells = within(total)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(cells).toEqual([msg('tabs.tokens.total'), '', '2.5K', '1K', '500', '3M']);
  });

  it('falls back to the model of the session for an agent that reports none, and says why in a tooltip', () => {
    renderTokens([agent(1, { model: null }), agent(2, { model: 'fixture-model-b' })], {
      lastModel: 'fixture-session-model',
      models: ['fixture-session-model'],
    });
    const first = screen.getByText('FIXTURE agent 1').closest('tr') as HTMLElement;
    const fallback = within(first).getByText('fixture-session-model');
    expect(fallback).toHaveAttribute('title', msg('tabs.tokens.sessionModel'));
    const second = screen.getByText('FIXTURE agent 2').closest('tr') as HTMLElement;
    expect(within(second).getByText('fixture-model-b')).not.toHaveAttribute('title');
    expect(screen.queryByText('-')).toBeNull();
  });

  it('sorts by a column, flips on a second press and keeps the Total row last', async () => {
    renderTokens([
      agent(1, { usage: makeUsage({ output: 10 }) }),
      agent(2, { usage: makeUsage({ output: 30 }) }),
      agent(3, { usage: makeUsage({ output: 20 }) }),
    ]);
    const total = msg('tabs.tokens.total');
    expect(rowLabels()).toEqual(['FIXTURE agent 1', 'FIXTURE agent 2', 'FIXTURE agent 3', total]);
    const sortButton = screen.getByRole('button', { name: msg('tokens.output') });
    await userEvent.click(sortButton);
    expect(rowLabels()).toEqual(['FIXTURE agent 2', 'FIXTURE agent 3', 'FIXTURE agent 1', total]);
    expect(screen.getByRole('columnheader', { name: msg('tokens.output') })).toHaveAttribute('aria-sort', 'descending');
    await userEvent.click(sortButton);
    expect(rowLabels()).toEqual(['FIXTURE agent 1', 'FIXTURE agent 3', 'FIXTURE agent 2', total]);
    expect(screen.getByRole('columnheader', { name: msg('tokens.output') })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('sorts the agents by name, ascending first', async () => {
    renderTokens([agent(2, { label: 'FIXTURE b' }), agent(1, { label: 'FIXTURE a' })]);
    await userEvent.click(screen.getByRole('button', { name: msg('tabs.agents.col.agent') }));
    expect(rowLabels()).toEqual(['FIXTURE a', 'FIXTURE b', msg('tabs.tokens.total')]);
  });

  it('puts an agent whose number is not known last, in either direction', async () => {
    renderTokens([
      agent(1, { usage: makeUsage({ completeness: 'unavailable', output: null }) }),
      agent(2, { usage: makeUsage({ output: 5 }) }),
    ]);
    const total = msg('tabs.tokens.total');
    const sortButton = screen.getByRole('button', { name: msg('tokens.output') });
    await userEvent.click(sortButton);
    expect(rowLabels()).toEqual(['FIXTURE agent 2', 'FIXTURE agent 1', total]);
    await userEvent.click(sortButton);
    expect(rowLabels()).toEqual(['FIXTURE agent 2', 'FIXTURE agent 1', total]);
  });

  it('marks the partial usage of an agent as a lower bound', () => {
    renderTokens([
      agent(1, { usage: makeUsage({ lowerBound: true, completeness: 'partial', scannedPct: 50 }) }),
      agent(2),
    ]);
    const partial = screen.getByText('FIXTURE agent 1').closest('tr') as HTMLElement;
    const complete = screen.getByText('FIXTURE agent 2').closest('tr') as HTMLElement;
    expect(within(partial).getAllByText(msg('tokens.lowerBound')).length).toBeGreaterThan(0);
    expect(within(complete).queryByText(msg('tokens.lowerBound'))).toBeNull();
  });

  it('draws no table while the agents are not loaded', () => {
    renderTokens([]);
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.querySelector('.session-tokens .token-figures--tiles')).not.toBeNull();
  });
});

describe('SessionTokens: the note', () => {
  it('says where the numbers come from at the bottom, after the table', () => {
    renderTokens([agent(1)]);
    const note = screen.getByText(msg('tabs.tokens.note'));
    const table = screen.getByRole('table');
    expect(table.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(msg('tokens.inclSubagents'))).toBeNull();
  });

  it('is worded in Vietnamese', () => {
    renderTokens([agent(1)], {}, 'vi');
    expect(screen.getByText(msg('tabs.tokens.note', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: msg('tabs.tokens.totals', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByText(msg('tabs.tokens.total', undefined, 'vi'))).toBeInTheDocument();
  });
});
