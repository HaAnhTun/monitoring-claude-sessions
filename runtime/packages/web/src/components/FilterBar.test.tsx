import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flag, oneOf, text, type Spec } from '../lib/url-state.ts';
import { ShortcutRegistryProvider } from '../state/shortcuts-registry.tsx';
import { FilterBar, useUrlState, type FilterBarProps, type FilterField } from './FilterBar.tsx';

afterEach(() => {
  vi.useRealTimers();
});

function renderBar(fields: FilterField[], props: Partial<FilterBarProps> = {}) {
  const all: FilterBarProps = {
    label: 'Filter fixtures',
    fields,
    ignoredKeys: [],
    onDismissIgnored: vi.fn(),
    activeCount: 0,
    onClearAll: vi.fn(),
    ...props,
  };
  return {
    props: all,
    ...render(
      <ShortcutRegistryProvider>
        <FilterBar {...all} />
      </ShortcutRegistryProvider>,
    ),
  };
}

function textField(overrides: Partial<Extract<FilterField, { kind: 'text' }>> = {}): FilterField {
  return { kind: 'text', id: 'f-q', label: 'Search', value: '', onChange: vi.fn(), ...overrides };
}

describe('FilterBar', () => {
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

  it('shows an external change of the value (clear all) and drops the pending edit', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender, props } = renderBar([textField({ onChange, value: 'old' })]);
    const input = screen.getByRole('textbox', { name: 'Search' });
    expect(input).toHaveValue('old');
    fireEvent.change(input, { target: { value: 'oldx' } });
    rerender(
      <ShortcutRegistryProvider>
        <FilterBar {...props} fields={[textField({ onChange, value: '' })]} />
      </ShortcutRegistryProvider>,
    );
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
    renderBar([
      {
        kind: 'multi',
        id: 'f-m',
        label: 'State',
        value: ['c'],
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
          { value: 'c', label: 'Gamma' },
        ],
        onChange,
      },
    ]);
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
    const { rerender, props } = renderBar([
      { kind: 'range', id: 'f-r', label: 'Time range', value: { kind: 'preset', preset: '24h' }, onChange },
    ]);
    const select = screen.getByRole('combobox', { name: 'Time range' });
    expect(select).toHaveValue('24h');
    expect(screen.queryByLabelText('From')).toBeNull();
    await user.selectOptions(select, '7d');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'preset', preset: '7d' });
    await user.selectOptions(select, 'custom');
    const custom = onChange.mock.lastCall?.[0] as { kind: string; from: string; to: string | null };
    expect(custom.kind).toBe('custom');
    expect(Number.isNaN(Date.parse(custom.from))).toBe(false);
    expect(custom.to).toBeNull();
    rerender(
      <ShortcutRegistryProvider>
        <FilterBar
          {...props}
          fields={[
            {
              kind: 'range',
              id: 'f-r',
              label: 'Time range',
              value: { kind: 'custom', from: '2026-10-12T08:30:00.000Z', to: null },
              onChange,
            },
          ]}
        />
      </ShortcutRegistryProvider>,
    );
    expect(screen.getByRole('combobox', { name: 'Time range' })).toHaveValue('custom');
    expect(screen.getByLabelText('From')).toHaveValue('2026-10-12T08:30');
    expect(screen.getByLabelText('To')).toHaveValue('');
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
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-12T09:00' } });
    });
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'custom',
      from: '2026-10-12T09:00:00.000Z',
      to: '2026-10-12T10:00:00.000Z',
    });
    onChange.mockClear();
    act(() => {
      fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-12T08:00' } });
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
    const { rerender, props } = renderBar([textField()], { activeCount: 0, onClearAll });
    expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull();
    rerender(
      <ShortcutRegistryProvider>
        <FilterBar {...props} activeCount={2} />
      </ShortcutRegistryProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Clear filters (2)' }));
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it('lists ignored keys (never values) with a dismiss button', async () => {
    const user = userEvent.setup();
    const onDismissIgnored = vi.fn();
    renderBar([textField()], { ignoredKeys: ['bogus', 'sort'], onDismissIgnored });
    expect(screen.getByText('Ignored invalid or unknown filter: bogus, sort')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissIgnored).toHaveBeenCalledOnce();
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
