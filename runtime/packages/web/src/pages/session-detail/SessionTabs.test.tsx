import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { agentId } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { SessionTabs } from './SessionTabs.tsx';

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

function renderTabs(props: Partial<Parameters<typeof SessionTabs>[0]> = {}, route = '/sessions/abc') {
  return renderWithIntl(
    <>
      <button type="button">before</button>
      <SessionTabs active="transcript" agent="" {...props} />
      <button type="button">after</button>
      <Where />
    </>,
    { route },
  );
}

describe('SessionTabs', () => {
  it('is a navigation landmark named for the session views, with no tab roles', () => {
    renderTabs();
    const nav = screen.getByRole('navigation', { name: msg('detail.tabs.label') });
    expect(within(nav).getAllByRole('link')).toHaveLength(5);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('lists Transcript, Errors, Agents, Tokens and Events in that order', () => {
    renderTabs();
    const nav = screen.getByRole('navigation', { name: msg('detail.tabs.label') });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      msg('detail.tab.transcript'),
      msg('detail.tab.errors'),
      msg('detail.tab.agents'),
      msg('detail.tab.tokens'),
      msg('detail.tab.events'),
    ]);
  });

  it('marks only the chosen view with aria-current="page"', () => {
    renderTabs({ active: 'tokens' });
    const nav = screen.getByRole('navigation', { name: msg('detail.tabs.label') });
    const current = within(nav)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.textContent)).toEqual([msg('detail.tab.tokens')]);
  });

  it('links to the address of every view and keeps the chosen agent', () => {
    renderTabs({ active: 'transcript', agent: agentId(2) });
    expect(screen.getByRole('link', { name: msg('detail.tab.transcript') })).toHaveAttribute(
      'href',
      `/sessions/abc?agent=${agentId(2)}`,
    );
    expect(screen.getByRole('link', { name: msg('detail.tab.events') })).toHaveAttribute(
      'href',
      `/sessions/abc?tab=events&agent=${agentId(2)}`,
    );
    expect(screen.getByRole('link', { name: msg('detail.tab.errors') })).toHaveAttribute(
      'href',
      `/sessions/abc?tab=errors&agent=${agentId(2)}`,
    );
  });

  it('is five Tab stops and needs no arrow key', async () => {
    const user = userEvent.setup();
    renderTabs();
    await user.click(screen.getByRole('button', { name: 'before' }));
    const names = [
      msg('detail.tab.transcript'),
      msg('detail.tab.errors'),
      msg('detail.tab.agents'),
      msg('detail.tab.tokens'),
      msg('detail.tab.events'),
    ];
    for (const name of names) {
      await user.tab();
      expect(screen.getByRole('link', { name })).toHaveFocus();
    }
    await user.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
    // an arrow key does not move between the views
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('link', { name: msg('detail.tab.transcript') })).toHaveFocus();
  });

  it('shows a count on the Errors view that a screen reader hears in words', () => {
    renderTabs({ issueCount: 3 });
    const link = screen.getByRole('link', { name: new RegExp(msg('detail.tab.errors')) });
    expect(link).toHaveTextContent('3');
    expect(link).toHaveAccessibleName(`${msg('detail.tab.errors')} ${msg('detail.tab.issues', { count: 3 })}`);
    expect(screen.getByRole('link', { name: msg('detail.tab.agents') })).not.toHaveTextContent('3');
  });

  it('shows no count without errors or warnings', () => {
    renderTabs({ issueCount: 0 });
    expect(screen.getByRole('link', { name: msg('detail.tab.errors') })).toHaveAccessibleName(msg('detail.tab.errors'));
  });

  it('adds a history entry when a view is chosen', async () => {
    renderTabs({ active: 'transcript' });
    await userEvent.click(screen.getByRole('link', { name: msg('detail.tab.agents') }));
    expect(screen.getByTestId('where')).toHaveTextContent('/sessions/abc?tab=agents');
  });

  it('is worded in Vietnamese', () => {
    renderWithIntl(<SessionTabs active="events" agent="" issueCount={2} />, { locale: 'vi' });
    expect(screen.getByRole('navigation', { name: msg('detail.tabs.label', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('detail.tab.transcript', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('detail.tab.events', undefined, 'vi') })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
