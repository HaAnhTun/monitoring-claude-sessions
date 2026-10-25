import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createPrefs } from '../../lib/prefs.ts';
import { createPrefsStore } from '../../state/prefs-store.ts';
import { msg } from '../../test/msg.ts';
import { renderHookWithProviders, renderWithIntl } from '../../test/render.tsx';
import { ColumnChooser, resolveColumns, useColumnChoice, type ColumnOption } from './ColumnChooser.tsx';

const OPTIONS: ColumnOption[] = [
  { id: 'state', label: 'FIXTURE state' },
  { id: 'label', label: 'FIXTURE session', required: true },
  { id: 'project', label: 'FIXTURE project' },
  { id: 'models', label: 'FIXTURE model' },
];
const ALL = OPTIONS.map((option) => option.id);
const REQUIRED = ['label'];
const DEFAULTS = ['state', 'label'];

function newStore(stored?: Record<string, string[]>) {
  const store = createPrefsStore(createPrefs(null));
  if (stored !== undefined) store.setPref('tableColumns', stored);
  return store;
}

describe('resolveColumns', () => {
  it('gives the defaults when nothing is stored', () => {
    expect(resolveColumns(undefined, ALL, REQUIRED, DEFAULTS)).toEqual(DEFAULTS);
  });

  it('keeps the order of the table, drops unknown ids and adds the required columns', () => {
    expect(resolveColumns(['models', 'gone', 'state'], ALL, REQUIRED, DEFAULTS)).toEqual(['state', 'label', 'models']);
  });
});

describe('useColumnChoice', () => {
  it('stores the choice under the table id in tableColumns and keeps the other tables', () => {
    const prefsStore = newStore({ other: ['a'] });
    const { result } = renderHookWithProviders(() => useColumnChoice('sessions', ALL, REQUIRED, DEFAULTS), {
      prefsStore,
    });
    expect(result.current.selected).toEqual(DEFAULTS);
    expect(result.current.isDefault).toBe(true);
    act(() => {
      result.current.toggle('models', true);
    });
    expect(prefsStore.getSnapshot().tableColumns).toEqual({ other: ['a'], sessions: ['state', 'label', 'models'] });
    expect(result.current.selected).toEqual(['state', 'label', 'models']);
    expect(result.current.isDefault).toBe(false);
  });

  it('does not store a choice that equals the default', () => {
    const prefsStore = newStore({ sessions: ['state', 'label', 'project'] });
    const { result } = renderHookWithProviders(() => useColumnChoice('sessions', ALL, REQUIRED, DEFAULTS), {
      prefsStore,
    });
    act(() => {
      result.current.toggle('project', false);
    });
    expect(prefsStore.getSnapshot().tableColumns).toEqual({});
    expect(result.current.isDefault).toBe(true);
  });

  it('cannot turn a required column off', () => {
    const prefsStore = newStore();
    const { result } = renderHookWithProviders(() => useColumnChoice('sessions', ALL, REQUIRED, DEFAULTS), {
      prefsStore,
    });
    act(() => {
      result.current.toggle('label', false);
    });
    expect(result.current.selected).toContain('label');
  });

  it('forgets the stored choice on reset', () => {
    const prefsStore = newStore({ sessions: ['label', 'models'], other: ['a'] });
    const { result } = renderHookWithProviders(() => useColumnChoice('sessions', ALL, REQUIRED, DEFAULTS), {
      prefsStore,
    });
    expect(result.current.selected).toEqual(['label', 'models']);
    act(() => {
      result.current.reset();
    });
    expect(prefsStore.getSnapshot().tableColumns).toEqual({ other: ['a'] });
    expect(result.current.selected).toEqual(DEFAULTS);
  });
});

describe('ColumnChooser', () => {
  function render() {
    const prefsStore = newStore();
    renderWithIntl(<ColumnChooser tableId="sessions" options={OPTIONS} defaults={DEFAULTS} />, { prefsStore });
    return prefsStore;
  }

  it('lists every column with the default ones ticked and the required one fixed', async () => {
    const user = userEvent.setup();
    render();
    await user.click(screen.getByRole('button', { name: msg('sessions.columns.button') }));
    const panel = screen.getByRole('dialog', { name: msg('sessions.columns.panel') });
    const boxes = within(panel).getAllByRole('checkbox');
    expect(boxes.map((box) => box.closest('label')?.textContent)).toEqual([
      'FIXTURE state',
      `FIXTURE session${msg('sessions.columns.required')}`,
      'FIXTURE project',
      'FIXTURE model',
    ]);
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, true, false, false]);
    expect(within(panel).getByRole('checkbox', { name: /FIXTURE session/ })).toBeDisabled();
    expect(within(panel).getByText(msg('sessions.columns.hint'))).toBeInTheDocument();
  });

  it('stores a ticked column in the preference and resets it', async () => {
    const user = userEvent.setup();
    const prefsStore = render();
    await user.click(screen.getByRole('button', { name: msg('sessions.columns.button') }));
    expect(screen.getByRole('button', { name: msg('sessions.columns.reset') })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'FIXTURE project' }));
    expect(prefsStore.getSnapshot().tableColumns).toEqual({ sessions: ['state', 'label', 'project'] });
    expect(screen.getByRole('checkbox', { name: 'FIXTURE project' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: msg('sessions.columns.reset') }));
    expect(prefsStore.getSnapshot().tableColumns).toEqual({});
    expect(screen.getByRole('checkbox', { name: 'FIXTURE project' })).not.toBeChecked();
  });

  it('is named in Vietnamese when the language is Vietnamese', () => {
    renderWithIntl(<ColumnChooser tableId="sessions" options={OPTIONS} defaults={DEFAULTS} />, { locale: 'vi' });
    expect(screen.getByRole('button', { name: msg('sessions.columns.button', undefined, 'vi') })).toBeVisible();
  });
});
