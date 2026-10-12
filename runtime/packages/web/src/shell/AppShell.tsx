import type { InstanceInfo } from '@mcs/shared';
import { useContext, useEffect, type ReactNode } from 'react';
import { Outlet } from 'react-router';

import { PageSkeleton } from '../app/PageSkeleton.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { Icon } from '../components/Icon.tsx';
import { ApiContext, InstanceIdContext, useInstance } from '../data/hooks/useInstance.ts';
import { AnnouncerProvider } from '../state/announcer.tsx';
import { applyDisplayPrefs, resolveDisplay, usePrefs } from '../state/prefs-store.ts';
import { ShortcutRegistryProvider, useShortcut, useShortcutRegistry } from '../state/shortcuts-registry.tsx';
import { useToasts } from '../state/toast-store.ts';
import { InstanceChangedNotice } from './InstanceChangedNotice.tsx';
import { ShortcutsDialog } from './ShortcutsDialog.tsx';
import { Sidebar } from './Sidebar.tsx';
import { MAIN_ID, SkipLinks } from './SkipLinks.tsx';
import { TopBar } from './TopBar.tsx';

function ToastRegion() {
  const { toasts, dismiss } = useToasts();
  if (toasts.length === 0) return null;
  // Toasts are announced through the live region; the visible copy is not a second live region.
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`}>
          <span>{toast.message}</span>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Dismiss notification"
            onClick={() => {
              dismiss(toast.id);
            }}
          >
            <Icon name="x" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The frame once the instance is known: top bar, sidebar, the routed page, dialogs and notices. */
function Frame({ instance }: { instance: InstanceInfo }) {
  const { prefs } = usePrefs();
  const { setHelpOpen } = useShortcutRegistry();
  const { theme, density } = resolveDisplay(prefs, instance.ui);
  useEffect(() => {
    applyDisplayPrefs(document.documentElement, { theme, density });
  }, [theme, density]);
  useShortcut(
    '?',
    () => {
      setHelpOpen(true);
    },
    { description: 'Show this list of shortcuts' },
  );
  return (
    <div className="shell">
      <SkipLinks />
      <TopBar />
      <InstanceChangedNotice />
      <div className="shell__body">
        <Sidebar />
        <main id={MAIN_ID} className="main" tabIndex={-1} data-stale-scope>
          <Outlet />
        </main>
      </div>
      <ShortcutsDialog />
      <ToastRegion />
    </div>
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
          subject="the monitor"
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
