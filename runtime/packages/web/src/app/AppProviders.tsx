import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router';

import { Button } from '../components/Button.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';

export interface AppProvidersProps {
  children: ReactNode;
  /** Defaults to a client that never throws query errors into boundaries (04-ui.md 3.4). */
  queryClient?: QueryClient;
}

function createDefaultQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { throwOnError: false } } });
}

/** AppErrorBoundary at the root: a crash in the shell shows a full-page fallback with "Reload page" (04-ui.md 3.4). */
export function AppProviders({ children, queryClient }: AppProvidersProps) {
  const [fallbackClient] = useState(createDefaultQueryClient);
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
        <BrowserRouter>{children}</BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
