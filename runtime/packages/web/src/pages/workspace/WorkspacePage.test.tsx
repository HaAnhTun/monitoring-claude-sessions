import type { Folder, TerminalState } from '@mcs/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { qk } from '../../data/query-keys.ts';
import { createPrefs } from '../../lib/prefs.ts';
import { AnnouncerProvider } from '../../state/announcer.tsx';
import { createPrefsStore, type PrefsStore } from '../../state/prefs-store.ts';
import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { createToastStore, ToastStoreContext, type ToastStore } from '../../state/toast-store.ts';
import { MQ_LIST_OVERLAY } from '../../state/use-media-query.ts';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import { createFakeEventSources, type FakeEventSources } from '../../test/fake-event-source.ts';
import { fakeSeams, handshake, stubResizeObserver, type FakeTerminalSeams } from '../../test/fake-terminal.ts';
import {
  FIXTURE_EPOCH,
  FIXTURE_INSTANCE_ID,
  iso,
  makeAuthSession,
  makeFolder,
  makeFolderList,
  makeInstance,
  makeLinkedTerminalSession,
  makeSession,
  makeSessionPage,
  makeTerminalSession,
  makeTerminalState,
  makeUnavailableTerminalState,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { TerminalSeamsContext } from '../../terminal/seams.ts';
import { WorkspacePage } from './WorkspacePage.tsx';

// Design 04 2.2, 6 and 8, with the real providers and the fakes of the seams: the address is the selection, a click asks for the
// focus once, the dialogs start, stop and resume, the events stream moves the list. TC-UI ids are in the titles.

interface Rig {
  api: FakeApi;
  fake: FakeTerminalSeams;
  sources: FakeEventSources;
  prefsStore: PrefsStore;
  toasts: ToastStore;
  rendered: ReturnType<typeof renderWithIntl>;
  /** The state the fake server answers; a test replaces it before the next fetch. */
  server: { state: TerminalState; authenticated: boolean };
}

interface Options {
  route?: string;
  kind?: 'user' | 'task';
  state?: TerminalState;
  folders?: Folder[];
  authenticated?: boolean;
  handlers?: FakeHandlers;
  locale?: 'en' | 'vi';
  prefsStore?: PrefsStore;
  monitor?: ReturnType<typeof makeSession>[];
}

function Probe() {
  const location = useLocation();
  return (
    <output data-testid="location" data-state={JSON.stringify(location.state)}>
      {location.pathname + location.search}
    </output>
  );
}

function stubOverlay(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      media: query,
      matches: matches && query === MQ_LIST_OVERLAY,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

function renderPage(options: Options = {}): Rig {
  stubResizeObserver();
  const fake = fakeSeams();
  const sources = createFakeEventSources();
  function FakeEventSourceConstructor(url: string) {
    return sources.factory(url);
  }
  vi.stubGlobal('EventSource', FakeEventSourceConstructor);
  const server = {
    state: options.state ?? makeTerminalState([makeTerminalSession(1), makeTerminalSession(2)]),
    authenticated: options.authenticated ?? true,
  };
  const instance = makeInstance({ kind: options.kind ?? 'user' });
  const api = createFakeApi({
    instance: () => instance,
    authSession: () => makeAuthSession(server.authenticated),
    terminalState: () => server.state,
    listFolders: () => makeFolderList(options.folders ?? [makeFolder(1, { activity: 'full' }), makeFolder(2)]),
    listSessions: (query) => makeSessionPage(query.has('session') ? (options.monitor ?? []) : []),
    ...options.handlers,
  });
  const prefsStore = options.prefsStore ?? createPrefsStore(createPrefs(null));
  const toasts = createToastStore();
  const rendered = renderWithIntl(
    <>
      <Probe />
      <Routes>
        <Route path="/" element={<WorkspacePage />} />
        <Route path="/overview" element={<h1>Overview page</h1>} />
      </Routes>
    </>,
    {
      api,
      instance,
      prefsStore,
      route: options.route ?? '/',
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      wrap: (children: ReactNode) => (
        <TerminalSeamsContext value={fake.seams}>
          <AnnouncerProvider>
            <ShortcutRegistryProvider>
              <ToastStoreContext value={toasts}>{children}</ToastStoreContext>
            </ShortcutRegistryProvider>
          </AnnouncerProvider>
        </TerminalSeamsContext>
      ),
    },
  );
  return { api, fake, sources, prefsStore, toasts, rendered, server };
}

const where = (): string => screen.getByTestId('location').textContent;
const regionOf = (name: string, locale: 'en' | 'vi' = 'en'): Promise<HTMLElement> =>
  screen.findByRole('group', { name: msg('terminal.region', { name }, locale) });
const sidebar = (locale: 'en' | 'vi' = 'en'): Promise<HTMLElement> =>
  screen.findByRole('navigation', { name: msg('workspace.sidebar.label', undefined, locale) });

async function rowOf(name: string): Promise<HTMLElement> {
  const nav = await sidebar();
  return await within(nav).findByRole('link', { name: new RegExp(name) });
}

/** Opens the socket of the last session: the server says `ready` and `live`, so the view is live. */
async function goLive(rig: Rig): Promise<void> {
  await waitFor(() => {
    expect(rig.fake.sockets.instances.length).toBeGreaterThan(0);
  });
  act(() => {
    handshake(rig.fake.sockets.last(), { cols: 120, rows: 30 });
  });
}

function toastTexts(rig: Rig): string[] {
  return rig.toasts.getSnapshot().map((toast) => toast.message);
}

beforeEach(() => {
  stubOverlay(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which page it is', () => {
  it('sends a task instance to the Overview, where the old landing page lives', async () => {
    renderPage({ kind: 'task' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview page' })).toBeInTheDocument();
    expect(where()).toBe('/overview');
  });

  it('shows the project column and the pane of a user instance, with one h1', async () => {
    renderPage();
    await sidebar();
    expect(
      await screen.findByRole('heading', { level: 1, name: msg('workspace.pane.none.title') }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe(`${msg('route.workspace.title')} - ${msg('shell.appTitle')}`);
  });

  it('TC-UI-10 shows the locked state, and asks for nothing the session protects, without the cookie', async () => {
    const rig = renderPage({ authenticated: false });
    expect(await screen.findByRole('heading', { level: 1, name: msg('access.locked.title') })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: msg('workspace.sidebar.label') })).toBeNull();
    expect(rig.api.callsTo('terminalState')).toHaveLength(0);
    expect(rig.api.callsTo('listFolders')).toHaveLength(0);
    expect(rig.sources.instances).toHaveLength(0);
  });

  it('TC-UI-10 turns to the locked state when a request answers access_required', async () => {
    renderPage({ handlers: { terminalState: () => errorResponse('access_required') } });
    expect(await screen.findByRole('heading', { level: 1, name: msg('access.locked.title') })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('TC-UI-10 says why terminals are unavailable, and draws no project column', async () => {
    renderPage({ state: makeUnavailableTerminalState('claude_not_found') });
    expect(
      await screen.findByRole('heading', { level: 1, name: msg('terminal.unavailable.claude.title') }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: msg('workspace.sidebar.label') })).toBeNull();
    expect(screen.queryByRole('button', { name: msg('workspace.pane.toggleList') })).toBeNull();
  });

  it('shows a failed first load with a retry that asks again', async () => {
    const user = userEvent.setup();
    let fail = true;
    const rig = renderPage({
      handlers: { terminalState: () => (fail ? errorResponse('internal_error') : makeTerminalState([])) },
    });
    const alert = await screen.findByRole('alert');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    fail = false;
    await user.click(within(alert).getByRole('button', { name: msg('common.retryNow') }));
    expect(
      await screen.findByRole('heading', { level: 1, name: msg('workspace.pane.none.title') }),
    ).toBeInTheDocument();
    expect(rig.api.callsTo('terminalState').length).toBeGreaterThan(1);
  });
});

describe('the selection is the address', () => {
  it('opens the session named by ?session= with its header, its row marked and its terminal', async () => {
    renderPage({ route: '/?session=fixture-term-2' });
    expect(await screen.findByRole('heading', { level: 1, name: 'fixture-term-2' })).toBeInTheDocument();
    await regionOf('fixture-term-2');
    expect(await rowOf('fixture-term-2')).toHaveAttribute('aria-current', 'true');
    expect(await rowOf('fixture-term-1')).not.toHaveAttribute('aria-current');
    expect(document.title).toBe(`fixture-term-2 - ${msg('shell.appTitle')}`);
  });

  it('says that a named session is not running, once the list is known, and links to the bare page', async () => {
    renderPage({ route: '/?session=fixture-term-9' });
    expect(
      await screen.findByRole('heading', { level: 1, name: msg('workspace.pane.notFound.title') }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('route.workspace.title') })).toHaveAttribute('href', '/');
  });

  it('treats a name that is no terminal name as none, and never repeats the text of the address', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { rendered } = renderPage({ route: `/?session=${encodeURIComponent(hostile)}` });
    expect(
      await screen.findByRole('heading', { level: 1, name: msg('workspace.pane.none.title') }),
    ).toBeInTheDocument();
    expect(rendered.container.querySelector('img')).toBeNull();
    expect(rendered.container.querySelector('.workspace')?.textContent).not.toContain('onerror');
  });

  it('restores the last session from the preference on a bare "/" when it still runs, once', async () => {
    const prefsStore = createPrefsStore(createPrefs(null));
    prefsStore.setPref('lastTerminal', 'fixture-term-2');
    renderPage({ prefsStore });
    expect(await screen.findByRole('heading', { level: 1, name: 'fixture-term-2' })).toBeInTheDocument();
    expect(where()).toBe('/?session=fixture-term-2');
  });

  it('does not restore a session that no longer runs', async () => {
    const prefsStore = createPrefsStore(createPrefs(null));
    prefsStore.setPref('lastTerminal', 'fixture-term-9');
    renderPage({ prefsStore });
    expect(
      await screen.findByRole('heading', { level: 1, name: msg('workspace.pane.none.title') }),
    ).toBeInTheDocument();
    expect(where()).toBe('/');
  });

  it('remembers the selected session for the next visit', async () => {
    const rig = renderPage({ route: '/?session=fixture-term-1' });
    await regionOf('fixture-term-1');
    await waitFor(() => {
      expect(rig.prefsStore.getSnapshot().lastTerminal).toBe('fixture-term-1');
    });
  });

  it('selecting a row changes only the query, and the pathname stays "/"', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await rowOf('fixture-term-2'));
    expect(await screen.findByRole('heading', { level: 1, name: 'fixture-term-2' })).toBeInTheDocument();
    expect(where()).toBe('/?session=fixture-term-2');
  });
});

describe('TC-UI-12 focus', () => {
  it('gives the terminal the focus on live after a click on a row, and clears the request from the history', async () => {
    const user = userEvent.setup();
    const rig = renderPage();
    await user.click(await rowOf('fixture-term-1'));
    await regionOf('fixture-term-1');
    await waitFor(() => {
      expect(screen.getByTestId('location').dataset['state']).toBe('null');
    });
    await goLive(rig);
    const terminal = rig.fake.engine.last().terminal;
    expect(document.activeElement).toBe(terminal.textarea);
  });

  it('does not take the focus for a session opened from the address, a reload or Back', async () => {
    const rig = renderPage({ route: '/?session=fixture-term-1' });
    await regionOf('fixture-term-1');
    await goLive(rig);
    expect(rig.fake.engine.last().terminal.focusCount).toBe(0);
  });

  it('leaves the terminal with Ctrl+Shift+Space to the row of the session, and "t" brings the focus back', async () => {
    const user = userEvent.setup();
    const rig = renderPage();
    await user.click(await rowOf('fixture-term-1'));
    await regionOf('fixture-term-1');
    await goLive(rig);
    const terminal = rig.fake.engine.last().terminal;
    expect(document.activeElement).toBe(terminal.textarea);
    act(() => {
      terminal.pressKey({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    });
    const row = await rowOf('fixture-term-1');
    expect(row).toHaveFocus();
    fireEvent.keyDown(row, { key: 't' });
    expect(document.activeElement).toBe(terminal.textarea);
  });

  it('does not register "t" while no session is open', async () => {
    const rig = renderPage();
    await sidebar();
    fireEvent.keyDown(document.body, { key: 't' });
    expect(rig.fake.engine.instances).toHaveLength(0);
  });
});

describe('TC-UI-02 a new session', () => {
  it('asks first, sends one create request with the folder, selects the row and focuses the terminal', async () => {
    const user = userEvent.setup();
    const created = makeTerminalSession(5);
    const rig = renderPage({
      handlers: {
        terminalCreateSession: () => {
          rig.server.state = makeTerminalState([makeTerminalSession(1), makeTerminalSession(2), created]);
          return { session: created };
        },
      },
    });
    const nav = await sidebar();
    await user.click(
      (await within(nav).findAllByRole('button', { name: new RegExp(msg('workspace.newSession')) }))[0]!,
    );
    const dialog = await screen.findByRole('dialog', { name: msg('workspace.dialog.new.title') });
    await user.click(within(dialog).getByRole('button', { name: msg('workspace.dialog.new.confirm') }));
    expect(await screen.findByRole('heading', { level: 1, name: created.name })).toBeInTheDocument();
    expect(rig.api.callsTo('terminalCreateSession')).toHaveLength(1);
    expect(rig.api.callsTo('terminalCreateSession')[0]?.headers['x-mcs-request']).toBe('1');
    expect(where()).toBe(`/?session=${created.name}`);
    expect(toastTexts(rig)).toContain(msg('workspace.toast.started', { name: created.name }));
    await regionOf(created.name);
    await goLive(rig);
    expect(document.activeElement).toBe(rig.fake.engine.last().terminal.textarea);
  });

  it('starts nothing when the dialog is cancelled', async () => {
    const user = userEvent.setup();
    const rig = renderPage();
    const nav = await sidebar();
    await user.click(
      (await within(nav).findAllByRole('button', { name: new RegExp(msg('workspace.newSession')) }))[0]!,
    );
    await user.click(await screen.findByRole('button', { name: msg('workspace.dialog.cancel') }));
    expect(rig.api.callsTo('terminalCreateSession')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('TC-UI-03 another folder', () => {
  async function clickOtherFolder(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    const nav = await sidebar();
    await user.click(await within(nav).findByRole('button', { name: msg('workspace.otherFolder') }));
  }

  it('starts in the folder the picker answers: the folder is added, one create request, the session selected', async () => {
    const user = userEvent.setup();
    const created = makeTerminalSession(6, { path: '/fixture/picked/app' });
    const rig = renderPage({
      handlers: {
        terminalPickFolder: () => ({ path: '/fixture/picked/app' }),
        addFolder: () => makeFolder(6, { path: '/fixture/picked/app' }),
        terminalCreateSession: () => {
          rig.server.state = makeTerminalState([created]);
          return { session: created };
        },
      },
    });
    await clickOtherFolder(user);
    expect(await screen.findByRole('heading', { level: 1, name: created.name })).toBeInTheDocument();
    expect(rig.api.callsTo('terminalPickFolder')).toHaveLength(1);
    expect(rig.api.callsTo('addFolder')).toHaveLength(1);
    expect(rig.api.callsTo('terminalCreateSession')).toHaveLength(1);
    expect(rig.api.callsTo('terminalCreateSession')[0]?.body).toEqual({ path: '/fixture/picked/app' });
  });

  it('does nothing when the dialog of the computer was closed', async () => {
    const user = userEvent.setup();
    const rig = renderPage({ handlers: { terminalPickFolder: () => ({ path: null }) } });
    await clickOtherFolder(user);
    await waitFor(() => {
      expect(rig.api.callsTo('terminalPickFolder')).toHaveLength(1);
    });
    expect(rig.api.callsTo('terminalCreateSession')).toHaveLength(0);
    expect(rig.toasts.getSnapshot()).toHaveLength(0);
  });

  it('does not open a second picker while the first is open', async () => {
    const user = userEvent.setup();
    let release: (value: { path: null }) => void = () => undefined;
    const pending = new Promise<{ path: null }>((resolve) => {
      release = resolve;
    });
    const rig = renderPage({ handlers: { terminalPickFolder: () => pending } });
    await clickOtherFolder(user);
    await clickOtherFolder(user);
    expect(rig.api.callsTo('terminalPickFolder')).toHaveLength(1);
    release({ path: null });
    await waitFor(() => {
      expect(rig.api.callsTo('terminalPickFolder')).toHaveLength(1);
    });
  });

  it('says that a folder dialog is already open (picker_busy) and starts nothing', async () => {
    const user = userEvent.setup();
    const rig = renderPage({ handlers: { terminalPickFolder: () => errorResponse('picker_busy') } });
    await clickOtherFolder(user);
    await waitFor(() => {
      expect(toastTexts(rig)).toHaveLength(1);
    });
    expect(toastTexts(rig)[0]).toContain(msg('error.handling.pickerBusy').replace(/[. ]+$/u, ''));
    expect(rig.toasts.getSnapshot()[0]?.kind).toBe('error');
    expect(rig.api.callsTo('terminalCreateSession')).toHaveLength(0);
  });

  it('asks for the path by typing when the computer has no picker', async () => {
    const user = userEvent.setup();
    const rig = renderPage({ handlers: { terminalPickFolder: () => errorResponse('terminal_unavailable') } });
    await clickOtherFolder(user);
    expect(await screen.findByRole('dialog', { name: msg('workspace.dialog.folder.title') })).toBeInTheDocument();
    expect(rig.api.callsTo('terminalCreateSession')).toHaveLength(0);
  });

  it('asks for the path by typing at once when the capabilities say there is no picker', async () => {
    const user = userEvent.setup();
    const state = makeTerminalState([], {
      capabilities: { available: true, reason: null, folderPicker: false, resume: true, maxSessions: 8 },
    });
    const rig = renderPage({ state });
    await clickOtherFolder(user);
    expect(await screen.findByRole('dialog', { name: msg('workspace.dialog.folder.title') })).toBeInTheDocument();
    expect(rig.api.callsTo('terminalPickFolder')).toHaveLength(0);
  });
});

describe('TC-UI-04 the list follows the server', () => {
  async function openStream(rig: Rig): Promise<void> {
    await waitFor(() => {
      expect(rig.sources.instances.length).toBeGreaterThan(0);
    });
    act(() => {
      rig.sources.last().open();
      rig.sources.last().emit('hello', {
        instanceId: FIXTURE_INSTANCE_ID,
        epoch: FIXTURE_EPOCH,
        serverTime: iso(0),
        heartbeatMs: 15_000,
      });
    });
  }

  it('shows a session that appears and drops one that ended, with the state and tokens of a linked session', async () => {
    const rig = renderPage({
      state: makeTerminalState([makeTerminalSession(1)]),
      monitor: [makeSession({ id: sessionId(3) })],
    });
    await rowOf('fixture-term-1');
    await openStream(rig);
    act(() => {
      rig.sources
        .last()
        .emit('sessions', { version: 1, sessions: [makeTerminalSession(1), makeLinkedTerminalSession(3)] });
    });
    const appeared = await rowOf('fixture-term-3');
    await waitFor(() => {
      expect(within(appeared).getAllByText(/./u).length).toBeGreaterThan(1);
    });
    expect(appeared.querySelector('.badge--state')).not.toBeNull();
    act(() => {
      rig.sources.last().emit('sessions', { version: 2, sessions: [makeTerminalSession(1)] });
    });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /fixture-term-3/u })).toBeNull();
    });
    expect(rig.api.callsTo('terminalState').length).toBeGreaterThanOrEqual(1);
  });

  it('ends the open session when the list says it left, keeping its screen under the banner', async () => {
    const rig = renderPage({ route: '/?session=fixture-term-1' });
    await regionOf('fixture-term-1');
    await openStream(rig);
    await goLive(rig);
    act(() => {
      rig.sources.last().emit('sessions', { version: 1, sessions: [makeTerminalSession(2)] });
    });
    expect(await screen.findByRole('region', { name: msg('terminal.ended.title') })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'fixture-term-1' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: msg('terminal.region', { name: 'fixture-term-1' }) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: msg('workspace.pane.stop') })).toBeNull();
  });

  it('keeps the banner until another session is selected, then shows that one', async () => {
    const user = userEvent.setup();
    const rig = renderPage({ route: '/?session=fixture-term-1' });
    await regionOf('fixture-term-1');
    await openStream(rig);
    await goLive(rig);
    act(() => {
      rig.sources.last().emit('sessions', { version: 1, sessions: [makeTerminalSession(2)] });
    });
    await screen.findByRole('region', { name: msg('terminal.ended.title') });
    await user.click(await rowOf('fixture-term-2'));
    expect(await screen.findByRole('heading', { level: 1, name: 'fixture-term-2' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: msg('terminal.ended.title') })).toBeNull();
  });
});

describe('TC-UI-05 stopping a session', () => {
  it('asks first with Cancel focused, and Escape gives the focus back to the Stop button', async () => {
    const user = userEvent.setup();
    const rig = renderPage({ route: '/?session=fixture-term-1' });
    await regionOf('fixture-term-1');
    const stop = await screen.findByRole('button', { name: msg('workspace.pane.stop') });
    await user.click(stop);
    const dialog = await screen.findByRole('dialog', { name: msg('workspace.dialog.stop.title') });
    expect(within(dialog).getByRole('button', { name: msg('workspace.dialog.cancel') })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(stop).toHaveFocus();
    expect(rig.api.callsTo('terminalKillSession')).toHaveLength(0);
  });

  it('stops after the confirmation, forgets the session and selects the next one that runs', async () => {
    const user = userEvent.setup();
    const rig = renderPage({
      route: '/?session=fixture-term-1',
      handlers: {
        terminalKillSession: () => {
          rig.server.state = makeTerminalState([makeTerminalSession(2)]);
          return { name: 'fixture-term-1' };
        },
      },
    });
    await regionOf('fixture-term-1');
    await waitFor(() => {
      expect(rig.prefsStore.getSnapshot().lastTerminal).toBe('fixture-term-1');
    });
    await user.click(await screen.findByRole('button', { name: msg('workspace.pane.stop') }));
    const dialog = await screen.findByRole('dialog', { name: msg('workspace.dialog.stop.title') });
    await user.click(within(dialog).getByRole('button', { name: msg('workspace.dialog.stop.confirm') }));
    expect(await screen.findByRole('heading', { level: 1, name: 'fixture-term-2' })).toBeInTheDocument();
    expect(rig.api.callsTo('terminalKillSession')).toHaveLength(1);
    expect(toastTexts(rig)).toContain(msg('workspace.toast.stopped', { name: 'fixture-term-1' }));
    expect(where()).toBe('/?session=fixture-term-2');
  });

  it('goes to the bare page when it was the last session', async () => {
    const user = userEvent.setup();
    const rig = renderPage({
      route: '/?session=fixture-term-1',
      state: makeTerminalState([makeTerminalSession(1)]),
      handlers: {
        terminalKillSession: () => {
          rig.server.state = makeTerminalState([]);
          return { name: 'fixture-term-1' };
        },
      },
    });
    await regionOf('fixture-term-1');
    await user.click(await screen.findByRole('button', { name: msg('workspace.pane.stop') }));
    const dialog = await screen.findByRole('dialog', { name: msg('workspace.dialog.stop.title') });
    await user.click(within(dialog).getByRole('button', { name: msg('workspace.dialog.stop.confirm') }));
    expect(
      await screen.findByRole('heading', { level: 1, name: msg('workspace.pane.none.title') }),
    ).toBeInTheDocument();
    expect(where()).toBe('/');
    expect(rig.prefsStore.getSnapshot().lastTerminal).toBe('');
  });
});

describe('the ended banner starts again and resumes', () => {
  it('opens the dialog of a new session in the folder of the ended one', async () => {
    const user = userEvent.setup();
    const rig = renderPage({ route: '/?session=fixture-term-1' });
    await regionOf('fixture-term-1');
    await goLive(rig);
    act(() => {
      rig.fake.sockets.last().closeFromServer(4001);
    });
    await user.click(await screen.findByRole('button', { name: msg('terminal.ended.startAgain') }));
    const dialog = await screen.findByRole('dialog', { name: msg('workspace.dialog.new.title') });
    expect(within(dialog).getByText('/fixture/projects/app-1')).toBeInTheDocument();
  });
});

describe('the project list toggle (design 2.4)', () => {
  it('folds the column away from 1024 px and keeps that choice as a preference', async () => {
    const user = userEvent.setup();
    const rig = renderPage({ route: '/?session=fixture-term-1' });
    await regionOf('fixture-term-1');
    const toggle = screen.getByRole('button', { name: msg('workspace.pane.toggleList') });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(rig.prefsStore.getSnapshot().workspaceCollapsed).toBe(true);
    expect(rig.rendered.container.querySelector('.workspace')).toHaveAttribute('data-list', 'collapsed');
  });

  it('opens the list as an overlay below 1024 px and closes it after a selection', async () => {
    stubOverlay(true);
    const user = userEvent.setup();
    const rig = renderPage({ route: '/?session=fixture-term-1' });
    await regionOf('fixture-term-1');
    expect(rig.rendered.container.querySelector('.workspace')).toHaveAttribute('data-list', 'closed');
    await user.click(screen.getByRole('button', { name: msg('workspace.pane.toggleList') }));
    const dialog = await screen.findByRole('dialog', { name: msg('workspace.sidebar.label') });
    expect(rig.rendered.container.querySelector('.workspace')).toHaveAttribute('data-list', 'open');
    await user.click(within(dialog).getByRole('link', { name: /fixture-term-2/u }));
    expect(await screen.findByRole('heading', { level: 1, name: 'fixture-term-2' })).toBeInTheDocument();
    await waitFor(() => {
      expect(rig.rendered.container.querySelector('.workspace')).toHaveAttribute('data-list', 'closed');
    });
  });

  it('offers "Other folder" and the list on the notice of nothing selected where the column is hidden', async () => {
    stubOverlay(true);
    renderPage();
    expect(await screen.findByRole('button', { name: msg('workspace.otherFolder') })).toHaveClass('btn-primary');
    expect(screen.getByRole('button', { name: msg('workspace.pane.toggleList') })).toBeInTheDocument();
  });
});

describe('the data keys', () => {
  it('shares the terminal state with the sidebar: one cached entry for the instance', async () => {
    const rig = renderPage({ route: '/?session=fixture-term-1' });
    await regionOf('fixture-term-1');
    expect(rig.rendered.queryClient.getQueryData(qk.terminalState(FIXTURE_INSTANCE_ID))).toBeDefined();
  });
});

describe('accessibility', () => {
  async function violations(container: HTMLElement): Promise<string[]> {
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  for (const locale of ['en', 'vi'] as const) {
    it(`TC-UI-11 has no axe violation with a session open (${locale})`, async () => {
      const rig = renderPage({ route: '/?session=fixture-term-1', locale });
      await regionOf('fixture-term-1', locale);
      await sidebar(locale);
      await goLive(rig);
      expect(await violations(rig.rendered.container)).toEqual([]);
    });

    it(`TC-UI-11 has no axe violation in the locked state (${locale})`, async () => {
      const rig = renderPage({ authenticated: false, locale });
      await screen.findByRole('heading', { level: 1, name: msg('access.locked.title', undefined, locale) });
      expect(await violations(rig.rendered.container)).toEqual([]);
    });
  }
});
