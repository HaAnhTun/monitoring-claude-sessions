import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router';

import { Button } from '../components/Button.tsx';
import { Icon } from '../components/Icon.tsx';
import { createApiClient } from '../data/api-client.ts';
import { ApiContext } from '../data/hooks/useInstance.ts';
import { createQueryClient } from '../data/query-client.ts';
import { I18nProvider, useActiveLocale } from '../i18n/I18nProvider.tsx';
import { browserLanguages, resolveLocale } from '../i18n/locale.ts';
import { catalogues, translate } from '../i18n/translate.ts';
import { usePrefs } from '../state/prefs-store.ts';
import { StreamProvider } from '../stream/StreamProvider.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';

/** Rule R3 exception (04 5.5): a list the user has not scrolled follows the stream, so the default view stays current. */
const AT_TOP_PX = 8;

/** True while neither the page nor the main region is scrolled. Read at the moment a change arrives, never subscribed. */
function viewIsAtTop(): boolean {
  const main = document.querySelector('main');
  const scrolled = Math.max(window.scrollY, document.scrollingElement?.scrollTop ?? 0, main?.scrollTop ?? 0);
  return scrolled < AT_TOP_PX;
}

/**
 * The full-page fallback of the root boundary. It sits above the language provider, which may be the thing that crashed, so it
 * reads the stored language itself and translates with the pure `translate` instead of the hooks of the provider. Until a
 * Vietnamese catalogue has been fetched the text is English (and stays English if the fetch fails).
 */
function RootCrashFallback() {
  const { prefs } = usePrefs();
  const [languages] = useState(browserLanguages);
  const { locale } = useActiveLocale(catalogues, resolveLocale(prefs.locale ?? 'auto', languages));
  return (
    <div className="state state--error state--page" role="status" data-kind="crash">
      <p className="state__title">
        <Icon name="alert" />
        <span>{translate(locale, 'common.viewFailed')}</span>
      </p>
      <div className="state__actions">
        <Button
          icon="refresh"
          onClick={() => {
            window.location.reload();
          }}
        >
          {translate(locale, 'common.reloadPage')}
        </Button>
      </div>
    </div>
  );
}

export interface AppProvidersProps {
  children: ReactNode;
  /** Defaults to the data layer's client: retry policy of 04-ui.md 5.2, never throws query errors into boundaries (3.4). */
  queryClient?: QueryClient;
}

/**
 * AppErrorBoundary at the root: a crash in the shell shows a full-page fallback with "Reload page" (04-ui.md 3.4). The language
 * provider (ADR 0072) is the outermost provider inside it, so every other provider and the whole app can translate.
 */
export function AppProviders({ children, queryClient }: AppProvidersProps) {
  const [fallbackClient] = useState(createQueryClient);
  // The one API client of the app: same origin, created once (04-ui.md 5.1). Without it no data hook has a client.
  const [apiClient] = useState(createApiClient);
  return (
    <ErrorBoundary resetKeys={[]} fallback={() => <RootCrashFallback />}>
      <I18nProvider>
        <QueryClientProvider client={queryClient ?? fallbackClient}>
          <ApiContext value={apiClient}>
            {/* The one realtime stream of the app (04 5.6): same-origin EventSource on /api/v3/stream, created once the
                instance is known. It tells the data hooks to stop polling while it is live and patches or invalidates their
                queries; the connection and ingestion indicators read its snapshot. Connectivity is not ingestion health. */}
            <StreamProvider listAtTop={viewIsAtTop}>
              <BrowserRouter>{children}</BrowserRouter>
            </StreamProvider>
          </ApiContext>
        </QueryClientProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}
