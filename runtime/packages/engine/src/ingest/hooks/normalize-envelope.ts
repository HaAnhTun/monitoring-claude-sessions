// Hook envelope -> logical events and one `events` row (02 4.3 "Hook envelope mapping", 4.1.1, 4.1.2).
//
// Pure: no clock, no file, no database. The envelope was cut down to its kept fields by the handler (02 2.4), so what is
// read here is already free of bodies; the row copies only scalars of `data` and the previews it was given.
import type { EventKind } from '@mcs/shared';
import {
  AGENT_RE,
  RUN_ID_RE,
  SUMMARY_MAX_CP,
  canonicalJsonHash,
  clip,
  hookEventRank,
  isInstalledHookEvent,
  redact,
  type EnvelopeDataValue,
  type HookEnvelopeV1,
  type InstalledHookEvent,
  type Stamp,
} from '@mcs/shared/protocol';

import { clipCodePoints } from '../../platform/fsx.ts';
import {
  ROW_LIMITS,
  eventRow,
  permissionDeniedKey,
  promptKey,
  taskKey,
  toolBatchKey,
  toolCallKey,
  toolEndKey,
  type EventRowWrite,
  type InfoKind,
  type LogicalEvent,
} from '../event-row.ts';

/** Where the spool line was read (the row keeps it for replay and diagnostics); both null when it is unknown. */
export interface EnvelopeLocation {
  segment: string | null;
  offset: number | null;
}

export interface NormalizedEnvelope {
  /** Logical events in the order of the table of 02 4.3, `session.seen` first. Empty for a probe. */
  events: LogicalEvent[];
  /** The `events` row; null for a probe and for an envelope without a session id. */
  row: EventRowWrite | null;
}

const DETAIL_MAX_BYTES = 16 * 1024;

/** Stored kind of each installed event (02 4.3, last column). */
const KIND_OF_EVENT: Readonly<Record<InstalledHookEvent, EventKind>> = {
  SessionStart: 'session.start',
  UserPromptSubmit: 'prompt.submit',
  PreToolUse: 'tool.call',
  PermissionRequest: 'permission.request',
  PermissionDenied: 'permission.denied',
  PostToolUse: 'tool.result',
  PostToolUseFailure: 'tool.failure',
  PostToolBatch: 'tool.batch',
  Notification: 'notification.sent',
  SubagentStart: 'agent.start',
  SubagentStop: 'agent.stop',
  TaskCreated: 'task.created',
  TaskCompleted: 'task.completed',
  Stop: 'turn.stop',
  StopFailure: 'turn.failure',
  TeammateIdle: 'teammate.idle',
  PreCompact: 'context.compact',
  PostCompact: 'context.compact',
  PostModelSwitch: 'model.switch',
  CwdChanged: 'cwd.change',
  SessionEnd: 'session.end',
};

/** Stored kind of an envelope (02 4.1.2); null for a probe, which is written to `hook_probes` and not to `events`. */
export function eventKindOfEnvelope(env: HookEnvelopeV1): EventKind | null {
  if (env.kind === 'probe') return null;
  return isInstalledHookEvent(env.event) ? KIND_OF_EVENT[env.event] : 'hook.unknown';
}

/** Kinds that belong to the main agent when the envelope names no agent (the others belong to the session itself). */
const AGENT_LEVEL_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'prompt.submit',
  'tool.call',
  'tool.result',
  'tool.failure',
  'tool.batch',
  'permission.request',
  'permission.denied',
  'turn.stop',
  'turn.failure',
]);

// ---- reading `data` ------------------------------------------------------------------------------------------------

type Data = Readonly<Record<string, EnvelopeDataValue>>;

function str(data: Data, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A string of `data` cut to `max` code points: a schema-valid envelope may carry far longer values than a column holds. */
function strMax(data: Data, key: string, max: number): string | undefined {
  const value = str(data, key);
  return value === undefined ? undefined : clipCodePoints(value, max);
}

/** Limits of the strings copied into logical events (they end up in short columns of entity tables, 03 3.2-3.4). */
const NAME_MAX_CP = 128;
const LABEL_MAX_CP = 64;
const TITLE_MAX_CP = 120;

function int(data: Data, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function flag(data: Data, key: string): boolean {
  return data[key] === true;
}

function calls(data: Data): string[] {
  const value = data['calls'];
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    const id = entry['tool_use_id'];
    if (typeof id === 'string' && id !== '') ids.push(id);
  }
  return ids;
}

/** Hash of the sorted tool use ids of a batch: the `ids_hash` of 02 2.5.4 (null when the batch is empty). */
function batchHash(ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  return canonicalJsonHash([...ids].sort().join(','));
}

/** Scalars of `data` only: a list becomes `<key>_count`; the whole object stays under 16 KiB (keys added in name order). */
function detailOf(data: Data): Record<string, string | number | boolean | null> | null {
  const detail: Record<string, string | number | boolean | null> = {};
  let size = 2;
  for (const key of Object.keys(data).sort()) {
    const value = data[key];
    if (value === undefined) continue;
    const name = Array.isArray(value) ? `${key}_count` : key;
    const scalar = Array.isArray(value) ? value.length : value;
    const cost = JSON.stringify(name).length + JSON.stringify(scalar).length + 2;
    if (size + cost > DETAIL_MAX_BYTES) break;
    detail[name] = scalar;
    size += cost;
  }
  return Object.keys(detail).length === 0 ? null : detail;
}

function preview(text: string | undefined): string | null {
  return text === undefined ? null : clip(redact(text), SUMMARY_MAX_CP);
}

// ---- the mapping ---------------------------------------------------------------------------------------------------

function infoOf(sid: string, stamp: Stamp, what: InfoKind, detail?: Record<string, string | number>): LogicalEvent {
  return detail === undefined
    ? { k: 'info', sessionId: sid, stamp, what }
    : { k: 'info', sessionId: sid, stamp, what, detail };
}

/** The logical events of an envelope after the `session.seen` every envelope yields (02 4.3 table, middle column). */
function eventsOf(env: HookEnvelopeV1, sid: string, stamp: Stamp): LogicalEvent[] {
  const data: Data = env.data;
  const agentId = env.agent_id;
  const promptId = env.prompt_id;
  const toolUseId = env.tool_use_id;
  const activity: LogicalEvent = { k: 'activity', sessionId: sid, agentId, stamp, via: 'hook' };
  const out: LogicalEvent[] = [];

  switch (env.event) {
    case 'SessionStart': {
      const model = strMax(data, 'model', NAME_MAX_CP);
      out.push({
        k: 'session.start',
        sessionId: sid,
        stamp,
        startSource: strMax(data, 'source', LABEL_MAX_CP) ?? 'unknown',
        ...(model === undefined ? {} : { model }),
      });
      break;
    }
    case 'UserPromptSubmit': {
      const promptLen = int(data, 'prompt_len');
      out.push(
        {
          k: 'turn.prompt',
          sessionId: sid,
          agentId,
          promptId,
          stamp,
          origin: 'hook',
          ...(promptLen === undefined ? {} : { promptLen }),
        },
        activity,
      );
      break;
    }
    case 'PreToolUse': {
      if (toolUseId !== null) {
        const summary = preview(str(data, 'tool_summary')) ?? undefined;
        const inputHash = strMax(data, 'tool_input_hash', 32);
        out.push({
          k: 'tool.start',
          sessionId: sid,
          agentId,
          promptId,
          toolUseId,
          name: strMax(data, 'tool_name', NAME_MAX_CP) ?? 'unknown',
          stamp,
          ...(summary === undefined ? {} : { summary }),
          ...(inputHash === undefined ? {} : { inputHash }),
        });
      }
      out.push(activity);
      break;
    }
    case 'PermissionRequest':
      out.push({
        k: 'permission.request',
        sessionId: sid,
        promptId,
        toolName: strMax(data, 'tool_name', NAME_MAX_CP) ?? 'unknown',
        inputHash: strMax(data, 'tool_input_hash', 32) ?? '',
        stamp,
      });
      break;
    case 'PermissionDenied':
      if (toolUseId !== null) out.push({ k: 'tool.end', sessionId: sid, agentId, toolUseId, stamp, outcome: 'denied' });
      break;
    case 'PostToolUse': {
      if (toolUseId !== null) {
        const durationMs = int(data, 'duration_ms');
        out.push({
          k: 'tool.end',
          sessionId: sid,
          agentId,
          toolUseId,
          stamp,
          outcome: 'ok',
          ...(durationMs === undefined ? {} : { durationMs }),
        });
      }
      out.push(activity);
      const linkId = str(data, 'agent_link_id');
      if (toolUseId !== null && str(data, 'tool_name') === 'Agent' && linkId !== undefined && AGENT_RE.test(linkId)) {
        out.push({
          k: 'agent.link',
          sessionId: sid,
          agentId: linkId,
          toolUseId,
          status: strMax(data, 'agent_status', LABEL_MAX_CP) ?? null,
          stamp,
        });
      }
      const runId = str(data, 'run_id');
      if (toolUseId !== null && str(data, 'tool_name') === 'Workflow' && runId !== undefined && RUN_ID_RE.test(runId)) {
        const name = strMax(data, 'workflow_name', TITLE_MAX_CP);
        out.push({
          k: 'workflow.launch',
          sessionId: sid,
          runId,
          toolUseId,
          stamp,
          ...(name === undefined ? {} : { name }),
        });
      }
      break;
    }
    case 'PostToolUseFailure': {
      if (toolUseId !== null) {
        const durationMs = int(data, 'duration_ms');
        const exitCode = int(data, 'exit_code');
        out.push({
          k: 'tool.end',
          sessionId: sid,
          agentId,
          toolUseId,
          stamp,
          outcome: flag(data, 'is_interrupt') ? 'interrupted' : 'error',
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(exitCode === undefined ? {} : { exitCode }),
        });
      }
      out.push(activity);
      break;
    }
    case 'PostToolBatch':
      out.push({ k: 'tool.batch', sessionId: sid, promptId, toolUseIds: calls(data), stamp }, activity);
      break;
    case 'Notification':
      out.push({
        k: 'notification',
        sessionId: sid,
        type: strMax(data, 'notification_type', LABEL_MAX_CP) ?? 'unknown',
        stamp,
      });
      break;
    case 'SubagentStart':
    case 'SubagentStop': {
      if (agentId !== null) {
        const agentType = env.agent_type ?? '';
        if (env.event === 'SubagentStart') {
          out.push({ k: 'agent.start', sessionId: sid, agentId, agentType, stamp });
        } else {
          const transcriptPath = str(data, 'agent_transcript_path');
          out.push({
            k: 'agent.stop',
            sessionId: sid,
            agentId,
            agentType,
            stamp,
            ...(transcriptPath === undefined ? {} : { transcriptPath }),
          });
        }
        out.push(activity);
      }
      break;
    }
    case 'Stop':
    case 'StopFailure': {
      const backgroundTasks = int(data, 'background_task_count');
      const error = env.event === 'StopFailure' ? strMax(data, 'error', LABEL_MAX_CP) : undefined;
      out.push({
        k: 'turn.end',
        sessionId: sid,
        agentId,
        promptId,
        stamp,
        kind: env.event === 'Stop' ? 'stop' : 'stop_failure',
        ...(error === undefined ? {} : { error }),
        ...(backgroundTasks === undefined ? {} : { backgroundTasks }),
      });
      break;
    }
    case 'SessionEnd':
      out.push({ k: 'session.end', sessionId: sid, stamp, reason: strMax(data, 'reason', LABEL_MAX_CP) ?? 'other' });
      break;
    case 'PreCompact':
      out.push(activity);
      break;
    case 'PostCompact': {
      out.push(
        { k: 'compaction', sessionId: sid, stamp, trigger: strMax(data, 'trigger', LABEL_MAX_CP) ?? 'unknown' },
        activity,
      );
      break;
    }
    case 'TaskCreated':
    case 'TaskCompleted': {
      const taskId = strMax(data, 'task_id', NAME_MAX_CP);
      out.push(
        infoOf(
          sid,
          stamp,
          env.event === 'TaskCreated' ? 'task_created' : 'task_completed',
          taskId === undefined ? undefined : { task_id: taskId },
        ),
      );
      break;
    }
    case 'TeammateIdle':
      out.push(infoOf(sid, stamp, 'teammate_idle'));
      break;
    case 'PostModelSwitch': {
      const to = strMax(data, 'to_model', NAME_MAX_CP);
      out.push(infoOf(sid, stamp, 'model_switch', to === undefined ? undefined : { to_model: to }));
      break;
    }
    case 'CwdChanged':
      out.push(infoOf(sid, stamp, 'cwd_changed'));
      break;
    default:
      // an event that is not installed: session.seen only
      break;
  }
  return out;
}

function naturalKeyOf(env: HookEnvelopeV1, sid: string): string | null {
  switch (env.event) {
    case 'UserPromptSubmit':
      return promptKey(sid, env.prompt_id);
    case 'PreToolUse':
      return toolCallKey(env.tool_use_id);
    case 'PermissionDenied':
      return permissionDeniedKey(env.tool_use_id);
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return toolEndKey(env.tool_use_id);
    case 'PostToolBatch':
      return toolBatchKey(sid, batchHash(calls(env.data)));
    case 'TaskCreated':
      return taskKey('created', sid, str(env.data, 'task_id'));
    case 'TaskCompleted':
      return taskKey('completed', sid, str(env.data, 'task_id'));
    default:
      return null;
  }
}

/** The preview a row carries (160 code points, redacted): the tool summary, the reason, the message or the subject. */
function summaryOf(env: HookEnvelopeV1): string | null {
  const data: Data = env.data;
  switch (env.event) {
    case 'PreToolUse':
    case 'PermissionRequest':
      return preview(str(data, 'tool_summary'));
    case 'PermissionDenied':
      return preview(str(data, 'reason_preview'));
    case 'Notification':
      return preview(str(data, 'message_preview'));
    case 'TaskCreated':
    case 'TaskCompleted':
      return preview(str(data, 'subject_preview'));
    case 'StopFailure':
      return preview(str(data, 'error_preview'));
    default:
      return null;
  }
}

/**
 * Normalizes one validated envelope (02 4.3). The stamp of every event and of the row is
 * `{at: received_at, rank: HOOK_EVENT_RANK[event], tie: event_uid}`. A probe and an envelope without a session id give
 * nothing: there is no session to attach the facts to.
 */
export function normalizeEnvelope(
  env: HookEnvelopeV1,
  where: EnvelopeLocation = { segment: null, offset: null },
): NormalizedEnvelope {
  const sid = env.session_id;
  const kind = eventKindOfEnvelope(env);
  if (sid === null || kind === null) return { events: [], row: null };
  const stamp: Stamp = { at: env.received_at, rank: hookEventRank(env.event), tie: env.event_uid };

  const seen: LogicalEvent = {
    k: 'session.seen',
    sessionId: sid,
    stamp,
    ...(env.cwd === null ? {} : { cwd: env.cwd }),
    ...(env.transcript_path === null ? {} : { transcriptPath: env.transcript_path }),
    ...(env.claude_pid === null ? {} : { claudePid: env.claude_pid }),
  };

  const agentUid = env.agent_id ?? (AGENT_LEVEL_KINDS.has(kind) ? 'main' : null);
  const promptLen = env.event === 'UserPromptSubmit' ? int(env.data, 'prompt_len') : undefined;
  const row = eventRow({
    sessionUid: sid,
    agentUid,
    kind,
    sources: 1,
    stamp,
    tsSource: 'hook_received',
    receivedAt: env.received_at,
    eventUid: env.event_uid,
    naturalKey: naturalKeyOf(env, sid),
    hookEvent: env.event,
    contentHash: env.content_hash,
    spoolSegment: where.segment,
    spoolOffset: where.offset,
    flags: env.flags,
    promptId: env.prompt_id,
    toolUseId: env.tool_use_id,
    toolName: strMax(env.data, 'tool_name', ROW_LIMITS.toolName) ?? null,
    textLen: promptLen ?? null,
    summary: summaryOf(env),
    detail: detailOf(env.data),
  });
  return { events: [seen, ...eventsOf(env, sid, stamp)], row };
}
