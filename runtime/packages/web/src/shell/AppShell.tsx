import type { InstanceInfo } from '@mcs/shared';
import { useContext, useEffect, type ReactNode } from 'react';
import { Outlet } from 'react-router';

import { PageSkeleton } from '../app/PageSkeleton.tsx';
import { useRouteLayout } from '../app/routes.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { Icon } from '../components/Icon.tsx';
import { AccessFlowContext, useCreateAccessFlow } from '../data/hooks/useAuth.ts';
import { ApiContext, InstanceIdContext, useInstance } from '../data/hooks/useInstance.ts';
import { useT } from '../i18n/context.ts';
import { AnnouncerProvider } from '../state/announcer.tsx';
import { applyDisplayPrefs, resolveDisplay, usePrefs } from '../state/prefs-store.ts';
import { ShortcutRegistryProvider, useShortcut, useShortcutRegistry } from '../state/shortcuts-registry.tsx';
import { useToasts } from '../state/toast-store.ts';
import { AccessGate } from './AccessGate.tsx';
import { AttentionHost } from './AttentionHost.tsx';
import { InstanceChangedNotice } from './InstanceChangedNotice.tsx';
import { OutdatedNotice } from './OutdatedNotice.tsx';
import { ShortcutsDialog } from './ShortcutsDialog.tsx';
import { Sidebar } from './Sidebar.tsx';
import { MAIN_ID, SkipLinks } from './SkipLinks.tsx';
import { TopBar } from './TopBar.tsx';

function ToastRegion() {
  const t = useT();
  const { toasts, dismiss } = useToasts();
  if (toasts.length === 0) return null;
  // Toasts are announced through the live region; the visible copy is not a second live region.
  return (
    <section className="toasts" aria-label={t('toast.region')}>
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`}>
          <span>{toast.message}</span>
          <button
            type="button"
            className="btn btn-icon"
            aria-label={t('toast.dismiss')}
            onClick={() => {
              dismiss(toast.id);
            }}
          >
            <Icon name="x" />
          </button>
        </div>
      ))}
    </section>
  );
}

/**
 * The frame once the instance is known: top bar, sidebar, the routed page, dialogs and notices. A bleed route (the Workspace) is
 * marked on `<html data-layout>` and on `main` (no padding, the page does not scroll); only a page route is the scope of the stale
 * outline. A user instance also redeems its login link (`AccessGate`), shares the access flow with its pages and shows the
 * outdated notice under the instance-changed one. The attention host (ADR 0107) wraps the frame: the pages read its rows, and the
 * tab title and the tab icon follow it.
 */
function Frame({ instance }: { instance: InstanceInfo }) {
  const t = useT();
  const layout = useRouteLayout();
  const accessFlow = useCreateAccessFlow();
  const user = instance.kind === 'user';
  const { prefs } = usePrefs();
  const { setHelpOpen } = useShortcutRegistry();
  const { theme, density } = resolveDisplay(prefs, instance.ui);
  useEffect(() => {
    applyDisplayPrefs(document.documentElement, { theme, density });
  }, [theme, density]);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset['layout'] = layout;
    return () => {
      delete root.dataset['layout'];
    };
  }, [layout]);
  useShortcut(
    '?',
    () => {
      setHelpOpen(true);
    },
    { description: t('shell.shortcutsHelp') },
  );
  return (
    <AccessFlowContext value={accessFlow}>
      <AttentionHost kind={instance.kind}>
        <div className="shell">
          <SkipLinks />
          <TopBar />
          <InstanceChangedNotice />
          {user ? <OutdatedNotice /> : null}
          {user ? <AccessGate /> : null}
          <div className="shell__body">
            <Sidebar />
            <main
              id={MAIN_ID}
              className={layout === 'bleed' ? 'main main--bleed' : 'main'}
              tabIndex={-1}
              data-stale-scope={layout === 'page' ? '' : undefined}
            >
              <Outlet />
            </main>
          </div>
          <ShortcutsDialog />
          <ToastRegion />
        </div>
      </AttentionHost>
    </AccessFlowContext>
  );
}

function BootFrame({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <SkipLinks />
      <TopBar />
      <div className="shell__body shell__body--boot">
        <main id={MAIN_ID} className="main" tabIndex={-1} aria-busy="true">
          {children}
        </main>
      </div>
    </div>
  );
}

function ConnectedShell() {
  const instance = useInstance();
  if (instance.data !== undefined) {
    return (
      <InstanceIdContext value={instance.data.instanceId}>
        <Frame instance={instance.data} />
      </InstanceIdContext>
    );
  }
  if (instance.error !== null) {
    return (
      <BootFrame>
        <ErrorState
          kind="load"
          size="page"
          subjectKey="error.subject.monitor"
          error={instance.error}
          onRetry={() => {
            void instance.refetch();
          }}
        />
      </BootFrame>
    );
  }
  return (
    <BootFrame>
      <PageSkeleton />
    </BootFrame>
  );
}

/**
 * The layout route of every page (04-ui.md 4.1, 4.4): skip links, top bar (title, chips, age, Retry now, details), sidebar, `main#main` with the routed page, the one live
 * region, toasts, the shortcuts dialog and the instance-changed notice. Until the instance is known only the frame and a skeleton
 * show (no 700 ms hide, layout is visible from the first paint); a failed load shows a page-size error with a retry.
 * Without an API client in the tree (isolated route tests) it degrades to the bare `main` landmark.
 */
export function AppShell() {
  const api = useContext(ApiContext);
  if (api === null) {
    return (
      <main id={MAIN_ID} className="main" tabIndex={-1}>
        <Outlet />
      </main>
    );
  }
  return (
    <AnnouncerProvider>
      <ShortcutRegistryProvider>
        <ConnectedShell />
      </ShortcutRegistryProvider>
    </AnnouncerProvider>
  );
}
