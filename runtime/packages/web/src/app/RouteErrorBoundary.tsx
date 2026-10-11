import type { ReactNode } from 'react';
import { useLocation } from 'react-router';

import { Button } from '../components/Button.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';

function copyDetails(error: Error, componentStack: string | undefined): void {
  const text = [`${error.name}: ${error.message}`, componentStack ?? ''].join('\n').trim();
  // Best effort: the clipboard is absent outside secure contexts and may refuse; neither may throw inside a fallback.
  if (!('clipboard' in navigator)) return;
  navigator.clipboard.writeText(text).catch(() => undefined);
}

/** Wraps one route element; navigating to another path leaves the fallback (04-ui.md 3.1 rule 2, 3.4). */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary
      resetKeys={[pathname]}
      fallback={({ error, reset, componentStack }) => (
        <ErrorState kind="crash" size="page" onRetry={reset}>
          <Button
            icon="copy"
            onClick={() => {
              copyDetails(error, componentStack);
            }}
          >
            Copy error details
          </Button>
        </ErrorState>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
