import type { SessionSummary } from '@mcs/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { iso, makeSession, makeState, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { ATTENTION_CAP, NeedsAttention, selectNeedsAttention } from './NeedsAttention.tsx';

function row(n: number, state: Parameters<typeof makeState>[0], over: Partial<SessionSummary> = {}): SessionSummary {
  return makeSession({
    id: sessionId(n),
    label: `FIXTURE session ${String(n)}`,
    lastActivityAt: iso(-n * 60),
    state: makeState(state),
    ...over,
  });
}

const quiet = (n: number): SessionSummary =>
  row(n, 'working', { state: makeState('working', { basis: 'inferred', confidence: 'medium', rule: 'S-7e' }) });

function titles(): string[] {
  const list = screen.getByRole('list', { name: msg('overview.attention.list') });
  return within(list)
    .getAllByRole('listitem')
    .map((item) => within(item).getAllByRole('link')[0]?.textContent ?? '');
}

describe('selectNeedsAttention', () => {
  it('takes the sessions with errors, waiting for input and quiet (inferred), and no others', () => {
    const rows = [
      row(1, 'working'),
      row(2, 'turn_ended'),
      row(3, 'completed'),
      row(4, 'working', { errorCount: 1 }),
      row(5, 'waiting_input'),
      quiet(6),
    ];
    const { items, total } = selectNeedsAttention(rows);
    expect(items.map((s) => s.label)).toEqual(['FIXTURE session 4', 'FIXTURE session 5', 'FIXTURE session 6']);
    expect(total).toBe(3);
  });

  it('puts errors first, then waiting for input, then quiet, and the newest activity first within a group', () => {
    const rows = [
      quiet(1),
      row(2, 'waiting_input'),
      row(3, 'turn_ended', { errorCount: 2 }),
      row(4, 'waiting_input'),
      row(5, 'failed', { errorCount: 1 }),
    ];
    const labels = selectNeedsAttention(rows).items.map((s) => s.label);
    expect(labels).toEqual([
      'FIXTURE session 3',
      'FIXTURE session 5',
      'FIXTURE session 2',
      'FIXTURE session 4',
      'FIXTURE session 1',
    ]);
  });

  it('keeps at most five and counts all of them', () => {
    const rows = Array.from({ length: 9 }, (_unused, i) => row(i + 1, 'waiting_input'));
    const { items, total } = selectNeedsAttention(rows);
    expect(items).toHaveLength(ATTENTION_CAP);
    expect(ATTENTION_CAP).toBe(5);
    expect(total).toBe(9);
  });
});

describe('the two halves of waiting_input (ADR 0107)', () => {
  const needs = row(1, 'waiting_input', {
    state: makeState('waiting_input', { rule: 'S-6a', waitReason: 'permission' }),
  });
  const ready = row(2, 'waiting_input', { state: makeState('waiting_input', { rule: 'S-8b', waitReason: 'user' }) });

  it('lists a session that needs the person and leaves out one that is ready for the next prompt', () => {
    expect(selectNeedsAttention([ready, needs])).toEqual({ items: [needs], total: 1 });
    // a ready session with an error is listed for its error
    const failing = { ...ready, errorCount: 1 };
    expect(selectNeedsAttention([failing]).items).toEqual([failing]);
  });

  it('draws the badge with the word "Needs you"', () => {
    renderWithIntl(<NeedsAttention sessions={[ready, needs]} complete />);
    expect(titles()).toEqual(['FIXTURE session 1']);
    expect(screen.getByText('Needs you')).toHaveClass('badge__word');
    expect(screen.queryByText(msg('state.waiting_input.label'))).toBeNull();
  });
});

describe('NeedsAttention', () => {
  it('lists the sessions as links to their detail page with a state badge', () => {
    renderWithIntl(
      <NeedsAttention sessions={[row(1, 'waiting_input'), row(2, 'turn_ended', { errorCount: 1 })]} complete />,
    );
    expect(screen.getByRole('heading', { level: 2, name: msg('overview.attention.title') })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'FIXTURE session 1' })).toHaveAttribute(
      'href',
      `/sessions/${sessionId(1)}`,
    );
    expect(screen.getAllByText(msg('state.waiting_input.label')).length).toBeGreaterThan(0);
    expect(titles()).toEqual(['FIXTURE session 2', 'FIXTURE session 1']);
  });

  it('links the error count to the errors tab of the session', () => {
    renderWithIntl(<NeedsAttention sessions={[row(2, 'turn_ended', { errorCount: 3 })]} complete />);
    const link = screen.getByRole('link', { name: msg('overview.attention.errors', { count: 3 }) });
    expect(link).toHaveAttribute('href', `/sessions/${sessionId(2)}?tab=errors`);
  });

  it('shows the evidence line of an inferred session and the question mark of its badge', () => {
    renderWithIntl(<NeedsAttention sessions={[quiet(1)]} complete />);
    expect(document.querySelector('.evidence-line[data-evidence="quiet"]')).not.toBeNull();
    expect(screen.getByText(msg('badge.inferredLabel', { label: msg('state.working.label') }))).toBeInTheDocument();
  });

  it('shows the first evidence text of the engine for a session that waits for input', () => {
    const waiting = row(1, 'waiting_input', {
      state: makeState('waiting_input', {
        basis: 'inferred',
        confidence: 'medium',
        evidence: [{ kind: 'hook:permission_request', at: iso(-60), text: 'FIXTURE waiting for permission (Edit)' }],
      }),
    });
    renderWithIntl(<NeedsAttention sessions={[waiting]} complete />);
    expect(screen.getByText('FIXTURE waiting for permission (Edit)')).toBeInTheDocument();
  });

  it('says how many more there are and links to the list in attention order', () => {
    const rows = Array.from({ length: 8 }, (_unused, i) => row(i + 1, 'waiting_input'));
    renderWithIntl(<NeedsAttention sessions={rows} complete />);
    expect(titles()).toHaveLength(5);
    expect(screen.getByText(msg('overview.shown', { shown: '5', total: '8' }))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('overview.attention.viewAll') })).toHaveAttribute(
      'href',
      '/sessions?sort=attention',
    );
  });

  it('says "at least" when more sessions are still on the server', () => {
    const rows = Array.from({ length: 7 }, (_unused, i) => row(i + 1, 'waiting_input'));
    renderWithIntl(<NeedsAttention sessions={rows} complete={false} />);
    expect(screen.getByText(msg('overview.shownAtLeast', { shown: '5', total: '7' }))).toBeInTheDocument();
  });

  it('offers no link when everything is shown', () => {
    renderWithIntl(<NeedsAttention sessions={[row(1, 'waiting_input')]} complete />);
    expect(screen.queryByRole('link', { name: msg('overview.attention.viewAll') })).toBeNull();
  });

  it('says that nothing needs attention', () => {
    renderWithIntl(<NeedsAttention sessions={[row(1, 'working'), row(2, 'completed')]} complete />);
    expect(screen.getByText(msg('overview.attention.empty'))).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: msg('overview.attention.list') })).toBeNull();
  });

  it('shows a loading placeholder, not the empty message, while the first page is on its way', () => {
    renderWithIntl(<NeedsAttention sessions={[]} complete={false} loading />);
    expect(screen.getByText(msg('overview.attention.loading'))).toBeInTheDocument();
    expect(screen.queryByText(msg('overview.attention.empty'))).toBeNull();
  });

  it('speaks Vietnamese', () => {
    renderWithIntl(<NeedsAttention sessions={[row(1, 'turn_ended', { errorCount: 2 })]} complete />, { locale: 'vi' });
    expect(screen.getByRole('heading', { name: msg('overview.attention.title', undefined, 'vi') })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: msg('overview.attention.errors', { count: 2 }, 'vi') }),
    ).toBeInTheDocument();
  });
});
