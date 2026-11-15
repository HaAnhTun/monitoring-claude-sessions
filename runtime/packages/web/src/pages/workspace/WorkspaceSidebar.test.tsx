import type { Folder, SessionSummary, TerminalState } from '@mcs/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { qk } from '../../data/query-keys.ts';
import { folderPrefKey } from '../../lib/workspace-view.ts';
import { ShortcutRegistryProvider } from '../../state/shortcuts-registry.tsx';
import { MQ_LIST_OVERLAY } from '../../state/use-media-query.ts';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import {
  FIXTURE_INSTANCE_ID,
  makeAuthSession,
  makeFolder,
  makeFolderList,
  makeInstance,
  makeLinkedTerminalSession,
  makeSession,
  makeSessionPage,
  makeState,
  makeTerminalSession,
  makeTerminalState,
  makeUnavailableTerminalState,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import type { NewSessionTarget } from './ActionDialogs.tsx';
import { WorkspaceSidebar, type WorkspaceSidebarProps } from './WorkspaceSidebar.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Data {
  folders?: Folder[] | Response;
  sources?: Parameters<typeof makeFolderList>[1];
  terminal?: TerminalState | Response;
  /** Monitor rows by the `session` filter, recent sessions by the `project` filter. */
  monitor?: SessionSummary[];
  recent?: SessionSummary[];
  authenticated?: boolean;
}

function fakeApi(data: Data = {}, extra: FakeHandlers = {}): FakeApi {
  return createFakeApi({
    instance: () => makeInstance(),
    authSession: () => makeAuthSession(data.authenticated ?? true),
    listFolders: () => {
      const folders = data.folders ?? [makeFolder(1), makeFolder(2)];
      return folders instanceof Response ? folders : makeFolderList(folders, data.sources);
    },
    terminalState: () => data.terminal ?? makeTerminalState([]),
    listSessions: (query) => makeSessionPage(query.has('session') ? (data.monitor ?? []) : (data.recent ?? [])),
    ...extra,
  });
}

/** A media query stub: only the overlay query matches. */
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

interface Handlers {
  onNewSession: Mock<(target: NewSessionTarget) => void>;
  onOtherFolder: Mock<() => void>;
  onResume: Mock<(summary: SessionSummary) => void>;
  onClose: Mock<() => void>;
}

function Harness({ props, handlers }: { props: Partial<WorkspaceSidebarProps>; handlers: Handlers }): ReactNode {
  const toggle = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button type="button" ref={toggle}>
        toggle
      </button>
      <WorkspaceSidebar selected="" returnFocusRef={toggle} {...handlers} {...props} />
      <button type="button">outside</button>
    </>
  );
}

function renderSidebar(data: Data = {}, props: Partial<WorkspaceSidebarProps> = {}, locale: 'en' | 'vi' = 'en') {
  const api = fakeApi(data);
  const handlers: Handlers = {
    onNewSession: vi.fn<(target: NewSessionTarget) => void>(),
    onOtherFolder: vi.fn<() => void>(),
    onResume: vi.fn<(summary: SessionSummary) => void>(),
    onClose: vi.fn<() => void>(),
  };
  const rendered = renderWithIntl(<Harness props={props} handlers={handlers} />, {
    api,
    locale,
    wrap: (children) => <ShortcutRegistryProvider>{children}</ShortcutRegistryProvider>,
  });
  return { ...rendered, api, ...handlers };
}

/** The column, whether it is a navigation or (as an open overlay) a dialog. */
const nav = (): HTMLElement => {
  const found = document.getElementById('project-list');
  if (found === null) throw new Error('no project list');
  return found;
};
const landmark = (): HTMLElement => screen.getByRole('navigation', { name: msg('workspace.sidebar.label') });
const heads = (): string[] =>
  [...nav().querySelectorAll<HTMLElement>('.workspace-folder__head')].map((head) => head.dataset['navId'] ?? '');
const headOf = (n: number): HTMLElement => {
  const found = nav().querySelector<HTMLElement>(`[data-nav-id="folder:fixture-app-${String(n)}"]`);
  if (found === null) throw new Error(`no head ${String(n)}`);
  return found;
};

async function loaded(): Promise<void> {
  await waitFor(() => {
    expect(nav().querySelector('.workspace-folder__head')).not.toBeNull();
  });
}

describe('WorkspaceSidebar', () => {
  describe('states', () => {
    it('TC-UI-01 shows a loading list while the first answer is on its way, then the folders', async () => {
      renderSidebar();
      expect(screen.getByText(msg('workspace.loading'))).toBeInTheDocument();
      await loaded();
      expect(screen.queryByText(msg('workspace.loading'))).toBeNull();
      expect(heads()).toEqual(['folder:fixture-app-1', 'folder:fixture-app-2']);
    });

    it('TC-UI-01 names its landmark and heading', async () => {
      renderSidebar();
      await loaded();
      expect(landmark()).toBe(nav());
      expect(within(nav()).getByRole('heading', { name: msg('workspace.sidebar.heading') })).toBeInTheDocument();
    });

    it('says what failed and retries when the folders cannot be read', async () => {
      const { api } = renderSidebar({ folders: errorResponse('internal_error') });
      const retry = await screen.findByRole('button', { name: msg('common.retryNow') });
      expect(within(nav()).getByText(/projects and sessions/)).toBeInTheDocument();
      const before = api.callsTo('listFolders').length;
      await userEvent.setup().click(retry);
      await waitFor(() => {
        expect(api.callsTo('listFolders').length).toBeGreaterThan(before);
      });
    });

    it('keeps the folders and says how old they are when a refresh fails', async () => {
      const { api, queryClient } = renderSidebar();
      await loaded();
      expect(document.querySelector('.stale-indicator')).toBeNull();
      api.handlers.listFolders = () => errorResponse('internal_error');
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: qk.folders(FIXTURE_INSTANCE_ID) });
      });
      await waitFor(() => {
        expect(document.querySelector('.stale-indicator')).not.toBeNull();
      });
      expect(heads()).toHaveLength(2);
    });

    it('TC-UI-01 with no folder and no session shows one primary button, Other folder, and no second one', async () => {
      const { onOtherFolder } = renderSidebar({ folders: [] });
      expect(await screen.findByText(msg('workspace.empty.title'))).toBeInTheDocument();
      expect(screen.getByText(msg('workspace.empty.body'))).toBeInTheDocument();
      expect(nav().querySelectorAll('.btn-primary')).toHaveLength(1);
      const buttons = screen.getAllByRole('button', { name: msg('workspace.otherFolder') });
      expect(buttons).toHaveLength(1);
      await userEvent.setup().click(buttons[0]!);
      expect(onOtherFolder).toHaveBeenCalledTimes(1);
    });

    it('shows a line, with the failing source in its title, when a source could not be read', async () => {
      renderSidebar({
        sources: {
          sources: {
            daMemory: { status: 'unreadable', folders: 0, readAt: null },
            claudeHome: { status: 'ok', folders: 2, scannedAt: null, truncated: false },
            userFolders: { status: 'ok', count: 0 },
          },
        },
      });
      await loaded();
      const line = screen.getByText(msg('workspace.sources.degraded'));
      expect(line.title).toContain('daMemory');
    });

    it('treats a truncated scan of the Claude home as degraded too', async () => {
      renderSidebar({
        sources: {
          sources: {
            daMemory: { status: 'ok', folders: 0, readAt: null },
            claudeHome: { status: 'ok', folders: 2, scannedAt: null, truncated: true },
            userFolders: { status: 'ok', count: 0 },
          },
        },
      });
      await loaded();
      expect(screen.getByText(msg('workspace.sources.degraded')).title).toContain('claudeHome');
    });

    it('says nothing about a source that is simply absent', async () => {
      renderSidebar({
        sources: {
          sources: {
            daMemory: { status: 'absent', folders: 0, readAt: null },
            claudeHome: { status: 'ok', folders: 2, scannedAt: null, truncated: false },
            userFolders: { status: 'absent', count: 0 },
          },
        },
      });
      await loaded();
      expect(screen.queryByText(msg('workspace.sources.degraded'))).toBeNull();
    });

    it('hides the whole column when terminals are unavailable', async () => {
      const { api } = renderSidebar({ terminal: makeUnavailableTerminalState('unsupported_os') });
      await waitFor(() => {
        expect(api.callsTo('terminalState')).toHaveLength(1);
      });
      await waitFor(() => {
        expect(screen.queryByRole('navigation')).toBeNull();
      });
      expect(document.getElementById('project-list')).toBeNull();
    });

    it('hides the column while the browser has no session, and asks for no folders', async () => {
      const { api } = renderSidebar({ authenticated: false });
      await waitFor(() => {
        expect(api.callsTo('authSession')).toHaveLength(1);
      });
      await waitFor(() => {
        expect(document.getElementById('project-list')).toBeNull();
      });
      expect(api.callsTo('listFolders')).toHaveLength(0);
    });

    it('shows the footer with Other folder, the legend of the marks and the note that sessions end with the app', async () => {
      const { onOtherFolder } = renderSidebar();
      await loaded();
      expect(screen.getByText(msg('workspace.footer.endsWithApp'))).toBeInTheDocument();
      expect(screen.getByRole('list', { name: msg('workspace.legend.label') })).toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole('button', { name: msg('workspace.otherFolder') }));
      expect(onOtherFolder).toHaveBeenCalledTimes(1);
    });
  });

  describe('folders and live sessions', () => {
    it('TC-UI-01 puts the folders with live sessions first and the live rows inside their folder', async () => {
      renderSidebar({
        folders: [makeFolder(1), makeFolder(2), makeFolder(3)],
        terminal: makeTerminalState([makeTerminalSession(3)]),
      });
      await waitFor(() => {
        expect(heads()[0]).toBe('folder:fixture-app-3');
      });
      expect(heads()).toEqual(['folder:fixture-app-3', 'folder:fixture-app-1', 'folder:fixture-app-2']);
      expect(headOf(3)).toHaveAttribute('aria-expanded', 'true');
      expect(headOf(1)).toHaveAttribute('aria-expanded', 'false');
      expect(await screen.findByRole('link', { name: /fixture-term-3/ })).toBeInTheDocument();
    });

    it('opens a folder with the full mark by default', async () => {
      renderSidebar({ folders: [makeFolder(1, { activity: 'full' }), makeFolder(2)] });
      await loaded();
      expect(headOf(1)).toHaveAttribute('aria-expanded', 'true');
      expect(headOf(2)).toHaveAttribute('aria-expanded', 'false');
    });

    it('TC-UI-04 shows the state and tokens of a live session from its transcript', async () => {
      const summary = makeSession({ id: sessionId(1), state: makeState('waiting_input') });
      renderSidebar({
        folders: [makeFolder(1)],
        terminal: makeTerminalState([makeLinkedTerminalSession(1)]),
        monitor: [summary],
      });
      const row = await screen.findByRole('link', { name: /fixture-term-1/ });
      await waitFor(() => {
        expect(within(row).getByText(msg('state.waiting_input.label'))).toBeInTheDocument();
      });
    });

    it('asks the monitor for the linked sessions in one request, by id', async () => {
      const { api } = renderSidebar({
        folders: [makeFolder(1), makeFolder(2)],
        terminal: makeTerminalState([makeLinkedTerminalSession(1), makeLinkedTerminalSession(2)]),
      });
      await waitFor(() => {
        expect(api.callsTo('listSessions').some((call) => call.query.has('session'))).toBe(true);
      });
      const call = api.callsTo('listSessions').find((candidate) => candidate.query.has('session'));
      expect(call?.query.get('session')).toBe([sessionId(1), sessionId(2)].join(','));
    });

    it('marks the selected session with aria-current', async () => {
      renderSidebar(
        { folders: [makeFolder(1)], terminal: makeTerminalState([makeTerminalSession(1)]) },
        { selected: 'fixture-term-1' },
      );
      expect(await screen.findByRole('link', { name: /fixture-term-1/ })).toHaveAttribute('aria-current', 'true');
    });

    it('keeps the session of a folder it does not list, in a folder of its own', async () => {
      renderSidebar({
        folders: [makeFolder(1)],
        terminal: makeTerminalState([makeTerminalSession(5, { folderKey: null, path: '/fixture/elsewhere/lone' })]),
      });
      expect(await screen.findByRole('link', { name: /fixture-term-5/ })).toBeInTheDocument();
      expect(within(nav()).getByText('lone')).toBeInTheDocument();
    });

    it('follows the sessions that appear and leave without a reload', async () => {
      const { queryClient } = renderSidebar({ folders: [makeFolder(1)] });
      await loaded();
      expect(screen.queryByRole('link', { name: /fixture-term-1/ })).toBeNull();
      act(() => {
        queryClient.setQueryData(qk.terminalState(FIXTURE_INSTANCE_ID), makeTerminalState([makeTerminalSession(1)]));
      });
      expect(await screen.findByRole('link', { name: /fixture-term-1/ })).toBeInTheDocument();
      act(() => {
        queryClient.setQueryData(qk.terminalState(FIXTURE_INSTANCE_ID), makeTerminalState([]));
      });
      await waitFor(() => {
        expect(screen.queryByRole('link', { name: /fixture-term-1/ })).toBeNull();
      });
    });
  });

  describe('opening and closing folders', () => {
    it('stores the choice of the person under the hashed key of the folder', async () => {
      const { prefsStore } = renderSidebar({ folders: [makeFolder(1), makeFolder(2)] });
      await loaded();
      await userEvent.setup().click(headOf(2));
      expect(prefsStore.getSnapshot().workspaceOpen).toEqual({ [folderPrefKey('fixture-app-2')]: true });
      expect(headOf(2)).toHaveAttribute('aria-expanded', 'true');
      await userEvent.setup().click(headOf(2));
      expect(prefsStore.getSnapshot().workspaceOpen).toEqual({ [folderPrefKey('fixture-app-2')]: false });
      expect(headOf(2)).toHaveAttribute('aria-expanded', 'false');
    });

    it('lets a closed choice win over a live session', async () => {
      const { prefsStore } = renderSidebar({
        folders: [makeFolder(1)],
        terminal: makeTerminalState([makeTerminalSession(1)]),
      });
      await waitFor(() => {
        expect(headOf(1)).toHaveAttribute('aria-expanded', 'true');
      });
      await userEvent.setup().click(headOf(1));
      expect(headOf(1)).toHaveAttribute('aria-expanded', 'false');
      expect(prefsStore.getSnapshot().workspaceOpen?.[folderPrefKey('fixture-app-1')]).toBe(false);
    });
  });

  describe('actions', () => {
    it('hands the folder to the page when New session is pressed', async () => {
      const { onNewSession } = renderSidebar({ folders: [makeFolder(1, { activity: 'full' })] });
      await userEvent
        .setup()
        .click(await screen.findByRole('button', { name: new RegExp(msg('workspace.newSession')) }));
      expect(onNewSession).toHaveBeenCalledWith({
        name: 'fixture-app-1',
        path: '/fixture/projects/app-1',
        known: true,
      });
    });

    it('says the folder is not known when a session started the row', async () => {
      const { onNewSession } = renderSidebar({
        folders: [makeFolder(1)],
        terminal: makeTerminalState([makeTerminalSession(5, { folderKey: null, path: '/fixture/elsewhere/lone' })]),
      });
      await screen.findByRole('link', { name: /fixture-term-5/ });
      const lone = within(nav()).getByText('lone').closest('li') as HTMLElement;
      await userEvent
        .setup()
        .click(within(lone).getByRole('button', { name: new RegExp(msg('workspace.newSession')) }));
      expect(onNewSession).toHaveBeenCalledWith({ name: 'lone', path: '/fixture/elsewhere/lone', known: false });
    });

    it('hands the session to the page when Resume is pressed', async () => {
      const summary = makeSession({ id: sessionId(7), label: 'FIXTURE recent seven' });
      const { onResume } = renderSidebar({ folders: [makeFolder(1, { activity: 'full' })], recent: [summary] });
      await userEvent.setup().click(await screen.findByRole('button', { name: /Resume FIXTURE recent seven/ }));
      expect(onResume).toHaveBeenCalledWith(summary);
    });
  });

  describe('the filter', () => {
    const three = [makeFolder(1), makeFolder(2), makeFolder(3)];

    it('TC-UI-01 narrows the folders by name or path, case-insensitively, and restores them', async () => {
      renderSidebar({ folders: three });
      await loaded();
      const user = userEvent.setup();
      const field = screen.getByRole('searchbox', { name: msg('workspace.filter.label') });
      expect(field).toHaveAttribute('placeholder', msg('workspace.filter.placeholder'));
      await user.type(field, 'APP-2');
      expect(heads()).toEqual(['folder:fixture-app-2']);
      await user.clear(field);
      expect(heads()).toHaveLength(3);
      await user.type(field, '/fixture/projects/app-3');
      expect(heads()).toEqual(['folder:fixture-app-3']);
    });

    it('keeps a folder visible whose live session matches', async () => {
      renderSidebar({ folders: three, terminal: makeTerminalState([makeTerminalSession(2, { name: 'needle-term' })]) });
      await loaded();
      await userEvent.setup().type(screen.getByRole('searchbox'), 'needle');
      expect(heads()).toEqual(['folder:fixture-app-2']);
    });

    it('says so when nothing matches, and shows no empty-state button for it', async () => {
      renderSidebar({ folders: three });
      await loaded();
      await userEvent.setup().type(screen.getByRole('searchbox'), 'zzz');
      expect(screen.getByText(msg('workspace.filter.empty'))).toBeInTheDocument();
      expect(nav().querySelectorAll('.btn-primary')).toHaveLength(0);
    });

    it('Escape clears a typed filter', async () => {
      renderSidebar({ folders: three });
      await loaded();
      const user = userEvent.setup();
      const field = screen.getByRole('searchbox');
      await user.type(field, 'app-2{Escape}');
      expect(field).toHaveValue('');
      expect(heads()).toHaveLength(3);
    });

    it('TC-UI-12 takes the focus on the slash key and does not type it', async () => {
      renderSidebar({ folders: three });
      await loaded();
      const user = userEvent.setup();
      await user.keyboard('/');
      const field = screen.getByRole('searchbox');
      expect(field).toHaveFocus();
      expect(field).toHaveValue('');
    });

    it('ArrowDown in the filter moves into the list', async () => {
      renderSidebar({ folders: three });
      await loaded();
      const user = userEvent.setup();
      await user.click(screen.getByRole('searchbox'));
      await user.keyboard('{ArrowDown}');
      expect(headOf(1)).toHaveFocus();
    });
  });

  describe('roving focus', () => {
    it('TC-UI-12 leaves one tab stop in the list, the selected session', async () => {
      renderSidebar(
        {
          folders: [makeFolder(1), makeFolder(2)],
          terminal: makeTerminalState([makeTerminalSession(2, { name: 'fixture-term-2' })]),
        },
        { selected: 'fixture-term-2' },
      );
      await screen.findByRole('link', { name: /fixture-term-2/ });
      const stops = [...nav().querySelectorAll('[data-nav-item]')].filter(
        (item) => item.getAttribute('tabindex') === '0',
      );
      expect(stops).toHaveLength(1);
      expect(stops[0]).toHaveAttribute('data-nav-id', 'session:fixture-term-2');
    });

    it('TC-UI-12 moves over heads, rows and buttons with the arrow keys', async () => {
      renderSidebar({
        folders: [makeFolder(1), makeFolder(2)],
        terminal: makeTerminalState([makeTerminalSession(1)]),
      });
      await screen.findByRole('link', { name: /fixture-term-1/ });
      const user = userEvent.setup();
      headOf(1).focus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('link', { name: /fixture-term-1/ })).toHaveFocus();
      await user.keyboard('{End}');
      expect(screen.getByRole('button', { name: msg('workspace.otherFolder') })).toHaveFocus();
      await user.keyboard('{Home}');
      expect(headOf(1)).toHaveFocus();
    });

    it('TC-UI-12 keeps the focus on its row when a live update re-renders the list', async () => {
      const { queryClient } = renderSidebar({
        folders: [makeFolder(1), makeFolder(2)],
        terminal: makeTerminalState([makeTerminalSession(1)]),
      });
      const row = await screen.findByRole('link', { name: /fixture-term-1/ });
      row.focus();
      act(() => {
        queryClient.setQueryData(
          qk.terminalState(FIXTURE_INSTANCE_ID),
          makeTerminalState([makeTerminalSession(2), makeTerminalSession(1, { viewers: 3 })]),
        );
      });
      await screen.findByRole('link', { name: /fixture-term-2/ });
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /fixture-term-1/ })).toHaveFocus();
      });
    });
  });

  describe('the overlay below 1024 px', () => {
    it('TC-UI-12 is a plain navigation from 1024 px: always shown, no dialog role', async () => {
      stubOverlay(false);
      renderSidebar({}, { open: false });
      await loaded();
      const root = document.querySelector('.workspace-sidebar');
      expect(root).not.toHaveAttribute('role', 'dialog');
      expect(root).not.toHaveAttribute('hidden');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('TC-UI-12 is hidden while closed', () => {
      stubOverlay(true);
      renderSidebar({}, { open: false });
      expect(document.querySelector('.workspace-sidebar')).toHaveAttribute('hidden');
      expect(screen.queryByRole('navigation')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('TC-UI-12 is a dialog named after the list when open, and takes the focus', async () => {
      stubOverlay(true);
      renderSidebar({}, { open: true });
      const dialog = await screen.findByRole('dialog', { name: msg('workspace.sidebar.label') });
      expect(dialog).toContainElement(nav());
      expect(dialog).not.toHaveAttribute('aria-modal', 'true');
      await waitFor(() => {
        expect(dialog.contains(document.activeElement)).toBe(true);
      });
    });

    it('TC-UI-12 closes on Escape and gives the focus back to the toggle', async () => {
      stubOverlay(true);
      const { onClose } = renderSidebar({}, { open: true });
      await screen.findByRole('dialog');
      await loaded();
      await userEvent.setup().keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'toggle' })).toHaveFocus();
    });

    it('TC-UI-12 keeps Tab inside: from the last control to the first, and back', async () => {
      stubOverlay(true);
      renderSidebar({}, { open: true });
      await screen.findByRole('dialog');
      await loaded();
      const user = userEvent.setup();
      const first = screen.getByRole('searchbox');
      const last = screen.getByRole('button', { name: msg('workspace.otherFolder') });
      last.focus();
      await user.tab();
      expect(first).toHaveFocus();
      await user.tab({ shift: true });
      expect(last).toHaveFocus();
    });

    it('TC-UI-12 closes on a click outside, but not on a click inside or on the toggle that opens it', async () => {
      stubOverlay(true);
      const { onClose } = renderSidebar({}, { open: true });
      await screen.findByRole('dialog');
      await loaded();
      const user = userEvent.setup();
      await user.click(screen.getByRole('searchbox'));
      expect(onClose).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'toggle' }));
      expect(onClose).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'outside' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('TC-UI-12 does not close for a click inside a modal dialog that the list opened', async () => {
      stubOverlay(true);
      const { onClose } = renderSidebar({}, { open: true });
      await screen.findByRole('dialog');
      const modal = document.createElement('dialog');
      modal.setAttribute('open', '');
      const button = document.createElement('button');
      modal.append(button);
      document.body.append(modal);
      await userEvent.setup().click(button);
      expect(onClose).not.toHaveBeenCalled();
      modal.remove();
    });

    it('TC-UI-12 closes after a selection', async () => {
      stubOverlay(true);
      const { onClose } = renderSidebar(
        { folders: [makeFolder(1)], terminal: makeTerminalState([makeTerminalSession(1)]) },
        { open: true },
      );
      await userEvent.setup().click(await screen.findByRole('link', { name: /fixture-term-1/ }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('TC-UI-12 stays open while a dialog of the page asks about New session or Resume', async () => {
      stubOverlay(true);
      const { onClose, onNewSession } = renderSidebar(
        { folders: [makeFolder(1, { activity: 'full' })] },
        { open: true },
      );
      await userEvent
        .setup()
        .click(await screen.findByRole('button', { name: new RegExp(msg('workspace.newSession')) }));
      expect(onNewSession).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('does nothing on Escape when the list is a column', async () => {
      stubOverlay(false);
      const { onClose } = renderSidebar({}, { open: true });
      await loaded();
      await userEvent.setup().keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('does not take the slash key while it is hidden', async () => {
      stubOverlay(true);
      renderSidebar({}, { open: false });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'outside' }));
      await user.keyboard('/');
      expect(screen.getByRole('button', { name: 'outside' })).toHaveFocus();
    });
  });

  describe('accessibility', () => {
    async function violations(container: HTMLElement): Promise<string[]> {
      const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
      return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
    }

    for (const locale of ['en', 'vi'] as const) {
      it(`TC-UI-11 has no axe violation with folders, a live session and recent sessions (${locale})`, async () => {
        const { container } = renderSidebar(
          {
            folders: [makeFolder(1, { activity: 'full' }), makeFolder(2, { activity: 'half' })],
            terminal: makeTerminalState([makeLinkedTerminalSession(1)]),
            monitor: [makeSession({ id: sessionId(1) })],
            recent: [makeSession({ id: sessionId(8), label: 'FIXTURE recent eight' })],
          },
          {},
          locale,
        );
        await screen.findByText('FIXTURE recent eight');
        expect(await violations(container)).toEqual([]);
      });

      it(`TC-UI-11 has no axe violation in the empty state (${locale})`, async () => {
        const { container } = renderSidebar({ folders: [] }, {}, locale);
        await screen.findByText(msg('workspace.empty.title', undefined, locale));
        expect(await violations(container)).toEqual([]);
      });
    }

    it('TC-UI-11 has no axe violation as an open overlay', async () => {
      stubOverlay(true);
      const { container } = renderSidebar({ folders: [makeFolder(1)] }, { open: true });
      await screen.findByRole('dialog');
      await loaded();
      expect(await violations(container)).toEqual([]);
    });

    it('TC-UI-11 has no axe violation while it loads or after an error', async () => {
      const loading = renderSidebar();
      expect(await violations(loading.container)).toEqual([]);
      loading.unmount();
      const failed = renderSidebar({ folders: errorResponse('internal_error') });
      await screen.findByRole('button', { name: msg('common.retryNow') });
      expect(await violations(failed.container)).toEqual([]);
    });
  });

  it('keeps its words in the catalogue: the same landmark in Vietnamese', async () => {
    renderSidebar({}, {}, 'vi');
    await waitFor(() => {
      expect(
        screen.getByRole('navigation', { name: msg('workspace.sidebar.label', undefined, 'vi') }),
      ).toBeInTheDocument();
    });
  });
});
