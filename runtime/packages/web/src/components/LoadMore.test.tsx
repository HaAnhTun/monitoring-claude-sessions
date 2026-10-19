import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { LoadMore, type LoadMoreProps } from './LoadMore.tsx';

const base: LoadMoreProps = {
  hasMore: true,
  loading: false,
  onLoad: () => undefined,
  shown: 100,
  total: 342,
  noun: 'sessions',
};

describe('LoadMore', () => {
  it('says how many rows are shown of how many, and offers the next page', () => {
    renderWithIntl(<LoadMore {...base} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('common.loadMore.showingOf', { shown: 100, total: 342, noun: 'sessions' }),
    );
    expect(screen.getByRole('button', { name: msg('common.loadMore.button', { count: 100 }) })).toBeInTheDocument();
  });

  it('shrinks the step to what is left', () => {
    renderWithIntl(<LoadMore {...base} shown={300} />);
    expect(screen.getByRole('button', { name: msg('common.loadMore.button', { count: 42 }) })).toBeInTheDocument();
  });

  it('uses the page size as the step when the total is not known or only a lower bound', () => {
    const { rerender } = renderWithIntl(<LoadMore {...base} total={null} pageSize={50} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('common.loadMore.showing', { shown: 100, noun: 'sessions' }),
    );
    expect(screen.getByRole('button', { name: msg('common.loadMore.button', { count: 50 }) })).toBeInTheDocument();
    rerender(<LoadMore {...base} total={10000} totalIsLowerBound />);
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('common.loadMore.showingOfAtLeast', { shown: 100, total: 10000, noun: 'sessions' }),
    );
    expect(screen.getByRole('button', { name: msg('common.loadMore.button', { count: 100 }) })).toBeInTheDocument();
  });

  it('calls back on click, and shows a busy button while loading', async () => {
    const onLoad = vi.fn();
    const { rerender } = renderWithIntl(<LoadMore {...base} onLoad={onLoad} />);
    await userEvent.setup().click(screen.getByRole('button'));
    expect(onLoad).toHaveBeenCalledTimes(1);
    rerender(<LoadMore {...base} onLoad={onLoad} loading />);
    const busy = screen.getByRole('button', { name: msg('common.loading') });
    expect(busy).toBeDisabled();
  });

  it('has no button when everything is shown', () => {
    renderWithIntl(<LoadMore {...base} hasMore={false} shown={342} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('common.loadMore.showingOf', { shown: 342, total: 342, noun: 'sessions' }),
    );
  });

  it('at the page limit it says to narrow the filters and offers no button', () => {
    renderWithIntl(<LoadMore {...base} capped shown={1000} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('common.loadMore.capped', { shown: 1000, noun: 'sessions' }),
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  describe('with a noun key', () => {
    it.each([
      [1, 'Showing 1 of 1 session'],
      [2, 'Showing 2 of 2 sessions'],
    ])('picks the plural form of the noun for %i row(s)', (count, expected) => {
      renderWithIntl(
        <LoadMore
          {...base}
          noun={undefined}
          nounKey="common.noun.sessions"
          hasMore={false}
          shown={count}
          total={count}
        />,
      );
      expect(screen.getByRole('status')).toHaveTextContent(expected);
    });

    it.each([
      ['common.noun.agents', 'agent', 'agents'],
      ['common.noun.events', 'event', 'events'],
      ['common.noun.errors', 'error', 'errors'],
    ] as const)('%s reads %s for one and %s for many', (nounKey, one, many) => {
      const { rerender } = renderWithIntl(
        <LoadMore {...base} noun={undefined} nounKey={nounKey} hasMore={false} shown={1} total={1} />,
      );
      expect(screen.getByRole('status')).toHaveTextContent(`Showing 1 of 1 ${one}`);
      rerender(<LoadMore {...base} noun={undefined} nounKey={nounKey} hasMore={false} shown={7} total={7} />);
      expect(screen.getByRole('status')).toHaveTextContent(`Showing 7 of 7 ${many}`);
    });

    it('words the sentence and the noun in Vietnamese, which has one form', () => {
      renderWithIntl(<LoadMore {...base} noun={undefined} nounKey="common.noun.sessions" />, { locale: 'vi' });
      expect(screen.getByRole('status')).toHaveTextContent(
        msg(
          'common.loadMore.showingOf',
          { shown: 100, total: 342, noun: msg('common.noun.sessions', { count: 342 }, 'vi') },
          'vi',
        ),
      );
      expect(
        screen.getByRole('button', { name: msg('common.loadMore.button', { count: 100 }, 'vi') }),
      ).toBeInTheDocument();
    });

    it('prefers the noun key over the deprecated noun text', () => {
      renderWithIntl(<LoadMore {...base} noun="items" nounKey="common.noun.events" />);
      expect(screen.getByRole('status')).toHaveTextContent('events');
      expect(screen.getByRole('status')).not.toHaveTextContent('items');
    });
  });

  it('formats the counts for the language of the page', () => {
    renderWithIntl(<LoadMore {...base} shown={1000} total={5000} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('common.loadMore.showingOf', { shown: 1000, total: 5000, noun: 'sessions' }),
    );
  });
});
