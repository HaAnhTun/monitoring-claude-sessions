import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router';

import { Button } from '../components/Button.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { createApiClient } from '../data/api-client.ts';
import { ApiContext } from '../data/hooks/useInstance.ts';
import { createQueryClient } from '../data/query-client.ts';
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

export interface AppProvidersProps {
  children: ReactNode;
  /** Defaults to the data layer's client: retry policy of 04-ui.md 5.2, never throws query errors into boundaries (3.4). */
  queryClient?: QueryClient;
}

/** AppErrorBoundary at the root: a crash in the shell shows a full-page fallback with "Reload page" (04-ui.md 3.4). */
export function AppProviders({ children, queryClient }: AppProvidersProps) {
  const [fallbackClient] = useState(createQueryClient);
  // The one API client of the app: same origin, created once (04-ui.md 5.1). Without it no data hook has a client.
  const [apiClient] = useState(createApiClient);
  return (
    <ErrorBoundary
      resetKeys={[]}
      fallback={() => (
        <ErrorState kind="crash" size="page">
          <Button
            icon="refresh"
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload page
          </Button>
        </ErrorState>
      )}
    >
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
    </ErrorBoundary>
  );
}
