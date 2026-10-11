import { routes, type SessionDetail } from '@mcs/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { pathFor } from '../endpoints.ts';
import { qk } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';

/**
 * `GET /sessions/:id`. A 404 is not retried. An id the route refuses (a mistyped address) is a not-found answer without a
 * request.
 */
export function useSession(sessionId: string): UseQueryResult<SessionDetail & { asOfSeq: number }> {
  const { api, iid, live, poll } = useDataEnv();
  return useQuery({
    queryKey: qk.session(iid, sessionId),
    queryFn: ({ signal }) =>
      api.get('session', pathFor('session', routes.getSession, { sessionId }), routes.getSession.response, { signal }),
    staleTime: 30_000,
    refetchInterval: live ? false : poll.sessionsMs,
  });
}
