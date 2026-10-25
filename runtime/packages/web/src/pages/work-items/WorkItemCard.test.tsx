import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { makeUsage, makeWorkItem, sessionId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { WorkItemCard } from './WorkItemCard.tsx';

const ITEM = makeWorkItem({
  id: 7,
  title: 'FIXTURE Release review',
  source: 'attempts',
  rule: 'W-ATT',
  state: 'waiting',
  boardReason: 'FIXTURE two of three sessions wait for input',
  evidence: [
    { kind: 'session:state', at: '2026-10-12T11:00:00.000Z', text: 'FIXTURE first: waiting_input (S-6a)' },
    { kind: 'session:state', at: null, text: 'FIXTURE second: working (S-7b)' },
  ],
  sessionIds: [1, 2, 3].map(sessionId),
  sessionCount: 3,
  usage: makeUsage({ output: 1500, input: 100, cacheCreation: 20, cacheRead: 40_000 }),
});

describe('WorkItemCard', () => {
  it('is an article named by the title, with the state as a dot and a word', () => {
    renderWithIntl(<WorkItemCard item={ITEM} />);
    const card = screen.getByRole('article', { name: 'FIXTURE Release review' });
    expect(within(card).getByText(msg('state.board.waiting'))).toBeInTheDocument();
    expect(card).toHaveAttribute('data-state', 'waiting');
  });

  it('names the source and puts the rule id in its tooltip', () => {
    renderWithIntl(<WorkItemCard item={ITEM} />);
    const tag = screen.getByText(msg('tasks.source.attempts')).closest('.badge');
    expect(tag).toHaveAttribute('title', msg('tasks.rule.attempts'));
    expect(screen.getByText('W-ATT')).toBeInTheDocument();
  });

  it('gives the reason of the board and keeps the evidence behind a disclosure', async () => {
    const user = userEvent.setup();
    renderWithIntl(<WorkItemCard item={ITEM} />);
    expect(screen.getByText('FIXTURE two of three sessions wait for input')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: msg('tasks.card.evidence', { count: 2 }) });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const list = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(list).toHaveAttribute('hidden');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const items = within(
      screen.getByRole('list', { name: msg('tasks.card.evidenceFor', { title: ITEM.title }) }),
    ).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('FIXTURE first: waiting_input (S-6a)');
  });

  it('marks server text as English in another language', () => {
    renderWithIntl(<WorkItemCard item={ITEM} />, { locale: 'vi' });
    expect(screen.getByText('FIXTURE two of three sessions wait for input')).toHaveAttribute('lang', 'en');
    expect(screen.getByText(msg('tasks.card.why', undefined, 'vi'))).toBeInTheDocument();
  });

  it('has no evidence disclosure when the item has no evidence', () => {
    renderWithIntl(<WorkItemCard item={makeWorkItem({ evidence: [] })} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('links the first five sessions and then one "+N" link to the sessions of the task', () => {
    const many = makeWorkItem({ id: 9, sessionIds: [1, 2, 3, 4, 5, 6, 7].map(sessionId), sessionCount: 12 });
    renderWithIntl(<WorkItemCard item={many} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(6);
    expect(links[0]).toHaveAttribute('href', `/sessions/${sessionId(1)}`);
    expect(links[0]).toHaveTextContent(sessionId(1).slice(0, 8));
    expect(links[0]).toHaveAccessibleName(msg('tasks.card.openSession', { id: sessionId(1).slice(0, 8) }));
    expect(links[5]).toHaveTextContent('+7');
    expect(links[5]).toHaveAttribute('href', '/sessions?task=9');
    expect(links[5]).toHaveAccessibleName(msg('tasks.card.allSessions', { count: 12 }));
  });

  it('has no "+N" link when all the sessions are shown, and says so for a task without sessions', () => {
    const { unmount } = renderWithIntl(<WorkItemCard item={ITEM} />);
    expect(screen.getAllByRole('link')).toHaveLength(3);
    unmount();
    renderWithIntl(<WorkItemCard item={makeWorkItem({ sessionIds: [], sessionCount: 0 })} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(msg('tasks.card.sessions', { count: 0 }))).toBeInTheDocument();
  });

  it('shows since and last activity as times, and a dash when there was no activity', () => {
    renderWithIntl(<WorkItemCard item={makeWorkItem({ lastActivityAt: null })} />);
    expect(screen.getByText(msg('tasks.card.since'))).toBeInTheDocument();
    const last = screen.getByText(msg('tasks.card.lastActivity')).nextElementSibling;
    expect(last).toHaveTextContent('-');
  });

  it('shows the three token figures, and "not available" without usage', () => {
    const { unmount } = renderWithIntl(<WorkItemCard item={ITEM} />);
    expect(screen.getByText(msg('tokens.output'))).toBeInTheDocument();
    expect(screen.getByText('1.5K')).toBeInTheDocument();
    unmount();
    renderWithIntl(<WorkItemCard item={makeWorkItem({ usage: null })} />);
    expect(screen.getAllByText(msg('tokens.notAvailable')).length).toBeGreaterThan(0);
  });
});
