import type { InstanceInfo } from '@mcs/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { Link, MemoryRouter, Outlet, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enMessages } from '../i18n/messages/en.ts';
import { viMessages } from '../i18n/messages/vi.ts';
import { msg } from '../test/msg.ts';
import { AppRoutes, ROUTES, navItems, type PageRegistry } from './routes.tsx';

// CR-WP-49-2: the route-table tests never touch the default registry. Loading the real shell here would pull the whole frame (and
// its data hooks) into a test about paths and titles, so loading it fails the test.
vi.mock('../shell/AppShell.tsx', () => {
  throw new Error('the route-table tests must not load the real shell');
});

function lazyOf(component: ComponentType): LazyExoticComponent<ComponentType> {
  return lazy(() => Promise.resolve({ default: component }));
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderAt(path: string, registry: PageRegistry = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <nav>
        <Link to="/sessions">go sessions</Link>
        <Link to="/settings">go settings</Link>
      </nav>
      <LocationProbe />
      <AppRoutes registry={registry} />
    </MemoryRouter>,
  );
}

const FEATURES: InstanceInfo['features'] = {
  transcriptSearch: 'session',
  costEstimates: false,
  usageTrend: true,
  hooks: false,
};

const ALL_PAGES: PageRegistry = {
  overview: lazyOf(() => null),
  sessions: lazyOf(() => null),
  sessionDetail: lazyOf(() => null),
  activity: lazyOf(() => null),
  tasks: lazyOf(() => null),
  analytics: lazyOf(() => null),
  search: lazyOf(() => null),
  settings: lazyOf(() => null),
};

const without = (registry: PageRegistry, key: string): PageRegistry =>
  Object.fromEntries(Object.entries(registry).filter(([name]) => name !== key));

const navKeys = (registry: PageRegistry, features: InstanceInfo['features'] | null = FEATURES): string[] =>
  navItems(registry, features).map((item) => item.key);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  document.title = '';
});

describe('route table (ADR 0073 decision 2)', () => {
  it('lists the pages, their paths and their title keys', () => {
    expect(ROUTES.map((r) => [r.key, r.path, r.titleKey])).toEqual([
      ['overview', '/', 'route.overview.title'],
      ['sessions', '/sessions', 'route.sessions.title'],
      ['sessionDetail', '/sessions/:sessionId', 'route.sessionDetail.title'],
      ['activity', '/activity', 'route.activity.title'],
      ['tasks', '/tasks', 'route.tasks.title'],
      ['analytics', '/analytics', 'route.analytics.title'],
      ['search', '/search', 'route.search.title'],
      ['settings', '/settings', 'route.settings.title'],
    ]);
  });

  it('gives every route a title key that both catalogues have', () => {
    for (const spec of ROUTES) {
      expect(Object.hasOwn(enMessages, spec.titleKey), spec.key).toBe(true);
      expect(Object.hasOwn(viMessages, spec.titleKey), spec.key).toBe(true);
    }
  });

  it('makes "/" the Overview', () => {
    expect(ROUTES[0]).toMatchObject({ key: 'overview', path: '/', titleKey: 'route.overview.title' });
    expect(msg('route.overview.title')).toBe('Overview');
  });

  it.each([
    ['/', 'route.overview.title'],
    ['/sessions', 'route.sessions.title'],
    ['/sessions/abc-123', 'route.sessionDetail.title'],
    ['/activity', 'route.activity.title'],
    ['/tasks', 'route.tasks.title'],
    ['/analytics', 'route.analytics.title'],
    ['/search', 'route.search.title'],
    ['/settings', 'route.settings.title'],
  ] as const)('renders the placeholder of %s with one h1 and one main landmark', async (path, titleKey) => {
    renderAt(path);
    const title = msg(titleKey);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(document.title).toBe(`${title} - ${msg('shell.appTitle')}`);
    expect(screen.getByText(msg('route.placeholder'))).toBeInTheDocument();
  });

  it('shows the session id of a detail route as text', async () => {
    renderAt('/sessions/abc-123');
    expect(await screen.findByText('abc-123')).toBeInTheDocument();
  });

  it('decodes a percent-encoded session id once', async () => {
    renderAt(`/sessions/${encodeURIComponent('50%-done')}`);
    expect(await screen.findByTestId('route-param')).toHaveTextContent('50%-done');
  });

  it('redirects /health to the settings health section', async () => {
    renderAt('/health');
    expect(await screen.findByRole('heading', { level: 1, name: msg('route.settings.title') })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?section=health');
  });

  it('renders the not-found page for an unknown path with the requested path as text', async () => {
    renderAt('/no/such/page');
    expect(await screen.findByRole('heading', { level: 1, name: msg('notFound.title') })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByText('/no/such/page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('notFound.openOverview') })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('notFound.openSessions') })).toHaveAttribute('href', '/sessions');
    expect(document.title).toBe(`${msg('notFound.documentTitle')} - ${msg('shell.appTitle')}`);
  });

  it('does not move focus on the first load', async () => {
    renderAt('/sessions');
    await screen.findByRole('heading', { level: 1, name: msg('route.sessions.title') });
    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus to the new page heading after a navigation', async () => {
    const user = userEvent.setup();
    renderAt('/sessions');
    await screen.findByRole('heading', { level: 1, name: msg('route.sessions.title') });
    await user.click(screen.getByRole('link', { name: 'go settings' }));
    const heading = await screen.findByRole('heading', { level: 1, name: msg('route.settings.title') });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });
});

describe('navigation generated from the registry (ADR 0073 decision 3, R-01)', () => {
  it('lists exactly the registered pages, in the order of the decision, with Settings last', () => {
    expect(navKeys(ALL_PAGES, { ...FEATURES, transcriptSearch: 'instance' })).toEqual([
      'overview',
      'sessions',
      'activity',
      'tasks',
      'analytics',
      'search',
      'settings',
    ]);
    expect(navKeys(ALL_PAGES)).toEqual(['overview', 'sessions', 'activity', 'tasks', 'analytics', 'settings']);
  });

  it('never lists the session detail route', () => {
    expect(navKeys(ALL_PAGES)).not.toContain('sessionDetail');
  });

  it('drops a page that is not registered', () => {
    expect(navKeys(without(ALL_PAGES, 'tasks'))).toEqual(['overview', 'sessions', 'activity', 'analytics', 'settings']);
    expect(navKeys({})).toEqual([]);
  });

  it('shows the search entry only when it is registered and the instance searches all sessions', () => {
    const instance = { ...FEATURES, transcriptSearch: 'instance' } as const;
    expect(navKeys(ALL_PAGES, instance)).toContain('search');
    expect(navKeys(ALL_PAGES, FEATURES)).not.toContain('search');
    expect(navKeys(ALL_PAGES, null)).not.toContain('search');
    expect(navKeys(without(ALL_PAGES, 'search'), instance)).not.toContain('search');
  });

  it('carries the icon, the group and the count of each entry; Tasks has no count', () => {
    const items = navItems(ALL_PAGES, FEATURES);
    const byKey = Object.fromEntries(items.map((item) => [item.key, item]));
    expect(byKey['sessions']).toMatchObject({ to: '/sessions', icon: 'sessions', group: 'main', countKey: 'sessions' });
    expect(byKey['settings']).toMatchObject({
      to: '/settings',
      icon: 'settings',
      group: 'footer',
      countKey: 'settings',
    });
    expect(byKey['tasks']?.countKey).toBeUndefined();
    expect(byKey['overview']).toMatchObject({ to: '/', titleKey: 'route.overview.title' });
  });
});

describe('registry (the seam of the later work packages)', () => {
  it('renders a registered page instead of the placeholder', async () => {
    const registry: PageRegistry = { sessions: lazyOf(() => <h1>Real sessions page</h1>) };
    renderAt('/sessions', registry);
    expect(await screen.findByRole('heading', { level: 1, name: 'Real sessions page' })).toBeInTheDocument();
    expect(screen.queryByText(msg('route.placeholder'))).toBeNull();
  });

  it('renders a registered shell around the pages through an outlet', async () => {
    const Shell = () => (
      <div data-testid="shell">
        <Outlet />
      </div>
    );
    renderAt('/activity', { shell: lazyOf(Shell) });
    const shell = await screen.findByTestId('shell');
    expect(shell).toContainElement(await screen.findByRole('heading', { level: 1, name: msg('route.activity.title') }));
  });

  it('falls back to the bare main landmark when no shell is registered (CR-WP-49-2)', async () => {
    renderAt('/sessions');
    await screen.findByRole('heading', { level: 1, name: msg('route.sessions.title') });
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('mounts a registered legacy hash redirect before the routes', async () => {
    const Probe = () => <output data-testid="redirect-probe">mounted</output>;
    renderAt('/', { legacyHashRedirect: lazyOf(Probe) });
    expect(await screen.findByTestId('redirect-probe')).toBeInTheDocument();
  });
});

describe('route error boundary (04-ui.md section 3.4)', () => {
  it('shows the crash state for a page that throws and recovers on navigation', async () => {
    const user = userEvent.setup();
    const Boom = (): never => {
      throw new Error('kaboom');
    };
    renderAt('/sessions', { sessions: lazyOf(Boom) });
    expect(await screen.findByText(msg('common.viewFailed'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('common.reloadView') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('common.copyErrorDetails') })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'go settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: msg('route.settings.title') })).toBeInTheDocument();
    expect(screen.queryByText(msg('common.viewFailed'))).toBeNull();
  });

  it('keeps the shell alive when a page crashes', async () => {
    const Boom = (): never => {
      throw new Error('kaboom');
    };
    const Shell = () => (
      <div data-testid="shell">
        <Outlet />
      </div>
    );
    renderAt('/tasks', { shell: lazyOf(Shell), tasks: lazyOf(Boom) });
    expect(await screen.findByText(msg('common.viewFailed'))).toBeInTheDocument();
    expect(screen.getByTestId('shell')).toBeInTheDocument();
  });
});
