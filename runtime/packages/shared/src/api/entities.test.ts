import { describe, expect, it } from 'vitest';

import {
  ACTIVE_STATES,
  ActivityEventSchema,
  AgentNodeSchema,
  AlertItemSchema,
  AlertRulesViewSchema,
  BOARD_STATES,
  CATEGORY_OF,
  CostEstimateSchema,
  EVENT_CATEGORIES,
  EVENT_KINDS,
  EvidenceItemSchema,
  InstanceSearchResponseSchema,
  LIFECYCLE_STATES,
  LegacyStateSchema,
  MetricSchema,
  OVERVIEW_METRIC_KEYS,
  OverviewSchema,
  SessionDetailSchema,
  SessionSummarySchema,
  StateAssessmentSchema,
  TokenUsageSchema,
  ToolCallItemSchema,
  ToolFrequencyReportSchema,
  TranscriptEntrySchema,
  TranscriptLocateResponseSchema,
  TranscriptSearchResponseSchema,
  TranscriptWindowResponseSchema,
  TransitionItemSchema,
  UsageReportSchema,
  UsageSeriesSchema,
  WorkItemSchema,
  EventPageSchema,
  pageSchema,
  type ActivityEvent,
  type LegacyState,
  type LifecycleState,
  type Page,
  type SessionSummary,
} from './entities.ts';

/** A copy of `value` without the key `omit` (the tests need an object with a missing field). */
function without(value: object, omit: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omit));
}

const AT = '2026-10-11T10:00:00.000Z';
const SID = '0b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d11';

const usage = {
  input: 10,
  output: 20,
  cacheCreation: null,
  cacheRead: 5,
  total: 35,
  missing: { input: 0, output: 0, cacheCreation: 3, cacheRead: 0 },
  turns: 3,
  synthetic: 0,
  unfinalized: 1,
  completeness: 'partial',
  scannedPct: 80,
  lowerBound: true,
};

const state = {
  state: 'working',
  presence: 'open',
  waitReason: null,
  staleKind: null,
  endReason: null,
  turnOutcome: null,
  basis: 'observed',
  confidence: 'high',
  rule: 'S-7c',
  evidence: [{ kind: 'hook:tool_pre', at: AT, text: 'Bash started' }],
  since: AT,
  evaluatedAt: AT,
  legacyState: 'RUNNING',
};

const summary = {
  id: SID,
  seq: 4,
  label: 'Fix the build',
  labelSource: 'first_prompt',
  matched: true,
  pinned: false,
  projectId: 'proj',
  projectLabel: 'Proj',
  workItemIds: [2],
  provider: 'claude-code',
  entrypoint: 'cli',
  ccVersion: '3.0.0',
  models: ['m-1'],
  lastModel: 'm-1',
  startedAt: AT,
  lastActivityAt: AT,
  endedAt: null,
  durationMs: 1000,
  state,
  agentCount: 2,
  activeAgentCount: 1,
  toolCallCount: 9,
  pendingTools: 0,
  errorCount: 0,
  warningCount: 1,
  usage,
  usageInclSubagents: usage,
  cost: { amount: 0.5, currency: 'USD', basis: 'estimate', pricedTokensPct: 100, unpricedModels: [] },
  reportedCost: { amountUsd: 0.4, at: AT, trailing: false, label: 'Reported by Claude Code' },
  partial: true,
  sources: { hooks: true, transcript: true },
  freshness: {
    lastHookAt: AT,
    lastTranscriptAt: AT,
    transcriptLagBytes: 0,
    hookCoverage: 'full',
    eventsComplete: true,
    usageComplete: false,
  },
};

const detail = {
  ...summary,
  cwd: null,
  gitBranch: 'main',
  permissionMode: 'default',
  claudePid: 1234,
  continuedIn: null,
  copiedFrom: null,
  hookMissing: { tools: 0, turns: 0 },
  external: [{ source: 'registry', observedAt: AT, value: { a: 'x', b: 1, c: true, d: null } }],
  workItems: [{ id: 2, title: 'Item', state: 'working' }],
  files: [
    {
      agentId: 'main',
      kind: 'session',
      state: 'active',
      sizeBytes: 100,
      importedBytes: 100,
      behindBytes: 0,
      entries: 4,
      usageState: 'complete',
    },
  ],
  filesTruncated: false,
  copiedMessages: 0,
  reconciliations: [{ kind: 'downtime', at: AT, detail: { minutes: 3 } }],
  auditRefs: [{ file: 'changes', at: AT, title: 'T', summary: 'S' }],
};

const agent = {
  id: 'main',
  seq: 1,
  sessionId: SID,
  kind: 'main',
  depth: 0,
  parentAgentId: null,
  parentToolUseId: null,
  agentType: null,
  label: 'main',
  workflow: { runId: 'wf_x', name: null, phase: null, state: 'working' },
  requestShape: null,
  model: 'm-1',
  startedAt: AT,
  lastActivityAt: AT,
  endedAt: null,
  state,
  usage,
  toolCallCount: 1,
  errorCount: 0,
  transcript: { state: 'active', sizeBytes: 1, importedBytes: 1 },
};

const event: ActivityEvent = {
  id: 1,
  seq: 1,
  key: 'h:abc',
  sessionId: SID,
  sessionLabel: 'Fix the build',
  agentId: 'main',
  agentLabel: null,
  at: AT,
  atSource: 'record',
  receivedAt: AT,
  sources: ['hook', 'transcript'],
  source: 'hook',
  type: 'tool.call',
  category: 'tool',
  severity: 'info',
  hookEvent: 'PreToolUse',
  entryKind: 'tool',
  toolName: 'Bash',
  toolUseId: 'toolu_1',
  toolStatus: 'pending',
  durationMs: null,
  summary: 'ls',
  details: { a: 'x', n: 1, b: false, z: null },
  transcriptRef: { agentId: 'main', offset: 10 },
};

const toolCall = {
  id: 1,
  seq: 1,
  toolUseId: 'toolu_1',
  sessionId: SID,
  agentId: 'main',
  promptId: null,
  name: 'Bash',
  mcpServer: null,
  status: 'succeeded',
  outcome: 'ok',
  summary: 'ls',
  inputBytes: 10,
  startedAt: AT,
  endedAt: AT,
  batchAt: null,
  durationMs: 5,
  durationSource: 'hook',
  exitCode: 0,
  sources: ['hook_pre', 'hook_post'],
  subagentId: null,
  workflowRunId: null,
  transcriptRef: null,
};

const workItem = {
  id: 2,
  key: 'declared:one',
  seq: 3,
  title: 'Item',
  source: 'attempts',
  rule: 'W-ATT',
  state: 'working',
  boardReason: 'one member is working',
  evidence: [{ kind: 'work_item:member', at: null, text: 'Fix: working (S-7c)' }],
  since: AT,
  sessionIds: [SID],
  sessionCount: 1,
  lastActivityAt: AT,
  usage: null,
};

const alert = {
  id: 1,
  seq: 1,
  ruleId: 'inactivity',
  rule: 'inactivity',
  severity: 'warning',
  status: 'open',
  title: 'No activity for 47 min',
  scope: { kind: 'session', key: SID },
  sessionId: SID,
  since: AT,
  lastFiredAt: AT,
  fireCount: 2,
  resolvedAt: null,
  resolvedReason: null,
  detail: { minutes: 47 },
};

describe('enumerations (03 5.5, registry 1.1 and 11)', () => {
  it('lifecycle states are the ten values of 02 7.1, active states a subset', () => {
    expect([...LIFECYCLE_STATES]).toEqual([
      'running',
      'working',
      'waiting_input',
      'waiting_tool',
      'waiting_agent',
      'turn_ended',
      'completed',
      'failed',
      'stale',
      'unknown',
    ]);
    expect([...ACTIVE_STATES]).toEqual(['running', 'working', 'waiting_tool', 'waiting_agent']);
    for (const s of ACTIVE_STATES) expect(LIFECYCLE_STATES).toContain(s);
  });

  it('board states are the six of 02 7.11', () => {
    expect([...BOARD_STATES]).toEqual(['working', 'waiting', 'completed', 'failed', 'stale', 'unknown']);
  });

  it('LegacyState is declared once with its five values (C36)', () => {
    expect(LegacyStateSchema.options).toEqual(['RUNNING', 'IDLE', 'COMPLETED', 'FAILED', 'UNKNOWN']);
    const legacy: LegacyState = 'IDLE';
    const lifecycle: LifecycleState = 'stale';
    expect([legacy, lifecycle]).toEqual(['IDLE', 'stale']);
  });

  it('has 33 event kinds and every kind maps to exactly one of the 8 categories', () => {
    expect(EVENT_KINDS).toHaveLength(33);
    expect(new Set(EVENT_KINDS).size).toBe(33);
    expect(EVENT_CATEGORIES).toEqual([
      'lifecycle',
      'prompt',
      'tool',
      'agent',
      'notification',
      'compaction',
      'error',
      'ingest',
    ]);
    expect(Object.keys(CATEGORY_OF).sort()).toEqual([...EVENT_KINDS].sort());
    for (const kind of EVENT_KINDS) expect(EVENT_CATEGORIES).toContain(CATEGORY_OF[kind]);
    // every category is used by at least one kind
    expect(new Set(Object.values(CATEGORY_OF)).size).toBe(8);
  });

  it('overview metrics are the 17 keys of 03 8.1', () => {
    expect([...OVERVIEW_METRIC_KEYS]).toEqual([
      'sessions.active',
      'sessions.waiting_input',
      'sessions.turn_ended',
      'sessions.completed',
      'sessions.failed',
      'sessions.stale',
      'sessions.unknown',
      'agents.running',
      'events.errors',
      'tokens.input',
      'tokens.input_new',
      'tokens.output',
      'tokens.cache_creation',
      'tokens.cache_read',
      'cost.estimate',
      'cost.reported',
      'alerts.open',
    ]);
  });
});

describe('entity schemas', () => {
  it('parse the samples unchanged (strict objects drop nothing)', () => {
    expect(EvidenceItemSchema.parse(state.evidence[0])).toEqual(state.evidence[0]);
    expect(StateAssessmentSchema.parse(state)).toEqual(state);
    expect(TokenUsageSchema.parse(usage)).toEqual(usage);
    expect(CostEstimateSchema.parse(summary.cost)).toEqual(summary.cost);
    expect(SessionSummarySchema.parse(summary)).toEqual(summary);
    expect(SessionDetailSchema.parse(detail)).toEqual(detail);
    expect(AgentNodeSchema.parse(agent)).toEqual(agent);
    expect(ActivityEventSchema.parse(event)).toEqual(event);
    expect(ToolCallItemSchema.parse(toolCall)).toEqual(toolCall);
    expect(WorkItemSchema.parse(workItem)).toEqual(workItem);
    expect(AlertItemSchema.parse(alert)).toEqual(alert);
    expect(
      TransitionItemSchema.parse({
        id: 1,
        at: AT,
        agentId: null,
        from: null,
        to: 'working',
        rule: 'S-7c',
        basis: 'inferred',
        confidence: 'low',
        evidence: [],
      }),
    ).toMatchObject({ to: 'working' });
  });

  it('every object is strict: an undocumented field fails', () => {
    for (const [schema, sample] of [
      [StateAssessmentSchema, state],
      [TokenUsageSchema, usage],
      [SessionSummarySchema, summary],
      [SessionDetailSchema, detail],
      [AgentNodeSchema, agent],
      [ActivityEventSchema, event],
      [ToolCallItemSchema, toolCall],
      [WorkItemSchema, workItem],
      [AlertItemSchema, alert],
    ] as const) {
      expect(schema.safeParse({ ...sample, surprise: 1 }).success).toBe(false);
    }
    expect(SessionSummarySchema.safeParse({ ...summary, state: { ...state, surprise: 1 } }).success).toBe(false);
    expect(SessionSummarySchema.safeParse({ ...summary, usage: { ...usage, surprise: 1 } }).success).toBe(false);
  });

  it('SessionDetail extends SessionSummary: a summary is not a detail', () => {
    expect(SessionDetailSchema.safeParse(summary).success).toBe(false);
    expect(SessionSummarySchema.safeParse(detail).success).toBe(false);
  });

  it('missing is null and zero is zero (DA-I9)', () => {
    expect(TokenUsageSchema.safeParse({ ...usage, input: 0, output: 0, cacheRead: 0, total: 0 }).success).toBe(true);
    expect(
      TokenUsageSchema.safeParse({
        ...usage,
        input: null,
        output: null,
        cacheRead: null,
        cacheCreation: null,
        total: null,
        turns: 0,
        scannedPct: null,
      }).success,
    ).toBe(true);
    expect(TokenUsageSchema.safeParse({ ...usage, input: undefined }).success).toBe(false);
    expect(TokenUsageSchema.safeParse({ ...usage, input: -1 }).success).toBe(false);
    expect(TokenUsageSchema.safeParse({ ...usage, completeness: 'whole' }).success).toBe(false);
  });

  it('timestamps are millisecond UTC strings', () => {
    expect(SessionSummarySchema.safeParse({ ...summary, startedAt: '2026-10-11T10:00:00Z' }).success).toBe(false);
    expect(SessionSummarySchema.safeParse({ ...summary, startedAt: 1_780_000_000_000 }).success).toBe(false);
  });

  it('event ids are positive integers, never strings (I-10)', () => {
    expect(ActivityEventSchema.safeParse({ ...event, id: '1' }).success).toBe(false);
    expect(ActivityEventSchema.safeParse({ ...event, id: 0 }).success).toBe(false);
    expect(ActivityEventSchema.safeParse({ ...event, transcriptRef: { agentId: 'main', index: 3 } }).success).toBe(
      false,
    );
    expect(ActivityEventSchema.safeParse({ ...event, source: 'derived' }).success).toBe(false);
    expect(ActivityEventSchema.safeParse({ ...event, details: { nested: { a: 1 } } }).success).toBe(false);
  });

  it('work item names follow I-10 and C52', () => {
    expect(WorkItemSchema.safeParse({ ...workItem, source: 'attempt' }).success).toBe(false);
    for (const source of ['declared', 'attempts', 'label']) {
      expect(WorkItemSchema.safeParse({ ...workItem, source }).success).toBe(true);
    }
    expect(WorkItemSchema.safeParse({ ...workItem, rule: 'W-XYZ' }).success).toBe(false);
    expect(SessionSummarySchema.safeParse({ ...summary, taskIds: [1] }).success).toBe(false);
    expect(SessionSummarySchema.safeParse(without(summary, 'workItemIds')).success).toBe(false);
  });

  it('alert rule kinds are the eight of 03 10.1 and resolution reasons are closed', () => {
    for (const rule of [
      'inactivity',
      'ingest_errors',
      'runtime_unavailable',
      'token_threshold',
      'import_lag',
      'db_disk',
      'hook_gap',
      'hook_failing',
    ]) {
      expect(AlertItemSchema.safeParse({ ...alert, rule }).success).toBe(true);
    }
    expect(AlertItemSchema.safeParse({ ...alert, rule: 'other' }).success).toBe(false);
    expect(AlertItemSchema.safeParse({ ...alert, resolvedReason: 'acknowledged' }).success).toBe(false);
    expect(AlertItemSchema.safeParse({ ...alert, severity: 'info' }).success).toBe(false);
  });

  it('alert rules view (note N4) lists one row per rule', () => {
    const view = {
      asOfSeq: 5,
      enabled: true,
      sweepSeconds: 60,
      rules: [
        {
          ruleId: 'inactivity',
          rule: 'inactivity',
          enabled: true,
          scopeKind: 'session',
          settings: { minutes: 30 },
          openCount: 1,
        },
      ],
    };
    expect(AlertRulesViewSchema.parse(view)).toEqual(view);
    expect(AlertRulesViewSchema.safeParse({ ...view, rules: [{ ...view.rules[0], extra: 1 }] }).success).toBe(false);
  });
});

describe('pages', () => {
  it('Page<T> carries the six fields of 03 5.3', () => {
    const schema = pageSchema(AlertItemSchema);
    const page: Page<unknown> = {
      items: [alert],
      nextCursor: null,
      asOfSeq: 7,
      total: null,
      totalIsLowerBound: false,
      limit: 50,
    };
    expect(schema.parse(page)).toEqual(page);
    expect(schema.safeParse({ ...page, nextCursor: 'c', total: 10000, totalIsLowerBound: true }).success).toBe(true);
    expect(schema.safeParse({ ...page, extra: 1 }).success).toBe(false);
    expect(schema.safeParse(without(page, 'limit')).success).toBe(false);
    expect(schema.safeParse({ ...page, items: [{ ...alert, id: 'x' }] }).success).toBe(false);
  });

  it('EventPage adds scanCapped and newerCursor', () => {
    const page = {
      items: [event],
      nextCursor: null,
      asOfSeq: 7,
      total: null,
      totalIsLowerBound: false,
      limit: 100,
      scanCapped: false,
      newerCursor: null,
    };
    expect(EventPageSchema.parse(page)).toEqual(page);
    expect(EventPageSchema.safeParse(without(page, 'scanCapped')).success).toBe(false);
  });

  it('a session summary page type-checks against Page<SessionSummary>', () => {
    const typed: Page<SessionSummary> = pageSchema(SessionSummarySchema).parse({
      items: [summary],
      nextCursor: null,
      asOfSeq: 1,
      total: 1,
      totalIsLowerBound: false,
      limit: 50,
    });
    expect(typed.items[0]?.workItemIds).toEqual([2]);
  });
});

describe('transcript, search, analytics and overview shapes (03 7.3, 7.4, 8)', () => {
  const coverage = {
    scope: 'session',
    filesInScope: 1,
    filesScanned: 1,
    filesMissing: 0,
    filesUnreadable: 0,
    bytesInScope: 10,
    bytesScanned: 10,
    bytesNotIndexed: 0,
    entriesScanned: 3,
    complete: true,
    stoppedBy: 'complete',
    elapsedMs: 4,
    note: 'Searched 1 of 1 transcript files (10 B) of 1 sessions.',
  };

  it('transcript entries use the five kinds', () => {
    expect(TranscriptEntrySchema.safeParse({ i: 0, t: AT, k: 'prompt', text: 'hi' }).success).toBe(true);
    expect(TranscriptEntrySchema.safeParse({ i: 0, t: '', k: 'result', err: true }).success).toBe(true);
    expect(TranscriptEntrySchema.safeParse({ i: 0, t: '', k: 'other' }).success).toBe(false);
    expect(TranscriptEntrySchema.safeParse({ i: -1, t: '', k: 'say' }).success).toBe(false);
  });

  it('window and locate responses', () => {
    const window = {
      sessionId: SID,
      agentId: 'main',
      total: 3,
      base: 0,
      from: 0,
      next: 3,
      partial: false,
      skippedBytes: 0,
      pendingBytes: 0,
      fileState: 'active',
      asOfSeq: 1,
      events: [{ i: 0, t: AT, k: 'say', text: 'x' }],
    };
    expect(TranscriptWindowResponseSchema.parse(window)).toEqual(window);
    expect(TranscriptWindowResponseSchema.safeParse({ ...window, base: 1 }).success).toBe(false);
    expect(TranscriptLocateResponseSchema.safeParse({ i: 1, t: AT, base: 0, total: 3 }).success).toBe(true);
  });

  it('search responses carry coverage and the echoed query', () => {
    const response = {
      matches: [{ i: 1, k: 'tool', t: AT, name: 'Bash', snippet: 'ls', offset: 100 }],
      count: 1,
      truncated: false,
      partial: false,
      complete: true,
      searchedEntries: 3,
      query: { q: 'ls', kinds: ['tool'], tool: null, errors: false },
      coverage,
    };
    expect(TranscriptSearchResponseSchema.parse(response)).toEqual(response);
    expect(
      TranscriptSearchResponseSchema.safeParse({ ...response, coverage: { ...coverage, stoppedBy: 'user' } }).success,
    ).toBe(false);
    const instance = {
      query: { q: 'ls', kinds: ['tool'] },
      matches: [
        { sessionId: SID, sessionLabel: 'L', agentId: 'main', i: 1, k: 'tool', t: AT, name: null, snippet: 'ls' },
      ],
      truncated: false,
      coverage: { ...coverage, scope: 'instance' },
      continuation: null,
    };
    expect(InstanceSearchResponseSchema.parse(instance)).toEqual(instance);
  });

  it('overview metrics carry source, rule and completeness', () => {
    const metric = {
      key: 'sessions.active',
      label: 'Active sessions',
      value: 3,
      unit: 'count',
      source: 'sessions.state',
      rule: 'in window',
      completeness: 'complete',
      asOf: AT,
      link: '/sessions?state=active',
    };
    expect(MetricSchema.parse(metric)).toEqual(metric);
    expect(MetricSchema.safeParse({ ...metric, unit: 'currency', currency: 'USD', value: null }).success).toBe(true);
    expect(MetricSchema.safeParse({ ...metric, source: undefined }).success).toBe(false);
    const overview = {
      asOfSeq: 1,
      generatedAt: AT,
      window: { from: null, to: AT, source: 'window_hours' },
      metrics: [metric],
      recentActivity: [event],
      recentErrors: [],
      alerts: { open: 1, critical: 0, items: [alert] },
    };
    expect(OverviewSchema.parse(overview)).toEqual(overview);
  });

  it('usage report, series and tool frequency', () => {
    const row = { key: 'm-1', label: 'm-1', usage, cost: null, sessions: 2 };
    const report = {
      asOfSeq: 1,
      window: { from: null, to: AT },
      groupBy: 'model',
      totals: row,
      rows: [row],
      rowsTruncated: false,
      source: 'Token usage from transcript assistant records.',
      cost: {
        currency: 'USD',
        basis: 'estimate',
        source: 'configured_prices',
        amount: 1.5,
        pricedTokensPct: 100,
        pricedModels: ['m-1'],
        unpricedModels: [],
        assumedCacheWriteTier: false,
        note: 'Estimate from prices configured in runtime.json; not a bill.',
      },
      reportedCost: { amountUsd: 1.2, sessionsWithReport: 1, sessionsInScope: 2, label: 'Reported' },
    };
    expect(UsageReportSchema.parse(report)).toEqual(report);
    const point = {
      start: AT,
      input: 1,
      output: 2,
      cacheCreation: 3,
      cacheRead: 4,
      messages: 5,
      completeness: 'complete',
    };
    const series = {
      asOfSeq: 1,
      bucket: 'day',
      tzOffsetMinutes: 0,
      window: { from: AT, to: AT },
      points: [point],
      series: null,
    };
    expect(UsageSeriesSchema.parse(series)).toEqual(series);
    expect(UsageSeriesSchema.safeParse({ ...series, points: [{ ...point, input: null }] }).success).toBe(false);
    const tools = {
      asOfSeq: 1,
      window: { from: null, to: AT },
      items: [
        {
          toolName: 'Bash',
          mcpServer: null,
          calls: 3,
          succeeded: 2,
          failed: 1,
          denied: 0,
          interrupted: 0,
          pending: 0,
          unknown: 0,
          failurePct: 33.3,
          medianDurationMs: 5,
          maxDurationMs: 9,
        },
      ],
      sampled: false,
    };
    expect(ToolFrequencyReportSchema.parse(tools)).toEqual(tools);
    expect(ToolFrequencyReportSchema.safeParse({ ...tools, items: [{ ...tools.items[0], failures: 1 }] }).success).toBe(
      false,
    );
  });
});
