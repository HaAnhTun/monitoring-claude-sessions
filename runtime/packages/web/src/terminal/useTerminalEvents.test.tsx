import type { TerminalSessionInfo, TerminalSessionsEvent, TerminalState } from '@mcs/shared';
import type { QueryClient } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { qk } from '../data/query-keys.ts';
import { createFakeApi, type FakeApi, type FakeHandlers } from '../test/fake-api.ts';
import { createFakeEventSources, type FakeEventSources } from '../test/fake-event-source.ts';
import {
  FIXTURE_EPOCH,
  FIXTURE_INSTANCE_ID,
  iso,
  makeAuthSession,
  makeInstance,
  makeTerminalSession,
  makeTerminalState,
} from '../test/fixtures/index.ts';
import { renderHookWithProviders } from '../test/render.tsx';
import type { LockManagerLike } from './events-client.ts';
import { INVALIDATE_DEBOUNCE_MS, useTerminalEvents, type TerminalEventsEnvironment } from './useTerminalEvents.ts';

const IID = FIXTURE_INSTANCE_ID;
const NEW_EPOCH = 'ffeeddcc';
const EVENTS_PATH = '/api/v3/terminal/events';

afterEach(() => {
  vi.useRealTimers();
});

interface Setup {
  sources: FakeEventSources;
  api: FakeApi;
  win: EventTarget;
  /** `true` while the fake session route says the browser holds the cookie. */
  session: { authenticated: boolean };
}

function fakeSetup(handlers: FakeHandlers = {}): Setup {
  const session = { authenticated: true };
  const api = createFakeApi({
    instance: () => makeInstance(),
    authSession: () => makeAuthSession(session.authenticated),
    ...handlers,
  });
  return { sources: createFakeEventSources(), api, win: new EventTarget(), session };
}

function environmentOf(s: Setup, over: TerminalEventsEnvironment = {}): TerminalEventsEnvironment {
  return { esFactory: s.sources.factory, locks: null, visibility: null, windowTarget: s.win, ...over };
}

function strict(children: ReactNode): ReactNode {
  return <StrictMode>{children}</StrictMode>;
}

function sessionsEvent(version: number, sessions: TerminalSessionInfo[]): TerminalSessionsEvent {
  return { version, sessions };
}

function helloOf(epoch: string = FIXTURE_EPOCH) {
  return { instanceId: IID, epoch, serverTime: iso(0), heartbeatMs: 15_000 };
}

/** Mounts the hook with a seeded terminal state (the page had loaded it) and returns what a test needs. */
function mount(
  s: Setup,
  options: {
    seed?: TerminalState | null;
    env?: TerminalEventsEnvironment;
    wrap?: (children: ReactNode) => ReactNode;
  } = {},
) {
  const rendered = renderHookWithProviders(
    (props: { enabled: boolean }) =>
      useTerminalEvents({ enabled: props.enabled, environment: options.env ?? environmentOf(s) }),
    {
      api: s.api,
      initialProps: { enabled: true },
      ...(options.wrap === undefined ? {} : { wrap: options.wrap }),
    },
  );
  const seed = options.seed === undefined ? makeTerminalState([makeTerminalSession(1)]) : options.seed;
  if (seed !== null) rendered.queryClient.setQueryData(qk.terminalState(IID), seed);
  return rendered;
}

function stateOf(queryClient: QueryClient): TerminalState | undefined {
  return queryClient.getQueryData<TerminalState>(qk.terminalState(IID));
}

function namesOf(state: TerminalState | undefined): string[] {
  return state?.sessions.map((session) => session.name) ?? [];
}

describe('opening and closing', () => {
  it('opens one stream at the events path while enabled and none while disabled', () => {
    const s = fakeSetup();
    const { result, rerender, unmount } = mount(s);
    expect(s.sources.urls()).toEqual([EVENTS_PATH]);
    expect(result.current.status).toBe('connecting');
    rerender({ enabled: false });
    expect(s.sources.last().closed).toBe(true);
    expect(result.current.status).toBe('idle');
    rerender({ enabled: true });
    expect(s.sources.instances).toHaveLength(2);
    expect(s.sources.last().closed).toBe(false);
    unmount();
    expect(s.sources.last().closed).toBe(true);
  });

  it('opens nothing at all when it starts disabled', () => {
    const s = fakeSetup();
    const { result } = renderHookWithProviders(
      () => useTerminalEvents({ enabled: false, environment: environmentOf(s) }),
      { api: s.api },
    );
    expect(s.sources.instances).toHaveLength(0);
    expect(result.current.status).toBe('idle');
  });

  it('reports the status of the stream: connecting, open, backoff', () => {
    const s = fakeSetup();
    const { result, unmount } = mount(s);
    expect(result.current.status).toBe('connecting');
    act(() => {
      s.sources.last().open();
    });
    expect(result.current.status).toBe('open');
    act(() => {
      s.sources.last().fail();
    });
    expect(result.current.status).toBe('backoff');
    unmount();
  });

  it('survives StrictMode: one source stays open', () => {
    const s = fakeSetup();
    const { unmount } = mount(s, { wrap: strict });
    const open = s.sources.instances.filter((source) => !source.closed);
    expect(open).toHaveLength(1);
    unmount();
    expect(s.sources.instances.every((source) => source.closed)).toBe(true);
  });

  it('honours an injected lock manager: it asks for the lock and opens no source until it holds it', () => {
    const s = fakeSetup();
    const requested: string[] = [];
    const locks: LockManagerLike = {
      request: (name) => {
        requested.push(name);
        return new Promise<void>(() => undefined);
      },
    };
    const { result, unmount } = mount(s, { env: environmentOf(s, { locks }) });
    expect(requested).toEqual(['caw-terminal-events']);
    expect(s.sources.instances).toHaveLength(0);
    expect(result.current.status).toBe('waiting');
    unmount();
  });
});

describe('patches the terminal state', () => {
  it('replaces the sessions of the cached state with the list of the frame and keeps the rest', () => {
    const s = fakeSetup();
    const seed = makeTerminalState([makeTerminalSession(1)]);
    const { queryClient, unmount } = mount(s, { seed });
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('hello', helloOf());
      s.sources.last().emit('sessions', sessionsEvent(1, [makeTerminalSession(1), makeTerminalSession(2)]));
    });
    const state = stateOf(queryClient);
    expect(namesOf(state)).toEqual(['fixture-term-1', 'fixture-term-2']);
    expect(state?.capabilities).toEqual(seed.capabilities);
    expect(state?.epoch).toBe(seed.epoch);
    expect(state?.generatedAt).toBe(seed.generatedAt);
    unmount();
  });

  it('latest wins by version: an older list does not overwrite a newer one', () => {
    const s = fakeSetup();
    const { queryClient, unmount } = mount(s);
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('hello', helloOf());
      s.sources
        .last()
        .emit('sessions', sessionsEvent(5, [makeTerminalSession(1), makeTerminalSession(2), makeTerminalSession(3)]));
      s.sources.last().emit('sessions', sessionsEvent(4, [makeTerminalSession(1)]));
    });
    expect(namesOf(stateOf(queryClient))).toEqual(['fixture-term-1', 'fixture-term-2', 'fixture-term-3']);
    unmount();
  });

  it('does not invent a terminal state that was never loaded (it has no capabilities to give)', () => {
    const s = fakeSetup();
    const { queryClient, unmount } = mount(s, { seed: null });
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('hello', helloOf());
      s.sources.last().emit('sessions', sessionsEvent(1, [makeTerminalSession(1)]));
    });
    expect(queryClient.getQueryData(qk.terminalState(IID))).toBeUndefined();
    unmount();
  });

  it('writes under the key of its own instance only', () => {
    const s = fakeSetup();
    const other = '22222222-2222-4222-8222-222222222222';
    const { queryClient, unmount } = mount(s);
    queryClient.setQueryData(qk.terminalState(other), makeTerminalState([makeTerminalSession(7)]));
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('sessions', sessionsEvent(1, []));
    });
    expect(namesOf(stateOf(queryClient))).toEqual([]);
    expect(queryClient.getQueryData<TerminalState>(qk.terminalState(other))?.sessions).toHaveLength(1);
    unmount();
  });
});

describe('debounced invalidation when the set of names changes', () => {
  function spyOnInvalidate(queryClient: QueryClient) {
    return vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  }

  /** The `queryKey` of every `invalidateQueries` call, as text. */
  function invalidatedKeys(spy: ReturnType<typeof spyOnInvalidate>): string[] {
    return spy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
  }

  it('invalidates the terminal state and the folders 800 ms after a session appeared, not before', () => {
    vi.useFakeTimers();
    const s = fakeSetup();
    const { queryClient, unmount } = mount(s);
    const spy = spyOnInvalidate(queryClient);
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('hello', helloOf());
      s.sources.last().emit('sessions', sessionsEvent(1, [makeTerminalSession(1), makeTerminalSession(2)]));
    });
    expect(INVALIDATE_DEBOUNCE_MS).toBe(800);
    act(() => {
      vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS - 1);
    });
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(invalidatedKeys(spy).sort()).toEqual(
      [JSON.stringify(qk.folders(IID)), JSON.stringify(qk.terminalState(IID))].sort(),
    );
    unmount();
  });

  it('turns a burst of changes into one invalidation after the last one (trailing debounce)', () => {
    vi.useFakeTimers();
    const s = fakeSetup();
    const { queryClient, unmount } = mount(s);
    const spy = spyOnInvalidate(queryClient);
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('sessions', sessionsEvent(1, [makeTerminalSession(1), makeTerminalSession(2)]));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      s.sources.last().emit('sessions', sessionsEvent(2, [makeTerminalSession(1)]));
    });
    act(() => {
      vi.advanceTimersByTime(799);
    });
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('invalidates when a session left the list as well', () => {
    vi.useFakeTimers();
    const s = fakeSetup();
    const { queryClient, unmount } = mount(s, {
      seed: makeTerminalState([makeTerminalSession(1), makeTerminalSession(2)]),
    });
    const spy = spyOnInvalidate(queryClient);
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('sessions', sessionsEvent(1, [makeTerminalSession(1)]));
      vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not invalidate when only the details of the sessions changed (viewers, size)', () => {
    vi.useFakeTimers();
    const s = fakeSetup();
    const { queryClient, unmount } = mount(s, { seed: makeTerminalState([makeTerminalSession(1)]) });
    const spy = spyOnInvalidate(queryClient);
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('sessions', sessionsEvent(1, [makeTerminalSession(1, { viewers: 3, cols: 90 })]));
      vi.advanceTimersByTime(5000);
    });
    expect(spy).not.toHaveBeenCalled();
    expect(stateOf(queryClient)?.sessions[0]?.viewers).toBe(3);
    unmount();
  });

  it('drops a pending invalidation when it unmounts', () => {
    vi.useFakeTimers();
    const s = fakeSetup();
    const { queryClient, unmount } = mount(s);
    const spy = spyOnInvalidate(queryClient);
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('sessions', sessionsEvent(1, [makeTerminalSession(1), makeTerminalSession(2)]));
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('a new epoch', () => {
  it('invalidates everything of the instance, and the first hello does not', () => {
    const s = fakeSetup();
    const { queryClient, unmount } = mount(s);
    const spy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('hello', helloOf());
    });
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      s.sources.last().fail();
      s.win.dispatchEvent(new Event('online'));
    });
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('hello', helloOf(NEW_EPOCH));
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.root(IID) });
    unmount();
  });

  it('takes the first list of the restarted server even though its version is lower', () => {
    const s = fakeSetup();
    const { queryClient, unmount } = mount(s);
    vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('hello', helloOf());
      s.sources.last().emit('sessions', sessionsEvent(57, [makeTerminalSession(1), makeTerminalSession(2)]));
      s.sources.last().fail();
      s.win.dispatchEvent(new Event('online'));
    });
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('hello', helloOf(NEW_EPOCH));
      s.sources.last().emit('sessions', sessionsEvent(1, []));
    });
    expect(namesOf(stateOf(queryClient))).toEqual([]);
    unmount();
  });
});

describe('another instance on the address', () => {
  it('stops the stream and never patches the cache of this instance with its list', () => {
    const s = fakeSetup();
    const { queryClient, result, unmount } = mount(s);
    act(() => {
      s.sources.last().open();
      s.sources.last().emit('hello', { ...helloOf(), instanceId: '33333333-3333-4333-8333-333333333333' });
      s.sources.last().emit('sessions', sessionsEvent(1, []), { force: true });
    });
    expect(result.current.status).toBe('stopped');
    expect(namesOf(stateOf(queryClient))).toEqual(['fixture-term-1']);
    unmount();
  });
});

describe('TC-UI-10: the credential is gone', () => {
  it('locks the page when the stream fails and the session route says the browser has no cookie', async () => {
    const s = fakeSetup();
    const { queryClient, result, unmount } = mount(s);
    queryClient.setQueryData(qk.authSession(IID), { authenticated: true });
    act(() => {
      s.sources.last().open();
    });
    s.session.authenticated = false;
    act(() => {
      s.sources.last().fail();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('revoked');
    });
    expect(queryClient.getQueryData(qk.authSession(IID))).toEqual({ authenticated: false });
    expect(s.api.callsTo('authSession').length).toBeGreaterThanOrEqual(1);
    expect(s.sources.instances).toHaveLength(1);
    unmount();
  });

  it('keeps retrying when the session route says the cookie is still there', async () => {
    const s = fakeSetup();
    const { queryClient, result, unmount } = mount(s);
    queryClient.setQueryData(qk.authSession(IID), { authenticated: true });
    act(() => {
      s.sources.last().open();
      s.sources.last().fail();
    });
    await waitFor(() => {
      expect(s.api.callsTo('authSession')).toHaveLength(1);
    });
    expect(result.current.status).toBe('backoff');
    expect(queryClient.getQueryData(qk.authSession(IID))).toEqual({ authenticated: true });
    act(() => {
      s.win.dispatchEvent(new Event('online'));
    });
    expect(s.sources.instances).toHaveLength(2);
    unmount();
  });

  it('starts again with a fresh client when it is enabled again after the page was unlocked', async () => {
    const s = fakeSetup();
    const { result, rerender, unmount } = mount(s);
    act(() => {
      s.sources.last().open();
    });
    s.session.authenticated = false;
    act(() => {
      s.sources.last().fail();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('revoked');
    });
    rerender({ enabled: false });
    s.session.authenticated = true;
    rerender({ enabled: true });
    expect(s.sources.instances).toHaveLength(2);
    expect(result.current.status).toBe('connecting');
    unmount();
  });
});
