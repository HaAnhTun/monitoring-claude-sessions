// The environment of the data hooks and `GET /instance` (04-ui.md 5.2). Contexts carry the API client, the active instance id
// and whether the stream is live; no design file assigns a home to them, so they live here with the boot query (CR-WP-46-1).
import { routes, type InstanceInfo } from '@mcs/shared';
import {
  skipToken,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { createContext, createElement, useContext, useEffect, useEffectEvent, type ReactNode } from 'react';

import type { ApiClient } from '../api-client.ts';
import type { ApiError } from '../api-errors.ts';
import { qk, type ApiQuery } from '../query-keys.ts';

/** The legacy poll defaults (04 5.2), used until the instance is known. */
export const DEFAULT_POLL: InstanceInfo['poll'] = {
  healthMs: 5000,
  sessionsMs: 6000,
  overviewMs: 5000,
  transcriptMs: 1500,
  machineMs: 2000,
  logsMs: 3000,
  attemptsMs: 6000,
};

export const ApiContext = createContext<ApiClient | null>(null);
/** The active instance id (`null`: not known yet). Every query key except the boot key starts with it (UI-I11). */
export const InstanceIdContext = createContext<string | null>(null);
/**
 * Whether the realtime stream is live. While it is, lists are refreshed by stream changes and the polling fallback is off
 * (5.2 "L"). The stream provider of the stream work package sets it; without one the pages poll.
 */
export const StreamLiveContext = createContext<boolean>(false);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (api === null) throw new Error('No API client: render the data hooks inside the app providers');
  return api;
}

export function useIid(): string {
  const iid = useContext(InstanceIdContext);
  if (iid === null) throw new Error('No active instance: render the data hooks inside <ActiveInstance>');
  return iid;
}

export function useStreamLive(): boolean {
  return useContext(StreamLiveContext);
}

/** `GET /instance`: boot data, never stale; a new server epoch refetches it (the stream work package invalidates it). */
export function useInstance(): UseQueryResult<InstanceInfo> {
  const api = useApi();
  return useQuery({
    queryKey: qk.instance(),
    queryFn: ({ signal }) => api.get('instance', routes.instance.path, routes.instance.response, { signal }),
    staleTime: Infinity,
  });
}

/** The poll intervals of the instance, or the legacy defaults before it is loaded. Reads the cache; never fetches. */
export function usePoll(): InstanceInfo['poll'] {
  const query = useQuery<InstanceInfo>({ queryKey: qk.instance(), queryFn: skipToken });
  return query.data?.poll ?? DEFAULT_POLL;
}

export interface DataEnv {
  api: ApiClient;
  iid: string;
  live: boolean;
  poll: InstanceInfo['poll'];
}

/** What every data hook needs. */
export function useDataEnv(): DataEnv {
  return { api: useApi(), iid: useIid(), live: useStreamLive(), poll: usePoll() };
}

export interface ActiveInstanceProps {
  children: ReactNode;
  /** Shown while `GET /instance` is loading. */
  fallback: ReactNode;
  /** Shown when it failed (the full-page instance error of 3.4). */
  failed: (error: ApiError) => ReactNode;
}

/** Loads the instance and renders the children with its id as the active one; nothing below it runs before the id is known. */
export function ActiveInstance({ children, fallback, failed }: ActiveInstanceProps): ReactNode {
  const query = useInstance();
  if (query.data !== undefined) {
    return createElement(InstanceIdContext, { value: query.data.instanceId }, children);
  }
  if (query.error !== null) return failed(query.error);
  return fallback;
}

// ---- cursor pages -----------------------------------------------------------------------------------------------------

export interface CursorPage {
  items: readonly unknown[];
  nextCursor: string | null;
}

export interface InfiniteList<P extends CursorPage> {
  query: UseInfiniteQueryResult<InfiniteData<P>>;
  /** All loaded pages flattened in order; the server order is never changed (5.3 rule 2). */
  items: P['items'][number][];
  /** `maxPages` pages are loaded and the server has more: the UI shows the capped note instead of "Load more" (5.3 rule 3). */
  capped: boolean;
}

export function listOf<P extends CursorPage>(
  query: UseInfiniteQueryResult<InfiniteData<P>>,
  maxPages: number,
): InfiniteList<P> {
  const items: P['items'][number][] = [];
  for (const page of query.data?.pages ?? []) items.push(...page.items);
  const loaded = query.data?.pages.length ?? 0;
  return { query, items, capped: loaded >= maxPages && query.hasNextPage };
}

/** The query of one page: the filter, the cursor (none for the first page) and the page size. */
export function pageQuery(q: ApiQuery, cursor: string | null, limit: number): Record<string, string> {
  return { ...q, ...(cursor === null ? {} : { cursor }), limit: String(limit) };
}

/**
 * `400 cursor_invalid` (the list changed under the cursor): restart the infinite list at its first page and tell the caller
 * once so it can show "The list changed; reloaded from the top". Not counted as an outage (5.3 rule 2).
 */
export function useCursorReset(error: ApiError | null, queryKey: QueryKey, onReset?: () => void): void {
  const client = useQueryClient();
  const restart = useEffectEvent(() => {
    void client.resetQueries({ queryKey });
    onReset?.();
  });
  useEffect(() => {
    if (error?.info.code === 'cursor_invalid') restart();
  }, [error]);
}
