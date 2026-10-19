// FIXTURE: invented data for the visual QA tool (WP-122, fixture mode).
// The fake API of the web tests (`src/test/fake-api.ts`, every body validated against its route schema) bridged to Playwright:
// `page.route` answers every `/api/v3/**` request from it, and the event stream is aborted so the app falls back to polling.
// Fixture mode shows what a real instance cannot show quickly: every lifecycle state at once, a request that never finishes
// (loading), an answer of 500 (error), no data (empty) and a server that goes away after the page was drawn (disconnected).
// Every timestamp of the fixtures is shifted so that "now" of the fixtures is the real now: relative times read right.
import type { Page, Route } from '@playwright/test';

import {
  ERROR_HTTP_STATUS,
  routes,
  type ActivityEvent,
  type CostEstimate,
  type LifecycleState,
  type PanelKey,
  type SessionSummary,
} from '@mcs/shared';

import { createFakeApi, errorResponse, type FakeApi, type FakeHandlers } from '../../src/test/fake-api.ts';
import {
  FIXTURE_NOW_MS,
  agentId,
  iso,
  makeAgent,
  makeAgentPage,
  makeConfigInspection,
  makeEvent,
  makeEventPage,
  makeHealth,
  makeInstance,
  makeMetric,
  makeOverview,
  makePage,
  makePanelResponse,
  makeSession,
  makeSessionDetail,
  makeSeriesPoint,
  makeState,
  makeToolFrequencyReport,
  makeToolFrequencyRow,
  makeTranscriptSearch,
  makeTranscriptWindow,
  makeUsage,
  makeUsageReport,
  makeUsageRow,
  makeUsageSeries,
  makeWorkItem,
  makeWorkItemBoard,
} from '../../src/test/fixtures/index.ts';

/** What the fake server does. `ok` answers every route with data; the others are the states a real instance cannot show quickly. */
export const FIXTURE_STATES = ['ok', 'loading', 'error', 'empty', 'disconnected'] as const;
export type FixtureState = (typeof FIXTURE_STATES)[number];

/** A valid session id whose first characters differ from one session to the next (the lists show the first eight). */
export function fixtureId(n: number): string {
  const head = (0x3c5a1f00 + n * 0x01010101).toString(16).padStart(8, '0');
  return `${head}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** The session of the fixture list that the detail views open (it has subagents, an error and a long transcript). */
export const FIXTURE_DETAIL_SESSION_ID = fixtureId(3);

const MINUTE = 60;

/** The ten lifecycle states of the engine, each at least once, plus the shapes that stress a layout. */
export function fixtureSessions(): SessionSummary[] {
  const usage = (output: number, input: number, cacheRead: number): SessionSummary['usage'] =>
    makeUsage({
      output,
      input,
      cacheCreation: Math.round(input / 4),
      cacheRead,
      total: output + input + Math.round(input / 4) + cacheRead,
    });
  const row = (n: number, label: string, state: LifecycleState, over: Partial<SessionSummary> = {}): SessionSummary =>
    makeSession({
      id: fixtureId(n),
      seq: n,
      label,
      startedAt: iso(-90 * MINUTE),
      lastActivityAt: iso(-30),
      state: makeState(state),
      usage: usage(4200 + n * 310, 9000 + n * 700, 640_000 + n * 21_000),
      usageInclSubagents: usage(5100 + n * 310, 11_000 + n * 700, 790_000 + n * 21_000),
      ...over,
    });
  const cost: CostEstimate = {
    amount: 1.42,
    currency: 'USD',
    basis: 'estimate',
    pricedTokensPct: 100,
    unpricedModels: [],
  };
  return [
    row(1, 'Parser refactor', 'working', { state: makeState('working', { rule: 'S-7b', since: iso(-40) }), cost }),
    row(2, 'Flaky cache test', 'working', {
      lastActivityAt: iso(-25 * MINUTE),
      state: makeState('working', {
        basis: 'inferred',
        confidence: 'medium',
        rule: 'S-7e',
        evidence: [{ kind: 'clock:quiet', at: iso(-25 * MINUTE), text: 'quiet 25m' }],
      }),
    }),
    row(3, 'Release checklist', 'turn_ended', {
      errorCount: 2,
      agentCount: 3,
      activeAgentCount: 0,
      toolCallCount: 18,
      lastActivityAt: iso(-8 * MINUTE),
      projectLabel: 'billing-service',
      workItemIds: [1],
      state: makeState('turn_ended', { rule: 'S-8e' }),
      cost,
    }),
    row(4, 'End-to-end suite', 'waiting_tool', {
      pendingTools: 1,
      lastActivityAt: iso(-5 * MINUTE),
      state: makeState('waiting_tool', {
        rule: 'S-7c',
        evidence: [{ kind: 'transcript:tool_open', at: iso(-5 * MINUTE), text: 'tool Bash open for 5m' }],
      }),
    }),
    row(5, 'Review the open pull requests', 'waiting_agent', {
      agentCount: 5,
      activeAgentCount: 2,
      projectLabel: 'billing-service',
      workItemIds: [2],
      state: makeState('waiting_agent', { rule: 'S-7a' }),
    }),
    row(6, 'Approve the schema change', 'waiting_input', {
      lastActivityAt: iso(-12 * MINUTE),
      state: makeState('waiting_input', {
        waitReason: 'permission',
        rule: 'S-6a',
        evidence: [
          { kind: 'hook:permission_request', at: iso(-12 * MINUTE), text: 'waiting for permission (Edit) 12m ago' },
        ],
      }),
    }),
    row(7, 'Compile the backend and run the unit tests', 'completed', {
      endedAt: iso(-40 * MINUTE),
      lastActivityAt: iso(-40 * MINUTE),
      workItemIds: [1],
      state: makeState('completed', { rule: 'S-2a', endReason: 'prompt_input_exit', since: iso(-40 * MINUTE) }),
      cost,
    }),
    row(8, 'Run the integration tests against staging', 'failed', {
      errorCount: 4,
      lastActivityAt: iso(-50 * MINUTE),
      state: makeState('failed', { rule: 'S-3a', turnOutcome: 'error', since: iso(-50 * MINUTE) }),
    }),
    row(9, 'Search index migration', 'stale', {
      lastActivityAt: iso(-45 * MINUTE),
      state: makeState('stale', {
        basis: 'inferred',
        confidence: 'medium',
        staleKind: 'silent',
        rule: 'S-7f',
        evidence: [{ kind: 'clock:quiet', at: iso(-45 * MINUTE), text: 'quiet 45m' }],
      }),
    }),
    row(10, 'Sync the translation files', 'unknown', {
      lastActivityAt: iso(-33 * MINUTE),
      state: makeState('unknown', { basis: 'inferred', confidence: 'low', rule: 'S-7d' }),
    }),
    row(
      11,
      'Migrate the billing service to the new payment provider, update every integration test, the runbook and the dashboards',
      'turn_ended',
      { lastActivityAt: iso(-3 * 60 * MINUTE), state: makeState('turn_ended', { rule: 'S-8e' }) },
    ),
    row(12, 'Draft the release notes', 'turn_ended', {
      lastActivityAt: iso(-26 * 60 * MINUTE),
      startedAt: iso(-27 * 60 * MINUTE),
      matched: false,
      labelSource: 'first_prompt',
      state: makeState('turn_ended', { rule: 'S-8e' }),
    }),
  ];
}

function events(sessions: readonly SessionSummary[]): ActivityEvent[] {
  const kinds = [
    { type: 'tool.call', category: 'tool', entryKind: 'tool', severity: 'info', summary: 'npm test --workspace api' },
    {
      type: 'tool.failure',
      category: 'error',
      entryKind: 'result',
      severity: 'error',
      summary: 'Exit code 1: 3 tests failed',
    },
    {
      type: 'assistant.message',
      category: 'prompt',
      entryKind: 'say',
      severity: 'info',
      summary: 'Looking at the failing test first.',
    },
    { type: 'tool.result', category: 'tool', entryKind: 'result', severity: 'info', summary: 'Compiled 214 files' },
  ] as const;
  return Array.from({ length: 24 }, (_unused, i): ActivityEvent => {
    const kind = kinds[i % kinds.length] ?? kinds[0];
    const session = sessions[i % sessions.length] ?? sessions[0];
    return makeEvent({
      id: 100 - i,
      seq: 100 - i,
      key: `t:fixture-event-${String(i)}`,
      sessionId: session?.id ?? fixtureId(1),
      sessionLabel: session?.label ?? 'FIXTURE',
      at: iso(-20 - i * 45),
      receivedAt: iso(-19 - i * 45),
      toolName: kind.entryKind === 'tool' || kind.type === 'tool.failure' ? 'Bash' : null,
      ...kind,
    });
  });
}

function handlers(state: FixtureState): FakeHandlers {
  const sessions = state === 'empty' ? [] : fixtureSessions();
  const instance = makeInstance({
    slug: 'demo',
    title: 'Demo monitor',
    // a quick poll so that a change of state shows within a second or two
    poll: {
      healthMs: 1500,
      sessionsMs: 1500,
      overviewMs: 1500,
      transcriptMs: 1500,
      machineMs: 2000,
      logsMs: 3000,
      attemptsMs: 3000,
    },
    features: { transcriptSearch: 'instance', costEstimates: true, usageTrend: true, hooks: false },
  });
  const eventRows = state === 'empty' ? [] : events(fixtureSessions());
  const metric = (
    key: string,
    label: string,
    value: number,
    unit: 'count' | 'tokens' | 'currency',
    link: string | null = null,
  ) => makeMetric({ key, label, value, unit, link, source: 'sessions.state', rule: `FIXTURE rule of ${key}` });
  const count = (state_: LifecycleState): number => sessions.filter((s) => s.state.state === state_).length;
  const detailOf = (id: string) => {
    const found = sessions.find((s) => s.id === id) ?? sessions[0] ?? makeSession();
    return makeSessionDetail({
      ...found,
      cwd: '/work/billing-service',
      gitBranch: 'feature/payment-provider',
      permissionMode: 'default',
      models: ['model-a', 'model-b'],
      lastModel: 'model-a',
      workItems: found.workItemIds.map((workItemId) => ({
        id: workItemId,
        title: workItemId === 1 ? 'Backend build and tests' : 'Release review',
        state: 'working' as const,
      })),
      files: [
        {
          agentId: 'main',
          kind: 'session',
          state: 'active',
          sizeBytes: 412_000,
          importedBytes: 412_000,
          behindBytes: 0,
          entries: 612,
          usageState: 'complete',
        },
        {
          agentId: agentId(1),
          kind: 'subagent',
          state: 'active',
          sizeBytes: 88_000,
          importedBytes: 88_000,
          behindBytes: 0,
          entries: 140,
          usageState: 'complete',
        },
      ],
    });
  };
  const board = makeWorkItemBoard({
    items:
      state === 'empty'
        ? []
        : [
            makeWorkItem({
              id: 1,
              key: 'backend',
              title: 'Backend build and tests',
              state: 'completed',
              sessionIds: [fixtureId(3), fixtureId(7)],
              sessionCount: 2,
            }),
            makeWorkItem({
              id: 2,
              key: 'review',
              title: 'Release review',
              state: 'working',
              sessionIds: [fixtureId(5)],
              sessionCount: 1,
            }),
            makeWorkItem({
              id: 3,
              key: 'deploy',
              title: 'Deploy to staging',
              state: 'failed',
              sessionIds: [fixtureId(8)],
              sessionCount: 1,
            }),
          ],
  });
  return {
    instance: () => instance,
    health: () => makeHealth(state === 'error' ? 'error' : 'ok'),
    config: () => makeConfigInspection(),
    overview: () =>
      makeOverview({
        metrics:
          state === 'empty'
            ? []
            : [
                metric(
                  'sessions.active',
                  'Active sessions',
                  count('working') + count('waiting_tool') + count('waiting_agent'),
                  'count',
                  '/sessions?state=active',
                ),
                metric('sessions.waiting_input', 'Waiting for input', count('waiting_input'), 'count'),
                metric('sessions.turn_ended', 'Turn ended', count('turn_ended'), 'count'),
                metric('sessions.failed', 'Failed', count('failed'), 'count'),
                metric('events.errors', 'Errors', 6, 'count', '/activity?severity=error'),
                metric('tokens.output', 'Output tokens', 61_400, 'tokens'),
                metric('tokens.input', 'Input tokens (uncached)', 118_900, 'tokens'),
                metric('tokens.cache_read', 'Cache read tokens', 9_240_000, 'tokens'),
                metric('cost.estimate', 'Estimated cost', 4.26, 'currency'),
              ],
        recentActivity: eventRows.slice(0, 8),
        recentErrors: eventRows.filter((e) => e.severity === 'error').slice(0, 4),
      }),
    listSessions: () => makePage(sessions, { total: sessions.length }),
    getSession: (_query, request) => detailOf(request.params['sessionId'] ?? FIXTURE_DETAIL_SESSION_ID),
    sessionAgents: (_query, request) =>
      makeAgentPage([
        makeAgent({
          id: 'main',
          kind: 'main',
          depth: 0,
          parentAgentId: null,
          label: 'main',
          sessionId: request.params['sessionId'] ?? fixtureId(3),
          state: makeState('turn_ended'),
        }),
        makeAgent({
          id: agentId(1),
          label: 'Lint helper',
          errorCount: 1,
          state: makeState('failed'),
          sessionId: request.params['sessionId'] ?? fixtureId(3),
        }),
        makeAgent({
          id: agentId(2),
          label: 'Test runner',
          state: makeState('completed'),
          sessionId: request.params['sessionId'] ?? fixtureId(3),
        }),
      ]),
    transcriptWindow: (_query, request) =>
      makeTranscriptWindow(state === 'empty' ? 0 : 40, { sessionId: request.params['sessionId'] ?? fixtureId(3) }),
    sessionTimeline: () => makeEventPage(eventRows),
    listEvents: () => makeEventPage(eventRows),
    searchTranscript: () => makeTranscriptSearch(),
    workItemBoard: () => board,
    analyticsUsage: () =>
      makeUsageReport({
        rows:
          state === 'empty'
            ? []
            : [
                makeUsageRow({ key: 'model-a', label: 'model-a', sessions: 9 }),
                makeUsageRow({ key: 'model-b', label: 'model-b', sessions: 3 }),
              ],
      }),
    analyticsSeries: () =>
      makeUsageSeries({
        bucket: 'hour',
        points:
          state === 'empty'
            ? []
            : Array.from({ length: 24 }, (_unused, i) =>
                makeSeriesPoint({
                  start: iso(-(24 - i) * 3600),
                  output: 800 + ((i * 337) % 2200),
                  input: 1500 + ((i * 521) % 3100),
                  cacheRead: 90_000 + ((i * 7919) % 210_000),
                  messages: 10 + (i % 9),
                }),
              ),
      }),
    analyticsTools: () =>
      makeToolFrequencyReport({
        items:
          state === 'empty'
            ? []
            : [
                makeToolFrequencyRow({ toolName: 'Bash', calls: 120, succeeded: 104, failed: 16, failurePct: 13 }),
                makeToolFrequencyRow({ toolName: 'Read', calls: 96, succeeded: 96, failed: 0, failurePct: 0 }),
                makeToolFrequencyRow({ toolName: 'Edit', calls: 41, succeeded: 39, failed: 2, failurePct: 5 }),
              ],
      }),
    panel: (_query, request) => makePanelResponse((request.params['key'] ?? 'ledger') as PanelKey),
  };
}

/** The ISO instants inside a JSON text, moved by `deltaMs`. */
export function shiftInstants(text: string, deltaMs: number): string {
  return text.replaceAll(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z/g, (instant) =>
    new Date(Date.parse(instant) + deltaMs).toISOString(),
  );
}

export interface FixtureApi {
  /** The fake API of the web tests; replace a handler (`fake.handlers.listSessions = ...`) to change what a view gets. */
  readonly fake: FakeApi;
  state: FixtureState;
  /** Every request path (and query) the page made, in order. */
  readonly requests: string[];
  /** Switches the answers (`disconnected` makes every request fail at the network level). */
  setState(next: FixtureState): void;
}

/** Instances that bootstrap the shell stay answered while a page is "loading" or "failing", so the chrome is drawn. */
const BOOTSTRAP: ReadonlySet<string> = new Set([routes.instance.path]);

/**
 * Bridges the fake API to `page.route` for `/api/v3/**`. The stream route is aborted, so the app polls. Returns a handle with
 * which a view can change the state (`disconnected` after the first draw) or replace handlers before the page loads.
 */
export async function fixtureApi(page: Page, initial: FixtureState = 'ok'): Promise<FixtureApi> {
  const delta = Math.round((Date.now() - FIXTURE_NOW_MS) / 1000) * 1000;
  const fake = createFakeApi(handlers(initial));
  const api: FixtureApi = {
    fake,
    state: initial,
    requests: [],
    setState(next) {
      api.state = next;
      fake.handlers = handlers(next);
    },
  };

  const answer = async (route: Route): Promise<void> => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === routes.stream.path) {
      await route.abort();
      return;
    }
    api.requests.push(`${url.pathname}${url.search}`);
    if (api.state === 'disconnected') {
      await route.abort('connectionrefused');
      return;
    }
    if (!BOOTSTRAP.has(url.pathname) && api.state === 'loading') {
      // a request that never finishes: the page keeps its loading state until it is closed
      await new Promise<void>(() => undefined);
      return;
    }
    if (!BOOTSTRAP.has(url.pathname) && api.state === 'error') {
      const failure = errorResponse('internal_error', 'The monitor could not answer this request.');
      await route.fulfill({
        status: ERROR_HTTP_STATUS.internal_error,
        contentType: 'application/json',
        body: await failure.text(),
      });
      return;
    }
    try {
      const response = await fake.fetchImpl(url.href);
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: shiftInstants(await response.text(), delta),
      });
    } catch (error) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal_error', message: String(error), requestId: 'r-fixture' } }),
      });
    }
  };
  await page.route('**/api/v3/**', answer);
  return api;
}

/** The count of distinct lifecycle states the default fixture list shows. */
export function fixtureStates(): LifecycleState[] {
  return [...new Set(fixtureSessions().map((session) => session.state.state))];
}
