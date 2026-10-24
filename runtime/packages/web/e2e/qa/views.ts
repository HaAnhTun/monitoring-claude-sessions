// The views the visual QA tool can shoot (WP-122). One base view per route exists from the start, so that every work package can
// capture its page before its own variants exist; a work package that adds variants (loading, error, empty, popovers, tabs)
// writes new entries inside its own marked block below, with ids that no base view and no other block uses.
import type { Page as BrowserPage } from '@playwright/test';

import type { Page, SessionSummary } from '@mcs/shared';

import { iso, makeSession, makeState } from '../../src/test/fixtures/index.ts';
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
export const PLANNED_ROUTE_PATHS: readonly string[] = ['/search'];

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
  // @wp-end WP-53
  // @wp-begin WP-54
  // @wp-end WP-54
  // @wp-begin WP-65
  // @wp-end WP-65
  // @wp-begin WP-66
  // @wp-end WP-66
  // @wp-begin WP-67
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
      const states: Parameters<typeof makeState>[0][] = [
        'working',
        'waiting_tool',
        'turn_ended',
        'completed',
        'failed',
        'waiting_input',
        'stale',
      ];
      fixture.fake.handlers.listSessions = (): Page<SessionSummary> => ({
        items: Array.from({ length: 1000 }, (_unused, i) =>
          makeSession({
            id: fixtureId(100 + i),
            seq: 100 + i,
            label: `Nightly job ${String(i + 1)}`,
            startedAt: iso(-(90 + i) * 60),
            lastActivityAt: iso(-30 - i * 40),
            errorCount: i % 9 === 0 ? 1 : 0,
            state: makeState(states[i % states.length] ?? 'working'),
          }),
        ),
        nextCursor: null,
        asOfSeq: 10,
        total: 1000,
        totalIsLowerBound: false,
        limit: 100,
      });
      await page.waitForFunction(
        `document.querySelectorAll('main tbody tr, main .data-card').length >= 1000`,
        undefined,
        { timeout: 30_000 },
      );
    },
  },
  // @wp-end WP-116
  // @wp-begin WP-117
  // @wp-end WP-117
  // @wp-begin WP-118
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
