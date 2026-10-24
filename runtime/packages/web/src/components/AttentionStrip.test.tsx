import type { SessionSummary } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { iso, makeMetric, makeOverview, makeSession, makeState } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { AttentionStrip, type AttentionStripProps } from './AttentionStrip.tsx';

function row(n: number, state: Parameters<typeof makeState>[0], over: Partial<SessionSummary> = {}): SessionSummary {
  return makeSession({ label: `FIXTURE ${String(n)}`, lastActivityAt: iso(-n), state: makeState(state), ...over });
}

const quiet = (n: number): SessionSummary =>
  row(n, 'working', { state: makeState('working', { basis: 'inferred', confidence: 'medium' }) });

const ROWS: SessionSummary[] = [
  row(1, 'working'),
  quiet(2),
  quiet(3),
  row(4, 'turn_ended', { errorCount: 1 }),
  row(5, 'waiting_input'),
  row(6, 'completed'),
];

function renderStrip(props: Partial<AttentionStripProps> = {}, locale: 'en' | 'vi' = 'en') {
  const all: AttentionStripProps = {
    overview: null,
    loadedRows: ROWS,
    complete: true,
    filter: null,
    onFilter: vi.fn(),
    ...props,
  };
  return { props: all, ...renderWithIntl(<AttentionStrip {...all} />, { locale }) };
}

function tile(name: 'working' | 'quiet' | 'errors' | 'waiting', locale: 'en' | 'vi' = 'en'): HTMLElement {
  return screen.getByRole('button', {
    name: new RegExp(msg(`attention.${name}`, undefined, locale).replace(/[()]/g, '\\$&')),
  });
}

describe('AttentionStrip', () => {
  it('has the four tiles in order, in a list named "Needs attention"', () => {
    renderStrip();
    const list = screen.getByRole('list', { name: msg('attention.label') });
    const labels = within(list)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain(msg('attention.working'));
    expect(labels[1]).toContain(msg('attention.quiet'));
    expect(labels[2]).toContain(msg('attention.errors'));
    expect(labels[3]).toContain(msg('attention.waiting'));
  });

  it('counts the loaded rows when the whole list is loaded: exact figures, no plus sign', () => {
    renderStrip();
    expect(tile('working')).toHaveTextContent(/^3/);
    expect(tile('quiet')).toHaveTextContent(/^2/);
    expect(tile('errors')).toHaveTextContent(/^1/);
    expect(tile('waiting')).toHaveTextContent(/^1/);
    expect(screen.queryByText(/\d\+/)).toBeNull();
  });

  it('equals the number of rows that the list shows for each tile', () => {
    renderStrip();
    const shown = {
      working: ROWS.filter((r) => ['working', 'running', 'waiting_tool', 'waiting_agent'].includes(r.state.state))
        .length,
      errors: ROWS.filter((r) => r.errorCount > 0).length,
    };
    expect(tile('working')).toHaveTextContent(new RegExp(`^${String(shown.working)}`));
    expect(tile('errors')).toHaveTextContent(new RegExp(`^${String(shown.errors)}`));
  });

  it('prefers the server metric of a tile over the loaded rows', () => {
    const overview = makeOverview({
      metrics: [
        makeMetric({ key: 'sessions.active', value: 41 }),
        makeMetric({ key: 'sessions.waiting_input', value: 9 }),
      ],
    });
    renderStrip({ overview });
    expect(tile('working')).toHaveTextContent(/^41/);
    expect(tile('waiting')).toHaveTextContent(/^9/);
    expect(tile('quiet')).toHaveTextContent(/^2/);
    expect(tile('working')).toHaveAttribute('title', expect.stringContaining(msg('attention.source.server')));
  });

  it('shows N+ with the explanation when more pages exist, and keeps all four tiles', () => {
    renderStrip({ complete: false });
    expect(screen.getByRole('list', { name: msg('attention.label') })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(within(tile('errors')).getByText('1+')).toBeInTheDocument();
    expect(tile('errors')).toHaveAttribute(
      'title',
      expect.stringContaining(msg('attention.source.atLeast', { count: 1, loaded: 6 })),
    );
    expect(tile('quiet')).toHaveTextContent(/^2\+/);
  });

  it('shows dashes, not zeros, before any page is loaded', () => {
    renderStrip({ loadedRows: [], complete: false });
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button).toHaveTextContent('–');
      expect(button).not.toHaveTextContent(/^0/);
    }
  });

  it('shows exact zeros for an empty list that is complete', () => {
    renderStrip({ loadedRows: [], complete: true });
    for (const button of screen.getAllByRole('button')) expect(button).toHaveTextContent(/^0/);
  });

  it('presses the tile of the filter and reports a press, and a second press as null', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    const { rerender, props } = renderStrip({ onFilter });
    for (const name of ['working', 'quiet', 'errors', 'waiting'] as const) {
      expect(tile(name)).toHaveAttribute('aria-pressed', 'false');
    }
    await user.click(tile('errors'));
    expect(onFilter).toHaveBeenLastCalledWith('errors');
    rerender(<AttentionStrip {...props} onFilter={onFilter} filter="errors" />);
    expect(tile('errors')).toHaveAttribute('aria-pressed', 'true');
    expect(tile('working')).toHaveAttribute('aria-pressed', 'false');
    await user.click(tile('errors'));
    expect(onFilter).toHaveBeenLastCalledWith(null);
    await user.click(tile('quiet'));
    expect(onFilter).toHaveBeenLastCalledWith('quiet');
  });

  it('describes each tile in its title', () => {
    renderStrip();
    expect(tile('quiet')).toHaveAttribute('title', expect.stringContaining(msg('attention.quiet.tip')));
    expect(tile('working')).toHaveAttribute(
      'title',
      expect.stringContaining(msg('attention.source.loaded', { loaded: 6 })),
    );
  });

  it('speaks Vietnamese and formats the figures for it', () => {
    const many = Array.from({ length: 1200 }, (_unused, i) => row(i, 'working'));
    renderStrip({ loadedRows: many }, 'vi');
    expect(screen.getByRole('list', { name: msg('attention.label', undefined, 'vi') })).toBeInTheDocument();
    expect(tile('working', 'vi')).toHaveTextContent(/^1\.200/);
    expect(msg('attention.working', undefined, 'vi')).not.toBe(msg('attention.working'));
  });
});
