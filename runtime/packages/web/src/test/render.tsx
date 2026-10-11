import type { InstanceInfo } from '@mcs/shared';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render, renderHook, type RenderHookResult, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { createApiClient, type ApiClient } from '../data/api-client.ts';
import { ApiContext, InstanceIdContext, StreamLiveContext } from '../data/hooks/useInstance.ts';
import { createQueryClient } from '../data/query-client.ts';
import { qk } from '../data/query-keys.ts';
import { createFakeApi, type FakeApi } from './fake-api.ts';
import { makeInstance } from './fixtures/health.ts';

export interface RenderOptions {
  /** Initial router entry; default `/`. */
  route?: string;
  /** Default: serves only `GET /instance` with `instance`. */
  api?: FakeApi;
  /** Default: `makeInstance()`; its poll intervals reach the hooks through the query cache. */
  instance?: InstanceInfo;
  /**
   * The active instance id the data hooks see. Default: the id of `instance`, with `instance` already in the cache.
   * `null`: no active instance and nothing cached, so the test renders `ActiveInstance` or `useInstance` itself.
   */
  instanceId?: string | null;
  /** Whether the stream is live (the polling fallback of 04 5.2 is off). Default false: no stream in the page. */
  live?: boolean;
  /** Default: a fresh client with retries off. */
  queryClient?: QueryClient;
  /** The clock of the API client (tracker times). */
  now?: () => number;
  /** Extra providers, innermost last (the stream and prefs providers of later work packages plug in here). */
  wrap?: (children: ReactNode) => ReactNode;
}

export interface RenderEnv {
  queryClient: QueryClient;
  api: FakeApi;
  apiClient: ApiClient;
  instance: InstanceInfo;
}

function setup(options: RenderOptions): RenderEnv & { Wrapper: (props: { children: ReactNode }) => ReactElement } {
  const instance = options.instance ?? makeInstance();
  const api = options.api ?? createFakeApi({ instance: () => instance });
  const queryClient = options.queryClient ?? createQueryClient({ retry: false });
  const apiClient = createApiClient({
    fetchImpl: api.fetchImpl,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const instanceId = options.instanceId === undefined ? instance.instanceId : options.instanceId;
  if (instanceId !== null) queryClient.setQueryData(qk.instance(), instance);
  const live = options.live ?? false;

  function Wrapper({ children }: { children: ReactNode }): ReactElement {
    const inner = options.wrap === undefined ? children : options.wrap(children);
    return (
      <QueryClientProvider client={queryClient}>
        <ApiContext value={apiClient}>
          <StreamLiveContext value={live}>
            <InstanceIdContext value={instanceId}>
              <MemoryRouter initialEntries={[options.route ?? '/']}>{inner}</MemoryRouter>
            </InstanceIdContext>
          </StreamLiveContext>
        </ApiContext>
      </QueryClientProvider>
    );
  }

  return { queryClient, api, apiClient, instance, Wrapper };
}

/** Renders `ui` with a fresh query client, the fake API, the router and the instance contexts (04 11 `renderWithProviders`). */
export function renderWithProviders(ui: ReactElement, options: RenderOptions = {}): RenderResult & RenderEnv {
  const { Wrapper, ...env } = setup(options);
  return Object.assign(render(ui, { wrapper: Wrapper }), env);
}

/** The same providers around a hook; `initialProps` and `rerender` work as in Testing Library. */
export function renderHookWithProviders<Result, Props = undefined>(
  callback: (props: Props) => Result,
  options: RenderOptions & { initialProps?: Props } = {},
): RenderHookResult<Result, Props> & RenderEnv {
  const { Wrapper, ...env } = setup(options);
  const { initialProps } = options;
  const rendered = renderHook<Result, Props>(callback, {
    wrapper: Wrapper,
    ...(initialProps === undefined ? {} : { initialProps }),
  });
  return Object.assign(rendered, env);
}
