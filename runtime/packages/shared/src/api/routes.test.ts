import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// eslint-disable-next-line no-restricted-imports -- WP-03 CR-WP-03-3: the rule reads `../cli/` inside @mcs/shared as the workspace package `cli`; this is shared's own folder src/cli/
import { ConfigInspectionSchema } from '../cli/results.ts';
import { IngestHealthSchema, type IngestHealth } from '../schemas/ingest.ts';
import { ERROR_CODES, RESERVED_ERROR_CODES, type ErrorCode } from './errors.ts';
import { FolderListResponseSchema, FolderSchema, ResumeEligibilitySchema } from './folders.ts';
import { PanelResponseSchema } from './panels.ts';
import {
  ACCESS_POLICY,
  COMMON_ERROR_CODES,
  DEFAULT_MAX_BODY_BYTES,
  ROUTE_IDS,
  WRITE_ROUTE_IDS,
  buildPath,
  defineRoute,
  routeErrors,
  routeUrl,
  routes,
  type RouteAccess,
  type RouteId,
} from './routes.ts';
import {
  AuthSessionResponseSchema,
  CreateSessionBodySchema,
  CreateSessionResponseSchema,
  EmptyBodySchema,
  ExchangeBodySchema,
  ExchangeResponseSchema,
  KillSessionResponseSchema,
  LogoutResponseSchema,
  PickFolderResponseSchema,
  ResumeBodySchema,
  ResumeResponseSchema,
  TerminalNameParamsSchema,
  TerminalStateSchema,
} from './terminal.ts';

const SID = '0b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d11';
const AT = '2026-10-11T10:00:00.000Z';

function sampleIngestHealth(): IngestHealth {
  return IngestHealthSchema.parse({
    evaluatedAt: 1791727200000,
    provider: { lastActivityAt: null, source: null, status: 'none' },
    receiving: {
      hooks: {
        installed: [],
        lastEnvelopeAt: null,
        envelopes1h: 0,
        duplicates1h: 0,
        invalid1h: 0,
        handlerErrors: [],
        transcriptHookFailures: 0,
        coverage: { full: 0, partial: 0, none: 0 },
        status: 'not_installed',
      },
      spool: {
        segments: 0,
        bytes: 0,
        bytesBehind: 0,
        oldestPendingReceivedAt: null,
        lastNudgeAt: null,
        lastDrainAt: null,
        foreignFiles: 0,
      },
      transcripts: {
        dir: null,
        dirFound: false,
        filesTracked: 0,
        filesMissing: 0,
        filesUnreadable: 0,
        bytesBehind: 0,
        maxLagMs: 0,
        backfillRemainingBytes: 0,
        lastScanAt: null,
        lastSyncAt: null,
        errors: {},
        status: 'not_found',
      },
    },
    persisted: {
      lastCommitAt: null,
      queueItems: 0,
      queueBytes: 0,
      commitP95Ms: 0,
      failures1h: 0,
      lastError: null,
      status: 'ok',
    },
    display: { headSeq: 0, serverTime: 1791727200000 },
    runtime: { startedAt: 1791727000000, eventLoopDelayP99Ms: 0 },
    status: 'ok',
    reasons: [],
  });
}

const EVENT_PARAMS =
  'type category severity session agent project workItem tool q range from to dir cursor limit around afterId';

/** Hand-copied from 03 6.1: id, method, path, query keys, specific errors (q routes also list query_too_short, 5.2). */
const TABLE: [RouteId, string, string, string, ErrorCode[]][] = [
  ['legacyHealth', 'GET', '/api/health', '', []],
  ['health', 'GET', '/api/v3/health', '', []],
  ['healthIngest', 'GET', '/api/v3/health/ingest', '', []],
  ['instance', 'GET', '/api/v3/instance', '', []],
  ['config', 'GET', '/api/v3/config', '', []],
  ['errors', 'GET', '/api/v3/errors', 'since source limit', []],
  ['overview', 'GET', '/api/v3/overview', 'range from to window includeUnmatched', ['range_invalid']],
  [
    'listSessions',
    'GET',
    '/api/v3/sessions',
    'q state presence project session workItem model hasErrors range from to window tokensMin tokensMax includeUnmatched sort dir cursor limit includeTotal',
    ['cursor_invalid', 'range_invalid', 'range_too_large', 'query_too_short'],
  ],
  ['getSession', 'GET', '/api/v3/sessions/:sessionId', '', ['session_not_found']],
  [
    'sessionAgents',
    'GET',
    '/api/v3/sessions/:sessionId/agents',
    'state includeInternal cursor limit',
    ['session_not_found'],
  ],
  [
    'sessionTimeline',
    'GET',
    '/api/v3/sessions/:sessionId/timeline',
    'type category severity agent workItem tool q range from to dir cursor limit around afterId',
    ['session_not_found', 'agent_not_found', 'query_too_short'],
  ],
  [
    'sessionToolCalls',
    'GET',
    '/api/v3/sessions/:sessionId/tool-calls',
    'agent tool status q range from to sort dir cursor limit',
    ['session_not_found', 'query_too_short'],
  ],
  ['sessionTransitions', 'GET', '/api/v3/sessions/:sessionId/transitions', 'agent cursor limit', ['session_not_found']],
  ['sessionUsage', 'GET', '/api/v3/sessions/:sessionId/usage', 'groupBy includeCost', ['session_not_found']],
  [
    'transcriptWindow',
    'GET',
    '/api/v3/sessions/:sessionId/transcript',
    'agent after before limit textChars thinking',
    ['session_not_found', 'agent_not_found', 'transcript_gone'],
  ],
  [
    'transcriptLocate',
    'GET',
    '/api/v3/sessions/:sessionId/transcript/locate',
    'agent i ts offset',
    ['session_not_found', 'agent_not_found', 'transcript_gone', 'event_not_found'],
  ],
  [
    'searchTranscript',
    'GET',
    '/api/v3/search/transcript',
    'session agent q kinds tool errors limit budgetMs',
    ['session_not_found', 'search_busy', 'transcript_gone'],
  ],
  [
    'searchTranscripts',
    'GET',
    '/api/v3/search/transcripts',
    'q session project workItem range from to window kinds limit budgetMs continue',
    ['search_busy', 'cursor_invalid', 'query_too_short'],
  ],
  [
    'listAgents',
    'GET',
    '/api/v3/agents',
    'state kind q session project hasErrors includeInternal range from to window includeUnmatched sort dir cursor limit',
    ['query_too_short'],
  ],
  [
    'listEvents',
    'GET',
    '/api/v3/events',
    EVENT_PARAMS,
    ['filter_requires_scope', 'event_not_found', 'query_too_short'],
  ],
  ['getEvent', 'GET', '/api/v3/events/:eventId', '', ['event_not_found']],
  [
    'listToolCalls',
    'GET',
    '/api/v3/tool-calls',
    'session agent project tool status q range from to sort dir cursor limit',
    ['filter_requires_scope', 'query_too_short'],
  ],
  ['workItemBoard', 'GET', '/api/v3/work-items', 'state q', ['query_too_short']],
  ['getWorkItem', 'GET', '/api/v3/work-items/:workItemId', '', ['work_item_not_found']],
  [
    'analyticsUsage',
    'GET',
    '/api/v3/analytics/usage',
    'groupBy session project workItem model range from to window limit includeCost',
    ['range_too_large'],
  ],
  [
    'analyticsSeries',
    'GET',
    '/api/v3/analytics/series',
    'bucket tzOffsetMinutes groupBy session project workItem model range from to',
    ['range_too_large'],
  ],
  ['analyticsTools', 'GET', '/api/v3/analytics/tools', 'groupBy session agent project tool range from to limit', []],
  ['listAlerts', 'GET', '/api/v3/alerts', 'status severity rule session cursor limit', []],
  ['alertRules', 'GET', '/api/v3/alerts/rules', '', []],
  ['panel', 'GET', '/api/v3/panels/:key', 'limit', ['panel_disabled']],
  [
    'export',
    'GET',
    '/api/v3/export',
    'session workItem range from to include redaction includeContent',
    ['range_invalid', 'export_busy'],
  ],
  [
    'ingestNudge',
    'POST',
    '/api/v3/ingest/nudge',
    '',
    ['instance_mismatch', 'payload_too_large', 'unsupported_media_type', 'body_invalid_json'],
  ],
  ['ingestProbe', 'GET', '/api/v3/ingest/probes/:probeSessionId', '', ['probe_not_found']],
  ['stream', 'GET', '/api/v3/stream', 'since epoch', ['stream_limit']],
  // the projects routes of CAW-08 (design 03 7.2, Option A)
  ['listFolders', 'GET', '/api/v3/folders', '', []],
  ['addFolder', 'POST', '/api/v3/folders', '', ['folder_invalid', 'folder_limit']],
  ['removeFolder', 'POST', '/api/v3/folders/:key/remove', '', ['folder_not_found']],
  ['sessionResume', 'GET', '/api/v3/sessions/:sessionId/resume', '', ['session_not_found']],
  // the access and terminal routes of CAW-09 (design 02 2.1)
  ['authSession', 'GET', '/api/v3/auth/session', '', []],
  ['authExchange', 'POST', '/api/v3/auth/exchange', '', ['access_code_invalid', 'access_rate_limited']],
  ['authLogout', 'POST', '/api/v3/auth/logout', '', []],
  ['terminalState', 'GET', '/api/v3/terminal/state', '', []],
  ['terminalEvents', 'GET', '/api/v3/terminal/events', '', ['stream_limit']],
  [
    'terminalCreateSession',
    'POST',
    '/api/v3/terminal/sessions',
    '',
    ['folder_invalid', 'claude_not_found', 'terminal_unavailable', 'terminal_limit'],
  ],
  ['terminalKillSession', 'POST', '/api/v3/terminal/sessions/:name/kill', '', ['terminal_not_found']],
  [
    'terminalSocket',
    'GET',
    '/api/v3/terminal/sessions/:name/socket',
    '',
    ['terminal_not_found', 'upgrade_required', 'stream_limit', 'terminal_unavailable'],
  ],
  ['terminalPickFolder', 'POST', '/api/v3/terminal/pick-folder', '', ['picker_busy', 'terminal_unavailable']],
  [
    'terminalResume',
    'POST',
    '/api/v3/terminal/resume',
    '',
    [
      'session_not_found',
      'resume_unavailable',
      'folder_invalid',
      'claude_not_found',
      'terminal_unavailable',
      'terminal_limit',
    ],
  ],
];

/** The routes of the projects area: every one of them needs the session cookie (design 03 7.2). */
const PROJECT_ROUTE_IDS: readonly RouteId[] = ['listFolders', 'addFolder', 'removeFolder', 'sessionResume'];

/** The routes of the terminal: the list and the feed, the socket and the five commands; every one needs the session cookie. */
const TERMINAL_ROUTE_IDS: readonly RouteId[] = [
  'terminalState',
  'terminalEvents',
  'terminalCreateSession',
  'terminalKillSession',
  'terminalSocket',
  'terminalPickFolder',
  'terminalResume',
];

/** The write routes, spelled out here as the independent expectation of `WRITE_ROUTE_IDS` of the registry. */
const EXPECTED_WRITE_ROUTE_IDS: readonly string[] = [
  'ingestNudge',
  'addFolder',
  'removeFolder',
  'authExchange',
  'authLogout',
  'terminalCreateSession',
  'terminalKillSession',
  'terminalPickFolder',
  'terminalResume',
];

/** Every open route (any local client that passes the guards): the monitoring reads, the nudge and the session probe. */
const OPEN_ROUTE_IDS: readonly string[] = [
  'legacyHealth',
  'health',
  'healthIngest',
  'instance',
  'config',
  'errors',
  'overview',
  'listSessions',
  'getSession',
  'sessionAgents',
  'sessionTransitions',
  'sessionUsage',
  'listAgents',
  'listEvents',
  'workItemBoard',
  'getWorkItem',
  'analyticsUsage',
  'analyticsSeries',
  'analyticsTools',
  'listAlerts',
  'alertRules',
  'panel',
  'ingestNudge',
  'ingestProbe',
  'stream',
  'explainCompletion',
  'authSession',
];

/** The routes whose content any local client could read before the access code existed (02 A1). */
const READER_ROUTE_IDS: readonly string[] = [
  'transcriptWindow',
  'transcriptLocate',
  'searchTranscript',
  'searchTranscripts',
  'export',
  'getEvent',
  'listToolCalls',
  'sessionToolCalls',
  'sessionTimeline',
];

function queryKeys(id: RouteId): string[] {
  const query = routes[id].query;
  if (!(query instanceof z.ZodObject)) return [];
  return Object.keys(query.shape).sort();
}

describe('route registry (03 6.1, 13)', () => {
  it('has every 6.1 row and nothing else (explainCompletion is the one row WP-29 adds on top)', () => {
    // WP-29 widens RouteId with explainCompletion; compare as plain strings so this file needs no edit then
    const all: readonly string[] = ROUTE_IDS;
    const own = all.filter((id) => id !== 'explainCompletion');
    expect([...own].sort()).toEqual(TABLE.map(([id]) => id).sort());
    expect(own).toHaveLength(48);
    expect(all).toHaveLength(all.includes('explainCompletion') ? 49 : 48);
    expect(Object.keys(routes).sort()).toEqual([...ROUTE_IDS].sort());
  });

  it.each(TABLE)('%s: method, path, query keys and error codes match the table', (id, method, path, keys, errors) => {
    const route = routes[id];
    expect(route.id).toBe(id);
    expect(route.method).toBe(method);
    expect(route.path).toBe(path);
    expect(queryKeys(id)).toEqual(keys === '' ? [] : keys.split(' ').sort());
    expect([...route.errors].sort()).toEqual([...errors].sort());
    expect(route.summary.length).toBeGreaterThan(5);
  });

  it('is read-only except the nudge (03 5.1), the two folder writes (CAW-08) and the access and terminal writes (CAW-09)', () => {
    for (const id of ROUTE_IDS) {
      expect(routes[id].method).toBe(WRITE_ROUTE_IDS.includes(id) ? 'POST' : 'GET');
    }
    expect(routes.ingestNudge.successStatus).toBe(204);
    expect(routes.ingestNudge.response).toBeNull();
    expect(routes.ingestNudge.body).not.toBeNull();
    for (const id of ROUTE_IDS) {
      if (WRITE_ROUTE_IDS.includes(id)) expect(routes[id].body, id).not.toBeNull();
      else expect(routes[id].body, id).toBeNull();
    }
  });

  it('declares content types: json, ndjson for export, event-stream for the two feeds, websocket for the socket, none for 204', () => {
    for (const id of ROUTE_IDS) {
      const expected =
        id === 'export'
          ? 'application/x-ndjson'
          : id === 'stream' || id === 'terminalEvents'
            ? 'text/event-stream'
            : id === 'terminalSocket'
              ? 'websocket'
              : id === 'ingestNudge' || id === 'removeFolder'
                ? null
                : 'application/json';
      expect(routes[id].contentType, id).toBe(expected);
      if (expected === 'application/json') expect(routes[id].response, id).not.toBeNull();
      else expect(routes[id].response, id).toBeNull();
    }
    expect(routes.export.response).toBeNull();
    expect(routes.stream.response).toBeNull();
    expect(routes.removeFolder.successStatus).toBe(204);
    expect(routes.addFolder.successStatus).toBe(200);
  });

  it('path parameters and param schemas agree both ways', () => {
    for (const id of ROUTE_IDS) {
      const route = routes[id];
      const names = [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1]).sort();
      const declared = route.params === null ? [] : Object.keys(route.params.shape);
      expect(declared.sort(), id).toEqual(names);
    }
  });

  it('paths are unique per method and live under /api', () => {
    const seen = new Set<string>();
    for (const id of ROUTE_IDS) {
      const key = `${routes[id].method} ${routes[id].path.replace(/:\w+/g, ':p')}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
      expect(routes[id].path.startsWith('/api/')).toBe(true);
      if (id !== 'legacyHealth') expect(routes[id].path.startsWith('/api/v3/')).toBe(true);
    }
  });

  it('uses work item names, never the old task names (I-10)', () => {
    for (const id of ROUTE_IDS) {
      expect(id.toLowerCase()).not.toContain('task');
      expect(routes[id].path).not.toContain('/tasks');
    }
    expect(routes.workItemBoard.path).toBe('/api/v3/work-items');
    expect(routes.getWorkItem.path).toBe('/api/v3/work-items/:workItemId');
    expect(queryKeys('listSessions')).toContain('workItem');
    expect(queryKeys('listSessions')).not.toContain('task');
  });

  it('every error code except the reserved one is listed by some route (DA-T-API-3 meta-test; no code is pending any more)', () => {
    const listed = new Set<ErrorCode>(COMMON_ERROR_CODES);
    for (const id of ROUTE_IDS) for (const code of routeErrors(routes[id])) listed.add(code);
    // completion_target_not_found belongs to the explainCompletion row that WP-29 adds
    const pending: ErrorCode[] = 'explainCompletion' in routes ? [] : ['completion_target_not_found'];
    const missing = ERROR_CODES.filter(
      (c) => !listed.has(c) && !RESERVED_ERROR_CODES.includes(c) && !pending.includes(c),
    );
    expect(missing).toEqual([]);
    expect([...RESERVED_ERROR_CODES]).toEqual(['alert_not_found']);
    for (const code of RESERVED_ERROR_CODES) expect(listed.has(code), code).toBe(false);
  });

  it('the codes of the access and terminal routes are listed by the routes that produce them', () => {
    const listedBy = (code: ErrorCode): string[] => ROUTE_IDS.filter((id) => routes[id].errors.includes(code)).sort();
    expect(listedBy('access_code_invalid')).toEqual(['authExchange']);
    expect(listedBy('access_rate_limited')).toEqual(['authExchange']);
    expect(listedBy('upgrade_required')).toEqual(['terminalSocket']);
    expect(listedBy('picker_busy')).toEqual(['terminalPickFolder']);
    expect(listedBy('terminal_not_found')).toEqual(['terminalKillSession', 'terminalSocket']);
    expect(listedBy('terminal_limit')).toEqual(['terminalCreateSession', 'terminalResume']);
    expect(listedBy('resume_unavailable')).toEqual(['terminalResume']);
    expect(listedBy('claude_not_found')).toEqual(['terminalCreateSession', 'terminalResume']);
    expect(listedBy('terminal_unavailable')).toEqual([
      'terminalCreateSession',
      'terminalPickFolder',
      'terminalResume',
      'terminalSocket',
    ]);
    expect(listedBy('stream_limit')).toEqual(['stream', 'terminalEvents', 'terminalSocket']);
  });

  it('common errors are the ones of the registry header, and a route lists them once', () => {
    expect([...COMMON_ERROR_CODES].sort()).toEqual(
      [
        'validation_failed',
        'param_repeated',
        'host_not_allowed',
        'origin_not_allowed',
        'cross_site_request',
        'route_not_found',
        'method_not_allowed',
        'uri_too_long',
        'internal_error',
        'db_busy',
        'disk_full',
        'shutting_down',
      ].sort(),
    );
    const all = routeErrors(routes.listSessions);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain('cursor_invalid');
    expect(all).toContain('validation_failed');
  });

  it('derives access_required, csrf_rejected, payload_too_large and body_invalid_json from the metadata', () => {
    const bodyCodes: ErrorCode[] = ['csrf_rejected', 'payload_too_large', 'body_invalid_json'];
    expect(routeErrors(routes.health)).not.toContain('access_required');
    for (const code of bodyCodes) expect(routeErrors(routes.health)).not.toContain(code);
    for (const id of READER_ROUTE_IDS) expect(routeErrors(routes[id as RouteId]), id).toContain('access_required');
    for (const code of bodyCodes) expect(routeErrors(routes.ingestNudge)).toContain(code);
    expect(routeErrors(routes.ingestNudge)).not.toContain('access_required');
    const session = routeErrors({ errors: [], access: 'session', body: z.strictObject({}) });
    expect(session).toEqual(expect.arrayContaining(['access_required', ...bodyCodes]));
    expect(routeErrors({ errors: [], access: 'ticket', body: z.strictObject({}) })).not.toContain('access_required');
    const all = routeErrors({ errors: ['csrf_rejected'], access: 'session', body: z.strictObject({}) });
    expect(new Set(all).size).toBe(all.length);
  });

  it('every q route lists query_too_short (5.2)', () => {
    for (const id of ROUTE_IDS) {
      const keys = queryKeys(id);
      if (keys.includes('q') && id !== 'searchTranscript' && id !== 'errors') {
        expect(routes[id].errors, id).toContain('query_too_short');
      }
    }
  });
});

describe('route metadata (02 2.1, A1)', () => {
  it('is open except the nine content routes (reader), the projects, terminal and logout routes (session) and the exchange (ticket)', () => {
    for (const id of ROUTE_IDS) {
      const expected: RouteAccess = READER_ROUTE_IDS.includes(id)
        ? 'reader'
        : PROJECT_ROUTE_IDS.includes(id) || TERMINAL_ROUTE_IDS.includes(id) || id === 'authLogout'
          ? 'session'
          : id === 'authExchange'
            ? 'ticket'
            : 'open';
      expect(routes[id].access, id).toBe(expected);
    }
    expect(ROUTE_IDS.filter((id) => routes[id].access === 'reader')).toHaveLength(9);
    expect(ROUTE_IDS.filter((id) => routes[id].access === 'session')).toHaveLength(12);
    expect(ROUTE_IDS.filter((id) => routes[id].access === 'ticket')).toEqual(['authExchange']);
  });

  it('keeps the body limit of the nudge guard and no body limit for a route without a body', () => {
    expect(routes.ingestNudge.maxBodyBytes).toBe(256);
    for (const id of ROUTE_IDS) {
      if (routes[id].body === null) expect(routes[id].maxBodyBytes, id).toBe(0);
    }
  });

  it('every route answers 200 or 204; the socket alone answers 101 (the status after the upgrade)', () => {
    for (const id of ROUTE_IDS) {
      if (id === 'terminalSocket') expect(routes[id].successStatus, id).toBe(101);
      else expect([200, 204], id).toContain(routes[id].successStatus);
    }
    expect(ROUTE_IDS.filter((id) => routes[id].contentType === 'websocket')).toEqual(['terminalSocket']);
  });

  it('the only write route that is open is the nudge', () => {
    for (const id of ROUTE_IDS) {
      if (routes[id].method !== 'GET' && id !== 'ingestNudge') expect(routes[id].access, id).not.toBe('open');
    }
  });
});

describe('ACCESS_POLICY and WRITE_ROUTE_IDS (02 2.1: the policy table the meta-test fixes)', () => {
  it('has an entry for every route and no other, and each entry equals the access of its definition', () => {
    expect(Object.keys(ACCESS_POLICY).sort()).toEqual([...ROUTE_IDS].sort());
    for (const id of ROUTE_IDS) expect(ACCESS_POLICY[id], id).toBe(routes[id].access);
  });

  it('pins the nine reader routes', () => {
    const readers = ROUTE_IDS.filter((id) => ACCESS_POLICY[id] === 'reader');
    expect([...readers].sort()).toEqual([...READER_ROUTE_IDS].sort());
    expect(readers).toHaveLength(9);
    // a reader route is a GET: the Bearer control token is never accepted on a POST
    for (const id of readers) expect(routes[id].method, id).toBe('GET');
  });

  it('pins the open routes: the monitoring reads, the nudge and the session probe', () => {
    const open = ROUTE_IDS.filter((id) => ACCESS_POLICY[id] === 'open');
    expect([...open].sort()).toEqual([...OPEN_ROUTE_IDS].sort());
  });

  it('pins the session routes and the one ticket route', () => {
    const session = ROUTE_IDS.filter((id) => ACCESS_POLICY[id] === 'session');
    expect([...session].sort()).toEqual([...PROJECT_ROUTE_IDS, ...TERMINAL_ROUTE_IDS, 'authLogout'].sort());
    expect(ROUTE_IDS.filter((id) => ACCESS_POLICY[id] === 'ticket')).toEqual(['authExchange']);
  });

  it('lists the write routes: every POST of the registry and no GET', () => {
    expect([...WRITE_ROUTE_IDS].sort()).toEqual([...EXPECTED_WRITE_ROUTE_IDS].sort());
    expect(new Set(WRITE_ROUTE_IDS).size).toBe(WRITE_ROUTE_IDS.length);
    expect(ROUTE_IDS.filter((id) => routes[id].method === 'POST').sort()).toEqual([...WRITE_ROUTE_IDS].sort());
    for (const id of WRITE_ROUTE_IDS) expect(ROUTE_IDS as readonly string[], id).toContain(id);
  });

  it('every write route is session or ticket, except the nudge of the spool', () => {
    for (const id of WRITE_ROUTE_IDS) {
      const access = ACCESS_POLICY[id];
      if (id === 'ingestNudge') expect(access, id).toBe('open');
      else expect(['session', 'ticket'], id).toContain(access);
    }
  });

  it('every session route is a terminal, folder-write, folder, resume-eligibility or logout route', () => {
    const allowed = new Set<string>([...PROJECT_ROUTE_IDS, ...TERMINAL_ROUTE_IDS, 'authLogout']);
    for (const id of ROUTE_IDS) if (ACCESS_POLICY[id] === 'session') expect(allowed.has(id), id).toBe(true);
  });

  it('every monitoring GET that was open before the access code stays open or reader, never session', () => {
    for (const id of ROUTE_IDS) {
      if (routes[id].method !== 'GET') continue;
      if (PROJECT_ROUTE_IDS.includes(id) || TERMINAL_ROUTE_IDS.includes(id)) continue;
      expect(['open', 'reader'], id).toContain(ACCESS_POLICY[id]);
    }
  });
});

describe('projects routes (CAW-08, design 03 7.2)', () => {
  it('every one needs the session cookie, even the two GETs: folder paths and DA summaries are private', () => {
    for (const id of PROJECT_ROUTE_IDS) expect(routes[id].access, id).toBe('session');
    for (const id of PROJECT_ROUTE_IDS) expect(routeErrors(routes[id]), id).toContain('access_required');
  });

  it('the two writes derive the body errors and keep the default body limit; the GETs have no body', () => {
    for (const id of ['addFolder', 'removeFolder'] as const) {
      expect(routeErrors(routes[id]), id).toEqual(
        expect.arrayContaining(['csrf_rejected', 'payload_too_large', 'body_invalid_json']),
      );
      expect(routes[id].maxBodyBytes, id).toBe(DEFAULT_MAX_BODY_BYTES);
    }
    for (const id of ['listFolders', 'sessionResume'] as const) {
      expect(routes[id].body, id).toBeNull();
      expect(routes[id].maxBodyBytes, id).toBe(0);
    }
  });

  it('addFolder takes { path } and answers the Folder row; removeFolder takes an empty object and answers 204', () => {
    expect(routes.addFolder.body.safeParse({ path: 'D:/x' }).success).toBe(true);
    expect(routes.addFolder.body.safeParse({}).success).toBe(false);
    expect(routes.addFolder.response).toBe(FolderSchema);
    expect(routes.removeFolder.body.safeParse({}).success).toBe(true);
    expect(routes.removeFolder.body.safeParse({ key: 'a' }).success).toBe(false);
    expect(routes.removeFolder.body).toBe(EmptyBodySchema);
    expect(routes.removeFolder.response).toBeNull();
    expect(routes.listFolders.response).toBe(FolderListResponseSchema);
    expect(routes.sessionResume.response).toBe(ResumeEligibilitySchema);
  });

  it('removeFolder names the folder by its project key, and the resume route by a session id', () => {
    const key = routes.removeFolder.params;
    expect(key.safeParse({ key: 'd--work-app' }).success).toBe(true);
    expect(key.safeParse({ key: '-home-x' }).success).toBe(true);
    for (const bad of ['', 'Upper', 'a/b', 'a b', '..', 'D:' + String.fromCharCode(92) + 'x']) {
      expect(key.safeParse({ key: bad }).success, bad).toBe(false);
    }
    expect(routes.sessionResume.params.safeParse({ sessionId: SID }).success).toBe(true);
    expect(routes.sessionResume.params.safeParse({ sessionId: 'abc' }).success).toBe(false);
    expect(buildPath(routes.removeFolder, { key: 'd--work-app' })).toBe('/api/v3/folders/d--work-app/remove');
    expect(buildPath(routes.sessionResume, { sessionId: SID })).toBe('/api/v3/sessions/' + SID + '/resume');
    expect(() => buildPath(routes.removeFolder, { key: 'a/b' })).toThrow(TypeError);
  });

  it('lists the codes the registry promises: folder_invalid and folder_limit on add, folder_not_found on remove', () => {
    expect(routeErrors(routes.addFolder)).toEqual(expect.arrayContaining(['folder_invalid', 'folder_limit']));
    expect(routeErrors(routes.removeFolder)).toContain('folder_not_found');
    expect(routeErrors(routes.sessionResume)).toContain('session_not_found');
    expect(routes.addFolder.errors).toEqual(['folder_invalid', 'folder_limit']);
  });

  it('the new codes are listed by a route', () => {
    const listed = new Set<ErrorCode>(ROUTE_IDS.flatMap((id) => routeErrors(routes[id])));
    for (const code of ['folder_invalid', 'folder_limit', 'folder_not_found'] as const) {
      expect(listed.has(code), code).toBe(true);
    }
  });
});

describe('access and terminal routes (CAW-09, design 02 2.1)', () => {
  it('the three access routes: an open probe, a ticket exchange, a logout behind the cookie', () => {
    expect(routes.authSession.access).toBe('open');
    expect(routes.authSession.body).toBeNull();
    expect(routes.authSession.response).toBe(AuthSessionResponseSchema);
    expect(routes.authExchange.access).toBe('ticket');
    expect(routes.authExchange.body).toBe(ExchangeBodySchema);
    expect(routes.authExchange.response).toBe(ExchangeResponseSchema);
    expect(routes.authLogout.access).toBe('session');
    expect(routes.authLogout.body).toBe(EmptyBodySchema);
    expect(routes.authLogout.response).toBe(LogoutResponseSchema);
    for (const id of ['authSession', 'authExchange', 'authLogout'] as const) {
      expect(routes[id].contentType, id).toBe('application/json');
      expect(routes[id].successStatus, id).toBe(200);
    }
  });

  it('the exchange derives the body errors but not access_required (the code is the credential), the probe derives nothing', () => {
    const exchange = routeErrors(routes.authExchange);
    expect(exchange).toEqual(expect.arrayContaining(['csrf_rejected', 'payload_too_large', 'body_invalid_json']));
    expect(exchange).toEqual(expect.arrayContaining(['access_code_invalid', 'access_rate_limited']));
    expect(exchange).not.toContain('access_required');
    expect(routeErrors(routes.authLogout)).toContain('access_required');
    const probe = routeErrors(routes.authSession);
    for (const code of ['access_required', 'csrf_rejected', 'payload_too_large', 'body_invalid_json'] as const) {
      expect(probe).not.toContain(code);
    }
  });

  it('every terminal route needs the session cookie and derives access_required', () => {
    for (const id of TERMINAL_ROUTE_IDS) {
      expect(routes[id].access, id).toBe('session');
      expect(routeErrors(routes[id]), id).toContain('access_required');
    }
  });

  it('the terminal writes are POST with a 4 KiB strict body and derive the body errors; the reads have no body', () => {
    for (const id of [
      'terminalCreateSession',
      'terminalKillSession',
      'terminalPickFolder',
      'terminalResume',
    ] as const) {
      expect(routes[id].method, id).toBe('POST');
      expect(routes[id].body, id).not.toBeNull();
      expect(routes[id].maxBodyBytes, id).toBe(DEFAULT_MAX_BODY_BYTES);
      expect(routeErrors(routes[id]), id).toEqual(
        expect.arrayContaining(['csrf_rejected', 'payload_too_large', 'body_invalid_json']),
      );
      expect(routes[id].successStatus, id).toBe(200);
    }
    for (const id of ['terminalState', 'terminalEvents', 'terminalSocket'] as const) {
      expect(routes[id].method, id).toBe('GET');
      expect(routes[id].body, id).toBeNull();
      expect(routes[id].maxBodyBytes, id).toBe(0);
    }
  });

  it('uses the schemas of terminal.ts for every body and response', () => {
    expect(routes.terminalState.response).toBe(TerminalStateSchema);
    expect(routes.terminalCreateSession.body).toBe(CreateSessionBodySchema);
    expect(routes.terminalCreateSession.response).toBe(CreateSessionResponseSchema);
    expect(routes.terminalKillSession.body).toBe(EmptyBodySchema);
    expect(routes.terminalKillSession.response).toBe(KillSessionResponseSchema);
    expect(routes.terminalPickFolder.body).toBe(EmptyBodySchema);
    expect(routes.terminalPickFolder.response).toBe(PickFolderResponseSchema);
    expect(routes.terminalResume.body).toBe(ResumeBodySchema);
    expect(routes.terminalResume.response).toBe(ResumeResponseSchema);
  });

  it('the events feed is a server-sent stream and the socket is a websocket upgrade: neither has a response schema', () => {
    expect(routes.terminalEvents.contentType).toBe('text/event-stream');
    expect(routes.terminalEvents.response).toBeNull();
    expect(routes.terminalEvents.successStatus).toBe(200);
    expect(routes.terminalSocket.contentType).toBe('websocket');
    expect(routes.terminalSocket.response).toBeNull();
    expect(routes.terminalSocket.successStatus).toBe(101);
    expect(routes.terminalSocket.params).toBe(TerminalNameParamsSchema);
    expect(routes.terminalKillSession.params).toBe(TerminalNameParamsSchema);
  });

  it('names a session by the MTOP pattern in the path and builds the socket path from it', () => {
    expect(buildPath(routes.terminalKillSession, { name: 'app-1' })).toBe('/api/v3/terminal/sessions/app-1/kill');
    expect(buildPath(routes.terminalSocket, { name: 'app-1' })).toBe('/api/v3/terminal/sessions/app-1/socket');
    for (const bad of ['..', 'a/b', 'a b', 'a.b', '', 'a'.repeat(65), 'a%2Fb']) {
      expect(() => buildPath(routes.terminalSocket, { name: bad }), bad).toThrow(TypeError);
      expect(() => buildPath(routes.terminalKillSession, { name: bad }), bad).toThrow(TypeError);
    }
  });

  it('resume is by monitored session id (and the fork flag) only: no route takes a command line, arguments or environment', () => {
    const body = routes.terminalResume.body;
    expect(body.safeParse({ sessionId: SID }).success).toBe(true);
    expect(body.safeParse({ sessionId: SID, fork: true }).success).toBe(true);
    for (const key of ['command', 'args', 'env', 'cwd'])
      expect(body.safeParse({ sessionId: SID, [key]: 'x' }).success).toBe(false);
    for (const id of ['terminalCreateSession', 'terminalResume'] as const) {
      const keys = Object.keys(routes[id].body.shape);
      for (const forbidden of ['command', 'args', 'env', 'cmd', 'argv']) expect(keys, id).not.toContain(forbidden);
    }
  });

  it('the registry names every error code of a route in its row: the browser and the CLI read the column', () => {
    expect(routes.terminalCreateSession.errors).toEqual([
      'folder_invalid',
      'claude_not_found',
      'terminal_unavailable',
      'terminal_limit',
    ]);
    expect(routes.terminalPickFolder.errors).toEqual(['picker_busy', 'terminal_unavailable']);
    expect(routes.terminalResume.errors).toContain('resume_unavailable');
    expect(routes.terminalResume.errors).toContain('session_not_found');
  });

  it('every route has a one-sentence summary that says what it does', () => {
    for (const id of [...TERMINAL_ROUTE_IDS, 'authSession', 'authExchange', 'authLogout'] as const) {
      expect(routes[id].summary.length, id).toBeGreaterThan(20);
      expect(routes[id].summary.endsWith('.'), id).toBe(true);
    }
  });
});

describe('route schemas', () => {
  it('reuse the owners schemas instead of redefining them', () => {
    expect(routes.panel.response).toBe(PanelResponseSchema);
    expect(routes.config.response).toBe(ConfigInspectionSchema);
    const ingest = routes.healthIngest.response.shape;
    for (const key of Object.keys(IngestHealthSchema.shape)) expect(key in ingest, key).toBe(true);
    expect('asOfSeq' in ingest).toBe(true);
  });

  it('healthIngest response is strict at the top level (03 5.1: an undocumented field is a contract failure)', () => {
    const body = sampleIngestHealth();
    const response = routes.healthIngest.response;
    expect(response.safeParse({ ...body, asOfSeq: 3 }).success).toBe(true);
    expect(response.safeParse({ ...body, asOfSeq: 3, extra: 1 }).success).toBe(false);
    expect(response.safeParse(body).success).toBe(false);
  });

  it('healthIngest response is strict at every nesting level (03 5.1, 13 item 1: strictObject all the way down)', () => {
    const response = routes.healthIngest.response;
    const body = {
      ...sampleIngestHealth(),
      asOfSeq: 3,
      reasons: [{ code: 'BACKFILLING', severity: 'info' as const, since: 1791727000000 }],
    };
    const hooks = {
      ...body.receiving.hooks,
      installed: [{ scope: 'user', settingsPath: 'x', verifiedAt: null, ok: null }],
      handlerErrors: [{ code: 'SPOOL_FULL', count: 1, lastAt: 1791727100000 }],
    };
    const persisted = {
      ...body.persisted,
      lastError: { code: 'SQLITE_FULL', at: 1791727199000 },
      status: 'db_error' as const,
    };
    const full = { ...body, receiving: { ...body.receiving, hooks }, persisted };
    expect(response.safeParse(full).success).toBe(true);

    const withExtra = (patch: Record<string, unknown>): boolean => response.safeParse({ ...full, ...patch }).success;
    const receivingWith = (patch: Record<string, unknown>): Record<string, unknown> => ({
      ...full.receiving,
      ...patch,
    });
    const hooksWith = (patch: Record<string, unknown>): Record<string, unknown> =>
      receivingWith({ hooks: { ...hooks, ...patch } });
    const extra = { extra: 1 };
    expect(withExtra({ provider: { ...full.provider, ...extra } }), 'provider').toBe(false);
    expect(withExtra({ receiving: receivingWith(extra) }), 'receiving').toBe(false);
    expect(withExtra({ receiving: receivingWith({ hooks: { ...hooks, ...extra } }) }), 'receiving.hooks').toBe(false);
    expect(
      withExtra({ receiving: hooksWith({ installed: [{ ...hooks.installed[0], ...extra }] }) }),
      'receiving.hooks.installed[0]',
    ).toBe(false);
    expect(
      withExtra({ receiving: hooksWith({ handlerErrors: [{ ...hooks.handlerErrors[0], ...extra }] }) }),
      'receiving.hooks.handlerErrors[0]',
    ).toBe(false);
    expect(
      withExtra({ receiving: hooksWith({ coverage: { ...hooks.coverage, ...extra } }) }),
      'receiving.hooks.coverage',
    ).toBe(false);
    expect(
      withExtra({ receiving: receivingWith({ spool: { ...full.receiving.spool, ...extra } }) }),
      'receiving.spool',
    ).toBe(false);
    expect(
      withExtra({ receiving: receivingWith({ transcripts: { ...full.receiving.transcripts, ...extra } }) }),
      'receiving.transcripts',
    ).toBe(false);
    expect(withExtra({ persisted: { ...persisted, ...extra } }), 'persisted').toBe(false);
    expect(
      withExtra({ persisted: { ...persisted, lastError: { ...persisted.lastError, ...extra } } }),
      'persisted.lastError',
    ).toBe(false);
    expect(withExtra({ display: { ...full.display, ...extra } }), 'display').toBe(false);
    expect(withExtra({ runtime: { ...full.runtime, ...extra } }), 'runtime').toBe(false);
    expect(withExtra({ reasons: [{ ...full.reasons[0], ...extra }] }), 'reasons[0]').toBe(false);
  });

  it('panel: key is one of the six, limit 1..200', () => {
    const params = routes.panel.params;
    expect(params.safeParse({ key: 'chainLog' }).success).toBe(true);
    expect(params.safeParse({ key: 'chain_log' }).success).toBe(false);
    const query = routes.panel.query;
    expect(query.safeParse({ limit: '200' }).success).toBe(true);
    expect(query.safeParse({ limit: '201' }).success).toBe(false);
    expect(query.safeParse({ limit: '0' }).success).toBe(false);
    expect(query.safeParse({ page: '1' }).success).toBe(false);
  });

  it('ingestProbe: only a probe session id is accepted (I-37)', () => {
    const params = routes.ingestProbe.params;
    expect(params.safeParse({ probeSessionId: '00000000-0000-4000-8000-0123456789ab' }).success).toBe(true);
    expect(params.safeParse({ probeSessionId: SID }).success).toBe(false);
    expect(params.safeParse({ probeSessionId: '00000000-0000-4000-8000-0123456789AB' }).success).toBe(false);
  });

  it('ingestNudge: body is { instanceId } only', () => {
    const body = routes.ingestNudge.body;
    expect(body.safeParse({ instanceId: '3f2b8c1e-0d4a-4b7e-9c11-5a6d7e8f9a0b' }).success).toBe(true);
    expect(body.safeParse({ instanceId: 'x' }).success).toBe(false);
    expect(body.safeParse({ instanceId: '3f2b8c1e-0d4a-4b7e-9c11-5a6d7e8f9a0b', extra: 1 }).success).toBe(false);
  });

  it('path ids: session ids use the legacy pattern, event ids are positive integers', () => {
    const session = routes.getSession.params;
    expect(session.safeParse({ sessionId: SID }).success).toBe(true);
    expect(session.safeParse({ sessionId: 'abc' }).success).toBe(false);
    const event = routes.getEvent.params;
    expect(event.parse({ eventId: '12' })).toEqual({ eventId: 12 });
    expect(event.safeParse({ eventId: '0' }).success).toBe(false);
    expect(event.safeParse({ eventId: '1.5' }).success).toBe(false);
    expect(event.safeParse({ eventId: 'x' }).success).toBe(false);
  });

  it('workItemBoard response is { asOfSeq, derivation, items, truncated } and strict', () => {
    const response = routes.workItemBoard.response;
    const board = { asOfSeq: 1, derivation: 'Declared items, attempt groups and labels.', items: [], truncated: false };
    expect(response.safeParse(board).success).toBe(true);
    expect(response.safeParse({ ...board, extra: 1 }).success).toBe(false);
    expect(response.safeParse({ asOfSeq: 1, items: [], truncated: false }).success).toBe(false);
  });

  it('errors response is { asOfSeq, items: ErrorItem[] }', () => {
    const response = routes.errors.response;
    const item = { at: AT, source: 'spool', code: 'SPOOL_WRITE_FAILED', where: null, message: 'x', sessionId: null };
    expect(response.safeParse({ asOfSeq: 1, items: [item] }).success).toBe(true);
    expect(response.safeParse({ asOfSeq: 1, items: [], extra: 1 }).success).toBe(false);
  });

  it('every schema converts to JSON Schema (the generator of WP-23 must not hit a wall)', () => {
    for (const id of ROUTE_IDS) {
      const route = routes[id];
      for (const input of [route.params, route.query, route.body]) {
        if (input === null) continue;
        expect(() => z.toJSONSchema(input, { io: 'input' }), `${id} input`).not.toThrow();
      }
      if (route.response !== null) {
        expect(() => z.toJSONSchema(route.response), `${id} response`).not.toThrow();
      }
    }
  });

  it('every default of a query (what an empty query parses to) is in the generated input schema (03 6.1, 13 item 4)', () => {
    let checked = 0;
    for (const id of ROUTE_IDS) {
      const query = routes[id].query;
      if (query === null) continue;
      const parsed: unknown = query.safeParse({}).data;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const properties = z.toJSONSchema(query, { io: 'input' }).properties ?? {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value === undefined) continue;
        const emitted = properties[key];
        // a list default is written as the query text (alerts status: 'open'); every other default is the parsed value
        const expected: unknown = Array.isArray(value) ? value.map(String).join(',') : value;
        expect(emitted, `${id}.${key}`).toMatchObject({ default: expected });
        checked += 1;
      }
    }
    // 19 numeric limits and budgets, the alert status, and the enum and flag defaults
    expect(checked).toBeGreaterThanOrEqual(20);
  });
});

describe('URL building', () => {
  it('fills path parameters and encodes them', () => {
    expect(buildPath(routes.getSession, { sessionId: SID })).toBe(`/api/v3/sessions/${SID}`);
    expect(buildPath(routes.health)).toBe('/api/v3/health');
    expect(buildPath(routes.panel, { key: 'git' })).toBe('/api/v3/panels/git');
    expect(buildPath(routes.getEvent, { eventId: 7 })).toBe('/api/v3/events/7');
  });

  it('refuses a missing or invalid parameter', () => {
    expect(() => buildPath(routes.getSession, {})).toThrow();
    expect(() => buildPath(routes.getSession, { sessionId: '../etc' })).toThrow();
    expect(() => buildPath(routes.getEvent, { eventId: 0 })).toThrow();
  });

  it('builds a query string through toQuery with sorted keys', () => {
    expect(routeUrl(routes.listSessions, { query: { state: ['working', 'failed'], limit: 5, hasErrors: true } })).toBe(
      '/api/v3/sessions?hasErrors=1&limit=5&state=working%2Cfailed',
    );
    expect(routeUrl(routes.health)).toBe('/api/v3/health');
  });
});

describe('defineRoute', () => {
  it('refuses a path parameter without a schema and a 204 route with a response', () => {
    expect(() =>
      defineRoute({
        id: 'x',
        method: 'GET',
        path: '/api/v3/x/:id',
        params: null,
        query: null,
        body: null,
        response: z.strictObject({}),
        successStatus: 200,
        errors: [],
        summary: 'Broken route.',
        contentType: 'application/json',
      }),
    ).toThrow(/path parameter/);
    expect(() =>
      defineRoute({
        id: 'y',
        method: 'POST',
        path: '/api/v3/y',
        params: null,
        query: null,
        body: z.strictObject({}),
        response: z.strictObject({}),
        successStatus: 204,
        errors: [],
        summary: 'Broken route.',
        contentType: null,
      }),
    ).toThrow(/204/);
  });

  const base = {
    params: null,
    query: null,
    body: null,
    response: null,
    summary: 'Test route.',
    errors: [],
  } as const;

  it('fills the defaults: open access, 4096 bytes with a body and none without', () => {
    const get = defineRoute({
      ...base,
      id: 'a',
      method: 'GET',
      path: '/api/v3/a',
      response: z.strictObject({}),
      successStatus: 200,
      contentType: 'application/json',
    });
    expect(get.access).toBe('open');
    expect(get.maxBodyBytes).toBe(0);
    const post = defineRoute({
      ...base,
      id: 'b',
      method: 'POST',
      path: '/api/v3/b',
      body: z.strictObject({}),
      successStatus: 204,
      contentType: null,
      access: 'session',
    });
    expect(post.access).toBe('session');
    expect(post.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(DEFAULT_MAX_BODY_BYTES).toBe(4096);
    expect(defineRoute({ ...post, id: 'c', path: '/api/v3/c', maxBodyBytes: 65536 }).maxBodyBytes).toBe(65536);
  });

  it('accepts a websocket route: a GET with no response and the status 101', () => {
    const socket = defineRoute({
      ...base,
      id: 'ws',
      method: 'GET',
      path: '/api/v3/ws/:name',
      params: z.strictObject({ name: z.string() }),
      successStatus: 101,
      contentType: 'websocket',
      access: 'session',
    });
    expect(socket.successStatus).toBe(101);
    expect(socket.contentType).toBe('websocket');
  });

  it('refuses a broken websocket route and a 101 anywhere else', () => {
    const ws = { ...base, id: 'ws', path: '/api/v3/ws', contentType: 'websocket', access: 'session' } as const;
    expect(() => defineRoute({ ...ws, method: 'POST', body: z.strictObject({}), successStatus: 101 })).toThrow(
      /websocket/,
    );
    expect(() => defineRoute({ ...ws, method: 'GET', successStatus: 200 })).toThrow(/websocket/);
    expect(() => defineRoute({ ...ws, method: 'GET', successStatus: 101, response: z.strictObject({}) })).toThrow(
      /websocket/,
    );
    expect(() =>
      defineRoute({
        ...base,
        id: 'j',
        method: 'GET',
        path: '/api/v3/j',
        response: z.strictObject({}),
        successStatus: 101,
        contentType: 'application/json',
      }),
    ).toThrow(/101/);
  });

  it('refuses a ticket route without a body and an open write route other than the nudge', () => {
    expect(() =>
      defineRoute({
        ...base,
        id: 't',
        method: 'GET',
        path: '/api/v3/t',
        successStatus: 204,
        contentType: null,
        access: 'ticket',
      }),
    ).toThrow(/ticket/);
    const write = { ...base, method: 'POST', body: z.strictObject({}), successStatus: 204, contentType: null } as const;
    expect(() => defineRoute({ ...write, id: 'w', path: '/api/v3/w' })).toThrow(/must not be open/);
    expect(() => defineRoute({ ...write, id: 'w', path: '/api/v3/w', access: 'open' })).toThrow(/must not be open/);
    expect(defineRoute({ ...write, id: 'ingestNudge', path: '/api/v3/n' }).access).toBe('open');
    expect(defineRoute({ ...write, id: 'w', path: '/api/v3/w', access: 'ticket' }).access).toBe('ticket');
  });

  it('refuses maxBodyBytes without a body and a limit that is not a positive integer', () => {
    const get = { ...base, id: 'g', method: 'GET', path: '/api/v3/g', successStatus: 204, contentType: null } as const;
    expect(() => defineRoute({ ...get, maxBodyBytes: 10 })).toThrow(/maxBodyBytes/);
    expect(defineRoute({ ...get, maxBodyBytes: 0 }).maxBodyBytes).toBe(0);
    const post = { ...get, method: 'POST', body: z.strictObject({}), access: 'session' } as const;
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => defineRoute({ ...post, maxBodyBytes: bad }), String(bad)).toThrow(/maxBodyBytes/);
    }
  });
});
