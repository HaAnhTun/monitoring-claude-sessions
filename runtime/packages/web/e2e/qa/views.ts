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
  // @wp-end WP-114
  // @wp-begin WP-115
  // @wp-end WP-115
  // @wp-begin WP-116
  // @wp-end WP-116
  // @wp-begin WP-117
  // @wp-end WP-117
  // @wp-begin WP-118
  // @wp-end WP-118
  // @wp-begin WP-119
  // @wp-end WP-119
  // @wp-begin WP-120
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
