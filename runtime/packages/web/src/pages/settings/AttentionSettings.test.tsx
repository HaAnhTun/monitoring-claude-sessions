// TC-ATT-15, 16 (ADR 0107): the Attention card of the display preferences. The browser is asked for the permission to notify
// only by a click on the button; a blocked permission disables the checkbox; there is no tone control.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createPrefs } from '../../lib/prefs.ts';
import type { NotificationPermissionState } from '../../state/attention-env.ts';
import { createPrefsStore } from '../../state/prefs-store.ts';
import { makeInstance } from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { AttentionSettings, type NotificationPermissionEnv } from './AttentionSettings.tsx';

function fakeEnv(initial: NotificationPermissionState, answer: NotificationPermissionState = 'granted') {
  const env = {
    read: vi.fn(() => Promise.resolve(initial)),
    request: vi.fn(() => Promise.resolve(answer)),
  } satisfies NotificationPermissionEnv;
  return env;
}

function renderCard(env: NotificationPermissionEnv, kind: 'user' | 'task' = 'user') {
  const store = createPrefsStore(createPrefs(null));
  const rendered = renderWithProviders(<AttentionSettings env={env} />, {
    instance: makeInstance({ kind }),
    prefsStore: store,
  });
  return { ...rendered, store };
}

describe('AttentionSettings', () => {
  it('shows the rows with their defaults and asks the browser only when the button is clicked', async () => {
    const user = userEvent.setup();
    const env = fakeEnv('default');
    const { store } = renderCard(env);
    const card = screen.getByRole('region', { name: msg('settings.attention.title') });

    expect(within(card).getByRole('checkbox', { name: new RegExp(msg('settings.attention.tabTitle')) })).toBeChecked();
    expect(within(card).getByRole('checkbox', { name: new RegExp(msg('settings.attention.favicon')) })).toBeChecked();
    const notify = within(card).getByRole('checkbox', { name: new RegExp(msg('settings.attention.notify')) });
    expect(notify).not.toBeChecked();
    expect(within(card).getByRole('radio', { name: msg('settings.attention.scope.here') })).toBeChecked();
    expect(within(card).getByRole('radio', { name: msg('settings.attention.titles.named') })).toBeChecked();
    expect(within(card).getByRole('spinbutton', { name: msg('settings.attention.delay') })).toHaveValue(5);
    // no tone control (the tone was cut)
    expect(within(card).getAllByRole('checkbox')).toHaveLength(3);

    // turning the notification on asks the browser nothing
    await user.click(notify);
    expect(store.getSnapshot().attentionNotify).toBe(true);
    expect(await within(card).findByText(msg('settings.attention.permission.default'))).toBeVisible();
    expect(env.request).not.toHaveBeenCalled();

    await user.click(within(card).getByRole('button', { name: msg('settings.attention.permission.allow') }));
    expect(env.request).toHaveBeenCalledTimes(1);
    expect(await within(card).findByText(msg('settings.attention.permission.granted'))).toBeVisible();
    expect(within(card).queryByRole('button', { name: msg('settings.attention.permission.allow') })).toBeNull();

    await user.click(within(card).getByRole('radio', { name: msg('settings.attention.titles.off') }));
    expect(store.getSnapshot().workspaceTitles).toBe('off');
    const delay = within(card).getByRole('spinbutton', { name: msg('settings.attention.delay') });
    await user.clear(delay);
    await user.type(delay, '12');
    expect(store.getSnapshot().attentionDelaySeconds).toBe(12);
  });

  it('disables the notification while the browser blocks it, and has no scope choice on a task instance', async () => {
    const env = fakeEnv('denied');
    const { store } = renderCard(env, 'task');
    store.setPref('attentionNotify', true);
    const card = screen.getByRole('region', { name: msg('settings.attention.title') });

    expect(await within(card).findByText(msg('settings.attention.permission.denied'))).toBeVisible();
    const notify = within(card).getByRole('checkbox', { name: new RegExp(msg('settings.attention.notify')) });
    await waitFor(() => {
      expect(notify).toBeDisabled();
    });
    expect(notify).not.toBeChecked();
    expect(within(card).queryByRole('button', { name: msg('settings.attention.permission.allow') })).toBeNull();
    expect(within(card).queryByRole('radio', { name: msg('settings.attention.scope.here') })).toBeNull();
    expect(env.request).not.toHaveBeenCalled();
  });
});
