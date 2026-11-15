// The project folders and the monitor rows of the Workspace sidebar (ADR 0099, design 04 4.2): `GET /folders` as the view model
// reads it, the monitor rows of the live terminals and the recent sessions of one folder. The two session queries live under the
// `sessions` key prefix, so the stream's `session/upsert` patches their rows in place without any code here.
import { routes, type FolderListResponse, type Page, type SessionSummary } from '@mcs/shared';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { folderModelOf, type FolderModel } from '../../lib/workspace-view.ts';
import type { ApiError } from '../api-errors.ts';
import { qk } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';
import { lockOnAccessRequired, useSessionGate } from './useTerminalState.ts';

/** What the sidebar reads of `GET /folders`: the rows as models, what each source said and when the answer was made. */
export interface FolderList {
  folders: FolderModel[];
  sources: FolderListResponse['sources'];
  asOf: string;
}

export const FOLDERS_POLL_MS = 5000;
/** The most monitor rows one list asks for: the server accepts at most 50 ids in the `session` filter. */
export const LINKED_SESSIONS_LIMIT = 50;
/** The recent sessions a folder row shows. */
export const FOLDER_SESSIONS_LIMIT = 6;

function folderListOf(response: FolderListResponse): FolderList {
  return { folders: response.folders.map(folderModelOf), sources: response.sources, asOf: response.asOf };
}

export interface UseFoldersOptions {
  /** The caller's own condition (default true); the request also waits for the session cookie. */
  enabled?: boolean;
}

/** `GET /folders` (a session route), polled every 5 s; a 401 locks the page. */
export function useFolders(o: UseFoldersOptions = {}): UseQueryResult<FolderList> {
  const { api, iid } = useDataEnv();
  const queryClient = useQueryClient();
  const allowed = useSessionGate(o.enabled ?? true);
  return useQuery<FolderListResponse, ApiError, FolderList>({
    queryKey: qk.folders(iid),
    queryFn: async ({ signal }) => {
      try {
        return await api.get('folders', routes.listFolders.path, routes.listFolders.response, { signal });
      } catch (error) {
        lockOnAccessRequired(queryClient, iid, error);
        throw error;
      }
    },
    select: folderListOf,
    enabled: allowed,
    staleTime: 2000,
    refetchInterval: FOLDERS_POLL_MS,
  });
}

/**
 * The monitor rows of the sessions the live terminals are linked to (design 04 C7): one request for all of them, by id, over all
 * time and with the unmatched ones. While the stream is live the rows follow it and nothing polls.
 */
export function useLinkedSessions(ids: readonly string[]): UseQueryResult<Page<SessionSummary>> {
  const { api, iid, live, poll } = useDataEnv();
  const sorted = [...new Set(ids)].sort();
  return useQuery({
    queryKey: qk.linkedSessions(iid, sorted.join(',')),
    queryFn: ({ signal }) =>
      api.get('sessions', routes.listSessions.path, routes.listSessions.response, {
        query: {
          session: sorted,
          range: 'all',
          includeUnmatched: true,
          limit: String(LINKED_SESSIONS_LIMIT),
        },
        signal,
      }),
    enabled: sorted.length > 0,
    staleTime: 30_000,
    refetchInterval: live ? false : poll.sessionsMs,
  });
}

/** The recent sessions of one folder row, asked only while the row's body is open. */
export function useFolderSessions(folderKey: string, enabled: boolean): UseQueryResult<Page<SessionSummary>> {
  const { api, iid, live, poll } = useDataEnv();
  return useQuery({
    queryKey: qk.folderSessions(iid, folderKey),
    queryFn: ({ signal }) =>
      api.get('sessions', routes.listSessions.path, routes.listSessions.response, {
        query: { project: folderKey, limit: String(FOLDER_SESSIONS_LIMIT) },
        signal,
      }),
    enabled,
    staleTime: 30_000,
    refetchInterval: live ? false : poll.sessionsMs,
  });
}
