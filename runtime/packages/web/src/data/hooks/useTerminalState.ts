// The live terminals and what this system can do with them (ADR 0099, design 04 4.2 and 4.3). The query holds the wire answer of
// `GET /terminal/state` (the events hook patches its `sessions` in place, so the cache must keep that shape); the page reads the
// view model through `select`. This file and `useFolders.ts` are the only places that read the wire shapes of the terminal area.
import { routes, type TerminalCapabilities, type TerminalState } from '@mcs/shared';
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';

import { liveSessionOf, type LiveSession } from '../../lib/workspace-view.ts';
import { ApiError } from '../api-errors.ts';
import { qk } from '../query-keys.ts';
import { markLocked, useAuthSession } from './useAuth.ts';
import { useDataEnv } from './useInstance.ts';

/** What the terminal area of the page reads: the capabilities, the live sessions and the epoch of the server that said so. */
export interface TerminalView {
  capabilities: TerminalCapabilities;
  sessions: LiveSession[];
  epoch: string;
}

/** The poll interval while the events channel is down (MTOP's `POLL_MS`) and while it is open (marks refresh through it). */
export const TERMINAL_POLL_DOWN_MS = 5000;
export const TERMINAL_POLL_OPEN_MS = 60_000;
/** A fresh answer is reused for this long when a second view mounts. */
const TERMINAL_STALE_MS = 2000;

/** The adapter of design 04 C6: a wire answer as the view model reads it. */
export function terminalViewOf(state: TerminalState): TerminalView {
  return { capabilities: state.capabilities, sessions: state.sessions.map(liveSessionOf), epoch: state.epoch };
}

/** A failure of a request the session protects: `access_required` locks the page, then the error goes on to the caller. */
export function lockOnAccessRequired(queryClient: QueryClient, iid: string, error: unknown): void {
  if (error instanceof ApiError && error.info.kind === 'http' && error.info.code === 'access_required') {
    markLocked(queryClient, iid);
  }
}

/** Whether the requests of the terminal area may be sent: the caller wants them and the browser holds the session cookie. */
export function useSessionGate(enabled: boolean): boolean {
  const session = useAuthSession();
  return enabled && session.data?.authenticated === true;
}

export interface UseTerminalStateOptions {
  /** The caller's own condition (default true); the request also waits for the session cookie. */
  enabled?: boolean;
  /** The events channel is open: the list follows the server and the page polls slowly. */
  eventsOpen: boolean;
}

/**
 * `GET /terminal/state`, only while the browser holds the session. Polls every 5 s while the events channel is down and every
 * 60 s while it is open; a 401 locks the page (`markLocked`) and stops the polling by itself.
 */
export function useTerminalState(o: UseTerminalStateOptions): UseQueryResult<TerminalView> {
  const { api, iid } = useDataEnv();
  const queryClient = useQueryClient();
  const allowed = useSessionGate(o.enabled ?? true);
  return useQuery<TerminalState, ApiError, TerminalView>({
    queryKey: qk.terminalState(iid),
    queryFn: async ({ signal }) => {
      try {
        return await api.get('terminalState', routes.terminalState.path, routes.terminalState.response, { signal });
      } catch (error) {
        lockOnAccessRequired(queryClient, iid, error);
        throw error;
      }
    },
    select: terminalViewOf,
    enabled: allowed,
    staleTime: TERMINAL_STALE_MS,
    refetchInterval: o.eventsOpen ? TERMINAL_POLL_OPEN_MS : TERMINAL_POLL_DOWN_MS,
  });
}
