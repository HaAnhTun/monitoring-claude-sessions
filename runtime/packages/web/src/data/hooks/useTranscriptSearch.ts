import { routes, type TranscriptSearchResponse } from '@mcs/shared';
import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { qk, type ApiQuery } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';

/**
 * `GET /search/transcript`: a search is a result of its text, so it is cached for good and runs only on submit: pass `null`
 * until the user submits, then the canonical query (`session`, `q`, `kinds`, ...).
 */
export function useTranscriptSearch(q: ApiQuery | null): UseQueryResult<TranscriptSearchResponse> {
  const { api, iid } = useDataEnv();
  return useQuery({
    queryKey: qk.transcriptSearch(iid, q ?? {}),
    queryFn:
      q === null
        ? skipToken
        : ({ signal }) =>
            api.get('transcriptSearch', routes.searchTranscript.path, routes.searchTranscript.response, {
              query: q,
              signal,
            }),
    staleTime: Infinity,
  });
}
