// SSE frames of `GET /api/v3/stream` (03 9.1-9.3, registry 1.5 and 4). The web client validates every message with these
// schemas; the server builds the frames from the change log and hydrates `data` with the same query functions as the routes.
import { z } from 'zod';

import {
  ActivityEventSchema,
  AgentNodeSchema,
  AlertItemSchema,
  SessionSummarySchema,
  StateAssessmentSchema,
  ToolCallItemSchema,
  WorkItemSchema,
} from './entities.ts';
import { HealthReportSchema } from './health.ts';
import {
  AgentIdSchema,
  CountSchema,
  EpochSchema,
  InstanceIdSchema,
  PositiveIdSchema,
  RunIdSchema,
  SessionIdSchema,
} from './ids.ts';
import { IsoTimeSchema, NullableIsoTimeSchema } from './time.ts';

/** `retry:` of the first frame, in milliseconds. */
export const STREAM_RETRY_MS = 3000;
/** Heartbeat interval; the client reconnects after 2.5 times this without any message. */
export const STREAM_HEARTBEAT_MS = 15000;
/** The named SSE events, in the order a client sees them first. */
export const STREAM_EVENT_NAMES = ['hello', 'change', 'heartbeat', 'reset'] as const;

export const CHANGE_KINDS = [
  'session',
  'agent',
  'workflow',
  'tool_call',
  'event',
  'transcript',
  'work_item',
  'usage',
  'alert',
  'health',
  'attempt',
] as const;
export const ChangeKindSchema = z.enum(CHANGE_KINDS);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

export const CHANGE_OPS = ['upsert', 'delete', 'append', 'invalidate'] as const;
export const ChangeOpSchema = z.enum(CHANGE_OPS);
export type ChangeOp = z.infer<typeof ChangeOpSchema>;

export const StreamHelloSchema = z.strictObject({
  instanceId: InstanceIdSchema,
  epoch: EpochSchema,
  headSeq: CountSchema,
  heartbeatMs: CountSchema,
  serverTime: IsoTimeSchema,
  runtimeVersion: z.string(),
  codeStamp: z.string(),
});
export type StreamHello = z.infer<typeof StreamHelloSchema>;

export const StreamHeartbeatSchema = z.strictObject({
  headSeq: CountSchema,
  epoch: EpochSchema,
  serverTime: IsoTimeSchema,
});
export type StreamHeartbeat = z.infer<typeof StreamHeartbeatSchema>;

export const STREAM_RESET_REASONS = ['cursor_too_old', 'cursor_ahead', 'epoch_changed', 'cursor_invalid'] as const;
export const StreamResetSchema = z.strictObject({ headSeq: CountSchema, reason: z.enum(STREAM_RESET_REASONS) });
export type StreamReset = z.infer<typeof StreamResetSchema>;

/** Data of `workflow/upsert`. */
export const WorkflowRunItemSchema = z.strictObject({
  runId: RunIdSchema,
  seq: CountSchema,
  sessionId: SessionIdSchema,
  name: z.string().nullable(),
  state: StateAssessmentSchema,
  agentCount: CountSchema.nullable(),
  started: CountSchema,
  results: CountSchema,
  failed: CountSchema,
  startedAt: NullableIsoTimeSchema,
  endedAt: NullableIsoTimeSchema,
});
export type WorkflowRunItem = z.infer<typeof WorkflowRunItemSchema>;

function change<K extends ChangeKind, O extends ChangeOp, D extends z.ZodType>(kind: K, op: O, data: D) {
  return z.strictObject({
    seq: PositiveIdSchema,
    at: IsoTimeSchema,
    instanceId: InstanceIdSchema,
    kind: z.literal(kind),
    op: z.literal(op),
    sessionId: SessionIdSchema.nullable(),
    data,
  });
}

/**
 * One schema per kind/op pair, keyed `<kind>/<op>` as in the registry. A frame is at most 64 KB, so `event/append`
 * carries at most 50 events and `tool_call/upsert` 50 calls. `data: null` means the entity no longer exists or is not
 * readable now: clients invalidate it.
 */
export const STREAM_CHANGE_SCHEMAS = {
  'session/upsert': change('session', 'upsert', SessionSummarySchema.nullable()),
  'session/delete': change('session', 'delete', z.null()),
  'agent/upsert': change('agent', 'upsert', AgentNodeSchema.nullable()),
  'workflow/upsert': change('workflow', 'upsert', WorkflowRunItemSchema.nullable()),
  'tool_call/upsert': change(
    'tool_call',
    'upsert',
    z.strictObject({ items: z.array(ToolCallItemSchema).max(50), truncated: z.boolean() }),
  ),
  'event/append': change(
    'event',
    'append',
    z.strictObject({ items: z.array(ActivityEventSchema).max(50), count: CountSchema, truncated: z.boolean() }),
  ),
  'transcript/append': change(
    'transcript',
    'append',
    z.strictObject({ agentId: AgentIdSchema, sizeBytes: CountSchema }).nullable(),
  ),
  'work_item/upsert': change('work_item', 'upsert', WorkItemSchema.nullable()),
  'usage/invalidate': change('usage', 'invalidate', z.strictObject({ sessionId: SessionIdSchema })),
  'alert/upsert': change('alert', 'upsert', AlertItemSchema.nullable()),
  'health/upsert': change('health', 'upsert', HealthReportSchema),
  'attempt/upsert': change(
    'attempt',
    'upsert',
    z.strictObject({ ids: z.array(PositiveIdSchema).max(50), truncated: z.boolean() }),
  ),
} as const;

/** One change frame: exactly one of the twelve kind/op pairs. */
export const StreamChangeSchema = z.union([
  STREAM_CHANGE_SCHEMAS['session/upsert'],
  STREAM_CHANGE_SCHEMAS['session/delete'],
  STREAM_CHANGE_SCHEMAS['agent/upsert'],
  STREAM_CHANGE_SCHEMAS['workflow/upsert'],
  STREAM_CHANGE_SCHEMAS['tool_call/upsert'],
  STREAM_CHANGE_SCHEMAS['event/append'],
  STREAM_CHANGE_SCHEMAS['transcript/append'],
  STREAM_CHANGE_SCHEMAS['work_item/upsert'],
  STREAM_CHANGE_SCHEMAS['usage/invalidate'],
  STREAM_CHANGE_SCHEMAS['alert/upsert'],
  STREAM_CHANGE_SCHEMAS['health/upsert'],
  STREAM_CHANGE_SCHEMAS['attempt/upsert'],
]);
export type StreamChange = z.infer<typeof StreamChangeSchema>;

function pairSchema(value: unknown) {
  if (typeof value !== 'object' || value === null) return undefined;
  const kind: unknown = Reflect.get(value, 'kind');
  const op: unknown = Reflect.get(value, 'op');
  if (typeof kind !== 'string' || typeof op !== 'string') return undefined;
  return Object.entries(STREAM_CHANGE_SCHEMAS).find(([key]) => key === kind + '/' + op)?.[1];
}

/**
 * Validates a change frame by looking at its `kind` and `op` first, so that a bad frame reports the issues of its own pair
 * (and not twelve union branches) and a valid one is parsed once.
 */
export function safeParseStreamChange(
  value: unknown,
): { success: true; data: StreamChange } | { success: false; error: z.ZodError } {
  const schema = pairSchema(value);
  if (schema === undefined) return StreamChangeSchema.safeParse(value);
  const parsed = schema.safeParse(value);
  return parsed.success ? { success: true, data: parsed.data } : { success: false, error: parsed.error };
}

/** The data schema of every SSE event name. */
export const StreamEventSchemas = {
  hello: StreamHelloSchema,
  change: StreamChangeSchema,
  heartbeat: StreamHeartbeatSchema,
  reset: StreamResetSchema,
} as const;
