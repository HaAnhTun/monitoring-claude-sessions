import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ActivityEvent } from './entities.ts';
import {
  AgentListQuerySchema,
  AlertListQuerySchema,
  AnalyticsToolsQuerySchema,
  ErrorsQuerySchema,
  EventListQuerySchema,
  InstanceSearchQuerySchema,
  OverviewQuerySchema,
  PanelQuerySchema,
  SeriesQuerySchema,
  SessionAgentsQuerySchema,
  SessionListQuerySchema,
  SessionTimelineQuerySchema,
  SessionUsageQuerySchema,
  ToolCallListQuerySchema,
  TranscriptLocateQuerySchema,
  TranscriptSearchQuerySchema,
  TranscriptWindowQuerySchema,
  TransitionListQuerySchema,
  UsageQuerySchema,
  WorkItemBoardQuerySchema,
  classifyQueryIssues,
  expandStateFilter,
  foldQuery,
  fromQuery,
  matchesEventFilter,
  panelQueryAllowed,
  queryString,
  resolveTimeWindow,
  safeFromQuery,
  toQuery,
  type EventListQuery,
  type SessionListQuery,
} from './filters.ts';

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';

function ok<S extends z.ZodType>(schema: S, params: Record<string, string>): z.output<S> {
  return fromQuery(schema, params);
}

function bad(schema: z.ZodType, params: Record<string, string>): boolean {
  return !safeFromQuery(schema, params).success;
}

describe('field validation of the list routes (03 5.4)', () => {
  it('sessions: every documented parameter parses to its typed value', () => {
    const q = ok(SessionListQuerySchema, {
      q: '  Hello  ',
      state: 'active,failed',
      presence: 'open,ended',
      project: 'alpha,beta-2',
      workItem: '7',
      model: 'm-1,m-2',
      hasErrors: '1',
      range: '24h',
      window: '1',
      tokensMin: '10',
      tokensMax: '20',
      includeUnmatched: '1',
      sort: 'tokens',
      dir: 'asc',
      limit: '25',
      includeTotal: '1',
    });
    expect(q).toEqual({
      q: 'Hello',
      state: ['active', 'failed'],
      presence: ['open', 'ended'],
      project: ['alpha', 'beta-2'],
      workItem: 7,
      model: ['m-1', 'm-2'],
      hasErrors: true,
      range: '24h',
      window: true,
      tokensMin: 10,
      tokensMax: 20,
      includeUnmatched: true,
      sort: 'tokens',
      dir: 'asc',
      limit: 25,
      includeTotal: true,
    });
  });

  it('sessions: defaults are sort lastActivity and limit 50, nothing else', () => {
    expect(ok(SessionListQuerySchema, {})).toEqual({ sort: 'lastActivity', limit: 50 });
  });

  it('refuses unknown keys, wrong enums and out-of-range values', () => {
    const cases: Record<string, string>[] = [
      { nope: '1' },
      { sort: 'bogus' },
      { dir: 'up' },
      { limit: '0' },
      { limit: '201' },
      { limit: '1.5' },
      { limit: 'ten' },
      { q: 'a' },
      { q: ' a ' },
      { q: 'x'.repeat(201) },
      { state: 'running,bogus' },
      { state: '' },
      { state: 'running,,failed' },
      { presence: 'maybe' },
      { project: 'UPPER' },
      { project: Array.from({ length: 21 }, (_, i) => `p${i}`).join(',') },
      { workItem: '0' },
      { workItem: '-3' },
      { hasErrors: '0' },
      { hasErrors: 'true' },
      { range: '2h' },
      { from: 'yesterday' },
      { tokensMin: '-1' },
      { tokensMin: '1000000000000001' },
      { tokensMin: '5', tokensMax: '4' },
      { cursor: 'x'.repeat(513) },
      { includeTotal: '2' },
      { model: 'a b' },
    ];
    for (const params of cases) expect(bad(SessionListQuerySchema, params), JSON.stringify(params)).toBe(true);
  });

  it('accepts at most 10 states and keeps the alias active unexpanded', () => {
    expect(ok(SessionListQuerySchema, { state: 'active' }).state).toEqual(['active']);
    expect(expandStateFilter(['active', 'failed'])).toEqual([
      'running',
      'working',
      'waiting_tool',
      'waiting_agent',
      'failed',
    ]);
    expect(expandStateFilter(['failed', 'failed'])).toEqual(['failed']);
  });

  it('explicit times normalise to the output form and keep offsets honest', () => {
    const q = ok(SessionListQuerySchema, { from: '2026-10-11T17:00:00+07:00', to: '2026-10-11T11:00:00Z' });
    expect(q.from).toBe('2026-10-11T10:00:00.000Z');
    expect(q.to).toBe('2026-10-11T11:00:00.000Z');
  });

  it('agents, tool calls, alerts and the others use their own bounds and defaults', () => {
    expect(ok(AgentListQuerySchema, {})).toEqual({ sort: 'lastActivity', limit: 50 });
    expect(ok(AgentListQuerySchema, { kind: 'subagent,teammate', includeInternal: '1' })).toMatchObject({
      kind: ['subagent', 'teammate'],
      includeInternal: true,
    });
    expect(bad(AgentListQuerySchema, { kind: 'wizard' })).toBe(true);
    expect(ok(SessionAgentsQuerySchema, {})).toEqual({ limit: 200 });
    expect(ok(SessionAgentsQuerySchema, { limit: '500' }).limit).toBe(500);
    expect(bad(SessionAgentsQuerySchema, { limit: '501' })).toBe(true);
    expect(ok(ToolCallListQuerySchema, {})).toEqual({ sort: 'started', limit: 50 });
    expect(ok(ToolCallListQuerySchema, { status: 'failed,denied', tool: 'Bash,mcp__a.b' })).toMatchObject({
      status: ['failed', 'denied'],
      tool: ['Bash', 'mcp__a.b'],
    });
    expect(bad(ToolCallListQuerySchema, { sort: 'label' })).toBe(true);
    expect(ok(AlertListQuerySchema, {})).toEqual({ status: ['open'], limit: 50 });
    expect(ok(AlertListQuerySchema, { status: 'open,resolved', severity: 'critical', rule: 'hook_gap' })).toMatchObject(
      {
        status: ['open', 'resolved'],
        severity: ['critical'],
        rule: ['hook_gap'],
      },
    );
    expect(ok(TransitionListQuerySchema, { agent: 'main' })).toEqual({ agent: 'main', limit: 50 });
    expect(ok(WorkItemBoardQuerySchema, { state: 'working,stale', q: 'ab' })).toEqual({
      state: ['working', 'stale'],
      q: 'ab',
    });
    expect(bad(WorkItemBoardQuerySchema, { state: 'running' })).toBe(true);
    expect(ok(ErrorsQuerySchema, { source: 'server,spool', since: '2026-10-11T00:00:00Z' })).toMatchObject({
      source: ['server', 'spool'],
      limit: 50,
    });
    expect(bad(ErrorsQuerySchema, { source: 'nowhere' })).toBe(true);
    expect(bad(ErrorsQuerySchema, { limit: '201' })).toBe(true);
    expect(ok(OverviewQuerySchema, { window: '1', includeUnmatched: '1' })).toEqual({
      window: true,
      includeUnmatched: true,
    });
  });

  it('analytics routes: groupBy, buckets and offsets', () => {
    expect(ok(UsageQuerySchema, {})).toEqual({ groupBy: 'model', limit: 50 });
    expect(bad(UsageQuerySchema, { groupBy: 'task' })).toBe(true);
    expect(ok(UsageQuerySchema, { groupBy: 'workItem', includeCost: '1', limit: '500' })).toMatchObject({
      groupBy: 'workItem',
      includeCost: true,
      limit: 500,
    });
    expect(bad(UsageQuerySchema, { limit: '501' })).toBe(true);
    expect(ok(SessionUsageQuerySchema, {})).toEqual({ groupBy: 'agent' });
    expect(bad(SessionUsageQuerySchema, { groupBy: 'project' })).toBe(true);
    expect(ok(SeriesQuerySchema, {})).toEqual({ bucket: 'day', tzOffsetMinutes: 0, groupBy: 'none' });
    expect(ok(SeriesQuerySchema, { tzOffsetMinutes: '-840' }).tzOffsetMinutes).toBe(-840);
    expect(bad(SeriesQuerySchema, { tzOffsetMinutes: '841' })).toBe(true);
    expect(bad(SeriesQuerySchema, { bucket: 'week' })).toBe(true);
    expect(ok(AnalyticsToolsQuerySchema, {})).toEqual({ groupBy: 'tool', limit: 50 });
    expect(bad(AnalyticsToolsQuerySchema, { limit: '201' })).toBe(true);
    expect(bad(AnalyticsToolsQuerySchema, { agent: 'main' })).toBe(true);
    expect(ok(AnalyticsToolsQuerySchema, { agent: 'main', session: SID_A }).agent).toBe('main');
  });

  it('transcript routes: window, locate and the two searches', () => {
    expect(ok(TranscriptWindowQuerySchema, {})).toEqual({ agent: 'main', after: -1 });
    expect(
      ok(TranscriptWindowQuerySchema, { before: '10', limit: '2000', textChars: '200', thinking: '1' }),
    ).toMatchObject({
      before: 10,
      limit: 2000,
      textChars: 200,
      thinking: true,
    });
    for (const params of [
      { after: '-2' },
      { before: '-1' },
      { limit: '2001' },
      { limit: '0' },
      { textChars: '199' },
      { textChars: '20001' },
    ]) {
      expect(bad(TranscriptWindowQuerySchema, params), JSON.stringify(params)).toBe(true);
    }
    expect(ok(TranscriptLocateQuerySchema, { i: '3' })).toEqual({ agent: 'main', i: 3 });
    expect(ok(TranscriptLocateQuerySchema, { offset: '0' })).toEqual({ agent: 'main', offset: 0 });
    // 03 7.3: `i` clamps into [0, total-1], so a negative index is valid input and the handler clamps it
    expect(ok(TranscriptLocateQuerySchema, { i: '-1' })).toEqual({ agent: 'main', i: -1 });
    expect(bad(TranscriptLocateQuerySchema, { offset: '-1' })).toBe(true);
    expect(ok(TranscriptLocateQuerySchema, { ts: '2026-10-11T00:00:00Z' })).toMatchObject({
      ts: '2026-10-11T00:00:00.000Z',
    });
    expect(bad(TranscriptLocateQuerySchema, {})).toBe(true);
    expect(bad(TranscriptLocateQuerySchema, { i: '1', offset: '2' })).toBe(true);
    expect(ok(TranscriptSearchQuerySchema, { session: SID_A })).toEqual({ session: SID_A, limit: 200, budgetMs: 3000 });
    expect(
      ok(TranscriptSearchQuerySchema, { session: SID_A, q: '', errors: '1', kinds: 'tool,result', tool: 'Bash' }),
    ).toMatchObject({
      q: '',
      errors: true,
      kinds: ['tool', 'result'],
      tool: 'Bash',
    });
    expect(bad(TranscriptSearchQuerySchema, {})).toBe(true);
    expect(bad(TranscriptSearchQuerySchema, { session: `${SID_A},${SID_B}` })).toBe(true);
    expect(bad(TranscriptSearchQuerySchema, { session: SID_A, limit: '1001' })).toBe(true);
    expect(bad(TranscriptSearchQuerySchema, { session: SID_A, budgetMs: '99' })).toBe(true);
    expect(bad(TranscriptSearchQuerySchema, { session: SID_A, budgetMs: '10001' })).toBe(true);
    expect(bad(TranscriptSearchQuerySchema, { session: SID_A, kinds: 'prompt,bogus' })).toBe(true);
    expect(ok(InstanceSearchQuerySchema, { q: 'ab' })).toEqual({ q: 'ab', limit: 100, budgetMs: 3000 });
    expect(bad(InstanceSearchQuerySchema, {})).toBe(true);
    expect(bad(InstanceSearchQuerySchema, { q: 'a' })).toBe(true);
    expect(bad(InstanceSearchQuerySchema, { q: 'ab', limit: '501' })).toBe(true);
    expect(ok(InstanceSearchQuerySchema, { q: 'ab', continue: 'c-abc123' }).continue).toBe('c-abc123');
  });

  it('events: scope rules, around and afterId', () => {
    expect(ok(EventListQuerySchema, {})).toEqual({ limit: 100 });
    expect(bad(EventListQuerySchema, { agent: 'main' })).toBe(true);
    expect(bad(EventListQuerySchema, { agent: 'main', session: `${SID_A},${SID_B}` })).toBe(true);
    expect(ok(EventListQuerySchema, { agent: 'abc123', session: SID_A }).agent).toBe('abc123');
    expect(bad(EventListQuerySchema, { limit: '201' })).toBe(true);
    expect(ok(EventListQuerySchema, { afterId: '9', limit: '500' })).toEqual({ afterId: 9, limit: 500 });
    expect(bad(EventListQuerySchema, { afterId: '9', limit: '501' })).toBe(true);
    expect(bad(EventListQuerySchema, { around: '9', afterId: '9' })).toBe(true);
    expect(ok(EventListQuerySchema, { around: '9' }).around).toBe(9);
    expect(bad(EventListQuerySchema, { type: 'tool.call,bogus' })).toBe(true);
    expect(ok(EventListQuerySchema, { type: 'tool.call', category: 'error', severity: 'warning,error' })).toMatchObject(
      {
        type: ['tool.call'],
        category: ['error'],
        severity: ['warning', 'error'],
      },
    );
    expect(bad(EventListQuerySchema, { sort: 'at' })).toBe(true);
    // the timeline has the session in the path: no session or project parameter, agent allowed alone
    expect(ok(SessionTimelineQuerySchema, { agent: 'main' })).toEqual({ agent: 'main', limit: 100 });
    expect(bad(SessionTimelineQuerySchema, { session: SID_A })).toBe(true);
    expect(bad(SessionTimelineQuerySchema, { project: 'p' })).toBe(true);
  });

  it('every route that takes q refuses a one character q', () => {
    for (const schema of [
      SessionListQuerySchema,
      AgentListQuerySchema,
      EventListQuerySchema,
      ToolCallListQuerySchema,
      WorkItemBoardQuerySchema,
      InstanceSearchQuerySchema,
    ]) {
      expect(bad(schema, { q: 'a' })).toBe(true);
    }
  });
});

describe('input forms of fromQuery', () => {
  it('accepts a query string, entries and a record, and refuses a repeated key', () => {
    const want = { sort: 'lastActivity', limit: 5, state: ['working'] };
    expect(fromQuery(SessionListQuerySchema, '?state=working&limit=5')).toEqual(want);
    expect(fromQuery(SessionListQuerySchema, 'state=working&limit=5')).toEqual(want);
    expect(
      fromQuery(SessionListQuerySchema, [
        ['state', 'working'],
        ['limit', '5'],
      ]),
    ).toEqual(want);
    expect(fromQuery(SessionListQuerySchema, new URLSearchParams('state=working&limit=5'))).toEqual(want);
    expect(fromQuery(SessionListQuerySchema, { state: 'working', limit: '5', dir: undefined })).toEqual(want);
    expect(safeFromQuery(SessionListQuerySchema, 'limit=5&limit=6').success).toBe(false);
    expect(fromQuery(SessionListQuerySchema, 'q=a%20b%2Cc')).toMatchObject({ q: 'a b,c' });
    expect(fromQuery(SessionListQuerySchema, 'q=a+b')).toMatchObject({ q: 'a b' });
    expect(safeFromQuery(SessionListQuerySchema, 'q=%E0%A4%A').success).toBe(false);
  });

  it('treats prototype names as unknown keys and never crashes', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(safeFromQuery(SessionListQuerySchema, key + '=1').success, key).toBe(false);
      expect(safeFromQuery(SessionListQuerySchema, key + '=1&' + key + '=2').success, key).toBe(false);
      expect(safeFromQuery(SessionListQuerySchema, [[key, '1']]).success, key).toBe(false);
      expect(safeFromQuery(SessionListQuerySchema, { [key]: '1' }).success, key).toBe(false);
    }
  });

  it('classifyQueryIssues maps a short q to query_too_short and everything else to validation_failed', () => {
    const short = safeFromQuery(SessionListQuerySchema, { q: 'a' });
    const other = safeFromQuery(SessionListQuerySchema, { limit: '0' });
    expect(short.success).toBe(false);
    expect(other.success).toBe(false);
    if (!short.success && !other.success) {
      expect(classifyQueryIssues(short.error.issues)).toBe('query_too_short');
      expect(classifyQueryIssues(other.error.issues)).toBe('validation_failed');
    }
  });
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('toQuery / fromQuery round trip (DA-T-API-7, unit part)', () => {
  it('serialises booleans as 1, lists as commas and omits empty values', () => {
    expect(
      toQuery({
        q: 'abc',
        state: ['a', 'b'],
        hasErrors: true,
        includeTotal: false,
        project: [],
        limit: 5,
        from: undefined,
        w: null,
      }),
    ).toEqual({ q: 'abc', state: 'a,b', hasErrors: '1', limit: '5' });
    expect(queryString({ b: 'x y', a: 'é,1' })).toBe('a=%C3%A9%2C1&b=x%20y');
    expect(queryString({})).toBe('');
  });

  it('survives 500 seeded random filters for sessions and events', () => {
    const rnd = mulberry32(20261011);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;
    const some = <T>(items: readonly T[], max: number): T[] => {
      const n = 1 + Math.floor(rnd() * Math.min(max, items.length));
      return Array.from({ length: n }, () => pick(items));
    };
    const maybe = <T>(make: () => T): T | undefined => (rnd() < 0.5 ? make() : undefined);
    const text = () => pick(['abc', 'a b', 'x,y', 'Tiếng Việt', '100%', 'a&b=c', '日本語', 'q?#']);
    const iso = () => new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 3e10)).toISOString();

    for (let n = 0; n < 500; n++) {
      const sessions: SessionListQuery = SessionListQuerySchema.parse(
        toQuery(
          stripUndefined({
            q: maybe(() => `${text()}!`),
            state: maybe(() => some(['active', 'failed', 'stale', 'unknown'], 4)),
            presence: maybe(() => some(['open', 'ended', 'unknown'], 3)),
            project: maybe(() => some(['alpha', 'beta', 'g-1'], 3)),
            workItem: maybe(() => 1 + Math.floor(rnd() * 99)),
            hasErrors: maybe(() => true),
            range: maybe(() => pick(['1h', '6h', '24h', '7d', '30d', 'all'])),
            tokensMin: maybe(() => Math.floor(rnd() * 1000)),
            sort: maybe(() => pick(['lastActivity', 'started', 'duration', 'tokens', 'state', 'label', 'errors'])),
            dir: maybe(() => pick(['asc', 'desc'])),
            limit: maybe(() => 1 + Math.floor(rnd() * 200)),
            includeTotal: maybe(() => true),
          }),
        ),
      );
      expect(fromQuery(SessionListQuerySchema, toQuery(sessions))).toEqual(sessions);
      expect(fromQuery(SessionListQuerySchema, queryString(toQuery(sessions)))).toEqual(sessions);

      const events: EventListQuery = EventListQuerySchema.parse(
        toQuery(
          stripUndefined({
            type: maybe(() => some(['tool.call', 'turn.stop', 'api.error'], 3)),
            category: maybe(() => some(['tool', 'error', 'lifecycle'], 3)),
            severity: maybe(() => some(['info', 'warning', 'error'], 3)),
            session: maybe(() => ['11111111-1111-4111-8111-111111111111']),
            tool: maybe(() => some(['Bash', 'Edit', 'mcp__a.b'], 3)),
            q: maybe(() => `${text()}!`),
            from: maybe(iso),
            dir: maybe(() => pick(['asc', 'desc'])),
            limit: maybe(() => 1 + Math.floor(rnd() * 200)),
          }),
        ),
      );
      expect(fromQuery(EventListQuerySchema, toQuery(events))).toEqual(events);
    }
  });
});

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('empty list');
  return item;
}

let nextId = 1;
function event(over: Partial<ActivityEvent>): ActivityEvent {
  const id = nextId++;
  return {
    id,
    seq: id,
    key: `h:${id}`,
    sessionId: SID_A,
    sessionLabel: 'label',
    agentId: 'main',
    agentLabel: null,
    at: '2026-10-11T10:00:00.000Z',
    atSource: 'record',
    receivedAt: '2026-10-11T10:00:00.000Z',
    sources: ['hook'],
    source: 'hook',
    type: 'tool.call',
    category: 'tool',
    severity: 'info',
    hookEvent: null,
    entryKind: null,
    toolName: null,
    toolUseId: null,
    toolStatus: null,
    durationMs: null,
    summary: '',
    details: {},
    transcriptRef: null,
    ...over,
  };
}

describe('matchesEventFilter (shared with the UI live buffers)', () => {
  const events = [
    event({ type: 'tool.call', category: 'tool', toolName: 'Bash', summary: 'Run ls -la' }),
    event({ type: 'tool.failure', category: 'tool', severity: 'error', toolName: 'Bash', summary: 'exit 1' }),
    event({ type: 'turn.stop', category: 'lifecycle', summary: 'Turn ended' }),
    event({ type: 'api.error', category: 'error', severity: 'error', summary: 'rate limited' }),
    event({ sessionId: SID_B, agentId: 'abc123', type: 'agent.start', category: 'agent', summary: 'Subagent started' }),
    event({ type: 'tool.call', category: 'tool', toolName: 'Edit', summary: 'edit file 100%_done' }),
    event({ type: 'assistant.message', category: 'prompt', summary: 'Tiếng Việt TRẢ LỜI' }),
    event({ type: 'notification.sent', category: 'notification', severity: 'warning', summary: '' }),
  ];
  const ids = (filter: EventListQuery, o?: Parameters<typeof matchesEventFilter>[2]) =>
    events.filter((e) => matchesEventFilter(filter, e, o)).map((e) => e.id - (events[0]?.id ?? 0) + 1);
  const f = (params: Record<string, string>) => fromQuery(EventListQuerySchema, params);

  it('each filter alone (known answers; ids are 1-based positions of the fixture)', () => {
    expect(ids(f({}))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ids(f({ type: 'tool.call' }))).toEqual([1, 6]);
    expect(ids(f({ type: 'tool.call,turn.stop' }))).toEqual([1, 3, 6]);
    expect(ids(f({ category: 'tool' }))).toEqual([1, 2, 6]);
    expect(ids(f({ severity: 'error' }))).toEqual([2, 4]);
    expect(ids(f({ severity: 'info,warning' }))).toEqual([1, 3, 5, 6, 7, 8]);
    expect(ids(f({ session: SID_B }))).toEqual([5]);
    expect(ids(f({ session: `${SID_A},${SID_B}` }))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ids(f({ session: SID_B, agent: 'abc123' }))).toEqual([5]);
    expect(ids(f({ session: SID_A, agent: 'abc123' }))).toEqual([]);
    expect(ids(f({ tool: 'Bash' }))).toEqual([1, 2]);
    expect(ids(f({ tool: 'Bash,Edit' }))).toEqual([1, 2, 6]);
  });

  it('type and category intersect', () => {
    expect(ids(f({ type: 'tool.call,turn.stop', category: 'tool' }))).toEqual([1, 6]);
    expect(ids(f({ type: 'turn.stop', category: 'tool' }))).toEqual([]);
  });

  it('every pair of filters is the intersection of the two answers (AND semantics)', () => {
    const singles: Record<string, string>[] = [
      { type: 'tool.call,tool.failure' },
      { category: 'tool,error' },
      { severity: 'error' },
      { session: SID_A },
      { tool: 'Bash' },
      { q: 'ex' },
    ];
    for (const a of singles) {
      for (const b of singles) {
        const both = ids(f({ ...a, ...b }));
        if (Object.keys(a)[0] === Object.keys(b)[0]) continue;
        const left = ids(f(a));
        const right = ids(f(b));
        expect(both, `${JSON.stringify(a)} + ${JSON.stringify(b)}`).toEqual(left.filter((x) => right.includes(x)));
      }
    }
  });

  it('q matches summary and tool name, ASCII case-insensitively, literal wildcards, folded needle', () => {
    expect(ids(f({ q: 'run LS' }))).toEqual([1]);
    expect(ids(f({ q: 'bash' }))).toEqual([1, 2]);
    expect(ids(f({ q: '100%' }))).toEqual([6]);
    expect(ids(f({ q: '%_' }))).toEqual([6]);
    expect(ids(f({ q: 'zz' }))).toEqual([]);
    // non-ASCII text is compared exactly (SQLite LIKE folds ASCII only): the lower-case needle misses upper-case text
    expect(ids(f({ q: 'trả lời' }))).toEqual([]);
    expect(ids(f({ q: 'Tiếng Việt' }))).toEqual([7]);
  });

  it('time bounds use the event time; presets need the clock', () => {
    const early = event({ at: '2026-10-11T09:00:00.000Z' });
    const late = event({ at: '2026-10-11T12:00:00.000Z' });
    const filter = f({ from: '2026-10-11T09:30:00Z', to: '2026-10-11T12:00:00Z' });
    expect(matchesEventFilter(filter, early)).toBe(false);
    expect(matchesEventFilter(filter, first(events))).toBe(true);
    expect(matchesEventFilter(filter, late)).toBe(false);
    const now = Date.parse('2026-10-11T10:30:00Z');
    expect(matchesEventFilter(f({ range: '1h' }), first(events), { nowMs: now })).toBe(true);
    expect(matchesEventFilter(f({ range: '1h' }), early, { nowMs: now })).toBe(false);
    expect(matchesEventFilter(f({ range: 'all' }), early, { nowMs: now })).toBe(true);
    // the preset window is [now - span, now + 1): an event at now is inside, one a millisecond later is not
    const at = (ms: number) => event({ at: new Date(ms).toISOString() });
    expect(matchesEventFilter(f({ range: '1h' }), at(now), { nowMs: now })).toBe(true);
    expect(matchesEventFilter(f({ range: '1h' }), at(now + 1), { nowMs: now })).toBe(false);
    expect(matchesEventFilter(f({ range: '1h' }), at(now - 3_600_000), { nowMs: now })).toBe(true);
    expect(matchesEventFilter(f({ range: '1h' }), at(now - 3_600_001), { nowMs: now })).toBe(false);
    // without a clock the preset cannot be applied and is left to the server
    expect(matchesEventFilter(f({ range: '1h' }), early)).toBe(true);
  });

  it('project and work item need the caller to say what a session belongs to', () => {
    const e = first(events);
    expect(matchesEventFilter(f({ project: 'alpha' }), e, { projectIdOf: () => 'alpha' })).toBe(true);
    expect(matchesEventFilter(f({ project: 'alpha' }), e, { projectIdOf: () => 'beta' })).toBe(false);
    expect(matchesEventFilter(f({ project: 'alpha' }), e, { projectIdOf: () => null })).toBe(false);
    expect(matchesEventFilter(f({ project: 'alpha,beta' }), e, { projectIdOf: () => 'beta' })).toBe(true);
    expect(matchesEventFilter(f({ workItem: '3' }), e, { workItemIdsOf: () => [1, 2] })).toBe(false);
    expect(matchesEventFilter(f({ workItem: '3' }), e, { workItemIdsOf: () => [3] })).toBe(true);
  });

  it('fails closed: a project or work item filter without its resolver matches nothing (04 S-5)', () => {
    const e = first(events);
    expect(matchesEventFilter(f({ project: 'alpha' }), e)).toBe(false);
    expect(matchesEventFilter(f({ workItem: '3' }), e)).toBe(false);
    expect(matchesEventFilter(f({ project: 'alpha' }), e, { workItemIdsOf: () => [3] })).toBe(false);
    // without such a filter the resolvers are not needed
    expect(matchesEventFilter(f({}), e)).toBe(true);
  });

  it('ignores paging parameters', () => {
    const e = first(events);
    expect(matchesEventFilter(f({ limit: '1', around: '99', dir: 'asc', cursor: 'abc' }), e)).toBe(true);
    expect(matchesEventFilter(f({ afterId: '99' }), e)).toBe(true);
  });
});

describe('resolveTimeWindow (03 5.4: presets resolve with the server clock)', () => {
  const nowMs = Date.parse('2026-10-11T12:00:00.000Z');
  const o = { nowMs, defaultRange: '24h' as const, windowHours: 6 };

  it('presets run from now minus the span to now plus one millisecond', () => {
    expect(resolveTimeWindow({ range: '1h' }, o)).toEqual({
      ok: true,
      window: { fromMs: nowMs - 3_600_000, toMs: nowMs + 1 },
      source: 'range',
    });
    expect(resolveTimeWindow({ range: '30d' }, o)).toMatchObject({ window: { fromMs: nowMs - 30 * 86_400_000 } });
    expect(resolveTimeWindow({ range: 'all' }, o)).toEqual({
      ok: true,
      window: { fromMs: null, toMs: nowMs + 1 },
      source: 'range',
    });
  });

  it('uses the route default, or the configured window with window=1', () => {
    expect(resolveTimeWindow({}, o)).toMatchObject({
      ok: true,
      window: { fromMs: nowMs - 86_400_000 },
      source: 'range',
    });
    expect(resolveTimeWindow({}, { ...o, defaultRange: 'window' })).toEqual({
      ok: true,
      window: { fromMs: nowMs - 6 * 3_600_000, toMs: nowMs + 1 },
      source: 'window_hours',
    });
    expect(resolveTimeWindow({ window: true }, o)).toMatchObject({
      window: { fromMs: nowMs - 6 * 3_600_000 },
      source: 'window_hours',
    });
  });

  it('explicit bounds: to is optional, from must precede to', () => {
    const from = '2026-10-10T00:00:00.000Z';
    const to = '2026-10-11T00:00:00.000Z';
    expect(resolveTimeWindow({ from, to }, o)).toEqual({
      ok: true,
      window: { fromMs: Date.parse(from), toMs: Date.parse(to) },
      source: 'custom',
    });
    expect(resolveTimeWindow({ from }, o)).toEqual({
      ok: true,
      window: { fromMs: Date.parse(from), toMs: nowMs },
      source: 'custom',
    });
  });

  it('rejects range with from or to, to without from, and from not before to', () => {
    const t = '2026-10-10T00:00:00.000Z';
    for (const q of [
      { range: '1h' as const, from: t },
      { range: '1h' as const, to: t },
      { to: t },
      { from: t, to: t },
      { from: '2026-10-12T00:00:00.000Z', to: t },
      { window: true, range: '1h' as const },
      { window: true, from: t },
    ]) {
      expect(resolveTimeWindow(q, o), JSON.stringify(q)).toEqual({ ok: false, code: 'range_invalid' });
    }
  });

  it('the span limit is exactly 3650 days', () => {
    const from = '2010-01-01T00:00:00.000Z';
    const limit = 3650 * 86_400_000;
    const span = (ms: number) => resolveTimeWindow({ from, to: new Date(Date.parse(from) + ms).toISOString() }, o);
    expect(span(limit)).toMatchObject({ ok: true });
    expect(span(limit + 1)).toEqual({ ok: false, code: 'range_too_large' });
  });

  it('rejects a span over 3650 days', () => {
    expect(resolveTimeWindow({ from: '2000-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }, o)).toEqual({
      ok: false,
      code: 'range_too_large',
    });
    expect(resolveTimeWindow({ from: '2020-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }, o)).toMatchObject({
      ok: true,
    });
  });
});

describe('foldQuery (03 5.4: q is folded NFKC then lower case)', () => {
  it('folds compatibility forms and case of the needle, and nothing else', () => {
    expect(foldQuery('ＡＢＣ')).toBe('abc');
    expect(foldQuery('Tiếng Việt')).toBe('tiếng việt');
    expect(foldQuery('a_b%c')).toBe('a_b%c');
    expect(foldQuery('')).toBe('');
  });

  it('is what matchesEventFilter folds the needle with', () => {
    const e = event({ summary: 'abc done' });
    expect(matchesEventFilter(fromQuery(EventListQuerySchema, { q: 'ＡＢＣ' }), e)).toBe(true);
  });
});

describe('panel query (06 3.4, 6.1)', () => {
  it('limit is 1..200 and the schema documents the bounds', () => {
    expect(ok(PanelQuerySchema, { limit: '200' })).toEqual({ limit: 200 });
    expect(bad(PanelQuerySchema, { limit: '201' })).toBe(true);
    expect(bad(PanelQuerySchema, { limit: '0' })).toBe(true);
  });

  it('limit applies to the attempts panel only', () => {
    expect(panelQueryAllowed('attempts', { limit: 10 })).toBe(true);
    expect(panelQueryAllowed('attempts', {})).toBe(true);
    for (const key of ['git', 'machine', 'ledger', 'chainLog', 'logs'] as const) {
      expect(panelQueryAllowed(key, {}), key).toBe(true);
      expect(panelQueryAllowed(key, { limit: 10 }), key).toBe(false);
    }
  });
});

describe('numeric query schemas keep their bounds in the generated JSON Schema (03 13 items 1 and 4)', () => {
  function property(schema: z.ZodType, name: string): unknown {
    const json = z.toJSONSchema(schema, { io: 'input' });
    return json.properties?.[name];
  }

  it.each([
    [SessionListQuerySchema, 'limit', 1, 200],
    [SessionListQuerySchema, 'tokensMax', 0, 1e15],
    [SeriesQuerySchema, 'tzOffsetMinutes', -840, 840],
    [TranscriptWindowQuerySchema, 'after', -1, Number.MAX_SAFE_INTEGER],
    [TranscriptWindowQuerySchema, 'limit', 1, 2000],
    [PanelQuerySchema, 'limit', 1, 200],
  ])('%# %s %s is an integer in [%s, %s]', (schema, name, minimum, maximum) => {
    expect(property(schema, name)).toMatchObject({ type: 'integer', minimum, maximum });
  });

  // a transforming schema loses its `default` in the generated input schema (zod drops it), so the number pipe must not
  // transform; the documented defaults of 03 6.1 reach schemas/api/*.query.schema.json through these
  it.each([
    [SessionListQuerySchema, 'limit', 50],
    [SessionAgentsQuerySchema, 'limit', 200],
    [SessionTimelineQuerySchema, 'limit', 100],
    [EventListQuerySchema, 'limit', 100],
    [ToolCallListQuerySchema, 'limit', 50],
    [AgentListQuerySchema, 'limit', 50],
    [ErrorsQuerySchema, 'limit', 50],
    [AlertListQuerySchema, 'limit', 50],
    [AnalyticsToolsQuerySchema, 'limit', 50],
    [SeriesQuerySchema, 'tzOffsetMinutes', 0],
    [TranscriptWindowQuerySchema, 'after', -1],
    [TranscriptSearchQuerySchema, 'limit', 200],
    [TranscriptSearchQuerySchema, 'budgetMs', 3000],
    [InstanceSearchQuerySchema, 'limit', 100],
    [InstanceSearchQuerySchema, 'budgetMs', 3000],
  ])('%# %s %s defaults to %s', (schema, name, expected) => {
    expect(property(schema, name)).toMatchObject({ default: expected });
  });

  it('the alert status filter documents its default as the query text it parses to [open]', () => {
    expect(property(AlertListQuerySchema, 'status')).toMatchObject({ default: 'open' });
    expect(ok(AlertListQuerySchema, {}).status).toEqual(['open']);
  });

  it('every defaulted number of the query schemas states the default it parses to', () => {
    for (const schema of [
      SessionListQuerySchema,
      SessionAgentsQuerySchema,
      SessionTimelineQuerySchema,
      EventListQuerySchema,
      ToolCallListQuerySchema,
      AgentListQuerySchema,
      ErrorsQuerySchema,
      AlertListQuerySchema,
      AnalyticsToolsQuerySchema,
      SeriesQuerySchema,
      TranscriptWindowQuerySchema,
      TranscriptSearchQuerySchema,
      InstanceSearchQuerySchema,
    ]) {
      const result = schema.safeParse({});
      const parsed: unknown = result.success ? result.data : {};
      const properties = z.toJSONSchema(schema, { io: 'input' }).properties ?? {};
      for (const [key, value] of Object.entries(typeof parsed === 'object' && parsed !== null ? parsed : {})) {
        if (typeof value === 'number') expect(properties[key], key).toMatchObject({ default: value });
      }
    }
  });
});
