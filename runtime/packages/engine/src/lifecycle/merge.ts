// Joins of the fact registers (02 7.2, ADR 0018) and the in-memory model that folds events into facts and rows.
//
// Every join is commutative, associative and idempotent, so a model built from any permutation or duplication of the
// same events is the same model (properties P1 to P3). The model is the reference of what the ingest writer does with
// repositories: facts per session, agent and workflow run, plus the `tool_call` rows and two small side tables that join
// facts which name each other by id (the spawn call of an agent, the task notification that cites it).
import { compareStamp, type Stamp } from '@mcs/shared/protocol';

import type { LogicalEvent } from '../ingest/event-row.ts';
import {
  AGENT_KINDS,
  JOURNAL_STATES,
  START_SOURCES,
  agentFactsOfEvent,
  emptyAgentFacts,
  emptySessionFacts,
  emptyWorkflowFacts,
  sessionFactsOfEvent,
  toolRowsOfEvent,
  workflowFactsOfEvent,
  type AgentFacts,
  type AgentNotificationStatus,
  type EventOrigin,
  type Lww,
  type PermissionFact,
  type SessionFacts,
  type StartSource,
  type ToolCallRow,
  type WorkflowFacts,
} from './facts.ts';

export type { EventOrigin };

/**
 * How many permission requests a session keeps (02 7.2): the newest by `requested`. The join stays commutative and
 * idempotent at any size; it is associative while a session has at most this many distinct input hashes (a dropped hash
 * that is later requested again starts from an empty `resolved`), which a turn never reaches.
 */
export const PERMISSIONS_KEPT = 64;

// ---- registers --------------------------------------------------------------------------------------------------

/** Max of two stamps; null is the neutral element. */
export function joinStamp(a: Stamp | null, b: Stamp | null): Stamp | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareStamp(a, b) >= 0 ? a : b;
}

/** Last-writer-wins by stamp; equal stamps tie-break on the JSON of the value so the join stays deterministic. */
export function joinLww<T>(a: Lww<T> | null, b: Lww<T> | null): Lww<T> | null {
  if (a === null) return b;
  if (b === null) return a;
  const order = compareStamp(a.stamp, b.stamp);
  if (order > 0) return a;
  if (order < 0) return b;
  return JSON.stringify(a.value) >= JSON.stringify(b.value) ? a : b;
}

function maxNumber(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function minNumber(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maxString(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

function minString(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

/** Own-property read: a hostile key such as `__proto__` never reaches the prototype. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Pointwise join of two records; the result has its keys in sorted order and only own properties. */
function joinRecord<T>(
  a: Readonly<Record<string, T>>,
  b: Readonly<Record<string, T>>,
  join: (x: T, y: T) => T,
): Record<string, T> {
  const merged = new Map<string, T>();
  for (const [key, value] of Object.entries(a)) merged.set(key, value);
  for (const [key, value] of Object.entries(b)) {
    const existing = merged.get(key);
    merged.set(key, existing === undefined ? value : join(existing, value));
  }
  return Object.fromEntries([...merged.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

function joinPermission(a: PermissionFact, b: PermissionFact): PermissionFact {
  return { requested: joinStamp(a.requested, b.requested), resolved: joinStamp(a.resolved, b.resolved) };
}

/** The `PERMISSIONS_KEPT` newest requests (by `requested`, a request never made counts as oldest, then by key). */
function capPermissions(permissions: Record<string, PermissionFact>): Record<string, PermissionFact> {
  const entries = Object.entries(permissions);
  if (entries.length <= PERMISSIONS_KEPT) return permissions;
  entries.sort(([ka, a], [kb, b]) => {
    if (a.requested === null && b.requested === null) return ka < kb ? -1 : ka > kb ? 1 : 0;
    if (a.requested === null) return 1;
    if (b.requested === null) return -1;
    const order = compareStamp(b.requested, a.requested);
    return order !== 0 ? order : ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return Object.fromEntries(entries.slice(0, PERMISSIONS_KEPT).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

function joinStarts(a: SessionFacts['starts'], b: SessionFacts['starts']): Partial<Record<StartSource, Stamp>> {
  const out: Partial<Record<StartSource, Stamp>> = {};
  for (const source of START_SOURCES) {
    const joined = joinStamp(a[source] ?? null, b[source] ?? null);
    if (joined !== null) out[source] = joined;
  }
  return out;
}

// ---- facts ------------------------------------------------------------------------------------------------------

/** Join of two fact sets of one session (02 7.2). */
export function mergeSessionFacts(a: SessionFacts, b: SessionFacts): SessionFacts {
  return {
    v: 1,
    firstSeenAt: minNumber(a.firstSeenAt, b.firstSeenAt),
    lastHookAt: maxNumber(a.lastHookAt, b.lastHookAt),
    hasRecords: a.hasRecords || b.hasRecords,
    transcriptMtime: maxNumber(a.transcriptMtime, b.transcriptMtime),
    lastActivity: joinStamp(a.lastActivity, b.lastActivity),
    lastPromptHook: joinStamp(a.lastPromptHook, b.lastPromptHook),
    lastPromptTx: joinStamp(a.lastPromptTx, b.lastPromptTx),
    lastTurnEndHook: joinLww(a.lastTurnEndHook, b.lastTurnEndHook),
    lastTurnEndTx: joinLww(a.lastTurnEndTx, b.lastTurnEndTx),
    lastInterrupt: joinStamp(a.lastInterrupt, b.lastInterrupt),
    starts: joinStarts(a.starts, b.starts),
    end: joinEnd(a.end, b.end),
    permissions: capPermissions(joinRecord(a.permissions, b.permissions, joinPermission)),
    notifications: joinRecord(a.notifications, b.notifications, (x, y) => joinStamp(x, y) ?? x),
    lastApiError: joinStamp(a.lastApiError, b.lastApiError),
    lastAssistantOk: joinStamp(a.lastAssistantOk, b.lastAssistantOk),
    claudePid: joinLww(a.claudePid, b.claudePid),
    pid: joinLww(a.pid, b.pid),
    registry: joinLww(a.registry, b.registry),
    job: joinLww(a.job, b.job),
    attempt: joinLww(a.attempt, b.attempt),
    costStateTrailing: joinLww(a.costStateTrailing, b.costStateTrailing),
    hookHandlerErrors: Math.max(a.hookHandlerErrors, b.hookHandlerErrors),
    legacy: {
      lastStop: joinLww(a.legacy.lastStop, b.legacy.lastStop),
      fileFirstTs: minString(a.legacy.fileFirstTs, b.legacy.fileFirstTs),
      fileMaxTs: maxString(a.legacy.fileMaxTs, b.legacy.fileMaxTs),
    },
  };
}

/** Registry name `mergeFacts` (98 2.5): the join of two session fact sets. */
export const mergeFacts = mergeSessionFacts;

function joinEnd(a: SessionFacts['end'], b: SessionFacts['end']): SessionFacts['end'] {
  if (a === null) return b;
  if (b === null) return a;
  const order = compareStamp(a.stamp, b.stamp);
  if (order > 0) return a;
  if (order < 0) return b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function rankOf<T extends string>(order: readonly T[], value: T | null): number {
  return value === null ? -1 : order.indexOf(value);
}

/** Join of two fact sets of one non-main agent. */
export function mergeAgentFacts(a: AgentFacts, b: AgentFacts): AgentFacts {
  const journal = rankOf(JOURNAL_STATES, a.journal) >= rankOf(JOURNAL_STATES, b.journal) ? a.journal : b.journal;
  const kind = rankOf(AGENT_KINDS, a.kind) >= rankOf(AGENT_KINDS, b.kind) ? a.kind : b.kind;
  return {
    v: 1,
    kind,
    started: joinStamp(a.started, b.started),
    stopped: joinStamp(a.stopped, b.stopped),
    final: joinStamp(a.final, b.final),
    notification: joinLww(a.notification, b.notification),
    link: joinLww(a.link, b.link),
    journal,
    lastActivity: joinStamp(a.lastActivity, b.lastActivity),
    fileMtime: maxNumber(a.fileMtime, b.fileMtime),
    hasRecords: a.hasRecords || b.hasRecords,
    lastTurnEnd: joinLww(a.lastTurnEnd, b.lastTurnEnd),
    lastPrompt: joinStamp(a.lastPrompt, b.lastPrompt),
    lastApiError: joinStamp(a.lastApiError, b.lastApiError),
    lastAssistantOk: joinStamp(a.lastAssistantOk, b.lastAssistantOk),
    legacy: { lastStop: joinLww(a.legacy.lastStop, b.legacy.lastStop) },
  };
}

/** Join of two fact sets of one workflow run. */
export function mergeWorkflowFacts(a: WorkflowFacts, b: WorkflowFacts): WorkflowFacts {
  return {
    v: 1,
    launched: joinStamp(a.launched, b.launched),
    fileStatus: joinLww(a.fileStatus, b.fileStatus),
    started: Math.max(a.started, b.started),
    results: Math.max(a.results, b.results),
    failed: Math.max(a.failed, b.failed),
    agentCount: maxNumber(a.agentCount, b.agentCount),
    lastAgentActivity: maxNumber(a.lastAgentActivity, b.lastAgentActivity),
  };
}

const OUTCOME_ORDER = ['ok', 'interrupted', 'denied', 'error'] as const;

function joinOutcome(a: ToolCallRow['outcome'], b: ToolCallRow['outcome']): ToolCallRow['outcome'] {
  if (a === null) return b;
  if (b === null) return a;
  return OUTCOME_ORDER.indexOf(a) >= OUTCOME_ORDER.indexOf(b) ? a : b;
}

/** A name that carries information beats the `unknown` placeholder; otherwise the smaller string, deterministically. */
function joinName(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return a <= b ? a : b;
}

/** Join of two deliveries about the same `tool_use_id` (02 4.1). */
export function mergeToolCallRow(a: ToolCallRow, b: ToolCallRow): ToolCallRow {
  return {
    toolUseId: a.toolUseId,
    agentId: minString(a.agentId, b.agentId),
    name: joinName(a.name, b.name),
    startedAt: minNumber(a.startedAt, b.startedAt),
    endedAt: maxNumber(a.endedAt, b.endedAt),
    batchAt: maxNumber(a.batchAt, b.batchAt),
    outcome: joinOutcome(a.outcome, b.outcome),
    inputHash: minString(a.inputHash, b.inputHash),
    link: joinLww(a.link, b.link),
    transcriptUse: a.transcriptUse || b.transcriptUse,
    transcriptResult: a.transcriptResult || b.transcriptResult,
  };
}

// ---- the model --------------------------------------------------------------------------------------------------

/**
 * The state one session needs to be derived: its facts, its tool rows, the facts of its agents and workflow runs and
 * the two id tables that join facts naming each other. Immutable: every function returns a new model.
 */
export interface LifecycleModel {
  readonly session: SessionFacts;
  readonly tools: Readonly<Record<string, ToolCallRow>>;
  readonly agents: Readonly<Record<string, AgentFacts>>;
  readonly workflows: Readonly<Record<string, WorkflowFacts>>;
  /** Spawn tool_use_id -> agent id (the `agent.link` and the `agent.meta` of the agent); the smaller id on a conflict. */
  readonly spawns: Readonly<Record<string, string>>;
  /** Agent id -> workflow run id (`agent.meta`). */
  readonly agentRuns: Readonly<Record<string, string>>;
  /** Task notifications by the spawn tool_use_id they cite, waiting to be joined to their agent. */
  readonly notifications: Readonly<Record<string, Lww<AgentNotificationStatus>>>;
}

export function emptyModel(): LifecycleModel {
  return {
    session: emptySessionFacts(),
    tools: {},
    agents: {},
    workflows: {},
    spawns: {},
    agentRuns: {},
    notifications: {},
  };
}

function putJoin<T>(
  record: Readonly<Record<string, T>>,
  key: string,
  value: T,
  join: (a: T, b: T) => T,
): Record<string, T> {
  return joinRecord(record, { [key]: value }, join);
}

function smallerString(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Folds one event into the model: the join of the model with what the event says (02 7.3). */
export function applyEvent(model: LifecycleModel, event: LogicalEvent, origin: EventOrigin): LifecycleModel {
  let next: LifecycleModel = model;

  const sessionDelta = sessionFactsOfEvent(event, origin);
  if (sessionDelta !== null) next = { ...next, session: mergeSessionFacts(next.session, sessionDelta) };

  for (const row of toolRowsOfEvent(event, origin)) {
    next = { ...next, tools: putJoin(next.tools, row.toolUseId, row, mergeToolCallRow) };
  }

  const agentDelta = agentFactsOfEvent(event, origin);
  if (agentDelta !== null) {
    next = { ...next, agents: putJoin(next.agents, agentDelta.agentId, agentDelta.facts, mergeAgentFacts) };
  }

  if (event.k === 'agent.link') {
    next = { ...next, spawns: putJoin(next.spawns, event.toolUseId, event.agentId, smallerString) };
  } else if (event.k === 'agent.meta') {
    if (event.spawnToolUseId !== undefined) {
      next = { ...next, spawns: putJoin(next.spawns, event.spawnToolUseId, event.agentId, smallerString) };
    }
    if (event.workflowRunId !== undefined) {
      next = { ...next, agentRuns: putJoin(next.agentRuns, event.agentId, event.workflowRunId, smallerString) };
    }
  } else if (event.k === 'agent.notification' && event.toolUseId !== null && event.status !== null) {
    next = {
      ...next,
      notifications: putJoin(
        next.notifications,
        event.toolUseId,
        { stamp: event.stamp, value: event.status } satisfies Lww<AgentNotificationStatus>,
        (a, b) => joinLww(a, b) ?? a,
      ),
    };
  }

  const workflowDelta = workflowFactsOfEvent(event);
  if (workflowDelta !== null) {
    next = {
      ...next,
      workflows: putJoin(next.workflows, workflowDelta.runId, workflowDelta.facts, mergeWorkflowFacts),
    };
  }
  return next;
}

/** Join of two models of the same session (for example the committed model and a working copy). */
export function mergeModels(a: LifecycleModel, b: LifecycleModel): LifecycleModel {
  return {
    session: mergeSessionFacts(a.session, b.session),
    tools: joinRecord(a.tools, b.tools, mergeToolCallRow),
    agents: joinRecord(a.agents, b.agents, mergeAgentFacts),
    workflows: joinRecord(a.workflows, b.workflows, mergeWorkflowFacts),
    spawns: joinRecord(a.spawns, b.spawns, smallerString),
    agentRuns: joinRecord(a.agentRuns, b.agentRuns, smallerString),
    notifications: joinRecord(a.notifications, b.notifications, (x, y) => joinLww(x, y) ?? x),
  };
}

/**
 * The facts of one agent as `derive` reads them: the stored facts, the kind raised to `workflow_agent` when the agent
 * belongs to a run, and the task notification that cites the agent's spawn call (joined here because the notification
 * names the call and the link names the agent, and either may arrive first).
 */
export function agentFactsOf(model: LifecycleModel, agentId: string): AgentFacts {
  const stored = own(model.agents, agentId) ?? emptyAgentFacts();
  let notification = stored.notification;
  for (const [toolUseId, spawned] of Object.entries(model.spawns)) {
    if (spawned !== agentId) continue;
    const cited = own(model.notifications, toolUseId);
    if (cited !== undefined) notification = joinLww(notification, cited);
  }
  const inRun = own(model.agentRuns, agentId) !== undefined;
  return mergeAgentFacts({ ...stored, notification }, inRun ? emptyAgentFacts('workflow_agent') : emptyAgentFacts());
}

/**
 * The facts of one workflow run as `derive` reads them: the stored facts, the newest activity of the agents of the run
 * and the number of agents seen for it.
 */
export function workflowFactsOf(model: LifecycleModel, runId: string): WorkflowFacts {
  const stored = own(model.workflows, runId) ?? emptyWorkflowFacts();
  let activity: number | null = null;
  let count = 0;
  for (const [agentId, run] of Object.entries(model.agentRuns)) {
    if (run !== runId) continue;
    const facts = agentFactsOf(model, agentId);
    count += 1;
    activity = maxNumber(activity, maxNumber(facts.lastActivity?.at ?? null, facts.fileMtime));
  }
  return {
    ...stored,
    agentCount: count === 0 ? stored.agentCount : maxNumber(stored.agentCount, count),
    lastAgentActivity: maxNumber(stored.lastAgentActivity, activity),
  };
}
