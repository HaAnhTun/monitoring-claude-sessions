// The views the visual QA tool can shoot (WP-122). One base view per route exists from the start, so that every work package can
// capture its page before its own variants exist; a work package that adds variants (loading, error, empty, popovers, tabs)
// writes new entries inside its own marked block below, with ids that no base view and no other block uses.
import type { Page as BrowserPage } from '@playwright/test';

import type { InstanceInfo, Page, SessionSummary } from '@mcs/shared';

import {
  iso,
  makeSession,
  makeState,
  makeUsage,
  makeWorkItem,
  makeWorkItemBoard,
} from '../../src/test/fixtures/index.ts';
import { fixtureId, type FixtureApi, type FixtureState } from './fixture-api.ts';
import type { QaInstance } from './qa-instance.ts';

/** `live` shoots a real instance on synthetic data; `fixture` answers the API from the fake server (states a real instance cannot show quickly). */
export type ViewMode = 'live' | 'fixture';

/** What a view may ask of the data behind it. */
export interface ViewData {
  /** A session with subagents, an error and a transcript: the one the detail views open. */
  readonly detailSessionId: string;
}

/** What `setup` gets: the page as the tool loaded it and the sources behind it. */
export interface ViewContext {
  readonly page: BrowserPage;
  readonly mode: ViewMode;
  readonly locale: 'en' | 'vi';
  /** Set in live mode. */
  readonly qa: QaInstance | null;
  /** Set in fixture mode: replace `fixture.fake.handlers` entries or call `fixture.setState`. */
  readonly fixture: FixtureApi | null;
}

export interface ViewSpec {
  /** Unique over the merged list; the file names of the shots start with it. */
  readonly id: string;
  /** The route pattern of `ROUTES` (`/sessions/:sessionId`), or `*` for a page that no route claims. */
  readonly path: string;
  readonly mode: ViewMode;
  /** The state of the fake server (fixture mode only); the default is `ok`. */
  readonly state?: FixtureState;
  /** CSS selector that must be visible before the shot (a view says what it is waiting for). */
  readonly wait: string;
  /** Values for the `:name` and `*` parts of `path`. */
  readonly params?: (data: ViewData) => Record<string, string>;
  /** The query string of the page, without the question mark. */
  readonly query?: string;
  /** Runs after the page is ready and before the shot: open a tab, a popover, a dialog, scroll. */
  readonly setup?: (context: ViewContext) => Promise<void>;
}

/**
 * Routes of ADR 0073 that the app does not register yet. A view of such a route is shot anyway (the app answers "not found"
 * until its page lands). The selftest fails when an entry is already in `ROUTES`, so the list cannot rot.
 */
export const PLANNED_ROUTE_PATHS: readonly string[] = [];

const detail = (data: ViewData): Record<string, string> => ({ sessionId: data.detailSessionId });

/** Fixture mode: appends a session whose state is an inferred `running` to the list the app polls, and waits until it is drawn. */
async function addInferredRunning({ page, fixture }: ViewContext): Promise<void> {
  if (fixture === null) return;
  const listSessions = fixture.fake.handlers.listSessions;
  if (listSessions === undefined) throw new Error('the fixture API has no session list');
  fixture.fake.handlers.listSessions = async (query, request) => {
    const body = (await listSessions(query, request)) as Page<SessionSummary>;
    const inferredRunning = makeSession({
      id: fixtureId(13),
      seq: 13,
      label: 'Rebuild the search index',
      startedAt: iso(-40 * 60),
      lastActivityAt: iso(-14 * 60),
      state: makeState('running', {
        basis: 'inferred',
        confidence: 'medium',
        rule: 'S-7e',
        evidence: [{ kind: 'clock:quiet', at: iso(-14 * 60), text: 'quiet 14m' }],
      }),
    });
    return { ...body, items: [...body.items, inferredRunning], total: (body.total ?? body.items.length) + 1 };
  };
  await page
    .locator('main [data-state="running"][data-basis="inferred"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 });
}

/**
 * Fixture mode: gives every open-tool session a realistic long evidence text (an MCP tool name, 88 characters; the engine allows
 * 120), the case that once stretched the State column of the table. Waits until the long text is drawn.
 */
async function addLongEvidence({ page, fixture }: ViewContext): Promise<void> {
  if (fixture === null) return;
  const listSessions = fixture.fake.handlers.listSessions;
  if (listSessions === undefined) throw new Error('the fixture API has no session list');
  const text = 'tool mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot open (2 open) for 5m';
  fixture.fake.handlers.listSessions = async (query, request) => {
    const body = (await listSessions(query, request)) as Page<SessionSummary>;
    const items = body.items.map((item) =>
      item.state.state === 'waiting_tool'
        ? { ...item, state: { ...item.state, evidence: [{ kind: 'transcript:tool_open', at: iso(-5 * 60), text }] } }
        : item,
    );
    return { ...body, items };
  };
  const selector = 'main .evidence-line[data-evidence="server"][title*="take_screenshot"]';
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 20_000 });
  // The regression check: the line is cut (its content is wider than its box) and its cell is no wider than a short badge column.
  const measured: unknown = await page.evaluate(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const td = el && el.closest('td');
      return { clipped: !!el && el.scrollWidth > el.clientWidth, cell: td ? td.getBoundingClientRect().width : 0 };
    })()`,
  );
  const { clipped, cell } = measured as { clipped: boolean; cell: number };
  if (!clipped) throw new Error('the long evidence line is not clamped to one line');
  if (cell > 320) throw new Error(`the long evidence line stretched the State column to ${Math.round(cell)} px`);
}

/** The page heading: every page has one, so it is the generic sign that the page is drawn. */
const HEADING = 'main h1';

export const VIEWS: readonly ViewSpec[] = [
  // ---- base views: one per route, defined by WP-122 (live mode) ----
  { id: 'overview', path: '/', mode: 'live', wait: HEADING },
  { id: 'sessions', path: '/sessions', mode: 'live', wait: HEADING },
  { id: 'session-detail-transcript', path: '/sessions/:sessionId', mode: 'live', wait: HEADING, params: detail },
  { id: 'activity', path: '/activity', mode: 'live', wait: HEADING },
  { id: 'tasks', path: '/tasks', mode: 'live', wait: HEADING },
  { id: 'analytics', path: '/analytics', mode: 'live', wait: HEADING },
  { id: 'settings-health', path: '/settings', mode: 'live', wait: HEADING, query: 'section=health' },
  { id: 'search', path: '/search', mode: 'live', wait: HEADING },
  { id: 'not-found', path: '*', mode: 'live', wait: HEADING, params: () => ({ '*': 'no-such-page' }) },
  // ---- marked blocks of the work packages that add variants (entries only; each entry ends with a comma) ----
  // @wp-begin WP-53
  {
    // Paused: the live instance keeps its stream, so the status line reads "Paused" and the button reads Resume.
    id: 'activity-paused',
    path: '/activity',
    mode: 'live',
    wait: 'main .activity-toolbar',
    setup: async ({ page }) => {
      await page.locator('main .activity-toolbar button').click();
      await page.locator('main .activity-status.tone-idle').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // The target of the Overview error figure: only errors, each with the failed bar on its left.
    id: 'activity-errors',
    path: '/activity',
    mode: 'fixture',
    query: 'severity=error',
    wait: 'main .activity-row--error',
    // The fake server ignores filters, so it is made to answer the severity of the request, as the real one does.
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      const listEvents = fixture.fake.handlers.listEvents;
      if (listEvents === undefined) throw new Error('the fixture API has no event list');
      fixture.fake.handlers.listEvents = async (query, request) => {
        const body = (await listEvents(query, request)) as { items: { severity: string }[] };
        const severities = (query.get('severity') ?? '').split(',');
        return { ...body, items: body.items.filter((item) => severities.includes(item.severity)) };
      };
      // The page polls every 3 s without a stream; the rows that are not errors go with the next answer.
      await page
        .locator('main .activity-row:not(.activity-row--error)')
        .first()
        .waitFor({ state: 'detached', timeout: 20_000 });
      await page.locator('main .activity-row--error').first().waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // Every row shape at once: a gap separator, a warning, a long summary that is clamped, and an event with details opened.
    id: 'activity-rows',
    path: '/activity',
    mode: 'fixture',
    wait: 'main .activity-row',
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      const listEvents = fixture.fake.handlers.listEvents;
      if (listEvents === undefined) throw new Error('the fixture API has no event list');
      fixture.fake.handlers.listEvents = async (query, request) => {
        const body = (await listEvents(query, request)) as { items: Record<string, unknown>[] };
        const base = body.items[0];
        if (base === undefined) return body;
        const extra = [
          {
            ...base,
            id: 901,
            seq: 901,
            type: 'monitor.gap',
            category: 'ingest',
            severity: 'warning',
            toolName: null,
            summary: 'hooks were not reporting for 4 minutes',
            details: {},
          },
          {
            ...base,
            id: 902,
            seq: 902,
            type: 'permission.denied',
            category: 'notification',
            severity: 'warning',
            toolName: 'Write',
            summary: 'The write to a protected path was denied',
            details: {},
          },
          {
            ...base,
            id: 903,
            seq: 903,
            type: 'tool.result',
            category: 'tool',
            severity: 'info',
            toolName: 'Bash',
            toolStatus: 'succeeded',
            durationMs: 84_000,
            summary: `${'Compiled the workspace and ran the whole suite; '.repeat(6)}done`,
            details: { exitCode: 0, cwd: '/work/demo', branch: 'feature/activity' },
          },
        ];
        return { ...body, items: [...extra, ...body.items] };
      };
      // The page polls every 3 s without a stream, so the new rows arrive by themselves.
      await page.locator('main .activity-row--gap').first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator('main .activity-row .disclosure__toggle').first().click();
    },
  },
  {
    // The "More filters" panel open.
    id: 'activity-filters',
    path: '/activity',
    mode: 'fixture',
    wait: 'main .activity-row',
    setup: async ({ page }) => {
      await page.locator('main .filter-bar__more .popover > button').click();
      await page.locator('main .filter-bar__panel').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  { id: 'activity-loading', path: '/activity', mode: 'fixture', state: 'loading', wait: 'main .skeleton--list' },
  { id: 'activity-error', path: '/activity', mode: 'fixture', state: 'error', wait: 'main .state--error' },
  { id: 'activity-empty', path: '/activity', mode: 'fixture', state: 'empty', wait: 'main .state--empty' },
  {
    // Filters that hide everything: the way out is one button.
    id: 'activity-no-match',
    path: '/activity',
    mode: 'fixture',
    state: 'empty',
    query: 'severity=error',
    wait: 'main .state--empty',
  },
  {
    id: 'activity-disconnected',
    path: '/activity',
    mode: 'fixture',
    state: 'disconnected',
    wait: 'main .activity-row',
  },
  // @wp-end WP-53
  // @wp-begin WP-54
  // @wp-end WP-54
  // @wp-begin WP-65
  // @wp-end WP-65
  // @wp-begin WP-66
  {
    id: 'tasks-empty',
    path: '/tasks',
    mode: 'fixture',
    state: 'empty',
    wait: 'main .state--empty',
  },
  {
    id: 'analytics-no-trend',
    path: '/analytics',
    mode: 'fixture',
    wait: 'main .metric-tiles',
    // The instance is read once at boot, so the fake answer is changed and the page is loaded again.
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      const instance = fixture.fake.handlers.instance;
      if (instance === undefined) throw new Error('the fixture API has no instance answer');
      fixture.fake.handlers.instance = async (query, request) => {
        const body = (await instance(query, request)) as InstanceInfo;
        return { ...body, features: { ...body.features, usageTrend: false } };
      };
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('main .metric-tiles').waitFor({ state: 'visible', timeout: 20_000 });
      if ((await page.locator('main .trend').count()) !== 0)
        throw new Error('the trend charts are drawn without the flag');
    },
  },
  {
    id: 'tasks-populated',
    path: '/tasks',
    mode: 'fixture',
    wait: 'main .board__col',
    // A board with every shape that stresses a card: a long title, many sessions, evidence, a task without figures, a full column.
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      const usage = makeUsage({
        output: 48_200,
        input: 9100,
        cacheCreation: 3100,
        cacheRead: 2_400_000,
        total: 2_460_400,
      });
      const evidence = [
        { kind: 'session:state', at: iso(-6 * 60), text: 'Parser refactor: working (S-7b)' },
        { kind: 'session:state', at: iso(-40 * 60), text: 'Compile the backend: completed (S-2a)' },
        { kind: 'session:state', at: null, text: 'Flaky cache test: working (S-7e)' },
      ];
      const ids = [1, 2, 3, 4, 5, 6, 7].map((n) => fixtureId(n));
      const working = Array.from({ length: 6 }, (_unused, i) =>
        makeWorkItem({
          id: 10 + i,
          key: `working-${String(i)}`,
          title: i === 0 ? 'Backend build and tests' : `Search index migration, part ${String(i)}`,
          source: i === 1 ? 'attempts' : 'declared',
          rule: i === 1 ? 'W-ATT' : 'W-DECL',
          state: 'working',
          boardReason: 'a member is working (S-7b)',
          evidence: i === 0 ? evidence : [],
          sessionIds: ids,
          sessionCount: i === 0 ? 9 : 7,
          usage: i === 2 ? null : usage,
        }),
      );
      const board = makeWorkItemBoard({
        derivation:
          'Each session belongs to at most one item and the first matching rule wins: W-DECL (items declared in the configuration), W-ATT (attempt rows grouped by part), W-LBL (matched sessions grouped by exact label).',
        items: [
          ...working,
          makeWorkItem({
            id: 20,
            key: 'review',
            title: 'Release review',
            source: 'label',
            rule: 'W-LBL',
            state: 'waiting',
            boardReason: 'a member waits for input (S-6a)',
            evidence: evidence.slice(0, 1),
            sessionIds: [fixtureId(6)],
            sessionCount: 1,
            usage,
          }),
          makeWorkItem({
            id: 21,
            key: 'billing',
            title:
              'Migrate the billing service to the new payment provider, update every integration test, the runbook and the dashboards',
            state: 'completed',
            boardReason: 'the most recently started member completed (S-2a)',
            sessionIds: [fixtureId(7)],
            sessionCount: 1,
            lastActivityAt: iso(-3 * 3600),
            usage: makeUsage({ ...usage, completeness: 'partial', lowerBound: true, scannedPct: 82 }),
          }),
          makeWorkItem({
            id: 22,
            key: 'deploy',
            title: 'Deploy to staging',
            state: 'failed',
            boardReason: 'the most recently started member failed (S-3a)',
            sessionIds: [fixtureId(8)],
            sessionCount: 1,
            usage,
          }),
          makeWorkItem({
            id: 23,
            key: 'sync',
            title: 'Sync the translation files',
            state: 'stale',
            boardReason: 'a member is stale (S-7f)',
            sessionIds: [fixtureId(9)],
            sessionCount: 1,
            lastActivityAt: iso(-45 * 60),
            usage: null,
          }),
        ],
      });
      fixture.fake.handlers.workItemBoard = () => board;
      await page
        .locator('main .work-card', { hasText: 'Sync the translation files' })
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    id: 'analytics-tooltip',
    path: '/analytics',
    mode: 'fixture',
    wait: 'main .chart',
    // Hourly buckets (24 bars): the keyboard focus of one bar shows its tooltip.
    setup: async ({ page }) => {
      await page.locator('main .chart[data-metric="output"] .chart__hit').nth(20).focus();
      await page.locator('main .chart__tip').first().waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    id: 'analytics-table',
    path: '/analytics',
    mode: 'fixture',
    wait: 'main .chart',
    setup: async ({ page }) => {
      await page.locator('main .trend__head button').click();
      await page.locator('main .trend table').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  // @wp-end WP-66
  // @wp-begin WP-67
  // The settings sections that need data the live QA instance does not have, and the two that only need a page of their own.
  {
    // Long values, a long key, every source tag and long file paths: the case that must clamp inside the page at 600 px.
    id: 'settings-config',
    path: '/settings',
    mode: 'fixture',
    query: 'section=config',
    wait: 'main .settings-value',
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      const longPath = `/work/${'a-very-long-folder-name/'.repeat(8)}transcripts`;
      const rules = Array.from({ length: 6 }, (_unused, index) => ({
        match: `project-${String(index)}/**`,
        label: `Fixture project number ${String(index)}`,
        tags: ['alpha', 'beta'],
      }));
      fixture.fake.handlers.config = () => ({
        entries: [
          { key: 'hooks.enabled', value: true, source: 'runtime' },
          { key: 'logging.level', value: 'info', source: 'env' },
          { key: 'poll.overview_ms', value: 5000, source: 'config' },
          { key: 'port', value: 18900, source: 'builtin' },
          { key: 'projects.rules', value: rules, source: 'config' },
          { key: 'retention.sessions_days', value: 90, source: 'skill' },
          { key: 'transcripts.dir', value: longPath, source: 'cli' },
          {
            key: 'ui.a.configuration.key.that.keeps.going.on.and.on.for.quite.a.while.longer',
            value: null,
            source: 'builtin',
          },
        ],
        files: [
          { name: 'defaults.json', path: `${longPath}/defaults.json`, schemaVersion: 1, present: true, ok: true },
          { name: 'config.json', path: `${longPath}/config.json`, schemaVersion: 1, present: true, ok: false },
          { name: 'runtime.json', path: `${longPath}/runtime.json`, schemaVersion: null, present: false, ok: true },
        ],
        effectivePort: 18900,
        engine: 'node',
      });
      // The configuration is read once per instance, so the page is loaded again to read the new answer.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('main .settings-value').first().waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    id: 'settings-preferences',
    path: '/settings',
    mode: 'live',
    query: 'section=preferences',
    wait: 'main .settings-prefs',
  },
  {
    // A server with trouble: degraded ingestion, hooks with an error, an old run, open alerts and server errors.
    id: 'settings-health-busy',
    path: '/settings',
    mode: 'fixture',
    query: 'section=health',
    wait: 'main h1',
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      const health = fixture.fake.handlers.health;
      if (health === undefined) throw new Error('the fixture API has no health answer');
      const error = (n: number): Record<string, unknown> => ({
        at: iso(-n * 90),
        source: n % 2 === 0 ? 'server' : 'ingest',
        code: n % 2 === 0 ? 'INTERNAL' : 'SPOOL_LINE_BAD',
        where: n % 3 === 0 ? `routes/session-${String(n)}` : null,
        message: `Fixture failure number ${String(n)}: the request could not be completed (a long message to check the wrapping)`,
        sessionId: null,
      });
      const alert = (
        id: number,
        severity: 'warning' | 'critical',
        title: string,
        sessionId: string | null,
      ): unknown => ({
        id,
        seq: id,
        ruleId: 'import_lag',
        rule: 'import_lag',
        severity,
        status: 'open',
        title,
        scope: { kind: 'instance', key: 'instance' },
        sessionId,
        since: iso(-1800),
        lastFiredAt: iso(-45),
        fireCount: 12,
        resolvedAt: null,
        resolvedReason: null,
        detail: {},
      });
      fixture.fake.handlers.health = async (query, request) => {
        const body = (await health(query, request)) as Record<string, Record<string, unknown>>;
        const ingestion = body['ingestion'] ?? {};
        return {
          ...body,
          status: 'degraded',
          runtime: { ...body['runtime'], outdated: true, previousRunUnclean: true },
          ingestion: {
            ...ingestion,
            status: 'degraded',
            reasons: ['The transcript import is 4 minutes behind', 'No hook event arrived for 12 minutes'],
            hooks: {
              enabled: true,
              installed: true,
              lastReceivedAt: iso(-720),
              lastEventAt: iso(-725),
              spoolPendingBytes: 4096,
              spoolLagMs: 2500,
              errorsLastHour: 3,
              lastError: error(1),
            },
          },
          alerts: [
            alert(1, 'critical', 'The import has not caught up for 30 minutes', fixtureId(2)),
            alert(2, 'warning', 'Hooks are quiet', null),
          ],
          errors: [1, 2, 3, 4, 5, 6].map(error),
        };
      };
      await page.locator('main .settings-alert').first().waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // The same server with trouble, scrolled to the open alerts and the server errors.
    id: 'settings-health-lists',
    path: '/settings',
    mode: 'fixture',
    query: 'section=health',
    wait: 'main h1',
    setup: async (context) => {
      await VIEWS.find((view) => view.id === 'settings-health-busy')?.setup?.(context);
      await context.page.evaluate(
        `(() => document.querySelector('main [data-list="alerts"]')?.closest('section')?.scrollIntoView({ block: 'start' }))()`,
      );
    },
  },
  { id: 'settings-data', path: '/settings', mode: 'live', query: 'section=data', wait: 'main .settings-command' },
  { id: 'settings-about', path: '/settings', mode: 'live', query: 'section=about', wait: 'main .settings-fact' },
  // @wp-end WP-67
  // @wp-begin WP-112
  // The new loading and error states on the sessions page: the request never finishes, or the server answers 500 every time.
  {
    id: 'sessions-loading',
    path: '/sessions',
    mode: 'fixture',
    state: 'loading',
    wait: 'main[data-stale-scope] .skeleton--table',
  },
  {
    id: 'sessions-error',
    path: '/sessions',
    mode: 'fixture',
    state: 'error',
    wait: 'main[data-stale-scope] .state--error',
  },
  // @wp-end WP-112
  // @wp-begin WP-113
  {
    // Every lifecycle state at once, observed and inferred: the fixture list holds the ten states and the inferred variants of
    // working, stale and unknown; setup adds an inferred "running" (the fifth shape of ADR 0074 decision 2).
    id: 'sessions-all-states',
    path: '/sessions',
    mode: 'fixture',
    wait: 'main [data-state="working"]',
    setup: addInferredRunning,
  },
  {
    // The same list scrolled to its last rows (Stale, Unknown and the inferred Running), which the first screen does not reach.
    id: 'sessions-all-states-end',
    path: '/sessions',
    mode: 'fixture',
    wait: 'main [data-state="working"]',
    setup: async (context) => {
      await addInferredRunning(context);
      await context.page.locator('main [data-state="running"][data-basis="inferred"]').last().scrollIntoViewIfNeeded();
    },
  },
  {
    // A realistic long server evidence text: the State column must stay narrow and the line must end in an ellipsis.
    id: 'sessions-long-evidence',
    path: '/sessions',
    mode: 'fixture',
    wait: 'main [data-state="working"]',
    setup: addLongEvidence,
  },
  // @wp-end WP-113
  // @wp-begin WP-114
  {
    // The shell frame on the session page: the full sidebar with the session switcher (1440 px), the 56 px rail (1024 px) or the
    // Menu bar (600 px). Shoot it at the three widths to see each layout mode.
    id: 'shell-rail',
    path: '/sessions/:sessionId',
    mode: 'live',
    wait: HEADING,
    params: detail,
  },
  {
    // The navigation sheet: below 900 px the Menu bar is pressed and the sheet is open; at wider windows the sidebar or rail is
    // the navigation and nothing is pressed.
    id: 'shell-sheet',
    path: '/sessions',
    mode: 'live',
    wait: '.sidebar-nav, .sidebar-menubar',
    setup: async ({ page }) => {
      const menu = page.locator('.sidebar-menubar button');
      if ((await menu.count()) === 0) return;
      await menu.click();
      await page.locator('.sidebar[data-mode="sheet"]:not([hidden]) .sidebar-nav').waitFor({ state: 'visible' });
    },
  },
  // @wp-end WP-114
  // @wp-begin WP-115
  {
    // The Live control open over the sessions page on a healthy instance: the four sections of the popover (ADR 0073 decision 5).
    id: 'live-popover',
    path: '/sessions',
    mode: 'live',
    wait: '.live-control button',
    setup: async ({ page }) => {
      await page.locator('.live-control button').click();
      await page.locator('.live-popover').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // The same popover on a sick instance: ingestion degraded with a reason, an unclean previous run and a long list of server
    // errors (the most the report holds, 20; the popover lists the newest few and says how many there are), one very long message.
    id: 'live-popover-busy',
    path: '/sessions',
    mode: 'fixture',
    wait: '.live-control button',
    setup: async ({ page, fixture }) => {
      const health = fixture?.fake.handlers.health;
      if (fixture === null || health === undefined) return;
      const long = `scan failed for ${'a-very-long-path-segment/'.repeat(14)}file.jsonl`;
      fixture.fake.handlers.health = async (query, request) => {
        const body = (await health(query, request)) as { runtime: object; ingestion: object };
        return {
          ...body,
          status: 'degraded',
          runtime: { ...body.runtime, previousRunUnclean: true },
          ingestion: {
            ...body.ingestion,
            status: 'degraded',
            reasons: ['12 hook envelopes rejected in the last hour', 'transcript import 90 s behind'],
          },
          errors: Array.from({ length: 20 }, (_unused, i) => ({
            at: iso(-60 * (i + 1)),
            source: 'server',
            code: 'INTERNAL',
            where: null,
            message: i === 1 ? long : `transcript import failed for session ${String(i + 1)}`,
            sessionId: null,
          })),
        };
      };
      await page.locator('.live-control[data-live-state="stale"]').waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator('.live-control button').click();
      await page.locator('.live-popover .live-error__message').first().waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // The user menu open: Theme, Density, Language and the shortcuts item, the chosen entries in the accent colour.
    id: 'user-menu',
    path: '/sessions',
    mode: 'live',
    wait: '.topbar button[aria-haspopup="menu"]',
    setup: async ({ page }) => {
      await page.locator('.topbar button[aria-haspopup="menu"]').click();
      await page.locator('.menu__panel[role="menu"]').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // The shortcuts dialog over a transcript, so that the registered keys (/, f, [, ]) show next to the fixed ones in their groups.
    id: 'shortcuts-dialog',
    path: '/sessions/:sessionId',
    mode: 'live',
    wait: '.tv-list .tr',
    params: detail,
    setup: async ({ page }) => {
      await page.locator('main').click({ position: { x: 4, y: 4 } });
      await page.keyboard.press('Shift+Slash');
      await page.locator('dialog.shortcuts-dialog[open]').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // The server goes away after the first draw: the Live control turns to "Reconnecting" or "Connection lost", the refresh button says
    // "Retry now" and "updated Ns ago" shows. A page that lists data adds the as-of line and the dashed outline (StaleDataIndicator).
    id: 'disconnected',
    path: '/sessions',
    mode: 'fixture',
    state: 'disconnected',
    wait: 'main h1',
    setup: async ({ page }) => {
      await page
        .locator('.live-control[data-connection="reconnecting"], .live-control[data-connection="offline"]')
        .waitFor({ state: 'visible', timeout: 30_000 });
    },
  },
  {
    // The same state with the popover open: the connection is lost, the ingestion is unknown with its last known status.
    id: 'disconnected-popover',
    path: '/sessions',
    mode: 'fixture',
    state: 'disconnected',
    wait: 'main h1',
    setup: async ({ page }) => {
      await page
        .locator('.live-control[data-connection="reconnecting"], .live-control[data-connection="offline"]')
        .waitFor({ state: 'visible', timeout: 30_000 });
      await page.locator('.live-control button').click();
      await page.locator('.live-popover').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  // @wp-end WP-115
  // @wp-begin WP-116
  {
    // One filter row, the "More filters" popover open over the list, and a removable chip for each hidden filter that is on
    // (R-06). The query turns on filters that live in the popover (project, model, tokens). The fixture server does not filter,
    // so the list stays drawn behind the popover. A page that still draws the V3 bar has no popover: nothing is opened then.
    id: 'sessions-filters',
    path: '/sessions',
    mode: 'fixture',
    query: 'project=billing-service&model=model-a&tokMin=5000&range=7d',
    wait: 'main form[role="search"]',
    setup: async ({ page }) => {
      const trigger = page.locator('main .filter-bar__more .popover > button').first();
      if ((await trigger.count()) === 0) return;
      await trigger.click();
      await page.locator('main .filter-bar__more .popover__panel').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // A thousand sessions in one list (the most the list ever holds, ADR 0038): a table at 1280 and 1024 px, a card list at 600 px.
    // The fixture server answers with all of them at once; the shot is taken when every row is drawn.
    id: 'sessions-many',
    path: '/sessions',
    mode: 'fixture',
    wait: 'main .data-table, main .data-cards',
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      // The rows of the default fixture list (every one is valid for the API schemas), repeated with new ids, labels and times.
      const { fixtureSessions } = await import('./fixture-api.ts');
      const base = fixtureSessions();
      fixture.fake.handlers.listSessions = (): Page<SessionSummary> => ({
        items: Array.from({ length: 1000 }, (_unused, i) => {
          const row = base[i % base.length] ?? makeSession();
          return {
            ...row,
            // fixtureId runs out of eight hex digits after about 250 rows
            id: `${(0x2a000000 + i).toString(16)}-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
            seq: 100 + i,
            label: i < base.length ? row.label : `${row.label} ${String(i + 1)}`,
            startedAt: iso(-(90 + i) * 60),
            lastActivityAt: iso(-30 - i * 40),
          };
        }),
        nextCursor: null,
        asOfSeq: 10,
        total: 1000,
        totalIsLowerBound: false,
        limit: 100,
      });
      // A locator waits without evaluating text as script, which the Content Security Policy of the page refuses.
      const rows = page.locator('main tbody tr, main .data-card');
      const problems: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') problems.push(message.text());
      });
      try {
        await rows.nth(999).waitFor({ state: 'attached', timeout: 30_000 });
      } catch {
        const seen = String(await rows.count());
        throw new Error(`the list has ${seen} rows, not 1000; console: ${problems.slice(-3).join(' | ')}`);
      }
    },
  },
  // @wp-end WP-116
  // @wp-begin WP-117
  {
    // No session at all: the list of causes. The fixture server answers an empty list (a second live instance would need its own
    // port and a second workspace for the same picture).
    id: 'sessions-empty',
    path: '/sessions',
    mode: 'fixture',
    state: 'empty',
    wait: 'main .state--empty',
  },
  {
    // Filters that match nothing: one message and one "Clear filters" button (the bar's own button is not drawn then).
    id: 'sessions-no-match',
    path: '/sessions',
    mode: 'fixture',
    state: 'empty',
    query: 'errors=1&state=failed&project=billing-service',
    wait: 'main .state--empty',
  },
  {
    // The column chooser open, with the extra columns of the table on: Project / task, Model, Started and Active span.
    id: 'sessions-columns',
    path: '/sessions',
    mode: 'fixture',
    wait: 'main .data-table, main .data-cards',
    setup: async ({ page }) => {
      const trigger = page.locator('main .explorer__tools .popover > button').first();
      if ((await trigger.count()) === 0) return;
      await trigger.click();
      await page.locator('main .column-chooser').waitFor({ state: 'visible', timeout: 20_000 });
      // The options are in the order of the table: state, session, project, model, started, last activity, active span, ...
      const boxes = page.locator('main .column-chooser input[type="checkbox"]');
      for (const index of [2, 3, 4, 6]) await boxes.nth(index).check();
    },
  },
  // @wp-end WP-117
  // @wp-begin WP-118
  {
    // The session header with its Details section open: back link, title, state with evidence, four tiles, and the fields that
    // have a value (no row of dashes). The demo session has a subagent with the only error, so the Errors tile shows the split.
    id: 'session-detail-header',
    path: '/sessions/:sessionId',
    mode: 'live',
    wait: 'main .session-frame h1',
    params: detail,
    setup: async ({ page }) => {
      await page.locator('main .session-frame__row .disclosure__toggle').click();
      await page.locator('main .session-details').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // The first load: the header-shaped placeholder in the frame the loaded page uses (the request never finishes).
    id: 'session-detail-loading',
    path: '/sessions/:sessionId',
    mode: 'fixture',
    state: 'loading',
    wait: 'main .session-frame[data-loading]',
    params: detail,
  },
  {
    // A session the monitor does not know (a real instance answers session_not_found): the heading, the explanation and the way back.
    id: 'session-detail-not-found',
    path: '/sessions/:sessionId',
    mode: 'live',
    wait: 'main .state--error',
    params: () => ({ sessionId: 'no-such-session' }),
  },
  {
    // The tab bar stays at the top of the window while the page scrolls: Details is open (a taller page) and the page is scrolled
    // to its end. Where the page is too short to scroll (a tall window) nothing moves and the check is skipped.
    id: 'session-detail-scrolled',
    path: '/sessions/:sessionId',
    mode: 'live',
    wait: 'main .session-frame h1',
    params: detail,
    setup: async ({ page }) => {
      await page.locator('main .session-frame__row .disclosure__toggle').click();
      await page.locator('main .session-details').waitFor({ state: 'visible', timeout: 20_000 });
      const measured: unknown = await page.evaluate(
        `(() => {
          const root = document.scrollingElement || document.documentElement;
          window.scrollTo(0, root.scrollHeight);
          const bar = document.querySelector('main nav.session-tabs');
          return { scrolled: window.scrollY, top: bar ? bar.getBoundingClientRect().top : null };
        })()`,
      );
      const { scrolled, top } = measured as { scrolled: number; top: number | null };
      if (top === null) throw new Error('the page has no tab bar');
      if (scrolled > 0 && Math.abs(top) > 1)
        throw new Error(`the tab bar is at y = ${String(top)} after scrolling ${String(scrolled)} px`);
    },
  },
  // @wp-end WP-118
  // @wp-begin WP-119
  // @wp-end WP-119
  // @wp-begin WP-120
  {
    // The transcript of the failing helper of the demo session (the session's only error belongs to this subagent): "Errors only" is
    // on and the first error is the target row, so the toolbar, the red error border and the target outline show together. (The
    // breakdown line "0 errors in this agent, 1 in subagents" needs the counts of the session page, WP-118.)
    id: 'transcript-failing',
    path: '/sessions/:sessionId',
    mode: 'live',
    wait: '.tv-list .tr',
    params: detail,
    query: 'agent=agentqafailed001',
    setup: async ({ page }) => {
      await page.locator('.tv-controls [role="switch"]').first().click();
      await page.locator('.tv-steps button').last().click();
      await page.locator('.tv-list .tr--error.is-target').first().waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // The Show popover open over the transcript: kind chips, Newest first and the Tool select.
    id: 'transcript-toolbar',
    path: '/sessions/:sessionId',
    mode: 'live',
    wait: '.tv-list .tr',
    params: detail,
    setup: async ({ page }) => {
      await page.locator('.tv-menus .popover > button').first().click();
      await page.locator('.tv-show').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  // @wp-end WP-120
  // @wp-begin WP-121
  {
    // A real instance: a text that is in several sessions is typed and submitted, and the matches are shown grouped by session.
    id: 'search-results',
    path: '/search',
    mode: 'live',
    wait: 'main .search-form__q',
    setup: async ({ page }) => {
      await page.locator('main .search-form__q').fill('test');
      await page.locator('main .search-form__q').press('Enter');
      await page.locator('main .search-group').first().waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // The fake server answers a search that stopped at its time limit: matches in two sessions, a subagent among them, and the coverage
    // warning with its reasons. "Not every part was searched" must be impossible to miss.
    id: 'search-incomplete',
    path: '/search',
    mode: 'fixture',
    wait: 'main .search-form__q',
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      const { makeInstanceSearch, makeInstanceSearchMatch } = await import('../../src/test/fixtures/index.ts');
      fixture.fake.handlers.searchTranscripts = () =>
        makeInstanceSearch({
          query: { q: 'migration', kinds: [] },
          truncated: true,
          matches: [
            makeInstanceSearchMatch({
              sessionId: fixtureId(1),
              sessionLabel: 'Parser refactor',
              i: 12,
              k: 'say',
              t: iso(-300),
              snippet: 'Starting the migration of the parser module to the new grammar, one rule at a time.',
            }),
            makeInstanceSearchMatch({
              sessionId: fixtureId(1),
              sessionLabel: 'Parser refactor',
              agentId: 'agentqafailed001',
              i: 3,
              k: 'tool',
              name: 'Bash',
              t: iso(-900),
              snippet: 'npm run migration:check -- --workspace parser',
            }),
            makeInstanceSearchMatch({
              sessionId: fixtureId(9),
              sessionLabel: 'Search index migration',
              i: 1,
              k: 'prompt',
              t: iso(-3600),
              snippet: `FIXTURE Run the index migration and report how long it takes. ${'The migration must not block reads. '.repeat(3)}`,
            }),
          ],
          coverage: {
            ...makeInstanceSearch().coverage,
            filesInScope: 14,
            filesScanned: 9,
            filesMissing: 1,
            filesUnreadable: 1,
            bytesInScope: 48_000_000,
            bytesScanned: 31_000_000,
            bytesNotIndexed: 2_400_000,
            entriesScanned: 18_200,
            complete: false,
            stoppedBy: 'time_budget',
            elapsedMs: 3010,
            note: 'Searched 9 of 14 transcript files (31.0 MB) of 6 sessions. 1 file was deleted and could not be searched.',
          },
        });
      await page.locator('main .search-form__q').fill('migration');
      await page.locator('main .search-form__q').press('Enter');
      await page.locator('main .search-coverage__warn').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // A search that never answers: the skeleton, the cancel hint and the Cancel button.
    id: 'search-loading',
    path: '/search',
    mode: 'fixture',
    wait: 'main .search-form__q',
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      fixture.fake.handlers.searchTranscripts = () => new Promise(() => undefined);
      await page.locator('main .search-form__q').fill('migration');
      await page.locator('main .search-form__q').press('Enter');
      await page.locator('main .search-loading').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // The server is running its other searches (429 search_busy): the message and the Retry button.
    id: 'search-busy',
    path: '/search',
    mode: 'fixture',
    wait: 'main .search-form__q',
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      const { errorResponse } = await import('../../src/test/fake-api.ts');
      fixture.fake.handlers.searchTranscripts = () => errorResponse('search_busy');
      await page.locator('main .search-form__q').fill('migration');
      await page.locator('main .search-form__q').press('Enter');
      await page.locator('main .state--error').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // A complete search with no match: the empty state and a coverage block without a warning.
    id: 'search-empty',
    path: '/search',
    mode: 'fixture',
    wait: 'main .search-form__q',
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      const { makeInstanceSearch } = await import('../../src/test/fixtures/index.ts');
      fixture.fake.handlers.searchTranscripts = () => makeInstanceSearch({ query: { q: 'zzzz', kinds: [] } });
      await page.locator('main .search-form__q').fill('zzzz');
      await page.locator('main .search-form__q').press('Enter');
      await page.locator('main .search-coverage').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  // @wp-end WP-121
];

/** `/sessions/:sessionId` and `{ sessionId }` give `/sessions/<id>`; the id is encoded; a missing value is an error. */
export function resolveViewUrl(view: ViewSpec, data: ViewData): string {
  const values = view.params?.(data) ?? {};
  const path = view.path
    .split('/')
    .map((segment) => {
      const key = segment === '*' ? '*' : segment.startsWith(':') ? segment.slice(1) : null;
      if (key === null) return segment;
      const value = values[key];
      if (value === undefined) throw new Error(`view ${view.id}: no value for ${segment} of ${view.path}`);
      return encodeURIComponent(value);
    })
    .join('/');
  const absolute = path.startsWith('/') ? path : `/${path}`;
  return view.query === undefined || view.query === '' ? absolute : `${absolute}?${view.query}`;
}

/** The storage key of the display preferences (`src/lib/prefs.ts`, ADR 0036). */
export const PREFS_STORAGE_KEY = 'mcs.ui.v3';

/** The init script that stores the theme and the language before the app starts, so that the first paint already has them. */
export function presetScript(theme: 'light' | 'dark', locale: 'en' | 'vi'): string {
  const value = JSON.stringify(JSON.stringify({ theme, locale }));
  return `try { globalThis.localStorage.setItem('${PREFS_STORAGE_KEY}', ${value}); } catch (error) { void error; }`;
}

/** The language tag the browser reports for a language of the UI. */
export function browserLocaleOf(locale: 'en' | 'vi'): string {
  return locale === 'vi' ? 'vi-VN' : 'en-US';
}

/** The ids that appear more than once in `views`. */
export function duplicateViewIds(views: readonly ViewSpec[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const view of views) {
    if (seen.has(view.id)) dup.add(view.id);
    seen.add(view.id);
  }
  return [...dup];
}
