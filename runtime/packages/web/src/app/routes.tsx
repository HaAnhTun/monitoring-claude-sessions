import { lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useParams } from 'react-router';

import { NotFoundPage } from './NotFoundPage.tsx';
import { PageSkeleton } from './PageSkeleton.tsx';
import { RouteErrorBoundary } from './RouteErrorBoundary.tsx';
import { usePageChrome } from './usePageChrome.ts';

// Route table of 04-ui.md section 3.1. Every page is a placeholder until its work package registers the real component
// in `pageRegistry` below (one marked block per work package, entries only). Registered components load through
// `lazyPage(() => import(...))`, so a block never needs an import line outside itself.

export interface RouteSpec {
  key: PageKey;
  path: string;
  title: string;
}

export type PageKey = 'overview' | 'sessions' | 'sessionDetail' | 'activity' | 'tasks' | 'analytics' | 'settings';

export const ROUTES = [
  { key: 'overview', path: '/', title: 'Overview' },
  { key: 'sessions', path: '/sessions', title: 'Sessions' },
  { key: 'sessionDetail', path: '/sessions/:sessionId', title: 'Session' },
  { key: 'activity', path: '/activity', title: 'Activity' },
  { key: 'tasks', path: '/tasks', title: 'Tasks' },
  { key: 'analytics', path: '/analytics', title: 'Analytics' },
  { key: 'settings', path: '/settings', title: 'Settings' },
] as const satisfies readonly RouteSpec[];

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
  // @wp-end WP-53
  // @wp-begin WP-54
  // @wp-end WP-54
  // @wp-begin WP-66
  // @wp-end WP-66
  // @wp-begin WP-67
  // @wp-end WP-67
};

function PlaceholderPage({ title }: { title: string }) {
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
      <p className="muted">This view is not built yet.</p>
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
      <Suspense fallback={<PageSkeleton />}>
        {Page === undefined ? <PlaceholderPage title={spec.title} /> : <Page />}
      </Suspense>
    </RouteErrorBoundary>
  );
}

export function AppRoutes({ registry = pageRegistry }: { registry?: PageRegistry }) {
  const LegacyHashRedirect = registry.legacyHashRedirect;
  return (
    <>
      {LegacyHashRedirect === undefined ? null : (
        <Suspense fallback={null}>
          <LegacyHashRedirect />
        </Suspense>
      )}
      <Routes>
        <Route element={<ShellRoute registry={registry} />}>
          {ROUTES.map((spec) => (
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
    </>
  );
}
