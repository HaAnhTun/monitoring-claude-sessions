import type { SessionSummary } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MQ_NARROW_TABLE, MQ_SHEET } from '../../state/use-media-query.ts';
import { makeSession, makeState, makeUsage, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { DEFAULT_SESSION_COLUMNS, SessionTable, type SessionTableProps } from './SessionTable.tsx';

/** `window.matchMedia` where the listed queries match (the table asks for the narrow and the sheet breakpoints). */
function mockMedia(...matching: string[]): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: matching.includes(query),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function row(n: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return makeSession({ id: sessionId(n), seq: n, label: `FIXTURE session ${String(n)}`, ...overrides });
}

const SORT: SessionTableProps['sort'] = { key: 'lastActivity', dir: 'desc' };

function renderTable(props: Partial<SessionTableProps> = {}, locale: 'en' | 'vi' = 'en') {
  const onSort = vi.fn();
  const rows = props.rows ?? [row(1), row(2)];
  const rendered = renderWithIntl(<SessionTable rows={rows} sort={SORT} onSort={onSort} {...props} />, { locale });
  return { ...rendered, onSort };
}

const headerTexts = (): (string | null)[] => screen.getAllByRole('columnheader').map((h) => h.textContent);

describe('SessionTable: columns', () => {
  it('draws the default columns of ADR 0073: State, Session, Last activity, Errors, Output, Input', () => {
    mockMedia();
    renderTable();
    expect(headerTexts()).toEqual(
      [
        'sessions.col.state',
        'sessions.col.session',
        'sessions.col.lastActivity',
        'sessions.col.errors',
        'sessions.col.output',
        'sessions.col.input',
      ].map((key) => msg(key as 'sessions.col.state')),
    );
    expect(DEFAULT_SESSION_COLUMNS).toEqual(['state', 'label', 'lastActivity', 'errors', 'output', 'input']);
  });

  it('draws the columns that were chosen, in the order of the table', () => {
    mockMedia();
    renderTable({
      columns: ['input', 'label', 'started', 'project', 'tokenDetail'],
      rows: [row(1, { projectLabel: 'FIXTURE proj' })],
    });
    expect(headerTexts()).toEqual([
      msg('sessions.col.session'),
      msg('sessions.col.project'),
      msg('sessions.col.started'),
      msg('sessions.col.input'),
      msg('sessions.col.tokenDetail'),
    ]);
  });

  it('ignores a column id it does not know', () => {
    mockMedia();
    renderTable({ columns: ['label', 'nope'] });
    expect(headerTexts()).toEqual([msg('sessions.col.session')]);
  });

  it('renames Duration to Active span and explains it in the tooltip of the header', () => {
    mockMedia();
    renderTable({ columns: ['label', 'duration'] });
    const header = screen.getByRole('columnheader', { name: msg('sessions.col.activeSpan') });
    expect(header).toHaveAttribute('title', msg('sessions.col.activeSpan.tip'));
    expect(within(screen.getAllByRole('row')[1]!).getByText('59m 30s')).toBeInTheDocument();
  });

  it('hides Model, Started and Active span below 1280 px (ADR 0073 decision 7)', () => {
    mockMedia(MQ_NARROW_TABLE);
    renderTable({ columns: ['label', 'models', 'started', 'duration', 'lastActivity'] });
    expect(headerTexts()).toEqual([msg('sessions.col.session'), msg('sessions.col.lastActivity')]);
  });
});

describe('SessionTable: columns that hide themselves', () => {
  it('hides Project / task when no session has a project or a task', () => {
    mockMedia();
    renderTable({
      columns: ['label', 'project'],
      rows: [row(1, { projectLabel: null, workItemIds: [] }), row(2, { projectLabel: null, workItemIds: [] })],
    });
    expect(headerTexts()).toEqual([msg('sessions.col.session')]);
  });

  it('shows Project / task, with the task, as soon as one session has a project', () => {
    mockMedia();
    renderTable({
      columns: ['label', 'project'],
      rows: [row(1, { projectLabel: 'FIXTURE proj', workItemIds: [7] }), row(2, { projectLabel: null })],
    });
    expect(headerTexts()).toContain(msg('sessions.col.project'));
    expect(screen.getByText('FIXTURE proj')).toBeInTheDocument();
    expect(screen.getByText(msg('sessions.session.task', { id: 7 }), { exact: false })).toBeInTheDocument();
  });

  it('hides Model when every session uses the same one, and shows it when they differ', () => {
    mockMedia();
    const same = [row(1, { models: ['fixture-model'] }), row(2, { models: ['fixture-model'] })];
    const { unmount } = renderTable({ columns: ['label', 'models'], rows: same });
    expect(headerTexts()).toEqual([msg('sessions.col.session')]);
    unmount();
    renderTable({
      columns: ['label', 'models'],
      rows: [row(1, { models: ['fixture-model-a'] }), row(2, { models: ['fixture-model-b'] })],
    });
    expect(headerTexts()).toEqual([msg('sessions.col.session'), msg('sessions.col.model')]);
  });

  it('hides Freshness when every session has the same sources', () => {
    mockMedia();
    renderTable({ columns: ['label', 'freshness'] });
    expect(headerTexts()).toEqual([msg('sessions.col.session')]);
  });

  it('shows Freshness with its tags when the sessions differ', () => {
    mockMedia();
    renderTable({
      columns: ['label', 'freshness'],
      rows: [row(1, { sources: { hooks: true, transcript: true } }), row(2, { partial: true })],
    });
    expect(headerTexts()).toContain(msg('sessions.col.freshness'));
    expect(screen.getByText(msg('sessions.tag.hooks'))).toBeInTheDocument();
    expect(screen.getAllByText(msg('sessions.tag.transcript'))).toHaveLength(2);
    expect(screen.getByText(msg('sessions.tag.partial'))).toBeInTheDocument();
  });
});

describe('SessionTable: the Session cell', () => {
  it('puts the model under the label when the sessions differ in it and the Model column is not drawn', () => {
    mockMedia();
    renderTable({ rows: [row(1, { models: ['fixture-model-a'] }), row(2, { models: ['fixture-model-b'] })] });
    expect(screen.getByText('fixture-model-a')).toBeInTheDocument();
    expect(screen.getByText('fixture-model-b')).toBeInTheDocument();
  });

  it('draws no model line when every session uses the same model', () => {
    mockMedia();
    renderTable();
    expect(screen.queryByText('fixture-model')).toBeNull();
  });

  it('draws no model line when the Model column shows it', () => {
    mockMedia();
    renderTable({
      columns: ['label', 'models'],
      rows: [row(1, { models: ['fixture-model-a'] }), row(2, { models: ['fixture-model-b'] })],
    });
    expect(screen.getAllByText('fixture-model-a')).toHaveLength(1);
  });

  it('links the cell to the session', () => {
    mockMedia();
    renderTable();
    expect(screen.getByRole('link', { name: /FIXTURE session 1/ })).toHaveAttribute(
      'href',
      `/sessions/${sessionId(1)}`,
    );
  });
});

describe('SessionTable: errors', () => {
  it('leaves the cell empty without errors and draws a chip with the count with them', () => {
    mockMedia();
    renderTable({ rows: [row(1), row(2, { errorCount: 3 })] });
    const [first, second] = screen.getAllByRole('row').slice(1);
    expect(first!.querySelector('.session-errors')).toBeNull();
    expect(first).not.toHaveTextContent(/none/i);
    expect(within(second!).getByText(msg('sessions.errors.count', { count: 3 }))).toBeInTheDocument();
  });

  it('says a single error in the singular', () => {
    mockMedia();
    renderTable({ rows: [row(1, { errorCount: 1 })] });
    expect(screen.getByText(msg('sessions.errors.count', { count: 1 }))).toBeInTheDocument();
  });

  it('shows warnings, muted, next to the errors', () => {
    mockMedia();
    renderTable({ rows: [row(1, { errorCount: 1, warningCount: 2 })] });
    expect(screen.getByText(msg('sessions.errors.warnings', { count: 2 }))).toBeInTheDocument();
  });

  it('marks the rows with errors with the class of the left bar, and only them', () => {
    mockMedia();
    renderTable({ rows: [row(1), row(2, { errorCount: 1 }), row(3, { warningCount: 1 })] });
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((r) => r.classList.contains('session-row--error'))).toEqual([false, true, false]);
  });

  it('sorts by Errors: the header is a button that asks for the errors sort', async () => {
    mockMedia();
    const { onSort } = renderTable({ sort: { key: 'errors', dir: 'desc' } });
    expect(screen.getByRole('columnheader', { name: msg('sessions.col.errors') })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await userEvent.setup().click(screen.getByRole('button', { name: msg('sessions.col.errors') }));
    expect(onSort).toHaveBeenCalledWith('errors');
  });
});

describe('SessionTable: figures', () => {
  it('right-aligns Output and Input as numbers and never shows a missing figure as 0', () => {
    mockMedia();
    renderTable({
      rows: [
        row(1, { usageInclSubagents: makeUsage({ output: 1500, input: 12_000, cacheCreation: 1000 }) }),
        row(2, {
          usageInclSubagents: makeUsage({
            input: null,
            output: null,
            cacheCreation: null,
            cacheRead: null,
            total: null,
            completeness: 'unavailable',
            scannedPct: null,
          }),
        }),
      ],
    });
    const headers = screen.getAllByRole('columnheader');
    const output = headers.find((h) => h.textContent === msg('sessions.col.output'))!;
    const input = headers.find((h) => h.textContent === msg('sessions.col.input'))!;
    for (const header of [output, input]) {
      expect(header).toHaveClass('is-num');
      expect(header).toHaveClass('is-end');
    }
    const [first, second] = screen.getAllByRole('row').slice(1);
    expect(within(first!).getByText('1.5K')).toBeInTheDocument();
    expect(within(first!).getByText('13K')).toBeInTheDocument();
    expect(second).not.toHaveTextContent(/\b0\b/);
    expect(within(second!).getAllByText(msg('tokens.notAvailable'))).not.toHaveLength(0);
  });

  it('sorts the Output header by tokens', async () => {
    mockMedia();
    const { onSort } = renderTable();
    await userEvent.setup().click(screen.getByRole('button', { name: msg('sessions.col.output') }));
    expect(onSort).toHaveBeenCalledWith('tokens');
  });

  it('reads Vietnamese headers when the language is Vietnamese', () => {
    mockMedia();
    renderTable({}, 'vi');
    expect(headerTexts()[0]).toBe(msg('sessions.col.state', undefined, 'vi'));
    expect(headerTexts()).toContain(msg('sessions.col.output', undefined, 'vi'));
  });
});

describe('SessionTable: sorting', () => {
  it('shows the sorted column and none when the order is "Attention first"', () => {
    mockMedia();
    const { unmount } = renderTable({ sort: { key: 'lastActivity', dir: 'asc' } });
    expect(screen.getByRole('columnheader', { name: msg('sessions.col.lastActivity') })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    unmount();
    renderTable({ sort: { key: 'attention', dir: 'desc' } });
    for (const header of screen.getAllByRole('columnheader')) {
      if (header.querySelector('button') !== null) expect(header).toHaveAttribute('aria-sort', 'none');
    }
  });

  it('passes a sort the page knows and drops one it does not', async () => {
    mockMedia();
    const { onSort } = renderTable();
    await userEvent.setup().click(screen.getByRole('button', { name: msg('sessions.col.session') }));
    expect(onSort).toHaveBeenCalledWith('label');
  });
});

describe('SessionTable: the card layout below 900 px', () => {
  it('is a list of cards, not a table, with one link each', () => {
    mockMedia(MQ_SHEET);
    renderTable({ rows: [row(1, { label: 'FIXTURE card one' }), row(2, { label: 'FIXTURE card two' })] });
    expect(screen.queryByRole('table')).toBeNull();
    const list = screen.getByRole('list', { name: msg('sessions.table.caption') });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByRole('link', { name: /FIXTURE card one/ })).toHaveAttribute(
      'href',
      `/sessions/${sessionId(1)}`,
    );
  });

  it('puts the state, the time, the errors and the figures on the card', () => {
    mockMedia(MQ_SHEET);
    renderTable({
      rows: [
        row(1, {
          state: makeState('waiting_input'),
          errorCount: 2,
          usageInclSubagents: makeUsage({ output: 1500, input: 12_000, cacheCreation: 1000 }),
        }),
      ],
    });
    const card = screen.getByRole('listitem');
    expect(within(card).getByText(msg('state.waiting_input.label'))).toBeInTheDocument();
    expect(within(card).getByText(msg('sessions.errors.count', { count: 2 }))).toBeInTheDocument();
    expect(within(card).getByText('1.5K')).toBeInTheDocument();
    expect(within(card).getByText('13K')).toBeInTheDocument();
    expect(card.querySelector('time')).not.toBeNull();
  });

  it('marks a card with errors, and offers "Attention first" in the sort list', () => {
    mockMedia(MQ_SHEET);
    renderTable({ rows: [row(1), row(2, { errorCount: 1 })], sort: { key: 'attention', dir: 'desc' } });
    const cards = screen.getAllByRole('listitem');
    expect(cards.map((card) => card.classList.contains('session-row--error'))).toEqual([false, true]);
    const select = screen.getByRole('combobox', { name: msg('lists.sortBy') });
    expect(select).toHaveValue('attention');
    expect(within(select).getByRole('option', { name: msg('sessions.sort.attention') })).toBeInTheDocument();
  });

  it('says an inferred state on the card, with its evidence line', () => {
    mockMedia(MQ_SHEET);
    renderTable({
      rows: [row(1, { state: makeState('working', { basis: 'inferred', confidence: 'medium', rule: 'S-7e' }) })],
    });
    const card = screen.getByRole('listitem');
    expect(card.querySelector('.evidence-line')).not.toBeNull();
  });
});
