// The "Recent sessions" group and its quiet button that opens a session in a window of the person's own terminal (CAW-145, design 09
// B7): the button exists only where the capabilities say `nativeOpen`, never on a task instance or before the browser holds the
// session, and it opens the same dialog with the native target.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';

import { createFakeApi, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import {
  makeAuthSession,
  makeInstance,
  makeResumeEligibility,
  makeSession,
  makeSessionPage,
  makeTerminalCapabilities,
  makeTerminalState,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { RecentRows } from './RecentRows.tsx';

const A = makeSession({ id: sessionId(1), label: 'FIXTURE first conversation' });
const B = makeSession({ id: sessionId(2), seq: 2, label: 'FIXTURE second conversation' });

interface Options {
  kind?: 'user' | 'task';
  authenticated?: boolean;
  nativeOpen?: boolean | undefined;
  handlers?: FakeHandlers;
  locale?: 'en' | 'vi';
}

function setup(o: Options = {}) {
  const capabilities = makeTerminalCapabilities(o.nativeOpen === undefined ? {} : { nativeOpen: o.nativeOpen });
  const api: FakeApi = createFakeApi({
    instance: () => makeInstance({ kind: o.kind ?? 'user' }),
    authSession: () => makeAuthSession(o.authenticated ?? true),
    terminalState: () => makeTerminalState([], { capabilities }),
    listSessions: () => makeSessionPage([A, B]),
    sessionResume: () => makeResumeEligibility(1),
    ...o.handlers,
  });
  const onResume = vi.fn();
  const rendered = renderWithIntl(<RecentRows folderKey="fixture-app-1" live={[]} onResume={onResume} />, {
    api,
    instance: makeInstance({ kind: o.kind ?? 'user' }),
    locale: o.locale ?? 'en',
  });
  return { ...rendered, api, onResume };
}

const nativeName = (label: string): string => [msg('workspace.recent.openNative'), label].join(' ');

describe('RecentRows: open in the native terminal', () => {
  it('adds a quiet button to every row, named with the session, when the capabilities say nativeOpen', async () => {
    setup({ nativeOpen: true });
    const first = await screen.findByRole('button', { name: nativeName(A.label) });
    expect(screen.getByRole('button', { name: nativeName(B.label) })).toBeInTheDocument();
    expect(first).toHaveAttribute('data-nav-item');
    expect(first).toHaveAttribute('data-nav-id', `native:${A.id}`);
    expect(first).toHaveAttribute('title', msg('workspace.recent.openNativeTip'));
    // the Resume button stays beside it
    expect(screen.getAllByRole('button', { name: new RegExp(`^${msg('workspace.recent.resume')} `) })).toHaveLength(2);
  });

  it.each([
    ['absent', undefined],
    ['false', false],
  ])('adds no button when nativeOpen is %s', async (_name, nativeOpen) => {
    setup({ nativeOpen });
    await screen.findAllByRole('button', { name: new RegExp(`^${msg('workspace.recent.resume')} `) });
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });
    expect(screen.queryByRole('button', { name: new RegExp(msg('workspace.recent.openNative')) })).toBeNull();
  });

  it('adds no button, and asks for no terminal state, before the browser holds the session', async () => {
    const { api } = setup({ authenticated: false, nativeOpen: true });
    await screen.findByText(A.label);
    expect(screen.queryByRole('button', { name: new RegExp(msg('workspace.recent.openNative')) })).toBeNull();
    expect(api.callsTo('terminalState')).toHaveLength(0);
  });

  it('opens the dialog of the native target for that session, and asks the page nothing', async () => {
    const user = userEvent.setup();
    const { api, onResume } = setup({
      nativeOpen: true,
      handlers: { terminalOpenNative: () => ({ via: 'windows-terminal', fork: false }) },
    });
    const button = await screen.findByRole('button', { name: nativeName(B.label) });
    await user.click(button);
    expect(await screen.findByRole('dialog', { name: msg('workspace.dialog.native.title') })).toBeInTheDocument();
    await waitFor(() => {
      expect(api.callsTo('sessionResume')[0]?.params).toEqual({ sessionId: B.id });
    });
    expect(onResume).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: msg('workspace.dialog.native.confirm') }));
    await waitFor(() => {
      expect(api.callsTo('terminalOpenNative')).toHaveLength(1);
    });
    expect(api.callsTo('terminalOpenNative')[0]?.body).toEqual({ sessionId: B.id, fork: false });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(api.callsTo('terminalResume')).toHaveLength(0);
  });

  it('keeps the Resume button asking the page, as before', async () => {
    const user = userEvent.setup();
    const { onResume } = setup({ nativeOpen: true });
    await user.click(await screen.findByRole('button', { name: `${msg('workspace.recent.resume')} ${A.label}` }));
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ id: A.id }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has no axe violation with the buttons, and with the dialog open (en and vi)', async () => {
    for (const locale of ['en', 'vi'] as const) {
      const user = userEvent.setup();
      const rendered = setup({ nativeOpen: true, locale });
      const button = await screen.findByRole('button', {
        name: [msg('workspace.recent.openNative', undefined, locale), A.label].join(' '),
      });
      const before = await axe.run(rendered.container, { rules: { 'color-contrast': { enabled: false } } });
      expect(
        before.violations.map((violation) => violation.id),
        `buttons ${locale}`,
      ).toEqual([]);
      await user.click(button);
      await screen.findByRole('dialog');
      const open = await axe.run(rendered.container, { rules: { 'color-contrast': { enabled: false } } });
      expect(
        open.violations.map((violation) => violation.id),
        `dialog ${locale}`,
      ).toEqual([]);
      rendered.unmount();
    }
  });
});
