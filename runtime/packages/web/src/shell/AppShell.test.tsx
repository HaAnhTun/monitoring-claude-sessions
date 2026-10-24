import type { InstanceInfo } from '@mcs/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, useState, type ComponentType, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PageRegistryContext, type PageRegistry } from '../app/routes.tsx';
import { usePageChrome } from '../app/usePageChrome.ts';
import { StaleDataIndicator } from '../components/StaleDataIndicator.tsx';
import { qk } from '../data/query-keys.ts';
import { createPrefs } from '../lib/prefs.ts';
import { AnnouncerProvider, useAnnounce } from '../state/announcer.tsx';
import { createPrefsStore, type PrefsStore } from '../state/prefs-store.ts';
import { ShortcutRegistryProvider, useShortcut } from '../state/shortcuts-registry.tsx';
import { createToastStore, ToastStoreContext, useShowToast, useToasts, type ToastStore } from '../state/toast-store.ts';
import { createFakeApi, errorResponse, type FakeApi } from '../test/fake-api.ts';
import {
  makeInstance,
  makeMetric,
  makeOverview,
  makeSession,
  makeSessionPage,
  makeState,
  sessionId,
  FIXTURE_INSTANCE_ID,
} from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithProviders } from '../test/render.tsx';
import { AppShell } from './AppShell.tsx';

const OTHER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

function Page({ title }: { title: string }) {
  const headingRef = usePageChrome(title);
  const { pathname, search, hash } = useLocation();
  return (
    <section>
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      <output data-testid="location">{pathname + search + hash}</output>
    </section>
  );
}

/** A page whose own refresh fails: it shows the stale line, which marks the shell's `main` (UI-I5). */
function StalePage() {
  return (
    <>
      <Page title="Stale" />
      <StaleDataIndicator asOf={null} fetchFailing scope="sessions" />
    </>
  );
}

const lazyOf = (component: ComponentType) => lazy(() => Promise.resolve({ default: component }));
const page = lazyOf(() => null);

/** Every page of the route table is registered, so the navigation lists them all (the shell reads the registry from the router). */
const ALL_PAGES: PageRegistry = {
  overview: page,
  sessions: page,
  sessionDetail: page,
  activity: page,
  tasks: page,
  analytics: page,
  settings: page,
};

function Pages() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Page title="Overview" />} />
        <Route path="/sessions" element={<Page title="Sessions" />} />
        <Route path="/sessions/:sessionId" element={<Page title="Session" />} />
        <Route path="/settings" element={<Page title="Settings" />} />
        <Route path="/stale" element={<StalePage />} />
        <Route path="*" element={<Page title="Unknown" />} />
      </Route>
    </Routes>
  );
}

interface ShellOptions {
  route?: string;
  instance?: InstanceInfo;
  instanceId?: string | null;
  api?: FakeApi;
  store?: PrefsStore;
  locale?: 'en' | 'vi';
  openAlerts?: number;
  toastStore?: ToastStore;
}

function renderShell(options: ShellOptions = {}) {
  const store = options.store ?? createPrefsStore(createPrefs(null));
  const instance = options.instance ?? makeInstance();
  const api =
    options.api ??
    createFakeApi({
      instance: () => instance,
      listSessions: () =>
        makeSessionPage([
          makeSession({ id: sessionId(1), seq: 1, label: 'Alpha build', state: makeState('working') }),
          makeSession({ id: sessionId(2), seq: 2, label: 'Beta done', state: makeState('completed') }),
        ]),
      overview: () =>
        makeOverview({
          metrics: [makeMetric({ key: 'sessions.active', value: 1 })],
          alerts: { open: options.openAlerts ?? 0, critical: 0, items: [] },
        }),
    });
  const rendered = renderWithProviders(<Pages />, {
    route: options.route ?? '/',
    instance,
    api,
    prefsStore: store,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
    wrap: (children: ReactNode) => (
      <PageRegistryContext value={ALL_PAGES}>
        {options.toastStore === undefined ? (
          children
        ) : (
          <ToastStoreContext value={options.toastStore}>{children}</ToastStoreContext>
        )}
      </PageRegistryContext>
    ),
  });
  return { ...rendered, store, api };
}

/**
 * Makes `matchMedia` answer for a window of `width` px (the max-width queries of ADR 0071); the returned function resizes it and
 * notifies the listeners, like a browser. The environment has no `matchMedia` otherwise, which reads as a wide window.
 */
function stubWidth(initial: number): (next: number) => void {
  let width = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      const max = /max-width: *([0-9]+)px/.exec(query);
      return max !== null && width <= Number(max[1]);
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
  }));
  return (next) => {
    width = next;
    act(() => {
      for (const listener of [...listeners]) listener();
    });
  };
}

function liveRegion(): HTMLElement {
  const region = document.getElementById('live-region');
  if (region === null) throw new Error('no live region');
  return region;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
  document.title = '';
});

describe('AppShell (04-ui.md 4.1, 4.4, 6.6)', () => {
  // The test environment reports a 1024 px window, which would make every test a rail; the default here is a wide window.
  beforeEach(() => {
    stubWidth(1440);
  });

  it('renders the landmarks of 6.6 rule 1 around the routed page', async () => {
    renderShell();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(await screen.findByRole('complementary', { name: msg('shell.sidebar.label') })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: msg('nav.label') })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(within(main).getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('puts the sidebar before the main region in the reading order', async () => {
    renderShell();
    const sidebar = await screen.findByRole('complementary');
    expect(sidebar.compareDocumentPosition(screen.getByRole('main')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the TopBar: title, task, both chips and the refresh button, and no second heading (CR-WP-48-2)', async () => {
    renderShell();
    const banner = screen.getByRole('banner');
    await waitFor(() => {
      expect(banner).toHaveTextContent('FIXTURE monitor');
    });
    expect(banner.querySelector('[data-chip="connection"]')).not.toBeNull();
    expect(banner.querySelector('[data-chip="ingestion"]')).not.toBeNull();
    expect(within(banner).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(banner).queryByRole('heading')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows the chips and the fallback title while the instance is still loading', () => {
    const api = createFakeApi({ instance: () => new Promise<InstanceInfo>(() => undefined) });
    renderShell({ api, instanceId: null });
    const banner = screen.getByRole('banner');
    expect(banner).toHaveTextContent('Claude session monitor');
    expect(banner.querySelector('[data-chip="connection"]')).toHaveTextContent('Connecting...');
    expect(banner.querySelector('[data-chip="ingestion"]')).not.toBeNull();
    expect(within(banner).queryByRole('button', { name: /^Theme:/ })).toBeNull();
  });

  it('marks the main region data-stale while a page shows a stale line, and only then', async () => {
    const quiet = renderShell();
    await screen.findByRole('complementary');
    expect(screen.getByRole('main')).not.toHaveAttribute('data-stale');
    quiet.unmount();

    renderShell({ route: '/stale' });
    await screen.findByRole('complementary');
    expect(screen.getByRole('main')).toHaveAttribute('data-stale', 'true');
    expect(within(screen.getByRole('main')).getByText(/sessions: refresh failing/)).toBeInTheDocument();
  });

  it('has one polite atomic live region', async () => {
    renderShell();
    await screen.findByRole('complementary');
    const region = liveRegion();
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(document.querySelectorAll('#live-region')).toHaveLength(1);
  });

  it('shows only the frame and a skeleton until the instance is known, then the sidebar', async () => {
    let release: (value: InstanceInfo) => void = () => undefined;
    const pending = new Promise<InstanceInfo>((resolve) => {
      release = resolve;
    });
    const api = createFakeApi({ instance: () => pending, listSessions: () => makeSessionPage([]) });
    renderShell({ api, instanceId: null });
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(msg('common.loadingPage'))).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).toBeNull();

    release(makeInstance());
    expect(await screen.findByRole('complementary', { name: msg('shell.sidebar.label') })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  });

  it('shows a failure page when the instance cannot be loaded and recovers on retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    const instance = makeInstance();
    const api = createFakeApi({
      instance: () => (fail ? errorResponse('internal_error') : instance),
      listSessions: () => makeSessionPage([]),
    });
    renderShell({ api, instanceId: null });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(msg('error.subject.monitor'));
    expect(screen.queryByRole('complementary')).toBeNull();

    fail = false;
    await user.click(within(alert).getByRole('button', { name: msg('common.retryNow') }));
    expect(await screen.findByRole('complementary', { name: msg('shell.sidebar.label') })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('degrades to the bare main landmark when no API client is provided', () => {
    render(
      <MemoryRouter>
        <Pages />
      </MemoryRouter>,
    );
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  describe('skip links', () => {
    it('is the first focusable element and moves focus without touching the URL', async () => {
      const user = userEvent.setup();
      renderShell({ route: '/sessions' });
      await screen.findByRole('complementary');

      await user.tab();
      expect(document.activeElement).toHaveTextContent(msg('shell.skip.main'));
      expect(screen.getAllByRole('link', { name: /^Skip to/ })).toHaveLength(1);

      await user.click(screen.getByRole('link', { name: msg('shell.skip.main') }));
      expect(screen.getByRole('main')).toHaveFocus();
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/sessions$/);
      expect(window.location.hash).toBe('');
    });

    it('adds a link to the session switcher on the session page and nowhere else', async () => {
      const user = userEvent.setup();
      renderShell({ route: `/sessions/${sessionId(1)}` });
      await screen.findByTestId('session-list');
      await user.tab();
      await user.tab();
      expect(document.activeElement).toHaveTextContent(msg('shell.skip.switcher'));
      await user.click(screen.getByRole('link', { name: msg('shell.skip.switcher') }));
      expect(screen.getByTestId('session-list')).toHaveFocus();
      expect(window.location.hash).toBe('');
    });

    it('has no link to the switcher where there is no switcher', async () => {
      renderShell({ route: '/' });
      await screen.findByRole('complementary');
      expect(screen.queryByRole('link', { name: msg('shell.skip.switcher') })).toBeNull();
    });
  });

  describe('navigation', () => {
    it('lists the registered pages and marks the current one with aria-current', async () => {
      renderShell({ route: '/sessions' });
      const nav = await screen.findByRole('navigation', { name: msg('nav.label') });
      expect(
        within(nav)
          .getAllByRole('link')
          .map((a) => a.getAttribute('href')),
      ).toEqual(['/', '/sessions', '/activity', '/tasks', '/analytics', '/settings']);
      expect(within(nav).getByRole('link', { name: new RegExp(`^${msg('route.sessions.title')}`) })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(within(nav).getByRole('link', { name: msg('route.overview.title') })).not.toHaveAttribute('aria-current');
    });

    it('keeps Sessions current on a session page', async () => {
      renderShell({ route: `/sessions/${sessionId(1)}` });
      const nav = await screen.findByRole('navigation', { name: msg('nav.label') });
      expect(within(nav).getByRole('link', { name: new RegExp(`^${msg('route.sessions.title')}`) })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });

    it('counts the active sessions with their unit, from the overview', async () => {
      renderShell();
      const nav = await screen.findByRole('navigation', { name: msg('nav.label') });
      expect(
        await within(nav).findByRole('link', {
          name: `${msg('route.sessions.title')} ${msg('nav.count.sessions', { count: 1 })}`,
        }),
      ).toBeInTheDocument();
    });

    it('counts the open alerts on Settings only when there are some', async () => {
      const none = renderShell();
      await within(await screen.findByRole('navigation', { name: msg('nav.label') })).findByText(
        msg('nav.count.sessions', { count: 1 }),
      );
      expect(screen.queryByText(msg('nav.count.alerts', { count: 0 }))).toBeNull();
      none.unmount();

      renderShell({ openAlerts: 2 });
      expect(await screen.findByText(msg('nav.count.alerts', { count: 2 }))).toBeInTheDocument();
    });

    it('does not load the session list for the sidebar outside the session page', async () => {
      const { api } = renderShell({ route: '/sessions' });
      await within(await screen.findByRole('navigation', { name: msg('nav.label') })).findByText(
        msg('nav.count.sessions', { count: 1 }),
      );
      expect(screen.queryByTestId('session-list')).toBeNull();
      expect(screen.queryByRole('searchbox')).toBeNull();
      expect(api.callsTo('listSessions')).toHaveLength(0);
    });

    it('shows the session switcher on the session page', async () => {
      renderShell({ route: `/sessions/${sessionId(1)}` });
      const switcher = await screen.findByRole('navigation', { name: msg('shell.switcher.label') });
      expect(await within(switcher).findByRole('link', { name: /Alpha build/ })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });

    it('adds one tab stop for the switcher and one per page to the sidebar', async () => {
      renderShell({ route: `/sessions/${sessionId(1)}` });
      const sidebar = await screen.findByRole('complementary');
      await screen.findByRole('link', { name: /Alpha build/ });
      const stops = [...sidebar.querySelectorAll<HTMLElement>('a[href], button')].filter(
        (el) => el.getAttribute('tabindex') !== '-1',
      );
      expect(stops).toHaveLength(6 + 1);
    });

    it('moves focus to the page heading after a navigation but not on the first load', async () => {
      const user = userEvent.setup();
      renderShell({ route: '/sessions' });
      await screen.findByRole('complementary');
      expect(document.activeElement).toBe(document.body);
      await user.click(
        within(screen.getByRole('navigation', { name: msg('nav.label') })).getByRole('link', {
          name: msg('route.settings.title'),
        }),
      );
      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toHaveFocus();
      });
    });

    it('keeps the frame around a route that no page claims', async () => {
      renderShell({ route: '/no/such/page' });
      expect(await screen.findByRole('heading', { level: 1, name: 'Unknown' })).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: msg('nav.label') })).toBeInTheDocument();
      expect(screen.getAllByRole('main')).toHaveLength(1);
    });

    it('re-words the navigation when the language changes', async () => {
      const { prefsStore } = renderShell();
      const nav = await screen.findByRole('navigation', { name: msg('nav.label') });
      expect(within(nav).getByRole('link', { name: msg('route.activity.title') })).toBeInTheDocument();
      act(() => {
        prefsStore.setPref('locale', 'vi');
      });
      expect(await screen.findByRole('navigation', { name: msg('nav.label', undefined, 'vi') })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: msg('route.activity.title', undefined, 'vi') })).toBeInTheDocument();
      expect(
        screen.getByRole('complementary', { name: msg('shell.sidebar.label', undefined, 'vi') }),
      ).toBeInTheDocument();
    });
  });

  describe('layout modes (ADR 0071 decision 6)', () => {
    it('is the full sidebar from 1200 px', async () => {
      stubWidth(1440);
      renderShell();
      const sidebar = await screen.findByRole('complementary');
      expect(sidebar).toHaveAttribute('data-mode', 'full');
      expect(screen.queryByRole('button', { name: msg('shell.menu.open') })).toBeNull();
      expect(within(sidebar).getByRole('link', { name: msg('route.activity.title') })).not.toHaveAttribute('title');
    });

    it('is a rail from 900 px with the labels as tooltips and no session switcher', async () => {
      stubWidth(1024);
      renderShell({ route: `/sessions/${sessionId(1)}` });
      const sidebar = await screen.findByRole('complementary');
      expect(sidebar).toHaveAttribute('data-mode', 'rail');
      expect(within(sidebar).getByRole('link', { name: msg('route.activity.title') })).toHaveAttribute(
        'title',
        msg('route.activity.title'),
      );
      await within(sidebar).findByText(msg('nav.count.sessions', { count: 1 }));
      expect(
        within(sidebar).getByRole('link', { name: new RegExp(`^${msg('route.sessions.title')}`) }),
      ).toHaveAttribute('title', `${msg('route.sessions.title')}: ${msg('nav.count.sessions', { count: 1 })}`);
      expect(screen.queryByTestId('session-list')).toBeNull();
      expect(screen.queryByRole('link', { name: msg('shell.skip.switcher') })).toBeNull();
    });

    describe('sheet below 900 px', () => {
      it('shows a Menu bar and keeps the navigation closed', async () => {
        stubWidth(600);
        renderShell();
        const menu = await screen.findByRole('button', { name: msg('shell.menu.open') });
        expect(menu).toHaveAttribute('aria-expanded', 'false');
        expect(menu).toHaveAttribute('aria-controls', 'sidebar');
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.queryByRole('navigation', { name: msg('nav.label') })).toBeNull();
      });

      it('opens as a dialog, takes the focus, remembers the state and closes with the button', async () => {
        stubWidth(600);
        const user = userEvent.setup();
        const { prefsStore } = renderShell({ route: '/sessions' });
        const menu = await screen.findByRole('button', { name: msg('shell.menu.open') });
        await user.click(menu);
        const dialog = await screen.findByRole('dialog', { name: msg('shell.menu.title') });
        expect(menu).toHaveAttribute('aria-expanded', 'true');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(prefsStore.getSnapshot().navOpen).toBe(true);
        expect(within(dialog).getByRole('navigation', { name: msg('nav.label') })).toBeInTheDocument();
        expect(dialog.contains(document.activeElement)).toBe(true);
        expect(document.activeElement).toHaveAttribute('aria-current', 'page');

        await user.click(within(dialog).getByRole('button', { name: msg('shell.menu.close') }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(prefsStore.getSnapshot().navOpen).toBe(false);
        expect(menu).toHaveFocus();
      });

      it('closes on Escape and gives the focus back to the Menu button', async () => {
        stubWidth(600);
        const user = userEvent.setup();
        renderShell();
        const menu = await screen.findByRole('button', { name: msg('shell.menu.open') });
        await user.click(menu);
        await screen.findByRole('dialog');
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(menu).toHaveFocus();
      });

      it('traps the focus: Tab from the last control goes to the first and Shift+Tab back', async () => {
        stubWidth(600);
        const user = userEvent.setup();
        renderShell();
        await user.click(await screen.findByRole('button', { name: msg('shell.menu.open') }));
        const dialog = await screen.findByRole('dialog');
        const controls = [...dialog.querySelectorAll<HTMLElement>('a[href], button')];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (first === undefined || last === undefined) throw new Error('no controls in the sheet');
        act(() => {
          last.focus();
        });
        await user.tab();
        expect(first).toHaveFocus();
        await user.tab({ shift: true });
        expect(last).toHaveFocus();
        for (let i = 0; i < controls.length + 2; i += 1) {
          await user.tab();
          expect(dialog.contains(document.activeElement)).toBe(true);
        }
      });

      it('closes after a navigation and leaves the focus to the new page', async () => {
        stubWidth(600);
        const user = userEvent.setup();
        renderShell({ route: '/sessions' });
        await user.click(await screen.findByRole('button', { name: msg('shell.menu.open') }));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('link', { name: msg('route.settings.title') }));
        await waitFor(() => {
          expect(screen.queryByRole('dialog')).toBeNull();
        });
        await waitFor(() => {
          expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toHaveFocus();
        });
      });

      it('closes on a click outside the sheet', async () => {
        stubWidth(600);
        const user = userEvent.setup();
        renderShell();
        await user.click(await screen.findByRole('button', { name: msg('shell.menu.open') }));
        await screen.findByRole('dialog');
        const backdrop = document.querySelector('.sidebar-backdrop');
        if (backdrop === null) throw new Error('no backdrop');
        await user.click(backdrop);
        expect(screen.queryByRole('dialog')).toBeNull();
      });

      it('turns into the full sidebar when the window grows, and does not come back open', async () => {
        const resize = stubWidth(600);
        const user = userEvent.setup();
        const { prefsStore } = renderShell();
        await user.click(await screen.findByRole('button', { name: msg('shell.menu.open') }));
        await screen.findByRole('dialog');
        resize(1440);
        expect(await screen.findByRole('complementary')).toHaveAttribute('data-mode', 'full');
        expect(screen.queryByRole('button', { name: msg('shell.menu.open') })).toBeNull();
        await waitFor(() => {
          expect(prefsStore.getSnapshot().navOpen).toBe(false);
        });
        resize(600);
        expect(await screen.findByRole('button', { name: msg('shell.menu.open') })).toHaveAttribute(
          'aria-expanded',
          'false',
        );
      });

      it('words the bar and the sheet in Vietnamese', async () => {
        stubWidth(600);
        const user = userEvent.setup();
        renderShell({ locale: 'vi' });
        await user.click(await screen.findByRole('button', { name: msg('shell.menu.open', undefined, 'vi') }));
        const dialog = await screen.findByRole('dialog', { name: msg('shell.menu.title', undefined, 'vi') });
        expect(
          within(dialog).getByRole('button', { name: msg('shell.menu.close', undefined, 'vi') }),
        ).toBeInTheDocument();
      });
    });
  });

  describe('toasts', () => {
    it('shows a toast in a named region and dismisses it with its button', async () => {
      const user = userEvent.setup();
      const toastStore = createToastStore();
      renderShell({ toastStore });
      await screen.findByRole('complementary');
      expect(screen.queryByRole('region', { name: msg('toast.region') })).toBeNull();
      act(() => {
        toastStore.show('Link copied');
      });
      const region = await screen.findByRole('region', { name: msg('toast.region') });
      expect(within(region).getByText('Link copied')).toBeInTheDocument();
      await user.click(within(region).getByRole('button', { name: msg('toast.dismiss') }));
      expect(screen.queryByRole('region', { name: msg('toast.region') })).toBeNull();
    });

    it('words the region and the button in Vietnamese', async () => {
      const toastStore = createToastStore();
      renderShell({ toastStore, locale: 'vi' });
      await screen.findByRole('complementary');
      act(() => {
        toastStore.show('Link copied');
      });
      const region = await screen.findByRole('region', { name: msg('toast.region', undefined, 'vi') });
      expect(within(region).getByRole('button', { name: msg('toast.dismiss', undefined, 'vi') })).toBeInTheDocument();
    });
  });

  describe('preference controls', () => {
    it('cycles the theme auto, light, dark, auto, sets data-theme and announces it', async () => {
      const user = userEvent.setup();
      const { store } = renderShell();
      const button = await screen.findByRole('button', { name: 'Theme: auto' });
      await user.click(button);
      expect(screen.getByRole('button', { name: 'Theme: light' })).toBeInTheDocument();
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');
      await user.click(screen.getByRole('button', { name: 'Theme: light' }));
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      await waitFor(() => {
        expect(liveRegion()).toHaveTextContent('Theme: dark');
      });
      await user.click(screen.getByRole('button', { name: 'Theme: dark' }));
      expect(document.documentElement).toHaveAttribute('data-theme', 'auto');
      expect(store.getSnapshot().theme).toBe('auto');
    });

    it('toggles the density and announces it', async () => {
      const user = userEvent.setup();
      renderShell();
      await user.click(await screen.findByRole('button', { name: 'Density: comfortable' }));
      expect(document.documentElement).toHaveAttribute('data-density', 'compact');
      expect(screen.getByRole('button', { name: 'Density: compact' })).toBeInTheDocument();
      await waitFor(() => {
        expect(liveRegion()).toHaveTextContent('Density: compact');
      });
    });

    it('uses the instance default until a preference is stored', async () => {
      renderShell({ instance: makeInstance({ ui: { ...makeInstance().ui, theme: 'dark', density: 'compact' } }) });
      expect(await screen.findByRole('button', { name: 'Theme: dark' })).toBeInTheDocument();
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    });

    it('prefers the stored value over the instance default', async () => {
      const store = createPrefsStore(createPrefs(null));
      store.setPref('theme', 'light');
      renderShell({ store, instance: makeInstance({ ui: { ...makeInstance().ui, theme: 'dark' } }) });
      expect(await screen.findByRole('button', { name: 'Theme: light' })).toBeInTheDocument();
    });
  });

  describe('shortcuts dialog', () => {
    it('opens with ?, lists the active shortcuts and closes with its button', async () => {
      const user = userEvent.setup();
      renderShell();
      await screen.findByRole('complementary');
      await user.keyboard('?');
      const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
      expect(within(dialog).getByText('Show this list of shortcuts')).toBeInTheDocument();
      expect(within(dialog).getByText('Up / Down / Home / End')).toBeInTheDocument();
      expect(within(dialog).getByText('Esc')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    it('opens from the button of the preference controls', async () => {
      const user = userEvent.setup();
      renderShell();
      await user.click(await screen.findByRole('button', { name: 'Shortcuts' }));
      expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    });
  });

  describe('instance changed notice (UI-I11)', () => {
    it('stays quiet for the same instance and remembers its id', async () => {
      const store = createPrefsStore(createPrefs(null));
      store.setPref('lastInstanceId', FIXTURE_INSTANCE_ID);
      renderShell({ store });
      await screen.findByRole('complementary');
      expect(screen.queryByText(msg('shell.instanceChanged.body'))).toBeNull();
      expect(store.getSnapshot().lastInstanceId).toBe(FIXTURE_INSTANCE_ID);
    });

    it('stays quiet on the very first visit and stores the id', async () => {
      const { store } = renderShell();
      await screen.findByRole('complementary');
      expect(screen.queryByText(msg('shell.instanceChanged.body'))).toBeNull();
      await waitFor(() => {
        expect(store.getSnapshot().lastInstanceId).toBe(FIXTURE_INSTANCE_ID);
      });
    });

    it('tells the user when the stored instance id differs, and can be dismissed', async () => {
      const user = userEvent.setup();
      const store = createPrefsStore(createPrefs(null));
      store.setPref('lastInstanceId', OTHER_INSTANCE_ID);
      renderShell({ store });
      const notice = await screen.findByText(msg('shell.instanceChanged.body'));
      expect(notice).toBeInTheDocument();
      expect(store.getSnapshot().lastInstanceId).toBe(FIXTURE_INSTANCE_ID);
      await user.click(screen.getByRole('button', { name: msg('shell.instanceChanged.dismiss') }));
      expect(screen.queryByText(msg('shell.instanceChanged.body'))).toBeNull();
    });

    it('clears the cached data of the old instance when the id changes while the page is open', async () => {
      const { queryClient } = renderShell();
      await screen.findByRole('complementary');
      await waitFor(() => {
        expect(queryClient.getQueryCache().findAll({ queryKey: qk.root(FIXTURE_INSTANCE_ID) }).length).toBeGreaterThan(
          0,
        );
      });

      act(() => {
        queryClient.setQueryData(qk.instance(), makeInstance({ instanceId: OTHER_INSTANCE_ID }));
      });

      expect(await screen.findByText(msg('shell.instanceChanged.body'))).toBeInTheDocument();
      expect(queryClient.getQueryCache().findAll({ queryKey: qk.root(FIXTURE_INSTANCE_ID) })).toHaveLength(0);
    });
  });
});

describe('announcer (04-ui.md 6.6 rule 6)', () => {
  function Announcing({ message }: { message: string }) {
    const announce = useAnnounce();
    return (
      <button
        type="button"
        onClick={() => {
          announce(message);
        }}
      >
        say
      </button>
    );
  }

  it('sets the message in the shared region after a short delay', async () => {
    const user = userEvent.setup();
    render(
      <AnnouncerProvider>
        <Announcing message="Following new events" />
      </AnnouncerProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'say' }));
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent('Following new events');
    });
  });

  it('is a harmless no-op outside a provider', async () => {
    const user = userEvent.setup();
    render(<Announcing message="nobody listens" />);
    await user.click(screen.getByRole('button', { name: 'say' }));
    expect(document.getElementById('live-region')).toBeNull();
  });
});

describe('shortcut registry (04-ui.md 6.5)', () => {
  function Key({ id, enabled = true, onKey }: { id: string; enabled?: boolean; onKey: (id: string) => void }) {
    useShortcut(
      'x',
      () => {
        onKey(id);
      },
      { enabled, description: `Handler ${id}` },
    );
    return null;
  }

  function Harness({ children }: { children: ReactNode }) {
    return (
      <ShortcutRegistryProvider>
        <input aria-label="text box" />
        <input type="checkbox" aria-label="check box" />
        {children}
      </ShortcutRegistryProvider>
    );
  }

  it('runs the handler of a pressed key', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    render(
      <Harness>
        <Key id="a" onKey={onKey} />
      </Harness>,
    );
    await user.keyboard('x');
    expect(onKey).toHaveBeenCalledWith('a');
  });

  it('gives the key to the most recently mounted enabled handler', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    function Toggle() {
      const [second, setSecond] = useState(false);
      return (
        <>
          <Key id="first" onKey={onKey} />
          {second ? <Key id="second" onKey={onKey} /> : null}
          <button
            type="button"
            onClick={() => {
              setSecond((v) => !v);
            }}
          >
            toggle
          </button>
        </>
      );
    }
    render(
      <Harness>
        <Toggle />
      </Harness>,
    );
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    await user.keyboard('x');
    expect(onKey).toHaveBeenLastCalledWith('second');
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    await user.keyboard('x');
    expect(onKey).toHaveBeenLastCalledWith('first');
  });

  it('skips a disabled handler', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    render(
      <Harness>
        <Key id="a" onKey={onKey} />
        <Key id="b" enabled={false} onKey={onKey} />
      </Harness>,
    );
    await user.keyboard('x');
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith('a');
  });

  it('ignores keys typed in text fields, with modifiers, or already handled', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    render(
      <Harness>
        <Key id="a" onKey={onKey} />
      </Harness>,
    );
    await user.type(screen.getByRole('textbox', { name: 'text box' }), 'x');
    expect(onKey).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: 'check box' }));
    await user.keyboard('x');
    expect(onKey).toHaveBeenCalledTimes(1);
    await user.keyboard('{Control>}x{/Control}');
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('does not fire while a dialog is open', async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    render(
      <Harness>
        <Key id="a" onKey={onKey} />
        <dialog open aria-label="open dialog" />
      </Harness>,
    );
    await user.keyboard('x');
    expect(onKey).not.toHaveBeenCalled();
  });
});

describe('toast store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a toast, announces it and removes it after its time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = createToastStore();
    function Toasts() {
      const { toasts } = useToasts();
      const show = useShowToast();
      return (
        <>
          <button
            type="button"
            onClick={() => {
              show('Link copied');
            }}
          >
            show
          </button>
          <ul>
            {toasts.map((t) => (
              <li key={t.id}>{t.message}</li>
            ))}
          </ul>
        </>
      );
    }
    render(
      <AnnouncerProvider>
        <ToastStoreContext value={store}>
          <Toasts />
        </ToastStoreContext>
      </AnnouncerProvider>,
    );
    act(() => {
      screen.getByRole('button', { name: 'show' }).click();
    });
    expect(screen.getByRole('listitem')).toHaveTextContent('Link copied');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(liveRegion()).toHaveTextContent('Link copied');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('dismisses by id and keeps the others', () => {
    const store = createToastStore();
    const first = store.show('one');
    store.show('two');
    store.dismiss(first);
    expect(store.getSnapshot().map((t) => t.message)).toEqual(['two']);
  });
});
