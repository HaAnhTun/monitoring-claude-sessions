import { LIFECYCLE_STATES } from '@mcs/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { lifecycleDisplay } from '../../lib/lifecycle-display.ts';
import { parseUrlState, sessionsSpec, type SessionsUrlState } from '../../lib/url-state.ts';
import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { SessionFilterBar } from './SessionFilterBar.tsx';

const SPEC = sessionsSpec(24);

function stateOf(query = ''): SessionsUrlState {
  return parseUrlState(SPEC, new URLSearchParams(query)).value;
}

function wrap(children: ReactNode): ReactNode {
  return <ShortcutRegistryProvider>{children}</ShortcutRegistryProvider>;
}

function renderBar(query = '', locale: 'en' | 'vi' = 'en', activeCount = 0) {
  const onChange = vi.fn();
  const onClearAll = vi.fn();
  renderWithIntl(
    <SessionFilterBar
      state={stateOf(query)}
      onChange={onChange}
      rangeDefault={SPEC.range.default}
      ignoredKeys={[]}
      onDismissIgnored={() => undefined}
      activeCount={activeCount}
      onClearAll={onClearAll}
    />,
    { locale, wrap },
  );
  return { onChange, onClearAll };
}

describe('SessionFilterBar: the one row', () => {
  it('is a labelled search form with the search, the state chip, the range and "Only errors"', () => {
    renderBar();
    const form = screen.getByRole('search', { name: msg('sessions.filter.label') });
    expect(within(form).getByRole('textbox', { name: msg('sessions.filter.search') })).toHaveAttribute(
      'placeholder',
      msg('sessions.filter.searchPlaceholder'),
    );
    expect(within(form).getByRole('button', { name: msg('sessions.filter.state') })).toBeInTheDocument();
    expect(within(form).getByRole('combobox', { name: msg('sessions.filter.range') })).toHaveValue('24h');
    expect(within(form).getByRole('checkbox', { name: msg('sessions.filter.errors') })).not.toBeChecked();
    expect(within(form).getByRole('button', { name: msg('filters.more') })).toBeInTheDocument();
  });

  it('keeps project, work item, model, tokens and unmatched out of the row', () => {
    renderBar();
    for (const key of [
      'sessions.filter.project',
      'sessions.filter.task',
      'sessions.filter.model',
      'sessions.filter.unmatched',
    ] as const) {
      expect(screen.queryByLabelText(msg(key))).toBeNull();
    }
  });

  it('offers every lifecycle state under its catalogue word in the state chip', async () => {
    renderBar();
    await userEvent.setup().click(screen.getByRole('button', { name: msg('sessions.filter.state') }));
    const panel = screen.getByRole('dialog', { name: msg('sessions.filter.state') });
    expect(
      within(panel)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual(LIFECYCLE_STATES.map((member) => msg(lifecycleDisplay(member).labelKey)));
  });

  it('offers the states in Vietnamese when the language is Vietnamese', async () => {
    renderBar('', 'vi');
    await userEvent.setup().click(screen.getByRole('button', { name: msg('sessions.filter.state', undefined, 'vi') }));
    const panel = screen.getByRole('dialog', { name: msg('sessions.filter.state', undefined, 'vi') });
    expect(
      within(panel)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual(LIFECYCLE_STATES.map((member) => msg(lifecycleDisplay(member).labelKey, undefined, 'vi')));
  });

  it('counts the chosen states on the chip and sends them in the order of the states', async () => {
    const { onChange } = renderBar('state=failed');
    await userEvent.setup().click(
      screen.getByRole('button', {
        name: msg('filters.multiCount', { label: msg('sessions.filter.state'), count: 1 }),
      }),
    );
    await userEvent.setup().click(screen.getByRole('checkbox', { name: msg('state.working.label') }));
    expect(onChange).toHaveBeenCalledWith({ state: ['working', 'failed'] });
  });

  it('sends the time range, "Only errors" and the typed search', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { onChange } = renderBar();
      fireEvent.change(screen.getByRole('combobox', { name: msg('sessions.filter.range') }), {
        target: { value: '7d' },
      });
      expect(onChange).toHaveBeenLastCalledWith({ range: { kind: 'preset', preset: '7d' } });
      fireEvent.click(screen.getByRole('checkbox', { name: msg('sessions.filter.errors') }));
      expect(onChange).toHaveBeenLastCalledWith({ errors: true });
      const box = screen.getByRole('textbox', { name: msg('sessions.filter.search') });
      fireEvent.change(box, { target: { value: 'build' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onChange).toHaveBeenLastCalledWith({ q: 'build' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionFilterBar: More filters', () => {
  it('holds project, work item, model, tokens and the unmatched switch', async () => {
    renderBar();
    await userEvent.setup().click(screen.getByRole('button', { name: msg('filters.more') }));
    const panel = screen.getByRole('dialog', { name: msg('filters.more') });
    expect(within(panel).getByRole('textbox', { name: msg('sessions.filter.project') })).toBeInTheDocument();
    expect(within(panel).getByRole('textbox', { name: msg('sessions.filter.task') })).toHaveAttribute(
      'placeholder',
      msg('sessions.filter.taskPlaceholder'),
    );
    expect(within(panel).getByRole('textbox', { name: msg('sessions.filter.model') })).toBeInTheDocument();
    expect(
      within(panel).getByRole('spinbutton', { name: msg('filters.min', { label: msg('sessions.filter.tokens') }) }),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('checkbox', { name: msg('sessions.filter.unmatched') })).not.toBeChecked();
  });

  it('counts the filters that are on in the popover, and shows a removable chip for each', () => {
    const { onChange } = renderBar('project=billing&model=model-a&tokMin=5000&unmatched=1', 'en', 4);
    expect(screen.getByRole('button', { name: msg('filters.moreCount', { count: 4 }) })).toBeInTheDocument();
    const chips = screen.getByRole('list', { name: msg('filters.active') });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(4);
    expect(
      within(chips).getByText(msg('filters.chip', { label: msg('sessions.filter.project'), value: 'billing' })),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: msg('filters.remove', { label: msg('sessions.filter.project') }) }),
    );
    expect(onChange).toHaveBeenCalledWith({ project: '' });
  });

  it('turns the work item into a number and ignores text that is not one', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    return (async () => {
      try {
        const { onChange } = renderBar();
        await userEvent
          .setup({ advanceTimers: vi.advanceTimersByTime })
          .click(screen.getByRole('button', { name: msg('filters.more') }));
        const box = screen.getByRole('textbox', { name: msg('sessions.filter.task') });
        fireEvent.change(box, { target: { value: '12' } });
        fireEvent.keyDown(box, { key: 'Enter' });
        expect(onChange).toHaveBeenLastCalledWith({ task: 12 });
        onChange.mockClear();
        fireEvent.change(box, { target: { value: 'abc' } });
        fireEvent.keyDown(box, { key: 'Enter' });
        expect(onChange).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    })();
  });
});

describe('SessionFilterBar: clearing', () => {
  it('has no clear button without a filter, and one with the count when filters are on', () => {
    const { onClearAll } = renderBar('errors=1&range=7d', 'en', 2);
    fireEvent.click(screen.getByRole('button', { name: msg('filters.clearCount', { count: 2 }) }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it('shows no clear button when nothing is filtered', () => {
    renderBar();
    expect(screen.queryByRole('button', { name: /^Clear filters/ })).toBeNull();
  });
});
