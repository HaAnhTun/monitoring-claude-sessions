import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { Link } from 'react-router';
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

describe('SidebarNav keyboard (design 05 section 6: one Tab stop for the whole navigation)', () => {
  const stops = (): (string | null)[] =>
    within(nav())
      .getAllByRole('link')
      .filter((a) => a.getAttribute('tabindex') !== '-1')
      .map((a) => a.getAttribute('href'));
  const link = (name: string | RegExp): HTMLElement => within(nav()).getByRole('link', { name });
  const workspace = msg('route.workspace.title');
  const overview = msg('route.overview.title');
  const sessions = new RegExp(`^${msg('route.sessions.title')}`);
  const settings = msg('route.settings.title');

  /** A link in the page, outside the navigation, that goes to another page. */
  function renderNavWithPageLink(route: string, to: string) {
    const items = navItems(ALL, makeInstance().features, 'user');
    return renderWithIntl(
      <>
        <SidebarNav items={items} counts={null} />
        <Link to={to}>elsewhere</Link>
      </>,
      { route },
    );
  }

  it('makes the current page the one Tab stop', () => {
    renderNav({ route: '/activity' });
    expect(stops()).toEqual(['/activity']);
  });

  it('keeps every entry a link, the ones without the Tab stop too', () => {
    renderNav({ route: '/activity' });
    expect(hrefs()).toEqual(['/', '/overview', '/sessions', '/activity', '/tasks', '/analytics', '/settings']);
    expect(
      within(nav())
        .getAllByRole('link')
        .filter((a) => a.getAttribute('tabindex') === '-1'),
    ).toHaveLength(6);
  });

  it('keeps Sessions as the stop on a session page', () => {
    renderNav({ route: '/sessions/abc' });
    expect(stops()).toEqual(['/sessions']);
  });

  it('makes the Workspace the stop on "/" only', () => {
    renderNav({ route: '/?session=fixture-term-1' });
    expect(stops()).toEqual(['/']);
  });

  it('makes the first entry the stop when no page is current', () => {
    renderNav({ route: '/no/such/page' });
    expect(stops()).toEqual(['/']);
  });

  it('reaches the navigation with one Tab and leaves it with the next', async () => {
    const user = userEvent.setup();
    renderNavWithPageLink('/tasks', '/analytics');
    await user.tab();
    expect(link(msg('route.tasks.title'))).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'elsewhere' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(link(msg('route.tasks.title'))).toHaveFocus();
  });

  it('moves between the entries with the arrow keys and wraps at both ends', async () => {
    const user = userEvent.setup();
    renderNav({ route: '/' });
    link(workspace).focus();
    await user.keyboard('{ArrowDown}');
    expect(link(overview)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(link(sessions)).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(link(settings)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(link(workspace)).toHaveFocus();
  });

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup();
    renderNav({ route: '/tasks' });
    link(msg('route.tasks.title')).focus();
    await user.keyboard('{End}');
    expect(link(settings)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(link(workspace)).toHaveFocus();
  });

  it('leaves an arrow key with a modifier to the browser', async () => {
    const user = userEvent.setup();
    renderNav({ route: '/tasks' });
    const tasks = link(msg('route.tasks.title'));
    tasks.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}{Control>}{End}{/Control}{Shift>}{Home}{/Shift}');
    expect(tasks).toHaveFocus();
  });

  it('keeps the Tab stop on the entry the focus left', async () => {
    const user = userEvent.setup();
    renderNavWithPageLink('/', '/analytics');
    link(workspace).focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(stops()).toEqual(['/sessions']);
    await user.tab();
    expect(screen.getByRole('link', { name: 'elsewhere' })).toHaveFocus();
    expect(stops()).toEqual(['/sessions']);
    await user.tab({ shift: true });
    expect(link(sessions)).toHaveFocus();
  });

  it('gives the Tab stop to the current page again after a navigation from elsewhere', async () => {
    const user = userEvent.setup();
    renderNavWithPageLink('/', '/analytics');
    link(workspace).focus();
    await user.keyboard('{ArrowDown}');
    expect(stops()).toEqual(['/overview']);
    await user.click(screen.getByRole('link', { name: 'elsewhere' }));
    expect(stops()).toEqual(['/analytics']);
  });

  it('does not bring a remembered entry back when the earlier page is shown again', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <>
        <SidebarNav items={navItems(ALL, makeInstance().features, 'user')} counts={null} />
        <Link to="/analytics">away</Link>
        <Link to="/overview">back</Link>
      </>,
      { route: '/overview' },
    );
    link(overview).focus();
    await user.keyboard('{ArrowDown}');
    expect(stops()).toEqual(['/sessions']);
    await user.click(screen.getByRole('link', { name: 'away' }));
    expect(stops()).toEqual(['/analytics']);
    await user.click(screen.getByRole('link', { name: 'back' }));
    expect(stops()).toEqual(['/overview']);
  });

  it('follows a link with Enter', async () => {
    const user = userEvent.setup();
    renderNav({ route: '/' });
    link(workspace).focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(link(sessions)).toHaveAttribute('aria-current', 'page');
    expect(stops()).toEqual(['/sessions']);
  });

  it('keeps one Tab stop in the rail, where the labels are tooltips', () => {
    renderNav({ route: '/overview', tooltips: true });
    expect(stops()).toEqual(['/overview']);
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
