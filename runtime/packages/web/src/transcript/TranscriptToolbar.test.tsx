import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultFilters } from '../lib/filters.ts';
import { TranscriptToolbar, type TranscriptToolbarProps } from './TranscriptToolbar.tsx';

afterEach(() => {
  vi.useRealTimers();
});

function props(extra: Partial<TranscriptToolbarProps> = {}): TranscriptToolbarProps {
  return {
    filters: defaultFilters(),
    onQueryChange: vi.fn(),
    onToolChange: vi.fn(),
    onErrorsOnlyChange: vi.fn(),
    onKindChange: vi.fn(),
    toolNames: ['Bash', 'Read'],
    newestFirst: true,
    onNewestFirstChange: vi.fn(),
    follow: true,
    onFollowChange: vi.fn(),
    onPrevError: vi.fn(),
    onNextError: vi.fn(),
    onSearchWhole: vi.fn(),
    onJump: vi.fn(),
    jumpError: null,
    onLoadOlder: vi.fn(),
    loadOlderDisabledReason: null,
    olderLoading: false,
    counts: { visible: 4, loaded: 6, errors: 2, firstIndex: 10, lastIndex: 15, total: 40 },
    ...extra,
  };
}

describe('TranscriptToolbar', () => {
  it('is a search landmark with the count line as a status', () => {
    render(<TranscriptToolbar {...props()} />);
    expect(screen.getByRole('search', { name: 'Filter transcript' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing 4 of 6 loaded items · 2 errors · events #10 to #15 of 40',
    );
  });

  it('says so when nothing is loaded', () => {
    render(
      <TranscriptToolbar
        {...props({ counts: { visible: 0, loaded: 0, errors: 0, firstIndex: null, lastIndex: null, total: 0 } })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('No events loaded');
  });

  it('debounces the text filter by 150 ms and clears it with Escape', () => {
    vi.useFakeTimers();
    const p = props();
    const { rerender } = render(<TranscriptToolbar {...p} />);
    const input = screen.getByRole('searchbox', { name: 'Search loaded events' });
    fireEvent.change(input, { target: { value: 'needle' } });
    expect(p.onQueryChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(p.onQueryChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(p.onQueryChange).toHaveBeenCalledWith('needle');
    rerender(<TranscriptToolbar {...p} filters={{ ...p.filters, q: 'needle' }} />);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(p.onQueryChange).toHaveBeenLastCalledWith('');
    expect(input).toHaveValue('');
  });

  it('follows the committed query when it is cleared from outside', () => {
    const p = props({ filters: { ...defaultFilters(), q: 'abc' } });
    const { rerender } = render(<TranscriptToolbar {...p} />);
    expect(screen.getByRole('searchbox')).toHaveValue('abc');
    rerender(<TranscriptToolbar {...p} filters={{ ...p.filters, q: '' }} />);
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('offers the tool names and keeps a selected name that vanished', () => {
    const p = props({ filters: { ...defaultFilters(), tool: 'Gone' } });
    render(<TranscriptToolbar {...p} />);
    const select = screen.getByRole('combobox', { name: 'Tool' });
    const labels = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toEqual(['All tools', 'Bash', 'Gone', 'Read']);
    expect(select).toHaveValue('Gone');
  });

  it('reports tool, errors-only, kind, order and follow changes', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<TranscriptToolbar {...p} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tool' }), 'Read');
    expect(p.onToolChange).toHaveBeenCalledWith('Read');
    await user.click(screen.getByRole('checkbox', { name: 'Errors only' }));
    expect(p.onErrorsOnlyChange).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole('checkbox', { name: 'Thinking' }));
    expect(p.onKindChange).toHaveBeenCalledWith('think', true);
    await user.click(screen.getByRole('checkbox', { name: 'Newest first' }));
    expect(p.onNewestFirstChange).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole('checkbox', { name: 'Follow new events' }));
    expect(p.onFollowChange).toHaveBeenCalledWith(false);
  });

  it('renders the five kind checkboxes in order', () => {
    render(<TranscriptToolbar {...props()} />);
    const names = ['Prompts', 'Claude', 'Thinking', 'Tool calls', 'Results'];
    for (const name of names) expect(screen.getByRole('checkbox', { name })).toBeInTheDocument();
  });

  it('steps through errors and starts the whole-transcript search', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<TranscriptToolbar {...p} />);
    await user.click(screen.getByRole('button', { name: 'Previous error' }));
    await user.click(screen.getByRole('button', { name: 'Next error' }));
    await user.click(screen.getByRole('button', { name: 'Search whole transcript' }));
    expect(p.onPrevError).toHaveBeenCalledTimes(1);
    expect(p.onNextError).toHaveBeenCalledTimes(1);
    expect(p.onSearchWhole).toHaveBeenCalledTimes(1);
  });

  it('submits the jump form and shows its message', async () => {
    const user = userEvent.setup();
    const p = props({ jumpError: 'Enter #N, HH:MM[:SS] or an ISO time' });
    render(<TranscriptToolbar {...p} />);
    expect(screen.getByText('Enter #N, HH:MM[:SS] or an ISO time')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Jump to' }), '#42{Enter}');
    expect(p.onJump).toHaveBeenCalledWith('#42');
  });

  it('disables Load older with the reason as a tooltip', () => {
    render(<TranscriptToolbar {...props({ loadOlderDisabledReason: 'Already at the first event' })} />);
    const button = screen.getByRole('button', { name: 'Load older' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Already at the first event');
  });

  it('loads older events when enabled', async () => {
    const p = props();
    render(<TranscriptToolbar {...p} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load older' }));
    expect(p.onLoadOlder).toHaveBeenCalledTimes(1);
  });
});
