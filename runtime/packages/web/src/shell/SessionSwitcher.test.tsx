import type { LifecycleState, SessionSummary } from '@mcs/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { qk } from '../data/query-keys.ts';
import { SWITCHER_MAX_ROWS } from '../lib/sessions-view.ts';
import { createFakeApi, errorResponse, type FakeApi } from '../test/fake-api.ts';
import { makeInstance, makeSession, makeSessionPage, makeState, sessionId } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { SessionSwitcher, useShowSwitcher } from './SessionSwitcher.tsx';

function session(n: number, label: string, state: LifecycleState, errorCount = 0): SessionSummary {
  return makeSession({ id: sessionId(n), seq: n, label, state: makeState(state), errorCount });
}

const LIST: SessionSummary[] = [
  session(1, 'Alpha build', 'working'),
  session(2, 'Beta review', 'waiting_tool'),
  session(3, 'Gamma broken', 'completed', 3),
  session(4, 'Delta done', 'completed'),
  session(5, 'Epsilon idle', 'turn_ended'),
  session(6, 'Zeta waiting', 'waiting_input'),
];

function Probe() {
  const { pathname } = useLocation();
  return <output data-testid="location">{pathname}</output>;
}

interface Setup {
  sessions?: () => SessionSummary[] | Response;
  route?: string;
  locale?: 'en' | 'vi';
}

function renderSwitcher(setup: Setup = {}) {
  const instance = makeInstance();
  const api: FakeApi = createFakeApi({
    instance: () => instance,
    listSessions: () => {
      const result = (setup.sessions ?? (() => LIST))();
      return result instanceof Response ? result : makeSessionPage(result);
    },
  });
  const page = (
    <>
      <SessionSwitcher />
      <Probe />
    </>
  );
  const rendered = renderWithIntl(
    <Routes>
      <Route path="/sessions/:sessionId" element={page} />
      <Route path="*" element={page} />
    </Routes>,
    {
      api,
      instance,
      route: setup.route ?? `/sessions/${sessionId(1)}`,
      ...(setup.locale === undefined ? {} : { locale: setup.locale }),
    },
  );
  return { ...rendered, api };
}

const rows = (): HTMLElement[] => screen.queryAllByRole('link').filter((el) => el.hasAttribute('data-session-id'));
const tabStops = (): HTMLElement[] => rows().filter((el) => el.getAttribute('tabindex') === '0');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionSwitcher (ADR 0073 decision 4)', () => {
  it('lists sessions with errors first, then the active ones, and names both groups', async () => {
    renderSwitcher();
    await screen.findByRole('link', { name: /Alpha build/ });
    const nav = screen.getByRole('navigation', { name: msg('shell.switcher.label') });
    expect(
      within(nav)
        .getAllByRole('list')
        .map((list) => list.getAttribute('aria-labelledby')),
    ).toEqual(['switcher-errors', 'switcher-active']);
    expect(rows().map((row) => row.getAttribute('data-session-id'))).toEqual([
      sessionId(3),
      sessionId(1),
      sessionId(2),
    ]);
    expect(within(nav).getByText(msg('shell.switcher.errors'))).toBeInTheDocument();
    expect(within(nav).getByText(msg('state.group.active'))).toBeInTheDocument();
  });

  it('leaves out finished sessions without errors, idle ones and the ones waiting for input', async () => {
    renderSwitcher();
    await screen.findByRole('link', { name: /Alpha build/ });
    for (const label of ['Delta done', 'Epsilon idle', 'Zeta waiting'])
      expect(screen.queryByRole('link', { name: new RegExp(label) })).toBeNull();
  });

  it('has no filter box, no show-unmatched box and no link to all sessions', async () => {
    renderSwitcher();
    await screen.findByRole('link', { name: /Alpha build/ });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('link', { name: /All sessions/ })).toBeNull();
  });

  it('asks for the current window only', async () => {
    const { api } = renderSwitcher();
    await screen.findByRole('link', { name: /Alpha build/ });
    expect(api.callsTo('listSessions')[0]?.query.get('window')).toBe('1');
  });

  it('marks the open session with aria-current and no other', async () => {
    renderSwitcher({ route: `/sessions/${sessionId(2)}` });
    await screen.findByRole('link', { name: /Beta review/ });
    const current = rows().filter((row) => row.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Beta review');
  });

  it('says the state in words and the number of errors for each row', async () => {
    renderSwitcher();
    const broken = await screen.findByRole('link', { name: /Gamma broken/ });
    expect(broken).toHaveTextContent(msg('state.completed.label'));
    expect(broken).toHaveTextContent(msg('shell.switcher.errorCount', { count: 3 }));
    expect(screen.getByRole('link', { name: /Alpha build/ })).toHaveTextContent(msg('state.working.label'));
  });

  it('words everything in Vietnamese', async () => {
    renderSwitcher({ locale: 'vi' });
    expect(
      await screen.findByRole('navigation', { name: msg('shell.switcher.label', undefined, 'vi') }),
    ).toBeInTheDocument();
    expect(await screen.findByText(msg('shell.switcher.errors', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Gamma broken/ })).toHaveTextContent(
      msg('shell.switcher.errorCount', { count: 3 }, 'vi'),
    );
  });

  describe('only on the session page', () => {
    it('renders nothing and asks for nothing on another route', async () => {
      const { api, container } = renderSwitcher({ route: '/sessions' });
      await waitFor(() => {
        expect(screen.getByTestId('location')).toHaveTextContent('/sessions');
      });
      expect(container.querySelector('.sidebar-switcher')).toBeNull();
      expect(api.callsTo('listSessions')).toHaveLength(0);
    });

    it('is on screen for the session route and not for the list route (useShowSwitcher)', () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
      function Shown() {
        return <output data-testid="shown">{String(useShowSwitcher())}</output>;
      }
      const onDetail = renderWithIntl(<Shown />, { route: `/sessions/${sessionId(1)}` });
      expect(screen.getByTestId('shown')).toHaveTextContent('true');
      onDetail.unmount();
      renderWithIntl(<Shown />, { route: '/sessions' });
      expect(screen.getByTestId('shown')).toHaveTextContent('false');
    });

    it('is not shown while the sidebar is the rail or the sheet (useShowSwitcher)', () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(max-width: 1199px)',
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
      function Shown() {
        return <output data-testid="shown">{String(useShowSwitcher())}</output>;
      }
      renderWithIntl(<Shown />, { route: `/sessions/${sessionId(1)}` });
      expect(screen.getByTestId('shown')).toHaveTextContent('false');
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

    it('has exactly one tab stop: the open session', async () => {
      renderSwitcher({ route: `/sessions/${sessionId(2)}` });
      await screen.findByRole('link', { name: /Beta review/ });
      expect(tabStops()).toHaveLength(1);
      expect(tabStops()[0]).toHaveTextContent('Beta review');
      expect(rows().filter((el) => el.getAttribute('tabindex') === '-1')).toHaveLength(2);
    });

    it('makes the first row the tab stop when the open session is not listed', async () => {
      renderSwitcher({ route: `/sessions/${sessionId(4)}` });
      await screen.findByRole('link', { name: /Alpha build/ });
      expect(tabStops()).toHaveLength(1);
      expect(tabStops()[0]).toHaveTextContent('Gamma broken');
    });

    it('moves with Up, Down, Home and End and moves the tab stop with the focus', async () => {
      const user = userEvent.setup();
      renderSwitcher();
      await focusTabStop();

      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toHaveTextContent('Beta review');
      expect(tabStops()).toHaveLength(1);
      expect(tabStops()[0]).toBe(document.activeElement);

      await user.keyboard('{End}');
      expect(document.activeElement).toHaveTextContent('Beta review');
      await user.keyboard('{Home}');
      expect(document.activeElement).toHaveTextContent('Gamma broken');
      await user.keyboard('{ArrowUp}');
      expect(document.activeElement).toHaveTextContent('Gamma broken');
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(document.activeElement).toHaveTextContent('Beta review');
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toHaveTextContent('Beta review');
    });

    it('opens the focused session with Enter', async () => {
      const user = userEvent.setup();
      renderSwitcher();
      await focusTabStop();
      await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
      expect(screen.getByTestId('location')).toHaveTextContent(`/sessions/${sessionId(2)}`);
    });

    it('keeps focus on the same session when a refresh moves it to another group', async () => {
      const user = userEvent.setup();
      let current = LIST;
      const { queryClient } = renderSwitcher({ sessions: () => current });
      await focusTabStop();
      await user.keyboard('{ArrowDown}');
      const id = document.activeElement?.getAttribute('data-session-id');
      expect(id).toBe(sessionId(2));

      current = LIST.map((s) => (s.id === sessionId(2) ? session(2, 'Beta review', 'waiting_tool', 2) : s));
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: qk.root(makeInstance().instanceId) });
      });
      await waitFor(() => {
        expect(rows().map((row) => row.getAttribute('data-session-id'))).toEqual([
          sessionId(2),
          sessionId(3),
          sessionId(1),
        ]);
      });
      expect(document.activeElement?.getAttribute('data-session-id')).toBe(id);
    });
  });

  describe('large and hostile lists', () => {
    it('caps a full page of sessions and links to the Sessions page for the rest', async () => {
      const many = Array.from({ length: 200 }, (_, i) => session(i + 1, `Run ${String(i + 1)}`, 'working'));
      renderSwitcher({ sessions: () => many });
      await screen.findByRole('link', { name: /^Run 1 / });
      expect(rows()).toHaveLength(SWITCHER_MAX_ROWS);
      const more = screen.getByRole('link', { name: msg('shell.switcher.more', { count: 200 - SWITCHER_MAX_ROWS }) });
      expect(more).toHaveAttribute('href', '/sessions');
    });

    it('copes with an open session id that holds percent signs and spaces', async () => {
      renderSwitcher({ route: `/sessions/${encodeURIComponent('50%-a b/c')}` });
      await screen.findByRole('link', { name: /Alpha build/ });
      expect(rows().filter((row) => row.getAttribute('aria-current') === 'page')).toHaveLength(0);
      expect(tabStops()).toHaveLength(1);
    });

    it('shows a label as text, never as markup', async () => {
      const hostile = makeSession({
        id: sessionId(7),
        seq: 7,
        label: '<img src=x onerror=alert(1)>',
        state: makeState('working'),
      });
      renderSwitcher({ sessions: () => [hostile] });
      expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
      expect(document.querySelector('img')).toBeNull();
    });
  });

  describe('states', () => {
    it('says so while the list loads and when it is empty', async () => {
      renderSwitcher({ sessions: () => [session(4, 'Delta done', 'completed')] });
      expect(screen.getByText(msg('shell.switcher.loading'))).toBeInTheDocument();
      expect(await screen.findByText(msg('shell.switcher.empty'))).toBeInTheDocument();
    });

    it('shows a readable failure and no rows', async () => {
      renderSwitcher({ sessions: () => errorResponse('internal_error') });
      expect(await screen.findByText(/Could not load/)).toBeInTheDocument();
      expect(rows()).toHaveLength(0);
    });
  });
});
