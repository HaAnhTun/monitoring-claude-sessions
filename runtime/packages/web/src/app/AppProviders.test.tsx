import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocation } from 'react-router';

import { AppProviders } from './AppProviders.tsx';

function Probe() {
  const client = useQueryClient();
  const { pathname } = useLocation();
  return (
    <output data-testid="probe">
      {pathname} {String(client.getDefaultOptions().queries?.throwOnError)}
    </output>
  );
}

function Boom(): never {
  throw new Error('shell exploded');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AppProviders', () => {
  it('provides a router and a query client that never throws query errors into boundaries', () => {
    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('/ false');
  });

  it('uses the query client it is given', () => {
    const client = new QueryClient({ defaultOptions: { queries: { throwOnError: true } } });
    render(
      <AppProviders queryClient={client}>
        <Probe />
      </AppProviders>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('true');
  });

  it('shows the full-page fallback with Reload page when the shell crashes', () => {
    render(
      <AppProviders>
        <Boom />
      </AppProviders>,
    );
    expect(screen.getByText('This view failed to render.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
  });
});
