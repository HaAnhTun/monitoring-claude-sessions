import type { CostEstimate, TokenUsage } from '@mcs/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MQ_NARROW_TABLE, MQ_SHEET } from '../state/use-media-query.ts';
import { makeUsage } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { DataTable, MQ_COMPACT_TABLE, type Column, type DataTableProps } from './DataTable.tsx';
import { TokenLine } from './TokenLine.tsx';
import { TokenSummary } from './TokenSummary.tsx';

interface Row {
  id: string;
  name: string;
  count: number;
  note: string | null;
  model: string;
}

const ALPHA: Row = { id: 'a', name: 'FIXTURE alpha', count: 3, note: null, model: 'FIXTURE-model' };
const BETA: Row = { id: 'b', name: 'FIXTURE beta', count: 12, note: null, model: 'FIXTURE-model' };
const ROWS: Row[] = [ALPHA, BETA];

const NAME_COLUMN: Column<Row> = { id: 'name', header: 'Name', cell: (r) => r.name, sortKey: 'name', link: true };
const COLUMNS: Column<Row>[] = [
  NAME_COLUMN,
  { id: 'count', header: 'Count', cell: (r) => String(r.count), sortKey: 'count', align: 'end', mono: true },
  { id: 'note', header: 'Note', cell: () => 'n', hideBelow: 'narrow' },
];

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderTable(props: Partial<DataTableProps<Row>> = {}, locale: 'en' | 'vi' = 'en') {
  return renderWithIntl(
    <>
      <DataTable<Row> caption="Fixture rows" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} {...props} />
      <Where />
    </>,
    { locale },
  );
}

type Listener = () => void;

/** A stand-in for `window.matchMedia` where the listed queries match; `set` flips one and tells the listeners. */
function mockMedia(...matching: string[]) {
  const on = new Set(matching);
  const listeners = new Map<string, Set<Listener>>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return on.has(query);
    },
    addEventListener: (type: string, listener: Listener) => {
      if (type !== 'change') return;
      const set = listeners.get(query) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(query, set);
    },
    removeEventListener: (type: string, listener: Listener) => {
      if (type === 'change') listeners.get(query)?.delete(listener);
    },
  }));
  return {
    set: (query: string, matches: boolean) => {
      if (matches) on.add(query);
      else on.delete(query);
      for (const listener of listeners.get(query) ?? []) listener();
    },
  };
}

const headers = (): (string | null)[] => screen.getAllByRole('columnheader').map((h) => h.textContent);

afterEach(() => {
  vi.useRealTimers();
});

describe('DataTable', () => {
  it('is a semantic table with an sr-only caption and column headers', () => {
    renderTable();
    const table = screen.getByRole('table', { name: 'Fixture rows' });
    expect(within(table).getByText('Fixture rows').tagName).toBe('CAPTION');
    expect(within(table).getByText('Fixture rows')).toHaveClass('sr-only');
    const columnHeaders = within(table).getAllByRole('columnheader');
    expect(columnHeaders.map((h) => h.textContent)).toEqual(['Name', 'Count', 'Note']);
    for (const header of columnHeaders) expect(header).toHaveAttribute('scope', 'col');
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

  it('has exactly one link per row', () => {
    renderTable({ rowHref: (r) => `/things/${r.id}` });
    expect(screen.getAllByRole('link')).toHaveLength(ROWS.length);
    for (const row of screen.getAllByRole('row').slice(1)) expect(within(row).getAllByRole('link')).toHaveLength(1);
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

  it('puts the tooltip of a column on its header', () => {
    renderTable({
      columns: [{ id: 'name', header: 'Name', cell: (r) => r.name, headerTitle: 'FIXTURE what the column means' }],
    });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
      'title',
      'FIXTURE what the column means',
    );
  });
});

describe('DataTable: right-aligned numbers and the sticky first column', () => {
  it('aligns a numeric column to the end in the header and in every cell, with tabular figures', () => {
    renderTable({
      columns: [
        { id: 'name', header: 'Name', cell: (r) => r.name },
        { id: 'count', header: 'Count', cell: (r) => String(r.count), numeric: true },
      ],
    });
    expect(screen.getByRole('columnheader', { name: 'Count' })).toHaveClass('is-num', 'is-end');
    expect(screen.getByRole('cell', { name: '12' })).toHaveClass('is-num', 'is-end');
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveClass('is-num');
    expect(screen.getByRole('cell', { name: 'FIXTURE beta' })).not.toHaveClass('is-end');
  });

  it('keeps the cells of a nowrap column on one line, in the header and in every cell', () => {
    renderTable({
      columns: [
        { id: 'name', header: 'Name', cell: (r) => r.name },
        { id: 'model', header: 'Model', cell: (r) => r.model, nowrap: true },
      ],
    });
    expect(screen.getByRole('columnheader', { name: 'Model' })).toHaveClass('is-nowrap');
    for (const cell of screen.getAllByRole('cell', { name: 'FIXTURE-model' })) expect(cell).toHaveClass('is-nowrap');
    expect(screen.getByRole('cell', { name: 'FIXTURE beta' })).not.toHaveClass('is-nowrap');
  });

  it('marks the sticky column in the header and in every cell, and no other column', () => {
    renderTable({
      columns: [
        { id: 'name', header: 'Name', cell: (r) => r.name, stickyStart: true },
        { id: 'count', header: 'Count', cell: (r) => String(r.count) },
      ],
    });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveClass('is-sticky-start');
    expect(screen.getByRole('cell', { name: 'FIXTURE alpha' })).toHaveClass('is-sticky-start');
    expect(screen.getByRole('cell', { name: 'FIXTURE beta' })).toHaveClass('is-sticky-start');
    expect(screen.getByRole('columnheader', { name: 'Count' })).not.toHaveClass('is-sticky-start');
    expect(screen.getByRole('cell', { name: '12' })).not.toHaveClass('is-sticky-start');
  });
});

describe('DataTable: columns by priority', () => {
  const TIERED: Column<Row>[] = [
    { id: 'name', header: 'Name', cell: (r) => r.name },
    { id: 'count', header: 'Count', cell: (r) => String(r.count), priority: 1 },
    { id: 'note', header: 'Note', cell: () => 'FIXTURE note', priority: 2 },
    { id: 'model', header: 'Model', cell: (r) => r.model, priority: 3 },
  ];

  it('shows every column when the window is wide', () => {
    mockMedia();
    renderTable({ columns: TIERED });
    expect(headers()).toEqual(['Name', 'Count', 'Note', 'Model']);
    expect(screen.getAllByRole('cell', { name: 'FIXTURE-model' })).toHaveLength(2);
  });

  it('shows every column when the browser has no matchMedia (the table is the default)', () => {
    vi.stubGlobal('matchMedia', undefined);
    renderTable({ columns: TIERED });
    expect(headers()).toEqual(['Name', 'Count', 'Note', 'Model']);
  });

  it('hides the priority 3 columns below 1280 px: header and cells', () => {
    mockMedia(MQ_NARROW_TABLE);
    renderTable({ columns: TIERED });
    expect(headers()).toEqual(['Name', 'Count', 'Note']);
    expect(screen.queryByText('FIXTURE-model')).toBeNull();
    for (const row of screen.getAllByRole('row').slice(1)) expect(within(row).getAllByRole('cell')).toHaveLength(3);
  });

  it('hides the priority 2 columns too below 1000 px, and never a priority 1 column', () => {
    mockMedia(MQ_NARROW_TABLE, MQ_COMPACT_TABLE);
    renderTable({ columns: TIERED });
    expect(headers()).toEqual(['Name', 'Count']);
    expect(screen.queryByText('FIXTURE note')).toBeNull();
  });

  it('treats a column without a priority as priority 1', () => {
    mockMedia(MQ_NARROW_TABLE, MQ_COMPACT_TABLE);
    renderTable();
    expect(headers()).toEqual(['Name', 'Count', 'Note']);
  });

  it('follows the window when it is resized', () => {
    const media = mockMedia();
    renderTable({ columns: TIERED });
    expect(headers()).toEqual(['Name', 'Count', 'Note', 'Model']);
    act(() => {
      media.set(MQ_NARROW_TABLE, true);
    });
    expect(headers()).toEqual(['Name', 'Count', 'Note']);
    act(() => {
      media.set(MQ_NARROW_TABLE, false);
    });
    expect(headers()).toEqual(['Name', 'Count', 'Note', 'Model']);
  });

  it('moves the row link to the first column that is left', () => {
    mockMedia(MQ_NARROW_TABLE);
    renderTable({
      columns: [
        { id: 'model', header: 'Model', cell: (r) => r.model, priority: 3 },
        { id: 'name', header: 'Name', cell: (r) => r.name },
      ],
      rowHref: (r) => `/things/${r.id}`,
    });
    expect(screen.getByRole('link', { name: 'FIXTURE alpha' })).toHaveAttribute('href', '/things/a');
    expect(screen.getAllByRole('link')).toHaveLength(ROWS.length);
  });
});

describe('DataTable: hiding columns that carry nothing', () => {
  const column = (over: Partial<Column<Row>>): Column<Row> => ({
    id: 'note',
    header: 'Note',
    cell: (r) => r.note,
    ...over,
  });
  const withNote = (note: Row['note'], index = 0): Row[] =>
    ROWS.map((row, i) => (i === index ? { ...row, note } : row));

  it('hides a column whose cells are all empty, header included', () => {
    renderTable({ columns: [NAME_COLUMN, column({ hideWhenEmpty: true })] });
    expect(headers()).toEqual(['Name']);
    expect(screen.getAllByRole('row').every((row) => within(row).queryAllByRole('cell').length <= 1)).toBe(true);
  });

  it('counts null, undefined, empty text and false as empty', () => {
    const rows = [
      { ...ALPHA, note: null },
      { ...BETA, note: '' },
    ];
    renderTable({ rows, columns: [NAME_COLUMN, column({ hideWhenEmpty: true, cell: () => false })] });
    expect(headers()).toEqual(['Name']);
  });

  it('keeps the column as soon as one row has a value', () => {
    renderTable({
      rows: withNote('FIXTURE value', 1),
      columns: [NAME_COLUMN, column({ hideWhenEmpty: true })],
    });
    expect(headers()).toEqual(['Name', 'Note']);
    expect(screen.getByRole('cell', { name: 'FIXTURE value' })).toBeInTheDocument();
  });

  it('keeps a column of zeros: 0 is a value', () => {
    renderTable({
      columns: [NAME_COLUMN, column({ hideWhenEmpty: true, cell: () => 0, value: () => 0 })],
    });
    expect(headers()).toEqual(['Name', 'Note']);
  });

  it('reads the value accessor before the cell: a cell that draws nothing for an empty value is hidden', () => {
    renderTable({
      columns: [
        NAME_COLUMN,
        column({ hideWhenEmpty: true, cell: () => <span className="muted"> </span>, value: (r) => r.note }),
      ],
    });
    expect(headers()).toEqual(['Name']);
  });

  it('keeps a column whose cells are elements when no value accessor says they are empty', () => {
    renderTable({ columns: [NAME_COLUMN, column({ hideWhenEmpty: true, cell: () => <span>x</span> })] });
    expect(headers()).toEqual(['Name', 'Note']);
  });

  it('keeps every column when there are no rows, so the header still explains the table', () => {
    renderTable({ rows: [], columns: [NAME_COLUMN, column({ hideWhenEmpty: true })] });
    expect(headers()).toEqual(['Name', 'Note']);
  });

  it('hides a column whose cells are all the same only when asked with "same"', () => {
    const model = (hideWhenEmpty: boolean | 'same'): Column<Row> => ({
      id: 'model',
      header: 'Model',
      cell: (r) => r.model,
      hideWhenEmpty,
    });
    const { unmount } = renderTable({ columns: [NAME_COLUMN, model(true)] });
    expect(headers()).toEqual(['Name', 'Model']);
    unmount();
    renderTable({ columns: [NAME_COLUMN, model('same')] });
    expect(headers()).toEqual(['Name']);
  });

  it('keeps a "same" column when two rows differ, and when only one row is shown', () => {
    const model: Column<Row> = { id: 'model', header: 'Model', cell: (r) => r.model, hideWhenEmpty: 'same' };
    const { unmount } = renderTable({
      columns: [NAME_COLUMN, model],
      rows: [ALPHA, { ...BETA, model: 'FIXTURE-other' }],
    });
    expect(headers()).toEqual(['Name', 'Model']);
    unmount();
    renderTable({ columns: [NAME_COLUMN, model], rows: [ALPHA] });
    expect(headers()).toEqual(['Name', 'Model']);
  });

  it('hides a "same" column of empty cells too, and compares by the value accessor', () => {
    const { unmount } = renderTable({ columns: [NAME_COLUMN, column({ hideWhenEmpty: 'same' })] });
    expect(headers()).toEqual(['Name']);
    unmount();
    renderTable({
      columns: [
        NAME_COLUMN,
        column({ hideWhenEmpty: 'same', cell: (r) => <b>{r.name}</b>, value: () => 'FIXTURE same' }),
      ],
    });
    expect(headers()).toEqual(['Name']);
  });
});

describe('DataTable: the card list below 900 px', () => {
  const cardColumns: Column<Row>[] = [
    { id: 'name', header: 'Name', cell: (r) => r.name, sortKey: 'name' },
    { id: 'count', header: 'Count', cell: (r) => String(r.count), sortKey: 'count', numeric: true },
    { id: 'note', header: 'Note', cell: () => 'n' },
  ];
  const card: DataTableProps<Row>['card'] = (r) => ({
    lead: <span data-testid={`lead-${r.id}`}>FIXTURE lead</span>,
    title: r.name,
    end: <span>{`FIXTURE end ${r.id}`}</span>,
    meta: <span>{`FIXTURE meta ${String(r.count)}`}</span>,
  });
  const base = { columns: cardColumns, card, rowHref: (r: Row) => `/things/${r.id}` };

  it('stays a table on a wide window, with or without a card renderer', () => {
    mockMedia();
    renderTable(base);
    expect(screen.getByRole('table', { name: 'Fixture rows' })).toBeInTheDocument();
    expect(screen.queryByTestId('lead-a')).toBeNull();
  });

  it('stays a table below 900 px when the page gave no card renderer', () => {
    mockMedia(MQ_SHEET);
    renderTable({ columns: cardColumns });
    expect(screen.getByRole('table', { name: 'Fixture rows' })).toBeInTheDocument();
  });

  it('stays a table when the browser has no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    renderTable(base);
    expect(screen.getByRole('table', { name: 'Fixture rows' })).toBeInTheDocument();
  });

  it('is a list named by the caption, one item per row, and no table', () => {
    mockMedia(MQ_SHEET);
    renderTable(base);
    expect(screen.queryByRole('table')).toBeNull();
    const list = screen.getByRole('list', { name: 'Fixture rows' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(ROWS.length);
    expect(items[0]).toHaveTextContent('FIXTURE alpha');
    expect(items[0]).toHaveTextContent('FIXTURE lead');
    expect(items[0]).toHaveTextContent('FIXTURE end a');
    expect(items[0]).toHaveTextContent('FIXTURE meta 3');
    expect(items[1]).toHaveTextContent('FIXTURE beta');
  });

  it('keeps one link per row: the title, to the row href', () => {
    mockMedia(MQ_SHEET);
    renderTable(base);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(ROWS.length);
    expect(links[0]).toHaveAccessibleName('FIXTURE alpha');
    expect(links[0]).toHaveAttribute('href', '/things/a');
    expect(links[1]).toHaveAttribute('href', '/things/b');
    for (const item of screen.getAllByRole('listitem')) expect(within(item).getAllByRole('link')).toHaveLength(1);
    expect(screen.getAllByRole('listitem')[0]).toHaveClass('data-card--link');
    for (const item of screen.getAllByRole('listitem')) expect(item).toHaveAttribute('data-row');
  });

  it('draws the title as plain text when there is no row href', () => {
    mockMedia(MQ_SHEET);
    renderTable({ columns: cardColumns, card });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('FIXTURE alpha')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[0]).not.toHaveClass('data-card--link');
  });

  it('marks the selected card with aria-current', () => {
    mockMedia(MQ_SHEET);
    renderTable({ ...base, selectedKey: 'b' });
    const items = screen.getAllByRole('listitem');
    expect(items[1]).toHaveAttribute('aria-current', 'true');
    expect(items[0]).not.toHaveAttribute('aria-current');
  });

  it('switches between the table and the list when the window crosses 900 px', () => {
    const media = mockMedia();
    renderTable(base);
    expect(screen.getByRole('table')).toBeInTheDocument();
    act(() => {
      media.set(MQ_SHEET, true);
    });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(ROWS.length);
    act(() => {
      media.set(MQ_SHEET, false);
    });
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('keeps the sort reachable: a "Sort by" select of the sortable columns and a direction button', async () => {
    mockMedia(MQ_SHEET);
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderTable({ ...base, sort: { key: 'count', dir: 'desc', onSort } });
    const select = screen.getByRole('combobox', { name: msg('lists.sortBy') });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Name', 'Count']);
    expect(select).toHaveValue('count');
    await user.selectOptions(select, 'name');
    expect(onSort).toHaveBeenLastCalledWith('name');
    await user.click(screen.getByRole('button', { name: msg('lists.sortDescending') }));
    expect(onSort).toHaveBeenLastCalledWith('count');
    expect(onSort).toHaveBeenCalledTimes(2);
  });

  it('names the direction of the sort on the button, both ways', () => {
    mockMedia(MQ_SHEET);
    const { rerender } = renderTable({ ...base, sort: { key: 'count', dir: 'asc', onSort: vi.fn() } });
    expect(screen.getByRole('button', { name: msg('lists.sortAscending') })).toBeInTheDocument();
    rerender(
      <DataTable<Row>
        caption="Fixture rows"
        columns={cardColumns}
        rows={ROWS}
        rowKey={(r) => r.id}
        card={card}
        sort={{ key: 'count', dir: 'desc', onSort: vi.fn() }}
      />,
    );
    expect(screen.getByRole('button', { name: msg('lists.sortDescending') })).toBeInTheDocument();
  });

  it('has no sort controls without a sort, and none when no column can be sorted', () => {
    mockMedia(MQ_SHEET);
    const { unmount } = renderTable(base);
    expect(screen.queryByRole('combobox')).toBeNull();
    unmount();
    renderTable({
      columns: [{ id: 'name', header: 'Name', cell: (r) => r.name }],
      card,
      sort: { key: 'name', dir: 'asc', onSort: vi.fn() },
    });
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('says the sort words in Vietnamese', () => {
    mockMedia(MQ_SHEET);
    renderTable({ ...base, sort: { key: 'count', dir: 'asc', onSort: vi.fn() } }, 'vi');
    expect(screen.getByRole('combobox', { name: msg('lists.sortBy', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('lists.sortAscending', undefined, 'vi') })).toBeInTheDocument();
  });

  it('draws a thousand cards without a table', () => {
    mockMedia(MQ_SHEET);
    const rows: Row[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `r${String(i)}`,
      name: `FIXTURE row ${String(i)}`,
      count: i,
      note: null,
      model: 'FIXTURE-model',
    }));
    renderTable({ ...base, rows });
    expect(screen.getAllByRole('listitem')).toHaveLength(1000);
    expect(screen.getAllByRole('link')).toHaveLength(1000);
  });
});

describe('DataTable: a click anywhere on a linked row', () => {
  const linked = { rowHref: (r: Row) => `/things/${r.id}` };

  it('opens the row from a cell that is not the link', async () => {
    const user = userEvent.setup();
    renderTable(linked);
    await user.click(screen.getByRole('cell', { name: '12' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/things/b');
  });

  it('leaves a button, a link or a field inside a cell to do its own work', async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    renderTable({
      ...linked,
      rows: [ALPHA],
      columns: [
        NAME_COLUMN,
        {
          id: 'act',
          header: 'Act',
          cell: () => (
            <button type="button" onClick={onPress}>
              FIXTURE press
            </button>
          ),
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'FIXTURE press' }));
    expect(onPress).toHaveBeenCalledOnce();
    expect(screen.getByTestId('where').textContent).toBe('/');
    expect(screen.getByTestId('where')).not.toHaveTextContent('/things');
  });

  it('does not navigate on a modified click or while text is selected', async () => {
    const user = userEvent.setup();
    renderTable(linked);
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('cell', { name: '12' }));
    await user.keyboard('{/Control}');
    expect(screen.getByTestId('where')).not.toHaveTextContent('/things');
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'FIXTURE selected' } as unknown as Selection);
    await user.click(screen.getByRole('cell', { name: '12' }));
    expect(screen.getByTestId('where')).not.toHaveTextContent('/things');
  });

  it('does nothing on a row without a href', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole('cell', { name: '12' }));
    expect(screen.getByTestId('where').textContent).toBe('/');
    expect(screen.getByTestId('where')).not.toHaveTextContent('/things');
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

describe('DataTable: a class per row and extra sorts for the card list', () => {
  const cardColumns: Column<Row>[] = [
    { id: 'name', header: 'Name', cell: (r) => r.name, sortKey: 'name' },
    { id: 'count', header: 'Count', cell: (r) => String(r.count), sortKey: 'count', numeric: true },
  ];
  const card: DataTableProps<Row>['card'] = (r) => ({ title: r.name });
  const rowClass = (r: Row): string | undefined => (r.id === 'b' ? 'fixture-row--hot' : undefined);

  it('puts the class of the row on its table row', () => {
    mockMedia();
    renderTable({ columns: cardColumns, rowClass });
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).not.toHaveClass('fixture-row--hot');
    expect(rows[1]).toHaveClass('fixture-row--hot');
    expect(rows[1]).toHaveClass('data-table__row');
  });

  it('puts the class of the row on its card', () => {
    mockMedia(MQ_SHEET);
    renderTable({ columns: cardColumns, card, rowClass });
    const items = screen.getAllByRole('listitem');
    expect(items[0]).not.toHaveClass('fixture-row--hot');
    expect(items[1]).toHaveClass('fixture-row--hot');
    expect(items[1]).toHaveClass('data-card');
  });

  it('offers an extra sort next to the columns in the card list and shows it as chosen', async () => {
    mockMedia(MQ_SHEET);
    const onSort = vi.fn();
    renderTable({
      columns: cardColumns,
      card,
      sort: { key: 'hot', dir: 'desc', onSort, extra: [{ key: 'hot', label: 'FIXTURE hot first' }] },
    });
    const select = screen.getByRole('combobox', { name: msg('lists.sortBy') });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Name', 'Count', 'FIXTURE hot first']);
    expect(select).toHaveValue('hot');
    await userEvent.setup().selectOptions(select, 'count');
    expect(onSort).toHaveBeenCalledWith('count');
  });

  it('adds no header for an extra sort in the table', () => {
    mockMedia();
    renderTable({
      columns: cardColumns,
      sort: { key: 'hot', dir: 'desc', onSort: () => undefined, extra: [{ key: 'hot', label: 'FIXTURE hot first' }] },
    });
    expect(headers()).toEqual(['Name', 'Count']);
    for (const header of screen.getAllByRole('columnheader')) expect(header).toHaveAttribute('aria-sort', 'none');
  });
});
