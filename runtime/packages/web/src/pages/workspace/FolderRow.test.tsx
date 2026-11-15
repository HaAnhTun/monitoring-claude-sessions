import type { Folder, SessionSummary, TerminalSessionInfo } from '@mcs/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  folderModelOf,
  liveSessionOf,
  rowStateOf,
  type FolderModel,
  type FolderRowModel,
  type LiveSession,
} from '../../lib/workspace-view.ts';
import { createFakeApi, errorResponse, type FakeApi } from '../../test/fake-api.ts';
import {
  makeFolder,
  makeInstance,
  makeLinkedTerminalSession,
  makeSession,
  makeSessionPage,
  makeTerminalSession,
  sessionId,
} from '../../test/fixtures/index.ts';
import { msg } from '../../test/msg.ts';
import { renderWithIntl } from '../../test/render.tsx';
import { FolderRow, type FolderRowProps } from './FolderRow.tsx';

const DA = { lastUpdatedAt: '2026-10-12T11:55:00.000Z', activity: 'full' as const, summary: '', brain: 3, action: 1 };

function folderOf(overrides: Partial<Folder> = {}): FolderModel {
  return folderModelOf(makeFolder(1, overrides));
}

interface RowOptions {
  folder?: FolderModel;
  live?: TerminalSessionInfo[];
  open?: boolean;
  monitor?: SessionSummary[];
  selected?: string;
}

function rowOf(options: RowOptions = {}): FolderRowModel {
  const folder = options.folder ?? folderOf();
  const monitor = new Map((options.monitor ?? []).map((summary) => [summary.id, summary]));
  const live = (options.live ?? []).map((info) => {
    const session = liveSessionOf(info);
    return { session, row: rowStateOf(session, monitor), selected: session.name === options.selected };
  });
  return { folder, live, liveCount: live.length, open: options.open ?? true };
}

function fakeApi(recent: () => SessionSummary[] | Response = () => []): FakeApi {
  return createFakeApi({
    instance: () => makeInstance(),
    listSessions: () => {
      const result = recent();
      return result instanceof Response ? result : makeSessionPage(result);
    },
  });
}

function renderRow(model: FolderRowModel, props: Partial<FolderRowProps> = {}, api: FakeApi = fakeApi()) {
  const handlers = { onToggle: vi.fn(), onNewSession: vi.fn(), onResume: vi.fn(), onNavigate: vi.fn() };
  const liveAll: readonly LiveSession[] = model.live.map((entry) => entry.session);
  const rendered = renderWithIntl(
    <ul>
      <FolderRow model={model} liveAll={liveAll} {...handlers} {...props} />
    </ul>,
    { api },
  );
  return { ...rendered, ...handlers, api };
}

const head = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[data-nav-id="folder:fixture-app-1"]');
  if (found === null) throw new Error('no folder head');
  return found;
};

describe('FolderRow', () => {
  describe('the head', () => {
    it('TC-UI-01 is a button with aria-expanded that toggles the body and names the folder', async () => {
      const { onToggle } = renderRow(rowOf({ open: false }));
      expect(head()).toHaveAttribute('aria-expanded', 'false');
      expect(head()).toHaveAttribute('data-nav-item');
      expect(head()).toHaveAttribute('data-nav-id', 'folder:fixture-app-1');
      await userEvent.setup().click(head());
      expect(onToggle).toHaveBeenCalledWith(true);
    });

    it('asks to close an open folder', async () => {
      const { onToggle } = renderRow(rowOf({ open: true }));
      expect(head()).toHaveAttribute('aria-expanded', 'true');
      await userEvent.setup().click(head());
      expect(onToggle).toHaveBeenCalledWith(false);
    });

    it('toggles from the keyboard with Enter and with Space', async () => {
      const { onToggle } = renderRow(rowOf({ open: false }));
      head().focus();
      await userEvent.setup().keyboard('{Enter} ');
      expect(onToggle).toHaveBeenCalledTimes(2);
    });

    it('carries the path in the title of the name, and controls its body', () => {
      renderRow(rowOf({ open: true }));
      expect(screen.getByText('fixture-app-1', { selector: '.workspace-folder__name' })).toHaveAttribute(
        'title',
        '/fixture/projects/app-1',
      );
      const controls = head().getAttribute('aria-controls');
      expect(controls).not.toBeNull();
      expect(document.getElementById(controls ?? '')).not.toBeNull();
    });

    for (const level of ['full', 'half', 'none'] as const) {
      it(`TC-UI-01 says the mark "${level}" in words for a screen reader and draws the disc from data-level`, () => {
        renderRow(rowOf({ folder: folderOf({ activity: level }), open: false }));
        const mark = head().querySelector('.workspace-mark');
        expect(mark).toHaveAttribute('data-level', level);
        expect(mark).toHaveAttribute('aria-hidden', 'true');
        expect(within(head()).getByText(msg(`workspace.folder.activity.${level}`))).toHaveClass('sr-only');
      });
    }

    it('TC-UI-01 shows the relative time of the last activity', () => {
      renderRow(
        rowOf({
          folder: folderOf({ da: DA, lastActivityAt: '2026-10-12T11:55:00.000Z', activity: 'full' }),
          open: false,
        }),
      );
      expect(head().querySelector('time')).toHaveAttribute('datetime', '2026-10-12T11:55:00.000Z');
      expect(within(head()).queryByText(msg('workspace.folder.noMemory'))).toBeNull();
    });

    it('TC-UI-01 says "no memory data" for a folder without DA memory', () => {
      renderRow(rowOf({ folder: folderOf({ da: null }), open: false }));
      expect(within(head()).getByText(msg('workspace.folder.noMemory'))).toBeInTheDocument();
      expect(head().querySelector('time')).toBeNull();
    });

    it('shows the live chip with the count, and none without live sessions', () => {
      const { unmount } = renderRow(
        rowOf({ live: [makeTerminalSession(1), makeTerminalSession(2, { name: 'fixture-term-9' })], open: false }),
      );
      expect(within(head()).getByText(msg('workspace.folder.live', { count: 2 }))).toBeInTheDocument();
      unmount();
      renderRow(rowOf({ open: false }));
      expect(within(head()).queryByText(/live session/)).toBeNull();
    });
  });

  describe('the body', () => {
    it('is not mounted while the folder is closed, and asks for no recent sessions', async () => {
      const { api } = renderRow(rowOf({ open: false, live: [makeTerminalSession(1)] }));
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.queryByRole('button', { name: new RegExp(msg('workspace.newSession')) })).toBeNull();
      await Promise.resolve();
      expect(api.callsTo('listSessions')).toHaveLength(0);
    });

    it('TC-UI-01 shows the summary with its full text in the title, and the counts only with a summary', () => {
      const folder = folderOf({ da: { ...DA, summary: 'FIXTURE summary of the work' } });
      renderRow(rowOf({ folder }));
      expect(screen.getByText('FIXTURE summary of the work')).toHaveAttribute('title', 'FIXTURE summary of the work');
      expect(screen.getByText(msg('workspace.folder.counts', { brain: 3, action: 1 }))).toBeInTheDocument();
    });

    it('shows no counts without a summary, and no summary line either', () => {
      const { container } = renderRow(rowOf({ folder: folderOf({ da: DA }) }));
      expect(screen.queryByText(msg('workspace.folder.counts', { brain: 3, action: 1 }))).toBeNull();
      expect(container.querySelector('.workspace-folder__summary')).toBeNull();
    });

    it('lists the live sessions with the selected one marked', () => {
      renderRow(
        rowOf({
          live: [makeTerminalSession(1), makeTerminalSession(2, { name: 'fixture-term-9' })],
          selected: 'fixture-term-9',
        }),
      );
      const links = screen.getAllByRole('link');
      expect(links.map((link) => link.getAttribute('data-nav-id'))).toEqual([
        'session:fixture-term-1',
        'session:fixture-term-9',
      ]);
      expect(links[1]).toHaveAttribute('aria-current', 'true');
      expect(links[0]).not.toHaveAttribute('aria-current');
    });

    it('passes the selection callback to its rows', async () => {
      const { onNavigate } = renderRow(rowOf({ live: [makeTerminalSession(1)] }));
      await userEvent.setup().click(screen.getByRole('link'));
      expect(onNavigate).toHaveBeenCalledTimes(1);
    });

    it('starts a session in the folder from the New session button', async () => {
      const folder = folderOf();
      const { onNewSession } = renderRow(rowOf({ folder }));
      const button = screen.getByRole('button', { name: new RegExp(msg('workspace.newSession')) });
      expect(button).toHaveAttribute('data-nav-item');
      expect(button).not.toHaveAttribute('aria-disabled', 'true');
      await userEvent.setup().click(button);
      expect(onNewSession).toHaveBeenCalledWith(folder);
    });

    it('keeps a folder that cannot start focusable, says why and starts nothing', async () => {
      const { onNewSession } = renderRow(rowOf({ folder: folderOf({ canStart: false, path: null }) }));
      const button = screen.getByRole('button', { name: new RegExp(msg('workspace.newSession')) });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).not.toBeDisabled();
      expect(button).toHaveAttribute('title', msg('workspace.folder.cannotStart'));
      await userEvent.setup().click(button);
      expect(onNewSession).not.toHaveBeenCalled();
    });
  });

  describe('recent sessions', () => {
    const recent = (n: number, overrides: Partial<SessionSummary> = {}): SessionSummary =>
      makeSession({ id: sessionId(n), seq: n, label: `FIXTURE recent ${String(n)}`, ...overrides });

    it('asks for the folder own sessions, six of them, only while the body is open', async () => {
      const { api } = renderRow(
        rowOf(),
        {},
        fakeApi(() => [recent(1)]),
      );
      await screen.findByText('FIXTURE recent 1');
      const [call] = api.callsTo('listSessions');
      expect(call?.query.get('project')).toBe('fixture-app-1');
      expect(call?.query.get('limit')).toBe('6');
    });

    it('TC-UI-04 shows the label, the state word and a Resume button for each', async () => {
      renderRow(
        rowOf(),
        {},
        fakeApi(() => [recent(1), recent(2)]),
      );
      const group = await screen.findByRole('list', { name: msg('workspace.recent.title') });
      const items = within(group).getAllByRole('listitem');
      const first = within(items[0]!);
      expect(items).toHaveLength(2);
      expect(first.getByText('FIXTURE recent 1')).toBeInTheDocument();
      expect(first.getByText(msg('state.working.label'))).toBeInTheDocument();
      expect(first.getByRole('button', { name: /Resume/ })).toBeInTheDocument();
    });

    it('names the session in the Resume button for a screen reader', async () => {
      renderRow(
        rowOf(),
        {},
        fakeApi(() => [recent(1)]),
      );
      const button = await screen.findByRole('button', { name: new RegExp(msg('workspace.recent.resume')) });
      expect(button).toHaveAccessibleName(`${msg('workspace.recent.resume')} FIXTURE recent 1`);
      expect(button).toHaveAttribute('data-nav-item');
      expect(button).toHaveAttribute('title', msg('workspace.recent.resumeTip'));
    });

    it('calls back with the session when Resume is pressed', async () => {
      const summary = recent(1);
      const { onResume } = renderRow(
        rowOf(),
        {},
        fakeApi(() => [summary]),
      );
      await userEvent
        .setup()
        .click(await screen.findByRole('button', { name: new RegExp(msg('workspace.recent.resume')) }));
      expect(onResume).toHaveBeenCalledWith(summary);
    });

    it('hides the sessions that are open as a terminal', async () => {
      const live = makeLinkedTerminalSession(1);
      renderRow(
        rowOf({ live: [live] }),
        {},
        fakeApi(() => [recent(1), recent(2)]),
      );
      await screen.findByText('FIXTURE recent 2');
      expect(screen.queryByText('FIXTURE recent 1')).toBeNull();
    });

    it('hides the session of a terminal in another folder as well', async () => {
      const elsewhere = liveSessionOf(makeLinkedTerminalSession(1));
      renderRow(
        rowOf(),
        { liveAll: [elsewhere] },
        fakeApi(() => [recent(1), recent(2)]),
      );
      await screen.findByText('FIXTURE recent 2');
      expect(screen.queryByText('FIXTURE recent 1')).toBeNull();
    });

    it('shows five rows and, when a sixth exists, the link to all sessions', async () => {
      renderRow(
        rowOf(),
        {},
        fakeApi(() => [1, 2, 3, 4, 5, 6].map((n) => recent(n))),
      );
      await screen.findByText('FIXTURE recent 5');
      expect(screen.queryByText('FIXTURE recent 6')).toBeNull();
      const all = screen.getByRole('link', { name: msg('workspace.recent.all') });
      expect(all).toHaveAttribute('href', '/sessions');
    });

    it('offers no link to all sessions when five or fewer exist', async () => {
      renderRow(
        rowOf(),
        {},
        fakeApi(() => [1, 2, 3, 4, 5].map((n) => recent(n))),
      );
      await screen.findByText('FIXTURE recent 5');
      expect(screen.queryByRole('link', { name: msg('workspace.recent.all') })).toBeNull();
    });

    it('says so while it loads, and when the folder has none', async () => {
      renderRow(rowOf());
      expect(screen.getByText(msg('workspace.recent.loading'))).toBeInTheDocument();
      expect(await screen.findByText(msg('workspace.recent.empty'))).toBeInTheDocument();
    });

    it('says what failed and offers a retry when the request fails', async () => {
      renderRow(
        rowOf(),
        {},
        fakeApi(() => errorResponse('internal_error')),
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: msg('common.retryNow') })).toBeInTheDocument();
      });
    });

    it('collapses and expands its group with a button', async () => {
      const user = userEvent.setup();
      renderRow(
        rowOf(),
        {},
        fakeApi(() => [recent(1)]),
      );
      await screen.findByText('FIXTURE recent 1');
      const toggle = screen.getByRole('button', { name: msg('workspace.recent.title') });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(toggle).toHaveAttribute('data-nav-item');
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('FIXTURE recent 1')).toBeNull();
    });
  });
});
