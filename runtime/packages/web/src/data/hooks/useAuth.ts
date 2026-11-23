// The session of the browser with the terminal side of the app (ADR 0099, design 04 4.2 and 4.5): whether it holds the cookie,
// how a 401 anywhere locks the terminal area, the logout, and the access flow of the page with its real dependencies.
import { routes } from '@mcs/shared';
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useCallback, useEffect, useMemo } from 'react';

import { useT } from '../../i18n/context.ts';
import { useAnnounce } from '../../state/announcer.tsx';
import { usePrefsStore } from '../../state/prefs-store.ts';
import { createAccessFlow, type AccessFlow } from '../access-flow.ts';
import { ApiError } from '../api-errors.ts';
import { qk } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';

/** What `GET /auth/session` answers. */
export interface AuthSession {
  authenticated: boolean;
}

/**
 * The access flow of the page, created once by the shell (`useCreateAccessFlow`) and read by the locked state and the paste
 * field. `null` outside the shell.
 */
export const AccessFlowContext = createContext<AccessFlow | null>(null);

/** Marks the session of the instance as not authenticated: the terminal area shows the locked state, nothing is refetched. */
export function markLocked(queryClient: QueryClient, iid: string): void {
  queryClient.setQueryData<AuthSession>(qk.authSession(iid), { authenticated: false });
}

function isAccessRequired(error: unknown): boolean {
  return error instanceof ApiError && error.info.kind === 'http' && error.info.code === 'access_required';
}

/**
 * `GET /auth/session` (an open route: it needs no cookie), kept until `markLocked`, an exchange or a logout changes it. While
 * mounted it also locks the page when any other query or mutation of the instance fails with `access_required`, so a session
 * that ended (a restart, 12 hours idle) shows the same locked state as a first visit, with no edit in the pages.
 */
export function useAuthSession(): UseQueryResult<AuthSession> {
  const { api, iid } = useDataEnv();
  const queryClient = useQueryClient();
  useEffect(() => {
    const stopQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;
      // The cache event is typed with `any` keys: take the key as `unknown` and check what is used.
      const key: unknown = event.query.queryKey;
      if (!Array.isArray(key) || key[1] !== iid || key[2] === 'auth') return;
      if (isAccessRequired(event.action.error)) markLocked(queryClient, iid);
    });
    const stopMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;
      if (isAccessRequired(event.action.error)) markLocked(queryClient, iid);
    });
    return () => {
      stopQueries();
      stopMutations();
    };
  }, [queryClient, iid]);
  return useQuery({
    queryKey: qk.authSession(iid),
    queryFn: ({ signal }) => api.get('authSession', routes.authSession.path, routes.authSession.response, { signal }),
    staleTime: Infinity,
  });
}

/** Everything the session protects that the page holds: the terminal state, the folder list and the resume answers. */
function removeProtectedQueries(queryClient: QueryClient, iid: string): void {
  queryClient.removeQueries({ queryKey: qk.terminalState(iid) });
  queryClient.removeQueries({ queryKey: qk.folders(iid) });
  queryClient.removeQueries({ queryKey: ['mcs', iid, 'resume'] });
}

/**
 * Ends the session: `POST /auth/logout`, then the page is locked, what the session protected is dropped from the cache, the
 * last selected terminal and the seen marks of the attention center are forgotten and the change is announced. A failed
 * request changes nothing and rejects with its `ApiError` (the server still holds the session); one that answers
 * `access_required` finishes the lock (it was already over).
 */
export function useLogout(): () => Promise<void> {
  const { api, iid } = useDataEnv();
  const queryClient = useQueryClient();
  const prefsStore = usePrefsStore();
  const announce = useAnnounce();
  const t = useT();
  return useCallback(async () => {
    try {
      await api.post('authLogout', routes.authLogout.path, {}, routes.authLogout.response);
    } catch (error) {
      if (!isAccessRequired(error)) throw error;
    }
    markLocked(queryClient, iid);
    removeProtectedQueries(queryClient, iid);
    prefsStore.setPref('lastTerminal', '');
    // What the person has seen says which sessions ran here: it goes with the lock (ADR 0107).
    prefsStore.setPref('attentionSeen', {});
    announce(t('access.lockedAnnounce'));
  }, [api, iid, queryClient, prefsStore, announce, t]);
}

/**
 * The access flow with its real dependencies: the exchange is a plain POST (never a mutation, so the code stays out of the
 * mutation cache), the check afterwards is a fresh read of the session, and a granted flow refreshes the terminal state and
 * the folders. One flow per mounted caller and instance.
 */
export function useCreateAccessFlow(): AccessFlow {
  const { api, iid } = useDataEnv();
  const queryClient = useQueryClient();
  return useMemo(
    () =>
      createAccessFlow({
        exchange: async (code) => {
          await api.post('authExchange', routes.authExchange.path, { code }, routes.authExchange.response);
        },
        readAuthenticated: async () => {
          const session = await queryClient.query({
            queryKey: qk.authSession(iid),
            queryFn: ({ signal }) =>
              api.get('authSession', routes.authSession.path, routes.authSession.response, { signal }),
            staleTime: 0,
          });
          return session.authenticated;
        },
        onGranted: () => {
          void queryClient.invalidateQueries({ queryKey: qk.terminalState(iid) });
          void queryClient.invalidateQueries({ queryKey: qk.folders(iid) });
        },
      }),
    [api, iid, queryClient],
  );
}
