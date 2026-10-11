import type { CostEstimate, TokenUsage } from '@mcs/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_NOW_MS, iso, makeUsage } from '../test/fixtures/index.ts';
import { DataTable, type Column, type DataTableProps } from './DataTable.tsx';
import { LoadMore } from './LoadMore.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import { TokenLine } from './TokenLine.tsx';
import { TokenSummary } from './TokenSummary.tsx';

interface Row {
  id: string;
  name: string;
  count: number;
}

const ROWS: Row[] = [
  { id: 'a', name: 'FIXTURE alpha', count: 3 },
  { id: 'b', name: 'FIXTURE beta', count: 12 },
];

const COLUMNS: Column<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, sortKey: 'name', link: true },
  { id: 'count', header: 'Count', cell: (r) => String(r.count), sortKey: 'count', align: 'end', mono: true },
  { id: 'note', header: 'Note', cell: () => 'n', hideBelow: 'narrow' },
];

function renderTable(props: Partial<DataTableProps<Row>> = {}) {
  return render(
    <MemoryRouter>
      <DataTable<Row> caption="Fixture rows" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DataTable', () => {
  it('is a semantic table with an sr-only caption and column headers', () => {
    renderTable();
    const table = screen.getByRole('table', { name: 'Fixture rows' });
    expect(within(table).getByText('Fixture rows').tagName).toBe('CAPTION');
    expect(within(table).getByText('Fixture rows')).toHaveClass('sr-only');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['Name', 'Count', 'Note']);
    for (const header of headers) expect(header).toHaveAttribute('scope', 'col');
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('puts aria-sort on sortable headers only: the active one has a direction, the others "none"', () => {
    renderTable({ sort: { key: 'count', dir: 'desc', onSort: vi.fn() } });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: 'Count' })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: 'Note' })).not.toHaveAttribute('aria-sort');
  });

  it('reports ascending order and calls onSort with the sort key of the clicked header button', async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderTable({ sort: { key: 'name', dir: 'asc', onSort } });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
    await user.click(screen.getByRole('button', { name: 'Count' }));
    expect(onSort).toHaveBeenCalledExactlyOnceWith('count');
    expect(screen.queryByRole('button', { name: 'Note' })).toBeNull();
  });

  it('renders no sort buttons without a sort prop', () => {
    renderTable();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('columnheader', { name: 'Count' })).not.toHaveAttribute('aria-sort');
  });

  it('renders the link column as a router link to the row href and marks the row link-able', () => {
    renderTable({ rowHref: (r) => `/things/${r.id}` });
    const link = screen.getByRole('link', { name: 'FIXTURE alpha' });
    expect(link).toHaveAttribute('href', '/things/a');
    expect(screen.getByRole('link', { name: 'FIXTURE beta' })).toHaveAttribute('href', '/things/b');
    expect(link.closest('tr')).toHaveClass('data-table__row--link');
    expect(screen.queryByRole('link', { name: '3' })).toBeNull();
  });

  it('uses the first column as the link when no column says so', () => {
    const columns = COLUMNS.map((column) => ({ id: column.id, header: column.header, cell: column.cell }));
    renderTable({ columns, rowHref: (r) => `/x/${r.id}` });
    expect(screen.getByRole('link', { name: 'FIXTURE alpha' })).toHaveAttribute('href', '/x/a');
  });

  it('marks the selected row with aria-current and applies the column options', () => {
    renderTable({ selectedKey: 'b' });
    const rows = screen.getAllByRole('row');
    expect(rows[2]).toHaveAttribute('aria-current', 'true');
    expect(rows[1]).not.toHaveAttribute('aria-current');
    const cell = screen.getByRole('cell', { name: '12' });
    expect(cell).toHaveClass('mono');
    expect(cell).toHaveClass('is-end');
    expect(screen.getAllByRole('cell', { name: 'n' })[0]).toHaveClass('col-narrow');
    expect(screen.getByRole('columnheader', { name: 'Note' })).toHaveClass('col-narrow');
  });

  it('scrolls inside its own wrapper', () => {
    const { container } = renderTable();
    expect(container.querySelector('.tbl-wrap')).toContainElement(screen.getByRole('table'));
  });
});

describe('LoadMore', () => {
  it('shows the count with a known total and a button for the next page', async () => {
    const user = userEvent.setup();
    const onLoad = vi.fn();
    render(<LoadMore hasMore loading={false} onLoad={onLoad} shown={100} total={342} noun="sessions" />);
    expect(screen.getByText('Showing 100 of 342 sessions')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load 100 more' }));
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it('offers only the remaining rows when fewer than a page are left', () => {
    render(<LoadMore hasMore loading={false} onLoad={vi.fn()} shown={100} total={130} noun="sessions" />);
    expect(screen.getByRole('button', { name: 'Load 30 more' })).toBeInTheDocument();
  });

  it('shows the count without a total, and marks a lower bound', () => {
    const { rerender } = render(
      <LoadMore hasMore loading={false} onLoad={vi.fn()} shown={100} total={null} noun="sessions" />,
    );
    expect(screen.getByText('Showing 100 sessions')).toBeInTheDocument();
    rerender(
      <LoadMore hasMore loading={false} onLoad={vi.fn()} shown={100} total={10000} totalIsLowerBound noun="sessions" />,
    );
    expect(screen.getByText('Showing 100 of 10000+ sessions')).toBeInTheDocument();
  });

  it('disables the button while loading', () => {
    render(<LoadMore hasMore loading onLoad={vi.fn()} shown={100} total={342} noun="sessions" />);
    expect(screen.getByRole('button', { name: /Loading/ })).toBeDisabled();
  });

  it('renders nothing to click when there is no more', () => {
    render(<LoadMore hasMore={false} loading={false} onLoad={vi.fn()} shown={5} total={5} noun="sessions" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Showing 5 of 5 sessions')).toBeInTheDocument();
  });

  it('replaces the button by the capped note', () => {
    render(<LoadMore hasMore loading={false} onLoad={vi.fn()} shown={1000} total={4000} noun="sessions" capped />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Showing the first 1000 sessions; narrow the filters to see others')).toBeInTheDocument();
  });
});

describe('TokenLine and TokenSummary', () => {
  it('shows the three groups of the legacy token line', () => {
    render(<TokenLine usage={makeUsage({ input: 1000, cacheCreation: 500, output: 2500, cacheRead: 3_000_000 })} />);
    expect(screen.getByText('out 3k · new input 2k · cache read 3.0M')).toBeInTheDocument();
    expect(screen.queryByText(/processed/)).toBeNull();
  });

  it('never turns a missing number into 0: it says n/a', () => {
    render(<TokenLine usage={makeUsage({ output: null, input: null, completeness: 'partial', scannedPct: 40 })} />);
    expect(screen.getByText(/out n\/a · new input n\/a/)).toBeInTheDocument();
    expect(screen.queryByText(/ 0\b/)).toBeNull();
    expect(screen.getByText('lower bound')).toBeInTheDocument();
  });

  it('keeps a real zero as 0', () => {
    render(<TokenLine usage={makeUsage({ output: 0, input: 0, cacheCreation: 0, cacheRead: 0, total: 0 })} />);
    expect(screen.getByText('out 0 · new input 0 · cache read 0')).toBeInTheDocument();
  });

  it('says "not available" for unavailable or missing usage, with no numbers', () => {
    const { rerender } = render(<TokenLine usage={null} />);
    expect(screen.getByText('not available')).toBeInTheDocument();
    expect(screen.queryByText(/out /)).toBeNull();
    rerender(<TokenLine usage={makeUsage({ completeness: 'unavailable', output: null, total: null })} />);
    expect(screen.getByText('not available')).toBeInTheDocument();
    expect(screen.queryByText(/out /)).toBeNull();
  });

  it('renders the line layout with the subagent note and a labelled cost estimate', () => {
    const cost: CostEstimate = {
      amount: 1.5,
      currency: 'USD',
      basis: 'estimate',
      pricedTokensPct: 80,
      unpricedModels: [],
    };
    render(<TokenSummary usage={makeUsage()} cost={cost} layout="line" includesSubagents />);
    expect(screen.getByText('(incl. subagents)')).toBeInTheDocument();
    expect(screen.getByText(/Estimated cost \(configured prices\)/)).toHaveTextContent('1.50 USD');
    expect(screen.getByText(/covers 80% of tokens/)).toBeInTheDocument();
  });

  it('shows no cost without an estimate and no coverage note at 100%', () => {
    const cost: CostEstimate = {
      amount: 2,
      currency: 'USD',
      basis: 'estimate',
      pricedTokensPct: 100,
      unpricedModels: [],
    };
    const { rerender } = render(<TokenSummary usage={makeUsage()} layout="line" />);
    expect(screen.queryByText(/Estimated cost/)).toBeNull();
    rerender(<TokenSummary usage={makeUsage()} cost={cost} layout="line" />);
    expect(screen.getByText(/Estimated cost/)).toBeInTheDocument();
    expect(screen.queryByText(/covers/)).toBeNull();
  });

  it('renders the grid layout as four labelled numbers and the turns', () => {
    const usage: TokenUsage = makeUsage({ input: 1200, output: 50, cacheCreation: null, cacheRead: 0, turns: 7 });
    render(<TokenSummary usage={usage} layout="grid" />);
    const pairs = screen.getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(pairs).toEqual([
      ['Input', '1k'],
      ['Output', '50'],
      ['Cache creation', 'n/a'],
      ['Cache read', '0'],
      ['Turns', '7'],
    ]);
  });
});

describe('RelativeTime', () => {
  it('renders a time element with the ISO value, a title and the relative age', () => {
    vi.useFakeTimers({ now: FIXTURE_NOW_MS });
    render(<RelativeTime iso={iso(-125)} />);
    const time = screen.getByText('2m ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', iso(-125));
    expect(time).toHaveAttribute('title', `${iso(-125)} (2m ago)`);
  });

  it('re-renders from the shared one-second clock', () => {
    vi.useFakeTimers({ now: FIXTURE_NOW_MS });
    render(<RelativeTime iso={iso(-2)} />);
    expect(screen.getByText('just now')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText('6s ago')).toBeInTheDocument();
  });

  it('shows the wall clock in clock mode and both in both mode', () => {
    vi.useFakeTimers({ now: FIXTURE_NOW_MS });
    const { rerender } = render(<RelativeTime iso={iso(-60)} mode="clock" />);
    expect(screen.getByText('11:59:00')).toBeInTheDocument();
    rerender(<RelativeTime iso={iso(-60)} mode="both" />);
    expect(screen.getByText('11:59:00 (60s ago)')).toBeInTheDocument();
  });

  it('shows a dash for a missing time', () => {
    render(<RelativeTime iso={null} />);
    expect(screen.getByText('-')).toBeInTheDocument();
    expect(document.querySelector('time')).toBeNull();
  });
});
