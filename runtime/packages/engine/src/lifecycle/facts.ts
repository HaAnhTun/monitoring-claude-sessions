// Lifecycle facts (02 7.1 to 7.3, ADR 0018): the vocabulary, the fact registers of a session, an agent and a workflow
// run, and the table "logical event -> fact update". Every register is a join-semilattice element (merge.ts), so a fact
// set built from any permutation or duplication of the same events is the same fact set.
//
// An event becomes a DELTA: a fact set that holds only what this one event says. Folding is `merge(facts, delta)`; the
// writer never mutates facts in place. Where the event alone cannot say where it came from (a hook envelope or a
// transcript record carry the same `LogicalEvent` shapes) the caller passes the origin, which is known from the
// `IngestItem.kind` (02 4.6).
import type { LifecycleState } from '@mcs/shared';
import type { Stamp } from '@mcs/shared/protocol';
import { z } from 'zod';

import type { LogicalEvent, ToolOutcome } from '../ingest/event-row.ts';

export type { LifecycleState };

// ---- vocabulary (02 7.1, registry 11.1) --------------------------------------------------------------------------

export const PRESENCES = ['open', 'ended', 'unknown'] as const;
/** Is the provider process or session still there. */
export type Presence = (typeof PRESENCES)[number];

export const WAIT_REASONS = ['user', 'permission', 'elicitation', 'agent_input', 'idle_prompt'] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];

export const STALE_KINDS = ['silent', 'abandoned', 'process_gone', 'parent_ended'] as const;
export type StaleKind = (typeof STALE_KINDS)[number];

export const BASES = ['observed', 'inferred'] as const;
export type Basis = (typeof BASES)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const TURN_OUTCOMES = ['ok', 'error', 'interrupted'] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export const EVIDENCE_SOURCES = [
  'hook',
  'transcript',
  'registry',
  'job',
  'attempts',
  'pid',
  'workflow_file',
  'journal',
  'meta',
  'clock',
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const EVIDENCE_FACTS = [
  'session_end',
  'session_start',
  'stop',
  'stop_failure',
  'end_turn',
  'interrupt',
  'prompt',
  'tool_open',
  'permission_request',
  'notification',
  'registry_status',
  'job_state',
  'attempt_row',
  'pid_dead',
  'pid_alive',
  'file_written',
  'child_active',
  'background_pending',
  'agent_notification',
  'agent_stop',
  'agent_final',
  'agent_link',
  'workflow_status',
  'quiet',
  'no_records',
  'api_error',
  'activity_after_end',
  'parent_ended',
] as const;
export type EvidenceFact = (typeof EVIDENCE_FACTS)[number];

/** The engine form of an evidence item (registry C18); the API form is `EvidenceItem` of `@mcs/shared`. */
export interface LifecycleEvidence {
  readonly source: EvidenceSource;
  readonly fact: EvidenceFact;
  /** Epoch ms of the fact; null when it has no time. */
  readonly at: number | null;
  readonly count?: number;
  /** Enum-like, at most 64 characters, never content (exception: `attempts:attempt_row`, at most 160 code points). */
  readonly value?: string;
}

export interface LifecycleView {
  readonly state: LifecycleState;
  readonly presence: Presence;
  readonly waitReason: WaitReason | null;
  readonly staleKind: StaleKind | null;
  /** SessionEnd reason, job state or attempt status. */
  readonly endReason: string | null;
  readonly turnOutcome: TurnOutcome | null;
  readonly basis: Basis;
  readonly confidence: Confidence;
  /** The rule that decided, for example `S-7c`. */
  readonly ruleId: string;
  /** Ordered, at most 8; the words are rendered at read time (`renderEvidence`). */
  readonly evidence: readonly LifecycleEvidence[];
  /** `at` of the deciding fact. */
  readonly since: number | null;
  readonly evaluatedAt: number;
  readonly nextCheckAt: number | null;
}

/** The `lifecycle` thresholds of `runtime.json` (02 7.8), resolved: seconds where the key says Seconds, else ms. */
export interface LifecycleCfg {
  readonly activeSeconds: number;
  readonly pendingToolGraceSeconds: number;
  readonly subagentActiveSeconds: number;
  readonly staleAfterSeconds: number;
  readonly abandonedAfterSeconds: number;
  readonly processGoneGraceSeconds: number;
  readonly crossSourceToleranceMs: number;
  readonly reopenToleranceMs: number;
  readonly sweepIntervalMs: number;
  readonly pidCheckIntervalMs: number;
  readonly registryPollMs: number;
  readonly jobsPollMs: number;
}

/** The defaults of 02 7.8 (`active_seconds` 120 and `pending_tool_grace_seconds` 900 come from the legacy keys). */
export const DEFAULT_LIFECYCLE_CFG: LifecycleCfg = {
  activeSeconds: 120,
  pendingToolGraceSeconds: 900,
  subagentActiveSeconds: 60,
  staleAfterSeconds: 1800,
  abandonedAfterSeconds: 86_400,
  processGoneGraceSeconds: 30,
  crossSourceToleranceMs: 2000,
  reopenToleranceMs: 2000,
  sweepIntervalMs: 5000,
  pidCheckIntervalMs: 10_000,
  registryPollMs: 5000,
  jobsPollMs: 15_000,
};

// ---- fact registers (02 7.2) ---------------------------------------------------------------------------------------

/** Last-writer-wins register: the greater stamp wins, equal stamps tie-break on `JSON.stringify(value)`. */
export interface Lww<T> {
  readonly stamp: Stamp;
  readonly value: T;
}

export interface TurnEndInfo {
  readonly kind: 'stop' | 'stop_failure' | 'end_turn' | 'turn_duration';
  readonly promptId: string | null;
  readonly error: string | null;
  readonly backgroundTasks: number | null;
  readonly pendingBackgroundAgents: number | null;
  readonly pendingWorkflows: number | null;
}

export const START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork', 'other'] as const;
export type StartSource = (typeof START_SOURCES)[number];

export interface PermissionFact {
  readonly requested: Stamp | null;
  readonly resolved: Stamp | null;
}

export interface RegistryFact {
  readonly status: 'busy' | 'idle' | 'waiting';
  readonly waitingFor: string | null;
  readonly pid: number;
  readonly pidAlive: boolean;
}

export interface AttemptFact {
  readonly state: 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  readonly evidence: string;
  readonly rowKey: string;
  readonly endedAt: number;
}

export interface LegacyFacts {
  readonly lastStop: Lww<string> | null;
  /** First timestamp string of the file in file order (legacy parity input, 7.9). */
  readonly fileFirstTs: string | null;
  /** Greatest timestamp string of the file. */
  readonly fileMaxTs: string | null;
}

export interface SessionFacts {
  readonly v: 1;
  /** Min over all stamps and the file's first timestamp. */
  readonly firstSeenAt: number | null;
  /** Max `received_at` over the envelopes of this session. */
  readonly lastHookAt: number | null;
  /** Or: at least one valid conversational record in the session's own file. */
  readonly hasRecords: boolean;
  /** Max observed mtime of the own file (epoch ms). */
  readonly transcriptMtime: number | null;
  /** Max over the activity events of the main agent, both sources. */
  readonly lastActivity: Stamp | null;
  readonly lastPromptHook: Stamp | null;
  readonly lastPromptTx: Stamp | null;
  readonly lastTurnEndHook: Lww<TurnEndInfo> | null;
  readonly lastTurnEndTx: Lww<TurnEndInfo> | null;
  readonly lastInterrupt: Stamp | null;
  readonly starts: Readonly<Partial<Record<StartSource, Stamp>>>;
  /** LWW by stamp: the later SessionEnd. */
  readonly end: { readonly stamp: Stamp; readonly reason: string } | null;
  /** Keyed by the tool input hash; the 64 newest by `requested` are kept. */
  readonly permissions: Readonly<Record<string, PermissionFact>>;
  /** Keyed by the notification type. */
  readonly notifications: Readonly<Record<string, Stamp>>;
  readonly lastApiError: Stamp | null;
  readonly lastAssistantOk: Stamp | null;
  readonly claudePid: Lww<number> | null;
  readonly pid: Lww<{ readonly pid: number; readonly alive: boolean }> | null;
  readonly registry: Lww<RegistryFact> | null;
  readonly job: Lww<{ readonly jobId: string; readonly state: string }> | null;
  /** A register holding `null` is a retraction by `external.attempt_cleared` (I-18): "no evidence". */
  readonly attempt: Lww<AttemptFact | null> | null;
  /**
   * Deprecated (CR-WP-28-2): no event writes it any more and no rule reads it. Whether a cost-state record is still the last
   * record of its file is a row-level fact (`cost_states.is_trailing`), handed to the derivation as an input
   * (`SessionRows.costStateTrailing`). The key stays in the stored facts so that the facts of an existing database parse.
   */
  readonly costStateTrailing: Lww<boolean> | null;
  /**
   * Deprecated (CR-WP-28-2): a Max counter fed by one event could only be 0 or 1 and nothing read it. The health counts the
   * `hook.handler_error` rows of `events`. The key stays in the stored facts so that existing databases parse.
   */
  readonly hookHandlerErrors: number;
  readonly legacy: LegacyFacts;
}

export const AGENT_KINDS = ['subagent', 'workflow_agent', 'internal'] as const;
/** Facts of non-main agents only: the `main` agent uses `SessionFacts`; `teammate` is reserved (C56). */
export type AgentFactKind = (typeof AGENT_KINDS)[number];

export const AGENT_NOTIFICATION_STATUSES = ['completed', 'failed', 'killed', 'stopped'] as const;
export type AgentNotificationStatus = (typeof AGENT_NOTIFICATION_STATUSES)[number];

export const JOURNAL_STATES = ['started', 'result', 'failed'] as const;
export type JournalState = (typeof JOURNAL_STATES)[number];

export interface AgentFacts {
  readonly v: 1;
  readonly kind: AgentFactKind;
  readonly started: Stamp | null;
  readonly stopped: Stamp | null;
  readonly final: Stamp | null;
  readonly notification: Lww<AgentNotificationStatus> | null;
  /** `completed`, `async_launched` or another status of PostToolUse(Agent). */
  readonly link: Lww<string> | null;
  /** Join: started < result < failed. */
  readonly journal: JournalState | null;
  readonly lastActivity: Stamp | null;
  /** Epoch ms of the agent's own file. */
  readonly fileMtime: number | null;
  readonly hasRecords: boolean;
  readonly lastTurnEnd: Lww<TurnEndInfo> | null;
  readonly lastPrompt: Stamp | null;
  readonly lastApiError: Stamp | null;
  readonly lastAssistantOk: Stamp | null;
  readonly legacy: { readonly lastStop: Lww<string> | null };
}

export interface WorkflowFacts {
  readonly v: 1;
  readonly launched: Stamp | null;
  /** Status of `workflows/<runId>.json`; stamp `at` = observedAt. */
  readonly fileStatus: Lww<string> | null;
  readonly started: number;
  readonly results: number;
  readonly failed: number;
  readonly agentCount: number | null;
  readonly lastAgentActivity: number | null;
}

/**
 * One `tool_call` row (02 4.1): per tool_use_id, `startedAt` Min, `endedAt` and `batchAt` Max, the outcome by precedence.
 * An open call has neither `endedAt` nor `batchAt`.
 */
export interface ToolCallRow {
  readonly toolUseId: string;
  /** The agent that made the call; null = the main agent (or not known yet). */
  readonly agentId: string | null;
  readonly name: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly batchAt: number | null;
  readonly outcome: ToolOutcome | null;
  readonly inputHash: string | null;
  /** Status of the `agent.link` that names this call as the spawn call of an agent (S-7a). */
  readonly link: Lww<string> | null;
  /** The transcript holds the `tool_use` block / the `tool_result` block (legacy pending, 7.9). */
  readonly transcriptUse: boolean;
  readonly transcriptResult: boolean;
}

// ---- constructors -----------------------------------------------------------------------------------------------

export function emptySessionFacts(): SessionFacts {
  return {
    v: 1,
    firstSeenAt: null,
    lastHookAt: null,
    hasRecords: false,
    transcriptMtime: null,
    lastActivity: null,
    lastPromptHook: null,
    lastPromptTx: null,
    lastTurnEndHook: null,
    lastTurnEndTx: null,
    lastInterrupt: null,
    starts: {},
    end: null,
    permissions: {},
    notifications: {},
    lastApiError: null,
    lastAssistantOk: null,
    claudePid: null,
    pid: null,
    registry: null,
    job: null,
    attempt: null,
    costStateTrailing: null,
    hookHandlerErrors: 0,
    legacy: { lastStop: null, fileFirstTs: null, fileMaxTs: null },
  };
}

/** Facts with the given registers set; the other registers stay empty (a merge-neutral element elsewhere). */
export function sessionFactsWith(patch: Partial<SessionFacts>): SessionFacts {
  return { ...emptySessionFacts(), ...patch };
}

export function emptyAgentFacts(kind: AgentFactKind = 'subagent'): AgentFacts {
  return {
    v: 1,
    kind,
    started: null,
    stopped: null,
    final: null,
    notification: null,
    link: null,
    journal: null,
    lastActivity: null,
    fileMtime: null,
    hasRecords: false,
    lastTurnEnd: null,
    lastPrompt: null,
    lastApiError: null,
    lastAssistantOk: null,
    legacy: { lastStop: null },
  };
}

export function agentFactsWith(patch: Partial<AgentFacts>): AgentFacts {
  return { ...emptyAgentFacts(), ...patch };
}

export function emptyWorkflowFacts(): WorkflowFacts {
  return {
    v: 1,
    launched: null,
    fileStatus: null,
    started: 0,
    results: 0,
    failed: 0,
    agentCount: null,
    lastAgentActivity: null,
  };
}

export function workflowFactsWith(patch: Partial<WorkflowFacts>): WorkflowFacts {
  return { ...emptyWorkflowFacts(), ...patch };
}

export function emptyToolCallRow(toolUseId: string): ToolCallRow {
  return {
    toolUseId,
    agentId: null,
    name: null,
    startedAt: null,
    endedAt: null,
    batchAt: null,
    outcome: null,
    inputHash: null,
    link: null,
    transcriptUse: false,
    transcriptResult: false,
  };
}

// ---- event -> delta (02 7.3) -----------------------------------------------------------------------------------

/** Where an event was read: a hook envelope, a transcript record, or an external poller (registry, job, pid, attempts). */
export type EventOrigin = 'hook' | 'transcript' | 'external';

const NO_RANK_TIE = (at: number, rank = 0, tie = ''): Stamp => ({ at, rank, tie });

function isStartSource(value: string): value is StartSource {
  return START_SOURCES.some((source) => source === value);
}

function turnEndInfoOf(event: Extract<LogicalEvent, { k: 'turn.end' }>): TurnEndInfo {
  return {
    kind: event.kind,
    promptId: event.promptId,
    error: event.error ?? null,
    backgroundTasks: event.backgroundTasks ?? null,
    pendingBackgroundAgents: event.pendingBackgroundAgents ?? null,
    pendingWorkflows: event.pendingWorkflows ?? null,
  };
}

/** The stamp of an event that has one (events of external pollers and some bookkeeping events have none). */
function stampOf(event: LogicalEvent): Stamp | null {
  return 'stamp' in event ? event.stamp : null;
}

/**
 * The delta an event contributes to the facts of its session (the main agent's registers). Null when the event
 * says nothing about session facts (agent-only events, titles, column updates).
 */
export function sessionFactsOfEvent(event: LogicalEvent, origin: EventOrigin): SessionFacts | null {
  const stamp = stampOf(event);
  const seen: Partial<SessionFacts> =
    stamp !== null && origin !== 'external'
      ? { firstSeenAt: stamp.at, ...(origin === 'hook' ? { lastHookAt: stamp.at } : {}) }
      : {};
  const delta = (patch: Partial<SessionFacts>): SessionFacts => sessionFactsWith({ ...seen, ...patch });
  const isMain = (agentId: string | null): boolean => agentId === null;

  switch (event.k) {
    case 'session.seen':
      return delta(event.claudePid === undefined ? {} : { claudePid: { stamp: event.stamp, value: event.claudePid } });
    case 'session.start': {
      const source: StartSource = isStartSource(event.startSource) ? event.startSource : 'other';
      return delta({ starts: { [source]: event.stamp } });
    }
    case 'session.end':
      return delta({ end: { stamp: event.stamp, reason: event.reason } });
    case 'turn.prompt':
      if (!isMain(event.agentId)) return null;
      return delta({
        lastActivity: event.stamp,
        ...(origin === 'hook' ? { lastPromptHook: event.stamp } : { lastPromptTx: event.stamp }),
      });
    case 'turn.end': {
      if (!isMain(event.agentId)) return null;
      const info = turnEndInfoOf(event);
      const register = { stamp: event.stamp, value: info };
      return delta(origin === 'hook' ? { lastTurnEndHook: register } : { lastTurnEndTx: register });
    }
    case 'interrupt':
      return isMain(event.agentId) ? delta({ lastInterrupt: event.stamp }) : null;
    case 'tool.start':
    case 'tool.end':
      return isMain(event.agentId) ? delta({ lastActivity: event.stamp }) : null;
    case 'tool.batch':
      return delta({ lastActivity: event.stamp });
    case 'permission.request':
      return delta({ permissions: { [event.inputHash]: { requested: event.stamp, resolved: null } } });
    case 'notification':
      return delta({ notifications: { [event.type]: event.stamp } });
    case 'activity':
      if (!isMain(event.agentId)) return null;
      return delta({ lastActivity: event.stamp, ...(origin === 'hook' ? {} : { hasRecords: true }) });
    case 'api_error':
      return isMain(event.agentId) ? delta({ lastApiError: event.stamp }) : null;
    case 'assistant.ok':
      return isMain(event.agentId) ? delta({ lastAssistantOk: event.stamp }) : null;
    case 'compaction':
      return delta({ lastActivity: event.stamp });
    case 'cost_state':
    case 'hook.handler_error':
      // no fact (CR-WP-28-2): the cost state is a row of its own, the handler errors are rows of `events`
      return null;
    case 'external.registry':
      return sessionFactsWith({
        registry: {
          stamp: NO_RANK_TIE(event.observedAt),
          value: {
            status: event.status,
            waitingFor: event.waitingFor ?? null,
            pid: event.pid,
            pidAlive: event.pidAlive,
          },
        },
      });
    case 'external.job':
      return sessionFactsWith({
        job: { stamp: NO_RANK_TIE(event.observedAt), value: { jobId: event.jobId, state: event.state } },
      });
    case 'external.attempt':
      return sessionFactsWith({
        attempt: {
          stamp: NO_RANK_TIE(event.observedAt, 1, event.rowKey),
          value: { state: event.state, evidence: event.evidence, rowKey: event.rowKey, endedAt: event.endedAt },
        },
      });
    case 'external.attempt_cleared':
      // I-18: a retraction is a null in the same register, ranked below a republish of the same tick (rank 1).
      return sessionFactsWith({ attempt: { stamp: NO_RANK_TIE(event.observedAt, 0, ''), value: null } });
    case 'external.pid':
      return sessionFactsWith({
        pid: { stamp: NO_RANK_TIE(event.checkedAt), value: { pid: event.pid, alive: event.alive } },
      });
    case 'agent.start':
    case 'agent.stop':
    case 'agent.link':
    case 'agent.final':
    case 'agent.notification':
    case 'agent.meta':
    case 'workflow.launch':
    case 'workflow.status':
    case 'title':
    case 'session.continued_in':
    case 'session.copied_from':
    case 'info':
      return stamp === null ? null : delta({});
  }
}

/** The delta an event contributes to the facts of one non-main agent, with the agent id it belongs to. */
export function agentFactsOfEvent(
  event: LogicalEvent,
  origin: EventOrigin,
): { readonly agentId: string; readonly facts: AgentFacts } | null {
  switch (event.k) {
    case 'agent.start':
      return { agentId: event.agentId, facts: agentFactsWith({ started: event.stamp }) };
    case 'agent.stop':
      return { agentId: event.agentId, facts: agentFactsWith({ stopped: event.stamp }) };
    case 'agent.final':
      return { agentId: event.agentId, facts: agentFactsWith({ final: event.stamp }) };
    case 'agent.link':
      return {
        agentId: event.agentId,
        facts: agentFactsWith(event.status === null ? {} : { link: { stamp: event.stamp, value: event.status } }),
      };
    case 'agent.meta':
      return {
        agentId: event.agentId,
        facts: emptyAgentFacts(event.workflowRunId === undefined ? 'subagent' : 'workflow_agent'),
      };
    case 'turn.prompt':
      return event.agentId === null
        ? null
        : { agentId: event.agentId, facts: agentFactsWith({ lastPrompt: event.stamp, lastActivity: event.stamp }) };
    case 'turn.end':
      return event.agentId === null
        ? null
        : {
            agentId: event.agentId,
            facts: agentFactsWith({ lastTurnEnd: { stamp: event.stamp, value: turnEndInfoOf(event) } }),
          };
    case 'activity':
      return event.agentId === null
        ? null
        : {
            agentId: event.agentId,
            facts: agentFactsWith({ lastActivity: event.stamp, ...(origin === 'hook' ? {} : { hasRecords: true }) }),
          };
    case 'api_error':
      return event.agentId === null
        ? null
        : { agentId: event.agentId, facts: agentFactsWith({ lastApiError: event.stamp }) };
    case 'assistant.ok':
      return event.agentId === null
        ? null
        : { agentId: event.agentId, facts: agentFactsWith({ lastAssistantOk: event.stamp }) };
    case 'session.seen':
    case 'session.start':
    case 'session.end':
    case 'tool.start':
    case 'tool.end':
    case 'tool.batch':
    case 'permission.request':
    case 'notification':
    case 'agent.notification':
    case 'workflow.launch':
    case 'workflow.status':
    case 'interrupt':
    case 'compaction':
    case 'title':
    case 'session.continued_in':
    case 'session.copied_from':
    case 'cost_state':
    case 'hook.handler_error':
    case 'external.registry':
    case 'external.job':
    case 'external.attempt':
    case 'external.attempt_cleared':
    case 'external.pid':
    case 'info':
      return null;
  }
}

/** The delta an event contributes to the facts of one workflow run, with the run id. */
export function workflowFactsOfEvent(
  event: LogicalEvent,
): { readonly runId: string; readonly facts: WorkflowFacts } | null {
  switch (event.k) {
    case 'workflow.launch':
      return { runId: event.runId, facts: workflowFactsWith({ launched: event.stamp }) };
    case 'workflow.status':
      return {
        runId: event.runId,
        facts: workflowFactsWith({
          started: event.started,
          results: event.results,
          failed: event.failed,
          ...(event.agentCount === undefined ? {} : { agentCount: event.agentCount }),
          ...(event.fileStatus === null
            ? {}
            : { fileStatus: { stamp: NO_RANK_TIE(event.observedAt), value: event.fileStatus } }),
        }),
      };
    case 'session.seen':
    case 'session.start':
    case 'session.end':
    case 'turn.prompt':
    case 'turn.end':
    case 'tool.start':
    case 'tool.end':
    case 'tool.batch':
    case 'permission.request':
    case 'notification':
    case 'agent.start':
    case 'agent.stop':
    case 'agent.link':
    case 'agent.final':
    case 'agent.notification':
    case 'agent.meta':
    case 'activity':
    case 'interrupt':
    case 'api_error':
    case 'assistant.ok':
    case 'compaction':
    case 'title':
    case 'session.continued_in':
    case 'session.copied_from':
    case 'cost_state':
    case 'hook.handler_error':
    case 'external.registry':
    case 'external.job':
    case 'external.attempt':
    case 'external.attempt_cleared':
    case 'external.pid':
    case 'info':
      return null;
  }
}

/** The tool-call rows an event touches: a start, an end, a batch listing calls, or the link that names a spawn call. */
export function toolRowsOfEvent(event: LogicalEvent, origin: EventOrigin): ToolCallRow[] {
  const transcript = origin === 'transcript';
  switch (event.k) {
    case 'tool.start':
      return [
        {
          ...emptyToolCallRow(event.toolUseId),
          agentId: event.agentId,
          name: event.name,
          startedAt: event.stamp.at,
          inputHash: event.inputHash ?? null,
          transcriptUse: transcript,
        },
      ];
    case 'tool.end':
      return [
        {
          ...emptyToolCallRow(event.toolUseId),
          agentId: event.agentId,
          endedAt: event.stamp.at,
          outcome: event.outcome,
          transcriptResult: transcript,
        },
      ];
    case 'tool.batch':
      return event.toolUseIds.map((id) => ({ ...emptyToolCallRow(id), batchAt: event.stamp.at }));
    case 'agent.link':
      return event.status === null
        ? [emptyToolCallRow(event.toolUseId)]
        : [{ ...emptyToolCallRow(event.toolUseId), link: { stamp: event.stamp, value: event.status } }];
    case 'session.seen':
    case 'session.start':
    case 'session.end':
    case 'turn.prompt':
    case 'turn.end':
    case 'permission.request':
    case 'notification':
    case 'agent.start':
    case 'agent.stop':
    case 'agent.final':
    case 'agent.notification':
    case 'agent.meta':
    case 'workflow.launch':
    case 'workflow.status':
    case 'activity':
    case 'interrupt':
    case 'api_error':
    case 'assistant.ok':
    case 'compaction':
    case 'title':
    case 'session.continued_in':
    case 'session.copied_from':
    case 'cost_state':
    case 'hook.handler_error':
    case 'external.registry':
    case 'external.job':
    case 'external.attempt':
    case 'external.attempt_cleared':
    case 'external.pid':
    case 'info':
      return [];
  }
}

// ---- persisted facts (the `facts_json` boundary) --------------------------------------------------------------------
//
// Facts are stored as JSON next to the entity row and read back by the ingest writer and the sweeper. The reader
// validates what it loaded: a row written by another version, a damaged value or an unknown key is refused (the caller
// then rebuilds the facts from the events) instead of feeding a decision table with a wrong shape. The schemas are
// annotated with the TypeScript types above, so a field added to one and not to the other does not compile.

const StampSchema = z.strictObject({ at: z.number(), rank: z.number(), tie: z.string() });
const CountSchema = z.number().int().nonnegative();

function lwwOf<V extends z.ZodType>(value: V) {
  return z.strictObject({ stamp: StampSchema, value });
}

const TurnEndInfoSchema = z.strictObject({
  kind: z.enum(['stop', 'stop_failure', 'end_turn', 'turn_duration']),
  promptId: z.string().nullable(),
  error: z.string().nullable(),
  backgroundTasks: CountSchema.nullable(),
  pendingBackgroundAgents: CountSchema.nullable(),
  pendingWorkflows: CountSchema.nullable(),
});

const PermissionFactSchema = z.strictObject({ requested: StampSchema.nullable(), resolved: StampSchema.nullable() });

const AttemptFactSchema = z.strictObject({
  state: z.enum(['COMPLETED', 'FAILED', 'UNKNOWN']),
  evidence: z.string(),
  rowKey: z.string(),
  endedAt: z.number(),
});

export const SessionFactsSchema: z.ZodType<SessionFacts> = z.strictObject({
  v: z.literal(1),
  firstSeenAt: z.number().nullable(),
  lastHookAt: z.number().nullable(),
  hasRecords: z.boolean(),
  transcriptMtime: z.number().nullable(),
  lastActivity: StampSchema.nullable(),
  lastPromptHook: StampSchema.nullable(),
  lastPromptTx: StampSchema.nullable(),
  lastTurnEndHook: lwwOf(TurnEndInfoSchema).nullable(),
  lastTurnEndTx: lwwOf(TurnEndInfoSchema).nullable(),
  lastInterrupt: StampSchema.nullable(),
  starts: z.partialRecord(z.enum(START_SOURCES), StampSchema),
  end: z.strictObject({ stamp: StampSchema, reason: z.string() }).nullable(),
  permissions: z.record(z.string(), PermissionFactSchema),
  notifications: z.record(z.string(), StampSchema),
  lastApiError: StampSchema.nullable(),
  lastAssistantOk: StampSchema.nullable(),
  claudePid: lwwOf(z.number()).nullable(),
  pid: lwwOf(z.strictObject({ pid: z.number(), alive: z.boolean() })).nullable(),
  registry: lwwOf(
    z.strictObject({
      status: z.enum(['busy', 'idle', 'waiting']),
      waitingFor: z.string().nullable(),
      pid: z.number(),
      pidAlive: z.boolean(),
    }),
  ).nullable(),
  job: lwwOf(z.strictObject({ jobId: z.string(), state: z.string() })).nullable(),
  attempt: lwwOf(AttemptFactSchema.nullable()).nullable(),
  costStateTrailing: lwwOf(z.boolean()).nullable(),
  hookHandlerErrors: CountSchema,
  legacy: z.strictObject({
    lastStop: lwwOf(z.string()).nullable(),
    fileFirstTs: z.string().nullable(),
    fileMaxTs: z.string().nullable(),
  }),
});

export const AgentFactsSchema: z.ZodType<AgentFacts> = z.strictObject({
  v: z.literal(1),
  kind: z.enum(AGENT_KINDS),
  started: StampSchema.nullable(),
  stopped: StampSchema.nullable(),
  final: StampSchema.nullable(),
  notification: lwwOf(z.enum(AGENT_NOTIFICATION_STATUSES)).nullable(),
  link: lwwOf(z.string()).nullable(),
  journal: z.enum(JOURNAL_STATES).nullable(),
  lastActivity: StampSchema.nullable(),
  fileMtime: z.number().nullable(),
  hasRecords: z.boolean(),
  lastTurnEnd: lwwOf(TurnEndInfoSchema).nullable(),
  lastPrompt: StampSchema.nullable(),
  lastApiError: StampSchema.nullable(),
  lastAssistantOk: StampSchema.nullable(),
  legacy: z.strictObject({ lastStop: lwwOf(z.string()).nullable() }),
});

export const WorkflowFactsSchema: z.ZodType<WorkflowFacts> = z.strictObject({
  v: z.literal(1),
  launched: StampSchema.nullable(),
  fileStatus: lwwOf(z.string()).nullable(),
  started: CountSchema,
  results: CountSchema,
  failed: CountSchema,
  agentCount: CountSchema.nullable(),
  lastAgentActivity: z.number().nullable(),
});

export const ToolCallRowSchema: z.ZodType<ToolCallRow> = z.strictObject({
  toolUseId: z.string(),
  agentId: z.string().nullable(),
  name: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  batchAt: z.number().nullable(),
  outcome: z.enum(['ok', 'error', 'denied', 'interrupted']).nullable(),
  inputHash: z.string().nullable(),
  link: lwwOf(z.string()).nullable(),
  transcriptUse: z.boolean(),
  transcriptResult: z.boolean(),
});

/** The facts of a stored `facts_json` value, or null when it does not have the shape of this version. */
export function parseSessionFacts(value: unknown): SessionFacts | null {
  const parsed = SessionFactsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseAgentFacts(value: unknown): AgentFacts | null {
  const parsed = AgentFactsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseWorkflowFacts(value: unknown): WorkflowFacts | null {
  const parsed = WorkflowFactsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseToolCallRow(value: unknown): ToolCallRow | null {
  const parsed = ToolCallRowSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
