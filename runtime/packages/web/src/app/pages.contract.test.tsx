import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeApi, type FakeHandlers } from '../test/fake-api.ts';
import { createFakeEventSources } from '../test/fake-event-source.ts';
import { stubResizeObserver } from '../test/fake-terminal.ts';
import { msg } from '../test/msg.ts';
import {
  CONTRACT_DETAIL_TABS,
  CONTRACT_PAGES,
  CONTRACT_SETTINGS_SECTIONS,
  FRAME_LANDMARKS,
  MATRIX_SESSION_LABEL,
  PAGE_MATRIX,
  SHELL_ENTRY_POINTS,
  matrixHandlers,
  matrixInstance,
} from '../test/page-matrix.ts';
import { renderWithIntl } from '../test/render.tsx';
import { DETAIL_TABS, SETTINGS_SECTIONS } from '../lib/url-state.ts';
import { AppRoutes, ROUTES, type PageKey } from './routes.tsx';

/** The keys of the route table: the matrix and the pages of the browser contract must cover them all. */
const ROUTE_KEYS: readonly PageKey[] = ROUTES.map((route) => route.key);

// The page contract (CAW-50, from WP-123; design 05 section 6): every route of the table renders the real shell around the real
// page, with one `main`, one `h1`, a named navigation and a skip link whose target exists; and a navigation moves the focus to the
// `h1` of the new page. The page matrix holds the data and the expectations. The same file holds the list of pages the browser
// contract suite walks (`e2e/qa/contract.ts`): the first tests keep both lists equal to the route table, so a route that is added
// without a matrix entry or without a page of the browser contract fails here, before any browser starts.

function renderPage(path: string, locale: 'en' | 'vi' = 'en', handlersOf: () => FakeHandlers = matrixHandlers) {
  const handlers = handlersOf();
  const instance = matrixInstance();
  const api = createFakeApi({ ...handlers, instance: () => instance });
  const rendered = renderWithIntl(<AppRoutes />, { route: path, api, instance, locale });
  return { ...rendered, api };
}

beforeEach(() => {
  // The Workspace reads the size of its pane and opens the event stream of the terminals: jsdom has neither.
  stubResizeObserver();
  const sources = createFakeEventSources();
  function FakeEventSourceConstructor(url: string) {
    return sources.factory(url);
  }
  vi.stubGlobal('EventSource', FakeEventSourceConstructor);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the page matrix', () => {
  it('has one case per route of the table, in the order of the table', () => {
    expect(PAGE_MATRIX.map((entry) => entry.id)).toEqual(ROUTE_KEYS);
  });

  it('opens each case at a path of its own route', () => {
    for (const entry of PAGE_MATRIX) {
      const route = ROUTES.find((candidate) => candidate.key === entry.id);
      expect(route, entry.id).toBeDefined();
      const pattern = new RegExp(`^${(route?.path ?? '').replace(/:[A-Za-z]+/g, '[^/]+')}(\\?.*)?$`);
      expect(entry.path, entry.id).toMatch(pattern);
    }
  });
});

describe('the pages of the browser contract', () => {
  it('cover every route of the table: a route without a contract page fails here', () => {
    const covered = new Set(CONTRACT_PAGES.map((page) => page.route));
    expect(ROUTE_KEYS.filter((key) => !covered.has(key))).toEqual([]);
  });

  it('name only routes of the table, and the base page of each route comes first, in the order of the table', () => {
    const unknown = CONTRACT_PAGES.filter((page) => !ROUTE_KEYS.includes(page.route)).map((page) => page.id);
    expect(unknown).toEqual([]);
    const base = CONTRACT_PAGES.filter((page) => page.query === undefined);
    expect(base.map((page) => page.route)).toEqual(ROUTE_KEYS);
    expect(CONTRACT_PAGES.slice(0, base.length)).toEqual(base);
  });

  it('have unique ids, a view to open and a selector that proves the content', () => {
    const ids = CONTRACT_PAGES.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const page of CONTRACT_PAGES) {
      expect(page.view, page.id).not.toBe('');
      expect(page.content, page.id).not.toBe('');
    }
  });

  it('open every tab of the session page and every section of Settings', () => {
    const queries = (route: string): (string | undefined)[] =>
      CONTRACT_PAGES.filter((page) => page.route === route).map((page) => page.query);
    // the base view of the session page is the transcript tab, the one of Settings names the health section in its own query
    expect(['transcript', ...CONTRACT_DETAIL_TABS]).toEqual([...DETAIL_TABS]);
    expect(queries('sessionDetail')).toEqual([undefined, ...CONTRACT_DETAIL_TABS.map((tab) => `tab=${tab}`)]);
    expect(['health', ...CONTRACT_SETTINGS_SECTIONS]).toEqual([...SETTINGS_SECTIONS]);
    expect(queries('settings')).toEqual([
      undefined,
      ...CONTRACT_SETTINGS_SECTIONS.map((section) => `section=${section}`),
    ]);
  });

  it('take the heading of a page from the title of its route, or from the data or the state of the page', () => {
    for (const page of CONTRACT_PAGES) {
      const route = ROUTES.find((candidate) => candidate.key === page.route);
      // the session page is named after its session, the Workspace after its pane; every other page after its route
      const expected =
        page.route === 'sessionDetail' ? null : page.route === 'workspace' ? page.heading : route?.titleKey;
      expect(page.heading, page.id).toBe(expected);
    }
  });
});

describe.each(PAGE_MATRIX)('page $id', (entry) => {
  it('renders one main landmark and one h1 with the name of the page', async () => {
    renderPage(entry.path, 'en', entry.handlers);
    const heading = await screen.findByRole('heading', { level: 1, name: entry.heading('en') });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 1 })).toBe(heading);
  });

  it('names the sidebar and the navigation landmark and marks the current entry', async () => {
    renderPage(entry.path, 'en', entry.handlers);
    await screen.findByRole('heading', { level: 1, name: entry.heading('en') });
    const aside = await screen.findByRole('complementary', { name: msg(FRAME_LANDMARKS.complementary) });
    const nav = within(aside).getByRole('navigation', { name: msg(FRAME_LANDMARKS.navigation) });
    const current = within(nav)
      .queryAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    if (entry.currentNav === null) {
      expect(current).toHaveLength(0);
    } else {
      const route = ROUTES.find((candidate) => candidate.key === entry.currentNav);
      expect(current.map((link) => link.getAttribute('href'))).toEqual([route?.path]);
    }
  });

  it('has a skip link to the main landmark and its target exists and can take focus', async () => {
    const user = userEvent.setup();
    renderPage(entry.path, 'en', entry.handlers);
    await screen.findByRole('heading', { level: 1, name: entry.heading('en') });
    const skip = screen.getByRole('link', { name: msg('shell.skip.main') });
    expect(skip).toHaveAttribute('href', '#main');
    const target = document.getElementById('main');
    expect(target).toBe(screen.getByRole('main'));
    expect(target).toHaveAttribute('tabindex', '-1');
    await user.click(skip);
    expect(document.activeElement).toBe(target);
  });

  it('reaches the entry points of the shell and of the page by role and name', async () => {
    renderPage(entry.path, 'en', entry.handlers);
    await screen.findByRole('heading', { level: 1, name: entry.heading('en') });
    for (const point of [...SHELL_ENTRY_POINTS, ...entry.entryPoints]) {
      expect(
        await screen.findByRole(point.role, { name: point.name('en') }),
        `${entry.id}: ${point.role} ${point.name('en')}`,
      ).toBeInTheDocument();
    }
  });

  it('keeps the same structure in Vietnamese', async () => {
    renderPage(entry.path, 'vi', entry.handlers);
    await screen.findByRole('heading', { level: 1, name: entry.heading('vi') });
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('link', { name: msg('shell.skip.main', undefined, 'vi') })).toBeInTheDocument();
    expect(
      screen.getByRole('navigation', { name: msg(FRAME_LANDMARKS.navigation, undefined, 'vi') }),
    ).toBeInTheDocument();
  });
});

describe('focus on navigation', () => {
  it.each(
    PAGE_MATRIX.filter(
      (entry) => entry.id !== 'settings' && ROUTES.some((route) => route.key === entry.id && 'nav' in route),
    ),
  )('moves the focus to the h1 of $id after a link from another page', async (entry) => {
    const user = userEvent.setup();
    renderPage('/settings');
    await screen.findByRole('heading', { level: 1, name: msg('route.settings.title') });
    const nav = screen.getByRole('navigation', { name: msg('nav.label') });
    const link = within(nav)
      .getAllByRole('link')
      .find((candidate) => candidate.getAttribute('href') === entry.path);
    expect(link, `a navigation link to ${entry.path}`).toBeDefined();
    if (link === undefined) return;
    await user.click(link);
    const heading = await screen.findByRole('heading', { level: 1, name: entry.heading('en') });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  it('moves the focus to the h1 of the session page after a click on a session of the list', async () => {
    const user = userEvent.setup();
    renderPage('/sessions');
    await screen.findByRole('heading', { level: 1, name: msg('route.sessions.title') });
    await user.click(await screen.findByRole('link', { name: new RegExp(MATRIX_SESSION_LABEL) }));
    const heading = await screen.findByRole('heading', { level: 1, name: MATRIX_SESSION_LABEL });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  it('does not move the focus on the first load', async () => {
    renderPage('/sessions');
    await screen.findByRole('heading', { level: 1, name: msg('route.sessions.title') });
    expect(document.activeElement).toBe(document.body);
  });
});
