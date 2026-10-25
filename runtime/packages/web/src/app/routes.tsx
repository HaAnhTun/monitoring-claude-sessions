import type { InstanceInfo } from '@mcs/shared';
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import { Navigate, Outlet, Route, Routes, useParams } from 'react-router';

import type { IconName } from '../components/icons.ts';
import { useT } from '../i18n/context.ts';
import type { MessageKey } from '../i18n/types.ts';
import { NotFoundPage } from './NotFoundPage.tsx';
import { PageSkeleton } from './PageSkeleton.tsx';
import { RouteErrorBoundary } from './RouteErrorBoundary.tsx';
import { usePageChrome } from './usePageChrome.ts';

// Route table of ADR 0073 decision 2. Every page is a placeholder until its work package registers the real component
// in `pageRegistry` below (one marked block per work package, entries only). Registered components load through
// `lazyPage(() => import(...))`, so a block never needs an import line outside itself. The navigation of the shell is generated
// from this table and the registry (`navItems`): a page that is not registered is not listed.

export type PageKey =
  'overview' | 'sessions' | 'sessionDetail' | 'activity' | 'tasks' | 'analytics' | 'search' | 'settings';

/** Where an entry sits in the navigation: the main list, or the footer list below it (Settings). */
export type NavGroup = 'main' | 'footer';

/** The figure shown next to an entry. Tasks has none (ADR 0073 decision 3). */
export type NavCountKey = 'sessions' | 'settings';

export interface RouteNav {
  icon: IconName;
  group: NavGroup;
  countKey?: NavCountKey;
}

export type RouteTitleKey = Extract<MessageKey, `route.${string}.title`>;

export interface RouteSpec {
  key: PageKey;
  path: string;
  /** The page name: the heading, the document title and the label of its navigation entry. */
  titleKey: RouteTitleKey;
  /** Present when the page has a navigation entry. */
  nav?: RouteNav;
}

export const ROUTES = [
  { key: 'overview', path: '/', titleKey: 'route.overview.title', nav: { icon: 'overview', group: 'main' } },
  {
    key: 'sessions',
    path: '/sessions',
    titleKey: 'route.sessions.title',
    nav: { icon: 'sessions', group: 'main', countKey: 'sessions' },
  },
  { key: 'sessionDetail', path: '/sessions/:sessionId', titleKey: 'route.sessionDetail.title' },
  { key: 'activity', path: '/activity', titleKey: 'route.activity.title', nav: { icon: 'activity', group: 'main' } },
  { key: 'tasks', path: '/tasks', titleKey: 'route.tasks.title', nav: { icon: 'tasks', group: 'main' } },
  {
    key: 'analytics',
    path: '/analytics',
    titleKey: 'route.analytics.title',
    nav: { icon: 'analytics', group: 'main' },
  },
  { key: 'search', path: '/search', titleKey: 'route.search.title', nav: { icon: 'search', group: 'main' } },
  {
    key: 'settings',
    path: '/settings',
    titleKey: 'route.settings.title',
    nav: { icon: 'settings', group: 'footer', countKey: 'settings' },
  },
] as const satisfies readonly RouteSpec[];

/** The table typed as a plain list, for the code that reads `nav` of every entry. */
const ROUTE_LIST: readonly RouteSpec[] = ROUTES;

/** `shell` is the layout route (renders an Outlet); `legacyHashRedirect` runs before the routes (04-ui.md 3.3). */
export type RegistryKey = PageKey | 'shell' | 'legacyHashRedirect';
export type PageRegistry = Partial<Record<RegistryKey, LazyExoticComponent<ComponentType>>>;

/** Registry entry helper: `sessions: lazyPage(() => import('../pages/X.tsx').then((m) => ({ default: m.X })))`. */
export function lazyPage(load: () => Promise<{ default: ComponentType }>): LazyExoticComponent<ComponentType> {
  return lazy(load);
}

export const pageRegistry: PageRegistry = {
  shell: lazyPage(() => import('../shell/AppShell.tsx').then((m) => ({ default: m.AppShell }))),
  legacyHashRedirect: lazyPage(() =>
    import('../app/LegacyHashRedirect.tsx').then((m) => ({ default: m.LegacyHashRedirect })),
  ),
  sessions: lazyPage(() =>
    import('../pages/sessions/SessionExplorerPage.tsx').then((m) => ({ default: m.SessionExplorerPage })),
  ),
  sessionDetail: lazyPage(() =>
    import('../pages/session-detail/SessionDetailPage.tsx').then((m) => ({ default: m.SessionDetailPage })),
  ),
  // @wp-begin WP-53
  activity: lazyPage(() => import('../pages/activity/ActivityPage.tsx').then((m) => ({ default: m.ActivityPage }))),
  // @wp-end WP-53
  // @wp-begin WP-54
  overview: lazyPage(() => import('../pages/overview/OverviewPage.tsx').then((m) => ({ default: m.OverviewPage }))),
  // @wp-end WP-54
  // @wp-begin WP-66
  tasks: lazyPage(() =>
    import('../pages/work-items/WorkItemBoardPage.tsx').then((m) => ({ default: m.WorkItemBoardPage })),
  ),
  analytics: lazyPage(() => import('../pages/analytics/AnalyticsPage.tsx').then((m) => ({ default: m.AnalyticsPage }))),
  // @wp-end WP-66
  // @wp-begin WP-67
  settings: lazyPage(() => import('../pages/settings/SettingsPage.tsx').then((m) => ({ default: m.SettingsPage }))),
  // @wp-end WP-67
  // @wp-begin WP-121
  search: lazyPage(() => import('../pages/search/SearchPage.tsx').then((m) => ({ default: m.SearchPage }))),
  // @wp-end WP-121
};

/** The registry of the router in this subtree: the navigation of the shell reads the pages that exist from it. */
export const PageRegistryContext = createContext<PageRegistry>(pageRegistry);

export function usePageRegistry(): PageRegistry {
  return useContext(PageRegistryContext);
}

export interface NavItem {
  key: PageKey;
  to: string;
  titleKey: RouteTitleKey;
  icon: IconName;
  group: NavGroup;
  countKey?: NavCountKey;
}

/**
 * The navigation entries: the routes that have `nav` metadata and a registered page, the main group first and the footer group
 * after it, each in the order of the route table. The Search entry also needs an instance that searches all sessions
 * (`features.transcriptSearch === 'instance'`); a page that is not registered, or an unknown instance, hides it.
 */
export function navItems(registry: PageRegistry, features: InstanceInfo['features'] | null): NavItem[] {
  const items: NavItem[] = [];
  for (const spec of ROUTE_LIST) {
    const { nav } = spec;
    if (nav === undefined || registry[spec.key] === undefined) continue;
    if (spec.key === 'search' && features?.transcriptSearch !== 'instance') continue;
    items.push({
      key: spec.key,
      to: spec.path,
      titleKey: spec.titleKey,
      icon: nav.icon,
      group: nav.group,
      ...(nav.countKey === undefined ? {} : { countKey: nav.countKey }),
    });
  }
  return [...items.filter((item) => item.group === 'main'), ...items.filter((item) => item.group === 'footer')];
}

function PlaceholderPage({ spec }: { spec: RouteSpec }) {
  const t = useT();
  const title = t(spec.titleKey);
  const headingRef = usePageChrome(title);
  const { sessionId } = useParams();
  return (
    <section className="page page--placeholder">
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      {sessionId === undefined ? null : (
        <p className="mono" data-testid="route-param">
          {sessionId}
        </p>
      )}
      <p className="muted">{t('route.placeholder')}</p>
    </section>
  );
}

/** Layout used until a work package registers the real shell: just the main landmark. */
function PlaceholderShell() {
  return (
    <main id="main" className="main" tabIndex={-1}>
      <Outlet />
    </main>
  );
}

function ShellRoute({ registry }: { registry: PageRegistry }) {
  const Shell = registry.shell;
  if (Shell === undefined) return <PlaceholderShell />;
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Shell />
    </Suspense>
  );
}

function PageRoute({ spec, registry }: { spec: RouteSpec; registry: PageRegistry }): ReactNode {
  const Page = registry[spec.key];
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<PageSkeleton />}>{Page === undefined ? <PlaceholderPage spec={spec} /> : <Page />}</Suspense>
    </RouteErrorBoundary>
  );
}

export function AppRoutes({ registry = pageRegistry }: { registry?: PageRegistry }) {
  const LegacyHashRedirect = registry.legacyHashRedirect;
  return (
    <PageRegistryContext value={registry}>
      {LegacyHashRedirect === undefined ? null : (
        <Suspense fallback={null}>
          <LegacyHashRedirect />
        </Suspense>
      )}
      <Routes>
        <Route element={<ShellRoute registry={registry} />}>
          {ROUTE_LIST.map((spec) => (
            <Route key={spec.key} path={spec.path} element={<PageRoute spec={spec} registry={registry} />} />
          ))}
          <Route path="/health" element={<Navigate to="/settings?section=health" replace />} />
          <Route
            path="*"
            element={
              <RouteErrorBoundary>
                <NotFoundPage />
              </RouteErrorBoundary>
            }
          />
        </Route>
      </Routes>
    </PageRegistryContext>
  );
}
