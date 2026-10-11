// Export format `mcs.export/1` (03 11.1): JSONL, metadata by default. The data objects of the record lines are the API's own
// schemas; this file only adds the `type` discriminator and the header, transcript and trailer lines, so there is no second
// definition of a session, event or tool call.
import { z } from 'zod';

import {
  ActivityEventSchema,
  AgentNodeSchema,
  AlertItemSchema,
  SessionSummarySchema,
  ToolCallItemSchema,
  TranscriptEntrySchema,
  TransitionItemSchema,
  WorkItemSchema,
} from './entities.ts';
import { csvOf, flagParam, PresetSchema } from './filters.ts';
import { AgentIdSchema, CountSchema, InstanceIdSchema, SessionIdSchema, intString } from './ids.ts';
import { WorkflowRunItemSchema } from './stream.ts';
import { IsoTimeInputSchema, IsoTimeSchema, NullableIsoTimeSchema } from './time.ts';

export const EXPORT_FORMAT = 'mcs.export/1';

/** The `include` values of the query, in the order of the format. */
export const EXPORT_INCLUDES = [
  'sessions',
  'agents',
  'workflows',
  'work_items',
  'events',
  'tool_calls',
  'turns',
  'usage',
  'transitions',
  'alerts',
] as const;
export const ExportIncludeSchema = z.enum(EXPORT_INCLUDES);
export type ExportInclude = z.infer<typeof ExportIncludeSchema>;

export const EXPORT_REDACTIONS = ['standard', 'strict'] as const;

/** `GET /api/v3/export` query, and the flags of `mcs export` (01 6.4). `strict` refuses `includeContent`. */
export const ExportQuerySchema = z
  .strictObject({
    /** At most 500 ids; absent means the whole instance. */
    session: csvOf(SessionIdSchema, 500).optional(),
    workItem: intString(1, Number.MAX_SAFE_INTEGER).optional(),
    range: PresetSchema.optional(),
    from: IsoTimeInputSchema.optional(),
    to: IsoTimeInputSchema.optional(),
    /** Default: all. */
    include: csvOf(ExportIncludeSchema, 10).optional(),
    /** Default `standard`. */
    redaction: z.enum(EXPORT_REDACTIONS).optional(),
    /** Default false. */
    includeContent: flagParam.optional(),
  })
  .refine((q) => !(q.redaction === 'strict' && q.includeContent === true), {
    message: 'includeContent is not allowed with strict redaction',
    path: ['includeContent'],
  });
export type ExportQuery = z.output<typeof ExportQuerySchema>;

export const ExportSummarySchema = z.strictObject({
  lines: CountSchema,
  bytes: CountSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  counts: z.record(z.string(), CountSchema),
  includeContent: z.boolean(),
});
export type ExportSummary = z.infer<typeof ExportSummarySchema>;

// ---- lines ---------------------------------------------------------------------------------------------------------

const HeaderLineSchema = z.strictObject({
  type: z.literal('header'),
  format: z.literal(EXPORT_FORMAT),
  instanceId: InstanceIdSchema,
  slug: z.string(),
  exportedAt: IsoTimeSchema,
  runtimeVersion: z.string(),
  dbSchemaVersion: CountSchema,
  /** The resolved scope: the time bounds and the session ids. */
  scope: z.strictObject({ from: NullableIsoTimeSchema, to: IsoTimeSchema, sessions: z.array(SessionIdSchema) }),
  include: z.array(ExportIncludeSchema),
  redaction: z.enum(EXPORT_REDACTIONS),
  includeContent: z.boolean(),
  /** "Metadata only: no prompt, reply, thinking or tool result text." or the confidentiality note for content exports. */
  privacyNote: z.string(),
});

const record = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.strictObject({ type: z.literal(type), data });

const SessionRecord = SessionSummarySchema.extend({
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  permissionMode: z.string().nullable(),
});

const TurnRecord = z.strictObject({
  sessionId: SessionIdSchema,
  agentId: AgentIdSchema,
  promptId: z.string().nullable(),
  startedAt: IsoTimeSchema,
  endedAt: NullableIsoTimeSchema,
  endKind: z.string().nullable(),
  origin: z.string().nullable(),
  toolCount: CountSchema,
});

const nullableCount = CountSchema.nullable();

const UsageRecord = z.strictObject({
  messageKey: z.string(),
  sessionId: SessionIdSchema,
  agentId: AgentIdSchema,
  model: z.string().nullable(),
  ts: IsoTimeSchema,
  input: nullableCount,
  output: nullableCount,
  cacheRead: nullableCount,
  cacheCreation: nullableCount,
  cacheCreation5m: nullableCount,
  cacheCreation1h: nullableCount,
  thinking: nullableCount,
  finalized: z.boolean(),
  synthetic: z.boolean(),
  usageSource: z.string(),
  files: CountSchema,
});

const TranscriptLineSchema = z.strictObject({
  type: z.literal('transcript'),
  sessionId: SessionIdSchema,
  agentId: AgentIdSchema,
  /** At most 500 entries per line. */
  entries: z.array(TranscriptEntrySchema).max(500),
});

const TrailerLineSchema = z.strictObject({
  type: z.literal('trailer'),
  counts: z.record(z.string(), CountSchema),
  /** Transcript files that were listed but are gone from disk (only with `includeContent`). */
  missingTranscripts: z.array(z.strictObject({ sessionId: SessionIdSchema, agentId: AgentIdSchema })),
  /** Hex SHA-256 of all bytes before the trailer line. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Record line types in the order of the format. */
export const EXPORT_RECORD_TYPES = [
  'session',
  'agent',
  'workflow',
  'work_item',
  'turn',
  'event',
  'tool_call',
  'usage',
  'transition',
  'alert',
] as const;

/** One schema per line type; the generator of the JSON Schemas writes one file per key (`schemas/export/<type>`). */
export const ExportLineSchemas = {
  header: HeaderLineSchema,
  session: record('session', SessionRecord),
  agent: record('agent', AgentNodeSchema),
  workflow: record('workflow', WorkflowRunItemSchema),
  work_item: record('work_item', WorkItemSchema),
  turn: record('turn', TurnRecord),
  event: record('event', ActivityEventSchema.omit({ sessionLabel: true, agentLabel: true })),
  tool_call: record('tool_call', ToolCallItemSchema),
  usage: record('usage', UsageRecord),
  transition: record('transition', TransitionItemSchema.extend({ sessionId: SessionIdSchema })),
  alert: record('alert', AlertItemSchema),
  transcript: TranscriptLineSchema,
  trailer: TrailerLineSchema,
} as const;

export const ExportLineSchema = z.discriminatedUnion('type', [
  ExportLineSchemas.header,
  ExportLineSchemas.session,
  ExportLineSchemas.agent,
  ExportLineSchemas.workflow,
  ExportLineSchemas.work_item,
  ExportLineSchemas.turn,
  ExportLineSchemas.event,
  ExportLineSchemas.tool_call,
  ExportLineSchemas.usage,
  ExportLineSchemas.transition,
  ExportLineSchemas.alert,
  ExportLineSchemas.transcript,
  ExportLineSchemas.trailer,
]);
export type ExportLine = z.infer<typeof ExportLineSchema>;
