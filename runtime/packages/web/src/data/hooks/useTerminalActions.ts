// What a person does with terminals (ADR 0099, design 04 4.2): start one, stop one, pick a folder, start in a folder by path,
// resume a session, open it in the native terminal and ask whether it can be resumed. Every write is a mutation that never retries; the cached terminal list is
// kept in step at once (a started session is added, a stopped one is removed) and then refreshed, so the sidebar does not wait for
// the events channel. A request the session protects that answers `access_required` locks the page.
import {
  routes,
  type OpenNativeResponse,
  type ResumeEligibility,
  type TerminalSessionInfo,
  type TerminalState,
} from '@mcs/shared';
import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { liveSessionOf, type LiveSession } from '../../lib/workspace-view.ts';
import { ApiError } from '../api-errors.ts';
import { pathFor } from '../endpoints.ts';
import { qk } from '../query-keys.ts';
import { useDataEnv } from './useInstance.ts';
import { lockOnAccessRequired } from './useTerminalState.ts';

/** Starting a process can take a moment on a loaded machine: longer than the 8 s of a read. */
export const TERMINAL_WRITE_TIMEOUT_MS = 20_000;
/** The folder dialog of the computer waits for a person; the server aborts it when this page goes away. */
export const PICK_FOLDER_TIMEOUT_MS = 600_000;

/** Puts a session the server just confirmed into the cached list (or replaces the row of the same name). */
function rememberSession(queryClient: QueryClient, iid: string, session: TerminalSessionInfo): void {
  queryClient.setQueryData<TerminalState>(qk.terminalState(iid), (before) => {
    if (before === undefined) return before;
    const others = before.sessions.filter((row) => row.name !== session.name);
    return { ...before, sessions: [...others, session] };
  });
}

function refreshTerminalState(queryClient: QueryClient, iid: string): void {
  void queryClient.invalidateQueries({ queryKey: qk.terminalState(iid) });
}

/** Runs a request the session protects: a refusal for a missing session locks the page, then the error goes on. */
async function guarded<T>(queryClient: QueryClient, iid: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    lockOnAccessRequired(queryClient, iid, error);
    throw error;
  }
}

function useWriteEnv() {
  const { api, iid } = useDataEnv();
  const queryClient = useQueryClient();
  return { api, iid, queryClient };
}

/** `POST /terminal/sessions`: starts `claude` in a folder. The new session joins the cached list at once. */
export function useCreateTerminalSession() {
  const { api, iid, queryClient } = useWriteEnv();
  return useMutation<LiveSession, ApiError, { path: string }>({
    mutationFn: ({ path }) =>
      guarded(queryClient, iid, async () => {
        const answer = await api.post(
          'terminalCreateSession',
          routes.terminalCreateSession.path,
          { path },
          routes.terminalCreateSession.response,
          { timeoutMs: TERMINAL_WRITE_TIMEOUT_MS },
        );
        rememberSession(queryClient, iid, answer.session);
        return liveSessionOf(answer.session);
      }),
    onSettled: () => {
      refreshTerminalState(queryClient, iid);
    },
  });
}

export interface StartInFolderInput {
  path: string;
  /** The folder is a row of the folder list: it is known, so it is not added again. */
  known: boolean;
}

export interface StartInFolder {
  /**
   * Starts a session in `path`. Unless the folder is `known`, it is added to the folder list first: that normalises the path
   * (a WSL path, a trailing separator) and a folder the server refuses (`folder_invalid`) stops here, before any process starts.
   */
  start: (path: string, options?: { known?: boolean }) => Promise<LiveSession>;
  isPending: boolean;
  error: ApiError | null;
  /** Forgets the last failure (the dialog was closed or the text changed). */
  reset: () => void;
}

export function useStartInFolder(): StartInFolder {
  const { api, iid, queryClient } = useWriteEnv();
  const mutation = useMutation<LiveSession, ApiError, StartInFolderInput>({
    mutationFn: ({ path, known }) =>
      guarded(queryClient, iid, async () => {
        const typed = path.trim();
        let target = typed;
        if (!known) {
          const folder = await api.post('addFolder', routes.addFolder.path, { path: typed }, routes.addFolder.response);
          target = folder.path ?? typed;
          void queryClient.invalidateQueries({ queryKey: qk.folders(iid) });
        }
        const answer = await api.post(
          'terminalCreateSession',
          routes.terminalCreateSession.path,
          { path: target },
          routes.terminalCreateSession.response,
          { timeoutMs: TERMINAL_WRITE_TIMEOUT_MS },
        );
        rememberSession(queryClient, iid, answer.session);
        return liveSessionOf(answer.session);
      }),
    onSettled: () => {
      refreshTerminalState(queryClient, iid);
    },
  });
  const { mutateAsync, reset } = mutation;
  const start = useCallback(
    (path: string, options: { known?: boolean } = {}) => mutateAsync({ path, known: options.known ?? false }),
    [mutateAsync],
  );
  return { start, isPending: mutation.isPending, error: mutation.error, reset };
}

interface StopContext {
  removed: TerminalSessionInfo | undefined;
  index: number;
}

/**
 * `POST /terminal/sessions/:name/kill`. The session leaves the cached list before the answer; any failure but "it is not running
 * any more" puts it back where it was. A session that was already gone counts as stopped.
 */
export function useStopTerminalSession() {
  const { api, iid, queryClient } = useWriteEnv();
  return useMutation<undefined, ApiError, { name: string }, StopContext>({
    mutationFn: ({ name }) =>
      guarded(queryClient, iid, async () => {
        const path = pathFor('terminalKillSession', routes.terminalKillSession, { name });
        try {
          await api.post('terminalKillSession', path, {}, routes.terminalKillSession.response);
        } catch (error) {
          if (!(error instanceof ApiError && error.info.kind === 'http' && error.info.code === 'terminal_not_found')) {
            throw error;
          }
        }
        return undefined;
      }),
    onMutate: async ({ name }) => {
      const key = qk.terminalState(iid);
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<TerminalState>(key);
      const index = before?.sessions.findIndex((row) => row.name === name) ?? -1;
      const removed = index < 0 ? undefined : before?.sessions[index];
      if (before !== undefined && removed !== undefined) {
        queryClient.setQueryData<TerminalState>(key, {
          ...before,
          sessions: before.sessions.filter((row) => row.name !== name),
        });
      }
      return { removed, index };
    },
    onError: (_error, _input, context) => {
      const removed = context?.removed;
      if (removed === undefined) return;
      queryClient.setQueryData<TerminalState>(qk.terminalState(iid), (current) => {
        if (current === undefined || current.sessions.some((row) => row.name === removed.name)) return current;
        const sessions = [...current.sessions];
        sessions.splice(Math.min(context?.index ?? sessions.length, sessions.length), 0, removed);
        return { ...current, sessions };
      });
    },
    onSettled: () => {
      refreshTerminalState(queryClient, iid);
    },
  });
}

export interface PickFolder {
  /**
   * `POST /terminal/pick-folder`: opens the folder dialog on the computer and answers the path, or `null` when it was closed.
   * Waits up to 600 s. The request is aborted when `signal` aborts and when the component that called this goes away.
   */
  pick: (signal?: AbortSignal) => Promise<string | null>;
}

export function usePickFolder(): PickFolder {
  const { api, iid, queryClient } = useWriteEnv();
  const [pending] = useState(() => new Set<AbortController>());
  useEffect(
    () => () => {
      for (const controller of pending) controller.abort();
      pending.clear();
    },
    [pending],
  );
  const pick = useCallback(
    async (signal?: AbortSignal): Promise<string | null> => {
      const own = new AbortController();
      pending.add(own);
      const onCallerAbort = (): void => {
        own.abort();
      };
      if (signal?.aborted === true) own.abort();
      else signal?.addEventListener('abort', onCallerAbort, { once: true });
      try {
        const answer = await guarded(queryClient, iid, () =>
          api.post('terminalPickFolder', routes.terminalPickFolder.path, {}, routes.terminalPickFolder.response, {
            signal: own.signal,
            timeoutMs: PICK_FOLDER_TIMEOUT_MS,
          }),
        );
        return answer.path;
      } finally {
        signal?.removeEventListener('abort', onCallerAbort);
        pending.delete(own);
      }
    },
    [api, iid, queryClient, pending],
  );
  return { pick };
}

/** `POST /terminal/resume`: `claude --resume` in a new terminal, or a copy of the session with `fork`. */
export function useResumeTerminalSession() {
  const { api, iid, queryClient } = useWriteEnv();
  return useMutation<LiveSession, ApiError, { sessionId: string; fork: boolean }>({
    mutationFn: ({ sessionId, fork }) =>
      guarded(queryClient, iid, async () => {
        const answer = await api.post(
          'terminalResume',
          routes.terminalResume.path,
          { sessionId, fork },
          routes.terminalResume.response,
          { timeoutMs: TERMINAL_WRITE_TIMEOUT_MS },
        );
        rememberSession(queryClient, iid, answer.session);
        return liveSessionOf(answer.session);
      }),
    onSettled: (_session, _error, input) => {
      refreshTerminalState(queryClient, iid);
      void queryClient.invalidateQueries({ queryKey: qk.resumeEligibility(iid, input.sessionId) });
    },
  });
}

/**
 * `POST /terminal/open-native`: a window of the person's own terminal running `claude --resume` (CAW-145), or a copy with `fork`.
 * The app starts no terminal of its own and keeps no control of the window, so no cached list changes and nothing is refreshed.
 */
export function useOpenNativeTerminal() {
  const { api, iid, queryClient } = useWriteEnv();
  return useMutation<OpenNativeResponse, ApiError, { sessionId: string; fork: boolean }>({
    mutationFn: ({ sessionId, fork }) =>
      guarded(queryClient, iid, () =>
        api.post(
          'terminalOpenNative',
          routes.terminalOpenNative.path,
          { sessionId, fork },
          routes.terminalOpenNative.response,
          { timeoutMs: TERMINAL_WRITE_TIMEOUT_MS },
        ),
      ),
  });
}

/**
 * `GET /sessions/:sessionId/resume`: whether the session can be resumed, a copy of it, and why not. Asked fresh every time a
 * dialog or a button mounts (the answer changes when a terminal starts or ends), and only for a session id.
 */
export function useResumeEligibility(sessionId: string | null): UseQueryResult<ResumeEligibility> {
  const { api, iid } = useDataEnv();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: qk.resumeEligibility(iid, sessionId ?? ''),
    queryFn: ({ signal }) =>
      guarded(queryClient, iid, () =>
        api.get(
          'sessionResume',
          pathFor('sessionResume', routes.sessionResume, { sessionId: sessionId ?? '' }),
          routes.sessionResume.response,
          { signal },
        ),
      ),
    enabled: sessionId !== null,
    staleTime: 0,
    // an answer is about the moment it was asked: nothing is kept for the next dialog
    gcTime: 0,
  });
}
