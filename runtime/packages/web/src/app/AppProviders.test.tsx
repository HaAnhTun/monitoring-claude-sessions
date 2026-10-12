import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocation } from 'react-router';

import { useApi } from '../data/hooks/useInstance.ts';
import { createFakeApi } from '../test/fake-api.ts';
import { makeHealth, makeInstance, makeSession, makeSessionPage, sessionId } from '../test/fixtures/index.ts';
import { App } from './App.tsx';
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

function ApiProbe() {
  return <output data-testid="api">{typeof useApi().get}</output>;
}

function Boom(): never {
  throw new Error('shell exploded');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
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

  it('provides the API client to the data hooks', () => {
    render(
      <AppProviders>
        <ApiProbe />
      </AppProviders>,
    );
    expect(screen.getByTestId('api')).toHaveTextContent('function');
  });

  it('loads and renders the sessions list in the real app, through the global fetch and the same origin', async () => {
    const instance = makeInstance();
    const api = createFakeApi({
      instance: () => instance,
      health: () => makeHealth('ok'),
      listSessions: () =>
        makeSessionPage([makeSession({ id: sessionId(1), seq: 1, label: 'FIXTURE wired session' })], { total: 1 }),
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    window.history.replaceState(null, '', '/sessions');
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    );
    expect((await screen.findAllByText('FIXTURE wired session')).length).toBeGreaterThan(0);
    expect(api.callsTo('listSessions').length).toBeGreaterThan(0);
    expect(api.violations).toEqual([]);
    for (const call of api.calls) expect(call.url).toMatch(/^\/api\/v3\//);
  });
});
