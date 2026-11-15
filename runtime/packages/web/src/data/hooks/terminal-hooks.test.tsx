import type { SessionSummary, TerminalState } from '@mcs/shared';
import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReconciler } from '../../stream/reconcile.ts';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import {
  FIXTURE_INSTANCE_ID,
  iso,
  makeAuthSession,
  makeFolder,
  makeFolderList,
  makeInstance,
  makeLinkedTerminalSession,
  makeResumeEligibility,
  makeSession,
  makeSessionPage,
  makeTerminalSession,
  makeTerminalState,
  sessionId,
} from '../../test/fixtures/index.ts';
import { renderHookWithProviders } from '../../test/render.tsx';
import { ApiError } from '../api-errors.ts';
import { qk } from '../query-keys.ts';
import {
  useCreateTerminalSession,
  usePickFolder,
  useResumeEligibility,
  useResumeTerminalSession,
  useStartInFolder,
  useStopTerminalSession,
} from './useTerminalActions.ts';
import { useFolders, useFolderSessions, useLinkedSessions } from './useFolders.ts';
import { terminalViewOf, useTerminalState } from './useTerminalState.ts';

const IID = FIXTURE_INSTANCE_ID;
const TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const;

afterEach(() => {
  vi.useRealTimers();
});

/** The fake API of a page whose browser holds the session cookie (`auth.authenticated`), with the handlers a test adds. */
function setup(handlers: FakeHandlers = {}, auth = { authenticated: true }): { api: FakeApi; auth: typeof auth } {
  const api = createFakeApi({
    instance: () => makeInstance(),
    authSession: () => makeAuthSession(auth.authenticated),
    ...handlers,
  });
  return { api, auth };
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A promise a test settles by hand, to look at the page while a request is in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const names = (state: TerminalState | undefined): string[] => (state?.sessions ?? []).map((session) => session.name);

describe('useTerminalState', () => {
  it('TC-UI-10 asks nothing before the browser holds the session, then loads the view', async () => {
    const state = makeTerminalState([makeTerminalSession(1)]);
    const { api } = setup({ terminalState: () => state }, { authenticated: false });
    const { result, queryClient } = renderHookWithProviders(() => useTerminalState({ eventsOpen: false }), { api });
    await waitFor(() => {
      expect(api.callsTo('authSession')).toHaveLength(1);
    });
    await Promise.resolve();
    expect(api.callsTo('terminalState')).toHaveLength(0);
    expect(result.current.data).toBeUndefined();
    act(() => {
      queryClient.setQueryData(qk.authSession(IID), { authenticated: true });
    });
    await waitFor(() => {
      expect(result.current.data?.sessions).toHaveLength(1);
    });
    expect(api.callsTo('terminalState')).toHaveLength(1);
    expect(api.violations).toEqual([]);
  });

  it('does not ask while the caller says it is disabled', async () => {
    const { api } = setup({ terminalState: () => makeTerminalState() });
    const { result } = renderHookWithProviders(() => useTerminalState({ enabled: false, eventsOpen: false }), { api });
    await waitFor(() => {
      expect(api.callsTo('authSession')).toHaveLength(1);
    });
    await Promise.resolve();
    expect(api.callsTo('terminalState')).toHaveLength(0);
    expect(result.current.data).toBeUndefined();
  });

  it('gives the view model: the capabilities, the live sessions with their link and the epoch', async () => {
    const wire = makeTerminalState([makeLinkedTerminalSession(2, { viewers: 3 })]);
    const { api } = setup({ terminalState: () => wire });
    const { result } = renderHookWithProviders(() => useTerminalState({ eventsOpen: true }), { api });
    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    expect(result.current.data).toEqual(terminalViewOf(wire));
    const session = result.current.data?.sessions[0];
    expect(session?.name).toBe('fixture-term-2');
    expect(session?.viewers).toBe(3);
    expect(session?.link.sessionId).toBe(sessionId(2));
    expect(result.current.data?.capabilities.available).toBe(true);
    expect(result.current.data?.epoch).toBe(wire.epoch);
  });

  it('follows the list the events hook writes into the cache', async () => {
    const { api } = setup({ terminalState: () => makeTerminalState([makeTerminalSession(1)]) });
    const { result, queryClient } = renderHookWithProviders(() => useTerminalState({ eventsOpen: true }), { api });
    await waitFor(() => {
      expect(result.current.data?.sessions).toHaveLength(1);
    });
    act(() => {
      queryClient.setQueryData<TerminalState>(qk.terminalState(IID), (before) =>
        before === undefined ? before : { ...before, sessions: [makeTerminalSession(1), makeTerminalSession(2)] },
      );
    });
    await waitFor(() => {
      expect(result.current.data?.sessions.map((session) => session.name)).toEqual([
        'fixture-term-1',
        'fixture-term-2',
      ]);
    });
  });

  it('TC-UI-04 polls every 5 s while the events channel is down and every 60 s while it is open', async () => {
    vi.useFakeTimers({ toFake: [...TIMERS] });
    const { api } = setup({ terminalState: () => makeTerminalState() });
    const { rerender } = renderHookWithProviders(
      (props: { open: boolean }) => useTerminalState({ eventsOpen: props.open }),
      {
        api,
        initialProps: { open: false },
      },
    );
    await flush(0);
    expect(api.callsTo('terminalState')).toHaveLength(1);
    await flush(5000);
    expect(api.callsTo('terminalState')).toHaveLength(2);
    await flush(5000);
    expect(api.callsTo('terminalState')).toHaveLength(3);
    rerender({ open: true });
    await flush(59_000);
    expect(api.callsTo('terminalState')).toHaveLength(3);
    await flush(1000);
    expect(api.callsTo('terminalState')).toHaveLength(4);
    await flush(60_000);
    expect(api.callsTo('terminalState')).toHaveLength(5);
  });

  it('TC-UI-10 locks the page when the state route answers access_required', async () => {
    const { api } = setup({ terminalState: () => errorResponse('access_required') });
    const { result, queryClient } = renderHookWithProviders(() => useTerminalState({ eventsOpen: false }), { api });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(ApiError);
    });
    expect(queryClient.getQueryData(qk.authSession(IID))).toEqual({ authenticated: false });
  });

  it('keeps another failure as an error and the page unlocked', async () => {
    const { api } = setup({ terminalState: () => errorResponse('terminal_unavailable') });
    const { result, queryClient } = renderHookWithProviders(() => useTerminalState({ eventsOpen: false }), { api });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(ApiError);
    });
    expect(queryClient.getQueryData(qk.authSession(IID))).toEqual({ authenticated: true });
  });
});

describe('useFolders', () => {
  it('asks nothing before the browser holds the session, then gives the folder models', async () => {
    const { api } = setup(
      { listFolders: () => makeFolderList([makeFolder(1), makeFolder(2, { userAdded: true })]) },
      { authenticated: false },
    );
    const { result, queryClient } = renderHookWithProviders(() => useFolders(), { api });
    await waitFor(() => {
      expect(api.callsTo('authSession')).toHaveLength(1);
    });
    await Promise.resolve();
    expect(api.callsTo('listFolders')).toHaveLength(0);
    act(() => {
      queryClient.setQueryData(qk.authSession(IID), { authenticated: true });
    });
    await waitFor(() => {
      expect(result.current.data?.folders).toHaveLength(2);
    });
    expect(result.current.data?.folders.map((folder) => folder.key)).toEqual(['fixture-app-1', 'fixture-app-2']);
    expect(result.current.data?.folders[1]?.userAdded).toBe(true);
    expect(result.current.data?.sources.userFolders.status).toBe('ok');
    expect(typeof result.current.data?.asOf).toBe('string');
  });

  it('polls every 5 s', async () => {
    vi.useFakeTimers({ toFake: [...TIMERS] });
    const { api } = setup({ listFolders: () => makeFolderList([makeFolder(1)]) });
    renderHookWithProviders(() => useFolders(), { api });
    await flush(0);
    expect(api.callsTo('listFolders')).toHaveLength(1);
    await flush(5000);
    expect(api.callsTo('listFolders')).toHaveLength(2);
  });

  it('TC-UI-10 locks the page on access_required', async () => {
    const { api } = setup({ listFolders: () => errorResponse('access_required') });
    const { result, queryClient } = renderHookWithProviders(() => useFolders(), { api });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(ApiError);
    });
    expect(queryClient.getQueryData(qk.authSession(IID))).toEqual({ authenticated: false });
  });
});

describe('useLinkedSessions and useFolderSessions', () => {
  it('asks for the monitor rows of the live terminals by id, sorted, all time, unmatched too', async () => {
    const { api } = setup({ listSessions: () => makeSessionPage([makeSession({ id: sessionId(1) })]) });
    const { result } = renderHookWithProviders(() => useLinkedSessions([sessionId(2), sessionId(1)]), { api });
    await waitFor(() => {
      expect(result.current.data?.items).toHaveLength(1);
    });
    const query = api.callsTo('listSessions')[0]?.query;
    expect(query?.get('session')).toBe([sessionId(1), sessionId(2)].join(','));
    expect(query?.get('range')).toBe('all');
    expect(query?.get('includeUnmatched')).toBe('1');
    expect(query?.get('limit')).toBe('50');
  });

  it('asks nothing for no ids, and one query for the same ids in another order', async () => {
    const { api } = setup({ listSessions: () => makeSessionPage([]) });
    const { rerender } = renderHookWithProviders((props: { ids: string[] }) => useLinkedSessions(props.ids), {
      api,
      initialProps: { ids: [] as string[] },
    });
    await Promise.resolve();
    expect(api.callsTo('listSessions')).toHaveLength(0);
    rerender({ ids: [sessionId(2), sessionId(1)] });
    await waitFor(() => {
      expect(api.callsTo('listSessions')).toHaveLength(1);
    });
    rerender({ ids: [sessionId(1), sessionId(2)] });
    await Promise.resolve();
    expect(api.callsTo('listSessions')).toHaveLength(1);
  });

  it('TC-UI-04 a stream change patches a linked row through the real reconciler', async () => {
    const row = makeSession({ id: sessionId(1), label: 'FIXTURE before', seq: 1 });
    const { api } = setup({ listSessions: () => makeSessionPage([row]) });
    const { result, queryClient } = renderHookWithProviders(() => useLinkedSessions([sessionId(1)]), { api });
    await waitFor(() => {
      expect(result.current.data?.items[0]?.label).toBe('FIXTURE before');
    });
    const reconciler = createReconciler({ queryClient, iid: IID });
    const changed: SessionSummary = { ...row, label: 'FIXTURE after', seq: 2 };
    act(() => {
      reconciler.applyBatch([
        {
          seq: 2,
          at: iso(0),
          instanceId: IID,
          kind: 'session',
          op: 'upsert',
          sessionId: row.id,
          data: changed,
        },
      ]);
    });
    await waitFor(() => {
      expect(result.current.data?.items[0]?.label).toBe('FIXTURE after');
    });
    reconciler.dispose();
    expect(api.callsTo('listSessions')).toHaveLength(1);
  });

  it('keeps the linked rows under the sessions prefix of the instance', () => {
    expect(qk.linkedSessions(IID, 'a,b').slice(0, 3)).toEqual(['mcs', IID, 'sessions']);
    expect(qk.folderSessions(IID, 'k').slice(0, 3)).toEqual(['mcs', IID, 'sessions']);
  });

  it('polls only while the stream is not live', async () => {
    vi.useFakeTimers({ toFake: [...TIMERS] });
    const { api } = setup({ listSessions: () => makeSessionPage([makeSession()]) });
    const down = renderHookWithProviders(() => useLinkedSessions([sessionId(1)]), { api, live: false });
    await flush(0);
    expect(api.callsTo('listSessions')).toHaveLength(1);
    await flush(60_000);
    expect(api.callsTo('listSessions').length).toBeGreaterThan(1);
    down.unmount();
    const live = setup({ listSessions: () => makeSessionPage([makeSession()]) });
    renderHookWithProviders(() => useLinkedSessions([sessionId(1)]), { api: live.api, live: true });
    await flush(0);
    await flush(60_000);
    expect(live.api.callsTo('listSessions')).toHaveLength(1);
  });

  it('asks for the recent sessions of a folder only while its body is open', async () => {
    const { api } = setup({ listSessions: () => makeSessionPage([makeSession()]) });
    const { rerender, result } = renderHookWithProviders(
      (props: { open: boolean }) => useFolderSessions('fixture-app-1', props.open),
      { api, initialProps: { open: false } },
    );
    await Promise.resolve();
    expect(api.callsTo('listSessions')).toHaveLength(0);
    rerender({ open: true });
    await waitFor(() => {
      expect(result.current.data?.items).toHaveLength(1);
    });
    const query = api.callsTo('listSessions')[0]?.query;
    expect(query?.get('project')).toBe('fixture-app-1');
    expect(query?.get('limit')).toBe('6');
  });
});

describe('useCreateTerminalSession', () => {
  it('TC-UI-02 posts the folder only, adds the session to the cached list and refreshes it', async () => {
    const created = makeTerminalSession(5);
    const { api } = setup({
      terminalState: () => makeTerminalState([makeTerminalSession(1), created]),
      terminalCreateSession: () => ({ session: created }),
    });
    const { result, queryClient } = renderHookWithProviders(() => useCreateTerminalSession(), { api });
    queryClient.setQueryData(qk.terminalState(IID), makeTerminalState([makeTerminalSession(1)]));
    let session: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
    await act(async () => {
      session = await result.current.mutateAsync({ path: '/fixture/projects/app-5' });
    });
    expect(session?.name).toBe(created.name);
    expect(api.callsTo('terminalCreateSession')[0]?.body).toEqual({ path: '/fixture/projects/app-5' });
    expect(api.callsTo('terminalCreateSession')[0]?.headers['x-mcs-request']).toBe('1');
    expect(names(queryClient.getQueryData<TerminalState>(qk.terminalState(IID)))).toContain(created.name);
    expect(queryClient.getQueryState(qk.terminalState(IID))?.isInvalidated).toBe(true);
    expect(api.violations).toEqual([]);
  });

  it('adds nothing when no list is cached yet, and a failure leaves the list alone', async () => {
    const { api } = setup({ terminalCreateSession: () => errorResponse('terminal_limit') });
    const { result, queryClient } = renderHookWithProviders(() => useCreateTerminalSession(), { api });
    await act(async () => {
      await expect(result.current.mutateAsync({ path: '/fixture/projects/app-5' })).rejects.toMatchObject({
        info: { code: 'terminal_limit' },
      });
    });
    expect(queryClient.getQueryData(qk.terminalState(IID))).toBeUndefined();
  });
});

describe('useStopTerminalSession', () => {
  /** A server with two terminals; the kill handler decides what the server answers and, when it answers, forgets the session. */
  function stopSetup(answer: (name: string) => unknown) {
    const server = [makeTerminalSession(1), makeTerminalSession(2)];
    const { api } = setup({
      terminalState: () => makeTerminalState([...server]),
      terminalKillSession: async (_query, request) => {
        const name = request.params['name'] ?? '';
        const reply = await answer(name);
        if (!(reply instanceof Response) || reply.status === 404) {
          const index = server.findIndex((session) => session.name === name);
          if (index >= 0) server.splice(index, 1);
        }
        return reply;
      },
    });
    const rendered = renderHookWithProviders(() => useStopTerminalSession(), { api });
    rendered.queryClient.setQueryData(qk.terminalState(IID), makeTerminalState([...server]));
    return { ...rendered, api };
  }

  it('TC-UI-05 removes the session from the list at once and keeps it removed on success', async () => {
    const gate = deferred<{ name: string }>();
    const { result, queryClient, api } = stopSetup(() => gate.promise);
    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.mutateAsync({ name: 'fixture-term-1' });
    });
    await waitFor(() => {
      expect(names(queryClient.getQueryData<TerminalState>(qk.terminalState(IID)))).toEqual(['fixture-term-2']);
    });
    expect(api.callsTo('terminalKillSession')[0]?.params).toEqual({ name: 'fixture-term-1' });
    expect(api.callsTo('terminalKillSession')[0]?.body).toEqual({});
    await act(async () => {
      gate.resolve({ name: 'fixture-term-1' });
      await done;
    });
    expect(names(queryClient.getQueryData<TerminalState>(qk.terminalState(IID)))).toEqual(['fixture-term-2']);
    expect(queryClient.getQueryState(qk.terminalState(IID))?.isInvalidated).toBe(true);
  });

  it('TC-UI-05 puts the session back when the request fails for any other reason', async () => {
    const { result, queryClient } = stopSetup(() => errorResponse('internal_error'));
    await act(async () => {
      await expect(result.current.mutateAsync({ name: 'fixture-term-1' })).rejects.toBeInstanceOf(ApiError);
    });
    expect(names(queryClient.getQueryData<TerminalState>(qk.terminalState(IID)))).toEqual([
      'fixture-term-1',
      'fixture-term-2',
    ]);
  });

  it('counts terminal_not_found as success: the session was already gone', async () => {
    const { result, queryClient } = stopSetup(() => errorResponse('terminal_not_found'));
    await act(async () => {
      await result.current.mutateAsync({ name: 'fixture-term-1' });
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(names(queryClient.getQueryData<TerminalState>(qk.terminalState(IID)))).toEqual(['fixture-term-2']);
  });

  it('never asks the server for a name that is not a terminal name', async () => {
    const { result, api } = stopSetup(() => ({ name: 'x' }));
    await act(async () => {
      await expect(result.current.mutateAsync({ name: '../state' })).rejects.toBeInstanceOf(ApiError);
    });
    expect(api.callsTo('terminalKillSession')).toHaveLength(0);
  });
});

describe('usePickFolder', () => {
  it('TC-UI-03 answers the folder the person chose, or null when the dialog was closed', async () => {
    const answers: (string | null)[] = ['/fixture/chosen', null];
    const { api } = setup({ terminalPickFolder: () => ({ path: answers.shift() ?? null }) });
    const { result } = renderHookWithProviders(() => usePickFolder(), { api });
    const first = new AbortController();
    await expect(result.current.pick(first.signal)).resolves.toBe('/fixture/chosen');
    await expect(result.current.pick(first.signal)).resolves.toBeNull();
    expect(api.callsTo('terminalPickFolder')[0]?.body).toEqual({});
  });

  it('TC-UI-03 lets picker_busy and terminal_unavailable reach the caller as they are', async () => {
    const { api } = setup({ terminalPickFolder: () => errorResponse('picker_busy') });
    const { result } = renderHookWithProviders(() => usePickFolder(), { api });
    await expect(result.current.pick(new AbortController().signal)).rejects.toMatchObject({
      info: { code: 'picker_busy' },
    });
    api.handlers.terminalPickFolder = () => errorResponse('terminal_unavailable');
    await expect(result.current.pick(new AbortController().signal)).rejects.toMatchObject({
      info: { code: 'terminal_unavailable' },
    });
  });

  it('TC-UI-03 waits up to 600 s for a person, not the 8 s of other requests', async () => {
    vi.useFakeTimers({ toFake: [...TIMERS] });
    const { api } = setup({ terminalPickFolder: () => new Promise(() => undefined) });
    const { result } = renderHookWithProviders(() => usePickFolder(), { api });
    const settled = { state: 'pending' as 'pending' | 'timeout' | 'other' };
    const request = result.current.pick(new AbortController().signal).catch((error: unknown) => {
      settled.state = error instanceof ApiError && error.info.kind === 'timeout' ? 'timeout' : 'other';
    });
    await flush(9000);
    expect(settled.state).toBe('pending');
    await flush(591_000);
    await request;
    expect(settled.state).toBe('timeout');
  });

  it('TC-UI-03 aborts the request when the page that asked goes away', async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const { api } = setup({
      terminalPickFolder: (_query, request) => {
        seen.signal = request.signal;
        return new Promise(() => undefined);
      },
    });
    const { result, unmount } = renderHookWithProviders(() => usePickFolder(), { api });
    const outcome = result.current.pick(new AbortController().signal).catch((error: unknown) => error);
    await waitFor(() => {
      expect(seen.signal).not.toBeNull();
    });
    expect(seen.signal?.aborted).toBe(false);
    unmount();
    const error = await outcome;
    expect(seen.signal?.aborted).toBe(true);
    expect(error).toMatchObject({ info: { kind: 'aborted' } });
  });

  it('TC-UI-03 aborts the request when the caller cancels it', async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const { api } = setup({
      terminalPickFolder: (_query, request) => {
        seen.signal = request.signal;
        return new Promise(() => undefined);
      },
    });
    const { result } = renderHookWithProviders(() => usePickFolder(), { api });
    const own = new AbortController();
    const outcome = result.current.pick(own.signal).catch((error: unknown) => error);
    await waitFor(() => {
      expect(seen.signal).not.toBeNull();
    });
    own.abort();
    expect(await outcome).toMatchObject({ info: { kind: 'aborted' } });
  });
});

describe('useStartInFolder', () => {
  it('TC-UI-02 starts a known folder with one create request and no add', async () => {
    const created = makeTerminalSession(1);
    const { api } = setup({ terminalCreateSession: () => ({ session: created }) });
    const { result } = renderHookWithProviders(() => useStartInFolder(), { api });
    let session: Awaited<ReturnType<typeof result.current.start>> | undefined;
    await act(async () => {
      session = await result.current.start('/fixture/projects/app-1', { known: true });
    });
    expect(session?.name).toBe(created.name);
    expect(api.callsTo('addFolder')).toHaveLength(0);
    expect(api.callsTo('terminalCreateSession')[0]?.body).toEqual({ path: '/fixture/projects/app-1' });
  });

  it('TC-UI-03 adds an other folder first and starts in the path the server normalised', async () => {
    const created = makeTerminalSession(7);
    const { api } = setup({
      addFolder: () => makeFolder(7, { path: '/fixture/normalised/app-7', userAdded: true }),
      terminalCreateSession: () => ({ session: created }),
    });
    const { result, queryClient } = renderHookWithProviders(() => useStartInFolder(), { api });
    queryClient.setQueryData(qk.folders(IID), makeFolderList([]));
    await act(async () => {
      await result.current.start('  /fixture/typed/app-7  ');
    });
    expect(api.callsTo('addFolder')[0]?.body).toEqual({ path: '/fixture/typed/app-7' });
    expect(api.callsTo('terminalCreateSession')[0]?.body).toEqual({ path: '/fixture/normalised/app-7' });
    expect(queryClient.getQueryState(qk.folders(IID))?.isInvalidated).toBe(true);
  });

  it('TC-UI-03 stops at a folder the server refuses: no process is started', async () => {
    const { api } = setup({
      addFolder: () => errorResponse('folder_invalid'),
      terminalCreateSession: () => ({ session: makeTerminalSession(1) }),
    });
    const { result } = renderHookWithProviders(() => useStartInFolder(), { api });
    await act(async () => {
      await expect(result.current.start('/fixture/missing')).rejects.toMatchObject({
        info: { code: 'folder_invalid' },
      });
    });
    expect(api.callsTo('terminalCreateSession')).toHaveLength(0);
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(ApiError);
    });
    act(() => {
      result.current.reset();
    });
    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
  });
});

describe('useResumeTerminalSession', () => {
  it('posts the session and the fork choice and adds the new terminal to the list', async () => {
    const created = makeLinkedTerminalSession(3);
    const { api } = setup({
      terminalState: () => makeTerminalState([created]),
      terminalResume: () => ({ session: created }),
    });
    const { result, queryClient } = renderHookWithProviders(() => useResumeTerminalSession(), { api });
    queryClient.setQueryData(qk.terminalState(IID), makeTerminalState([]));
    await act(async () => {
      await result.current.mutateAsync({ sessionId: sessionId(3), fork: true });
    });
    expect(api.callsTo('terminalResume')[0]?.body).toEqual({ sessionId: sessionId(3), fork: true });
    expect(names(queryClient.getQueryData<TerminalState>(qk.terminalState(IID)))).toContain(created.name);
    await act(async () => {
      await result.current.mutateAsync({ sessionId: sessionId(3), fork: false });
    });
    expect(api.callsTo('terminalResume')[1]?.body).toEqual({ sessionId: sessionId(3), fork: false });
  });

  it('lets each refusal reach the caller with its code', async () => {
    const { api } = setup({ terminalResume: () => errorResponse('resume_unavailable') });
    const { result } = renderHookWithProviders(() => useResumeTerminalSession(), { api });
    for (const code of ['resume_unavailable', 'session_not_found', 'terminal_limit', 'folder_invalid'] as const) {
      api.handlers.terminalResume = () => errorResponse(code);
      await act(async () => {
        await expect(result.current.mutateAsync({ sessionId: sessionId(3), fork: false })).rejects.toMatchObject({
          info: { code },
        });
      });
    }
  });
});

describe('useResumeEligibility', () => {
  it('asks nothing without a session id', async () => {
    const { api } = setup({ sessionResume: () => makeResumeEligibility(1) });
    renderHookWithProviders(() => useResumeEligibility(null), { api });
    await Promise.resolve();
    expect(api.callsTo('sessionResume')).toHaveLength(0);
  });

  it('asks the resume route of the session and gives its answer', async () => {
    const { api } = setup({ sessionResume: () => makeResumeEligibility(2, { liveElsewhere: true }) });
    const { result } = renderHookWithProviders(() => useResumeEligibility(sessionId(2)), { api });
    await waitFor(() => {
      expect(result.current.data?.liveElsewhere).toBe(true);
    });
    expect(api.callsTo('sessionResume')[0]?.params).toEqual({ sessionId: sessionId(2) });
    expect(api.callsTo('sessionResume')[0]?.method).toBe('GET');
  });

  it('asks again every time it is mounted, and never retries a refusal', async () => {
    const { api } = setup({ sessionResume: () => errorResponse('session_not_found') });
    const first = renderHookWithProviders(() => useResumeEligibility(sessionId(2)), { api });
    await waitFor(() => {
      expect(first.result.current.error).toBeInstanceOf(ApiError);
    });
    expect(api.callsTo('sessionResume')).toHaveLength(1);
    first.unmount();
    api.handlers.sessionResume = () => makeResumeEligibility(2);
    const second = renderHookWithProviders(() => useResumeEligibility(sessionId(2)), {
      api,
      queryClient: first.queryClient,
    });
    await waitFor(() => {
      expect(second.result.current.data?.allowed).toBe(true);
    });
    expect(api.callsTo('sessionResume')).toHaveLength(2);
  });
});
