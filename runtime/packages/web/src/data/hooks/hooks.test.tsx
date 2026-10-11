import { ERROR_CODES, routes } from '@mcs/shared';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../test/fake-api.ts';
import * as fixtures from '../../test/fixtures/index.ts';
import { renderHookWithProviders, renderWithProviders } from '../../test/render.tsx';
import { ApiError } from '../api-errors.ts';
import { createQueryClient } from '../query-client.ts';
import { qk } from '../query-keys.ts';
import { useActivity } from './useActivity.ts';
import { useAgents } from './useAgents.ts';
import { useAnalytics } from './useAnalytics.ts';
import { useConfigInspection } from './useConfigInspection.ts';
import { useHealth } from './useHealth.ts';
import { ActiveInstance, DEFAULT_POLL, useInstance } from './useInstance.ts';
import { useOverview } from './useOverview.ts';
import { panelPollMs, usePanel } from './usePanel.ts';
import { useSession } from './useSession.ts';
import { useSessions, useSidebarSessions } from './useSessions.ts';
import { useTimeline } from './useTimeline.ts';
import { useTranscriptSearch } from './useTranscriptSearch.ts';
import { useWorkItems } from './useWorkItems.ts';

const { sessionId } = fixtures;
const SID = sessionId(1);
const INSTANCE = fixtures.makeInstance();
const IID = INSTANCE.instanceId;

afterEach(() => {
  vi.useRealTimers();
});

function fakeApi(handlers: FakeHandlers = {}): FakeApi {
  return createFakeApi({ instance: () => INSTANCE, ...handlers });
}

/** Pages of `n` sessions with a cursor chain `c1`, `c2`, ... until `pages` pages have been served. */
function pagedSessions(pages: number) {
  return (query: URLSearchParams) => {
    const cursor = query.get('cursor');
    const index = cursor === null ? 0 : Number(cursor.slice(1));
    const items = [fixtures.makeSession({ id: sessionId(index * 10 + 1), label: `FIXTURE page ${index}` })];
    return fixtures.makeSessionPage(items, { nextCursor: index + 1 < pages ? `c${index + 1}` : null });
  };
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('fixtures and the fake API', () => {
  it('every fixture factory produces a body its shared route schema accepts', () => {
    const cases: [string, { success: boolean }][] = [
      ['instance', routes.instance.response.safeParse(fixtures.makeInstance())],
      ['health ok', routes.health.response.safeParse(fixtures.makeHealth('ok'))],
      ['health degraded', routes.health.response.safeParse(fixtures.makeHealth('degraded'))],
      ['health error', routes.health.response.safeParse(fixtures.makeHealth('error'))],
      ['overview', routes.overview.response.safeParse(fixtures.makeOverview())],
      ['sessions', routes.listSessions.response.safeParse(fixtures.makeSessionPage([fixtures.makeSession()]))],
      ['session', routes.getSession.response.safeParse(fixtures.makeSessionDetail())],
      ['agents', routes.sessionAgents.response.safeParse(fixtures.makeAgentPage([fixtures.makeAgent()]))],
      ['timeline', routes.sessionTimeline.response.safeParse(fixtures.makeEventPage([fixtures.makeEvent()]))],
      ['events', routes.listEvents.response.safeParse(fixtures.makeEventPage([fixtures.makeEvent()]))],
      ['transcript', routes.transcriptWindow.response.safeParse(fixtures.makeTranscriptWindow(5))],
      ['search', routes.searchTranscript.response.safeParse(fixtures.makeTranscriptSearch())],
      ['work items', routes.workItemBoard.response.safeParse(fixtures.makeWorkItemBoard())],
      ['usage', routes.analyticsUsage.response.safeParse(fixtures.makeUsageReport())],
      ['series', routes.analyticsSeries.response.safeParse(fixtures.makeUsageSeries())],
      ['tools', routes.analyticsTools.response.safeParse(fixtures.makeToolFrequencyReport())],
      ['config', routes.config.response.safeParse(fixtures.makeConfigInspection())],
      ...(['git', 'machine', 'attempts', 'ledger', 'chainLog', 'logs'] as const).map(
        (key): [string, { success: boolean }] => [
          `panel ${key}`,
          routes.panel.response.safeParse(fixtures.makePanelResponse(key)),
        ],
      ),
    ];
    for (const [name, result] of cases) expect(result.success, name).toBe(true);
  });

  it('starts every fixture with invented labels', () => {
    expect(fixtures.makeSession().label).toMatch(/^FIXTURE/);
    expect(fixtures.makeAgent().label).toMatch(/^FIXTURE/);
    expect(fixtures.makeWorkItem().title).toMatch(/^FIXTURE/);
  });

  it('numbers ids deterministically and uniquely', () => {
    expect(sessionId(1)).toBe(sessionId(1));
    expect(sessionId(1)).not.toBe(sessionId(2));
    expect(fixtures.agentId(3)).not.toBe(fixtures.agentId(4));
  });

  it('matches a route by its registry path, records the call and answers with a validated body', async () => {
    const api = fakeApi({
      getSession: (_query, ctx) => fixtures.makeSessionDetail({ id: ctx.params['sessionId'] ?? '' }),
    });
    const response = await api.fetchImpl(`/api/v3/sessions/${SID}?x=1`);
    expect(response.status).toBe(200);
    expect(api.callsTo('getSession')).toHaveLength(1);
    expect(api.callsTo('getSession')[0]?.params).toEqual({ sessionId: SID });
    expect(api.callsTo('getSession')[0]?.query.get('x')).toBe('1');
  });

  it('refuses a fixture that breaks the contract: the request fails and the violation is recorded', async () => {
    const api = fakeApi({ health: () => ({ not: 'a health report' }) });
    await expect(api.fetchImpl('/api/v3/health')).rejects.toThrow(/health/);
    expect(api.violations).toHaveLength(1);
    expect(api.violations[0]).toContain('health');
  });

  it('answers an unknown route with the route_not_found envelope', async () => {
    const api = createFakeApi({});
    const response = await api.fetchImpl('/api/v3/health');
    expect(response.status).toBe(404);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ error: { code: 'route_not_found' } });
  });

  it('builds an error envelope for every catalogue code with the catalogue status', async () => {
    for (const code of ERROR_CODES) {
      const response = errorResponse(code, 'm');
      const body: unknown = await response.json();
      expect(body).toMatchObject({ error: { code, message: 'm' } });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('useInstance and ActiveInstance', () => {
  it('loads the instance once and never refetches it by itself (staleTime Infinity)', async () => {
    const api = fakeApi();
    const { result, queryClient } = renderHookWithProviders(() => useInstance(), { api, instanceId: null });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.instanceId).toBe(IID);
    expect(queryClient.getQueryData(qk.instance())).toEqual(INSTANCE);
    expect(queryClient.getQueryState(qk.instance())?.dataUpdatedAt).toBeGreaterThan(0);
    expect(api.callsTo('instance')).toHaveLength(1);
  });

  it('ActiveInstance shows the fallback until the instance is known, then the children with its id', async () => {
    const api = fakeApi();
    renderWithProviders(
      <ActiveInstance fallback={<p>loading instance</p>} failed={() => <p>instance failed</p>}>
        <p>ready</p>
      </ActiveInstance>,
      { api, instanceId: null },
    );
    expect(screen.getByText('loading instance')).toBeInTheDocument();
    expect(await screen.findByText('ready')).toBeInTheDocument();
  });

  it('ActiveInstance shows the failure view when the instance cannot be loaded', async () => {
    const api = fakeApi({ instance: () => errorResponse('host_not_allowed', 'nope') });
    renderWithProviders(
      <ActiveInstance
        fallback={<p>loading instance</p>}
        failed={(error) => <p>{`instance failed: ${error.info.code ?? 'none'}`}</p>}
      >
        <p>ready</p>
      </ActiveInstance>,
      { api, instanceId: null },
    );
    expect(await screen.findByText('instance failed: host_not_allowed')).toBeInTheDocument();
    expect(screen.queryByText('ready')).not.toBeInTheDocument();
  });

  it('a data hook without an instance id is a programming error that says so', () => {
    expect(() => renderHookWithProviders(() => useHealth(), { api: fakeApi(), instanceId: null })).toThrow(/instance/i);
  });
});

describe('single-resource hooks', () => {
  it('useHealth, useOverview, useConfigInspection and useWorkItems fetch their route and fill the keyed cache', async () => {
    const api = fakeApi({
      health: () => fixtures.makeHealth('ok'),
      overview: () => fixtures.makeOverview(),
      config: () => fixtures.makeConfigInspection(),
      workItemBoard: () => fixtures.makeWorkItemBoard(),
    });
    const { result, queryClient } = renderHookWithProviders(
      () => ({
        health: useHealth(),
        overview: useOverview(),
        config: useConfigInspection(),
        board: useWorkItems(),
      }),
      { api },
    );
    await waitFor(() => {
      expect(result.current.health.isSuccess).toBe(true);
      expect(result.current.overview.isSuccess).toBe(true);
      expect(result.current.config.isSuccess).toBe(true);
      expect(result.current.board.isSuccess).toBe(true);
    });
    expect(queryClient.getQueryData(qk.health(IID))).toEqual(fixtures.makeHealth('ok'));
    expect(queryClient.getQueryData(qk.config(IID))).toEqual(fixtures.makeConfigInspection());
    expect(queryClient.getQueryData(qk.overview(IID))).toEqual(fixtures.makeOverview());
    expect(queryClient.getQueryData(qk.workItems(IID))).toEqual(fixtures.makeWorkItemBoard());
    expect(api.violations).toEqual([]);
  });

  it('useSession reads the session path and caches under the session key', async () => {
    const api = fakeApi({ getSession: (_q, ctx) => fixtures.makeSessionDetail({ id: ctx.params['sessionId'] ?? '' }) });
    const { result, queryClient } = renderHookWithProviders(() => useSession(SID), { api });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.id).toBe(SID);
    expect(queryClient.getQueryData(qk.session(IID, SID))).toBeDefined();
  });

  it('useSession treats a malformed id as not found without sending a request', async () => {
    const api = fakeApi();
    const { result } = renderHookWithProviders(() => useSession('not-a-session-id'), { api });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.info).toMatchObject({ kind: 'http', status: 404 });
    expect(api.callsTo('getSession')).toHaveLength(0);
  });

  it('useAnalytics reads the route of its kind', async () => {
    const api = fakeApi({
      analyticsUsage: () => fixtures.makeUsageReport(),
      analyticsSeries: () => fixtures.makeUsageSeries(),
      analyticsTools: () => fixtures.makeToolFrequencyReport(),
    });
    const { result, queryClient } = renderHookWithProviders(
      () => ({
        usage: useAnalytics('usage', { groupBy: 'model' }),
        series: useAnalytics('series', { bucket: 'day' }),
        tools: useAnalytics('tools', {}),
      }),
      { api },
    );
    await waitFor(() => {
      expect(result.current.usage.isSuccess).toBe(true);
      expect(result.current.series.isSuccess).toBe(true);
      expect(result.current.tools.isSuccess).toBe(true);
    });
    expect(result.current.usage.data?.groupBy).toBe('model');
    expect(result.current.series.data?.bucket).toBe('day');
    expect(result.current.tools.data?.items.length).toBeGreaterThan(0);
    expect(queryClient.getQueryData(qk.analytics(IID, 'series', { bucket: 'day' }))).toBeDefined();
    expect(api.callsTo('analyticsUsage')[0]?.query.get('groupBy')).toBe('model');
  });

  it('useTranscriptSearch sends nothing until a query is submitted, then caches it forever', async () => {
    const api = fakeApi({ searchTranscript: () => fixtures.makeTranscriptSearch() });
    const initial: { q: Record<string, string> | null } = { q: null };
    const { result, rerender, queryClient } = renderHookWithProviders(
      (props: { q: Record<string, string> | null }) => useTranscriptSearch(props.q),
      { api, initialProps: initial },
    );
    await flushReal();
    expect(api.callsTo('searchTranscript')).toHaveLength(0);
    expect(result.current.fetchStatus).toBe('idle');
    rerender({ q: { session: SID, q: 'needle' } });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(api.callsTo('searchTranscript')[0]?.query.get('session')).toBe(SID);
    expect(api.callsTo('searchTranscript')[0]?.query.get('q')).toBe('needle');
    expect(queryClient.getQueryState(qk.transcriptSearch(IID, { session: SID, q: 'needle' }))).toBeDefined();
  });
});

async function flushReal() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useSessions (cursor infinite query)', () => {
  it('requests 100 rows from the first page without a cursor and flattens the pages', async () => {
    const api = fakeApi({ listSessions: pagedSessions(3) });
    const { result } = renderHookWithProviders(() => useSessions({ sort: 'lastActivity' }), { api });
    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
    });
    const first = api.callsTo('listSessions')[0];
    expect(first?.query.get('limit')).toBe('100');
    expect(first?.query.get('cursor')).toBeNull();
    expect(first?.query.get('sort')).toBe('lastActivity');
    expect(result.current.items).toHaveLength(1);
    expect(result.current.query.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.query.fetchNextPage();
    });
    expect(api.callsTo('listSessions')[1]?.query.get('cursor')).toBe('c1');
    await waitFor(() => {
      expect(result.current.items.map((item) => item.label)).toEqual(['FIXTURE page 0', 'FIXTURE page 1']);
    });
  });

  it('stops offering more at maxPages and says so with capped', async () => {
    const api = fakeApi({ listSessions: pagedSessions(20) });
    const { result } = renderHookWithProviders(() => useSessions({}), { api });
    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
    });
    expect(result.current.capped).toBe(false);
    for (let loaded = 1; loaded < 10; loaded += 1) {
      await act(async () => {
        await result.current.query.fetchNextPage();
      });
      await waitFor(() => {
        expect(result.current.items).toHaveLength(loaded + 1);
      });
    }
    expect(result.current.capped).toBe(true);
    expect(result.current.query.hasNextPage).toBe(true);
  });

  it('keeps the previous rows visible while a new filter loads (keepPreviousData)', async () => {
    let release: () => void = () => undefined;
    const api = fakeApi({
      listSessions: (query) => {
        if (query.get('q') === 'slow') {
          return new Promise((resolve) => {
            release = () => {
              resolve(fixtures.makeSessionPage([fixtures.makeSession({ label: 'FIXTURE filtered' })]));
            };
          });
        }
        return fixtures.makeSessionPage([fixtures.makeSession({ label: 'FIXTURE all' })]);
      },
    });
    const { result, rerender } = renderHookWithProviders(
      (props: { q: Record<string, string> }) => useSessions(props.q),
      {
        api,
        initialProps: { q: {} },
      },
    );
    await waitFor(() => {
      expect(result.current.items.map((item) => item.label)).toEqual(['FIXTURE all']);
    });
    rerender({ q: { q: 'slow' } });
    await waitFor(() => {
      expect(result.current.query.isPlaceholderData).toBe(true);
    });
    expect(result.current.items.map((item) => item.label)).toEqual(['FIXTURE all']);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.items.map((item) => item.label)).toEqual(['FIXTURE filtered']);
    });
  });

  it('aborts the request of the old filter when the filter changes', async () => {
    const signals: AbortSignal[] = [];
    const api = fakeApi({
      listSessions: (query, ctx) => {
        if (query.get('q') === 'first' && ctx.signal !== null) signals.push(ctx.signal);
        return query.get('q') === 'first'
          ? new Promise(() => undefined)
          : fixtures.makeSessionPage([fixtures.makeSession()]);
      },
    });
    const { result, rerender } = renderHookWithProviders(
      (props: { q: Record<string, string> }) => useSessions(props.q),
      {
        api,
        initialProps: { q: { q: 'first' } },
      },
    );
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    rerender({ q: { q: 'second' } });
    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
    });
    expect(signals[0]?.aborted).toBe(true);
  });

  it('cursor_invalid resets the list to the first page and reports it once', async () => {
    let calls = 0;
    const onCursorReset = vi.fn();
    const api = fakeApi({
      listSessions: (query) => {
        calls += 1;
        if (query.get('cursor') !== null) return errorResponse('cursor_invalid', 'The list changed');
        return fixtures.makeSessionPage([fixtures.makeSession({ label: `FIXTURE load ${calls}` })], {
          nextCursor: 'c1',
        });
      },
    });
    const { result } = renderHookWithProviders(() => useSessions({}, { onCursorReset }), { api });
    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
    });
    await act(async () => {
      await result.current.query.fetchNextPage();
    });
    await waitFor(() => {
      expect(onCursorReset).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.items.map((item) => item.label)).toEqual(['FIXTURE load 3']);
    });
    expect(api.callsTo('listSessions').filter((call) => call.query.get('cursor') === null)).toHaveLength(2);
  });

  it('useSidebarSessions asks for the current window with 200 rows, or everything when showAll', async () => {
    const api = fakeApi({ listSessions: () => fixtures.makeSessionPage([fixtures.makeSession()]) });
    const { result, rerender, queryClient } = renderHookWithProviders(
      (props: { all: boolean }) => useSidebarSessions(props.all),
      {
        api,
        initialProps: { all: false },
      },
    );
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const first = api.callsTo('listSessions')[0];
    expect(first?.query.get('window')).toBe('1');
    expect(first?.query.get('limit')).toBe('200');
    expect(queryClient.getQueryData(qk.sidebarSessions(IID, false))).toBeDefined();
    rerender({ all: true });
    await waitFor(() => {
      expect(api.callsTo('listSessions')).toHaveLength(2);
    });
    expect(api.callsTo('listSessions')[1]?.query.get('window')).toBeNull();
    expect(api.callsTo('listSessions')[1]?.query.get('limit')).toBe('200');
  });
});

describe('useAgents, useTimeline and useActivity', () => {
  it('useAgents asks for 500 agents of the session and loads the next page on demand', async () => {
    const api = fakeApi({
      sessionAgents: (query) =>
        fixtures.makeAgentPage([fixtures.makeAgent({ id: fixtures.agentId(query.get('cursor') === null ? 1 : 2) })], {
          nextCursor: query.get('cursor') === null ? 'a1' : null,
        }),
    });
    const { result } = renderHookWithProviders(() => useAgents(SID), { api });
    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
    });
    expect(api.callsTo('sessionAgents')[0]?.query.get('limit')).toBe('500');
    expect(api.callsTo('sessionAgents')[0]?.params).toEqual({ sessionId: SID });
    await act(async () => {
      await result.current.query.fetchNextPage();
    });
    await waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });
  });

  it('useTimeline pages by cursor with 100 events and the session path', async () => {
    const api = fakeApi({
      sessionTimeline: (query) =>
        fixtures.makeEventPage([fixtures.makeEvent({ id: query.get('cursor') === null ? 2 : 1 })], {
          nextCursor: query.get('cursor') === null ? 'e1' : null,
        }),
    });
    const { result } = renderHookWithProviders(() => useTimeline(SID, { category: 'tool' }), { api });
    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
    });
    const first = api.callsTo('sessionTimeline')[0];
    expect(first?.query.get('limit')).toBe('100');
    expect(first?.query.get('category')).toBe('tool');
    await act(async () => {
      await result.current.query.fetchNextPage();
    });
    await waitFor(() => {
      expect(result.current.items.map((event) => event.id)).toEqual([2, 1]);
    });
  });

  it('useActivity pages by cursor with 100 events', async () => {
    const api = fakeApi({ listEvents: () => fixtures.makeEventPage([fixtures.makeEvent()]) });
    const { result } = renderHookWithProviders(() => useActivity({ severity: 'error' }), { api });
    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
    });
    expect(api.callsTo('listEvents')[0]?.query.get('limit')).toBe('100');
    expect(api.callsTo('listEvents')[0]?.query.get('severity')).toBe('error');
    expect(result.current.items).toHaveLength(1);
  });
});

describe('usePanel (04 5.2, 06 3.3)', () => {
  it('polls git, ledger and chainLog with poll.overviewMs and the others with their own key (N-09)', () => {
    const poll = { ...DEFAULT_POLL, overviewMs: 7000, machineMs: 2100, logsMs: 3100, attemptsMs: 6100 };
    expect(panelPollMs('git', poll)).toBe(7000);
    expect(panelPollMs('ledger', poll)).toBe(7000);
    expect(panelPollMs('chainLog', poll)).toBe(7000);
    expect(panelPollMs('machine', poll)).toBe(2100);
    expect(panelPollMs('logs', poll)).toBe(3100);
    expect(panelPollMs('attempts', poll)).toBe(6100);
  });

  it('does not fetch a collapsed panel', async () => {
    const api = fakeApi({ panel: () => fixtures.makePanelResponse('git') });
    renderHookWithProviders(() => usePanel('git', { expanded: false }), { api });
    await flushReal();
    expect(api.callsTo('panel')).toHaveLength(0);
  });

  it('fetches an expanded panel by key and returns the response of that key', async () => {
    const api = fakeApi({
      panel: (_q, ctx) => fixtures.makePanelResponse(ctx.params['key'] === 'machine' ? 'machine' : 'git'),
    });
    const { result, queryClient } = renderHookWithProviders(() => usePanel('machine', { expanded: true }), { api });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.key).toBe('machine');
    expect(api.callsTo('panel')[0]?.params).toEqual({ key: 'machine' });
    expect(queryClient.getQueryData(qk.panel(IID, 'machine'))).toBeDefined();
  });

  it('turns a response of another panel into a contract failure', async () => {
    const api = fakeApi({
      panel: () => new Response(JSON.stringify(fixtures.makePanelResponse('logs')), { status: 200 }),
    });
    const { result } = renderHookWithProviders(() => usePanel('git', { expanded: true }), { api });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error?.info.kind).toBe('contract');
  });

  it('does not retry a disabled panel (404 panel_disabled)', async () => {
    const api = fakeApi({ panel: () => errorResponse('panel_disabled', 'disabled') });
    const queryClient = createQueryClient();
    const { result } = renderHookWithProviders(() => usePanel('git', { expanded: true }), { api, queryClient });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error?.info.code).toBe('panel_disabled');
    expect(api.callsTo('panel')).toHaveLength(1);
  });

  it('polls an expanded git panel every poll.overviewMs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const api = fakeApi({ panel: () => fixtures.makePanelResponse('git') });
    const instance = fixtures.makeInstance({ poll: { ...DEFAULT_POLL, overviewMs: 7000 } });
    renderHookWithProviders(() => usePanel('git', { expanded: true }), { api, instance });
    await flush(0);
    expect(api.callsTo('panel')).toHaveLength(1);
    await flush(6900);
    expect(api.callsTo('panel')).toHaveLength(1);
    await flush(200);
    expect(api.callsTo('panel')).toHaveLength(2);
  });
});

describe('polling without a stream (04 5.2 !L) and with one (L)', () => {
  const timers = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const;

  it('useHealth polls at poll.healthMs even with a live stream', async () => {
    vi.useFakeTimers({ toFake: [...timers] });
    const api = fakeApi({ health: () => fixtures.makeHealth('ok') });
    renderHookWithProviders(() => useHealth(), { api, live: true });
    await flush(0);
    expect(api.callsTo('health')).toHaveLength(1);
    await flush(DEFAULT_POLL.healthMs);
    expect(api.callsTo('health')).toHaveLength(2);
  });

  it('useOverview and useSessions poll when the stream is not live and stay quiet when it is', async () => {
    vi.useFakeTimers({ toFake: [...timers] });
    const api = fakeApi({
      overview: () => fixtures.makeOverview(),
      listSessions: () => fixtures.makeSessionPage([fixtures.makeSession()]),
    });
    renderHookWithProviders(() => ({ o: useOverview(), s: useSessions({}) }), { api, live: false });
    await flush(0);
    expect(api.callsTo('overview')).toHaveLength(1);
    expect(api.callsTo('listSessions')).toHaveLength(1);
    await flush(DEFAULT_POLL.sessionsMs);
    expect(api.callsTo('overview')).toHaveLength(2);
    expect(api.callsTo('listSessions')).toHaveLength(2);
  });

  it('a live stream turns the list polling off', async () => {
    vi.useFakeTimers({ toFake: [...timers] });
    const api = fakeApi({
      overview: () => fixtures.makeOverview(),
      listSessions: () => fixtures.makeSessionPage([fixtures.makeSession()]),
    });
    renderHookWithProviders(() => ({ o: useOverview(), s: useSessions({}) }), { api, live: true });
    await flush(0);
    await flush(60_000);
    expect(api.callsTo('overview')).toHaveLength(1);
    expect(api.callsTo('listSessions')).toHaveLength(1);
  });

  it('useAnalytics and useConfigInspection never poll', async () => {
    vi.useFakeTimers({ toFake: [...timers] });
    const api = fakeApi({
      analyticsUsage: () => fixtures.makeUsageReport(),
      config: () => fixtures.makeConfigInspection(),
    });
    renderHookWithProviders(() => ({ a: useAnalytics('usage', {}), c: useConfigInspection() }), { api });
    await flush(0);
    await flush(300_000);
    expect(api.callsTo('analyticsUsage')).toHaveLength(1);
    expect(api.callsTo('config')).toHaveLength(1);
  });

  it('the timeline polls its first page only while a single page is loaded', async () => {
    vi.useFakeTimers({ toFake: [...timers] });
    const api = fakeApi({
      sessionTimeline: (query) =>
        fixtures.makeEventPage([fixtures.makeEvent()], { nextCursor: query.get('cursor') === null ? 'e1' : null }),
    });
    const { result } = renderHookWithProviders(() => useTimeline(SID, {}), { api });
    await flush(0);
    await flush(3000);
    expect(api.callsTo('sessionTimeline')).toHaveLength(2);
    await act(async () => {
      await result.current.query.fetchNextPage();
    });
    const before = api.callsTo('sessionTimeline').length;
    await flush(9000);
    expect(api.callsTo('sessionTimeline')).toHaveLength(before);
  });

  it('uses the poll intervals of the instance when it is known', async () => {
    vi.useFakeTimers({ toFake: [...timers] });
    const api = fakeApi({ health: () => fixtures.makeHealth('ok') });
    const instance = fixtures.makeInstance({ poll: { ...DEFAULT_POLL, healthMs: 1500 } });
    renderHookWithProviders(() => useHealth(), { api, instance });
    await flush(0);
    await flush(1500);
    expect(api.callsTo('health')).toHaveLength(2);
  });
});

describe('failures reach the caller', () => {
  it('surfaces a contract failure as an ApiError of kind contract and does not retry it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = fakeApi({ overview: () => new Response(JSON.stringify({ wrong: true }), { status: 200 }) });
    const queryClient = createQueryClient();
    const { result } = renderHookWithProviders(() => useOverview(), { api, queryClient });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error?.info.kind).toBe('contract');
    expect(result.current.error?.message).toContain('overview');
    expect(api.callsTo('overview')).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it('does not retry a 404 session and exposes its code', async () => {
    const api = fakeApi({ getSession: () => errorResponse('session_not_found', 'No such session') });
    const queryClient = createQueryClient();
    const { result } = renderHookWithProviders(() => useSession(SID), { api, queryClient });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error?.info.code).toBe('session_not_found');
    expect(api.callsTo('getSession')).toHaveLength(1);
  });

  it('retries a 500 with backoff and keeps the data of an earlier success on a later failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let fail = false;
    const api = fakeApi({
      health: () => (fail ? errorResponse('internal_error', 'kaput') : fixtures.makeHealth('ok')),
    });
    const queryClient = createQueryClient();
    const { result } = renderHookWithProviders(() => useHealth(), { api, queryClient });
    await flush(0);
    expect(result.current.isSuccess).toBe(true);
    fail = true;
    await flush(DEFAULT_POLL.healthMs);
    expect(api.callsTo('health')).toHaveLength(2);
    await flush(2000);
    expect(api.callsTo('health')).toHaveLength(3);
    expect(result.current.data).toEqual(fixtures.makeHealth('ok'));
  });
});
