import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router';

import { Button } from '../components/Button.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { createApiClient } from '../data/api-client.ts';
import { ApiContext } from '../data/hooks/useInstance.ts';
import { createQueryClient } from '../data/query-client.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';

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
          <BrowserRouter>{children}</BrowserRouter>
        </ApiContext>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
