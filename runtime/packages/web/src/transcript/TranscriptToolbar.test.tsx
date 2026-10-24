import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultFilters } from '../lib/filters.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
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
    onJump: vi.fn(() => true),
    jumpError: null,
    onLoadOlder: vi.fn(),
    canLoadOlder: true,
    olderLoading: false,
    counts: { visible: 4, loaded: 6, errors: 2, firstIndex: 10, lastIndex: 15, total: 40 },
    ...extra,
  };
}

const searchbox = (): HTMLElement => screen.getByRole('searchbox', { name: msg('transcript.toolbar.search') });

async function openShow(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: msg('transcript.toolbar.show') }));
  return screen.getByRole('dialog', { name: msg('transcript.toolbar.showPanel') });
}

async function openMore(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: msg('transcript.toolbar.more') }));
  return screen.getByRole('dialog', { name: msg('transcript.toolbar.more') });
}

describe('TranscriptToolbar', () => {
  it('is a search landmark with the count line below it', () => {
    renderWithIntl(<TranscriptToolbar {...props()} />);
    expect(screen.getByRole('search', { name: msg('transcript.toolbar.label') })).toBeInTheDocument();
    expect(
      screen.getByText(
        msg('transcript.count', { visible: 4, loaded: 6, errors: 2, first: '10', last: '15', total: 40 }),
      ),
    ).toBeInTheDocument();
  });

  it('words the count line from the number of errors (singular and plural differ)', () => {
    renderWithIntl(
      <TranscriptToolbar
        {...props({ counts: { visible: 12, loaded: 12, errors: 1, firstIndex: 0, lastIndex: 16, total: 17 } })}
      />,
    );
    const one = msg('transcript.count', { visible: 12, loaded: 12, errors: 1, first: '0', last: '16', total: 17 });
    const two = msg('transcript.count', { visible: 12, loaded: 12, errors: 2, first: '0', last: '16', total: 17 });
    expect(one).not.toBe(two);
    expect(screen.getByText(one)).toBeInTheDocument();
  });

  it('says so when nothing is loaded', () => {
    renderWithIntl(
      <TranscriptToolbar
        {...props({ counts: { visible: 0, loaded: 0, errors: 0, firstIndex: null, lastIndex: null, total: 0 } })}
      />,
    );
    expect(screen.getByText(msg('transcript.countEmpty'))).toBeInTheDocument();
  });

  it('keeps the first row to the search box, the switches, the error steps and the two menus', () => {
    renderWithIntl(<TranscriptToolbar {...props()} />);
    const row = screen.getByRole('search', { name: msg('transcript.toolbar.label') });
    const controls = Array.from(row.querySelectorAll('input, button, select, textarea, a[href]'));
    const outsideMenus = controls.filter((control) => control.closest('.tv-menus') === null);
    // search box, Errors only, previous and next error, Follow
    expect(outsideMenus).toHaveLength(5);
    // plus the Show popover and the overflow menu: seven controls, none of them hidden behind a second row of filters
    expect(controls).toHaveLength(7);
    expect(row.querySelectorAll('.tv-kinds, select')).toHaveLength(0);
  });

  it('draws the previous and next error as icon buttons with a name and a tooltip', () => {
    renderWithIntl(<TranscriptToolbar {...props()} />);
    for (const key of ['transcript.toolbar.prevError', 'transcript.toolbar.nextError'] as const) {
      const button = screen.getByRole('button', { name: msg(key) });
      expect(button).toHaveAttribute('title', msg(key));
      expect(button).toHaveTextContent('');
      expect(button.querySelector('svg')).not.toBeNull();
    }
  });

  it('debounces the text filter by 150 ms and clears it with Escape', () => {
    vi.useFakeTimers();
    const p = props();
    const { rerender } = renderWithIntl(<TranscriptToolbar {...p} />);
    const input = searchbox();
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
    const { rerender } = renderWithIntl(<TranscriptToolbar {...p} />);
    expect(searchbox()).toHaveValue('abc');
    rerender(<TranscriptToolbar {...p} filters={{ ...p.filters, q: '' }} />);
    expect(searchbox()).toHaveValue('');
  });

  it('searches the whole transcript on Enter, with the text that is in the box', async () => {
    const user = userEvent.setup();
    const p = props();
    renderWithIntl(<TranscriptToolbar {...p} />);
    await user.type(searchbox(), 'needle{Enter}');
    expect(p.onQueryChange).toHaveBeenCalledWith('needle');
    expect(p.onSearchWhole).toHaveBeenCalledWith('needle');
  });

  it('does not search the whole transcript on Enter in an empty box', async () => {
    const user = userEvent.setup();
    const p = props();
    renderWithIntl(<TranscriptToolbar {...p} />);
    await user.type(searchbox(), '{Enter}');
    expect(p.onSearchWhole).not.toHaveBeenCalled();
  });

  it('reports the Errors only and Follow switches and steps through errors', async () => {
    const user = userEvent.setup();
    const p = props();
    renderWithIntl(<TranscriptToolbar {...p} />);
    const errorsOnly = screen.getByRole('switch', { name: msg('transcript.toolbar.errorsOnly') });
    expect(errorsOnly).toHaveAttribute('aria-checked', 'false');
    await user.click(errorsOnly);
    expect(p.onErrorsOnlyChange).toHaveBeenCalledWith(true);
    const follow = screen.getByRole('switch', { name: msg('transcript.toolbar.follow') });
    expect(follow).toHaveAttribute('aria-checked', 'true');
    await user.click(follow);
    expect(p.onFollowChange).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole('button', { name: msg('transcript.toolbar.prevError') }));
    await user.click(screen.getByRole('button', { name: msg('transcript.toolbar.nextError') }));
    expect(p.onPrevError).toHaveBeenCalledTimes(1);
    expect(p.onNextError).toHaveBeenCalledTimes(1);
  });

  it('shows the state of the switches that the filters hold', () => {
    renderWithIntl(
      <TranscriptToolbar {...props({ filters: { ...defaultFilters(), errorsOnly: true }, follow: false })} />,
    );
    expect(screen.getByRole('switch', { name: msg('transcript.toolbar.errorsOnly') })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('switch', { name: msg('transcript.toolbar.follow') })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  describe('the Show popover', () => {
    it('opens on the trigger and closes on Escape', async () => {
      const user = userEvent.setup();
      renderWithIntl(<TranscriptToolbar {...props()} />);
      const trigger = screen.getByRole('button', { name: msg('transcript.toolbar.show') });
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await openShow(user);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(trigger).toHaveFocus();
    });

    it('lists the five kinds in order as toggle buttons that carry their state', async () => {
      const user = userEvent.setup();
      renderWithIntl(<TranscriptToolbar {...props()} />);
      const panel = await openShow(user);
      const keys = ['prompt', 'say', 'think', 'tool', 'result'] as const;
      const chips = within(panel).getAllByRole('button');
      expect(chips.map((chip) => chip.textContent)).toEqual(keys.map((kind) => msg(`transcript.toolbar.kind.${kind}`)));
      // the defaults: everything but Thinking and (prompts only when the filters say so) is on
      const filters = defaultFilters();
      keys.forEach((kind, n) => {
        expect(chips[n]).toHaveAttribute('aria-pressed', String(filters.kinds[kind]));
      });
    });

    it('reports a kind, the order and the tool', async () => {
      const user = userEvent.setup();
      const p = props();
      renderWithIntl(<TranscriptToolbar {...p} />);
      const panel = await openShow(user);
      await user.click(within(panel).getByRole('button', { name: msg('transcript.toolbar.kind.think') }));
      expect(p.onKindChange).toHaveBeenCalledWith('think', true);
      await user.click(within(panel).getByRole('checkbox', { name: msg('transcript.toolbar.newestFirst') }));
      expect(p.onNewestFirstChange).toHaveBeenCalledWith(false);
      await user.selectOptions(within(panel).getByRole('combobox', { name: msg('transcript.toolbar.tool') }), 'Read');
      expect(p.onToolChange).toHaveBeenCalledWith('Read');
    });

    it('offers the tool names and keeps a selected name that vanished', async () => {
      const user = userEvent.setup();
      renderWithIntl(<TranscriptToolbar {...props({ filters: { ...defaultFilters(), tool: 'Gone' } })} />);
      const panel = await openShow(user);
      const select = within(panel).getByRole('combobox', { name: msg('transcript.toolbar.tool') });
      const labels = within(select)
        .getAllByRole('option')
        .map((option) => option.textContent);
      expect(labels).toEqual([msg('transcript.toolbar.allTools'), 'Bash', 'Gone', 'Read']);
      expect(select).toHaveValue('Gone');
    });
  });

  describe('the overflow menu', () => {
    it('holds the whole-transcript search, the jump box and Load older', async () => {
      const user = userEvent.setup();
      renderWithIntl(<TranscriptToolbar {...props()} />);
      const panel = await openMore(user);
      expect(within(panel).getByRole('button', { name: msg('transcript.toolbar.searchWhole') })).toBeInTheDocument();
      expect(within(panel).getByRole('textbox', { name: msg('transcript.toolbar.jumpTo') })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: msg('transcript.loadOlder') })).toBeInTheDocument();
    });

    it('starts the whole-transcript search with the text in the box and closes', async () => {
      const user = userEvent.setup();
      const p = props();
      renderWithIntl(<TranscriptToolbar {...p} />);
      await user.type(searchbox(), 'needle');
      const panel = await openMore(user);
      await user.click(within(panel).getByRole('button', { name: msg('transcript.toolbar.searchWhole') }));
      expect(p.onSearchWhole).toHaveBeenCalledWith('needle');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('submits the jump text unchanged and closes when it could be read', async () => {
      const user = userEvent.setup();
      const p = props();
      renderWithIntl(<TranscriptToolbar {...p} />);
      const panel = await openMore(user);
      await user.type(within(panel).getByRole('textbox', { name: msg('transcript.toolbar.jumpTo') }), '#42{Enter}');
      expect(p.onJump).toHaveBeenCalledWith('#42');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('stays open and shows the message when the jump text cannot be read', async () => {
      const user = userEvent.setup();
      const p = props({ onJump: vi.fn(() => false), jumpError: msg('transcript.notice.jumpUnreadable') });
      renderWithIntl(<TranscriptToolbar {...p} />);
      const panel = await openMore(user);
      expect(within(panel).getByText(msg('transcript.notice.jumpUnreadable'))).toBeInTheDocument();
      await user.type(within(panel).getByRole('textbox', { name: msg('transcript.toolbar.jumpTo') }), 'later{Enter}');
      expect(p.onJump).toHaveBeenCalledWith('later');
      expect(screen.getByRole('dialog', { name: msg('transcript.toolbar.more') })).toBeInTheDocument();
    });

    it('loads older events and closes', async () => {
      const user = userEvent.setup();
      const p = props();
      renderWithIntl(<TranscriptToolbar {...p} />);
      const panel = await openMore(user);
      await user.click(within(panel).getByRole('button', { name: msg('transcript.loadOlder') }));
      expect(p.onLoadOlder).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('does not offer Load older when nothing can be loaded', async () => {
      const user = userEvent.setup();
      renderWithIntl(<TranscriptToolbar {...props({ canLoadOlder: false })} />);
      const panel = await openMore(user);
      expect(within(panel).queryByRole('button', { name: msg('transcript.loadOlder') })).toBeNull();
      expect(within(panel).getByRole('button', { name: msg('transcript.toolbar.searchWhole') })).toBeInTheDocument();
    });
  });

  describe('the error breakdown', () => {
    it('says how many errors are in this agent and how many in subagents, with a link to the Errors tab', () => {
      renderWithIntl(
        <TranscriptToolbar
          {...props({ sessionErrors: { thisAgent: 0, subagents: 1, errorsTabHref: '/sessions/s1?tab=errors' } })}
        />,
      );
      expect(screen.getByText(msg('transcript.errors.breakdown', { thisAgent: 0, subagents: 1 }))).toBeInTheDocument();
      expect(screen.getByRole('link', { name: msg('transcript.errors.viewAll') })).toHaveAttribute(
        'href',
        '/sessions/s1?tab=errors',
      );
    });

    it('is not shown when no subagent has an error, or when the page does not know the counts', () => {
      const { rerender } = renderWithIntl(
        <TranscriptToolbar
          {...props({ sessionErrors: { thisAgent: 2, subagents: 0, errorsTabHref: '/sessions/s1?tab=errors' } })}
        />,
      );
      expect(screen.queryByRole('link', { name: msg('transcript.errors.viewAll') })).toBeNull();
      rerender(<TranscriptToolbar {...props()} />);
      expect(screen.queryByRole('link')).toBeNull();
    });
  });

  it('speaks Vietnamese when the language is Vietnamese', async () => {
    const user = userEvent.setup();
    renderWithIntl(<TranscriptToolbar {...props()} />, { locale: 'vi' });
    expect(
      screen.getByRole('switch', { name: msg('transcript.toolbar.errorsOnly', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: msg('transcript.toolbar.prevError', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        msg('transcript.count', { visible: 4, loaded: 6, errors: 2, first: '10', last: '15', total: 40 }, 'vi'),
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('transcript.toolbar.show', undefined, 'vi') }));
    expect(
      screen.getByRole('button', { name: msg('transcript.toolbar.kind.tool', undefined, 'vi') }),
    ).toBeInTheDocument();
  });
});
