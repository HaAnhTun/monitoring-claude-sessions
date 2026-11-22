// The views the visual QA tool can shoot (WP-122). One base view per route exists from the start, so that every work package can
// capture its page before its own variants exist; a work package that adds variants (loading, error, empty, popovers, tabs)
// writes new entries inside its own marked block below, with ids that no base view and no other block uses.
import type { Page as BrowserPage } from '@playwright/test';

import type {
  ActivityEvent,
  AgentNode,
  InstanceInfo,
  Page,
  SessionDetail,
  SessionSummary,
  ToolCallItem,
} from '@mcs/shared';

import {
  agentId,
  iso,
  makeAgent,
  makeAgentPage,
  makeEvent,
  makeEventPage,
  makePage,
  makeSession,
  makeState,
  makeUsage,
  makeWorkItem,
  makeWorkItemBoard,
  toolUseId,
} from '../../src/test/fixtures/index.ts';
import {
  FIXTURE_RECENT_FOLDER,
  FIXTURE_TERMINALS,
  fixtureId,
  type FixtureApi,
  type FixtureState,
  type TerminalFixtureState,
} from './fixture-api.ts';
import type { QaInstance } from './qa-instance.ts';
import { focusStyleguideTarget, injectStyleguide } from './styleguide.ts';

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
  /**
   * The terminal side of the fake server (fixture mode only). A view that names one gets a user instance, whose first page is the
   * Workspace, with the access, terminal and folder routes and the canned terminal socket; a view that names none keeps the task
   * instance, which has no terminals.
   */
  readonly terminal?: TerminalFixtureState;
  /** Also shot at the wide window sizes (1920x1080 and 1280x720): the workspace, the terminal and the style guide. */
  readonly wide?: boolean;
  /** Also shot in the forced-colours column (1440x900, light, `forced-colors: active`). */
  readonly forcedColors?: boolean;
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

/**
 * Fixture mode, WP-119: serves other agents and events for the detail views of the failing session, reloads the page so that its
 * first draw already holds them, and waits for `ready`. The session has the main agent and two subagents, one of which failed.
 */
async function serveDetail(
  { page, fixture }: ViewContext,
  patch: { agents?: AgentNode[]; events?: ActivityEvent[]; calls?: ToolCallItem[]; warnings?: number },
  ready: string,
): Promise<void> {
  if (fixture === null) return;
  const { agents, events, calls = [], warnings } = patch;
  if (agents !== undefined) fixture.fake.handlers.sessionAgents = () => makeAgentPage(agents);
  if (events !== undefined) fixture.fake.handlers.sessionTimeline = () => makeEventPage(events);
  fixture.fake.handlers.sessionToolCalls = () => makePage(calls);
  const { getSession } = fixture.fake.handlers;
  if (warnings !== undefined && getSession !== undefined) {
    fixture.fake.handlers.getSession = async (query, request) => ({
      ...((await getSession(query, request)) as SessionDetail),
      warningCount: warnings,
    });
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator(ready).first().waitFor({ state: 'visible', timeout: 20_000 });
}

const DETAIL_SESSION = fixtureId(3);

/** The main agent, a subagent that failed and one that completed, each with its own usage and model. */
function detailAgents(): AgentNode[] {
  const base = { sessionId: DETAIL_SESSION };
  return [
    makeAgent({
      ...base,
      id: 'main',
      kind: 'main',
      depth: 0,
      parentAgentId: null,
      label: 'main',
      agentType: null,
      model: null,
      state: makeState('turn_ended'),
      lastActivityAt: iso(-40),
      usage: makeUsage({ output: 18_400, input: 21_000, cacheCreation: 9_000, cacheRead: 1_200_000 }),
    }),
    makeAgent({
      ...base,
      id: agentId(1),
      label: 'Lint helper',
      agentType: 'general-purpose',
      model: 'model-b',
      errorCount: 1,
      toolCallCount: 14,
      state: makeState('failed'),
      lastActivityAt: iso(-9 * 60),
      usage: makeUsage({ output: 3_100, input: 4_200, cacheCreation: 1_800, cacheRead: 210_000 }),
    }),
    makeAgent({
      ...base,
      id: agentId(2),
      label: 'Test runner',
      agentType: 'general-purpose',
      model: 'model-b',
      toolCallCount: 31,
      state: makeState('completed'),
      lastActivityAt: iso(-12 * 60),
      usage: makeUsage({ output: 7_600, input: 6_300, cacheCreation: 2_400, cacheRead: 480_000 }),
    }),
  ];
}

/** The failed call behind the first error: the engine keeps its tool, argument, duration and exit code on the call. */
function detailToolCalls(): ToolCallItem[] {
  return [
    {
      id: 1,
      seq: 1,
      toolUseId: toolUseId(1),
      sessionId: DETAIL_SESSION,
      agentId: agentId(1),
      promptId: null,
      name: 'Grep',
      mcpServer: null,
      status: 'failed',
      outcome: 'error',
      summary: 'TODO in src/**/*.ts',
      inputBytes: null,
      startedAt: iso(-9 * 60 - 4),
      endedAt: iso(-9 * 60),
      batchAt: null,
      durationMs: 4_000,
      durationSource: 'timestamps',
      exitCode: 2,
      sources: ['transcript_use', 'transcript_result'],
      subagentId: null,
      workflowRunId: null,
      transcriptRef: { agentId: agentId(1), offset: 4096 },
    },
  ];
}

/** The warnings and errors of the failing session: a tool that failed after 4 s, an API error without a tool, a denied tool. */
function detailErrors(): ActivityEvent[] {
  const base = { sessionId: DETAIL_SESSION, sessionLabel: 'Release checklist' };
  return [
    makeEvent({
      ...base,
      id: 211,
      key: 't:fixture-error-3',
      at: iso(-9 * 60),
      type: 'tool.failure',
      category: 'error',
      severity: 'error',
      toolName: null,
      toolUseId: toolUseId(1),
      toolStatus: 'failed',
      durationMs: null,
      summary: '',
      agentId: agentId(1),
      agentLabel: 'Lint helper',
    }),
    makeEvent({
      ...base,
      id: 207,
      key: 't:fixture-error-2',
      at: iso(-14 * 60),
      type: 'api.error',
      category: 'error',
      severity: 'error',
      toolName: null,
      summary: 'The model was overloaded; the request was retried twice before it succeeded and the turn went on',
      agentId: null,
      agentLabel: 'main',
    }),
    makeEvent({
      ...base,
      id: 198,
      key: 't:fixture-warning-1',
      at: iso(-21 * 60),
      type: 'permission.denied',
      category: 'notification',
      severity: 'warning',
      toolName: 'Bash',
      toolStatus: 'denied',
      durationMs: null,
      summary: '',
      agentId: agentId(2),
      agentLabel: 'Test runner',
    }),
  ];
}

/** 33 events of one session, newest first, from the three sources, with a status, a duration, an agent and one gap. */
function detailEvents(): ActivityEvent[] {
  const base = { sessionId: DETAIL_SESSION, sessionLabel: 'Release checklist' };
  const shape: Partial<ActivityEvent>[] = [
    {
      type: 'prompt.submit',
      category: 'prompt',
      summary: 'Run the release checklist with helpers',
      sources: ['hook', 'transcript'],
    },
    {
      type: 'assistant.message',
      category: 'prompt',
      summary: 'Starting with the lint check and the tests.',
      sources: ['transcript'],
    },
    { type: 'tool.call', category: 'tool', toolName: 'Bash', summary: 'npm run lint', sources: ['hook', 'transcript'] },
    {
      type: 'tool.result',
      category: 'tool',
      toolName: 'Bash',
      toolStatus: 'succeeded',
      durationMs: 5_200,
      summary: 'Lint finished without problems',
      sources: ['hook', 'transcript'],
    },
    { type: 'agent.start', category: 'agent', summary: 'Lint helper', sources: ['hook'] },
    { type: 'tool.call', category: 'tool', toolName: 'Grep', summary: 'TODO in src', sources: ['transcript'] },
    {
      type: 'tool.failure',
      category: 'error',
      severity: 'error',
      toolName: 'Grep',
      toolStatus: 'failed',
      durationMs: 4_000,
      summary: 'the path src/legacy does not exist',
      sources: ['transcript'],
    },
    { type: 'turn.stop', category: 'lifecycle', summary: '', sources: ['hook'] },
    {
      type: 'permission.request',
      category: 'notification',
      toolName: 'Bash',
      toolStatus: 'pending',
      summary: 'rm -rf build',
      sources: ['hook'],
    },
    {
      type: 'context.compact',
      category: 'compaction',
      summary: 'Context compacted after 168,000 tokens',
      sources: ['transcript'],
    },
  ];
  const events = Array.from({ length: 33 }, (_unused, n): ActivityEvent => {
    const pick = shape[n % shape.length] ?? {};
    const agent =
      n % 4 === 1 ? { agentId: agentId(1), agentLabel: 'Lint helper' } : { agentId: null, agentLabel: 'main' };
    return makeEvent({
      ...base,
      id: 300 - n,
      seq: 300 - n,
      key: `t:fixture-event-${String(n)}`,
      at: iso(-60 - n * 55),
      severity: 'info',
      toolName: null,
      toolStatus: null,
      durationMs: null,
      details: n % 5 === 2 ? { tool_use_id: `toolu_fixture_${String(n)}`, cwd: 'FIXTURE project' } : {},
      ...pick,
      ...agent,
    });
  });
  events.splice(
    12,
    1,
    makeEvent({
      ...base,
      id: 288,
      seq: 288,
      key: 'm:fixture-gap',
      at: iso(-60 - 12 * 55),
      type: 'monitor.gap',
      category: 'ingest',
      source: 'monitor',
      sources: ['monitor'],
      summary: 'the transcript was rewritten',
      transcriptRef: null,
    }),
  );
  return events;
}

/** The page heading: every page has one, so it is the generic sign that the page is drawn. */
const HEADING = 'main h1';

// ---- the Workspace and its terminals (CAW-49) --------------------------------------------------------------------------------------

/** The terminal pane with nothing selected: its notice is the heading of the page. */
const NONE_SELECTED = '.workspace-pane[data-pane="none-selected"] h1';

/** The host of an open terminal once xterm exists in it (the host then says its size). */
const TERMINAL_HOST = '.workspace-pane[data-pane="terminal"] [data-terminal][data-cols][data-rows]';

/** Below this width the project list of the Workspace is an overlay that a button opens (`MQ_LIST_OVERLAY` of the app). */
const LIST_OVERLAY_BELOW_PX = 1024;

const listIsOverlay = (page: BrowserPage): boolean => (page.viewportSize()?.width ?? 0) < LIST_OVERLAY_BELOW_PX;

const sessionQuery = (name: string): string => `session=${encodeURIComponent(name)}`;

/** The project list shows its folders, the monitor state of a linked terminal and the recent sessions of the first folder. */
async function projectListDrawn(page: BrowserPage): Promise<void> {
  const column = page.locator('.workspace-sidebar');
  await column
    .locator('.workspace-session [data-state="working"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 });
  await column.locator('.workspace-recent__row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

/** Waits for the project column where it is a column. Below 1024 px it is not drawn until it is opened: nothing to wait for. */
async function projectColumnDrawn({ page }: ViewContext): Promise<void> {
  if (!listIsOverlay(page)) await projectListDrawn(page);
}

/** Opens the project list where it is an overlay (the button of the pane), and waits for its content at every width. */
async function openProjectList(page: BrowserPage): Promise<void> {
  if (listIsOverlay(page)) {
    await page
      .locator('.workspace-pane [aria-controls="project-list"], .workspace-pane .state__actions .btn-quiet')
      .first()
      .click();
    await page.locator('.workspace-sidebar[data-open="true"]').waitFor({ state: 'visible', timeout: 20_000 });
  }
  await projectListDrawn(page);
}

/** Fixture mode: the canned terminal of `name` has drawn its screen, for the size the terminal has on the page now. */
async function terminalDrawn({ page, fixture }: ViewContext, name: string): Promise<void> {
  const terminal = fixture?.terminal ?? null;
  if (terminal === null) throw new Error('this view needs the terminal side of the fixture API');
  await terminal.socket.settle(page, name);
}

/** An open terminal of the fixture: the address selects it and the shot waits for its screen. */
function terminalView(id: string, name: string, more: Partial<ViewSpec> = {}): ViewSpec {
  return {
    id,
    path: '/',
    mode: 'fixture',
    terminal: 'ok',
    query: sessionQuery(name),
    wait: TERMINAL_HOST,
    setup: (context) => terminalDrawn(context, name),
    ...more,
  };
}

/** A state of the terminal side in which the pane shows a notice instead of a terminal. */
function noticeView(id: string, terminal: TerminalFixtureState, pane: string, what = 'h1'): ViewSpec {
  return { id, path: '/', mode: 'fixture', terminal, wait: `.workspace-pane[data-pane="${pane}"] ${what}` };
}

export const VIEWS: readonly ViewSpec[] = [
  // ---- base views: one per route, defined by WP-122 (live mode) ----
  // The Workspace is the page of `/` (CAW-49). Only a user instance has it, and its terminals need the access session and a
  // socket, so its base view is the one fixture view of this list: the project column and nothing selected.
  {
    id: 'workspace',
    path: '/',
    mode: 'fixture',
    terminal: 'ok',
    wide: true,
    forcedColors: true,
    wait: NONE_SELECTED,
    setup: projectColumnDrawn,
  },
  { id: 'overview', path: '/overview', mode: 'live', wait: HEADING },
  { id: 'sessions', path: '/sessions', mode: 'live', wait: HEADING, forcedColors: true },
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
  // The base view `overview` (live mode) is WP-122's. These are the variants of the Overview (`/overview` since CAW-49).
  { id: 'overview-empty', path: '/overview', mode: 'fixture', state: 'empty', wait: 'main .state--empty' },
  {
    // Only the overview route answers 500: the sessions, the ingestion summary and the feed stay usable.
    id: 'overview-error',
    path: '/overview',
    mode: 'fixture',
    wait: HEADING,
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      const { errorResponse } = await import('../../src/test/fake-api.ts');
      fixture.fake.handlers.overview = () => errorResponse('internal_error');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('main .state--error').first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator('main .attention-item').first().waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  // Every route answers 500: the sessions and the figures each say so, the strip shows dashes.
  { id: 'overview-total-error', path: '/overview', mode: 'fixture', state: 'error', wait: 'main .state--error' },
  { id: 'overview-loading', path: '/overview', mode: 'fixture', state: 'loading', wait: 'main .skeleton--tiles' },
  {
    id: 'overview-disconnected',
    path: '/overview',
    mode: 'fixture',
    state: 'disconnected',
    wait: 'main .overview-tile',
  },
  {
    // The info tip of the first token tile open: source and rule as the server wrote them.
    id: 'overview-tip',
    path: '/overview',
    mode: 'fixture',
    wait: 'main .overview-tile',
    setup: async ({ page }) => {
      await page.locator('main [data-metric="tokens.output"] .info-tip button').click();
      await page.locator('main [data-metric="tokens.output"] .popover__panel').waitFor({ state: 'visible' });
    },
  },
  // @wp-end WP-54
  // @wp-begin WP-65
  // The workspace panels in the right column of the Overview. Before the shot every open panel has drawn its body, and the page is
  // scrolled so that the panels are the first thing in view (the column starts below the ingestion summary).
  {
    // The live instance enables Machine, Git and Ledger, so the machine, the repository and the ledger are the real ones of the QA
    // folder. Below 900 px the panels start collapsed, which is the state this view shows there.
    id: 'overview-panels',
    path: '/overview',
    mode: 'live',
    wait: 'main .workspace-panels .panel[data-panel="git"]',
    setup: async ({ page }) => {
      // No open panel is still loading (a panel that failed is a state worth shooting too).
      const loading = page.locator(
        'main .workspace-panels .panel[data-status="loading"]:has(.panel-toggle[aria-expanded="true"])',
      );
      const deadline = Date.now() + 20_000;
      while ((await loading.count()) > 0) {
        if (Date.now() > deadline) throw new Error('a panel is still loading');
        await page.waitForTimeout(100);
      }
      await page.evaluate(
        `document.querySelector('main .workspace-panels')?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -72);`,
      );
    },
  },
  {
    // The same panels with every one of them open, whatever the width: the small-window view of their bodies.
    id: 'overview-panels-open',
    path: '/overview',
    mode: 'live',
    wait: 'main .workspace-panels .panel[data-panel="git"]',
    setup: async ({ page }) => {
      const toggles = page.locator('main .workspace-panels .panel-toggle[aria-expanded="false"]');
      await page.locator('main .workspace-panels .panel-toggle').first().waitFor({ state: 'visible', timeout: 20_000 });
      while ((await toggles.count()) > 0) await toggles.first().click();
      // No open panel is still loading (a panel that failed is a state worth shooting too).
      const loading = page.locator(
        'main .workspace-panels .panel[data-status="loading"]:has(.panel-toggle[aria-expanded="true"])',
      );
      const deadline = Date.now() + 20_000;
      while ((await loading.count()) > 0) {
        if (Date.now() > deadline) throw new Error('a panel is still loading');
        await page.waitForTimeout(100);
      }
      await page.evaluate(
        `document.querySelector('main .workspace-panels')?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -72);`,
      );
    },
  },
  {
    // Every panel in a state of its own: Git with the STOP file and a long branch name, Machine partial (memory high, CPU not
    // supported, Docker unavailable), Attempts with every result, Ledger with PASS and FAIL cells, a chain log that holds a hostile
    // line, Logs with one file being written and one idle, one of them stale. All panels are open.
    id: 'overview-panels-partial',
    path: '/overview',
    mode: 'fixture',
    wait: 'main .workspace-panels .panel[data-panel="git"]',
    setup: async ({ page, fixture }) => {
      if (fixture === null) return;
      const f = await import('../../src/test/fixtures/index.ts');
      type Attempt = ReturnType<typeof f.makePanelData<'attempts'>>['rows'][number];
      const attempt = (n: number, over: Partial<Attempt>): Attempt => ({
        part: `build step ${String(n)}`,
        n,
        model: 'FIXTURE-model',
        effort: 'high',
        startedAt: f.iso(-3600 + n * 300),
        endedAt: f.iso(-3600 + n * 300 + 240),
        exit: 0,
        status: 'PASS',
        state: 'COMPLETED',
        sessionId: null,
        usage: f.makeUsage({ output: 4200 * n }),
        attemptId: n,
        nRaw: String(n),
        exitRaw: '0',
        endReason: 'ended',
        evidence: 'the log line of the part matched a transcript that started 2s later',
        matchDeltaS: 2,
        ...over,
      });
      const hostile = '<img src=x onerror=alert(1)> FIXTURE hostile line';
      fixture.fake.handlers.panel = (_query, request) => {
        switch (request.params['key'] ?? 'logs') {
          case 'git':
            return f.makePanelResponse('git', {
              data: {
                ...f.makePanelData('git'),
                branch: 'feature/a-rather-long-branch-name-for-the-overview-panel',
                dirty: 3,
                stopFile: true,
                commits: [
                  {
                    hash: 'a1b2c3d4e5f6',
                    subject: 'Parse the transcript tail without reading the whole file',
                    at: f.iso(-600),
                  },
                  { hash: '0f9e8d7c6b5a', subject: 'Add the machine panel samplers', at: f.iso(-7200) },
                  { hash: '1122334455aa', subject: 'Fix the stale marker of a list', at: f.iso(-90_000) },
                ],
              },
            });
          case 'machine':
            return f.makePanelResponse('machine', {
              status: 'partial',
              sources: [
                { source: 'memory', status: 'ok', sampledAt: f.iso(-1), message: null },
                {
                  source: 'cpu',
                  status: 'unsupported',
                  sampledAt: null,
                  message: 'CPU load is not available on this platform',
                },
                { source: 'processes', status: 'ok', sampledAt: f.iso(-2), message: null },
                {
                  source: 'docker',
                  status: 'unavailable',
                  sampledAt: f.iso(-5),
                  message: 'the docker command was not found',
                },
              ],
              data: {
                ...f.makePanelData('machine'),
                usedPct: 88,
                totalGb: 16,
                freeGb: 1.9,
                cpuPct: null,
                procs: [
                  { name: 'node', count: 4, mb: 1234 },
                  { name: 'claude', count: 2, mb: 880 },
                  { name: 'a-process-with-a-rather-long-name', count: 1, mb: null },
                ],
                procsStatus: 'ok',
                dockerEnabled: true,
                dockerStatus: 'unavailable',
                docker: [],
              },
            });
          case 'attempts':
            return f.makePanelResponse('attempts', {
              data: {
                sourceState: 'ok',
                rows: [
                  attempt(1, { sessionId: fixtureId(1) }),
                  attempt(2, { state: 'FAILED', status: 'FAIL', exit: 1, sessionId: fixtureId(2) }),
                  attempt(3, {
                    state: 'RUNNING',
                    endedAt: null,
                    status: null,
                    exit: null,
                    endReason: 'open',
                    usage: null,
                  }),
                  attempt(4, {
                    state: null,
                    status: null,
                    exit: null,
                    model: null,
                    effort: null,
                    part: 'a part whose name is rather long indeed',
                  }),
                ],
              },
            });
          case 'ledger':
            return f.makePanelResponse('ledger', {
              data: {
                lines: [
                  '| part | result | note |',
                  '| --- | --- | --- |',
                  '| backend build | PASS | 412 tests |',
                  '| frontend build | FAIL | 2 type errors |',
                  '| deploy | BLOCKED | waiting for the build |',
                ],
                file: 'ledger/progress.md',
                exists: true,
                sizeBytes: 540,
                modifiedAt: f.iso(-300),
              },
            });
          case 'chainLog':
            return f.makePanelResponse('chainLog', {
              data: {
                lines: [
                  '[10:01:02] step A started',
                  '[10:04:11] step A finished',
                  hostile,
                  '[10:04:12] step B started with a long line that needs to wrap inside the narrow column of the overview page',
                ],
                file: 'chain.log',
                exists: true,
                sizeBytes: 300,
                modifiedAt: f.iso(-20),
              },
            });
          default:
            return f.makePanelResponse('logs', {
              generatedAt: f.iso(-120),
              data: {
                matchedFiles: 6,
                files: [
                  {
                    name: 'backend.log',
                    ageS: 4,
                    sizeBytes: 1_250_000,
                    tail: ['INFO server started', 'INFO request handled in 12 ms', hostile],
                    relPath: 'logs/backend.log',
                    modifiedAt: f.iso(-4),
                  },
                  {
                    name: 'worker.log',
                    ageS: 640,
                    sizeBytes: 8200,
                    tail: ['INFO worker idle'],
                    relPath: 'logs/worker.log',
                    modifiedAt: f.iso(-640),
                  },
                ],
              },
            });
        }
      };
      await page.reload({ waitUntil: 'domcontentloaded' });
      const toggles = page.locator('main .workspace-panels .panel-toggle[aria-expanded="false"]');
      await page.locator('main .workspace-panels .panel-toggle').first().waitFor({ state: 'visible', timeout: 20_000 });
      while ((await toggles.count()) > 0) await toggles.first().click();
      await page
        .locator('main .workspace-panels .panel[data-panel="logs"] .panel-log')
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 });
      await page
        .locator('main .workspace-panels .panel[data-panel="machine"] .meter')
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 });
      await page.evaluate(
        `document.querySelector('main .workspace-panels')?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -72);`,
      );
    },
  },
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
    // The tab bar stays at the top of the window while the page scrolls. The page is made long (the demo transcript is short) by a
    // blank block under the transcript, then scrolled until the bar would have left the window; the bar must still be at y = 0.
    id: 'session-detail-scrolled',
    path: '/sessions/:sessionId',
    mode: 'live',
    wait: 'main .session-frame h1',
    params: detail,
    setup: async ({ page }) => {
      await page.locator('main .tv-list .tr').first().waitFor({ state: 'visible', timeout: 20_000 });
      const measured: unknown = await page.evaluate(
        `(() => {
          const bar = document.querySelector('main nav.session-tabs');
          const section = bar && bar.parentElement;
          if (!bar || !section) return { top: null, scrolled: 0 };
          const filler = document.createElement('div');
          filler.setAttribute('aria-hidden', 'true');
          filler.style.height = '3000px';
          section.appendChild(filler);
          const natural = bar.getBoundingClientRect().top + window.scrollY;
          window.scrollTo(0, natural + 120);
          return { top: bar.getBoundingClientRect().top, scrolled: window.scrollY };
        })()`,
      );
      const { top, scrolled } = measured as { top: number | null; scrolled: number };
      if (top === null) throw new Error('the page has no tab bar');
      if (scrolled <= 0) throw new Error('the page did not scroll');
      if (Math.abs(top) > 1)
        throw new Error(`the tab bar is at y = ${String(top)} after scrolling ${String(scrolled)} px`);
    },
  },
  // @wp-end WP-118
  // @wp-begin WP-119
  {
    // The errors of the failing session (a tool that failed after 4 s, an API error and a denied tool): the tool in bold, the first
    // line of the message, the event number and time, and the button that opens the entry in the transcript.
    id: 'session-detail-errors',
    path: '/sessions/:sessionId',
    mode: 'fixture',
    wait: 'main .session-frame h1',
    params: detail,
    query: 'tab=errors',
    setup: (context) =>
      serveDetail(
        context,
        { events: detailErrors(), calls: detailToolCalls(), warnings: 1 },
        'main .errors-tab .error-row--error',
      ),
  },
  {
    // The main agent and two subagents (one failed, one completed): the main agent is not a subagent, so the tab counts 2, and the tables
    // have the columns of the Sessions list.
    id: 'session-detail-agents',
    path: '/sessions/:sessionId',
    mode: 'fixture',
    wait: 'main .session-frame h1',
    params: detail,
    query: 'tab=agents',
    setup: (context) => serveDetail(context, { agents: detailAgents() }, 'main .agent-tree .agent-cell__label'),
  },
  {
    // The five totals of the session and the table per agent with its Total row.
    id: 'session-detail-tokens',
    path: '/sessions/:sessionId',
    mode: 'fixture',
    wait: 'main .session-frame h1',
    params: detail,
    query: 'tab=tokens',
    setup: (context) => serveDetail(context, { agents: detailAgents() }, 'main .session-tokens tr.token-total-row'),
  },
  {
    // 33 events, one line each, from the hooks and the transcript, with a gap row: they have to fit two screens.
    id: 'session-detail-events',
    path: '/sessions/:sessionId',
    mode: 'fixture',
    wait: 'main .session-frame h1',
    params: detail,
    query: 'tab=events',
    setup: (context) => serveDetail(context, { events: detailEvents() }, 'main .event-row--gap'),
  },
  {
    // The same tab on the real demo instance: what the engine records for the error of the failing helper (the tool, the time, the
    // event number), with no message body, because the monitor never stores one.
    id: 'session-detail-errors-live',
    path: '/sessions/:sessionId',
    mode: 'live',
    wait: 'main .errors-tab .error-row--error',
    params: detail,
    query: 'tab=errors',
  },
  {
    // The events the real instance recorded for the failing session, as the engine writes them.
    id: 'session-detail-events-live',
    path: '/sessions/:sessionId',
    mode: 'live',
    wait: 'main .event-list .event-row',
    params: detail,
    query: 'tab=events',
  },
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
  // @wp-begin CAW-35
  // The style guide (design 05 section 7.2): a static page of every primitive and state, injected into the loaded app so that the
  // real stylesheets draw it. It rides on the catch-all route (the lightest page with the full shell). The focus view puts the focus
  // on the guide's focus target with Tab presses. Both are shot at the matrix sizes; the page grows to the height of the guide.
  {
    id: 'styleguide',
    path: '*',
    mode: 'live',
    wide: true,
    forcedColors: true,
    wait: HEADING,
    params: () => ({ '*': 'qa-style-guide' }),
    setup: async ({ page, locale }) => {
      await injectStyleguide(page, locale);
    },
  },
  {
    id: 'styleguide-focus',
    path: '*',
    mode: 'live',
    wide: true,
    wait: HEADING,
    params: () => ({ '*': 'qa-style-guide' }),
    setup: async ({ page, locale }) => {
      await injectStyleguide(page, locale);
      await focusStyleguideTarget(page);
    },
  },
  // @wp-end CAW-35
  // @wp-begin CAW-49
  // The Workspace and its terminals (design 05 section 7.2, design 04 section 12.4, last paragraph). Every one is a fixture view with
  // a terminal state: the fake instance is a user instance and `terminal-fixture.ts` answers the socket. The base view `workspace`
  // is with the base views above. The views with a terminal and the project list are also shot at the wide sizes.
  {
    // The project list as the subject: three open folders with their live rows in every row state (linked with tokens, starting,
    // not linked, waiting for a permission, several candidates), the recent sessions with Resume and the native-terminal button.
    // Below 1024 px the list is an overlay, opened here with the button of the pane.
    id: 'workspace-projects',
    path: '/',
    mode: 'fixture',
    terminal: 'ok',
    wide: true,
    wait: NONE_SELECTED,
    setup: ({ page }) => openProjectList(page),
  },
  {
    // The end of the same list: a folder with a long name, one whose path is unknown (it cannot start a session) and one that was
    // moved, above the footer. Two of the last folders are opened first, then the list is scrolled to its last folder.
    id: 'workspace-projects-end',
    path: '/',
    mode: 'fixture',
    terminal: 'ok',
    wait: NONE_SELECTED,
    setup: async ({ page }) => {
      await openProjectList(page);
      for (const name of ['archived-notes', 'a-project-folder-with-a-rather-long-name']) {
        await page.locator('.workspace-folder__head', { hasText: name }).click();
        await page
          .locator('.workspace-folder[data-open="true"]', { hasText: name })
          .waitFor({ state: 'visible', timeout: 20_000 });
      }
      await page.locator('.workspace-folder').last().scrollIntoViewIfNeeded();
    },
  },
  // An open session that the monitor follows: the header with its state, tokens and viewers, and a screen like a real session.
  terminalView('workspace-session', FIXTURE_TERMINALS.session, {
    wide: true,
    setup: async (context) => {
      await terminalDrawn(context, FIXTURE_TERMINALS.session);
      await context.page
        .locator('.workspace-header [data-state="working"]')
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 });
    },
  }),
  // The 16 ANSI colours as text and background, bold, dim, inverse, the colour ramps, the glyphs and the box drawing, in a frame.
  terminalView('terminal-colors', FIXTURE_TERMINALS.colors, { wide: true }),
  // The 134 Vietnamese letters outside ASCII in each of the 16 colours: the stacked marks must not be cut between two rows.
  terminalView('terminal-vi', FIXTURE_TERMINALS.vietnamese, { wide: true }),
  // The process exits with code 0 while the page shows it: the banner, the two ways on, and the last screen under them.
  terminalView('terminal-ended', FIXTURE_TERMINALS.waiting, {
    setup: async (context) => {
      await terminalDrawn(context, FIXTURE_TERMINALS.waiting);
      context.fixture?.terminal?.socket.end(FIXTURE_TERMINALS.waiting, 0);
      await context.page.locator('.workspace-ended').waitFor({ state: 'visible', timeout: 20_000 });
    },
  }),
  // "Stop session" was pressed: the danger dialog over the terminal, nothing confirmed.
  terminalView('workspace-kill-dialog', FIXTURE_TERMINALS.session, {
    setup: async (context) => {
      await terminalDrawn(context, FIXTURE_TERMINALS.session);
      await context.page.locator('.workspace-header__actions [data-tone="danger"]').click();
      await context.page.locator('dialog.dialog--danger[open]').waitFor({ state: 'visible', timeout: 20_000 });
    },
  }),
  {
    // Resume of a recent session: the server was asked first and said yes, so the dialog names the folder and offers Resume.
    id: 'workspace-resume-dialog',
    path: '/',
    mode: 'fixture',
    terminal: 'ok',
    wait: NONE_SELECTED,
    setup: async ({ page }) => {
      await openProjectList(page);
      await page
        .locator('.workspace-folder', { hasText: FIXTURE_RECENT_FOLDER })
        .locator('.workspace-recent__row [data-nav-id^="resume:"]')
        .first()
        .click();
      await page.locator('dialog.dialog[open] .dialog__path').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  {
    // "Other folder" while a folder dialog is already open on the computer (409 picker_busy): the error toast.
    id: 'workspace-folder-picker-busy',
    path: '/',
    mode: 'fixture',
    terminal: 'ok',
    wait: NONE_SELECTED,
    setup: async (context) => {
      const { page, fixture } = context;
      if (fixture === null) return;
      await projectColumnDrawn(context);
      const { errorResponse } = await import('../../src/test/fake-api.ts');
      fixture.fake.handlers.terminalPickFolder = () => errorResponse('picker_busy');
      // where the column is hidden the notice of the pane carries the button, else the footer of the column does
      const button = listIsOverlay(page)
        ? page.locator('.workspace-pane .state__actions .btn-primary')
        : page.locator('.workspace-sidebar [data-nav-id="other-folder"]');
      await button.click();
      await page.locator('.toast--error').first().waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  // This browser holds no session of the terminal side: the pane asks for the access link, and there is no project column.
  noticeView('workspace-no-access', 'locked', 'locked'),
  // Terminals cannot run on this system, for each of the three reasons the capabilities carry.
  noticeView('workspace-unsupported-os', 'unsupported_os', 'unavailable'),
  noticeView('workspace-claude-missing', 'claude_not_found', 'unavailable'),
  noticeView('workspace-addon-missing', 'addon_missing', 'unavailable'),
  {
    // No folder and no terminal yet: the empty state of the column with its one button, and nothing selected.
    ...noticeView('workspace-empty', 'empty', 'none-selected'),
    setup: async ({ page }) => {
      if (listIsOverlay(page)) return;
      await page.locator('.workspace-sidebar .state--empty').waitFor({ state: 'visible', timeout: 20_000 });
    },
  },
  // The terminal state and the folders never answer: the pane and the column wait.
  noticeView('workspace-loading', 'loading', 'loading'),
  // Both answer 500: the pane says so with Retry (the column too, where it is drawn).
  noticeView('workspace-error', 'error', 'error', '.state--error'),
  // The address names a session that is not running.
  { ...noticeView('workspace-not-found', 'ok', 'not-found'), query: sessionQuery('gone-1') },
  // @wp-end CAW-49
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
