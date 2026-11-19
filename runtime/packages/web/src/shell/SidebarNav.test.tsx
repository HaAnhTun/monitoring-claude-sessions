import { screen, within } from '@testing-library/react';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { describe, expect, it } from 'vitest';

import { navItems, PageRegistryContext, type PageRegistry } from '../app/routes.tsx';
import { createFakeApi } from '../test/fake-api.ts';
import { makeInstance } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { renderWithIntl } from '../test/render.tsx';
import { ConnectedSidebarNav, SidebarNav, type NavCounts } from './SidebarNav.tsx';

function lazyOf(component: ComponentType): LazyExoticComponent<ComponentType> {
  return lazy(() => Promise.resolve({ default: component }));
}

const page = lazyOf(() => null);
const ALL: PageRegistry = {
  workspace: page,
  overview: page,
  sessions: page,
  sessionDetail: page,
  activity: page,
  tasks: page,
  analytics: page,
  search: page,
  settings: page,
};

function renderNav(
  options: { counts?: NavCounts | null; route?: string; registry?: PageRegistry; tooltips?: boolean } = {},
) {
  const items = navItems(options.registry ?? ALL, makeInstance().features, 'user');
  return renderWithIntl(
    <SidebarNav items={items} counts={options.counts ?? null} tooltips={options.tooltips ?? false} />,
    {
      route: options.route ?? '/',
    },
  );
}

const nav = (): HTMLElement => screen.getByRole('navigation', { name: msg('nav.label') });
const hrefs = (): (string | null)[] =>
  within(nav())
    .getAllByRole('link')
    .map((a) => a.getAttribute('href'));

describe('SidebarNav (ADR 0073 decision 3)', () => {
  it('lists the registered pages in order and no entry for a page that is missing', () => {
    renderNav();
    expect(hrefs()).toEqual(['/', '/overview', '/sessions', '/activity', '/tasks', '/analytics', '/settings']);
  });

  it('drops an unregistered page', () => {
    renderNav({ registry: Object.fromEntries(Object.entries(ALL).filter(([key]) => key !== 'activity')) });
    expect(hrefs()).toEqual(['/', '/overview', '/sessions', '/tasks', '/analytics', '/settings']);
  });

  it('labels the entries from the catalogue in the language that is shown', () => {
    renderNav();
    expect(within(nav()).getByRole('link', { name: msg('route.overview.title') })).toBeInTheDocument();
  });

  it('words the entries in Vietnamese', () => {
    const items = navItems(ALL, makeInstance().features, 'user');
    renderWithIntl(<SidebarNav items={items} counts={null} />, { locale: 'vi' });
    expect(screen.getByRole('navigation', { name: msg('nav.label', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: msg('route.sessions.title', undefined, 'vi') })).toHaveAttribute(
      'href',
      '/sessions',
    );
  });

  it('marks the current page with aria-current and no other', () => {
    renderNav({ route: '/activity' });
    const links = within(nav()).getAllByRole('link');
    expect(links.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('href'))).toEqual([
      '/activity',
    ]);
  });

  it('keeps the Workspace current on "/" only (with or without a selected session) and Overview on "/overview"', () => {
    renderNav({ route: '/?session=fixture-term-1' });
    const current = (): (string | null)[] =>
      within(nav())
        .getAllByRole('link')
        .filter((a) => a.getAttribute('aria-current') === 'page')
        .map((a) => a.getAttribute('href'));
    expect(current()).toEqual(['/']);
  });

  it('marks only Overview current on "/overview"', () => {
    renderNav({ route: '/overview' });
    expect(within(nav()).getByRole('link', { name: msg('route.overview.title') })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav()).getByRole('link', { name: msg('route.workspace.title') })).not.toHaveAttribute('aria-current');
  });

  it('keeps Sessions current on a session page and Overview and the Workspace current on neither', () => {
    renderNav({ route: '/sessions/abc' });
    expect(within(nav()).getByRole('link', { name: new RegExp(`^${msg('route.sessions.title')}`) })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav()).getByRole('link', { name: msg('route.overview.title') })).not.toHaveAttribute('aria-current');
    expect(within(nav()).getByRole('link', { name: msg('route.workspace.title') })).not.toHaveAttribute('aria-current');
  });

  it('shows the active sessions with their unit and open alerts with theirs', () => {
    renderNav({ counts: { sessions: 3, settings: 2 } });
    expect(
      within(nav()).getByRole('link', {
        name: `${msg('route.sessions.title')} ${msg('nav.count.sessions', { count: 3 })}`,
      }),
    ).toBeInTheDocument();
    expect(
      within(nav()).getByRole('link', {
        name: `${msg('route.settings.title')} ${msg('nav.count.alerts', { count: 2 })}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('3 active')).toBeInTheDocument();
    expect(screen.getByText('2 alerts')).toBeInTheDocument();
  });

  it('uses the singular for one alert', () => {
    renderNav({ counts: { settings: 1 } });
    expect(screen.getByText('1 alert')).toBeInTheDocument();
  });

  it('never shows a bare number', () => {
    renderNav({ counts: { sessions: 12, settings: 4 } });
    for (const count of nav().querySelectorAll('.sidebar-nav__count')) {
      expect(count.textContent).toMatch(/[A-Za-z]/);
      expect(count.textContent).not.toMatch(/^\s*\d+\s*$/);
    }
  });

  it('shows 0 active but hides the alerts while there are none', () => {
    renderNav({ counts: { sessions: 0, settings: 0 } });
    expect(screen.getByText('0 active')).toBeInTheDocument();
    expect(screen.queryByText(/alert/)).toBeNull();
  });

  it('shows no count before the overview is known', () => {
    renderNav({ counts: null });
    expect(nav().querySelectorAll('.sidebar-nav__count')).toHaveLength(0);
    renderNav({ counts: {} });
    expect(document.querySelectorAll('.sidebar-nav__count')).toHaveLength(0);
  });

  it('has no count on Tasks, whatever the counts hold', () => {
    renderNav({ counts: { sessions: 5, settings: 5 } });
    const tasks = within(nav()).getByRole('link', { name: msg('route.tasks.title') });
    expect(tasks.querySelector('.sidebar-nav__count')).toBeNull();
  });

  it('puts Settings in the footer list below the others', () => {
    renderNav();
    const lists = nav().querySelectorAll('ul');
    expect(lists).toHaveLength(2);
    expect(within(lists[1] as HTMLElement).getAllByRole('link')).toHaveLength(1);
    expect(
      within(lists[1] as HTMLElement).getByRole('link', { name: msg('route.settings.title') }),
    ).toBeInTheDocument();
  });

  it('gives each link a tooltip with its label and count in the rail, and none otherwise', () => {
    const sessions = msg('route.sessions.title');
    const activity = msg('route.activity.title');
    const view = renderNav({ counts: { sessions: 3 }, tooltips: true });
    expect(within(nav()).getByRole('link', { name: new RegExp('^' + sessions) })).toHaveAttribute(
      'title',
      sessions + ': ' + msg('nav.count.sessions', { count: 3 }),
    );
    expect(within(nav()).getByRole('link', { name: activity })).toHaveAttribute('title', activity);
    view.unmount();
    renderNav({ counts: { sessions: 3 } });
    expect(within(nav()).getByRole('link', { name: new RegExp('^' + sessions) })).not.toHaveAttribute('title');
  });
});

describe('ConnectedSidebarNav passes the kind of the instance (design 04 2.1)', () => {
  function renderConnected(kind: 'user' | 'task') {
    const api = createFakeApi({ instance: () => makeInstance({ kind }) });
    return renderWithIntl(
      <PageRegistryContext value={ALL}>
        <ConnectedSidebarNav tooltips={false} />
      </PageRegistryContext>,
      { api, instance: makeInstance({ kind }) },
    );
  }

  it('lists the Workspace first for a user instance', () => {
    renderConnected('user');
    expect(hrefs()[0]).toBe('/');
    expect(within(nav()).getByRole('link', { name: msg('route.workspace.title') })).toBeInTheDocument();
  });

  it('hides the Workspace for a task instance, whose landing page stays the Overview', () => {
    renderConnected('task');
    expect(hrefs()).toEqual(['/overview', '/sessions', '/activity', '/tasks', '/analytics', '/settings']);
    expect(within(nav()).queryByRole('link', { name: msg('route.workspace.title') })).toBeNull();
  });
});
