// FIXTURE: invented data for the visual QA tool (WP-122, fixture mode).
// The fake API of the web tests (`src/test/fake-api.ts`, every body validated against its route schema) bridged to Playwright:
// `page.route` answers every `/api/v3/**` request from it, and the event stream is aborted so the app falls back to polling.
// Fixture mode shows what a real instance cannot show quickly: every lifecycle state at once, a request that never finishes
// (loading), an answer of 500 (error), no data (empty) and a server that goes away after the page was drawn (disconnected).
// Every timestamp of the fixtures is shifted so that "now" of the fixtures is the real now: relative times read right.
// CAW-49 adds the terminal side: a view that names a terminal state gets a user instance (the Workspace is its first page) with
// the access, terminal, folder and resume routes and the canned terminal socket of `terminal-fixture.ts`. A view that names
// none keeps the task instance it always had, where those routes do not exist.
import type { Page, Route } from '@playwright/test';

import {
  ERROR_HTTP_STATUS,
  PRODUCT_NAME,
  routes,
  type ActivityEvent,
  type CostEstimate,
  type Folder,
  type LifecycleState,
  type PanelKey,
  type ResumeEligibility,
  type SessionSummary,
  type TerminalSessionInfo,
  type TerminalState,
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
  makeFolder,
  makeFolderList,
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
  makeTerminalCapabilities,
  makeTerminalLink,
  makeTerminalSession,
  makeTerminalState,
  makeToolFrequencyReport,
  makeToolFrequencyRow,
  makeTranscriptSearch,
  makeTranscriptWindow,
  makeUnavailableTerminalState,
  makeUsage,
  makeUsageReport,
  makeUsageRow,
  makeUsageSeries,
  makeWorkItem,
  makeWorkItemBoard,
} from '../../src/test/fixtures/index.ts';
import { routeTerminalSocket, type TerminalFixture } from './terminal-fixture.ts';
import type { SampleName } from './terminal-sample.ts';

/** What the fake server does. `ok` answers every route with data; the others are the states a real instance cannot show quickly. */
export const FIXTURE_STATES = ['ok', 'loading', 'error', 'empty', 'disconnected'] as const;
export type FixtureState = (typeof FIXTURE_STATES)[number];

/**
 * What the terminal side of the fake server does (design 04 section 8.1), next to `FixtureState`, which is about the monitor
 * routes: `ok` has folders and live terminals; `locked` is a browser without the session; the three reasons are a system where
 * terminals cannot run; `empty` has no folder and no terminal; `loading` never answers the terminal state and the folders;
 * `error` answers them with 500.
 */
export const TERMINAL_FIXTURE_STATES = [
  'ok',
  'locked',
  'unsupported_os',
  'addon_missing',
  'claude_not_found',
  'empty',
  'loading',
  'error',
] as const;
export type TerminalFixtureState = (typeof TERMINAL_FIXTURE_STATES)[number];

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

// ---- the terminal side (CAW-49) ----------------------------------------------------------------------------------------------------

const BACKSLASH = String.fromCharCode(92);

/** The path of a fixture folder: a Windows path (terminals run on Windows), invented, with the word FIXTURE in it. */
function fixturePath(name: string): string {
  return ['D:', 'FIXTURE', name].join(BACKSLASH);
}

/** The project key of a fixture folder: the name of its folder under the Claude projects folder, in lower case. */
function fixtureFolderKey(name: string): string {
  return `d--fixture-${name}`;
}

/** The names of the live terminals of the fixture, by what each one shows. A name is `<folder name>-<n>`, as the engine names them. */
export const FIXTURE_TERMINALS = {
  /** Linked to a monitored session that is working: the header has its state and tokens. The screen is a session. */
  session: 'billing-service-1',
  /** Linked to a monitored session that waits for input. */
  waiting: 'billing-service-2',
  /** Just started: no link yet and no reason. */
  starting: 'search-index-1',
  /** Not linked, with the reason of the server. */
  notLinked: 'search-index-2',
  /** Linked without a transcript: the registry says the process waits for a permission. */
  registry: 'search-index-3',
  /** Several candidates: the monitor cannot say which session it is. */
  ambiguous: 'search-index-4',
  /** The colours screen of `terminal-sample.ts`. */
  colors: 'terminal-samples-1',
  /** The Vietnamese screen of `terminal-sample.ts`. */
  vietnamese: 'terminal-samples-2',
} as const;

/** The screen of each fixture terminal that does not show the default one. */
const FIXTURE_TERMINAL_SAMPLES: Readonly<Record<string, SampleName>> = {
  [FIXTURE_TERMINALS.colors]: 'colors',
  [FIXTURE_TERMINALS.vietnamese]: 'vietnamese',
};

/** The name of the folder that has six recent sessions: the Workspace lists five with a Resume button, and "All sessions". */
export const FIXTURE_RECENT_FOLDER = 'billing-service';

/** The recent sessions of the fixture folders, by folder name: numbers of `fixtureSessions` rows. */
const FIXTURE_RECENT: Readonly<Record<string, readonly number[]>> = {
  [FIXTURE_RECENT_FOLDER]: [3, 7, 8, 11, 12, 9],
  'search-index': [9, 10],
};

function fixtureFolders(): Folder[] {
  const folder = (name: string, over: Partial<Folder> = {}): Folder =>
    makeFolder(1, {
      key: fixtureFolderKey(name),
      name,
      path: fixturePath(name),
      origins: ['da', 'claude'],
      ...over,
    });
  const memory = (
    summary: string,
    activity: Folder['activity'],
    brain: number,
    action: number,
    ageSec: number,
  ): Pick<Folder, 'da' | 'activity' | 'lastActivityAt'> => ({
    activity,
    lastActivityAt: iso(-ageSec),
    da: { lastUpdatedAt: iso(-ageSec), activity, summary, brain, action },
  });
  const claude = (name: string, total: number, active: number, ageSec: number): Folder['claude'] => ({
    dirName: fixtureFolderKey(name),
    sessionsInWindow: Math.min(total, 6),
    activeSessions: active,
    totalSessions: total,
    lastSessionAt: iso(-ageSec),
  });
  const longName = 'a-project-folder-with-a-rather-long-name-for-the-project-column';
  return [
    folder('billing-service', {
      ...memory('Moving to the new payment provider; the integration tests are next.', 'full', 42, 7, 90),
      claude: claude('billing-service', 31, 2, 90),
    }),
    folder('search-index', {
      ...memory(
        'Rebuilding the search index in the background and comparing the result with the old index, shard by shard.',
        'half',
        18,
        3,
        5 * 3600,
      ),
      claude: claude('search-index', 12, 4, 5 * 3600),
    }),
    folder('terminal-samples', {
      origins: ['user'],
      pathSource: 'user',
      group: 'outside-da',
      userAdded: true,
    }),
    folder('docs-site', {
      ...memory('Publishing the new guides.', 'half', 6, 1, 9 * 3600),
      claude: claude('docs-site', 4, 0, 9 * 3600),
    }),
    folder(longName, {
      ...memory('A summary of a folder with a long name.', 'none', 2, 0, 3 * 86_400),
      claude: claude(longName, 2, 0, 3 * 86_400),
    }),
    folder('mobile-app', { ...memory('', 'none', 0, 0, 6 * 86_400), claude: claude('mobile-app', 9, 0, 6 * 86_400) }),
    folder('archived-notes', {
      path: null,
      pathSource: 'none',
      exists: null,
      canStart: false,
      origins: ['claude'],
      group: 'outside-da',
      claude: claude('archived-notes', 1, 0, 40 * 86_400),
    }),
    folder('infra-scripts', {
      exists: false,
      canStart: false,
      ...memory('The folder was moved; its memory is still here.', 'none', 11, 2, 12 * 86_400),
    }),
  ];
}

function fixtureTerminalSessions(): TerminalSessionInfo[] {
  let n = 0;
  const live = (
    name: string,
    link: Partial<TerminalSessionInfo['link']>,
    over: Partial<TerminalSessionInfo> = {},
  ): TerminalSessionInfo => {
    n += 1;
    const folderName = name.slice(0, name.lastIndexOf('-'));
    return makeTerminalSession(n, {
      name,
      path: fixturePath(folderName),
      folderKey: fixtureFolderKey(folderName),
      createdAt: iso(-n * 9 * MINUTE),
      link: makeTerminalLink(link),
      ...over,
    });
  };
  const linked = (
    id: string,
    transcript: 'none' | 'tracked',
    registryStatus: 'busy' | 'idle' | 'waiting',
  ): Partial<TerminalSessionInfo['link']> => ({
    status: 'linked',
    sessionId: id,
    basis: 'registry-pid',
    confidence: 'high',
    since: iso(-8 * MINUTE),
    claudePid: 41_000 + n,
    transcript,
    registryStatus,
  });
  return [
    live(FIXTURE_TERMINALS.session, linked(fixtureId(1), 'tracked', 'busy'), { viewers: 2 }),
    live(FIXTURE_TERMINALS.waiting, linked(fixtureId(6), 'tracked', 'waiting')),
    live(FIXTURE_TERMINALS.starting, {}),
    live(FIXTURE_TERMINALS.notLinked, { reason: 'no_registry' }),
    live(FIXTURE_TERMINALS.registry, {
      ...linked(fixtureId(21), 'none', 'waiting'),
      waitingFor: 'permission: Bash',
    }),
    live(FIXTURE_TERMINALS.ambiguous, { status: 'ambiguous', reason: 'ambiguous' }),
    live(FIXTURE_TERMINALS.colors, linked(fixtureId(22), 'none', 'idle')),
    live(FIXTURE_TERMINALS.vietnamese, linked(fixtureId(23), 'none', 'busy')),
  ];
}

/** The terminal side of the fake server: what the routes answer from, and the canned socket. A view may change any of it. */
export interface FixtureTerminal {
  state: TerminalFixtureState;
  /** Whether the browser holds the session: `locked` starts without it, a redeemed code sets it, a logout clears it. */
  authenticated: boolean;
  /** The live terminals; a started or resumed one is appended, a stopped one removed. */
  sessions: TerminalSessionInfo[];
  folders: Folder[];
  /** The canned socket: `socket.settle(page, name)` waits for the screen, `socket.end(name, code)` ends the process. */
  readonly socket: TerminalFixture;
}

/** `GET /sessions/:sessionId/resume`: one answer of each kind, by the number of the fixture session. */
function fixtureResumeEligibility(id: string): ResumeEligibility {
  const folder = { key: fixtureFolderKey(FIXTURE_RECENT_FOLDER), path: fixturePath(FIXTURE_RECENT_FOLDER) };
  const base: ResumeEligibility = {
    sessionId: id,
    allowed: true,
    forkAllowed: true,
    reason: null,
    folder,
    liveElsewhere: false,
    liveTerminal: null,
    redirectTo: null,
  };
  // open in another program: only a copy is safe
  if (id === fixtureId(7)) return { ...base, allowed: false, reason: 'live_elsewhere', liveElsewhere: true };
  // the folder is gone: refused
  if (id === fixtureId(8))
    return { ...base, allowed: false, forkAllowed: false, reason: 'folder_missing', folder: null };
  // a terminal of this app runs it already
  if (id === fixtureId(1)) {
    return {
      ...base,
      allowed: false,
      forkAllowed: false,
      reason: 'live_in_terminal',
      liveTerminal: FIXTURE_TERMINALS.session,
    };
  }
  return base;
}

function terminalHandlers(world: FixtureTerminal, sessions: readonly SessionSummary[]): FakeHandlers {
  const never = (): Promise<never> => new Promise<never>(() => undefined);
  /** What a session route answers before its own body: nothing without the session, and the state of the terminal side. */
  const refusal = (): Response | Promise<never> | null => {
    if (!world.authenticated) return errorResponse('access_required', 'The access link is needed.');
    if (world.state === 'loading') return never();
    if (world.state === 'error') return errorResponse('internal_error', 'The terminal host could not answer.');
    return null;
  };
  const open = (): TerminalSessionInfo[] => world.sessions.filter((session) => !world.socket.ended.has(session.name));
  const terminalState = (): TerminalState => {
    const { state } = world;
    if (state === 'unsupported_os' || state === 'addon_missing' || state === 'claude_not_found') {
      return makeUnavailableTerminalState(state);
    }
    return makeTerminalState(open(), {
      capabilities: makeTerminalCapabilities({ nativeOpen: true }),
    });
  };
  const start = (path: string, link: Partial<TerminalSessionInfo['link']>): TerminalSessionInfo => {
    const base =
      path
        .split(BACKSLASH)
        .flatMap((part) => part.split('/'))
        .filter((part) => part !== '')
        .at(-1)
        ?.replaceAll(/[^A-Za-z0-9_-]/gu, '_') ?? 'session';
    let n = 1;
    while (world.sessions.some((session) => session.name === `${base}-${String(n)}`)) n += 1;
    const known = world.folders.find((folder) => folder.path === path);
    const session = makeTerminalSession(1, {
      name: `${base}-${String(n)}`,
      path,
      folderKey: known?.key ?? null,
      createdAt: iso(0),
      link: makeTerminalLink(link),
    });
    world.sessions = [...world.sessions, session];
    return session;
  };
  return {
    authSession: () => ({ authenticated: world.authenticated }),
    authExchange: () => {
      world.authenticated = true;
      return { authenticated: true };
    },
    authLogout: () => {
      world.authenticated = false;
      return { authenticated: false };
    },
    terminalState: () => refusal() ?? terminalState(),
    listFolders: () => refusal() ?? makeFolderList(world.state === 'empty' ? [] : world.folders),
    addFolder: (_query, request) => {
      const refused = refusal();
      if (refused !== null) return refused;
      const { path } = routes.addFolder.body.parse(request.body);
      const name = path.split(BACKSLASH).at(-1) ?? 'folder';
      const added = makeFolder(1, {
        key: fixtureFolderKey(name.toLowerCase().replaceAll(/[^a-z0-9-]/gu, '-')),
        name,
        path,
        origins: ['user'],
        pathSource: 'user',
        group: 'outside-da',
        userAdded: true,
      });
      world.folders = [...world.folders, added];
      return added;
    },
    terminalCreateSession: (_query, request) =>
      refusal() ?? { session: start(routes.terminalCreateSession.body.parse(request.body).path, {}) },
    terminalKillSession: (_query, request) => {
      const refused = refusal();
      if (refused !== null) return refused;
      const name = request.params['name'] ?? '';
      if (!world.sessions.some((session) => session.name === name)) return errorResponse('terminal_not_found');
      world.sessions = world.sessions.filter((session) => session.name !== name);
      world.socket.kill(name);
      return { name };
    },
    terminalPickFolder: () => refusal() ?? { path: fixturePath('picked-folder') },
    terminalResume: (_query, request) => {
      const refused = refusal();
      if (refused !== null) return refused;
      const { sessionId } = routes.terminalResume.body.parse(request.body);
      return {
        session: start(fixturePath(FIXTURE_RECENT_FOLDER), {
          status: 'linked',
          sessionId,
          basis: 'resume-id',
          confidence: 'high',
          transcript: sessions.some((session) => session.id === sessionId) ? 'tracked' : 'none',
          registryStatus: 'idle',
        }),
      };
    },
    terminalOpenNative: (_query, request) =>
      refusal() ?? {
        via: 'windows-terminal',
        fork: routes.terminalOpenNative.body.parse(request.body).fork === true,
      },
    sessionResume: (_query, request) =>
      refusal() ?? fixtureResumeEligibility(request.params['sessionId'] ?? FIXTURE_DETAIL_SESSION_ID),
  };
}

/**
 * The session list of a user instance: the Workspace asks for the monitor rows of its linked terminals by id (`session`) and for
 * the recent sessions of a folder by project key (`project`). Any other request gets the whole list, as before.
 */
function workspaceSessionList(sessions: readonly SessionSummary[], query: URLSearchParams): SessionSummary[] {
  const ids = query.getAll('session').flatMap((value) => value.split(','));
  if (ids.length > 0) return sessions.filter((session) => ids.includes(session.id));
  const project = query.getAll('project').flatMap((value) => value.split(','))[0] ?? '';
  if (!project.startsWith(fixtureFolderKey(''))) return [...sessions];
  const numbers = FIXTURE_RECENT[project.slice(fixtureFolderKey('').length)] ?? [];
  return numbers.flatMap((n) => sessions.filter((session) => session.id === fixtureId(n)));
}

function handlers(state: FixtureState, world: FixtureTerminal | null = null): FakeHandlers {
  const sessions = state === 'empty' ? [] : fixtureSessions();
  const instance = makeInstance({
    slug: world === null ? 'demo' : 'user',
    title: world === null ? 'Demo monitor' : PRODUCT_NAME,
    ...(world === null ? {} : { kind: 'user' as const, app: { name: PRODUCT_NAME } }),
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
    listSessions: (query) => {
      const items = world === null ? sessions : workspaceSessionList(sessions, query);
      return makePage(items, { total: items.length });
    },
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
    ...(world === null ? {} : terminalHandlers(world, sessions)),
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
  /** The terminal side; `null` when the page was given none (a task instance, which has no terminal routes). */
  readonly terminal: FixtureTerminal | null;
}

/** Instances that bootstrap the shell stay answered while a page is "loading" or "failing", so the chrome is drawn. */
const BOOTSTRAP: ReadonlySet<string> = new Set([routes.instance.path]);

/** The two event streams: both are aborted, so the app polls and a changed answer shows within a few seconds. */
const STREAMS: ReadonlySet<string> = new Set([routes.stream.path, routes.terminalEvents.path]);

/**
 * Bridges the fake API to `page.route` for `/api/v3/**`. The stream routes are aborted, so the app polls. Returns a handle with
 * which a view can change the state (`disconnected` after the first draw) or replace handlers before the page loads. With a
 * `terminal` state the fake instance is a user instance: it also answers the access, terminal, folder and resume routes, a write
 * reaches its handler with its method, headers and body, and the terminal socket is the canned one.
 */
export async function fixtureApi(
  page: Page,
  initial: FixtureState = 'ok',
  terminal: TerminalFixtureState | null = null,
): Promise<FixtureApi> {
  const delta = Math.round((Date.now() - FIXTURE_NOW_MS) / 1000) * 1000;
  let world: FixtureTerminal | null = null;
  if (terminal !== null) {
    const socket = await routeTerminalSocket(page);
    for (const [name, sample] of Object.entries(FIXTURE_TERMINAL_SAMPLES)) socket.samples.set(name, sample);
    world = {
      state: terminal,
      authenticated: terminal !== 'locked',
      sessions: terminal === 'empty' ? [] : fixtureTerminalSessions(),
      folders: fixtureFolders(),
      socket,
    };
  }
  const fake = createFakeApi(handlers(initial, world));
  const api: FixtureApi = {
    fake,
    state: initial,
    requests: [],
    setState(next) {
      api.state = next;
      fake.handlers = handlers(next, world);
    },
    terminal: world,
  };

  const answer = async (route: Route): Promise<void> => {
    const request = route.request();
    const url = new URL(request.url());
    if (STREAMS.has(url.pathname)) {
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
      const method = request.method();
      const response =
        method === 'GET'
          ? await fake.fetchImpl(url.href)
          : await fake.fetchImpl(url.href, { method, headers: request.headers(), body: request.postData() });
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
