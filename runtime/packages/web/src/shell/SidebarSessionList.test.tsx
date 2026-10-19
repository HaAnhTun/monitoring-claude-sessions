import type { AgentNode, LifecycleState, SessionSummary } from '@mcs/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { qk } from '../data/query-keys.ts';
import { createPrefs } from '../lib/prefs.ts';
import { createFakeApi, errorResponse, type FakeApi } from '../test/fake-api.ts';
import {
  agentId,
  makeAgent,
  makeAgentPage,
  makeInstance,
  makeSession,
  makeSessionPage,
  makeState,
  sessionId,
} from '../test/fixtures/index.ts';
import { renderWithProviders } from '../test/render.tsx';
import { createPrefsStore, PrefsStoreContext, type PrefsStore } from '../state/prefs-store.ts';
import { SidebarSessionList } from './SidebarSessionList.tsx';

function session(n: number, label: string, state: LifecycleState): SessionSummary {
  return makeSession({ id: sessionId(n), seq: n, label, state: makeState(state) });
}

const FIVE_STATES: SessionSummary[] = [
  session(1, 'Alpha build', 'working'),
  session(2, 'Beta review', 'waiting_input'),
  session(3, 'Gamma idle', 'turn_ended'),
  session(4, 'Delta done', 'completed'),
  session(5, 'Epsilon stale', 'stale'),
];

function Probe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname + search}</output>;
}

interface Setup {
  sessions?: () => SessionSummary[] | Response;
  agents?: Record<string, AgentNode[]>;
  route?: string;
  store?: PrefsStore;
}

function renderList(setup: Setup = {}) {
  const store = setup.store ?? createPrefsStore(createPrefs(null));
  const instance = makeInstance();
  const api: FakeApi = createFakeApi({
    instance: () => instance,
    listSessions: () => {
      const result = (setup.sessions ?? (() => FIVE_STATES))();
      return result instanceof Response ? result : makeSessionPage(result);
    },
    sessionAgents: (_query, request) => makeAgentPage(setup.agents?.[request.params['sessionId'] ?? ''] ?? []),
  });
  const rendered = renderWithProviders(
    <Routes>
      <Route
        path="/sessions/:sessionId"
        element={
          <>
            <SidebarSessionList />
            <Probe />
          </>
        }
      />
      <Route
        path="*"
        element={
          <>
            <SidebarSessionList />
            <Probe />
          </>
        }
      />
    </Routes>,
    {
      api,
      instance,
      route: setup.route ?? '/sessions',
      wrap: (children: ReactNode) => <PrefsStoreContext value={store}>{children}</PrefsStoreContext>,
    },
  );
  return { ...rendered, api, store };
}

function rowLinks(): HTMLElement[] {
  return screen.getAllByRole('link').filter((el) => el.hasAttribute('data-key'));
}

function tabStops(): HTMLElement[] {
  return rowLinks().filter((el) => el.getAttribute('tabindex') === '0');
}

describe('SidebarSessionList (04-ui.md 4.4, 6.5, 6.6)', () => {
  it('groups the sessions in the legacy order and names every group', async () => {
    renderList();
    await screen.findByRole('link', { name: /Alpha build/ });
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Active',
      'Needs input',
      'Turn ended',
      'Done',
      'Stale or unknown',
    ]);
    const done = screen.getByRole('region', { name: 'Done' });
    expect(within(done).getByRole('link', { name: /Delta done/ })).toHaveAttribute('href', `/sessions/${sessionId(4)}`);
  });

  it('asks for the current window only, or everything with the show-all preference', async () => {
    const first = renderList();
    await screen.findByRole('link', { name: /Alpha build/ });
    expect(first.api.callsTo('listSessions')[0]?.query.get('window')).toBe('1');
    first.unmount();

    const store = createPrefsStore(createPrefs(null));
    store.setPref('showAll', true);
    const second = renderList({ store });
    await screen.findByRole('link', { name: /Alpha build/ });
    expect(second.api.callsTo('listSessions')[0]?.query.get('window')).toBeNull();
  });

  it('marks the list busy until the first answer and links to all sessions', async () => {
    renderList();
    const list = screen.getByTestId('session-list');
    expect(list).toHaveAttribute('aria-busy', 'true');
    await screen.findByRole('link', { name: /Alpha build/ });
    expect(list).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('link', { name: 'All sessions' })).toHaveAttribute('href', '/sessions');
  });

  it('marks the open session with aria-current', async () => {
    renderList({ route: `/sessions/${sessionId(2)}` });
    const link = await screen.findByRole('link', { name: /Beta review/ });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Alpha build/ })).not.toHaveAttribute('aria-current');
  });

  describe('filter', () => {
    it('ANDs the tokens, stores the text and says when nothing matches', async () => {
      const user = userEvent.setup();
      const { store } = renderList();
      await screen.findByRole('link', { name: /Alpha build/ });
      const box = screen.getByRole('searchbox', { name: 'Filter sessions' });

      await user.type(box, 'alpha');
      expect(rowLinks().map((el) => el.textContent)).toEqual([expect.stringContaining('Alpha build')]);
      expect(store.getSnapshot().filter).toBe('alpha');

      await user.type(box, ' idle');
      expect(screen.getByText(/No session matches this filter/)).toBeInTheDocument();
      expect(rowLinks()).toHaveLength(0);
    });

    it('starts from the stored filter and clears with Escape', async () => {
      const user = userEvent.setup();
      const store = createPrefsStore(createPrefs(null));
      store.setPref('filter', 'beta');
      renderList({ store });
      const box = screen.getByRole('searchbox', { name: 'Filter sessions' });
      expect(box).toHaveValue('beta');
      await screen.findByRole('link', { name: /Beta review/ });
      expect(rowLinks()).toHaveLength(1);

      await user.click(box);
      await user.keyboard('{Escape}');
      expect(box).toHaveValue('');
      expect(rowLinks()).toHaveLength(5);
      expect(store.getSnapshot().filter).toBe('');
    });

    it('lists a session that matches only through an agent, with just those agents', async () => {
      const id1 = sessionId(1);
      const agents = {
        [id1]: [
          makeAgent({ id: agentId(1), sessionId: id1, label: 'Reviewer helper' }),
          makeAgent({ id: agentId(2), sessionId: id1, label: 'Builder helper' }),
        ],
      };
      const store = createPrefsStore(createPrefs(null));
      store.setPref('filter', 'reviewer');
      renderList({ route: `/sessions/${id1}`, agents, store });
      await screen.findByRole('link', { name: /Reviewer helper/ });
      expect(screen.queryByRole('link', { name: /Builder helper/ })).toBeNull();
      expect(screen.getByRole('link', { name: /Alpha build/ })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Beta review/ })).toBeNull();
    });
  });

  describe('agents of the open session', () => {
    it('lists them under a group title, each linking to ?agent=', async () => {
      const id1 = sessionId(1);
      const agents = { [id1]: [makeAgent({ id: agentId(1), sessionId: id1, label: 'Helper one' })] };
      renderList({ route: `/sessions/${id1}`, agents });
      const link = await screen.findByRole('link', { name: /Helper one/ });
      expect(link).toHaveAttribute('href', `/sessions/${id1}?agent=${agentId(1)}`);
      expect(screen.getByText(/Subagents/)).toBeInTheDocument();
    });

    it('collapses more than 30 agents behind a button and pages them by 100', async () => {
      const user = userEvent.setup();
      const id1 = sessionId(1);
      const many = Array.from({ length: 130 }, (_, i) =>
        makeAgent({ id: agentId(i + 1), seq: i + 1, sessionId: id1, label: `Worker ${String(i + 1)}` }),
      );
      renderList({ route: `/sessions/${id1}`, agents: { [id1]: many } });
      const expand = await screen.findByRole('button', { name: 'Show 130 agents' });
      expect(screen.queryByRole('link', { name: /Worker 1$/ })).toBeNull();

      await user.click(expand);
      expect(rowLinks().filter((el) => el.textContent.includes('Worker'))).toHaveLength(100);
      await user.click(screen.getByRole('button', { name: 'Show 30 more' }));
      expect(rowLinks().filter((el) => el.textContent.includes('Worker'))).toHaveLength(130);
      expect(screen.queryByRole('button', { name: /Show .* more/ })).toBeNull();
    });

    it('shows up to 30 agents without a button', async () => {
      const id1 = sessionId(1);
      const few = Array.from({ length: 30 }, (_, i) =>
        makeAgent({ id: agentId(i + 1), seq: i + 1, sessionId: id1, label: `Worker ${String(i + 1)}` }),
      );
      renderList({ route: `/sessions/${id1}`, agents: { [id1]: few } });
      await screen.findByRole('link', { name: /Worker 30/ });
      expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
    });
  });

  describe('keyboard (roving tabindex)', () => {
    async function focusTabStop(): Promise<HTMLElement> {
      await screen.findByRole('link', { name: /Alpha build/ });
      const [stop] = tabStops();
      if (stop === undefined) throw new Error('no tab stop');
      act(() => {
        stop.focus();
      });
      return stop;
    }

    it('has exactly one tab stop, the first row unless a session is open', async () => {
      renderList();
      await screen.findByRole('link', { name: /Alpha build/ });
      expect(tabStops()).toHaveLength(1);
      expect(tabStops()[0]).toHaveTextContent('Alpha build');
      expect(rowLinks().filter((el) => el.getAttribute('tabindex') === '-1')).toHaveLength(4);
    });

    it('makes the open session the tab stop', async () => {
      renderList({ route: `/sessions/${sessionId(3)}` });
      await screen.findByRole('link', { name: /Gamma idle/ });
      expect(tabStops()).toHaveLength(1);
      expect(tabStops()[0]).toHaveTextContent('Gamma idle');
    });

    it('moves with Up, Down, Home and End and moves the tab stop with the focus', async () => {
      const user = userEvent.setup();
      renderList();
      await focusTabStop();

      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toHaveTextContent('Beta review');
      expect(tabStops()).toHaveLength(1);
      expect(tabStops()[0]).toBe(document.activeElement);

      await user.keyboard('{End}');
      expect(document.activeElement).toHaveTextContent('Epsilon stale');
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toHaveTextContent('Epsilon stale');

      await user.keyboard('{ArrowUp}');
      expect(document.activeElement).toHaveTextContent('Delta done');
      await user.keyboard('{Home}');
      expect(document.activeElement).toHaveTextContent('Alpha build');
      await user.keyboard('{ArrowUp}');
      expect(document.activeElement).toHaveTextContent('Alpha build');
    });

    it('opens the focused session with Enter', async () => {
      const user = userEvent.setup();
      renderList();
      await focusTabStop();
      await user.keyboard('{ArrowDown}{Enter}');
      expect(screen.getByTestId('location')).toHaveTextContent(`/sessions/${sessionId(2)}`);
    });

    it('keeps focus on the same session when a refresh moves it to another group', async () => {
      const user = userEvent.setup();
      let current = FIVE_STATES;
      const { queryClient } = renderList({ sessions: () => current });
      await focusTabStop();
      await user.keyboard('{ArrowDown}');
      const key = document.activeElement?.getAttribute('data-key');
      expect(key).toBe(`${sessionId(2)}|`);

      current = FIVE_STATES.map((s) => (s.id === sessionId(2) ? session(2, 'Beta review', 'completed') : s));
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: qk.root(makeInstance().instanceId) });
      });
      await waitFor(() => {
        expect(
          within(screen.getByRole('region', { name: 'Done' })).getByRole('link', { name: /Beta review/ }),
        ).toBeInTheDocument();
      });
      expect(document.activeElement?.getAttribute('data-key')).toBe(key);
    });
  });

  describe('states', () => {
    it('explains an empty list with the likely causes and the window', async () => {
      renderList({ sessions: () => [] });
      expect(await screen.findByText('No sessions to show')).toBeInTheDocument();
      expect(screen.getByText(/Only sessions written to in the last 24 hours are listed/)).toBeInTheDocument();
    });

    it('shows a readable failure and no rows', async () => {
      renderList({ sessions: () => errorResponse('internal_error') });
      expect(await screen.findByText(/Could not load sessions/)).toBeInTheDocument();
      expect(rowLinks()).toHaveLength(0);
    });
  });
});
