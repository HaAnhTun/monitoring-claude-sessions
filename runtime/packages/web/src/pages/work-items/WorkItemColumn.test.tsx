import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeWorkItem } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { WorkItemColumn } from './WorkItemColumn.tsx';

describe('WorkItemColumn', () => {
  it('is a region named by its heading, with the count and one card per item', () => {
    const items = [
      makeWorkItem({ id: 1, title: 'FIXTURE one', state: 'working' }),
      makeWorkItem({ id: 2, title: 'FIXTURE two', state: 'working' }),
    ];
    renderWithIntl(<WorkItemColumn state="working" items={items} />);
    const column = screen.getByRole('region', { name: msg('state.working.label') });
    expect(within(column).getByRole('heading', { level: 2 })).toHaveTextContent(msg('state.working.label'));
    expect(within(column).getByText(msg('tasks.column.count', { count: 2 }))).toBeInTheDocument();
    expect(within(column).getAllByRole('article')).toHaveLength(2);
  });

  it('says so when it has no item', () => {
    renderWithIntl(<WorkItemColumn state="failed" items={[]} />);
    const column = screen.getByRole('region', { name: msg('state.failed.label') });
    expect(column).toHaveAttribute('data-empty', 'true');
    expect(within(column).getByText(msg('tasks.column.empty'))).toBeInTheDocument();
    expect(within(column).getByText(msg('tasks.column.count', { count: 0 }))).toBeInTheDocument();
    expect(within(column).queryByRole('article')).toBeNull();
  });

  it('uses the long name of the stale column, and "Waiting" for the waiting one', () => {
    const { unmount } = renderWithIntl(<WorkItemColumn state="stale" items={[]} />);
    expect(screen.getByRole('region', { name: msg('tasks.column.stale') })).toBeInTheDocument();
    unmount();
    renderWithIntl(<WorkItemColumn state="waiting" items={[]} />);
    expect(screen.getByRole('region', { name: msg('state.board.waiting') })).toBeInTheDocument();
  });

  it('counts in Vietnamese', () => {
    renderWithIntl(<WorkItemColumn state="unknown" items={[makeWorkItem({ state: 'unknown' })]} />, { locale: 'vi' });
    expect(screen.getByText(msg('tasks.column.count', { count: 1 }, 'vi'))).toBeInTheDocument();
  });

  it('is read-only: nothing can be dragged', () => {
    const { container } = renderWithIntl(<WorkItemColumn state="working" items={[makeWorkItem()]} />);
    expect(container.querySelector('[draggable]')).toBeNull();
  });
});
