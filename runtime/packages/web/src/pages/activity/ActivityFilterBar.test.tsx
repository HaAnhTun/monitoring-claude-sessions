import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseUrlState, activitySpec, type ActivityUrlState } from '../../lib/url-state.ts';
import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { msg } from '../../test/msg.ts';
import { renderWithIntl, type RenderOptions } from '../../test/render.tsx';
import { ActivityFilterBar, type ActivityFilterBarProps } from './ActivityFilterBar.tsx';

afterEach(() => {
  vi.useRealTimers();
});

function wrap(children: ReactNode): ReactNode {
  return <ShortcutRegistryProvider>{children}</ShortcutRegistryProvider>;
}

function stateOf(query = ''): ActivityUrlState {
  return parseUrlState(activitySpec, new URLSearchParams(query)).value;
}

function renderBar(props: Partial<ActivityFilterBarProps> = {}, options: RenderOptions = {}) {
  const all: ActivityFilterBarProps = {
    state: stateOf(),
    onChange: vi.fn(),
    ignoredKeys: [],
    onDismissIgnored: vi.fn(),
    activeCount: 0,
    onClearAll: vi.fn(),
    ...props,
  };
  return { props: all, ...renderWithIntl(<ActivityFilterBar {...all} />, { wrap, ...options }) };
}

describe('ActivityFilterBar', () => {
  it('is one labelled search form with the search, category, severity and time range in the row', () => {
    renderBar();
    const form = screen.getByRole('search', { name: msg('activity.filter.label') });
    expect(within(form).getByRole('textbox', { name: msg('activity.filter.search') })).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: new RegExp(msg('activity.filter.category')) })).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: new RegExp(msg('activity.filter.severity')) })).toBeInTheDocument();
    expect(within(form).getByRole('combobox', { name: msg('activity.filter.range') })).toHaveValue('24h');
  });

  it('keeps session, project and tool in the More filters panel', async () => {
    const user = userEvent.setup();
    renderBar();
    expect(screen.queryByRole('textbox', { name: msg('activity.filter.session') })).toBeNull();
    await user.click(screen.getByRole('button', { name: new RegExp(msg('filters.more')) }));
    for (const name of ['session', 'project', 'tool'] as const) {
      expect(screen.getByRole('textbox', { name: msg(`activity.filter.${name}`) })).toBeInTheDocument();
    }
  });

  it('reports the search text after the typing pause', () => {
    vi.useFakeTimers();
    const { props } = renderBar();
    fireEvent.change(screen.getByRole('textbox', { name: msg('activity.filter.search') }), {
      target: { value: 'build' },
    });
    expect(props.onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ q: 'build' });
  });

  it('reports the chosen severities in their fixed order', async () => {
    const user = userEvent.setup();
    const { props } = renderBar({ state: stateOf('severity=error') });
    await user.click(screen.getByRole('button', { name: new RegExp(msg('activity.filter.severity')) }));
    const group = screen.getByRole('group', { name: msg('activity.filter.severity') });
    expect(within(group).getByRole('checkbox', { name: msg('activity.severity.error') })).toBeChecked();
    await user.click(within(group).getByRole('checkbox', { name: msg('activity.severity.warning') }));
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ severity: ['warning', 'error'] });
  });

  it('reports the chosen categories in the order of the catalogue', async () => {
    const user = userEvent.setup();
    const { props } = renderBar();
    await user.click(screen.getByRole('button', { name: new RegExp(msg('activity.filter.category')) }));
    const group = screen.getByRole('group', { name: msg('activity.filter.category') });
    await user.click(within(group).getByRole('checkbox', { name: msg('activity.category.error') }));
    expect(props.onChange).toHaveBeenLastCalledWith({ types: ['error'] });
  });

  it('reports a new time range', async () => {
    const user = userEvent.setup();
    const { props } = renderBar();
    await user.selectOptions(screen.getByRole('combobox', { name: msg('activity.filter.range') }), '7d');
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ range: { kind: 'preset', preset: '7d' } });
  });

  it('shows a chip for an active filter that sits in the panel and clears everything from one button', async () => {
    const user = userEvent.setup();
    const { props } = renderBar({ state: stateOf('tool=Bash'), activeCount: 1 });
    expect(screen.getByText(/Bash/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('filters.clearCount', { count: 1 }) }));
    expect(props.onClearAll).toHaveBeenCalledOnce();
  });

  it('says which keys of the address were ignored and lets the user dismiss the note', async () => {
    const user = userEvent.setup();
    const { props } = renderBar({ ignoredKeys: ['severity'] });
    expect(screen.getByText(msg('filters.ignored', { keys: 'severity' }))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('filters.dismiss') }));
    expect(props.onDismissIgnored).toHaveBeenCalledOnce();
  });

  it('writes its labels in Vietnamese', () => {
    renderBar({}, { locale: 'vi' });
    expect(screen.getByRole('search', { name: msg('activity.filter.label', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: msg('activity.filter.range', undefined, 'vi') })).toBeInTheDocument();
  });
});
