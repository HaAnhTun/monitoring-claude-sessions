// Frame hydration (03 9.3): a `changes` row is a small reference; the frame carries the current state of the entity it names,
// read with the same query functions as the REST routes (ADR 0029: one source for shapes). Because hydration reads the
// current state, `data.seq` can be newer than the frame `seq`; clients apply an entity only when its seq is newer than theirs.
//
// A frame never fails: an entity that is gone, a query that throws or a payload that cannot be read gives `data: null` (the
// client invalidates that entity) or, for the kinds that carry lists, an empty list with `truncated: true` (the client refetches).
// The seq sequence therefore stays gap free (03 9.2). Only the `health/upsert` frame has no such answer; its failure reaches the hub.
import type { ChangeRow, Logger } from '@mcs/engine';
import { AlertListQuerySchema, WorkItemSchema, isoMsZ } from '@mcs/shared';
import type {
  ActivityEvent,
  AgentNode,
  AlertItem,
  HealthReport,
  SessionSummary,
  StreamChange,
  ToolCallItem,
  WorkflowRunItem,
  WorkItem,
} from '@mcs/shared';
import { z } from 'zod';

import type { AppContext } from '../route-adapter.ts';

export type { ChangeRow };

/** The query functions a frame needs, with the scope already bound. */
export interface HydrationQueries {
  sessionSummaries(sessionRowIds: readonly number[]): SessionSummary[];
  agentNode(agentRowId: number): AgentNode | null;
  workflowRun(runRowId: number): WorkflowRunItem | null;
  eventsByIdRange(sessionRowId: number, from: number, to: number, limit: number): ActivityEvent[];
  toolCallsByIds(ids: readonly number[]): ToolCallItem[];
  workItem(id: number): WorkItem | null;
  alert(id: number): AlertItem | null;
  health(): HealthReport;
}

export interface HydrationDeps {
  readonly instanceId: string;
  readonly queries: HydrationQueries;
  /** Epoch ms; the health report is cached for one second (03 9.3). */
  readonly now: () => number;
  readonly logger: Pick<Logger, 'warn'>;
}

/** A frame is at most 64 KB (03 9.2); `event/append` carries at most 50 events and `tool_call/upsert` 50 calls. */
export const MAX_FRAME_BYTES = 64 * 1024;
const MAX_ITEMS = 50;
const HEALTH_CACHE_MS = 1000;
/** `HealthReport.errors` of the route has at most 20 entries (03 6.2). */
const HEALTH_ERRORS = 20;
/** The alerts query has no get-by-id; the newest alerts of both statuses are looked through (CR-WP-36-2). */
const ALERT_LOOKUP_LIMIT = 200;

const EventPayloadSchema = z.object({ from: z.number().int(), to: z.number().int(), count: z.number().int().min(0) });
const IdsPayloadSchema = z.object({ ids: z.array(z.number().int().positive()).max(MAX_ITEMS), truncated: z.boolean() });
const TranscriptPayloadSchema = z.object({
  size: z.number().int().min(0),
  tail: z.number().int().min(0),
  agent: z.string().nullable(),
});

function payloadOf<S extends z.ZodType>(schema: S, text: string): z.output<S> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Binds the engine query layer of an instance to the shape the hydrator needs. */
export function hydrationQueriesOf(ctx: AppContext): HydrationQueries {
  const { queries, scope } = ctx;
  const alertQuery = AlertListQuerySchema.parse({ status: 'open,resolved', limit: String(ALERT_LOOKUP_LIMIT) });
  return {
    sessionSummaries: (ids) => queries.sessionSummaries(scope, ids),
    agentNode: (id) => queries.agentNode(scope, id),
    workflowRun: (id) => queries.workflowRun(scope, id),
    eventsByIdRange: (session, from, to, limit) => queries.eventsByIdRange(scope, session, from, to, limit),
    toolCallsByIds: (ids) => queries.toolCallsByIds(scope, ids),
    workItem: (id) => {
      const full = queries.getWorkItem(scope, id);
      // the route answer adds the member sessions and asOfSeq to the work item; the frame carries the item alone
      return WorkItemSchema.parse(
        Object.fromEntries(Object.entries(full).filter(([key]) => key in WorkItemSchema.shape)),
      );
    },
    alert: (id) => queries.listAlerts(scope, alertQuery).items.find((item) => item.id === id) ?? null,
    health: () => ({ ...queries.health(scope), errors: ctx.errors.list(HEALTH_ERRORS) }),
  };
}

/** The frame of one change row. Throws only when the health report cannot be computed. */
export function createHydrator(deps: HydrationDeps): (row: ChangeRow) => StreamChange {
  const { queries, logger } = deps;
  let healthCache: { readonly at: number; readonly report: HealthReport } | null = null;

  /** Runs a query; any failure is logged by name only (never a message: it could carry request data) and gives the fallback. */
  function attempt<T>(kind: string, run: () => T, fallback: T): T {
    try {
      return run();
    } catch (error) {
      logger.warn('stream_hydration_failed', {
        kind,
        error: error instanceof Error ? error.name : 'non-error',
      });
      return fallback;
    }
  }

  function health(): HealthReport {
    const nowMs = deps.now();
    if (healthCache !== null && nowMs - healthCache.at >= 0 && nowMs - healthCache.at < HEALTH_CACHE_MS) {
      return healthCache.report;
    }
    const report = queries.health();
    healthCache = { at: nowMs, report };
    return report;
  }

  function build(row: ChangeRow): StreamChange {
    const base = {
      seq: row.seq,
      at: isoMsZ(row.at),
      instanceId: deps.instanceId,
      sessionId: row.sessionUid,
    };
    const id = row.entityId;
    switch (`${row.kind}/${row.op}`) {
      case 'session/upsert':
        return {
          ...base,
          kind: 'session',
          op: 'upsert',
          data: id === null ? null : attempt('session', () => queries.sessionSummaries([id])[0] ?? null, null),
        };
      case 'session/delete':
        return { ...base, kind: 'session', op: 'delete', data: null };
      case 'agent/upsert':
        return {
          ...base,
          kind: 'agent',
          op: 'upsert',
          data: id === null ? null : attempt('agent', () => queries.agentNode(id), null),
        };
      case 'workflow/upsert':
        return {
          ...base,
          kind: 'workflow',
          op: 'upsert',
          data: id === null ? null : attempt('workflow', () => queries.workflowRun(id), null),
        };
      case 'tool_call/upsert': {
        const payload = payloadOf(IdsPayloadSchema, row.payload);
        if (payload === null) return { ...base, kind: 'tool_call', op: 'upsert', data: { items: [], truncated: true } };
        const items = attempt('tool_call', () => queries.toolCallsByIds(payload.ids).slice(0, MAX_ITEMS), []);
        return { ...base, kind: 'tool_call', op: 'upsert', data: { items, truncated: payload.truncated } };
      }
      case 'event/append': {
        const payload = payloadOf(EventPayloadSchema, row.payload);
        if (payload === null || id === null) {
          return {
            ...base,
            kind: 'event',
            op: 'append',
            data: { items: [], count: payload?.count ?? 0, truncated: true },
          };
        }
        const items = attempt('event', () => queries.eventsByIdRange(id, payload.from, payload.to, MAX_ITEMS), []);
        return {
          ...base,
          kind: 'event',
          op: 'append',
          data: { items, count: payload.count, truncated: payload.count > MAX_ITEMS },
        };
      }
      case 'transcript/append': {
        const payload = payloadOf(TranscriptPayloadSchema, row.payload);
        return {
          ...base,
          kind: 'transcript',
          op: 'append',
          data: payload === null ? null : { agentId: payload.agent ?? 'main', sizeBytes: payload.size },
        };
      }
      case 'work_item/upsert':
        return {
          ...base,
          kind: 'work_item',
          op: 'upsert',
          data: id === null ? null : attempt('work_item', () => queries.workItem(id), null),
        };
      case 'usage/invalidate':
        // a usage change always names its session (03 9.1); a row without one is read as an empty invalidation for no session
        return { ...base, kind: 'usage', op: 'invalidate', data: { sessionId: row.sessionUid ?? '' } };
      case 'alert/upsert':
        return {
          ...base,
          kind: 'alert',
          op: 'upsert',
          data: id === null ? null : attempt('alert', () => queries.alert(id), null),
        };
      case 'health/upsert':
        return { ...base, kind: 'health', op: 'upsert', data: health() };
      case 'attempt/upsert': {
        const payload = payloadOf(IdsPayloadSchema, row.payload);
        return {
          ...base,
          kind: 'attempt',
          op: 'upsert',
          data: payload === null ? { ids: [], truncated: true } : { ids: payload.ids, truncated: payload.truncated },
        };
      }
      default:
        throw new RangeError(`unknown change ${row.kind}/${row.op}`);
    }
  }

  /** Keeps a frame within `MAX_FRAME_BYTES`: lists lose items (and say `truncated`), single entities become `null`. */
  function fit(frame: StreamChange): StreamChange {
    const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
    if (size(frame) <= MAX_FRAME_BYTES) return frame;
    if (frame.kind === 'event') {
      let items = frame.data.items;
      while (items.length > 0 && size({ ...frame, data: { ...frame.data, items } }) > MAX_FRAME_BYTES) {
        items = items.slice(0, Math.floor(items.length / 2));
      }
      return { ...frame, data: { ...frame.data, items, truncated: true } };
    }
    if (frame.kind === 'tool_call') {
      let items = frame.data.items;
      while (items.length > 0 && size({ ...frame, data: { items, truncated: true } }) > MAX_FRAME_BYTES) {
        items = items.slice(0, Math.floor(items.length / 2));
      }
      return { ...frame, data: { items, truncated: true } };
    }
    switch (frame.kind) {
      case 'session':
        return frame.op === 'upsert' ? { ...frame, data: null } : frame;
      case 'agent':
        return { ...frame, data: null };
      case 'workflow':
        return { ...frame, data: null };
      case 'work_item':
        return { ...frame, data: null };
      case 'alert':
        return { ...frame, data: null };
      case 'transcript':
      case 'usage':
      case 'health':
      case 'attempt':
        return frame;
    }
  }

  return (row) => fit(build(row));
}
