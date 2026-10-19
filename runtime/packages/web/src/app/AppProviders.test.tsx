import type { SessionSummary, StreamChange, StreamHello } from '@mcs/shared';
import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocation } from 'react-router';

import { useHealth } from '../data/hooks/useHealth.ts';
import { InstanceIdContext, useApi, useInstance } from '../data/hooks/useInstance.ts';
import { createFakeApi, type FakeApi } from '../test/fake-api.ts';
import { createFakeEventSources, type FakeEventSources } from '../test/fake-event-source.ts';
import { iso, makeHealth, makeInstance, makeSession, makeSessionPage, sessionId } from '../test/fixtures/index.ts';
import { msg } from '../test/msg.ts';
import { createPrefs } from '../lib/prefs.ts';
import { createPrefsStore, PrefsStoreContext } from '../state/prefs-store.ts';
import { useFreshness } from '../stream/useFreshness.ts';
import { App } from './App.tsx';
import { AppProviders } from './AppProviders.tsx';

function Probe() {
  const client = useQueryClient();
  const { pathname } = useLocation();
  return (
    <output data-testid="probe">
      {pathname} {String(client.getDefaultOptions().queries?.throwOnError)}
    </output>
  );
}

function ApiProbe() {
  return <output data-testid="api">{typeof useApi().get}</output>;
}

function Boom(): never {
  throw new Error('shell exploded');
}

let sources: FakeEventSources;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // The app opens its stream as soon as the instance is known; happy-dom has no EventSource, so every test gets the scripted one.
  // The provider asks for GET /instance as soon as it mounts; tests that do not care about the API get this one, not the network.
  vi.stubGlobal('fetch', createFakeApi({ instance: () => makeInstance() }).fetchImpl);
  sources = createFakeEventSources();
  vi.stubGlobal(
    'EventSource',
    vi.fn(function (url: string) {
      return sources.factory(url);
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('AppProviders', () => {
  it('provides a router and a query client that never throws query errors into boundaries', () => {
    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('/ false');
  });

  it('uses the query client it is given', () => {
    const client = new QueryClient({ defaultOptions: { queries: { throwOnError: true } } });
    render(
      <AppProviders queryClient={client}>
        <Probe />
      </AppProviders>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('true');
  });

  it('shows the full-page fallback with Reload page when the shell crashes', () => {
    render(
      <AppProviders>
        <Boom />
      </AppProviders>,
    );
    expect(screen.getByText(msg('common.viewFailed'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('common.reloadPage') })).toBeInTheDocument();
  });

  it('translates the crash fallback without any language context, from the stored language', async () => {
    const prefsStore = createPrefsStore(createPrefs(null));
    prefsStore.setPref('locale', 'vi');
    render(
      <PrefsStoreContext value={prefsStore}>
        <AppProviders>
          <Boom />
        </AppProviders>
      </PrefsStoreContext>,
    );
    // The fallback sits above the language provider: it fetches the Vietnamese catalogue itself.
    expect(await screen.findByText(msg('common.viewFailed', undefined, 'vi'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: msg('common.reloadPage', undefined, 'vi') })).toBeInTheDocument();
    expect(screen.queryByText(msg('common.viewFailed'))).toBeNull();
  });

  it('reloads the page from the fallback button', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    render(
      <AppProviders>
        <Boom />
      </AppProviders>,
    );
    fireEvent.click(screen.getByRole('button', { name: msg('common.reloadPage') }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('sets the page language from the stored choice and draws the app in it', async () => {
    const prefsStore = createPrefsStore(createPrefs(null));
    prefsStore.setPref('locale', 'vi');
    render(
      <PrefsStoreContext value={prefsStore}>
        <AppProviders>
          <Probe />
        </AppProviders>
      </PrefsStoreContext>,
    );
    expect(await screen.findByTestId('probe')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('vi');
  });

  it('provides the API client to the data hooks', () => {
    render(
      <AppProviders>
        <ApiProbe />
      </AppProviders>,
    );
    expect(screen.getByTestId('api')).toHaveTextContent('function');
  });

  it('loads and renders the sessions list in the real app, through the global fetch and the same origin', async () => {
    const instance = makeInstance();
    const api = createFakeApi({
      instance: () => instance,
      health: () => makeHealth('ok'),
      listSessions: () =>
        makeSessionPage([makeSession({ id: sessionId(1), seq: 1, label: 'FIXTURE wired session' })], { total: 1 }),
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    window.history.replaceState(null, '', '/sessions');
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    );
    expect((await screen.findAllByText('FIXTURE wired session')).length).toBeGreaterThan(0);
    expect(api.callsTo('listSessions').length).toBeGreaterThan(0);
    expect(api.violations).toEqual([]);
    for (const call of api.calls) expect(call.url).toMatch(/^\/api\/v3\//);
  });
});

// LF-7: the built app mounts the real stream provider. The browser `EventSource` is replaced by the scripted one of the stream
// tests, the rest is the real app (providers, routes, shell, data hooks, reconciler) on the global `fetch` of a fake API.
describe('AppProviders with the realtime stream', () => {
  const instance = makeInstance();
  const ROW_A = sessionId(1);
  const ROW_B = sessionId(2);
  let sessions: SessionSummary[];
  let api: FakeApi;
  let healthMode: 'ok' | 'degraded';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    healthMode = 'ok';
    sessions = [makeSession({ id: ROW_A, seq: 1, label: 'FIXTURE first session' })];
    api = createFakeApi({
      instance: () => instance,
      health: () =>
        healthMode === 'ok'
          ? makeHealth('ok')
          : makeHealth('degraded', {
              ingestion: { ...makeHealth('degraded').ingestion, status: 'degraded', reasons: ['FIXTURE reason'] },
            }),
      listSessions: () => makeSessionPage([...sessions], { total: sessions.length }),
    });
    vi.stubGlobal('fetch', api.fetchImpl);
    window.history.replaceState(null, '', '/sessions');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush(ms = 0): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  function hello(): StreamHello {
    return {
      instanceId: instance.instanceId,
      epoch: instance.epoch,
      headSeq: instance.headSeq,
      heartbeatMs: instance.heartbeatMs,
      serverTime: iso(0),
      runtimeVersion: instance.runtimeVersion,
      codeStamp: instance.codeStamp,
    };
  }

  function sessionChange(seq: number, data: SessionSummary): StreamChange {
    return {
      seq,
      at: iso(0),
      instanceId: instance.instanceId,
      kind: 'session',
      op: 'upsert',
      sessionId: data.id,
      data,
    };
  }

  function Freshness() {
    const id = useInstance().data?.instanceId ?? null;
    return id === null ? null : (
      <InstanceIdContext value={id}>
        <FreshnessReadout />
      </InstanceIdContext>
    );
  }

  function FreshnessReadout() {
    useHealth();
    const { connection, ingestion } = useFreshness();
    return <output data-testid="freshness">{`${connection.state}|${ingestion.display}`}</output>;
  }

  async function mount(): Promise<void> {
    render(
      <AppProviders>
        <Freshness />
        <App />
      </AppProviders>,
    );
    await flush(50);
  }

  async function openStream(): Promise<void> {
    act(() => {
      sources.last().open();
      sources.last().emit('hello', hello());
    });
    await flush(0);
  }

  /** The text is on screen after the pending fetches and renders of the fake clock ran (Testing Library's findBy cannot wait on it). */
  async function expectRow(text: string): Promise<void> {
    await flush(50);
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
  }

  const polls = (): number => api.callsTo('listSessions').length;

  it('opens one same-origin stream on /api/v3/stream, from the head and epoch of the instance', async () => {
    await mount();
    expect(sources.urls()).toEqual([`/api/v3/stream?since=${String(instance.headSeq)}&epoch=${instance.epoch}`]);
    expect(screen.getByTestId('freshness')).not.toHaveTextContent(/^live[|]/);
  });

  it('reports live while the stream is open and ingestion health separately from it', async () => {
    await mount();
    await openStream();
    await flush(10);
    expect(screen.getByTestId('freshness')).toHaveTextContent(/^live\|ok$/);
    healthMode = 'degraded';
    await flush(instance.poll.healthMs + 100);
    // Connectivity did not change, ingestion did: the two are not the same signal.
    expect(screen.getByTestId('freshness')).toHaveTextContent(/^live\|degraded$/);
  });

  it('stops polling the list while the stream is open and resumes polling when it fails', async () => {
    await mount();
    await expectRow('FIXTURE first session');
    await openStream();
    const before = polls();
    await flush(instance.poll.sessionsMs * 3);
    expect(polls()).toBe(before);
    act(() => {
      sources.last().fail();
    });
    await flush(instance.poll.sessionsMs * 2);
    expect(polls()).toBeGreaterThan(before);
  });

  it('patches a session change into the visible row in place, without a refetch', async () => {
    await mount();
    await expectRow('FIXTURE first session');
    await openStream();
    const before = polls();
    act(() => {
      sources
        .last()
        .emit('change', sessionChange(11, makeSession({ id: ROW_A, seq: 5, label: 'FIXTURE renamed session' })));
    });
    await flush(150);
    await expectRow('FIXTURE renamed session');
    expect(screen.queryByText('FIXTURE first session')).toBeNull();
    expect(polls()).toBe(before);
  });

  it('shows a new session on the first page without a reload when the list is at the top', async () => {
    await mount();
    await expectRow('FIXTURE first session');
    await openStream();
    const added = makeSession({ id: ROW_B, seq: 6, label: 'FIXTURE second session' });
    sessions = [added, ...sessions];
    const before = polls();
    act(() => {
      sources.last().emit('change', sessionChange(12, added));
    });
    await flush(2500);
    expect(polls()).toBeGreaterThan(before);
    await expectRow('FIXTURE second session');
    expect(screen.getAllByText('FIXTURE first session').length).toBeGreaterThan(0);
  });

  describe('a list the user has scrolled away from (rule R3, LF-10)', () => {
    afterEach(() => {
      Reflect.deleteProperty(window, 'scrollY');
      const main = document.querySelector('main');
      if (main !== null) main.scrollTop = 0;
    });

    function scrollWindowTo(top: number): void {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: top });
    }

    /** The sidebar is a live list by design; the explorer table is the one R3 keeps stable. */
    function inTable(text: string): boolean {
      return within(screen.getByTestId('explorer-results')).queryAllByText(text).length > 0;
    }

    async function addSecondSession(): Promise<SessionSummary> {
      const added = makeSession({ id: ROW_B, seq: 6, label: 'FIXTURE second session' });
      sessions = [added, ...sessions];
      act(() => {
        sources.last().emit('change', sessionChange(12, added));
      });
      await flush(2500);
      return added;
    }

    it('keeps the table as it is and offers Refresh once the page is scrolled 8 px or more', async () => {
      await mount();
      await expectRow('FIXTURE first session');
      await openStream();
      scrollWindowTo(8);
      const before = polls();
      await addSecondSession();
      expect(polls()).toBe(before);
      expect(inTable('FIXTURE second session')).toBe(false);
      const notice = screen.getByRole('status', { name: 'List changed' });
      expect(notice).toHaveTextContent('1 session changed');
      fireEvent.click(within(notice).getByRole('button', { name: 'Refresh' }));
      await flush(50);
      expect(inTable('FIXTURE second session')).toBe(true);
      expect(screen.queryByRole('status', { name: 'List changed' })).toBeNull();
      expect(polls()).toBeGreaterThan(before);
    });

    it('treats a main region scrolled 8 px or more like a scrolled page', async () => {
      await mount();
      await expectRow('FIXTURE first session');
      await openStream();
      const main = document.querySelector('main');
      if (main === null) throw new Error('the shell has no main region');
      main.scrollTop = 20;
      await addSecondSession();
      expect(inTable('FIXTURE second session')).toBe(false);
      expect(screen.getByRole('status', { name: 'List changed' })).toBeInTheDocument();
    });

    it('still follows the stream when the page is scrolled less than 8 px', async () => {
      await mount();
      await expectRow('FIXTURE first session');
      await openStream();
      scrollWindowTo(7);
      await addSecondSession();
      await flush(50);
      expect(inTable('FIXTURE second session')).toBe(true);
      expect(screen.queryByRole('status', { name: 'List changed' })).toBeNull();
    });
  });

  it('refetches the snapshot when the server sends a reset', async () => {
    await mount();
    await expectRow('FIXTURE first session');
    await openStream();
    const before = polls();
    sessions = [makeSession({ id: ROW_A, seq: 9, label: 'FIXTURE after reset' })];
    act(() => {
      sources.last().emit('reset', { headSeq: 50, reason: 'cursor_too_old' });
    });
    await flush(300);
    expect(polls()).toBeGreaterThan(before);
    await expectRow('FIXTURE after reset');
  });

  it('closes the source when the app unmounts', async () => {
    const { unmount } = render(
      <AppProviders>
        <App />
      </AppProviders>,
    );
    await flush(50);
    await openStream();
    unmount();
    expect(sources.last().closed).toBe(true);
  });
});
