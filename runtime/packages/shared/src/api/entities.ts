// Shared entity schemas of API v3 (03 5.5, 7.1, 7.3, 7.4, 8.1-8.4, registry 1.1-1.4). Every shape is a strict Zod schema
// and its TypeScript type is the `z.infer` of it: no consumer redeclares one. Unknown is `null`, zero is `0` (DA-I9).
import { z } from 'zod';

import {
  AgentIdSchema,
  CountSchema,
  PositiveIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  SessionIdSchema,
  ToolUseIdSchema,
} from './ids.ts';
import { IsoTimeSchema, NullableIsoTimeSchema } from './time.ts';

// ---- enumerations ------------------------------------------------------------------------------------------------

/** The ten lifecycle states of 02 7.1. */
export const LIFECYCLE_STATES = [
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
] as const;
export const LifecycleStateSchema = z.enum(LIFECYCLE_STATES);
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;

/** The alias `state=active` of the filter model. */
export const ACTIVE_STATES = [
  'running',
  'working',
  'waiting_tool',
  'waiting_agent',
] as const satisfies readonly LifecycleState[];

/** `toLegacy()` of 02 7.9. Declared here once and imported by 02, 05 and 06 (registry C36). */
export const LEGACY_STATES = ['RUNNING', 'IDLE', 'COMPLETED', 'FAILED', 'UNKNOWN'] as const;
export const LegacyStateSchema = z.enum(LEGACY_STATES);
export type LegacyState = z.infer<typeof LegacyStateSchema>;

export const BOARD_STATES = ['working', 'waiting', 'completed', 'failed', 'stale', 'unknown'] as const;
export const BoardStateSchema = z.enum(BOARD_STATES);
export type BoardState = z.infer<typeof BoardStateSchema>;

/** The 33 stored event kinds (03 3.6, registry 11.4). */
export const EVENT_KINDS = [
  'session.start',
  'session.end',
  'prompt.submit',
  'prompt.queued',
  'assistant.message',
  'assistant.thinking',
  'tool.call',
  'tool.result',
  'tool.failure',
  'tool.batch',
  'permission.request',
  'permission.denied',
  'notification.sent',
  'agent.start',
  'agent.stop',
  'agent.final',
  'agent.notification',
  'turn.stop',
  'turn.failure',
  'turn.duration',
  'turn.interrupt',
  'api.error',
  'context.compact',
  'model.switch',
  'cwd.change',
  'task.created',
  'task.completed',
  'teammate.idle',
  'system.info',
  'hook.handler_error',
  'hook.unknown',
  'monitor.gap',
  'monitor.reconcile',
] as const;
export const EventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKindSchema>;

export const EVENT_CATEGORIES = [
  'lifecycle',
  'prompt',
  'tool',
  'agent',
  'notification',
  'compaction',
  'error',
  'ingest',
] as const;
export const EventCategorySchema = z.enum(EVENT_CATEGORIES);
export type EventCategory = z.infer<typeof EventCategorySchema>;

export const CATEGORY_OF: Readonly<Record<EventKind, EventCategory>> = {
  'session.start': 'lifecycle',
  'session.end': 'lifecycle',
  'turn.stop': 'lifecycle',
  'turn.duration': 'lifecycle',
  'turn.interrupt': 'lifecycle',
  'model.switch': 'lifecycle',
  'cwd.change': 'lifecycle',
  'task.created': 'lifecycle',
  'task.completed': 'lifecycle',
  'teammate.idle': 'lifecycle',
  'system.info': 'lifecycle',
  'prompt.submit': 'prompt',
  'prompt.queued': 'prompt',
  'assistant.message': 'prompt',
  'assistant.thinking': 'prompt',
  'tool.call': 'tool',
  'tool.result': 'tool',
  'tool.failure': 'tool',
  'tool.batch': 'tool',
  'permission.request': 'notification',
  'permission.denied': 'notification',
  'notification.sent': 'notification',
  'agent.start': 'agent',
  'agent.stop': 'agent',
  'agent.final': 'agent',
  'agent.notification': 'agent',
  'context.compact': 'compaction',
  'turn.failure': 'error',
  'api.error': 'error',
  'hook.handler_error': 'ingest',
  'hook.unknown': 'ingest',
  'monitor.gap': 'ingest',
  'monitor.reconcile': 'ingest',
};

/**
 * Derived from `tool_calls`: outcome ok -> succeeded, error -> failed, denied -> denied, interrupted -> interrupted;
 * outcome NULL and `batch_at` set -> denied; NULL and its turn ended -> unknown; else pending.
 */
export const TOOL_STATUSES = ['pending', 'succeeded', 'failed', 'denied', 'interrupted', 'unknown'] as const;
export const ToolStatusSchema = z.enum(TOOL_STATUSES);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const COMPLETENESS = ['complete', 'partial', 'unavailable'] as const;
export const CompletenessSchema = z.enum(COMPLETENESS);
export type Completeness = z.infer<typeof CompletenessSchema>;

export const TRANSCRIPT_FILE_STATES = ['active', 'missing', 'unreadable', 'untracked', 'retired'] as const;
export const TranscriptFileStateSchema = z.enum(TRANSCRIPT_FILE_STATES);
export type TranscriptFileState = z.infer<typeof TranscriptFileStateSchema>;

// ---- small building blocks ---------------------------------------------------------------------------------------

/** Free-form but flat key/value detail, as stored in `events.detail` and similar columns. */
export const DetailRecordSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type DetailRecord = z.infer<typeof DetailRecordSchema>;

const SeqSchema = CountSchema;
const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
const BasisSchema = z.enum(['observed', 'inferred']);

/** The API form of lifecycle evidence; `text` is rendered at response time and is never transcript content. */
export const EvidenceItemSchema = z.strictObject({
  /** `<source>:<fact>` of 02 7.1 `LifecycleEvidence`. */
  kind: z.string(),
  at: NullableIsoTimeSchema,
  text: z.string(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const StateAssessmentSchema = z.strictObject({
  state: LifecycleStateSchema,
  presence: z.enum(['open', 'ended', 'unknown']),
  waitReason: z.enum(['user', 'permission', 'elicitation', 'agent_input', 'idle_prompt']).nullable(),
  staleKind: z.enum(['silent', 'abandoned', 'process_gone', 'parent_ended']).nullable(),
  endReason: z.string().nullable(),
  turnOutcome: z.enum(['ok', 'error', 'interrupted']).nullable(),
  basis: BasisSchema,
  confidence: ConfidenceSchema,
  /** The decision rule, for example `S-7c`. */
  rule: z.string(),
  evidence: z.array(EvidenceItemSchema).max(8),
  since: NullableIsoTimeSchema,
  evaluatedAt: NullableIsoTimeSchema,
  legacyState: LegacyStateSchema,
});
export type StateAssessment = z.infer<typeof StateAssessmentSchema>;

const nullableCount = CountSchema.nullable();

/** Projection of 02 6.3. A field is `null` when every counted message misses it. */
export const TokenUsageSchema = z.strictObject({
  input: nullableCount,
  output: nullableCount,
  cacheCreation: nullableCount,
  cacheRead: nullableCount,
  /** Sum of the four non-null fields; `null` when `turns` is 0. */
  total: nullableCount,
  /** Messages without a value, per field. */
  missing: z.strictObject({
    input: CountSchema,
    output: CountSchema,
    cacheCreation: CountSchema,
    cacheRead: CountSchema,
  }),
  /** Counted message keys (synthetic included, legacy parity). */
  turns: CountSchema,
  synthetic: CountSchema,
  unfinalized: CountSchema,
  completeness: CompletenessSchema,
  scannedPct: z.number().min(0).max(100).nullable(),
  lowerBound: z.boolean(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const CostEstimateSchema = z.strictObject({
  amount: z.number().min(0),
  currency: z.string(),
  basis: z.literal('estimate'),
  pricedTokensPct: z.number().min(0).max(100),
  unpricedModels: z.array(z.string()),
});
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

// ---- sessions, agents, events, tool calls, transitions, work items, alerts -----------------------------------------

export const SessionSummarySchema = z.strictObject({
  id: SessionIdSchema,
  seq: SeqSchema,
  label: z.string(),
  labelSource: z.enum(['rule', 'custom_title', 'ai_title', 'first_prompt', 'none']),
  matched: z.boolean(),
  pinned: z.boolean(),
  projectId: ProjectIdSchema.nullable(),
  projectLabel: z.string().nullable(),
  workItemIds: z.array(PositiveIdSchema),
  provider: z.literal('claude-code'),
  entrypoint: z.string().nullable(),
  ccVersion: z.string().nullable(),
  models: z.array(z.string()),
  lastModel: z.string().nullable(),
  startedAt: IsoTimeSchema,
  lastActivityAt: IsoTimeSchema,
  endedAt: NullableIsoTimeSchema,
  durationMs: CountSchema,
  state: StateAssessmentSchema,
  agentCount: CountSchema,
  activeAgentCount: CountSchema,
  toolCallCount: CountSchema,
  pendingTools: CountSchema,
  errorCount: CountSchema,
  warningCount: CountSchema,
  /** Main agent (scope `own`). */
  usage: TokenUsageSchema,
  /** Scope `total` (legacy `usage_total`). */
  usageInclSubagents: TokenUsageSchema,
  /** Of `usageInclSubagents`; `null` without configured prices. */
  cost: CostEstimateSchema.nullable(),
  /** Provider cost state (02 6.6). */
  reportedCost: z
    .strictObject({ amountUsd: z.number().min(0), at: IsoTimeSchema, trailing: z.boolean(), label: z.string() })
    .nullable(),
  /** `usageInclSubagents.completeness !== 'complete'`. */
  partial: z.boolean(),
  sources: z.strictObject({ hooks: z.boolean(), transcript: z.boolean() }),
  freshness: z.strictObject({
    lastHookAt: NullableIsoTimeSchema,
    lastTranscriptAt: NullableIsoTimeSchema,
    transcriptLagBytes: CountSchema,
    hookCoverage: z.enum(['none', 'full', 'partial']),
    eventsComplete: z.boolean(),
    usageComplete: z.boolean(),
  }),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

const AuditRefSchema = z.strictObject({
  file: z.enum(['changes', 'decisions']),
  at: IsoTimeSchema,
  title: z.string(),
  summary: z.string(),
});

export const SessionDetailSchema = SessionSummarySchema.extend({
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  permissionMode: z.string().nullable(),
  claudePid: CountSchema.nullable(),
  continuedIn: z.string().nullable(),
  copiedFrom: z.string().nullable(),
  hookMissing: z.strictObject({ tools: CountSchema, turns: CountSchema }),
  external: z.array(
    z.strictObject({
      source: z.enum(['registry', 'job', 'pid', 'attempt']),
      observedAt: IsoTimeSchema,
      value: DetailRecordSchema,
    }),
  ),
  workItems: z.array(z.strictObject({ id: PositiveIdSchema, title: z.string(), state: BoardStateSchema })),
  files: z
    .array(
      z.strictObject({
        agentId: AgentIdSchema,
        kind: z.enum(['session', 'subagent', 'workflow_agent', 'workflow_journal', 'workflow_status']),
        state: TranscriptFileStateSchema,
        sizeBytes: CountSchema,
        importedBytes: CountSchema,
        behindBytes: CountSchema,
        entries: CountSchema,
        usageState: z.enum(['complete', 'partial', 'skipped_backfill']),
      }),
    )
    .max(500),
  filesTruncated: z.boolean(),
  /** Message keys in this session's files that another session owns (02 6.3). */
  copiedMessages: CountSchema,
  reconciliations: z.array(z.strictObject({ kind: z.string(), at: IsoTimeSchema, detail: DetailRecordSchema })).max(20),
  /** At most 10 audit references (01 7.1), attached by the route handler after the snapshot (I-19). */
  auditRefs: z.array(AuditRefSchema).max(10),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

export const AGENT_KINDS = ['main', 'subagent', 'workflow_agent', 'teammate', 'internal'] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const AgentNodeSchema = z.strictObject({
  id: AgentIdSchema,
  seq: SeqSchema,
  sessionId: SessionIdSchema,
  kind: AgentKindSchema,
  depth: CountSchema,
  parentAgentId: AgentIdSchema.nullable(),
  parentToolUseId: ToolUseIdSchema.nullable(),
  agentType: z.string().nullable(),
  label: z.string(),
  workflow: z
    .strictObject({
      runId: RunIdSchema,
      name: z.string().nullable(),
      phase: z.string().nullable(),
      state: LifecycleStateSchema,
    })
    .nullable(),
  requestShape: z.enum(['foreground', 'background']).nullable(),
  model: z.string().nullable(),
  startedAt: IsoTimeSchema,
  lastActivityAt: IsoTimeSchema,
  endedAt: NullableIsoTimeSchema,
  state: StateAssessmentSchema,
  usage: TokenUsageSchema,
  toolCallCount: CountSchema,
  errorCount: CountSchema,
  transcript: z
    .strictObject({ state: TranscriptFileStateSchema, sizeBytes: CountSchema, importedBytes: CountSchema })
    .nullable(),
});
export type AgentNode = z.infer<typeof AgentNodeSchema>;

export const EVENT_SOURCES = ['hook', 'transcript', 'monitor'] as const;
const TranscriptRefSchema = z.strictObject({ agentId: AgentIdSchema, offset: CountSchema });

export const ActivityEventSchema = z.strictObject({
  id: PositiveIdSchema,
  seq: SeqSchema,
  /** Natural key, `h:<event uid>` or `t:<record uuid>`. */
  key: z.string(),
  sessionId: SessionIdSchema,
  sessionLabel: z.string(),
  agentId: AgentIdSchema.nullable(),
  agentLabel: z.string().nullable(),
  at: IsoTimeSchema,
  atSource: z.enum(['record', 'hook_received', 'derived']),
  receivedAt: IsoTimeSchema,
  sources: z.array(z.enum(EVENT_SOURCES)),
  /** First of `sources` in the order hook, transcript, monitor. */
  source: z.enum(EVENT_SOURCES),
  type: EventKindSchema,
  category: EventCategorySchema,
  severity: z.enum(['info', 'warning', 'error']),
  hookEvent: z.string().nullable(),
  entryKind: z.enum(['prompt', 'say', 'think', 'tool', 'result', 'system', 'attachment']).nullable(),
  toolName: z.string().nullable(),
  toolUseId: ToolUseIdSchema.nullable(),
  toolStatus: ToolStatusSchema.nullable(),
  durationMs: CountSchema.nullable(),
  /** Empty when there is none. */
  summary: z.string(),
  /** Allow-listed keys of `events.detail`, at most 24. */
  details: DetailRecordSchema.refine((record) => Object.keys(record).length <= 24, 'at most 24 detail keys'),
  /** Resolve with `GET .../transcript/locate?offset=`. */
  transcriptRef: TranscriptRefSchema.nullable(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ToolCallItemSchema = z.strictObject({
  id: PositiveIdSchema,
  seq: SeqSchema,
  toolUseId: ToolUseIdSchema,
  sessionId: SessionIdSchema,
  agentId: AgentIdSchema,
  promptId: z.string().nullable(),
  name: z.string(),
  mcpServer: z.string().nullable(),
  status: ToolStatusSchema,
  outcome: z.enum(['ok', 'error', 'denied', 'interrupted']).nullable(),
  summary: z.string().nullable(),
  inputBytes: CountSchema.nullable(),
  startedAt: NullableIsoTimeSchema,
  endedAt: NullableIsoTimeSchema,
  batchAt: NullableIsoTimeSchema,
  durationMs: CountSchema.nullable(),
  durationSource: z.enum(['hook', 'timestamps']).nullable(),
  exitCode: z.number().int().nullable(),
  sources: z.array(z.enum(['hook_pre', 'hook_post', 'transcript_use', 'transcript_result', 'hook_batch'])),
  subagentId: AgentIdSchema.nullable(),
  workflowRunId: RunIdSchema.nullable(),
  transcriptRef: TranscriptRefSchema.nullable(),
});
export type ToolCallItem = z.infer<typeof ToolCallItemSchema>;

export const TransitionItemSchema = z.strictObject({
  id: PositiveIdSchema,
  at: IsoTimeSchema,
  agentId: AgentIdSchema.nullable(),
  from: LifecycleStateSchema.nullable(),
  to: LifecycleStateSchema,
  rule: z.string(),
  basis: BasisSchema,
  confidence: ConfidenceSchema,
  evidence: z.array(EvidenceItemSchema).max(8),
});
export type TransitionItem = z.infer<typeof TransitionItemSchema>;

export const WORK_ITEM_SOURCES = ['declared', 'attempts', 'label'] as const;
export const WORK_ITEM_RULES = ['W-DECL', 'W-ATT', 'W-LBL'] as const;

export const WorkItemSchema = z.strictObject({
  id: PositiveIdSchema,
  key: z.string(),
  seq: SeqSchema,
  title: z.string(),
  /** `work_items.kind` with `attempt` spelled `attempts` (registry C52). */
  source: z.enum(WORK_ITEM_SOURCES),
  rule: z.enum(WORK_ITEM_RULES),
  state: BoardStateSchema,
  boardReason: z.string(),
  /** One item per member: `<label>: <state> (<rule>)`. */
  evidence: z.array(EvidenceItemSchema),
  since: IsoTimeSchema,
  sessionIds: z.array(SessionIdSchema).max(50),
  sessionCount: CountSchema,
  lastActivityAt: NullableIsoTimeSchema,
  usage: TokenUsageSchema.nullable(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const ALERT_RULE_KINDS = [
  'inactivity',
  'ingest_errors',
  'runtime_unavailable',
  'token_threshold',
  'import_lag',
  'db_disk',
  'hook_gap',
  'hook_failing',
] as const;
export const AlertRuleKindSchema = z.enum(ALERT_RULE_KINDS);
export type AlertRuleKind = z.infer<typeof AlertRuleKindSchema>;

export const ALERT_SCOPE_KINDS = ['instance', 'session', 'code'] as const;

export const AlertItemSchema = z.strictObject({
  id: PositiveIdSchema,
  seq: SeqSchema,
  ruleId: z.string(),
  rule: AlertRuleKindSchema,
  severity: z.enum(['warning', 'critical']),
  status: z.enum(['open', 'resolved']),
  title: z.string(),
  scope: z.strictObject({ kind: z.enum(ALERT_SCOPE_KINDS), key: z.string() }),
  sessionId: SessionIdSchema.nullable(),
  since: IsoTimeSchema,
  lastFiredAt: IsoTimeSchema,
  fireCount: CountSchema,
  resolvedAt: NullableIsoTimeSchema,
  resolvedReason: z.enum(['condition_cleared', 'expired', 'rule_disabled', 'scope_deleted']).nullable(),
  detail: DetailRecordSchema,
});
export type AlertItem = z.infer<typeof AlertItemSchema>;

/**
 * One row of `GET /alerts/rules` (registry note N4: the shape was not written out in 03; this one is the minimum a
 * reader needs: the rule, whether it is on, its scope, its configured thresholds and how many alerts it has open).
 */
export const AlertRuleViewSchema = z.strictObject({
  ruleId: z.string(),
  rule: AlertRuleKindSchema,
  enabled: z.boolean(),
  scopeKind: z.enum(ALERT_SCOPE_KINDS),
  settings: DetailRecordSchema,
  openCount: CountSchema,
});
export type AlertRuleView = z.infer<typeof AlertRuleViewSchema>;

export const AlertRulesViewSchema = z.strictObject({
  asOfSeq: SeqSchema,
  enabled: z.boolean(),
  sweepSeconds: z.number().int().min(15).max(600),
  rules: z.array(AlertRuleViewSchema),
});
export type AlertRulesView = z.infer<typeof AlertRulesViewSchema>;

// ---- pages -------------------------------------------------------------------------------------------------------

/** Everything of a `Page<T>` except its items (03 5.3). `total` only with `includeTotal=1`, capped at 10000. */
export const PageMetaSchema = z.strictObject({
  /** `null` = no more items in this direction. */
  nextCursor: z.string().max(512).nullable(),
  asOfSeq: SeqSchema,
  total: CountSchema.nullable(),
  /** True when the count reached the cap. */
  totalIsLowerBound: z.boolean(),
  limit: z.number().int().min(1).max(500),
});

/** `Page<T>`: the items plus `PageMeta`. */
export type Page<T> = { items: T[] } & z.infer<typeof PageMetaSchema>;

/** The schema of `Page<T>` for an item schema. */
export function pageSchema<S extends z.ZodType>(item: S) {
  return z.strictObject({ items: z.array(item), ...PageMetaSchema.shape });
}

/** `EventPage = Page<ActivityEvent> & { scanCapped, newerCursor }`; `newerCursor` is set only with `around`. */
export const EventPageSchema = pageSchema(ActivityEventSchema).extend({
  scanCapped: z.boolean(),
  newerCursor: z.string().max(512).nullable(),
});
export type EventPage = z.infer<typeof EventPageSchema>;

// ---- transcript access (03 7.1, 7.3, 7.4) -------------------------------------------------------------------------

export const ENTRY_KINDS = ['prompt', 'say', 'think', 'tool', 'result'] as const;
export const EntryKindSchema = z.enum(ENTRY_KINDS);
export type EntryKind = z.infer<typeof EntryKindSchema>;

/** One legacy display entry; `i` is its absolute, stable index in the file. */
export const TranscriptEntrySchema = z.strictObject({
  i: CountSchema,
  /** Record timestamp or `''`. */
  t: z.string(),
  k: EntryKindSchema,
  id: z.string().optional(),
  text: z.string().optional(),
  name: z.string().optional(),
  summary: z.string().optional(),
  input: z.string().optional(),
  err: z.boolean().optional(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const TranscriptWindowResponseSchema = z.strictObject({
  sessionId: SessionIdSchema,
  agentId: AgentIdSchema,
  total: CountSchema,
  /** Always 0: the whole indexed file is addressable. */
  base: z.literal(0),
  from: CountSchema,
  next: CountSchema,
  partial: z.boolean(),
  skippedBytes: CountSchema,
  pendingBytes: CountSchema,
  fileState: TranscriptFileStateSchema,
  asOfSeq: SeqSchema,
  events: z.array(TranscriptEntrySchema),
});
export type TranscriptWindowResponse = z.infer<typeof TranscriptWindowResponseSchema>;

export const TranscriptLocateResponseSchema = z.strictObject({
  i: CountSchema,
  t: z.string(),
  base: z.literal(0),
  total: CountSchema,
});
export type TranscriptLocateResponse = z.infer<typeof TranscriptLocateResponseSchema>;

export const SearchCoverageSchema = z.strictObject({
  scope: z.enum(['session', 'agent', 'instance']),
  filesInScope: CountSchema,
  filesScanned: CountSchema,
  filesMissing: CountSchema,
  filesUnreadable: CountSchema,
  bytesInScope: CountSchema,
  bytesScanned: CountSchema,
  bytesNotIndexed: CountSchema,
  entriesScanned: CountSchema,
  /** Every in-scope file scanned to its end, nothing not indexed, no missing or unreadable file. */
  complete: z.boolean(),
  stoppedBy: z.enum(['complete', 'match_limit', 'time_budget', 'cancelled']),
  elapsedMs: CountSchema,
  note: z.string(),
});
export type SearchCoverage = z.infer<typeof SearchCoverageSchema>;

export const TranscriptSearchResponseSchema = z.strictObject({
  matches: z.array(
    z.strictObject({
      i: CountSchema,
      k: EntryKindSchema,
      t: z.string(),
      name: z.string().nullable(),
      snippet: z.string(),
      offset: CountSchema,
    }),
  ),
  count: CountSchema,
  truncated: z.boolean(),
  /** `!complete`. */
  partial: z.boolean(),
  complete: z.boolean(),
  searchedEntries: CountSchema,
  query: z.strictObject({
    q: z.string(),
    kinds: z.array(EntryKindSchema),
    tool: z.string().nullable(),
    errors: z.boolean(),
  }),
  coverage: SearchCoverageSchema,
});
export type TranscriptSearchResponse = z.infer<typeof TranscriptSearchResponseSchema>;

export const InstanceSearchResponseSchema = z.strictObject({
  query: z.strictObject({ q: z.string(), kinds: z.array(EntryKindSchema) }),
  matches: z.array(
    z.strictObject({
      sessionId: SessionIdSchema,
      sessionLabel: z.string(),
      agentId: AgentIdSchema,
      i: CountSchema,
      k: EntryKindSchema,
      t: z.string(),
      name: z.string().nullable(),
      snippet: z.string(),
    }),
  ),
  truncated: z.boolean(),
  coverage: SearchCoverageSchema,
  /** Server-side handle `c-<random>`; an unknown or expired one is `400 cursor_invalid`. */
  continuation: z.string().nullable(),
});
export type InstanceSearchResponse = z.infer<typeof InstanceSearchResponseSchema>;

// ---- overview and analytics (03 8) --------------------------------------------------------------------------------

/** The metric keys of 03 8.1 (and 04 S-7), in table order. */
export const OVERVIEW_METRIC_KEYS = [
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
] as const;

export const MetricSchema = z.strictObject({
  key: z.string(),
  label: z.string(),
  value: z.number().nullable(),
  unit: z.enum(['count', 'tokens', 'ms', 'bytes', 'currency']),
  currency: z.string().optional(),
  /** Fixed English text of the table of 03 8.1; shown in an info tip. */
  source: z.string(),
  rule: z.string(),
  completeness: CompletenessSchema,
  asOf: IsoTimeSchema,
  link: z.string().nullable(),
});
export type Metric = z.infer<typeof MetricSchema>;

export const OverviewSchema = z.strictObject({
  asOfSeq: SeqSchema,
  generatedAt: IsoTimeSchema,
  window: z.strictObject({
    from: NullableIsoTimeSchema,
    to: IsoTimeSchema,
    source: z.enum(['window_hours', 'range', 'custom']),
  }),
  metrics: z.array(MetricSchema),
  recentActivity: z.array(ActivityEventSchema).max(15),
  recentErrors: z.array(ActivityEventSchema).max(10),
  alerts: z.strictObject({ open: CountSchema, critical: CountSchema, items: z.array(AlertItemSchema).max(5) }),
});
export type Overview = z.infer<typeof OverviewSchema>;

export const CostSummarySchema = z.strictObject({
  currency: z.string(),
  basis: z.literal('estimate'),
  source: z.literal('configured_prices'),
  amount: z.number().min(0),
  pricedTokensPct: z.number().min(0).max(100),
  pricedModels: z.array(z.string()),
  unpricedModels: z.array(z.string()),
  assumedCacheWriteTier: z.boolean(),
  note: z.string(),
});
export type CostSummary = z.infer<typeof CostSummarySchema>;

const WindowSchema = z.strictObject({ from: NullableIsoTimeSchema, to: IsoTimeSchema });

export const UsageRowSchema = z.strictObject({
  key: z.string(),
  label: z.string(),
  usage: TokenUsageSchema,
  cost: CostEstimateSchema.nullable(),
  sessions: CountSchema,
});
export type UsageRow = z.infer<typeof UsageRowSchema>;

export const UsageReportSchema = z.strictObject({
  asOfSeq: SeqSchema,
  window: WindowSchema,
  groupBy: z.string(),
  totals: UsageRowSchema,
  rows: z.array(UsageRowSchema),
  rowsTruncated: z.boolean(),
  source: z.string(),
  cost: CostSummarySchema.nullable(),
  reportedCost: z
    .strictObject({
      amountUsd: z.number().min(0),
      sessionsWithReport: CountSchema,
      sessionsInScope: CountSchema,
      label: z.string(),
    })
    .nullable(),
});
export type UsageReport = z.infer<typeof UsageReportSchema>;

export const SeriesPointSchema = z.strictObject({
  start: IsoTimeSchema,
  input: CountSchema,
  output: CountSchema,
  cacheCreation: CountSchema,
  cacheRead: CountSchema,
  messages: CountSchema,
  completeness: z.enum(['complete', 'partial']),
});
export type SeriesPoint = z.infer<typeof SeriesPointSchema>;

export const UsageSeriesSchema = z.strictObject({
  asOfSeq: SeqSchema,
  bucket: z.enum(['hour', 'day']),
  tzOffsetMinutes: z.number().int().min(-840).max(840),
  window: WindowSchema,
  points: z.array(SeriesPointSchema),
  series: z
    .array(z.strictObject({ key: z.string(), label: z.string(), points: z.array(SeriesPointSchema) }))
    .nullable(),
});
export type UsageSeries = z.infer<typeof UsageSeriesSchema>;

export const ToolFrequencyRowSchema = z.strictObject({
  toolName: z.string(),
  mcpServer: z.string().nullable(),
  calls: CountSchema,
  succeeded: CountSchema,
  failed: CountSchema,
  denied: CountSchema,
  interrupted: CountSchema,
  pending: CountSchema,
  unknown: CountSchema,
  failurePct: z.number().min(0).max(100).nullable(),
  medianDurationMs: z.number().min(0).nullable(),
  maxDurationMs: z.number().min(0).nullable(),
});
export type ToolFrequencyRow = z.infer<typeof ToolFrequencyRowSchema>;

export const ToolFrequencyReportSchema = z.strictObject({
  asOfSeq: SeqSchema,
  window: WindowSchema,
  items: z.array(ToolFrequencyRowSchema),
  sampled: z.boolean(),
});
export type ToolFrequencyReport = z.infer<typeof ToolFrequencyReportSchema>;
