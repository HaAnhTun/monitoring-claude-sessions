import { routes, type InstanceSearchResponse } from '@mcs/shared';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import type { ApiError } from '../api-errors.ts';
import { qk, type ApiQuery } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';

/**
 * - `idle`: nothing was submitted;
 * - `loading`: a request is running;
 * - `cancelled`: the user stopped it before an answer came;
 * - `error`: it failed, or the answer was for another text (`dropped`);
 * - `ready`: `data` is the answer to the current query.
 */
export type InstanceSearchStatus = 'idle' | 'loading' | 'cancelled' | 'error' | 'ready';

export interface InstanceSearchState {
  status: InstanceSearchStatus;
  /** Set only in `ready`, and only when the answer echoes the text that was asked. */
  data: InstanceSearchResponse | null;
  error: ApiError | null;
  /** The answer echoed another text than the current query: it was dropped and is never shown. */
  dropped: boolean;
  /** Runs the current query again, even when its answer is cached. */
  search: () => void;
  /** Stops the running request (the answer, if it still arrives, is not used). */
  cancel: () => void;
}

/** How long the answer of a search is kept after the page that asked is gone. */
const KEEP_MS = 60_000;

/**
 * `GET /search/transcripts`: the instance-wide transcript search. A search is a result of its text, so it runs only when a query
 * is passed (the page passes one on submit, `null` before) and its key holds every parameter. Changing the query aborts the
 * request in flight, and an answer whose echoed `q` is not the one asked is dropped. The text is never written anywhere but into
 * the request and the cache key.
 */
export function useInstanceSearch(q: ApiQuery | null): InstanceSearchState {
  const { api, iid } = useDataEnv();
  const client = useQueryClient();
  const queryKey = qk.instanceSearch(iid, q ?? {});
  const query = useQuery({
    queryKey,
    queryFn:
      q === null
        ? skipToken
        : ({ signal }) =>
            api.get('instanceSearch', routes.searchTranscripts.path, routes.searchTranscripts.response, {
              query: q,
              signal,
            }),
    staleTime: Infinity,
    gcTime: KEEP_MS,
  });
  const search = useCallback(() => {
    void client.resetQueries({ queryKey, exact: true });
  }, [client, queryKey]);
  const cancel = useCallback(() => {
    void client.cancelQueries({ queryKey, exact: true });
  }, [client, queryKey]);

  const base = { search, cancel };
  if (q === null) return { status: 'idle', data: null, error: null, dropped: false, ...base };
  if (query.fetchStatus === 'fetching') return { status: 'loading', data: null, error: null, dropped: false, ...base };
  if (query.error !== null) return { status: 'error', data: null, error: query.error, dropped: false, ...base };
  if (query.data === undefined) return { status: 'cancelled', data: null, error: null, dropped: false, ...base };
  if (query.data.query.q !== (q['q'] ?? ''))
    return { status: 'error', data: null, error: null, dropped: true, ...base };
  return { status: 'ready', data: query.data, error: null, dropped: false, ...base };
}
