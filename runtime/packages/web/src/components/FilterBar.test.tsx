import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flag, idText, oneOf, setOf, text, type Spec } from '../lib/url-state.ts';
import { ShortcutRegistryProvider } from '../state/shortcuts-registry.tsx';
import { msg } from '../test/msg.ts';
import { renderWithIntl, type RenderOptions } from '../test/render.tsx';
import { FilterBar, useUrlState, type FilterBarProps, type FilterField } from './FilterBar.tsx';

afterEach(() => {
  vi.useRealTimers();
});

function wrap(children: ReactNode): ReactNode {
  return <ShortcutRegistryProvider>{children}</ShortcutRegistryProvider>;
}

function renderBar(fields: FilterField[], props: Partial<FilterBarProps> = {}, options: RenderOptions = {}) {
  const all: FilterBarProps = {
    label: 'Filter fixtures',
    fields,
    ignoredKeys: [],
    onDismissIgnored: vi.fn(),
    activeCount: 0,
    onClearAll: vi.fn(),
    ...props,
  };
  const view = renderWithIntl(<FilterBar {...all} />, { wrap, ...options });
  return {
    props: all,
    ...view,
    update: (next: Partial<FilterBarProps>) => {
      view.rerender(<FilterBar {...all} {...next} />);
    },
  };
}

function textField(overrides: Partial<Extract<FilterField, { kind: 'text' }>> = {}): FilterField {
  return { kind: 'text', id: 'f-q', label: 'Search', value: '', onChange: vi.fn(), ...overrides };
}

const STATE_OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

// ---- the V3 layout: every field inline (no `primary`) ---------------------------------------------------------------------

describe('FilterBar without primary (the V3 layout)', () => {
  it('is a labelled search form and renders the fields in order', () => {
    renderBar([
      textField(),
      {
        kind: 'select',
        id: 'f-s',
        label: 'Sort',
        value: 'a',
        options: [{ value: 'a', label: 'A' }],
        onChange: vi.fn(),
      },
      { kind: 'flag', id: 'f-e', label: 'Only errors', value: false, onChange: vi.fn() },
    ]);
    const form = screen.getByRole('search', { name: 'Filter fixtures' });
    const labels = within(form)
      .getAllByRole('textbox')
      .concat(within(form).getAllByRole('combobox'), within(form).getAllByRole('checkbox'))
      .map((el) => el.id);
    expect(labels).toEqual(['f-q', 'f-s', 'f-e']);
    expect(screen.queryByRole('button', { name: new RegExp(msg('filters.more')) })).toBeNull();
  });

  it('commits typed text after 250 ms without typing, once', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    renderBar([textField({ onChange })]);
    const input = screen.getByRole('textbox', { name: 'Search' });
    fireEvent.change(input, { target: { value: 'bui' } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.change(input, { target: { value: 'build' } });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('build');
  });

  it('commits trimmed text, and at once on Enter and on blur', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    renderBar([textField({ onChange })]);
    const input = screen.getByRole('textbox', { name: 'Search' });
    fireEvent.change(input, { target: { value: ' ab ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('ab');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onChange).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith('abc');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not clear the text on Escape: that is the behaviour of the one-row search only', () => {
    const onChange = vi.fn();
    renderBar([textField({ onChange, value: 'keep' })]);
    const input = screen.getByRole('textbox', { name: 'Search' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('keep');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows an external change of the value (clear all) and drops the pending edit', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { update } = renderBar([textField({ onChange, value: 'old' })]);
    const input = screen.getByRole('textbox', { name: 'Search' });
    expect(input).toHaveValue('old');
    fireEvent.change(input, { target: { value: 'oldx' } });
    update({ fields: [textField({ onChange, value: '' })] });
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveValue('');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps what the user typed after the echo of an earlier commit and does not echo trailing spaces away', () => {
    vi.useFakeTimers();
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <ShortcutRegistryProvider>
          <FilterBar
            label="Filter fixtures"
            fields={[textField({ value, onChange: setValue })]}
            ignoredKeys={[]}
            onDismissIgnored={vi.fn()}
            activeCount={0}
            onClearAll={vi.fn()}
          />
        </ShortcutRegistryProvider>
      );
    }
    render(<Harness />);
    const input = screen.getByRole('textbox', { name: 'Search' });
    fireEvent.change(input, { target: { value: 'ab ' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(input).toHaveValue('ab ');
    fireEvent.change(input, { target: { value: 'ab c' } });
    expect(input).toHaveValue('ab c');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(input).toHaveValue('ab c');
  });

  it('focuses the field with / when shortcutSlash is set, and not while typing elsewhere', async () => {
    const user = userEvent.setup();
    renderBar([textField({ shortcutSlash: true }), textField({ id: 'f-other', label: 'Other' })]);
    await user.keyboard('/');
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveFocus();
    await user.click(screen.getByRole('textbox', { name: 'Other' }));
    await user.keyboard('/');
    expect(screen.getByRole('textbox', { name: 'Other' })).toHaveValue('/');
  });

  it('commits a select immediately', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderBar([
      {
        kind: 'select',
        id: 'f-s',
        label: 'Sort by',
        value: 'a',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        onChange,
      },
    ]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'b');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('renders a multi field as checkboxes in a disclosure and reports members in option order', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderBar([{ kind: 'multi', id: 'f-m', label: 'State', value: ['c'], options: STATE_OPTIONS, onChange }]);
    const toggle = screen.getByRole('button', { name: /State/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('State (1)');
    await user.click(toggle);
    const group = screen.getByRole('group', { name: 'State' });
    expect(within(group).getByRole('checkbox', { name: 'Gamma' })).toBeChecked();
    await user.click(within(group).getByRole('checkbox', { name: 'Alpha' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(['a', 'c']);
    await user.click(within(group).getByRole('checkbox', { name: 'Gamma' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('toggles a flag immediately', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderBar([{ kind: 'flag', id: 'f-e', label: 'Only errors', value: false, onChange }]);
    await user.click(screen.getByRole('checkbox', { name: 'Only errors' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('offers presets for a range and shows the date inputs only for a custom range', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { update } = renderBar([
      { kind: 'range', id: 'f-r', label: 'Time range', value: { kind: 'preset', preset: '24h' }, onChange },
    ]);
    const select = screen.getByRole('combobox', { name: 'Time range' });
    expect(select).toHaveValue('24h');
    expect(within(select).getByRole('option', { name: msg('filters.range.24h') })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: msg('filters.range.custom') })).toBeInTheDocument();
    expect(screen.queryByLabelText(msg('filters.range.from'))).toBeNull();
    await user.selectOptions(select, '7d');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'preset', preset: '7d' });
    await user.selectOptions(select, 'custom');
    const custom = onChange.mock.lastCall?.[0] as { kind: string; from: string; to: string | null };
    expect(custom.kind).toBe('custom');
    expect(Number.isNaN(Date.parse(custom.from))).toBe(false);
    expect(custom.to).toBeNull();
    update({
      fields: [
        {
          kind: 'range',
          id: 'f-r',
          label: 'Time range',
          value: { kind: 'custom', from: '2026-10-12T08:30:00.000Z', to: null },
          onChange,
        },
      ],
    });
    expect(screen.getByRole('combobox', { name: 'Time range' })).toHaveValue('custom');
    expect(screen.getByLabelText(msg('filters.range.from'))).toHaveValue('2026-10-12T08:30');
    expect(screen.getByLabelText(msg('filters.range.to'))).toHaveValue('');
  });

  it('converts an edited custom bound to an ISO time and refuses an end before the start', () => {
    const onChange = vi.fn();
    renderBar([
      {
        kind: 'range',
        id: 'f-r',
        label: 'Time range',
        value: { kind: 'custom', from: '2026-10-12T08:30:00.000Z', to: '2026-10-12T10:00:00.000Z' },
        onChange,
      },
    ]);
    act(() => {
      fireEvent.change(screen.getByLabelText(msg('filters.range.from')), { target: { value: '2026-10-12T09:00' } });
    });
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'custom',
      from: '2026-10-12T09:00:00.000Z',
      to: '2026-10-12T10:00:00.000Z',
    });
    onChange.mockClear();
    act(() => {
      fireEvent.change(screen.getByLabelText(msg('filters.range.to')), { target: { value: '2026-10-12T08:00' } });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits both bounds of an integer range after the debounce and maps an empty box to null', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    renderBar([{ kind: 'intRange', id: 'f-t', label: 'Tokens', min: 5, max: null, onChange }]);
    expect(screen.getByRole('spinbutton', { name: 'Tokens min' })).toHaveValue(5);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tokens max' }), { target: { value: '900' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onChange).toHaveBeenLastCalledWith(5, 900);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tokens min' }), { target: { value: '' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onChange).toHaveBeenLastCalledWith(null, null);
  });

  it('shows the clear button with the count only when something is active', async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    const { update } = renderBar([textField()], { activeCount: 0, onClearAll });
    expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull();
    update({ activeCount: 2 });
    await user.click(screen.getByRole('button', { name: msg('filters.clearCount', { count: 2 }) }));
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it('lists ignored keys (never values) with a dismiss button', async () => {
    const user = userEvent.setup();
    const onDismissIgnored = vi.fn();
    renderBar([textField()], { ignoredKeys: ['bogus', 'sort'], onDismissIgnored });
    expect(screen.getByText(msg('filters.ignored', { keys: 'bogus, sort' }))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('filters.dismiss') }));
    expect(onDismissIgnored).toHaveBeenCalledOnce();
  });
});

// ---- the one-row layout (`primary`) ---------------------------------------------------------------------------------------

interface RowSetup {
  q?: string;
  state?: string[];
  errors?: boolean;
  project?: string;
  model?: string;
  min?: number | null;
  max?: number | null;
  onChange?: Record<string, (...args: unknown[]) => void>;
}

/** A search box, a State chip, a Time range, "Only errors" in the row; Project, Model and Tokens behind "More filters". */
function rowFields(setup: RowSetup = {}) {
  /** The handler of a field: it forwards to the mock the test gave for that name, if any. */
  const fn =
    (name: string) =>
    (...args: unknown[]): void => {
      setup.onChange?.[name]?.(...args);
    };
  const search: FilterField = {
    kind: 'text',
    id: 'f-q',
    label: 'Search',
    value: setup.q ?? '',
    shortcutSlash: true,
    onChange: fn('q'),
  };
  const state: FilterField = {
    kind: 'multi',
    id: 'f-state',
    label: 'State',
    value: setup.state ?? [],
    options: STATE_OPTIONS,
    onChange: fn('state'),
  };
  const range: FilterField = {
    kind: 'range',
    id: 'f-range',
    label: 'Time range',
    value: { kind: 'preset', preset: '24h' },
    defaultValue: { kind: 'preset', preset: '24h' },
    onChange: fn('range'),
  };
  const errors: FilterField = {
    kind: 'flag',
    id: 'f-errors',
    label: 'Only errors',
    value: setup.errors ?? false,
    onChange: fn('errors'),
  };
  const project: FilterField = {
    kind: 'text',
    id: 'f-project',
    label: 'Project',
    value: setup.project ?? '',
    onChange: fn('project'),
  };
  const model: FilterField = {
    kind: 'text',
    id: 'f-model',
    label: 'Model',
    value: setup.model ?? '',
    onChange: fn('model'),
  };
  const tokens: FilterField = {
    kind: 'intRange',
    id: 'f-tokens',
    label: 'Tokens',
    min: setup.min ?? null,
    max: setup.max ?? null,
    onChange: fn('tokens'),
  };
  const primary = [search, state, range, errors];
  return { primary, fields: [...primary, project, model, tokens] };
}

function renderRow(setup: RowSetup = {}, props: Partial<FilterBarProps> = {}, options: RenderOptions = {}) {
  const { primary, fields } = rowFields(setup);
  return renderBar(fields, { primary, ...props }, options);
}

describe('FilterBar with primary (one row, "More filters", chips)', () => {
  it('puts the primary fields in the row and the others only behind "More filters"', async () => {
    const user = userEvent.setup();
    renderRow();
    const form = screen.getByRole('search', { name: 'Filter fixtures' });
    expect(within(form).getByRole('textbox', { name: 'Search' })).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: /State/ })).toBeInTheDocument();
    expect(within(form).getByRole('combobox', { name: 'Time range' })).toBeInTheDocument();
    expect(within(form).getByRole('checkbox', { name: 'Only errors' })).toBeInTheDocument();
    expect(within(form).queryByRole('textbox', { name: 'Project' })).toBeNull();
    expect(within(form).queryByRole('textbox', { name: 'Model' })).toBeNull();
    expect(within(form).queryByRole('spinbutton')).toBeNull();

    await user.click(within(form).getByRole('button', { name: new RegExp(msg('filters.more')) }));
    const panel = screen.getByRole('dialog', { name: msg('filters.more') });
    expect(within(panel).getByRole('textbox', { name: 'Project' })).toBeInTheDocument();
    expect(within(panel).getByRole('textbox', { name: 'Model' })).toBeInTheDocument();
    expect(within(panel).getByRole('spinbutton', { name: 'Tokens min' })).toBeInTheDocument();
    expect(within(panel).queryByRole('textbox', { name: 'Search' })).toBeNull();
  });

  it('has no "More filters" button when every field is in the row', () => {
    const { primary } = rowFields();
    renderBar(primary, { primary });
    expect(screen.queryByRole('button', { name: new RegExp(msg('filters.more')) })).toBeNull();
  });

  it('counts the active filters that are hidden, and only those', () => {
    renderRow({ project: 'api', min: 5, state: ['a'], errors: true, q: 'text' });
    const more = screen.getByRole('button', { name: msg('filters.moreCount', { count: 2 }) });
    expect(more).toHaveTextContent(msg('filters.moreCount', { count: 2 }));
  });

  it('says plain "More filters" when no hidden filter is on', () => {
    renderRow({ state: ['a'], errors: true });
    expect(screen.getByRole('button', { name: new RegExp(`^${msg('filters.more')}$`) })).toBeInTheDocument();
  });

  it('shows a chip with a remove button for every hidden filter that is on, and none for the row', () => {
    renderRow({ project: 'api', model: 'm1', min: 5, max: 50, q: 'text', state: ['a'], errors: true });
    const chips = within(screen.getByRole('list', { name: msg('filters.active') })).getAllByRole('listitem');
    expect(chips.map((chip) => chip.textContent)).toEqual([
      msg('filters.chip', { label: 'Project', value: 'api' }),
      msg('filters.chip', { label: 'Model', value: 'm1' }),
      msg('filters.chip', { label: 'Tokens', value: msg('filters.bounds.both', { min: '5', max: '50' }) }),
    ]);
    expect(screen.getByRole('button', { name: msg('filters.remove', { label: 'Project' }) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('filters.remove', { label: 'Model' }) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('filters.remove', { label: 'Tokens' }) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: msg('filters.remove', { label: 'Search' }) })).toBeNull();
  });

  it('shows no chip list when nothing hidden is on', () => {
    renderRow({ q: 'text' });
    expect(screen.queryByRole('list', { name: msg('filters.active') })).toBeNull();
  });

  it('removes a filter with its chip: each kind goes back to "no filter"', async () => {
    const user = userEvent.setup();
    const onChange = {
      project: vi.fn<(...args: unknown[]) => void>(),
      tokens: vi.fn<(...args: unknown[]) => void>(),
    };
    renderRow({ project: 'api', min: 5, onChange });
    await user.click(screen.getByRole('button', { name: msg('filters.remove', { label: 'Project' }) }));
    expect(onChange.project).toHaveBeenCalledExactlyOnceWith('');
    await user.click(screen.getByRole('button', { name: msg('filters.remove', { label: 'Tokens' }) }));
    expect(onChange.tokens).toHaveBeenCalledExactlyOnceWith(null, null);
  });

  it('writes a chip for a flag as its label, a multi as its labels, a custom range with its dates', async () => {
    const user = userEvent.setup();
    const onFlag = vi.fn();
    const onMulti = vi.fn();
    const onRange = vi.fn();
    const hiddenOnly: FilterField[] = [
      { kind: 'flag', id: 'h-flag', label: 'Unmatched', value: true, onChange: onFlag },
      { kind: 'multi', id: 'h-multi', label: 'Kinds', value: ['a', 'c'], options: STATE_OPTIONS, onChange: onMulti },
      {
        kind: 'range',
        id: 'h-range',
        label: 'Window',
        value: { kind: 'custom', from: '2026-10-12T08:30:00.000Z', to: null },
        defaultValue: { kind: 'preset', preset: '24h' },
        onChange: onRange,
      },
    ];
    renderBar(hiddenOnly, { primary: [textField()], activeCount: 3 });
    const chips = within(screen.getByRole('list', { name: msg('filters.active') })).getAllByRole('listitem');
    expect(chips[0]?.textContent).toBe('Unmatched');
    expect(chips[1]?.textContent).toBe(msg('filters.chip', { label: 'Kinds', value: 'Alpha, Gamma' }));
    expect(chips[2]?.textContent).toContain('Window');
    expect(chips[2]?.textContent).toContain(msg('filters.range.since', { from: 'Oct 12, 2026, 08:30:00' }));
    await user.click(screen.getByRole('button', { name: msg('filters.remove', { label: 'Unmatched' }) }));
    expect(onFlag).toHaveBeenCalledExactlyOnceWith(false);
    await user.click(screen.getByRole('button', { name: msg('filters.remove', { label: 'Kinds' }) }));
    expect(onMulti).toHaveBeenCalledExactlyOnceWith([]);
    await user.click(screen.getByRole('button', { name: msg('filters.remove', { label: 'Window' }) }));
    expect(onRange).toHaveBeenCalledExactlyOnceWith({ kind: 'preset', preset: '24h' });
  });

  it('lets the page say that a field is on, which overrides what the field would decide', () => {
    const fields: FilterField[] = [
      textField(),
      {
        kind: 'select',
        id: 'h-sel',
        label: 'Order',
        value: 'a',
        options: [{ value: 'a', label: 'A' }],
        onChange: vi.fn(),
        active: true,
      },
      { kind: 'text', id: 'h-off', label: 'Quiet', value: 'x', onChange: vi.fn(), active: false },
    ];
    renderBar(fields, { primary: [fields[0]!] });
    expect(screen.getByRole('button', { name: msg('filters.moreCount', { count: 1 }) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('filters.remove', { label: 'Order' }) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: msg('filters.remove', { label: 'Quiet' }) })).toBeNull();
  });

  it('keeps the chip text exact for a value with an ampersand and a percent sign', () => {
    renderRow({ project: 'a&b %41 <i>' });
    expect(screen.getByText(msg('filters.chip', { label: 'Project', value: 'a&b %41 <i>' }))).toBeInTheDocument();
    expect(
      screen.getByText(msg('filters.chip', { label: 'Project', value: 'a&b %41 <i>' })).closest('li'),
    ).toHaveTextContent('a&b %41 <i>');
  });

  it('shows "Clear filters (n)" for the count of the page, also when only the row is filtered', async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    renderRow({ errors: true }, { activeCount: 1, onClearAll });
    expect(screen.queryByRole('list', { name: msg('filters.active') })).toBeNull();
    await user.click(screen.getByRole('button', { name: msg('filters.clearCount', { count: 1 }) }));
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it('puts "Clear filters (n)" in the row when there are no chips, and with the chips when there are', () => {
    const { unmount } = renderRow({ errors: true }, { activeCount: 1 });
    const inRow = screen.getByRole('button', { name: msg('filters.clearCount', { count: 1 }) });
    expect(inRow.closest('.filter-bar__row')).not.toBeNull();
    expect(inRow.closest('.filter-bar__active')).toBeNull();
    expect(document.querySelector('.filter-bar__active')).toBeNull();
    const more = screen.getByRole('button', { name: new RegExp(msg('filters.more')) });
    expect(more.compareDocumentPosition(inRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
    renderRow({ project: 'api' }, { activeCount: 1 });
    const withChips = screen.getByRole('button', { name: msg('filters.clearCount', { count: 1 }) });
    expect(withChips.closest('.filter-bar__active')).not.toBeNull();
    expect(withChips.closest('.filter-bar__row')).toBeNull();
    expect(screen.getAllByRole('button', { name: msg('filters.clearCount', { count: 1 }) })).toHaveLength(1);
  });

  it('keeps the clear button of a bar without "More filters" in the row', async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    renderBar([textField()], { primary: [textField()], activeCount: 2, onClearAll });
    expect(document.querySelector('.filter-bar__more')).toBeNull();
    await user.click(screen.getByRole('button', { name: msg('filters.clearCount', { count: 2 }) }));
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it('draws neither a clear button nor a chip line for an unfiltered list', () => {
    renderRow();
    expect(screen.queryByRole('button', { name: msg('filters.clearCount', { count: 0 }) })).toBeNull();
    expect(document.querySelector('.filter-bar__active')).toBeNull();
  });

  it('opens "More filters" from the keyboard, edits inside it and returns the focus on Escape', async () => {
    const user = userEvent.setup();
    const onProject = vi.fn<(...args: unknown[]) => void>();
    renderRow({ onChange: { project: onProject } });
    const more = screen.getByRole('button', { name: new RegExp(msg('filters.more')) });
    more.focus();
    await user.keyboard('{Enter}');
    expect(more).toHaveAttribute('aria-expanded', 'true');
    await user.tab();
    const project = screen.getByRole('textbox', { name: 'Project' });
    expect(project).toHaveFocus();
    await user.keyboard('api{Enter}');
    expect(onProject).toHaveBeenCalledExactlyOnceWith('api');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(more).toHaveFocus();
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the Tab order: search, the primary controls, "More filters", then the chips', async () => {
    const user = userEvent.setup();
    renderRow({ project: 'api' });
    const order = [
      screen.getByRole('textbox', { name: 'Search' }),
      screen.getByRole('button', { name: /State/ }),
      screen.getByRole('combobox', { name: 'Time range' }),
      screen.getByRole('checkbox', { name: 'Only errors' }),
      screen.getByRole('button', { name: new RegExp(msg('filters.more')) }),
      screen.getByRole('button', { name: msg('filters.remove', { label: 'Project' }) }),
    ];
    await user.tab();
    for (const element of order) {
      expect(element).toHaveFocus();
      await user.tab();
    }
  });

  it('opens the State chip as a popover of checkboxes and reports members in option order', async () => {
    const user = userEvent.setup();
    const onState = vi.fn<(...args: unknown[]) => void>();
    renderRow({ state: ['c'], onChange: { state: onState } });
    const trigger = screen.getByRole('button', { name: /State/ });
    expect(trigger).toHaveTextContent(msg('filters.multiCount', { label: 'State', count: 1 }));
    expect(screen.queryByRole('checkbox', { name: 'Alpha' })).toBeNull();
    await user.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'State' });
    expect(within(panel).getByRole('checkbox', { name: 'Gamma' })).toBeChecked();
    await user.click(within(panel).getByRole('checkbox', { name: 'Alpha' }));
    expect(onState).toHaveBeenCalledExactlyOnceWith(['a', 'c']);
  });

  it('clears the search with Escape at once, and leaves an empty search with Escape', async () => {
    const user = userEvent.setup();
    const onQ = vi.fn<(...args: unknown[]) => void>();
    renderRow({ q: 'abc', onChange: { q: onQ } });
    const input = screen.getByRole('textbox', { name: 'Search' });
    await user.click(input);
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('');
    expect(onQ).toHaveBeenCalledExactlyOnceWith('');
    expect(input).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(input).not.toHaveFocus();
    expect(onQ).toHaveBeenCalledOnce();
  });

  it('drops a draft that was not committed yet when Escape clears it', () => {
    vi.useFakeTimers();
    const onQ = vi.fn<(...args: unknown[]) => void>();
    renderRow({ onChange: { q: onQ } });
    const input = screen.getByRole('textbox', { name: 'Search' });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onQ).not.toHaveBeenCalled();
  });

  it('still debounces the search by 250 ms and commits it trimmed', () => {
    vi.useFakeTimers();
    const onQ = vi.fn<(...args: unknown[]) => void>();
    renderRow({ onChange: { q: onQ } });
    const input = screen.getByRole('textbox', { name: 'Search' });
    fireEvent.change(input, { target: { value: ' ab ' } });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(onQ).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(onQ).toHaveBeenCalledExactlyOnceWith('ab');
  });

  it('focuses the search with / and describes the shortcut in the language of the page', async () => {
    const user = userEvent.setup();
    renderRow();
    await user.keyboard('/');
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveFocus();
  });

  it('lists ignored keys (never values) under the row, with a dismiss button', async () => {
    const user = userEvent.setup();
    const onDismissIgnored = vi.fn();
    renderRow({}, { ignoredKeys: ['bogus'], onDismissIgnored });
    expect(screen.getByText(msg('filters.ignored', { keys: 'bogus' }))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('filters.dismiss') }));
    expect(onDismissIgnored).toHaveBeenCalledOnce();
  });

  it('moves the focus to the next chip after a removal, and to "More filters" after the last one', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [project, setProject] = useState('api');
      const [model, setModel] = useState('m1');
      const { primary } = rowFields();
      const fields: FilterField[] = [
        ...primary,
        { kind: 'text', id: 'f-project', label: 'Project', value: project, onChange: setProject },
        { kind: 'text', id: 'f-model', label: 'Model', value: model, onChange: setModel },
      ];
      return (
        <ShortcutRegistryProvider>
          <FilterBar
            label="Filter fixtures"
            fields={fields}
            primary={primary}
            ignoredKeys={[]}
            onDismissIgnored={vi.fn()}
            activeCount={0}
            onClearAll={vi.fn()}
          />
        </ShortcutRegistryProvider>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: msg('filters.remove', { label: 'Project' }) }));
    expect(screen.getByRole('button', { name: msg('filters.remove', { label: 'Model' }) })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: msg('filters.remove', { label: 'Model' }) }));
    expect(screen.queryByRole('list', { name: msg('filters.active') })).toBeNull();
    expect(screen.getByRole('button', { name: new RegExp(`^${msg('filters.more')}$`) })).toHaveFocus();
  });

  it('holds 200 active filters: 200 chips, the count in the label and a remove button each', () => {
    const fields: FilterField[] = Array.from({ length: 200 }, (_unused, i) => ({
      kind: 'text' as const,
      id: `h-${String(i)}`,
      label: `Field ${String(i)}`,
      value: `v${String(i)}`,
      onChange: vi.fn(),
    }));
    renderBar([textField(), ...fields], { primary: [textField()], activeCount: 200 });
    expect(within(screen.getByRole('list', { name: msg('filters.active') })).getAllByRole('listitem')).toHaveLength(
      200,
    );
    expect(screen.getByRole('button', { name: msg('filters.moreCount', { count: 200 }) })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Remove filter: Field / })).toHaveLength(200);
  });

  it('says its words in Vietnamese', async () => {
    const user = userEvent.setup();
    renderRow({ project: 'api' }, { activeCount: 1 }, { locale: 'vi' });
    const more = screen.getByRole('button', { name: msg('filters.moreCount', { count: 1 }, 'vi') });
    expect(msg('filters.moreCount', { count: 1 }, 'vi')).not.toBe(msg('filters.moreCount', { count: 1 }));
    expect(screen.getByRole('list', { name: msg('filters.active', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('filters.clearCount', { count: 1 }, 'vi') })).toBeInTheDocument();
    await user.click(more);
    const select = screen.getByRole('combobox', { name: 'Time range' });
    expect(within(select).getByRole('option', { name: msg('filters.range.7d', undefined, 'vi') })).toBeInTheDocument();
  });
});

// ---- useUrlState ---------------------------------------------------------------------------------------------------------

interface DemoState {
  q: string;
  mode: 'a' | 'b';
  on: boolean;
}

const DEMO_SPEC: Spec<DemoState> = { q: text('q', 20), mode: oneOf('mode', ['a', 'b'] as const, 'a'), on: flag('on') };

function Probe() {
  const { pathname, search, key } = useLocation();
  return (
    <output data-testid="location" data-key={key}>
      {pathname + search}
    </output>
  );
}

function UrlHarness({ onRender }: { onRender?: (ignored: string[]) => void }): ReactElement {
  const [state, setState, ignored] = useUrlState(DEMO_SPEC);
  const navigate = useNavigate();
  onRender?.(ignored);
  return (
    <div>
      <p data-testid="state">{JSON.stringify(state)}</p>
      <p data-testid="ignored">{ignored.join(',')}</p>
      <button
        type="button"
        onClick={() => {
          setState({ mode: 'b' });
        }}
      >
        mode b
      </button>
      <button
        type="button"
        onClick={() => {
          setState({ q: 'x y', on: true }, { push: true });
        }}
      >
        push
      </button>
      <button
        type="button"
        onClick={() => {
          setState({ mode: 'a' });
        }}
      >
        mode a
      </button>
      <button
        type="button"
        onClick={() => {
          void navigate(-1);
        }}
      >
        back
      </button>
    </div>
  );
}

function stateOf(): unknown {
  return JSON.parse(screen.getByTestId('state').textContent);
}

function renderUrl(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Probe />
      <UrlHarness />
    </MemoryRouter>,
  );
}

describe('useUrlState', () => {
  it('parses the address into typed state', () => {
    renderUrl('/p?q=hello&mode=b&on=1');
    expect(stateOf()).toEqual({ q: 'hello', mode: 'b', on: true });
    expect(screen.getByTestId('location')).toHaveTextContent('/p?q=hello&mode=b&on=1');
    expect(screen.getByTestId('ignored')).toHaveTextContent('');
  });

  it('replaces the address once with the canonical form and keeps the ignored keys for the note', () => {
    renderUrl('/p?zzz=1&mode=nope&q=hi');
    expect(screen.getByTestId('location')).toHaveTextContent('/p?q=hi');
    expect(stateOf()).toEqual({ q: 'hi', mode: 'a', on: false });
    expect(screen.getByTestId('ignored').textContent.split(',').sort()).toEqual(['mode', 'zzz']);
  });

  it('omits defaults when writing: a filter change replaces the history entry', async () => {
    const user = userEvent.setup();
    renderUrl('/p');
    await user.click(screen.getByRole('button', { name: 'mode b' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/p?mode=b');
    await user.click(screen.getByRole('button', { name: 'mode a' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/p$/);
    await user.click(screen.getByRole('button', { name: 'mode b' }));
    await user.click(screen.getByRole('button', { name: 'back' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/p?mode=b');
  });

  it('pushes a history entry only when asked and merges the patch into the current state', async () => {
    const user = userEvent.setup();
    renderUrl('/p?mode=b');
    await user.click(screen.getByRole('button', { name: 'push' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/p?q=x+y&mode=b&on=1');
    expect(stateOf()).toEqual({ q: 'x y', mode: 'b', on: true });
    await user.click(screen.getByRole('button', { name: 'back' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/p?mode=b');
  });
});

describe('FilterBar and the address (round trip)', () => {
  interface UrlRowState {
    q: string;
    project: string;
    state: string[];
    errors: boolean;
  }
  const SPEC: Spec<UrlRowState> = {
    q: text('q', 200),
    project: idText('project'),
    state: setOf('state', ['a', 'b', 'c'] as const, { ab: ['a', 'b'] }),
    errors: flag('errors'),
  };

  function Page(): ReactElement {
    const [state, setState, ignored] = useUrlState(SPEC);
    const search: FilterField = {
      kind: 'text',
      id: 'u-q',
      label: 'Search',
      value: state.q,
      shortcutSlash: true,
      onChange: (q) => {
        setState({ q });
      },
    };
    const project: FilterField = {
      kind: 'text',
      id: 'u-project',
      label: 'Project',
      value: state.project,
      onChange: (project_) => {
        setState({ project: project_ });
      },
    };
    const errors: FilterField = {
      kind: 'flag',
      id: 'u-errors',
      label: 'Only errors',
      value: state.errors,
      onChange: (on) => {
        setState({ errors: on });
      },
    };
    return (
      <ShortcutRegistryProvider>
        <Probe />
        <FilterBar
          label="Filter fixtures"
          fields={[search, errors, project]}
          primary={[search, errors]}
          ignoredKeys={ignored}
          onDismissIgnored={vi.fn()}
          activeCount={0}
          onClearAll={vi.fn()}
        />
      </ShortcutRegistryProvider>
    );
  }

  function renderPage(route: string) {
    return render(
      <MemoryRouter initialEntries={[route]}>
        <Page />
      </MemoryRouter>,
    );
  }

  it('shows the filters of the address in the row and in the chips', () => {
    renderPage('/p?q=nightly&project=api&errors=1');
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveValue('nightly');
    expect(screen.getByRole('checkbox', { name: 'Only errors' })).toBeChecked();
    expect(screen.getByText(msg('filters.chip', { label: 'Project', value: 'api' }))).toBeInTheDocument();
  });

  it('writes a toggle to the address and takes the chip away again', async () => {
    const user = userEvent.setup();
    renderPage('/p');
    await user.click(screen.getByRole('checkbox', { name: 'Only errors' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/p?errors=1');
    await user.click(screen.getByRole('checkbox', { name: 'Only errors' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/p$/);
  });

  it('round trips a value with an ampersand, a percent sign and spaces through the address', async () => {
    const user = userEvent.setup();
    renderPage('/p');
    const more = screen.getByRole('button', { name: new RegExp(msg('filters.more')) });
    await user.click(more);
    await user.type(screen.getByRole('textbox', { name: 'Project' }), 'a&b %41 c=d{Enter}');
    const location = screen.getByTestId('location').textContent;
    expect(location).toContain('project=a%26b+%2541+c%3Dd');
    const params = new URLSearchParams(location.slice(location.indexOf('?')));
    expect(params.get('project')).toBe('a&b %41 c=d');
    expect(params.has('b %41 c')).toBe(false);
    expect(screen.getByText(msg('filters.chip', { label: 'Project', value: 'a&b %41 c=d' }))).toBeInTheDocument();
  });

  it('opens an address written by hand with the same value in the box', async () => {
    const user = userEvent.setup();
    renderPage('/p?project=a%26b%20%2541');
    expect(screen.getByText(msg('filters.chip', { label: 'Project', value: 'a&b %41' }))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: msg('filters.moreCount', { count: 1 }) }));
    expect(screen.getByRole('textbox', { name: 'Project' })).toHaveValue('a&b %41');
  });

  it('reports an unknown key of the address and removes it from the address', () => {
    renderPage('/p?zzz=1');
    expect(screen.getByText(msg('filters.ignored', { keys: 'zzz' }))).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/p$/);
  });
});
