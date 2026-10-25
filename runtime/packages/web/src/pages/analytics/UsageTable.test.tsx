import type { CostEstimate, UsageRow } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { TimeRange } from '../../lib/url-state.ts';
import { makeUsage, makeUsageRow } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { rowLink, sortRows, UsageTable } from './UsageTable.tsx';

const RANGE: TimeRange = { kind: 'preset', preset: '7d' };

const usage = (output: number | null, total: number | null) =>
  makeUsage({ output, input: 10, cacheCreation: 1, cacheRead: 100, total });

const COST: CostEstimate = {
  amount: 1.5,
  currency: 'USD',
  basis: 'estimate',
  pricedTokensPct: 100,
  unpricedModels: [],
};

const ROWS: UsageRow[] = [
  makeUsageRow({ key: 'model-a', label: 'model-a', usage: usage(500, 700), sessions: 3 }),
  makeUsageRow({ key: 'model-b', label: 'model-b', usage: usage(9000, 12_000), sessions: 1 }),
  makeUsageRow({ key: 'model-c', label: 'model-c', usage: usage(null, null), sessions: 2 }),
];

function labels(): string[] {
  const body = screen.getAllByRole('rowgroup')[1];
  if (body === undefined) throw new Error('no table body');
  return within(body)
    .getAllByRole('row')
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '');
}

describe('UsageTable', () => {
  it('lists the groups by total, largest first, with a link that opens their sessions in the same range', () => {
    renderWithIntl(<UsageTable rows={ROWS} groupBy="model" range={RANGE} />);
    expect(labels()).toEqual(['model-b', 'model-a', 'model-c']);
    expect(screen.getByRole('link', { name: 'model-b' })).toHaveAttribute('href', '/sessions?model=model-b&range=7d');
    expect(
      screen.getByRole('table', { name: msg('analytics.table.caption', { group: msg('analytics.group.model') }) }),
    ).toBeInTheDocument();
  });

  it('names the first column after the grouping', () => {
    renderWithIntl(<UsageTable rows={ROWS} groupBy="project" range={RANGE} />);
    expect(screen.getByRole('columnheader', { name: msg('analytics.group.project') })).toBeInTheDocument();
  });

  it('sorts the loaded rows by a numeric column, flips on a second click, and keeps rows without a figure last', async () => {
    const user = userEvent.setup();
    renderWithIntl(<UsageTable rows={ROWS} groupBy="model" range={RANGE} />);
    const header = (): HTMLElement =>
      screen.getByRole('columnheader', { name: new RegExp(`^${msg('tokens.output')}`) });
    await user.click(within(header()).getByRole('button'));
    expect(labels()).toEqual(['model-b', 'model-a', 'model-c']);
    expect(header()).toHaveAttribute('aria-sort', 'descending');
    await user.click(within(header()).getByRole('button'));
    expect(labels()).toEqual(['model-a', 'model-b', 'model-c']);
    expect(header()).toHaveAttribute('aria-sort', 'ascending');
    await user.click(screen.getByRole('button', { name: msg('analytics.group.model') }));
    expect(labels()).toEqual(['model-a', 'model-b', 'model-c']);
    await user.click(screen.getByRole('button', { name: msg('analytics.group.model') }));
    expect(labels()).toEqual(['model-c', 'model-b', 'model-a']);
  });

  it('writes a missing figure as not available and never as 0', () => {
    renderWithIntl(<UsageTable rows={[ROWS[2] ?? makeUsageRow()]} groupBy="model" range={RANGE} />);
    const row = screen.getAllByRole('row')[1];
    if (row === undefined) throw new Error('no body row');
    const cell = within(row).getAllByRole('cell')[1];
    if (cell === undefined) throw new Error('no output cell');
    expect(cell.textContent).toContain(msg('tokens.na'));
    expect(within(cell).getByText(msg('tokens.notAvailable'))).toHaveClass('sr-only');
    expect(cell.textContent).not.toContain('0');
  });

  it('shows the cost column only when a row was priced, and a row without a price as not available', () => {
    const { rerender } = renderWithIntl(<UsageTable rows={ROWS} groupBy="model" range={RANGE} />);
    expect(screen.queryByRole('columnheader', { name: msg('analytics.col.cost') })).toBeNull();
    const priced = [{ ...(ROWS[0] ?? makeUsageRow()), cost: COST }, ...ROWS.slice(1)];
    rerender(<UsageTable rows={priced} groupBy="model" range={RANGE} />);
    expect(screen.getByRole('columnheader', { name: msg('analytics.col.cost') })).toBeInTheDocument();
    expect(screen.getByText('$1.50')).toBeInTheDocument();
    expect(screen.getAllByTitle(msg('analytics.cost.rowUnpriced'))).toHaveLength(2);
  });

  it('draws the magnitude bar from the share of the largest total', () => {
    const { container } = renderWithIntl(<UsageTable rows={ROWS} groupBy="model" range={RANGE} />);
    const widths = Array.from(container.querySelectorAll<HTMLElement>('.mag__fill')).map(
      (fill) => fill.style.inlineSize,
    );
    expect(widths).toEqual(['100%', '5.833333333333333%', '0%']);
    expect(container.querySelectorAll('.mag[aria-hidden="true"]')).toHaveLength(3);
  });

  it('is drawn in Vietnamese', () => {
    renderWithIntl(<UsageTable rows={ROWS} groupBy="session" range={RANGE} />, { locale: 'vi' });
    expect(
      screen.getByRole('columnheader', { name: msg('analytics.group.session', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: msg('analytics.col.sessions', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(screen.getByText(msg('analytics.col.total', undefined, 'vi'))).toBeInTheDocument();
  });
});

describe('sortRows and rowLink', () => {
  it('breaks ties by label and puts missing figures last in both directions', () => {
    const rows = [
      makeUsageRow({ key: 'b', label: 'b', sessions: 2 }),
      makeUsageRow({ key: 'a', label: 'a', sessions: 2 }),
      makeUsageRow({ key: 'c', label: 'c', usage: usage(null, null) }),
    ];
    expect(sortRows(rows, { key: 'output', dir: 'desc' }).map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(sortRows(rows, { key: 'sessions', dir: 'asc' }).map((r) => r.key)).toEqual(['c', 'a', 'b']);
    expect(sortRows(rows, { key: 'cost', dir: 'asc' }).map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('links a session to its page and the other groups to the sessions list with their time range', () => {
    expect(rowLink('session', 'abc', RANGE)).toBe('/sessions/abc');
    expect(rowLink('task', '7', RANGE)).toBe('/sessions?task=7&range=7d');
    expect(rowLink('project', 'my project', { kind: 'custom', from: '2026-03-01T00:00:00.000Z', to: null })).toBe(
      '/sessions?project=my+project&from=2026-03-01T00%3A00%3A00.000Z',
    );
  });
});
