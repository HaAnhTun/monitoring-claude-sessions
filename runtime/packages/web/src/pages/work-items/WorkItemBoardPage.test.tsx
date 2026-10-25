import { BOARD_STATES, type BoardState } from '@mcs/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import { makeInstance, makeWorkItem, makeWorkItemBoard } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { WorkItemBoardPage } from './WorkItemBoardPage.tsx';

const INSTANCE = makeInstance();

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

const ITEMS = [
  makeWorkItem({ id: 1, key: 'backend', title: 'FIXTURE backend build', state: 'completed' }),
  makeWorkItem({ id: 2, key: 'review', title: 'FIXTURE release review', state: 'working' }),
  makeWorkItem({ id: 3, key: 'deploy', title: 'FIXTURE deploy to staging', state: 'failed' }),
  makeWorkItem({ id: 4, key: 'docs', title: 'FIXTURE write the docs', state: 'working' }),
];

function renderBoard(handlers: FakeHandlers = {}, route = '/tasks', locale: 'en' | 'vi' = 'en') {
  const api: FakeApi = createFakeApi({
    instance: () => INSTANCE,
    workItemBoard: () => makeWorkItemBoard({ items: ITEMS, derivation: 'FIXTURE derivation rules' }),
    ...handlers,
  });
  const wrap = (children: ReactNode): ReactNode => (
    <ShortcutRegistryProvider>
      <Where />
      {children}
    </ShortcutRegistryProvider>
  );
  return { ...renderWithIntl(<WorkItemBoardPage />, { api, instance: INSTANCE, route, wrap, locale }), api };
}

function columnOf(state: BoardState): HTMLElement {
  const found = document.querySelector<HTMLElement>(`.board__col[data-state="${state}"]`);
  if (found === null) throw new Error(`no column ${state}`);
  return found;
}

describe('WorkItemBoardPage', () => {
  it('renders one h1 and the six columns in the fixed order, each a region with its count', async () => {
    renderBoard();
    expect(screen.getByRole('heading', { level: 1, name: msg('route.tasks.title') })).toBeInTheDocument();
    await screen.findByRole('article', { name: 'FIXTURE backend build' });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual([
      msg('state.working.label'),
      msg('state.board.waiting'),
      msg('state.completed.label'),
      msg('state.failed.label'),
      msg('tasks.column.stale'),
      msg('state.unknown.label'),
    ]);
    expect(BOARD_STATES).toHaveLength(6);
    expect(screen.getAllByRole('region')).toHaveLength(6);
    expect(within(columnOf('working')).getByText(msg('tasks.column.count', { count: 2 }))).toBeInTheDocument();
    expect(within(columnOf('waiting')).getByText(msg('tasks.column.empty'))).toBeInTheDocument();
  });

  it('puts each card in the column of its state', async () => {
    renderBoard();
    await screen.findByRole('article', { name: 'FIXTURE backend build' });
    expect(within(columnOf('completed')).getByRole('article', { name: 'FIXTURE backend build' })).toBeInTheDocument();
    expect(
      within(columnOf('working'))
        .getAllByRole('article')
        .map((card) => card.getAttribute('aria-labelledby')),
    ).toHaveLength(2);
    expect(within(columnOf('failed')).getByRole('article', { name: 'FIXTURE deploy to staging' })).toBeInTheDocument();
  });

  it('is read-only: no card or column can be dragged', async () => {
    const { container } = renderBoard();
    await screen.findByRole('article', { name: 'FIXTURE backend build' });
    expect(container.querySelector('[draggable]')).toBeNull();
    expect(container.querySelector('[aria-grabbed]')).toBeNull();
  });

  it('shows six column skeletons and a status while loading', () => {
    const { container } = renderBoard({ workItemBoard: () => new Promise(() => undefined) });
    expect(screen.getByText(msg('tasks.loading'))).toBeInTheDocument();
    expect(container.querySelectorAll('.board--loading .board__col')).toHaveLength(6);
  });

  it('explains how to declare tasks, naming board.items, when the board is empty', async () => {
    renderBoard({ workItemBoard: () => makeWorkItemBoard({ items: [], derivation: 'FIXTURE derivation rules' }) });
    expect(await screen.findByText(msg('tasks.empty.title'))).toBeInTheDocument();
    expect(screen.getByText(msg('tasks.empty.declare', { key: 'board.items' }))).toBeInTheDocument();
    expect(screen.getByText(/"items"/)).toBeInTheDocument();
    expect(screen.getByText('FIXTURE derivation rules')).not.toBeVisible();
    expect(screen.getByRole('button', { name: msg('tasks.derivation.toggle') })).toBeInTheDocument();
    expect(screen.queryAllByRole('region')).toHaveLength(0);
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('notes a truncated board', async () => {
    renderBoard({ workItemBoard: () => makeWorkItemBoard({ items: ITEMS, truncated: true }) });
    expect(await screen.findByText(msg('tasks.truncated', { count: 4 }))).toBeInTheDocument();
  });

  it('has no truncation note for a complete board', async () => {
    renderBoard();
    await screen.findByRole('article', { name: 'FIXTURE backend build' });
    expect(screen.queryByText(msg('tasks.truncated', { count: 4 }))).toBeNull();
  });

  it('keeps the derivation rules behind a disclosure', async () => {
    const user = userEvent.setup();
    renderBoard();
    const toggle = await screen.findByRole('button', { name: msg('tasks.derivation.toggle') });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByText('FIXTURE derivation rules')).toBeVisible();
  });

  it('filters by state from the address', async () => {
    renderBoard({}, '/tasks?state=working');
    await screen.findByRole('article', { name: 'FIXTURE release review' });
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(within(columnOf('completed')).queryByRole('article')).toBeNull();
  });

  it('filters by text and keeps the filter in the address', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole('article', { name: 'FIXTURE backend build' });
    await user.type(screen.getByRole('textbox', { name: msg('tasks.filter.search') }), 'staging');
    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(1);
    });
    expect(screen.getByTestId('where')).toHaveTextContent('/tasks?q=staging');
  });

  it('says that no task matches the filters and offers to clear them', async () => {
    const user = userEvent.setup();
    renderBoard({}, '/tasks?q=nothing-like-this');
    expect(await screen.findByText(msg('tasks.filtered.title'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('tasks.filtered.clear') }));
    expect(await screen.findAllByRole('article')).toHaveLength(4);
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/tasks$/);
  });

  it('shows an error state with a retry when the board cannot be loaded', async () => {
    renderBoard({ workItemBoard: () => errorResponse('internal_error') });
    expect(await screen.findByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
    expect(screen.queryAllByRole('region')).toHaveLength(0);
  });

  it('is drawn in Vietnamese', async () => {
    renderBoard({}, '/tasks', 'vi');
    await screen.findByRole('article', { name: 'FIXTURE backend build' });
    expect(
      screen.getByRole('heading', { level: 1, name: msg('route.tasks.title', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: msg('tasks.column.stale', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: msg('tasks.board', undefined, 'vi') })).toBeInTheDocument();
  });

  it('shows only the heading until the app providers are mounted', () => {
    renderWithIntl(<WorkItemBoardPage />, { instanceId: null });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
