import type { HealthReport, InstanceInfo } from '@mcs/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { qk } from '../data/query-keys.ts';
import { AnnouncerProvider } from '../state/announcer.tsx';
import { createFakeApi, type FakeApi } from '../test/fake-api.ts';
import {
  FIXTURE_INSTANCE_ID,
  makeHealth,
  makeInstance,
  makeTerminalSession,
  makeTerminalState,
} from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { OutdatedNotice } from './OutdatedNotice.tsx';

// TC-UI-13 (design 04 4.7): a user instance whose running code is older than the files on disk says so, counts the running
// terminals from the cached state without fetching it, and offers the command to copy. No restart button.

const RESTART = 'caw restart';

function healthOf(outdated: boolean): HealthReport {
  const base = makeHealth('ok');
  return { ...base, runtime: { ...base.runtime, outdated } };
}

interface Options {
  kind?: InstanceInfo['kind'];
  outdated?: boolean;
  /** The terminal state in the cache before the render; `null` leaves the cache empty. */
  running?: number | null;
  locale?: 'en' | 'vi';
}

function renderNotice(options: Options = {}) {
  const instance = makeInstance({
    kind: options.kind ?? 'user',
    commands: { ...makeInstance().commands, restart: RESTART },
  });
  const api: FakeApi = createFakeApi({
    instance: () => instance,
    health: () => healthOf(options.outdated ?? true),
    terminalState: () => makeTerminalState([]),
  });
  const running = options.running === undefined ? 0 : options.running;
  const rendered = renderWithIntl(<OutdatedNotice />, {
    api,
    instance,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    wrap: (children: ReactNode) => <AnnouncerProvider>{children}</AnnouncerProvider>,
  });
  if (running !== null) {
    rendered.queryClient.setQueryData(
      qk.terminalState(FIXTURE_INSTANCE_ID),
      makeTerminalState(Array.from({ length: running }, (_, index) => makeTerminalSession(index + 1))),
    );
  }
  return { ...rendered, api };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OutdatedNotice', () => {
  it('shows the note with the restart command when the user instance is outdated', async () => {
    renderNotice();
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(msg('shell.outdated.body', { command: RESTART }));
    expect(within(note).getByText(RESTART)).toBeInTheDocument();
    expect(within(note).queryByText(/--force/)).toBeNull();
  });

  it('is hidden while the code is current', async () => {
    const { api } = renderNotice({ outdated: false });
    await waitFor(() => {
      expect(api.callsTo('health').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('is hidden for a task instance even when it is outdated', async () => {
    const { api } = renderNotice({ kind: 'task' });
    await waitFor(() => {
      expect(api.callsTo('health').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('counts the running terminals from the cached state, offers the force command and fetches nothing', async () => {
    const { api } = renderNotice({ running: 2 });
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(msg('shell.outdated.terminals', { count: 2 }));
    expect(api.callsTo('terminalState')).toHaveLength(0);
    expect(within(note).getByText(`${RESTART} --force`)).toBeInTheDocument();
  });

  it('says "one running terminal" for a single terminal', async () => {
    renderNotice({ running: 1 });
    expect(await screen.findByRole('note')).toHaveTextContent(msg('shell.outdated.terminals', { count: 1 }));
  });

  it('names no count and no force when no terminal is running, and with nothing cached', async () => {
    for (const running of [0, null]) {
      const { unmount, api } = renderNotice({ running });
      const note = await screen.findByRole('note');
      expect(note).not.toHaveTextContent(/running terminal/);
      expect(within(note).getByText(RESTART)).toBeInTheDocument();
      expect(within(note).queryByText(/--force/)).toBeNull();
      expect(api.callsTo('terminalState')).toHaveLength(0);
      unmount();
    }
  });

  it('copies the command with a button and has no restart button', async () => {
    vi.stubGlobal('isSecureContext', true);
    const user = userEvent.setup();
    renderNotice({ running: 3 });
    const note = await screen.findByRole('note');
    const buttons = within(note).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(msg('shell.outdated.copy'));
    expect(within(note).queryByRole('button', { name: /restart now|restart the/i })).toBeNull();
    await user.click(buttons[0]!);
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(`${RESTART} --force`);
    });
  });

  it('copies the plain command when nothing is running', async () => {
    vi.stubGlobal('isSecureContext', true);
    const user = userEvent.setup();
    renderNotice({ running: 0 });
    await user.click(await screen.findByRole('button', { name: msg('shell.outdated.copy') }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(RESTART);
    });
  });

  it('reads in Vietnamese through the catalogue', async () => {
    renderNotice({ running: 2, locale: 'vi' });
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(msg('shell.outdated.terminals', { count: 2 }, 'vi'));
    expect(within(note).getByRole('button', { name: msg('shell.outdated.copy', undefined, 'vi') })).toBeInTheDocument();
  });
});
