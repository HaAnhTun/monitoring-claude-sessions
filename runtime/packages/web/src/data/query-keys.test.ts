import {
  AnalyticsToolsQuerySchema,
  EventListQuerySchema,
  PANEL_KEYS,
  ROUTE_IDS,
  SeriesQuerySchema,
  SessionListQuerySchema,
  UsageQuerySchema,
  WRITE_ROUTE_IDS,
  fromQuery,
  routes,
  toQuery,
} from '@mcs/shared';
import { hashKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  sessionsSpec,
  type ActivityUrlState,
  type AnalyticsUrlState,
  type SessionsUrlState,
} from '../lib/url-state.ts';
import { ApiError } from './api-errors.ts';
import {
  ENDPOINT_NAMES,
  ENDPOINT_ROUTE,
  panelEndpoint,
  pathFor,
  toAnalyticsSeriesFilter,
  toAnalyticsToolsFilter,
  toAnalyticsUsageFilter,
  toEventFilter,
  toSessionFilter,
} from './endpoints.ts';
import { qk } from './query-keys.ts';

const IID_A = '11111111-1111-4111-8111-111111111111';
const IID_B = '22222222-2222-4222-8222-222222222222';
const SID = '33333333-3333-4333-8333-333333333333';

function defaultSessionsState(): SessionsUrlState {
  const spec = sessionsSpec(24);
  return {
    q: spec.q.default,
    state: [],
    project: '',
    task: null,
    model: '',
    errors: false,
    range: { kind: 'preset', preset: '24h' },
    tokMin: null,
    tokMax: null,
    sort: 'lastActivity',
    dir: 'desc',
    unmatched: false,
  };
}

describe('qk: query keys', () => {
  it('prefixes every key with the instance id, except the boot key that discovers it', () => {
    const keys = [
      qk.root(IID_A),
      qk.health(IID_A),
      qk.overview(IID_A),
      qk.sessions(IID_A, {}),
      qk.sidebarSessions(IID_A, false),
      qk.session(IID_A, SID),
      qk.agents(IID_A, SID),
      qk.timeline(IID_A, SID, {}),
      qk.toolCalls(IID_A, SID, {}),
      qk.activity(IID_A, {}),
      qk.transcriptSearch(IID_A, {}),
      qk.instanceSearch(IID_A, {}),
      qk.workItems(IID_A),
      qk.analytics(IID_A, 'usage', {}),
      qk.config(IID_A),
      qk.panel(IID_A, 'git'),
    ];
    for (const key of keys) expect(key.slice(0, 2)).toEqual(['mcs', IID_A]);
    expect(qk.instance()).toEqual(['mcs', 'boot', 'instance']);
  });

  it('two instances never share a cache entry', () => {
    expect(hashKey(qk.sessions(IID_A, { q: 'x' }))).not.toBe(hashKey(qk.sessions(IID_B, { q: 'x' })));
    expect(hashKey(qk.health(IID_A))).not.toBe(hashKey(qk.health(IID_B)));
    expect(hashKey(qk.panel(IID_A, 'git'))).not.toBe(hashKey(qk.panel(IID_B, 'git')));
  });

  it('equal filters hash equally whatever the insertion order, different filters do not', () => {
    const a = toQuery({ state: ['running'], q: 'abc' });
    const b = toQuery({ q: 'abc', state: ['running'] });
    expect(hashKey(qk.sessions(IID_A, a))).toBe(hashKey(qk.sessions(IID_A, b)));
    expect(hashKey(qk.sessions(IID_A, a))).not.toBe(hashKey(qk.sessions(IID_A, toQuery({ q: 'abd' }))));
  });

  it('keeps the sidebar list apart from the explorer list and the session scoped keys under the session key', () => {
    expect(hashKey(qk.sidebarSessions(IID_A, true))).not.toBe(hashKey(qk.sidebarSessions(IID_A, false)));
    expect(hashKey(qk.sidebarSessions(IID_A, false))).not.toBe(hashKey(qk.sessions(IID_A, {})));
    const session = qk.session(IID_A, SID);
    expect(qk.agents(IID_A, SID).slice(0, session.length)).toEqual([...session]);
    expect(qk.timeline(IID_A, SID, {}).slice(0, session.length)).toEqual([...session]);
    expect(qk.toolCalls(IID_A, SID, {}).slice(0, session.length)).toEqual([...session]);
    expect(hashKey(qk.toolCalls(IID_A, SID, { status: 'failed' }))).not.toBe(hashKey(qk.toolCalls(IID_A, SID, {})));
    expect(hashKey(qk.toolCalls(IID_A, SID, {}))).not.toBe(hashKey(qk.timeline(IID_A, SID, {})));
  });

  it('keeps the instance search apart from the search in one session and by every parameter', () => {
    expect(hashKey(qk.instanceSearch(IID_A, { q: 'ab' }))).not.toBe(hashKey(qk.transcriptSearch(IID_A, { q: 'ab' })));
    expect(hashKey(qk.instanceSearch(IID_A, { q: 'ab' }))).not.toBe(
      hashKey(qk.instanceSearch(IID_A, { q: 'ab', kinds: 'tool' })),
    );
    expect(hashKey(qk.instanceSearch(IID_A, { q: 'ab' }))).not.toBe(hashKey(qk.instanceSearch(IID_B, { q: 'ab' })));
  });

  it('separates the three analytics kinds and the six panels', () => {
    const kinds = (['usage', 'series', 'tools'] as const).map((kind) => hashKey(qk.analytics(IID_A, kind, {})));
    expect(new Set(kinds).size).toBe(3);
    const panels = PANEL_KEYS.map((key) => hashKey(qk.panel(IID_A, key)));
    expect(new Set(panels).size).toBe(PANEL_KEYS.length);
  });
});

describe('endpoints: names and routes', () => {
  it('maps every endpoint name to a route id of the shared registry', () => {
    for (const name of ENDPOINT_NAMES) expect(ROUTE_IDS, name).toContain(ENDPOINT_ROUTE[name]);
  });

  it('follows the table of 04 5.1', () => {
    expect(ENDPOINT_ROUTE).toMatchObject({
      instance: 'instance',
      health: 'health',
      overview: 'overview',
      sessions: 'listSessions',
      session: 'getSession',
      agents: 'sessionAgents',
      timeline: 'sessionTimeline',
      toolCalls: 'sessionToolCalls',
      activity: 'listEvents',
      transcript: 'transcriptWindow',
      transcriptLocate: 'transcriptLocate',
      transcriptSearch: 'searchTranscript',
      instanceSearch: 'searchTranscripts',
      workItems: 'workItemBoard',
      analyticsUsage: 'analyticsUsage',
      analyticsSeries: 'analyticsSeries',
      analyticsTools: 'analyticsTools',
      config: 'config',
    });
    for (const key of PANEL_KEYS) expect(ENDPOINT_ROUTE[panelEndpoint(key)]).toBe('panel');
  });

  it('maps the access, terminal, folder and resume endpoints to the routes of the registry (ADR 0099)', () => {
    expect(ENDPOINT_ROUTE).toMatchObject({
      authSession: 'authSession',
      authExchange: 'authExchange',
      authLogout: 'authLogout',
      terminalState: 'terminalState',
      terminalCreateSession: 'terminalCreateSession',
      terminalKillSession: 'terminalKillSession',
      terminalPickFolder: 'terminalPickFolder',
      terminalResume: 'terminalResume',
      folders: 'listFolders',
      addFolder: 'addFolder',
      sessionResume: 'sessionResume',
    });
  });

  it('uses routes that exist; a route is a POST exactly when the registry lists it as a write', () => {
    for (const name of ENDPOINT_NAMES) {
      const id = ENDPOINT_ROUTE[name];
      expect(routes[id].method, name).toBe(WRITE_ROUTE_IDS.includes(id) ? 'POST' : 'GET');
    }
  });

  it('calls exactly the seven write routes of the UI with a POST and keeps the rest GET', () => {
    const posts = ENDPOINT_NAMES.filter((name) => routes[ENDPOINT_ROUTE[name]].method === 'POST');
    expect([...posts].sort()).toEqual(
      [
        'authExchange',
        'authLogout',
        'terminalCreateSession',
        'terminalKillSession',
        'terminalPickFolder',
        'terminalResume',
        'addFolder',
      ].sort(),
    );
  });

  it('builds the kill path from a terminal name and answers not-found without a request for an invalid one', () => {
    expect(pathFor('terminalKillSession', routes.terminalKillSession, { name: 'repo-1' })).toBe(
      '/api/v3/terminal/sessions/repo-1/kill',
    );
    for (const name of ['', 'a b', 'a/b', '..', 'x'.repeat(65)]) {
      expect(() => pathFor('terminalKillSession', routes.terminalKillSession, { name }), JSON.stringify(name)).toThrow(
        ApiError,
      );
    }
  });

  it('builds the resume eligibility path from a session id only', () => {
    expect(pathFor('sessionResume', routes.sessionResume, { sessionId: SID })).toBe(`/api/v3/sessions/${SID}/resume`);
    expect(() => pathFor('sessionResume', routes.sessionResume, { sessionId: 'not-an-id' })).toThrow(ApiError);
  });
});

describe('qk: access, terminal, folder and resume keys (ADR 0099)', () => {
  it('starts every one with the instance id', () => {
    const keys = [
      qk.authSession(IID_A),
      qk.terminalState(IID_A),
      qk.folders(IID_A),
      qk.linkedSessions(IID_A, SID),
      qk.folderSessions(IID_A, 'folder-key'),
      qk.resumeEligibility(IID_A, SID),
    ];
    for (const key of keys) expect(key.slice(0, 2)).toEqual(['mcs', IID_A]);
  });

  it('uses the shapes of design 04 4.2', () => {
    expect(qk.authSession(IID_A)).toEqual(['mcs', IID_A, 'auth']);
    expect(qk.terminalState(IID_A)).toEqual(['mcs', IID_A, 'terminal']);
    expect(qk.folders(IID_A)).toEqual(['mcs', IID_A, 'folders']);
    expect(qk.resumeEligibility(IID_A, SID)).toEqual(['mcs', IID_A, 'resume', SID]);
    expect(qk.linkedSessions(IID_A, 'a,b')).toEqual(['mcs', IID_A, 'sessions', { linked: true, ids: 'a,b' }]);
    expect(qk.folderSessions(IID_A, 'k')).toEqual(['mcs', IID_A, 'sessions', { recent: true, folder: 'k' }]);
  });

  it('keeps the linked and folder keys under the sessions prefix, so the stream patches their rows', () => {
    const prefix = ['mcs', IID_A, 'sessions'];
    expect(qk.linkedSessions(IID_A, 'a').slice(0, 3)).toEqual(prefix);
    expect(qk.folderSessions(IID_A, 'k').slice(0, 3)).toEqual(prefix);
    expect(qk.sessions(IID_A, {}).slice(0, 3)).toEqual(prefix);
  });

  it('keeps those two lists apart from each other, from the explorer and from the sidebar', () => {
    const hashes = [
      hashKey(qk.linkedSessions(IID_A, 'a')),
      hashKey(qk.linkedSessions(IID_A, 'b')),
      hashKey(qk.folderSessions(IID_A, 'a')),
      hashKey(qk.folderSessions(IID_A, 'b')),
      hashKey(qk.sessions(IID_A, {})),
      hashKey(qk.sidebarSessions(IID_A, false)),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
    // the sidebar special case of the reconciler keys on `sidebar`: neither new key carries it
    expect(qk.linkedSessions(IID_A, 'a')[3]).not.toHaveProperty('sidebar');
    expect(qk.folderSessions(IID_A, 'a')[3]).not.toHaveProperty('sidebar');
  });

  it('keeps the auth, terminal, folder and resume entries apart, per instance and per session', () => {
    const hashes = [
      hashKey(qk.authSession(IID_A)),
      hashKey(qk.terminalState(IID_A)),
      hashKey(qk.folders(IID_A)),
      hashKey(qk.resumeEligibility(IID_A, SID)),
      hashKey(qk.session(IID_A, SID)),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(hashKey(qk.terminalState(IID_A))).not.toBe(hashKey(qk.terminalState(IID_B)));
    expect(hashKey(qk.authSession(IID_A))).not.toBe(hashKey(qk.authSession(IID_B)));
    expect(hashKey(qk.resumeEligibility(IID_A, SID))).not.toBe(hashKey(qk.resumeEligibility(IID_A, 'other')));
  });

  it('the terminal prefix removes the terminal state and nothing else of the instance', () => {
    const terminal = qk.terminalState(IID_A);
    for (const other of [qk.authSession(IID_A), qk.folders(IID_A), qk.health(IID_A), qk.sessions(IID_A, {})]) {
      expect(other.slice(0, terminal.length)).not.toEqual([...terminal]);
    }
  });
});

describe('endpoints: URL state to API filter (04 3.2)', () => {
  it('maps the defaults to a query the route accepts', () => {
    const query = toQuery(toSessionFilter(defaultSessionsState()));
    expect(query).toEqual({ dir: 'desc', range: '24h', sort: 'lastActivity' });
    expect(() => fromQuery(SessionListQuerySchema, query)).not.toThrow();
  });

  it('renames the UI-only keys: task -> workItem, errors -> hasErrors=1, tokMin/tokMax, unmatched', () => {
    const query = toQuery(
      toSessionFilter({
        ...defaultSessionsState(),
        q: 'build',
        state: ['running', 'failed'],
        project: 'proj-a',
        task: 42,
        model: 'model-x',
        errors: true,
        tokMin: 10,
        tokMax: 500,
        sort: 'tokens',
        dir: 'asc',
        unmatched: true,
      }),
    );
    expect(query).toEqual({
      dir: 'asc',
      hasErrors: '1',
      includeUnmatched: '1',
      model: 'model-x',
      project: 'proj-a',
      q: 'build',
      range: '24h',
      sort: 'tokens',
      state: 'running,failed',
      tokensMax: '500',
      tokensMin: '10',
      workItem: '42',
    });
    expect(query).not.toHaveProperty('task');
    expect(() => fromQuery(SessionListQuerySchema, query)).not.toThrow();
  });

  it('sends a custom range as from and to, and an open range as from only', () => {
    const closed = toQuery(
      toSessionFilter({
        ...defaultSessionsState(),
        range: { kind: 'custom', from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' },
      }),
    );
    expect(closed).toMatchObject({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' });
    expect(closed).not.toHaveProperty('range');
    const open = toQuery(
      toSessionFilter({
        ...defaultSessionsState(),
        range: { kind: 'custom', from: '2026-01-01T00:00:00.000Z', to: null },
      }),
    );
    expect(open).toMatchObject({ from: '2026-01-01T00:00:00.000Z' });
    expect(open).not.toHaveProperty('to');
    expect(() => fromQuery(SessionListQuerySchema, closed)).not.toThrow();
  });

  it('maps the activity state to the events route', () => {
    const state: ActivityUrlState = {
      types: ['tool', 'error'],
      session: SID,
      project: '',
      tool: 'Bash',
      severity: ['warning', 'error'],
      q: 'fail',
      range: { kind: 'preset', preset: '7d' },
    };
    const query = toQuery(toEventFilter(state));
    expect(query).toEqual({
      category: 'tool,error',
      q: 'fail',
      range: '7d',
      session: SID,
      severity: 'warning,error',
      tool: 'Bash',
    });
    expect(() => fromQuery(EventListQuerySchema, query)).not.toThrow();
  });

  it('maps the analytics state: by=task is sent as groupBy=workItem', () => {
    const state: AnalyticsUrlState = { range: { kind: 'preset', preset: '7d' }, by: 'task', bucket: 'hour' };
    const usage = toQuery(toAnalyticsUsageFilter(state));
    expect(usage).toEqual({ groupBy: 'workItem', range: '7d' });
    expect(() => fromQuery(UsageQuerySchema, usage)).not.toThrow();
    const series = toQuery(toAnalyticsSeriesFilter(state));
    expect(series).toEqual({ bucket: 'hour', range: '7d' });
    expect(() => fromQuery(SeriesQuerySchema, series)).not.toThrow();
    const tools = toQuery(toAnalyticsToolsFilter(state));
    expect(tools).toEqual({ range: '7d' });
    expect(() => fromQuery(AnalyticsToolsQuerySchema, tools)).not.toThrow();
    expect(toQuery(toAnalyticsUsageFilter({ ...state, by: 'model' }))).toMatchObject({ groupBy: 'model' });
  });
});
