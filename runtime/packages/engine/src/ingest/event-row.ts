// The two shapes the normalizers produce (02 4.1.2, 4.3): `LogicalEvent`, the input of the lifecycle and entity merges,
// and `EventRowWrite`, the input of `EventsRepo.insert` (03 3.6). Plus the natural keys of 02 4.1.1 and the severity of
// each stored kind, so the two normalizers (hook envelopes, transcript records) cannot disagree on them.
import type { EventKind } from '@mcs/shared';
import type { Stamp } from '@mcs/shared/protocol';
import { TOOL_ID_RE } from '@mcs/shared/protocol';

import { clipCodePoints } from '../platform/fsx.ts';

/** Stored outcome of a tool call; `closed_by_batch` and `closed_by_turn_end` are display-only (02 4.1). */
export type ToolOutcome = 'ok' | 'error' | 'denied' | 'interrupted';

export type EntryKind = 'prompt' | 'say' | 'think' | 'tool' | 'result' | 'system' | 'attachment';

export type InfoKind =
  | 'task_created'
  | 'task_completed'
  | 'teammate_idle'
  | 'model_switch'
  | 'cwd_changed'
  | 'queued_command'
  | 'away_summary'
  | 'local_command';

/** One logical fact read from an envelope or a record (02 4.3; names are registry 11.3). */
export type LogicalEvent =
  | {
      k: 'session.seen';
      sessionId: string;
      stamp: Stamp;
      cwd?: string;
      transcriptPath?: string;
      entrypoint?: string;
      version?: string;
      gitBranch?: string;
      claudePid?: number;
    }
  | { k: 'session.start'; sessionId: string; stamp: Stamp; startSource: string; model?: string }
  | { k: 'session.end'; sessionId: string; stamp: Stamp; reason: string }
  | {
      k: 'turn.prompt';
      sessionId: string;
      agentId: string | null;
      promptId: string | null;
      stamp: Stamp;
      origin: string;
      promptLen?: number;
    }
  | {
      k: 'turn.end';
      sessionId: string;
      agentId: string | null;
      promptId: string | null;
      stamp: Stamp;
      kind: 'stop' | 'stop_failure' | 'end_turn' | 'turn_duration';
      error?: string;
      backgroundTasks?: number;
      pendingBackgroundAgents?: number;
      pendingWorkflows?: number;
    }
  | {
      k: 'tool.start';
      sessionId: string;
      agentId: string | null;
      promptId: string | null;
      toolUseId: string;
      name: string;
      stamp: Stamp;
      summary?: string;
      inputHash?: string;
    }
  | {
      k: 'tool.end';
      sessionId: string;
      agentId: string | null;
      toolUseId: string;
      stamp: Stamp;
      outcome: ToolOutcome;
      durationMs?: number;
      exitCode?: number;
    }
  | { k: 'tool.batch'; sessionId: string; promptId: string | null; toolUseIds: string[]; stamp: Stamp }
  | {
      k: 'permission.request';
      sessionId: string;
      promptId: string | null;
      toolName: string;
      inputHash: string;
      stamp: Stamp;
    }
  | { k: 'notification'; sessionId: string; type: string; stamp: Stamp }
  | { k: 'agent.start'; sessionId: string; agentId: string; agentType: string; stamp: Stamp }
  | { k: 'agent.stop'; sessionId: string; agentId: string; agentType: string; stamp: Stamp; transcriptPath?: string }
  | { k: 'agent.link'; sessionId: string; agentId: string; toolUseId: string; status: string | null; stamp: Stamp }
  | { k: 'agent.final'; sessionId: string; agentId: string; stamp: Stamp; via: 'tool_ends_turn' | 'structured_output' }
  | {
      k: 'agent.notification';
      sessionId: string;
      toolUseId: string | null;
      taskId: string | null;
      status: 'completed' | 'failed' | 'killed' | 'stopped' | null;
      stamp: Stamp;
    }
  | {
      k: 'agent.meta';
      sessionId: string;
      agentId: string;
      agentType?: string;
      description?: string;
      model?: string;
      requestShape?: string;
      spawnToolUseId?: string;
      workflowRunId?: string;
      workflowPhase?: string;
    }
  | { k: 'workflow.launch'; sessionId: string; runId: string; toolUseId: string; name?: string; stamp: Stamp }
  | {
      k: 'workflow.status';
      sessionId: string;
      runId: string;
      observedAt: number;
      fileStatus: string | null;
      agentCount?: number;
      started: number;
      results: number;
      failed: number;
    }
  | {
      k: 'activity';
      sessionId: string;
      agentId: string | null;
      stamp: Stamp;
      via: 'hook' | 'assistant' | 'user' | 'tool_result' | 'system';
    }
  | {
      k: 'interrupt';
      sessionId: string;
      agentId: string | null;
      stamp: Stamp;
      via: 'user_marker' | 'aborted_mid_stream';
    }
  | { k: 'api_error'; sessionId: string; agentId: string | null; stamp: Stamp; status?: number; error?: string }
  | { k: 'assistant.ok'; sessionId: string; agentId: string | null; stamp: Stamp }
  | {
      k: 'compaction';
      sessionId: string;
      stamp: Stamp;
      trigger: string;
      preTokens?: number;
      postTokens?: number;
    }
  | { k: 'title'; sessionId: string; source: 'ai' | 'custom' | 'agent_name'; value: string; order: number }
  | { k: 'session.continued_in'; sessionId: string; target: string }
  | { k: 'session.copied_from'; sessionId: string; source: string; count: number }
  | {
      k: 'cost_state';
      sessionId: string;
      fileId: number;
      byteOffset: number;
      totalCostUsd: number | null;
      modelUsage: Record<string, Record<string, number>>;
    }
  | { k: 'hook.handler_error'; sessionId: string; hookEvent: string; exitCode: number | null; stamp: Stamp }
  | {
      k: 'external.registry';
      sessionId: string;
      status: 'busy' | 'idle' | 'waiting';
      waitingFor?: string;
      pid: number;
      pidAlive: boolean;
      observedAt: number;
    }
  | { k: 'external.job'; sessionId: string; jobId: string; state: string; observedAt: number }
  | {
      k: 'external.attempt';
      sessionId: string;
      state: 'COMPLETED' | 'FAILED' | 'UNKNOWN';
      evidence: string;
      rowKey: string;
      endedAt: number;
      observedAt: number;
    }
  | { k: 'external.attempt_cleared'; sessionId: string; observedAt: number }
  | { k: 'external.pid'; sessionId: string; pid: number; alive: boolean; checkedAt: number }
  | {
      k: 'info';
      sessionId: string;
      stamp: Stamp;
      what: InfoKind;
      detail?: Record<string, string | number>;
    };

/** The input of `EventsRepo.insert` (03 3.6): the parameter names of the statement, session and agent by provider id. */
export interface EventRowWrite {
  readonly sessionUid: string;
  /** `'main'` for the main agent, null for an event of the session itself (the repository resolves the row id). */
  readonly agentUid: string | null;
  readonly kind: EventKind;
  readonly entryKind: EntryKind | null;
  readonly severity: 0 | 1 | 2;
  /** Source bits: hook 1, transcript 2, monitor 4. */
  readonly sources: 1 | 2 | 4;
  readonly stamp: Stamp;
  readonly tsSource: 'record' | 'hook_received' | 'derived';
  readonly receivedAt: number;
  readonly eventUid: string | null;
  readonly naturalKey: string | null;
  readonly recordUuid: string | null;
  readonly hookEvent: string | null;
  readonly contentHash: string | null;
  readonly spoolSegment: string | null;
  readonly spoolOffset: number | null;
  readonly flags: readonly string[];
  readonly promptId: string | null;
  readonly toolUseId: string | null;
  readonly toolName: string | null;
  readonly messageId: string | null;
  readonly fileId: number | null;
  readonly byteOffset: number | null;
  readonly byteLength: number | null;
  readonly lineNo: number | null;
  readonly recordType: string | null;
  readonly subtype: string | null;
  readonly textLen: number | null;
  readonly summary: string | null;
  /** Hook rows: sanitized envelope data; monitor rows: the reconciliation detail. Never a body. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>> | null;
}

/** What a builder must say; everything else defaults to null (or an empty flag list). */
export type EventRowInit = Pick<
  EventRowWrite,
  'sessionUid' | 'kind' | 'sources' | 'stamp' | 'tsSource' | 'receivedAt'
> &
  Partial<Omit<EventRowWrite, 'sessionUid' | 'kind' | 'sources' | 'stamp' | 'tsSource' | 'receivedAt' | 'severity'>>;

const SEVERITY_2: ReadonlySet<EventKind> = new Set<EventKind>([
  'tool.failure',
  'turn.failure',
  'api.error',
  'hook.handler_error',
]);
const SEVERITY_1: ReadonlySet<EventKind> = new Set<EventKind>([
  'permission.denied',
  'turn.interrupt',
  'hook.unknown',
  'monitor.gap',
  'monitor.reconcile',
]);

/** Severity of a stored kind (02 4.1.2): 2 failures, 1 warnings, 0 the rest. */
export function severityOfKind(kind: EventKind): 0 | 1 | 2 {
  if (SEVERITY_2.has(kind)) return 2;
  if (SEVERITY_1.has(kind)) return 1;
  return 0;
}

/** Column limits of `events` (03 3.5 CHECKs, counted in characters): a longer provider string never reaches an insert. */
export const ROW_LIMITS = {
  toolName: 200,
  subtype: 40,
  recordType: 32,
  hookEvent: 64,
  summary: 240,
  messageId: 128,
  recordUuid: 80,
} as const;

function clipped(value: string | null | undefined, max: number): string | null {
  return value === undefined || value === null ? null : clipCodePoints(value, max);
}

/** The value, or null when it is longer than the column allows (an id cut short would name another thing). */
function orNullWhenLonger(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null;
  return Array.from(value).length <= max ? value : null;
}

/**
 * A complete row: the severity follows the kind, every unnamed column is null. Strings copied from a provider are cut to
 * the column limits (`ROW_LIMITS`); an id that is too long becomes null, so a caller that needs a record uuid builds its
 * fallback key BEFORE calling (see `entryKey` in normalize-record.ts).
 */
export function eventRow(init: EventRowInit): EventRowWrite {
  return {
    sessionUid: init.sessionUid,
    agentUid: init.agentUid ?? null,
    kind: init.kind,
    entryKind: init.entryKind ?? null,
    severity: severityOfKind(init.kind),
    sources: init.sources,
    stamp: init.stamp,
    tsSource: init.tsSource,
    receivedAt: init.receivedAt,
    eventUid: init.eventUid ?? null,
    naturalKey: init.naturalKey ?? null,
    recordUuid: orNullWhenLonger(init.recordUuid, ROW_LIMITS.recordUuid),
    hookEvent: clipped(init.hookEvent, ROW_LIMITS.hookEvent),
    contentHash: init.contentHash ?? null,
    spoolSegment: init.spoolSegment ?? null,
    spoolOffset: init.spoolOffset ?? null,
    flags: init.flags ?? [],
    promptId: init.promptId ?? null,
    toolUseId: init.toolUseId ?? null,
    toolName: clipped(init.toolName, ROW_LIMITS.toolName),
    messageId: orNullWhenLonger(init.messageId, ROW_LIMITS.messageId),
    fileId: init.fileId ?? null,
    byteOffset: init.byteOffset ?? null,
    byteLength: init.byteLength ?? null,
    lineNo: init.lineNo ?? null,
    recordType: clipped(init.recordType, ROW_LIMITS.recordType),
    subtype: clipped(init.subtype, ROW_LIMITS.subtype),
    textLen: init.textLen ?? null,
    summary: clipped(init.summary, ROW_LIMITS.summary),
    detail: init.detail ?? null,
  };
}

// ---- natural keys (02 4.1.1, adopted from 03 3.6) ------------------------------------------------------------------
// Each builder returns null when an id is missing or malformed: a key is set only when its id is usable.

function usableId(id: string | null | undefined): id is string {
  return typeof id === 'string' && TOOL_ID_RE.test(id);
}

/** `tool.call:<tool_use_id>` (PreToolUse and the assistant `tool_use` block). */
export function toolCallKey(toolUseId: string | null | undefined): string | null {
  return usableId(toolUseId) ? `tool.call:${toolUseId}` : null;
}

/** `tool.end:<tool_use_id>` (PostToolUse, PostToolUseFailure and the user `tool_result` block). */
export function toolEndKey(toolUseId: string | null | undefined): string | null {
  return usableId(toolUseId) ? `tool.end:${toolUseId}` : null;
}

/** `permission.denied:<tool_use_id>`. */
export function permissionDeniedKey(toolUseId: string | null | undefined): string | null {
  return usableId(toolUseId) ? `permission.denied:${toolUseId}` : null;
}

/** `prompt:<session_uid>:<prompt_id>`. */
export function promptKey(sessionUid: string, promptId: string | null | undefined): string | null {
  return usableId(promptId) ? `prompt:${sessionUid}:${promptId}` : null;
}

/** `tool.batch:<session_uid>:<ids_hash>`; `idsHash` comes from the sorted tool use ids (see `normalize-envelope.ts`). */
export function toolBatchKey(sessionUid: string, idsHash: string | null): string | null {
  return idsHash === null ? null : `tool.batch:${sessionUid}:${idsHash}`;
}

/** `task.<created|completed>:<session_uid>:<task_id>`. */
export function taskKey(
  which: 'created' | 'completed',
  sessionUid: string,
  taskId: string | null | undefined,
): string | null {
  return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 128
    ? `task.${which}:${sessionUid}:${taskId}`
    : null;
}
