import type { SessionSummary } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { iso, makeSession, makeState, makeUsage, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { RUNNING_CAP, RunningSessions, selectRunning } from './RunningSessions.tsx';

function row(n: number, state: Parameters<typeof makeState>[0], over: Partial<SessionSummary> = {}): SessionSummary {
  return makeSession({
    id: sessionId(n),
    label: `FIXTURE session ${String(n)}`,
    lastActivityAt: iso(-n * 60),
    state: makeState(state),
    ...over,
  });
}

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole('table', { name: msg('overview.running.caption') });
  return within(table).getAllByRole('row').slice(1);
}

describe('selectRunning', () => {
  it('takes the active states only, the newest activity first', () => {
    const rows = [
      row(3, 'working'),
      row(1, 'waiting_tool'),
      row(2, 'completed'),
      row(4, 'turn_ended'),
      row(5, 'running'),
      row(6, 'waiting_agent'),
      row(7, 'waiting_input'),
    ];
    const { items, total } = selectRunning(rows);
    expect(items.map((s) => s.label)).toEqual([
      'FIXTURE session 1',
      'FIXTURE session 3',
      'FIXTURE session 5',
      'FIXTURE session 6',
    ]);
    expect(total).toBe(4);
  });

  it('keeps at most eight and counts all of them', () => {
    const rows = Array.from({ length: 12 }, (_unused, i) => row(i + 1, 'working'));
    const { items, total } = selectRunning(rows);
    expect(items).toHaveLength(RUNNING_CAP);
    expect(total).toBe(12);
  });
});

describe('RunningSessions', () => {
  it('draws a table with the session as a link, its state, its last activity and its tokens', () => {
    const session = row(1, 'working', {
      usageInclSubagents: makeUsage({ output: 12_345, input: 2000, cacheCreation: 500 }),
    });
    renderWithIntl(<RunningSessions sessions={[session]} complete />);
    expect(screen.getByRole('heading', { level: 2, name: msg('overview.running.title') })).toBeInTheDocument();
    const [first] = bodyRows();
    if (first === undefined) throw new Error('no row');
    expect(within(first).getByRole('link', { name: 'FIXTURE session 1' })).toHaveAttribute(
      'href',
      `/sessions/${sessionId(1)}`,
    );
    expect(within(first).getByText(msg('state.working.label'))).toBeInTheDocument();
    expect(within(first).getByText('12K')).toHaveAttribute('title', '12,345');
    expect(within(first).getByText('2.5K')).toHaveAttribute(
      'title',
      msg('tokens.inputNewTip', { input: '2,000', cacheWrite: '500', sum: '2,500' }),
    );
    expect(within(first).getByRole('time')).toBeInTheDocument();
  });

  it('names the columns with the words of the Sessions list', () => {
    renderWithIntl(<RunningSessions sessions={[row(1, 'working')]} complete />);
    for (const key of [
      'sessions.col.session',
      'sessions.col.state',
      'sessions.col.lastActivity',
      'sessions.col.output',
      'sessions.col.input',
    ] as const) {
      expect(screen.getByRole('columnheader', { name: msg(key) })).toBeInTheDocument();
    }
  });

  it('shows "not available" for tokens the monitor does not have, never a zero', () => {
    const session = row(1, 'working', { usageInclSubagents: makeUsage({ completeness: 'unavailable' }) });
    renderWithIntl(<RunningSessions sessions={[session]} complete />);
    const [first] = bodyRows();
    if (first === undefined) throw new Error('no row');
    expect(within(first).getAllByText(msg('tokens.notAvailable'))).toHaveLength(2);
    expect(within(first).queryByText('0')).toBeNull();
  });

  it('shows the question mark and the evidence line of a session that is only inferred to be running', () => {
    const inferred = row(1, 'working', {
      state: makeState('working', { basis: 'inferred', confidence: 'medium', rule: 'S-7e' }),
    });
    renderWithIntl(<RunningSessions sessions={[inferred]} complete />);
    expect(screen.getByText(msg('badge.inferredLabel', { label: msg('state.working.label') }))).toBeInTheDocument();
    expect(document.querySelector('.evidence-line[data-evidence="quiet"]')).not.toBeNull();
  });

  it('links to the active sessions when there are more than it shows', () => {
    const rows = Array.from({ length: 10 }, (_unused, i) => row(i + 1, 'working'));
    renderWithIntl(<RunningSessions sessions={rows} complete />);
    expect(bodyRows()).toHaveLength(8);
    expect(screen.getByText(msg('overview.shown', { shown: '8', total: '10' }))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('overview.running.viewAll') })).toHaveAttribute(
      'href',
      '/sessions?state=active',
    );
  });

  it('says "at least" when more sessions are still on the server', () => {
    const rows = Array.from({ length: 10 }, (_unused, i) => row(i + 1, 'working'));
    renderWithIntl(<RunningSessions sessions={rows} complete={false} />);
    expect(screen.getByText(msg('overview.shownAtLeast', { shown: '8', total: '10' }))).toBeInTheDocument();
  });

  it('says that no session is running', () => {
    renderWithIntl(<RunningSessions sessions={[row(1, 'completed')]} complete />);
    expect(screen.getByText(msg('overview.running.empty'))).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a loading placeholder while the first page is on its way', () => {
    renderWithIntl(<RunningSessions sessions={[]} complete={false} loading />);
    expect(screen.getByText(msg('overview.running.loading'))).toBeInTheDocument();
    expect(screen.queryByText(msg('overview.running.empty'))).toBeNull();
  });

  it('formats the figures for Vietnamese', () => {
    const session = row(1, 'working', { usageInclSubagents: makeUsage({ output: 12_345 }) });
    renderWithIntl(<RunningSessions sessions={[session]} complete />, { locale: 'vi' });
    expect(screen.getByText(/^12\s?N$/)).toHaveAttribute('title', '12.345');
    expect(screen.getByRole('columnheader', { name: msg('sessions.col.output', undefined, 'vi') })).toBeInTheDocument();
  });
});
