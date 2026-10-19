import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { Link, MemoryRouter, Outlet, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { msg } from '../test/msg.ts';
import { AppRoutes, ROUTES, type PageRegistry } from './routes.tsx';

function lazyOf(component: ComponentType): LazyExoticComponent<ComponentType> {
  return lazy(() => Promise.resolve({ default: component }));
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderAt(path: string, registry?: PageRegistry) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <nav>
        <Link to="/sessions">go sessions</Link>
        <Link to="/settings">go settings</Link>
      </nav>
      <LocationProbe />
      {registry === undefined ? <AppRoutes /> : <AppRoutes registry={registry} />}
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  document.title = '';
});

describe('route table (04-ui.md section 3.1)', () => {
  it('lists the seven views and their paths', () => {
    expect(ROUTES.map((r) => [r.key, r.path, r.title])).toEqual([
      ['overview', '/', 'Overview'],
      ['sessions', '/sessions', 'Sessions'],
      ['sessionDetail', '/sessions/:sessionId', 'Session'],
      ['activity', '/activity', 'Activity'],
      ['tasks', '/tasks', 'Tasks'],
      ['analytics', '/analytics', 'Analytics'],
      ['settings', '/settings', 'Settings'],
    ]);
  });

  it.each([
    ['/', 'Overview'],
    ['/sessions', 'Sessions'],
    ['/sessions/abc-123', 'Session'],
    ['/activity', 'Activity'],
    ['/tasks', 'Tasks'],
    ['/analytics', 'Analytics'],
    ['/settings', 'Settings'],
  ])('renders the placeholder of %s with one h1 and one main landmark', async (path, title) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(document.title).toBe(`${title} - Claude session monitor`);
  });

  it('shows the session id of a detail route as text', async () => {
    renderAt('/sessions/abc-123');
    expect(await screen.findByText('abc-123')).toBeInTheDocument();
  });

  it('redirects /health to the settings health section', async () => {
    renderAt('/health');
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?section=health');
  });

  it('renders the not-found page for an unknown path with the requested path as text', async () => {
    renderAt('/no/such/page');
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByText('/no/such/page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('notFound.openOverview') })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('notFound.openSessions') })).toHaveAttribute('href', '/sessions');
    expect(document.title).toBe(`${msg('notFound.documentTitle')} - Claude session monitor`);
  });

  it('does not move focus on the first load', async () => {
    renderAt('/sessions');
    await screen.findByRole('heading', { level: 1, name: 'Sessions' });
    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus to the new page heading after a navigation', async () => {
    const user = userEvent.setup();
    renderAt('/sessions');
    await screen.findByRole('heading', { level: 1, name: 'Sessions' });
    await user.click(screen.getByRole('link', { name: 'go settings' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });
});

describe('registry (the seam of the later work packages)', () => {
  it('renders a registered page instead of the placeholder', async () => {
    const registry: PageRegistry = { sessions: lazyOf(() => <h1>Real sessions page</h1>) };
    renderAt('/sessions', registry);
    expect(await screen.findByRole('heading', { level: 1, name: 'Real sessions page' })).toBeInTheDocument();
    expect(screen.queryByText('This view is not built yet.')).toBeNull();
  });

  it('renders a registered shell around the pages through an outlet', async () => {
    const Shell = () => (
      <div data-testid="shell">
        <Outlet />
      </div>
    );
    renderAt('/activity', { shell: lazyOf(Shell) });
    const shell = await screen.findByTestId('shell');
    expect(shell).toContainElement(await screen.findByRole('heading', { level: 1, name: 'Activity' }));
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
    expect(await screen.findByText('This view failed to render.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy error details' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'go settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByText('This view failed to render.')).toBeNull();
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
    expect(await screen.findByText('This view failed to render.')).toBeInTheDocument();
    expect(screen.getByTestId('shell')).toBeInTheDocument();
  });
});
