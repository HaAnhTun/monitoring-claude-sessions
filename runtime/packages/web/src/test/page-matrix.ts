// FIXTURE: invented data for tests
// The page matrix (CAW-50, from WP-123): one entry per page of the route table, with the path to open, the fake API that makes the
// page draw real content, the landmarks the page frame must hold and the interactive entry points a keyboard user reaches first.
// `app/pages.contract.test.tsx` reads it (one `main`, one `h1`, focus on the `h1`, a named navigation, a skip link target).
//
// The second table, `CONTRACT_PAGES`, is the list of pages the browser contract suite walks (`e2e/qa/contract.ts` builds its pages
// from it and from nothing else): the base view of every route, the other tabs of the session page and the other sections of
// Settings. It lives here, next to the matrix, so that one unit test can hold both against `ROUTES`: a page that is added to the
// route table without a matrix entry or without a page of the browser contract fails `pages.contract.test.tsx` first.
import type { EnglishMessages, Locale, MessageKey, PlaceholderNames } from '../i18n/types.ts';
import type { FakeHandlers } from './fake-api.ts';
import {
  makeAgent,
  makeAgentPage,
  makeAuthSession,
  makeConfigInspection,
  makeEvent,
  makeEventPage,
  makeFolder,
  makeFolderList,
  makeHealth,
  makeInstance,
  makeInstanceSearch,
  makeMetric,
  makeOverview,
  makePage,
  makePanelResponse,
  makeSeriesPoint,
  makeSession,
  makeSessionDetail,
  makeState,
  makeTerminalSession,
  makeTerminalState,
  makeToolFrequencyReport,
  makeToolFrequencyRow,
  makeTranscriptSearch,
  makeTranscriptWindow,
  makeUsageReport,
  makeUsageRow,
  makeUsageSeries,
  makeWorkItem,
  makeWorkItemBoard,
  iso,
  sessionId,
} from './fixtures/index.ts';
import { msg } from './msg.ts';

/**
 * A page of the route table, read from the catalogue: every route has its `route.<key>.title`. The route table itself is not
 * imported, because the browser suite loads this file in Node and type-checks it without JSX, where the pages of the app cannot
 * be loaded. `pages.contract.test.tsx` holds the keys used here against `ROUTES`.
 */
export type PageKey = MessageKey extends infer K ? (K extends `route.${infer Key}.title` ? Key : never) : never;

/** The label of the session every page that needs one opens (the detail page names its `h1` after it). */
export const MATRIX_SESSION_LABEL = 'FIXTURE release checklist';

/** The session the detail case opens. */
export const MATRIX_SESSION_ID = sessionId(1);

/** A control a keyboard user reaches: found by its role and accessible name (never by a class). */
export interface EntryPoint {
  readonly role: 'button' | 'link' | 'textbox' | 'checkbox' | 'tab' | 'combobox' | 'searchbox';
  /** The accessible name, in the language asked for (a test passes it through `msg`). */
  readonly name: (locale: Locale) => string;
  /** What activating the control opens, when it opens something that must trap focus or give it back. */
  readonly opens?: 'menu' | 'popover' | 'dialog';
}

export interface PageCase {
  readonly id: PageKey;
  /** The location to open: path plus query. */
  readonly path: string;
  /** The text of the `h1` in the language asked for. */
  readonly heading: (locale: Locale) => string;
  /** The navigation entry that carries `aria-current="page"`; `null` when the page is not in the navigation. */
  readonly currentNav: PageKey | null;
  /** Controls to reach with the keyboard (after the shell ones in `SHELL_ENTRY_POINTS`). */
  readonly entryPoints: readonly EntryPoint[];
  /** A fresh fake API for the page: every route the page and the shell read answers with valid data. */
  readonly handlers: () => FakeHandlers;
}

/** A message of the catalogue that takes no argument: the name of a control or a heading. */
export type PlainKey = {
  [K in MessageKey]: [PlaceholderNames<EnglishMessages[K]>] extends [never] ? K : never;
}[MessageKey];

const byKey = (key: PlainKey): EntryPoint['name'] => {
  return (locale) => msg(key, undefined, locale);
};

/** Entry points of the shell frame, the same on every page. */
export const SHELL_ENTRY_POINTS: readonly EntryPoint[] = [
  { role: 'button', name: byKey('menu.trigger'), opens: 'menu' },
  { role: 'button', name: byKey('topbar.refresh') },
];

/** The catalogue keys of the landmark names of the frame (the `main` and the `h1` are checked on their own). */
export const FRAME_LANDMARKS = {
  /** The accessible names of the navigation landmarks (the sidebar `aside` and the main `nav` inside it). */
  complementary: 'shell.sidebar.label',
  navigation: 'nav.label',
} as const satisfies Record<string, PlainKey>;

/**
 * The instance behind every case: a user instance (the Workspace is the page of `/` and has a navigation entry only there) that
 * searches all sessions (the Search entry needs it).
 */
export function matrixInstance(): ReturnType<typeof makeInstance> {
  return makeInstance({
    kind: 'user',
    features: { transcriptSearch: 'instance', costEstimates: false, usageTrend: true, hooks: false },
  });
}

function sessions() {
  const rows = [
    makeSession({ id: MATRIX_SESSION_ID, seq: 1, label: MATRIX_SESSION_LABEL, state: makeState('working') }),
    makeSession({
      id: sessionId(2),
      seq: 2,
      label: 'FIXTURE failing build',
      state: makeState('failed'),
      errorCount: 2,
      lastActivityAt: iso(-1800),
    }),
    makeSession({
      id: sessionId(3),
      seq: 3,
      label: 'FIXTURE waiting for approval',
      state: makeState('waiting_input', { waitReason: 'permission' }),
      lastActivityAt: iso(-600),
    }),
  ];
  return rows;
}

/** The fake API behind every case: valid bodies for every route a page or the frame reads. */
export function matrixHandlers(): FakeHandlers {
  const rows = sessions();
  const events = rows.map((row, index) =>
    makeEvent({
      id: 100 - index,
      seq: 100 - index,
      key: `t:fixture-matrix-${String(index)}`,
      sessionId: row.id,
      sessionLabel: row.label,
      at: iso(-60 - index * 90),
      receivedAt: iso(-59 - index * 90),
      type: index === 1 ? 'tool.failure' : 'tool.call',
      category: index === 1 ? 'error' : 'tool',
      severity: index === 1 ? 'error' : 'info',
      toolName: 'Bash',
      summary: `FIXTURE event ${String(index)}`,
    }),
  );
  const board = makeWorkItemBoard({
    items: [
      makeWorkItem({
        id: 1,
        key: 'backend',
        title: 'FIXTURE backend work',
        state: 'working',
        sessionIds: [sessionId(1)],
      }),
      makeWorkItem({ id: 2, key: 'review', title: 'FIXTURE review', state: 'completed', sessionIds: [sessionId(2)] }),
    ],
  });
  const instance = matrixInstance();
  return {
    instance: () => instance,
    health: () => makeHealth('ok'),
    config: () => makeConfigInspection(),
    overview: () =>
      makeOverview({
        metrics: [
          makeMetric({ key: 'sessions.active', label: 'Active sessions', value: 1 }),
          makeMetric({ key: 'sessions.failed', label: 'Failed', value: 1 }),
          makeMetric({ key: 'events.errors', label: 'Errors', value: 1, link: '/activity?severity=error' }),
          makeMetric({ key: 'tokens.output', label: 'Output tokens', value: 61_400, unit: 'tokens' }),
          makeMetric({ key: 'tokens.input', label: 'Input tokens (uncached)', value: 118_900, unit: 'tokens' }),
          makeMetric({ key: 'tokens.cache_read', label: 'Cache read tokens', value: 9_240_000, unit: 'tokens' }),
        ],
        recentActivity: events,
        recentErrors: events.filter((event) => event.severity === 'error'),
      }),
    listSessions: () => makePage(rows, { total: rows.length }),
    getSession: () => makeSessionDetail({ ...rows[0], cwd: 'FIXTURE project', gitBranch: 'main' }),
    sessionAgents: () =>
      makeAgentPage([
        makeAgent({ sessionId: MATRIX_SESSION_ID, id: 'main', kind: 'main', depth: 0, parentAgentId: null }),
      ]),
    sessionTimeline: () => makeEventPage(events),
    sessionToolCalls: () => makePage([]),
    transcriptWindow: () => makeTranscriptWindow(8, { sessionId: MATRIX_SESSION_ID }),
    listEvents: () => makeEventPage(events),
    searchTranscript: () => makeTranscriptSearch(),
    searchTranscripts: () => makeInstanceSearch(),
    workItemBoard: () => board,
    analyticsUsage: () =>
      makeUsageReport({ rows: [makeUsageRow({ key: 'fixture-model', label: 'fixture-model', sessions: 3 })] }),
    analyticsSeries: () =>
      makeUsageSeries({
        bucket: 'hour',
        points: Array.from({ length: 6 }, (_unused, i) => makeSeriesPoint({ start: iso(-(6 - i) * 3600) })),
      }),
    analyticsTools: () =>
      makeToolFrequencyReport({
        items: [makeToolFrequencyRow({ toolName: 'Bash', calls: 12, succeeded: 10, failed: 2, failurePct: 17 })],
      }),
    panel: (_query, request) =>
      makePanelResponse((request.params['key'] ?? 'ledger') as Parameters<typeof makePanelResponse>[0]),
    // the terminal side of a user instance: this browser holds the session, one terminal runs, two folders are known
    authSession: () => makeAuthSession(true),
    terminalState: () => makeTerminalState([makeTerminalSession(1)]),
    listFolders: () => makeFolderList([makeFolder(1, { activity: 'full' }), makeFolder(2)]),
  };
}

const title = (key: PlainKey): PageCase['heading'] => byKey(key);

/** One entry per page of the route table, in the order of the table. */
export const PAGE_MATRIX: readonly PageCase[] = [
  {
    // With no session selected the pane has no session header: its notice is the heading of the page.
    id: 'workspace',
    path: '/',
    heading: title('workspace.pane.none.title'),
    currentNav: 'workspace',
    entryPoints: [
      { role: 'searchbox', name: byKey('workspace.filter.label') },
      { role: 'button', name: byKey('workspace.otherFolder') },
    ],
    handlers: matrixHandlers,
  },
  {
    id: 'overview',
    path: '/overview',
    heading: title('route.overview.title'),
    currentNav: 'overview',
    entryPoints: [{ role: 'button', name: byKey('panels.git.title') }],
    handlers: matrixHandlers,
  },
  {
    id: 'sessions',
    path: '/sessions',
    heading: title('route.sessions.title'),
    currentNav: 'sessions',
    entryPoints: [
      { role: 'button', name: byKey('filters.more'), opens: 'popover' },
      { role: 'button', name: byKey('sessions.columns.button'), opens: 'popover' },
    ],
    handlers: matrixHandlers,
  },
  {
    id: 'sessionDetail',
    path: `/sessions/${MATRIX_SESSION_ID}`,
    heading: () => MATRIX_SESSION_LABEL,
    currentNav: 'sessions',
    entryPoints: [
      { role: 'button', name: byKey('detail.copyLink') },
      { role: 'button', name: byKey('detail.details') },
      { role: 'searchbox', name: byKey('transcript.toolbar.search') },
    ],
    handlers: matrixHandlers,
  },
  {
    id: 'activity',
    path: '/activity',
    heading: title('route.activity.title'),
    currentNav: 'activity',
    entryPoints: [
      { role: 'button', name: byKey('filters.more'), opens: 'popover' },
      { role: 'button', name: byKey('activity.pause') },
    ],
    handlers: matrixHandlers,
  },
  {
    id: 'tasks',
    path: '/tasks',
    heading: title('route.tasks.title'),
    currentNav: 'tasks',
    entryPoints: [{ role: 'button', name: byKey('tasks.derivation.toggle') }],
    handlers: matrixHandlers,
  },
  {
    id: 'analytics',
    path: '/analytics',
    heading: title('route.analytics.title'),
    currentNav: 'analytics',
    entryPoints: [{ role: 'button', name: byKey('analytics.trend.showTable') }],
    handlers: matrixHandlers,
  },
  {
    id: 'search',
    path: '/search',
    heading: title('route.search.title'),
    currentNav: 'search',
    entryPoints: [{ role: 'searchbox', name: byKey('search.form.query') }],
    handlers: matrixHandlers,
  },
  {
    id: 'settings',
    path: '/settings',
    heading: title('route.settings.title'),
    currentNav: 'settings',
    entryPoints: [{ role: 'link', name: byKey('settings.section.preferences') }],
    handlers: matrixHandlers,
  },
];

// ---- the pages of the browser contract suite ---------------------------------------------------------------------------------------

/** One page the browser contract suite opens (`e2e/qa/contract.ts`). Plain data: this file cannot import the QA tool. */
export interface ContractPageSpec {
  /** Unique; the specs and the known-defect table name a page by it. */
  readonly id: string;
  /** The page of the route table this entry covers. */
  readonly route: PageKey;
  /** The id of the view of the QA tool (`e2e/qa/views.ts`) that opens the page: its mode, its address and its data. */
  readonly view: string;
  /** Replaces the query of the view (without the question mark): another tab of the session page, another section of Settings. */
  readonly query?: string;
  /** The key of the `h1` text, or `null` for a page whose heading is not the name of its route (it comes from the data or the state). */
  readonly heading: PlainKey | null;
  /** A selector that holds once the content of the page is drawn (the heading alone is drawn before the data). */
  readonly content: string;
}

/** The tabs of the session page that its base view does not open. */
export const CONTRACT_DETAIL_TABS = ['errors', 'agents', 'tokens', 'events'] as const;
/** The sections of Settings that its base view does not open. */
export const CONTRACT_SETTINGS_SECTIONS = ['config', 'preferences', 'data', 'about'] as const;

/**
 * Every page of the browser contract: the base view of each route in the order of the route table, then the other tabs of the
 * session page and the other sections of Settings.
 */
export const CONTRACT_PAGES: readonly ContractPageSpec[] = [
  {
    id: 'workspace',
    route: 'workspace',
    view: 'workspace',
    heading: 'workspace.pane.none.title',
    content: '.workspace-pane[data-pane="none-selected"] h1',
  },
  {
    id: 'overview',
    route: 'overview',
    view: 'overview',
    heading: 'route.overview.title',
    content: 'main .overview-tile',
  },
  {
    id: 'sessions',
    route: 'sessions',
    view: 'sessions',
    heading: 'route.sessions.title',
    content: 'main tbody tr, main [data-row]',
  },
  {
    id: 'session-detail-transcript',
    route: 'sessionDetail',
    view: 'session-detail-transcript',
    heading: null,
    content: 'main li[data-row-key]',
  },
  {
    id: 'activity',
    route: 'activity',
    view: 'activity',
    heading: 'route.activity.title',
    content: 'main .activity-row',
  },
  {
    id: 'tasks',
    route: 'tasks',
    view: 'tasks',
    heading: 'route.tasks.title',
    content: 'main .state--empty, main .work-card, main section',
  },
  {
    id: 'analytics',
    route: 'analytics',
    view: 'analytics',
    heading: 'route.analytics.title',
    content: 'main table, main .data-cards',
  },
  { id: 'search', route: 'search', view: 'search', heading: 'route.search.title', content: 'main form' },
  {
    id: 'settings-health',
    route: 'settings',
    view: 'settings-health',
    heading: 'route.settings.title',
    content: 'main section',
  },
  ...CONTRACT_DETAIL_TABS.map((tab): ContractPageSpec => ({
    id: `session-detail-${tab}`,
    route: 'sessionDetail',
    view: 'session-detail-transcript',
    query: `tab=${tab}`,
    heading: null,
    content: 'main nav a[aria-current="page"]',
  })),
  ...CONTRACT_SETTINGS_SECTIONS.map((section): ContractPageSpec => ({
    id: `settings-${section}`,
    route: 'settings',
    view: 'settings-health',
    query: `section=${section}`,
    heading: 'route.settings.title',
    content: 'main section',
  })),
];
