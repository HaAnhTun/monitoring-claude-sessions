import { routes } from '@mcs/shared';
import { useMutation, useQuery, type QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import { useContext, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { msg } from '../../test/msg.ts';
import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import {
  accessCode,
  FIXTURE_INSTANCE_ID,
  makeAuthSession,
  makeExchangeResponse,
  makeFolder,
  makeFolderList,
  makeInstance,
  makeLogoutResponse,
  makeResumeEligibility,
  makeSession,
  makeSessionPage,
  makeTerminalSession,
  makeTerminalState,
} from '../../test/fixtures/index.ts';
import { renderHookWithProviders } from '../../test/render.tsx';
import { createPrefs } from '../../lib/prefs.ts';
import { AnnouncerProvider } from '../../state/announcer.tsx';
import { createPrefsStore, type PrefsStore } from '../../state/prefs-store.ts';
import { ApiError } from '../api-errors.ts';
import { qk } from '../query-keys.ts';
import { AccessFlowContext, markLocked, useAuthSession, useCreateAccessFlow, useLogout } from './useAuth.ts';
import { useApi, useIid } from './useInstance.ts';

const IID = FIXTURE_INSTANCE_ID;
const OTHER_IID = '22222222-2222-4222-8222-222222222222';
const CODE = accessCode(1);

function fakeApi(handlers: FakeHandlers = {}): FakeApi {
  return createFakeApi({ instance: () => makeInstance(), ...handlers });
}

function announcer(children: ReactNode): ReactNode {
  return <AnnouncerProvider>{children}</AnnouncerProvider>;
}

/** What a storage holds, keys and values, as one text (a spread of `Storage` would lose its class). */
function storageText(storage: Storage): string {
  const parts: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) parts.push(key, storage.getItem(key) ?? '');
  }
  return parts.join('|');
}

function authOf(queryClient: QueryClient, iid = IID): unknown {
  return queryClient.getQueryData(qk.authSession(iid));
}

describe('useAuthSession', () => {
  it('asks the open session route once and keeps the answer until something says otherwise', async () => {
    const api = fakeApi({ authSession: () => makeAuthSession(true) });
    const { result, queryClient, unmount } = renderHookWithProviders(() => useAuthSession(), { api });
    await waitFor(() => {
      expect(result.current.data).toEqual({ authenticated: true });
    });
    unmount();
    const again = renderHookWithProviders(() => useAuthSession(), { api, queryClient });
    expect(again.result.current.data).toEqual({ authenticated: true });
    await Promise.resolve();
    expect(api.callsTo('authSession')).toHaveLength(1);
    expect(api.callsTo('authSession')[0]?.method).toBe('GET');
    expect(api.violations).toEqual([]);
  });

  it('reports a failed read as an error and not as locked', async () => {
    const api = fakeApi({ authSession: () => errorResponse('internal_error') });
    const { result } = renderHookWithProviders(() => useAuthSession(), { api });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(ApiError);
    });
    expect(result.current.data).toBeUndefined();
  });
});

describe('markLocked', () => {
  it('sets the session of that instance to not authenticated and touches no other entry', () => {
    const { queryClient } = renderHookWithProviders(() => undefined);
    queryClient.setQueryData(qk.authSession(IID), { authenticated: true });
    queryClient.setQueryData(qk.authSession(OTHER_IID), { authenticated: true });
    queryClient.setQueryData(qk.terminalState(IID), makeTerminalState());
    markLocked(queryClient, IID);
    expect(authOf(queryClient)).toEqual({ authenticated: false });
    expect(authOf(queryClient, OTHER_IID)).toEqual({ authenticated: true });
    expect(queryClient.getQueryData(qk.terminalState(IID))).toEqual(makeTerminalState());
  });

  it('is idempotent and also works when the session was never read', () => {
    const { queryClient } = renderHookWithProviders(() => undefined);
    markLocked(queryClient, IID);
    const first = authOf(queryClient);
    markLocked(queryClient, IID);
    expect(first).toEqual({ authenticated: false });
    expect(authOf(queryClient)).toBe(first);
  });
});

describe('TC-UI-10: a 401 locks the terminal area', () => {
  /** Mounts the auth session and one more query that answers `code`; the answer arrives while the session says yes. */
  function lockedBy(handlers: FakeHandlers) {
    const api = fakeApi({ authSession: () => makeAuthSession(true), ...handlers });
    return renderHookWithProviders(
      () => {
        const auth = useAuthSession();
        const iid = useIid();
        const client = useApi();
        const state = useQuery({
          queryKey: qk.terminalState(iid),
          queryFn: ({ signal }) =>
            client.get('terminalState', routes.terminalState.path, routes.terminalState.response, { signal }),
        });
        return { auth, state };
      },
      { api },
    );
  }

  it('turns the session to not authenticated when a session route answers access_required', async () => {
    const { result } = lockedBy({ terminalState: () => errorResponse('access_required') });
    await waitFor(() => {
      expect(result.current.state.error).toBeInstanceOf(ApiError);
    });
    await waitFor(() => {
      expect(result.current.auth.data).toEqual({ authenticated: false });
    });
  });

  it('does the same for a write that is refused for the same reason', async () => {
    const api = fakeApi({
      authSession: () => makeAuthSession(true),
      terminalKillSession: () => errorResponse('access_required'),
    });
    const { result } = renderHookWithProviders(
      () => {
        const auth = useAuthSession();
        const client = useApi();
        const kill = useMutation({
          mutationFn: () =>
            client.post(
              'terminalKillSession',
              '/api/v3/terminal/sessions/fixture-term-1/kill',
              {},
              routes.terminalKillSession.response,
            ),
        });
        return { auth, kill };
      },
      { api },
    );
    await waitFor(() => {
      expect(result.current.auth.data).toEqual({ authenticated: true });
    });
    await act(async () => {
      await result.current.kill.mutateAsync().catch(() => undefined);
    });
    await waitFor(() => {
      expect(result.current.auth.data).toEqual({ authenticated: false });
    });
  });

  it('keeps the session for every other failure', async () => {
    for (const code of ['terminal_unavailable', 'internal_error', 'access_rate_limited'] as const) {
      const { result, unmount } = lockedBy({ terminalState: () => errorResponse(code) });
      await waitFor(() => {
        expect(result.current.state.error).toBeInstanceOf(ApiError);
      });
      expect(result.current.auth.data, code).toEqual({ authenticated: true });
      unmount();
    }
  });
});

describe('useLogout', () => {
  function prefsWith(lastTerminal: string): PrefsStore {
    const store = createPrefsStore(createPrefs(null));
    store.setPref('lastTerminal', lastTerminal);
    return store;
  }

  function logoutHook(api: FakeApi, prefsStore: PrefsStore) {
    return renderHookWithProviders(() => useLogout(), { api, prefsStore, wrap: announcer });
  }

  function fill(queryClient: QueryClient) {
    queryClient.setQueryData(qk.authSession(IID), { authenticated: true });
    queryClient.setQueryData(qk.terminalState(IID), makeTerminalState());
    queryClient.setQueryData(qk.folders(IID), makeFolderList());
    queryClient.setQueryData(qk.resumeEligibility(IID, 'sid-1'), makeResumeEligibility(1));
    queryClient.setQueryData(qk.sessions(IID, {}), makeSessionPage([makeSession()]));
    queryClient.setQueryData(qk.health(IID), { kept: true });
    queryClient.setQueryData(qk.terminalState(OTHER_IID), makeTerminalState());
  }

  it('posts the logout with the header and an empty body, then locks the page', async () => {
    const api = fakeApi({ authLogout: () => makeLogoutResponse() });
    const prefsStore = prefsWith('fixture-term-1');
    const { result, queryClient } = logoutHook(api, prefsStore);
    fill(queryClient);
    await act(async () => {
      await result.current();
    });
    const [call] = api.callsTo('authLogout');
    expect(call).toMatchObject({ method: 'POST', body: {} });
    expect(call?.headers['x-mcs-request']).toBe('1');
    expect(authOf(queryClient)).toEqual({ authenticated: false });
    expect(api.violations).toEqual([]);
  });

  it('removes the terminal state, the folders and the resume answers of the instance, and nothing else', async () => {
    const api = fakeApi({ authLogout: () => makeLogoutResponse() });
    const { result, queryClient } = logoutHook(api, prefsWith('fixture-term-1'));
    fill(queryClient);
    await act(async () => {
      await result.current();
    });
    expect(queryClient.getQueryData(qk.terminalState(IID))).toBeUndefined();
    expect(queryClient.getQueryData(qk.folders(IID))).toBeUndefined();
    expect(queryClient.getQueryData(qk.resumeEligibility(IID, 'sid-1'))).toBeUndefined();
    expect(queryClient.getQueryData(qk.sessions(IID, {}))).toBeDefined();
    expect(queryClient.getQueryData(qk.health(IID))).toEqual({ kept: true });
    expect(queryClient.getQueryData(qk.terminalState(OTHER_IID))).toBeDefined();
  });

  it('clears the last selected terminal and announces that the terminals are locked', async () => {
    const api = fakeApi({ authLogout: () => makeLogoutResponse() });
    const prefsStore = prefsWith('fixture-term-1');
    const { result } = logoutHook(api, prefsStore);
    await act(async () => {
      await result.current();
    });
    expect(prefsStore.getSnapshot().lastTerminal).toBe('');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(msg('access.lockedAnnounce'));
    });
  });

  it('forgets what the person has seen in the attention center, and keeps it when the logout failed', async () => {
    const seen = { 'fixture-session': '2026-01-01T00:00:00.000Z' };
    for (const [answer, expected] of [
      [() => makeLogoutResponse(), {}],
      [() => errorResponse('internal_error'), seen],
    ] as const) {
      const prefsStore = prefsWith('fixture-term-1');
      prefsStore.setPref('attentionSeen', seen);
      const { result, unmount } = logoutHook(fakeApi({ authLogout: answer }), prefsStore);
      await act(async () => {
        await result.current().catch(() => undefined);
      });
      expect(prefsStore.getSnapshot().attentionSeen).toEqual(expected);
      unmount();
    }
  });

  it('keeps everything when the server could not be reached, and says why', async () => {
    const api = fakeApi({ authLogout: () => errorResponse('internal_error') });
    const prefsStore = prefsWith('fixture-term-1');
    const { result, queryClient } = logoutHook(api, prefsStore);
    fill(queryClient);
    let failure: unknown;
    await act(async () => {
      failure = await result.current().catch((error: unknown) => error);
    });
    expect(failure).toBeInstanceOf(ApiError);
    expect(api.callsTo('authLogout')).toHaveLength(1);
    expect(authOf(queryClient)).toEqual({ authenticated: true });
    expect(queryClient.getQueryData(qk.terminalState(IID))).toBeDefined();
    expect(prefsStore.getSnapshot().lastTerminal).toBe('fixture-term-1');
  });

  it('finishes the lock when the session had already ended (the logout answers access_required)', async () => {
    const api = fakeApi({ authLogout: () => errorResponse('access_required') });
    const prefsStore = prefsWith('fixture-term-1');
    const { result, queryClient } = logoutHook(api, prefsStore);
    fill(queryClient);
    await act(async () => {
      await result.current();
    });
    expect(authOf(queryClient)).toEqual({ authenticated: false });
    expect(queryClient.getQueryData(qk.terminalState(IID))).toBeUndefined();
    expect(prefsStore.getSnapshot().lastTerminal).toBe('');
  });

  it('works when no terminal was ever selected', async () => {
    const api = fakeApi({ authLogout: () => makeLogoutResponse() });
    const prefsStore = createPrefsStore(createPrefs(null));
    const { result } = logoutHook(api, prefsStore);
    await act(async () => {
      await result.current();
    });
    expect(prefsStore.getSnapshot().lastTerminal).toBe('');
  });
});

describe('useCreateAccessFlow and AccessFlowContext (the real deps of the flow)', () => {
  function flowHook(api: FakeApi) {
    return renderHookWithProviders(() => useCreateAccessFlow(), { api });
  }

  it('exchanges the code in the body of a POST, re-reads the session and unlocks the terminal queries', async () => {
    let authenticated = false;
    const api = fakeApi({
      authSession: () => makeAuthSession(authenticated),
      authExchange: () => {
        authenticated = true;
        return makeExchangeResponse();
      },
    });
    const { result, queryClient } = flowHook(api);
    queryClient.setQueryData(qk.terminalState(IID), makeTerminalState());
    queryClient.setQueryData(qk.folders(IID), makeFolderList());
    queryClient.setQueryData(qk.authSession(IID), { authenticated: false });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.submit(CODE);
    });
    expect(outcome).toEqual({ kind: 'granted' });
    const [exchange] = api.callsTo('authExchange');
    expect(exchange).toMatchObject({ method: 'POST', body: { code: CODE } });
    expect(exchange?.headers['x-mcs-request']).toBe('1');
    expect(exchange?.url).not.toContain(CODE);
    expect(authOf(queryClient)).toEqual({ authenticated: true });
    expect(queryClient.getQueryState(qk.terminalState(IID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(qk.folders(IID))?.isInvalidated).toBe(true);
    expect(api.violations).toEqual([]);
  });

  it('is cookie-not-kept when the session is still not authenticated after the exchange', async () => {
    const api = fakeApi({ authSession: () => makeAuthSession(false), authExchange: () => makeExchangeResponse() });
    const { result, queryClient } = flowHook(api);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.submit(CODE);
    });
    expect(outcome).toEqual({ kind: 'cookie-not-kept' });
    expect(authOf(queryClient)).toEqual({ authenticated: false });
  });

  it('is invalid for access_code_invalid and does not read the session again', async () => {
    const api = fakeApi({
      authSession: () => makeAuthSession(false),
      authExchange: () => errorResponse('access_code_invalid'),
    });
    const { result } = flowHook(api);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.submit(CODE);
    });
    expect(outcome).toEqual({ kind: 'invalid' });
    expect(api.callsTo('authSession')).toHaveLength(0);
  });

  it('is rate-limited with the Retry-After of the answer, and is sent once, not retried', async () => {
    const api = fakeApi({
      authExchange: () => errorResponse('access_rate_limited', 'slow down', { retryAfterSeconds: 7 }),
    });
    const { result } = flowHook(api);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.submit(CODE);
    });
    expect(outcome).toEqual({ kind: 'rate-limited', retryAfterMs: 7000 });
    expect(api.callsTo('authExchange')).toHaveLength(1);
  });

  it('is failed for a server error, with the error', async () => {
    const api = fakeApi({ authExchange: () => errorResponse('internal_error') });
    const { result } = flowHook(api);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.submit(CODE);
    });
    expect(outcome).toMatchObject({ kind: 'failed', error: { info: { status: 500 } } });
  });

  it('gives the same flow to every render and shares it through the context', () => {
    const api = fakeApi();
    const { result, rerender } = renderHookWithProviders(
      () => ({ made: useCreateAccessFlow(), provided: useContext(AccessFlowContext) }),
      { api },
    );
    const first = result.current.made;
    rerender();
    expect(result.current.made).toBe(first);
    expect(result.current.provided).toBeNull();
    const { result: inside } = renderHookWithProviders(() => useContext(AccessFlowContext), {
      api,
      wrap: (children) => <AccessFlowContext value={first}>{children}</AccessFlowContext>,
    });
    expect(inside.current).toBe(first);
  });

  it('never leaves the code in a query key, a mutation, web storage or the address of any request', async () => {
    const api = fakeApi({ authSession: () => makeAuthSession(true), authExchange: () => makeExchangeResponse() });
    const { result, queryClient } = flowHook(api);
    await act(async () => {
      await result.current.submit(CODE);
    });
    const cache = JSON.stringify([
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => [query.queryKey, query.queryHash, query.state.data]),
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
    ]);
    expect(cache).not.toContain(CODE);
    expect(storageText(window.localStorage)).not.toContain(CODE);
    expect(storageText(window.sessionStorage)).not.toContain(CODE);
    expect(api.calls.map((call) => call.url).join('\n')).not.toContain(CODE);
    expect(api.calls.flatMap((call) => [...call.query.values()]).join('\n')).not.toContain(CODE);
  });
});

describe('the fake API writes the way the server does', () => {
  const create = { path: 'FIXTURE-folder' };

  function post(api: FakeApi, path: string, body: unknown, headers: Record<string, string> = { 'X-MCS-Request': '1' }) {
    return api.fetchImpl(path, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  it('hands the parsed body and the method to the handler', async () => {
    const seen: { method: string; body: unknown }[] = [];
    const api = fakeApi({
      terminalCreateSession: (_query, request) => {
        seen.push({ method: request.method, body: request.body });
        return { session: makeTerminalSession(1) };
      },
    });
    await post(api, '/api/v3/terminal/sessions', create);
    expect(seen).toEqual([{ method: 'POST', body: create }]);
    expect(api.callsTo('terminalCreateSession')[0]).toMatchObject({ method: 'POST', body: create });
  });

  it('answers csrf_rejected to a write without the header, before any handler runs', async () => {
    let ran = false;
    const api = fakeApi({
      authLogout: () => {
        ran = true;
        return makeLogoutResponse();
      },
    });
    const response = await post(api, '/api/v3/auth/logout', {}, {});
    expect(response.status).toBe(403);
    expect(ran).toBe(false);
  });

  it('answers validation_failed to a body that breaks the route schema and records a violation', async () => {
    const api = fakeApi({ authExchange: () => makeExchangeResponse() });
    const response = await post(api, '/api/v3/auth/exchange', { code: 'too short' });
    expect(response.status).toBe(400);
    expect(api.violations).toHaveLength(1);
    expect(api.violations[0]).toContain('authExchange');
    expect(api.violations[0]).not.toContain('too short');
  });

  it('answers body_invalid_json to a body that is not JSON', async () => {
    const api = fakeApi({ authLogout: () => makeLogoutResponse() });
    const response = await api.fetchImpl('/api/v3/auth/logout', {
      method: 'POST',
      headers: { 'X-MCS-Request': '1' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
  });

  it('matches by method as well as path: the same /folders path is a read and a write', async () => {
    const api = fakeApi({ listFolders: () => makeFolderList(), addFolder: () => makeFolder(1) });
    expect((await api.fetchImpl('/api/v3/folders')).status).toBe(200);
    expect(api.callsTo('listFolders')).toHaveLength(1);
    expect(api.callsTo('addFolder')).toHaveLength(0);
    const wrong = await api.fetchImpl('/api/v3/auth/logout');
    expect(wrong.status).toBe(405);
  });
});
