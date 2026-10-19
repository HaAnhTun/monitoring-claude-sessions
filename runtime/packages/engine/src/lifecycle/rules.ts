// Evidence rendering, view comparison and the derived inputs shared by the decision tables (02 7.1, 7.1.1, 7.4 to 7.8).
// Everything here is pure: no clock, no file, no database. Words are rendered from `at` values when they are read, so
// time passing alone never changes a stored view.
import type { EvidenceItem as ApiEvidenceItem } from '@mcs/shared';
import { toIsoTime } from '@mcs/shared';
import { compareStamp, type Stamp } from '@mcs/shared/protocol';

import type {
  AgentFacts,
  Basis,
  EvidenceFact,
  LifecycleCfg,
  LifecycleEvidence,
  LifecycleState,
  LifecycleView,
  Presence,
  SessionFacts,
  ToolCallRow,
  TurnEndInfo,
  WorkflowFacts,
} from './facts.ts';

/** `renderEvidence` output limit (registry 10.2). */
export const EVIDENCE_TEXT_MAX_CP = 120;

/** `ms = max(0, floor(ms))`; below a minute `Ns`, below an hour `Nm`, below two days `Nh`, else `Nd` (02 7.1.1). */
export function fmtAge(ms: number): string {
  const value = Math.max(0, Math.floor(ms));
  if (value < 60_000) return `${String(Math.floor(value / 1000))}s`;
  if (value < 3_600_000) return `${String(Math.floor(value / 60_000))}m`;
  if (value < 172_800_000) return `${String(Math.floor(value / 3_600_000))}h`;
  return `${String(Math.floor(value / 86_400_000))}d`;
}

interface RenderParts {
  /** ` <age> ago`, or the empty string when the item has no time. */
  readonly ago: string;
  /** The age alone, or null when the item has no time. */
  readonly age: string | null;
  readonly v: string | undefined;
  readonly c: number | undefined;
}

type Template = (parts: RenderParts) => string;

/** The exhaustive template map of 02 7.1.1: a fact without a template is a compile error. */
const TEMPLATES: Readonly<Record<EvidenceFact, Template>> = {
  session_end: ({ v, ago }) => `session ended (${v ?? 'no reason'})${ago}`,
  session_start: ({ v, ago }) => `session started (${v ?? 'startup'})${ago}`,
  stop: ({ ago }) => `turn stopped${ago}`,
  stop_failure: ({ v, ago }) => `turn failed: ${v ?? 'error'}${ago}`,
  end_turn: ({ ago }) => `assistant ended the turn${ago}`,
  interrupt: ({ ago }) => `interrupted by the user${ago}`,
  prompt: ({ ago }) => `prompt submitted${ago}`,
  tool_open: ({ v, c, age }) =>
    `tool ${v ?? 'call'} open${c !== undefined && c > 1 ? ` (${String(c)} open)` : ''}${age === null ? '' : ` for ${age}`}`,
  permission_request: ({ v, ago }) => `waiting for permission (${v ?? 'tool'})${ago}`,
  notification: ({ v, ago }) => `notification ${v ?? 'received'}${ago}`,
  registry_status: ({ v, ago }) => `registry: ${v ?? 'unknown'}${ago}`,
  job_state: ({ v, ago }) => `daemon job ${v ?? 'unknown'}${ago}`,
  attempt_row: ({ v }) => v ?? 'attempt row',
  pid_dead: ({ age }) => `process gone${age === null ? '' : ` (checked ${age} ago)`}`,
  pid_alive: ({ age }) => `process alive${age === null ? '' : ` (checked ${age} ago)`}`,
  file_written: ({ ago }) => `transcript written${ago}`,
  child_active: ({ c }) => `${String(c ?? 1)} child agent(s) active`,
  background_pending: ({ c }) => `${String(c ?? 1)} background task(s) pending`,
  agent_notification: ({ v, ago }) => `agent ${v ?? 'notified'}${ago}`,
  agent_stop: ({ ago }) => `agent stopped${ago}`,
  agent_final: ({ ago }) => `agent returned its final output${ago}`,
  agent_link: ({ v, ago }) => `agent ${v ?? 'linked'}${ago}`,
  workflow_status: ({ v, ago }) => `workflow ${v ?? 'status unknown'}${ago}`,
  quiet: ({ age }) => `quiet${age === null ? '' : ` ${age}`}`,
  no_records: () => 'no records yet',
  api_error: ({ v, ago }) => `API error${v === undefined || v === '' ? '' : ` ${v}`}${ago}`,
  activity_after_end: ({ ago }) => `activity after session end${ago}`,
  parent_ended: ({ ago }) => `parent session ended${ago}`,
};

/** The first `n` code points (never inside a surrogate pair). */
function clipCp(text: string, n: number): string {
  const points = Array.from(text);
  return points.length <= n ? text : points.slice(0, n).join('');
}

/** English words for one evidence item at `now` (02 7.1.1). Pure; never content; at most 120 code points. */
export function renderEvidence(item: LifecycleEvidence, now: number): string {
  const age = item.at === null ? null : fmtAge(now - item.at);
  const parts: RenderParts = {
    age,
    ago: age === null ? '' : ` ${age} ago`,
    v: item.value,
    c: item.count,
  };
  return clipCp(TEMPLATES[item.fact](parts), EVIDENCE_TEXT_MAX_CP);
}

/** The API form of an evidence item (registry C18): `kind` is `<source>:<fact>`, `at` an ISO time or null. */
export function toApiEvidence(item: LifecycleEvidence, now: number): ApiEvidenceItem {
  let at: string | null = null;
  if (item.at !== null && Number.isFinite(item.at)) {
    try {
      at = toIsoTime(item.at);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return { kind: `${item.source}:${item.fact}`, at, text: renderEvidence(item, now) };
}

/**
 * Has a stored field of the view changed (02 7.8)? Only these nine fields are recorded and published; evidence, `since`,
 * `evaluatedAt` and `nextCheckAt` move with time and never create churn. `null` for the previous view means "none yet".
 */
export function viewChanged(a: LifecycleView | null, b: LifecycleView): boolean {
  if (a === null) return true;
  return (
    a.state !== b.state ||
    a.presence !== b.presence ||
    a.waitReason !== b.waitReason ||
    a.staleKind !== b.staleKind ||
    a.endReason !== b.endReason ||
    a.turnOutcome !== b.turnOutcome ||
    a.basis !== b.basis ||
    a.confidence !== b.confidence ||
    a.ruleId !== b.ruleId
  );
}

// ---- derived inputs (02 7.4 to 7.6) ---------------------------------------------------------------------------------
//
// The decision tables, `nextCheckAt` and the sweeper all need the same derived values (`lastEvidence`, `inTurn`,
// `openTools`, ...). They are computed once here so that the tables and the time thresholds cannot drift apart.

/** What the session table needs to know of one agent of the session (its derived view and two times). */
export interface AgentSummary {
  readonly agentId: string;
  readonly state: LifecycleState;
  readonly basis: Basis;
  readonly lastActivityAt: number | null;
  readonly fileMtime: number | null;
  /** The agent's own `nextCheckAt`: the session is re-derived when it changes state. */
  readonly nextCheckAt: number | null;
  readonly workflowRunId: string | null;
}

export interface WorkflowSummary {
  readonly runId: string;
  readonly state: LifecycleState;
  readonly basis: Basis;
  readonly lastAgentActivity: number | null;
  readonly nextCheckAt: number | null;
}

/** The related rows `deriveSession` reads (02 7.2 "related rows"). */
export interface SessionRows {
  /** `tool_call` rows of the session; the rows of the main agent (`agentId` null) are the session's tools. */
  readonly tools: readonly ToolCallRow[];
  readonly agents: readonly AgentSummary[];
  readonly workflows: readonly WorkflowSummary[];
  /**
   * The main transcript file of the session ends in a cost-state record (`cost_states.is_trailing`): with no live pid and no
   * live registry entry S-8e says the process ended (inferred, CHALLENGES C2). A row-level input and not a fact, so that a
   * later record can clear it (CR-WP-28-2). Absent = not set.
   */
  readonly costStateTrailing?: boolean;
}

/** A turn boundary: a Stop / StopFailure hook, a transcript end_turn / turn_duration, or an interrupt marker. */
export interface TurnBoundary {
  readonly stamp: Stamp;
  readonly kind: TurnEndInfo['kind'] | 'interrupted';
  readonly info: TurnEndInfo | null;
}

export interface SessionSignals {
  readonly now: number;
  /** Newest time of any evidence about the session or its children; null when there is none. */
  readonly lastEvidence: number | null;
  /** `now - lastEvidence` in ms, never negative; infinite without evidence. */
  readonly quiet: number;
  readonly hookPath: boolean;
  /** The prompt of the current or last turn. */
  readonly prompt: Stamp | null;
  /** The end of the last turn: the later of the turn end and an interrupt. */
  readonly turnEnd: TurnBoundary | null;
  readonly inTurn: boolean;
  /** Open tool calls of the main agent in the current turn, oldest first. */
  readonly openTools: readonly ToolCallRow[];
  readonly openPermission: { readonly requested: Stamp } | null;
  readonly blockingNotification: { readonly type: string; readonly stamp: Stamp } | null;
  readonly registryLive: boolean;
  readonly pidDead: boolean;
  readonly pidAlive: boolean;
  readonly childrenActive: number;
  /** At least one active child is observed (hooks, journal), not only seen through file activity. */
  readonly childrenObserved: boolean;
  readonly pendingAtEnd: number;
  readonly unrecoveredApiError: boolean;
  readonly reopened: boolean;
  readonly ended: boolean;
  /** The job fact is older than later activity (`isJobSuperseded`): S-4a and S-4b are skipped. */
  readonly jobSuperseded: boolean;
  /** `SessionRows.costStateTrailing`. */
  readonly costStateTrailing: boolean;
}

const ACTIVE_CHILD_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  'working',
  'waiting_tool',
  'running',
]);

/** Types of Notification that block on a human (02 7.4 `blockingNotif`). */
export const BLOCKING_NOTIFICATION_TYPES = [
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
] as const;

export function msOf(seconds: number): number {
  return seconds * 1000;
}

export function maxOf(values: readonly (number | null | undefined)[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

function byStartThenId(a: ToolCallRow, b: ToolCallRow): number {
  const byStart = (a.startedAt ?? 0) - (b.startedAt ?? 0);
  if (byStart !== 0) return byStart;
  return a.toolUseId < b.toolUseId ? -1 : a.toolUseId > b.toolUseId ? 1 : 0;
}

/** `reopened` of 02 7.4: activity later than the SessionEnd by more than the tolerance (writes `activity_after_end`). */
export function isReopened(facts: SessionFacts, cfg: LifecycleCfg): boolean {
  return (
    facts.end !== null &&
    facts.lastActivity !== null &&
    facts.lastActivity.at > facts.end.stamp.at + cfg.reopenToleranceMs
  );
}

/**
 * A daemon job fact is superseded by later activity (ADR 0069 item 4), the counterpart of `isReopened` for S-4: the newest
 * of `lastActivity` and `lastHookAt` is later than the stamp of the job fact by more than `reopenToleranceMs`. Facts only, so
 * S-4a stays time invariant. The single implementation: the session table and `explainCompletion` both call it.
 */
export function isJobSuperseded(facts: SessionFacts, cfg: LifecycleCfg): boolean {
  if (facts.job === null) return false;
  const newest = maxOf([facts.lastActivity?.at, facts.lastHookAt]);
  return newest !== null && newest > facts.job.stamp.at + cfg.reopenToleranceMs;
}

/** Resolution time of the permission request with this input hash: the facts and the tool rows that ended or were batched. */
function resolvedAt(hash: string, facts: SessionFacts, tools: readonly ToolCallRow[]): number | null {
  const stored = Object.hasOwn(facts.permissions, hash) ? facts.permissions[hash] : undefined;
  let best = stored?.resolved?.at ?? null;
  for (const row of tools) {
    if (row.inputHash !== hash) continue;
    best = maxOf([best, row.endedAt, row.batchAt]);
  }
  return best;
}

export function sessionSignals(facts: SessionFacts, rows: SessionRows, now: number, cfg: LifecycleCfg): SessionSignals {
  const tol = cfg.crossSourceToleranceMs;
  const lastEvidence = maxOf([
    facts.lastHookAt,
    facts.lastActivity?.at,
    facts.transcriptMtime,
    ...rows.agents.flatMap((agent) => [agent.lastActivityAt, agent.fileMtime]),
    ...rows.workflows.map((run) => run.lastAgentActivity),
  ]);
  const quiet = lastEvidence === null ? Number.POSITIVE_INFINITY : Math.max(0, now - lastEvidence);

  const hookTurnAt = maxOf([facts.lastPromptHook?.at, facts.lastTurnEndHook?.stamp.at]);
  const txTurnAt = maxOf([facts.lastPromptTx?.at, facts.lastTurnEndTx?.stamp.at]);
  const hookPath =
    facts.lastPromptHook !== null && hookTurnAt !== null && (txTurnAt === null || hookTurnAt >= txTurnAt - tol);
  const prompt = hookPath ? facts.lastPromptHook : facts.lastPromptTx;
  const endRegister = hookPath ? facts.lastTurnEndHook : facts.lastTurnEndTx;
  const endBoundary: TurnBoundary | null =
    endRegister === null ? null : { stamp: endRegister.stamp, kind: endRegister.value.kind, info: endRegister.value };
  const interrupt: TurnBoundary | null =
    facts.lastInterrupt === null ? null : { stamp: facts.lastInterrupt, kind: 'interrupted', info: null };
  let turnEnd: TurnBoundary | null = endBoundary;
  if (interrupt !== null && (endBoundary === null || compareStamp(interrupt.stamp, endBoundary.stamp) > 0)) {
    turnEnd = interrupt;
  }
  const inTurn = prompt !== null && (turnEnd === null || compareStamp(prompt, turnEnd.stamp) > 0);

  const mainTools = rows.tools.filter((row) => row.agentId === null);
  const openTools = inTurn
    ? mainTools
        .filter(
          (row) =>
            row.endedAt === null && row.batchAt === null && row.startedAt !== null && row.startedAt >= prompt.at - tol,
        )
        .sort(byStartThenId)
    : [];

  let openPermission: SessionSignals['openPermission'] = null;
  if (inTurn) {
    for (const [hash, permission] of Object.entries(facts.permissions)) {
      const requested = permission.requested;
      if (requested === null || requested.at < prompt.at - tol) continue;
      const resolved = resolvedAt(hash, facts, rows.tools);
      if (resolved !== null && resolved >= requested.at) continue;
      if (openPermission === null || compareStamp(requested, openPermission.requested) > 0)
        openPermission = { requested };
    }
  }

  let blockingNotification: SessionSignals['blockingNotification'] = null;
  for (const type of BLOCKING_NOTIFICATION_TYPES) {
    const stamp = Object.hasOwn(facts.notifications, type) ? facts.notifications[type] : undefined;
    if (stamp === undefined) continue;
    if (facts.lastActivity !== null && compareStamp(stamp, facts.lastActivity) <= 0) continue;
    if (blockingNotification === null || compareStamp(stamp, blockingNotification.stamp) > 0) {
      blockingNotification = { type, stamp };
    }
  }

  const registryLive =
    facts.registry !== null && facts.registry.value.pidAlive && now - facts.registry.stamp.at <= 2 * cfg.registryPollMs;
  const activeAgents = rows.agents.filter((agent) => ACTIVE_CHILD_STATES.has(agent.state));
  const activeRuns = rows.workflows.filter((run) => run.state === 'running');

  let pendingAtEnd = 0;
  for (const register of [facts.lastTurnEndHook, facts.lastTurnEndTx]) {
    if (register === null) continue;
    if (prompt !== null && compareStamp(register.stamp, prompt) < 0) continue;
    const info = register.value;
    pendingAtEnd = Math.max(
      pendingAtEnd,
      info.backgroundTasks ?? 0,
      (info.pendingBackgroundAgents ?? 0) + (info.pendingWorkflows ?? 0),
    );
  }

  const reopened = isReopened(facts, cfg);
  return {
    now,
    lastEvidence,
    quiet,
    hookPath,
    prompt,
    turnEnd,
    inTurn,
    openTools,
    openPermission,
    blockingNotification,
    registryLive,
    pidDead: facts.pid?.value.alive === false,
    pidAlive: facts.pid?.value.alive === true,
    childrenActive: activeAgents.length + activeRuns.length,
    childrenObserved:
      activeAgents.some((agent) => agent.basis === 'observed') || activeRuns.some((run) => run.basis === 'observed'),
    pendingAtEnd,
    unrecoveredApiError:
      facts.lastApiError !== null &&
      (facts.lastAssistantOk === null || compareStamp(facts.lastApiError, facts.lastAssistantOk) > 0),
    reopened,
    ended: facts.end !== null && !reopened,
    jobSuperseded: isJobSuperseded(facts, cfg),
    costStateTrailing: rows.costStateTrailing === true,
  };
}

// ---- agents and workflow runs -----------------------------------------------------------------------------------------

export interface AgentRows {
  /** Tool rows of this agent (`agentId` equal to the agent). */
  readonly tools: readonly ToolCallRow[];
  /** Presence of the parent session's view. */
  readonly parentPresence: Presence;
}

export interface AgentSignals {
  readonly now: number;
  /** max(stopped, final, notification): the end of the current episode. */
  readonly episodeEnd: number | null;
  /** SubagentStart fired again after the episode ended (resume, HK:1). */
  readonly reopened: boolean;
  /** The current episode has started and not ended. */
  readonly openEpisode: boolean;
  readonly lastEvidence: number | null;
  readonly quiet: number;
  /** max(lastActivity, fileMtime). */
  readonly recentActivity: number | null;
  readonly openTools: readonly ToolCallRow[];
}

export function agentSignals(facts: AgentFacts, rows: AgentRows, now: number, cfg: LifecycleCfg): AgentSignals {
  const episodeEnd = maxOf([facts.stopped?.at, facts.final?.at, facts.notification?.stamp.at]);
  const reopened =
    facts.started !== null && episodeEnd !== null && facts.started.at > episodeEnd + cfg.crossSourceToleranceMs;
  const lastEvidence = maxOf([
    facts.lastActivity?.at,
    facts.fileMtime,
    facts.started?.at,
    episodeEnd,
    facts.lastTurnEnd?.stamp.at,
    facts.lastPrompt?.at,
  ]);
  const openTools = rows.tools
    .filter((row) => row.endedAt === null && row.batchAt === null && row.startedAt !== null)
    .sort(byStartThenId);
  return {
    now,
    episodeEnd,
    reopened,
    openEpisode: facts.started !== null && (episodeEnd === null || reopened),
    lastEvidence,
    quiet: lastEvidence === null ? Number.POSITIVE_INFINITY : Math.max(0, now - lastEvidence),
    recentActivity: maxOf([facts.lastActivity?.at, facts.fileMtime]),
    openTools,
  };
}

export interface WorkflowRows {
  readonly parentPresence: Presence;
  /** Summaries of the agents of this run. */
  readonly agents: readonly AgentSummary[];
}

export interface WorkflowSignals {
  readonly now: number;
  /** An agent of the run is working or waiting for a tool. */
  readonly agentBusy: boolean;
  /** max(launched, lastAgentActivity). */
  readonly lastEvidence: number | null;
  readonly lastAgentActivity: number | null;
}

export function workflowSignals(facts: WorkflowFacts, rows: WorkflowRows, now: number): WorkflowSignals {
  const lastAgentActivity = maxOf([
    facts.lastAgentActivity,
    ...rows.agents.flatMap((agent) => [agent.lastActivityAt, agent.fileMtime]),
  ]);
  return {
    now,
    agentBusy: rows.agents.some((agent) => agent.state === 'working' || agent.state === 'waiting_tool'),
    lastEvidence: maxOf([facts.launched?.at, lastAgentActivity]),
    lastAgentActivity,
  };
}

// ---- building views -----------------------------------------------------------------------------------------------

/** Evidence item builder: optional fields are only present when given. */
export function ev(
  source: LifecycleEvidence['source'],
  fact: EvidenceFact,
  at: number | null,
  extra: { readonly value?: string; readonly count?: number } = {},
): LifecycleEvidence {
  return {
    source,
    fact,
    at,
    ...(extra.count === undefined ? {} : { count: extra.count }),
    ...(extra.value === undefined ? {} : { value: extra.value }),
  };
}

/** The most items a view keeps (02 7.1). */
export const EVIDENCE_MAX = 8;

/** What every decision sets; the rest of the view is null. */
export interface Decision {
  readonly ruleId: string;
  readonly state: LifecycleState;
  readonly presence: Presence;
  readonly basis: Basis;
  readonly confidence: LifecycleView['confidence'];
  readonly evidence: readonly LifecycleEvidence[];
  readonly waitReason?: LifecycleView['waitReason'];
  readonly staleKind?: LifecycleView['staleKind'];
  readonly endReason?: string;
  readonly turnOutcome?: LifecycleView['turnOutcome'];
}

/** Turns a decision into a view: `since` is the time of the first evidence item, at most eight items are kept. */
export function viewOf(decision: Decision, now: number, nextCheckAt: number | null): LifecycleView {
  const evidence = decision.evidence.slice(0, EVIDENCE_MAX);
  return {
    state: decision.state,
    presence: decision.presence,
    waitReason: decision.waitReason ?? null,
    staleKind: decision.staleKind ?? null,
    endReason: decision.endReason ?? null,
    turnOutcome: decision.turnOutcome ?? null,
    basis: decision.basis,
    confidence: decision.confidence,
    ruleId: decision.ruleId,
    evidence,
    since: evidence[0]?.at ?? null,
    evaluatedAt: now,
    nextCheckAt,
  };
}
