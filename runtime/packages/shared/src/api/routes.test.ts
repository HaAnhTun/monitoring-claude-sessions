import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// eslint-disable-next-line no-restricted-imports -- WP-03 CR-WP-03-3: the rule reads `../cli/` inside @mcs/shared as the workspace package `cli`; this is shared's own folder src/cli/
import { ConfigInspectionSchema } from '../cli/results.ts';
import { IngestHealthSchema, type IngestHealth } from '../schemas/ingest.ts';
import { ERROR_CODES, RESERVED_ERROR_CODES, type ErrorCode } from './errors.ts';
import { PanelResponseSchema } from './panels.ts';
import {
  COMMON_ERROR_CODES,
  ROUTE_IDS,
  buildPath,
  defineRoute,
  routeErrors,
  routeUrl,
  routes,
  type RouteId,
} from './routes.ts';

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
    'q state presence project workItem model hasErrors range from to window tokensMin tokensMax includeUnmatched sort dir cursor limit includeTotal',
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
    expect(own).toHaveLength(34);
    expect(all).toHaveLength(all.includes('explainCompletion') ? 35 : 34);
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

  it('is read-only except the nudge (03 5.1)', () => {
    for (const id of ROUTE_IDS) {
      expect(routes[id].method).toBe(id === 'ingestNudge' ? 'POST' : 'GET');
    }
    expect(routes.ingestNudge.successStatus).toBe(204);
    expect(routes.ingestNudge.response).toBeNull();
    expect(routes.ingestNudge.body).not.toBeNull();
    for (const id of ROUTE_IDS) {
      if (id !== 'ingestNudge') expect(routes[id].body, id).toBeNull();
    }
  });

  it('declares content types: json, ndjson for export, event-stream for stream, none for 204', () => {
    for (const id of ROUTE_IDS) {
      const expected =
        id === 'export'
          ? 'application/x-ndjson'
          : id === 'stream'
            ? 'text/event-stream'
            : id === 'ingestNudge'
              ? null
              : 'application/json';
      expect(routes[id].contentType, id).toBe(expected);
      if (expected === 'application/json') expect(routes[id].response, id).not.toBeNull();
    }
    expect(routes.export.response).toBeNull();
    expect(routes.stream.response).toBeNull();
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

  it('every error code except the reserved ones is listed by some route (DA-T-API-3 meta-test)', () => {
    const listed = new Set<ErrorCode>(COMMON_ERROR_CODES);
    for (const id of ROUTE_IDS) for (const code of routeErrors(routes[id])) listed.add(code);
    // completion_target_not_found belongs to the explainCompletion row that WP-29 adds
    const pending: ErrorCode[] = 'explainCompletion' in routes ? [] : ['completion_target_not_found'];
    const missing = ERROR_CODES.filter(
      (c) => !listed.has(c) && !RESERVED_ERROR_CODES.includes(c) && !pending.includes(c),
    );
    expect(missing).toEqual([]);
    for (const code of RESERVED_ERROR_CODES) expect(listed.has(code), code).toBe(false);
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

  it('every q route lists query_too_short (5.2)', () => {
    for (const id of ROUTE_IDS) {
      const keys = queryKeys(id);
      if (keys.includes('q') && id !== 'searchTranscript' && id !== 'errors') {
        expect(routes[id].errors, id).toContain('query_too_short');
      }
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
});
