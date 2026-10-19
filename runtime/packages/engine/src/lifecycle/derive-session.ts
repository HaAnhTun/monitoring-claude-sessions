// The session decision table (02 7.4, rules S-1 to S-10, ADR 0018): `deriveSession` is a pure function of the facts, the
// related rows, the time and the thresholds. First matching rule wins. COMPLETED / FAILED come only from SessionEnd, a
// daemon job, or an attempts row; Stop is not SessionEnd; a dead process is `stale`, never `completed`; missing events
// never imply success.
import { compareStamp } from '@mcs/shared/protocol';

import type { LifecycleModel } from './merge.ts';
import { agentFactsOf, workflowFactsOf } from './merge.ts';
import { deriveAgent } from './derive-agent.ts';
import { deriveWorkflow } from './derive-workflow.ts';
import type {
  LifecycleCfg,
  LifecycleEvidence,
  LifecycleView,
  Presence,
  SessionFacts,
  ToolCallRow,
  WaitReason,
} from './facts.ts';
import { sessionNextCheck } from './next-check.ts';
import {
  ev,
  isReopened,
  msOf,
  sessionSignals,
  viewOf,
  type AgentSummary,
  type Decision,
  type SessionRows,
  type SessionSignals,
  type TurnBoundary,
  type WorkflowSummary,
} from './rules.ts';

export { isReopened };

/** The job states that fail a session (S-4b); `done` completes it (S-4a). */
export const JOB_FAILED_STATES: ReadonlySet<string> = new Set(['failed', 'error', 'killed', 'cancelled']);

function waitReasonOfNotification(type: string): WaitReason {
  switch (type) {
    case 'permission_prompt':
      return 'permission';
    case 'agent_needs_input':
      return 'agent_input';
    default:
      return 'elicitation';
  }
}

/** The evidence item that names how a turn ended. */
function turnEndEvidence(boundary: TurnBoundary): LifecycleEvidence {
  switch (boundary.kind) {
    case 'stop':
      return ev('hook', 'stop', boundary.stamp.at);
    case 'stop_failure': {
      const error = boundary.info?.error;
      return ev('hook', 'stop_failure', boundary.stamp.at, typeof error === 'string' ? { value: error } : {});
    }
    case 'end_turn':
    case 'turn_duration':
      return ev('transcript', 'end_turn', boundary.stamp.at);
    case 'interrupted':
      return ev('transcript', 'interrupt', boundary.stamp.at);
  }
}

function decideSession(facts: SessionFacts, s: SessionSignals, cfg: LifecycleCfg): Decision {
  const activeMs = msOf(cfg.activeSeconds);
  const graceMs = msOf(cfg.pendingToolGraceSeconds);
  const staleMs = msOf(cfg.staleAfterSeconds);
  const abandonedMs = msOf(cfg.abandonedAfterSeconds);
  const now = s.now;
  const turnSource = s.hookPath ? 'hook' : 'transcript';
  const quiet = ev('clock', 'quiet', s.lastEvidence);
  const attempt = facts.attempt?.value ?? null;
  const registry = facts.registry?.value ?? null;
  // a job fact older than later activity is ignored (ADR 0069 item 4)
  const job = s.jobSuperseded ? null : (facts.job?.value ?? null);

  // S-1: attempts evidence (a register holding null is a retraction, 7.3)
  if (attempt !== null) {
    const state = attempt.state === 'COMPLETED' ? 'completed' : attempt.state === 'FAILED' ? 'failed' : 'unknown';
    return {
      ruleId: 'S-1',
      state,
      presence: 'ended',
      basis: 'observed',
      confidence: 'high',
      endReason: attempt.state.toLowerCase(),
      evidence: [ev('attempts', 'attempt_row', attempt.endedAt, { value: attempt.evidence })],
    };
  }
  // S-2: nothing is known about the session
  if (facts.lastHookAt === null && !facts.hasRecords) {
    return {
      ruleId: 'S-2',
      state: 'unknown',
      presence: 'unknown',
      basis: 'inferred',
      confidence: 'low',
      evidence: [ev('transcript', 'no_records', null)],
    };
  }
  // S-3: SessionEnd
  if (facts.end !== null && s.ended) {
    const sessionEnd = ev('hook', 'session_end', facts.end.stamp.at, { value: facts.end.reason });
    if (s.turnEnd?.kind === 'stop_failure') {
      return {
        ruleId: 'S-3a',
        state: 'failed',
        presence: 'ended',
        basis: 'observed',
        confidence: 'medium',
        endReason: facts.end.reason,
        evidence: [sessionEnd, turnEndEvidence(s.turnEnd)],
      };
    }
    if (s.unrecoveredApiError && facts.lastApiError !== null) {
      return {
        ruleId: 'S-3a',
        state: 'failed',
        presence: 'ended',
        basis: 'observed',
        confidence: 'medium',
        endReason: facts.end.reason,
        evidence: [sessionEnd, ev('transcript', 'api_error', facts.lastApiError.at)],
      };
    }
    return {
      ruleId: 'S-3b',
      state: 'completed',
      presence: 'ended',
      basis: 'observed',
      confidence: 'high',
      endReason: facts.end.reason,
      evidence: [sessionEnd],
    };
  }
  // S-4: daemon job state
  if (job !== null) {
    const evidence = [ev('job', 'job_state', facts.job?.stamp.at ?? null, { value: job.state })];
    if (job.state === 'done') {
      return {
        ruleId: 'S-4a',
        state: 'completed',
        presence: 'ended',
        basis: 'observed',
        confidence: 'high',
        endReason: job.state,
        evidence,
      };
    }
    if (JOB_FAILED_STATES.has(job.state)) {
      return {
        ruleId: 'S-4b',
        state: 'failed',
        presence: 'ended',
        basis: 'observed',
        confidence: 'high',
        endReason: job.state,
        evidence,
      };
    }
  }
  // S-5: the Claude process is gone without a SessionEnd
  if (s.pidDead && s.quiet >= msOf(cfg.processGoneGraceSeconds)) {
    return {
      ruleId: 'S-5',
      state: 'stale',
      staleKind: 'process_gone',
      presence: 'ended',
      basis: 'inferred',
      confidence: 'high',
      evidence: [ev('pid', 'pid_dead', facts.pid?.stamp.at ?? null), quiet],
    };
  }
  // S-6: a human is expected
  if (s.inTurn && s.openPermission !== null) {
    return {
      ruleId: 'S-6a',
      state: 'waiting_input',
      waitReason: 'permission',
      presence: 'open',
      basis: 'observed',
      confidence: 'high',
      evidence: [ev('hook', 'permission_request', s.openPermission.requested.at)],
    };
  }
  if (s.registryLive && registry?.status === 'waiting') {
    return {
      ruleId: 'S-6b',
      state: 'waiting_input',
      waitReason: registry.waitingFor?.includes('permission') === true ? 'permission' : 'user',
      presence: 'open',
      basis: 'observed',
      confidence: 'high',
      evidence: [ev('registry', 'registry_status', facts.registry?.stamp.at ?? null, { value: 'waiting' })],
    };
  }
  const blocking = s.blockingNotification;
  if (blocking !== null && (s.inTurn || s.turnEnd === null || compareStamp(blocking.stamp, s.turnEnd.stamp) > 0)) {
    return {
      ruleId: 'S-6c',
      state: 'waiting_input',
      waitReason: waitReasonOfNotification(blocking.type),
      presence: 'open',
      basis: 'observed',
      confidence: 'high',
      evidence: [ev('hook', 'notification', blocking.stamp.at, { value: blocking.type })],
    };
  }

  // S-7: inside a turn
  if (s.inTurn) {
    const oldest = s.openTools[0];
    if (oldest?.startedAt !== undefined && oldest.startedAt !== null) {
      const waited = now - oldest.startedAt;
      const toolOpen = ev(turnSource, 'tool_open', oldest.startedAt, {
        ...(oldest.name === null ? {} : { value: oldest.name }),
        count: s.openTools.length,
      });
      if ((oldest.name === 'Agent' || oldest.name === 'Task') && oldest.link?.value !== 'async_launched') {
        return {
          ruleId: 'S-7a',
          state: 'waiting_agent',
          presence: 'open',
          basis: 'observed',
          confidence: 'high',
          evidence: [
            toolOpen,
            ...(s.childrenActive > 0 ? [ev('transcript', 'child_active', null, { count: s.childrenActive })] : []),
          ],
        };
      }
      if (waited < activeMs) {
        return {
          ruleId: 'S-7b',
          state: 'working',
          presence: 'open',
          basis: 'observed',
          confidence: 'high',
          evidence: [toolOpen],
        };
      }
      if (waited < graceMs) {
        return {
          ruleId: 'S-7c',
          state: 'waiting_tool',
          presence: 'open',
          basis: 'observed',
          confidence: 'high',
          evidence: [toolOpen],
        };
      }
      return {
        ruleId: 'S-7d',
        state: 'unknown',
        presence: 'unknown',
        basis: 'inferred',
        confidence: 'low',
        evidence: [toolOpen],
      };
    }
    const prompt = ev(turnSource, 'prompt', s.prompt?.at ?? null);
    if (s.quiet < staleMs) {
      return {
        ruleId: 'S-7e',
        state: 'working',
        presence: 'open',
        basis: s.hookPath ? 'observed' : 'inferred',
        confidence: s.hookPath ? 'high' : 'medium',
        evidence: [prompt, quiet],
      };
    }
    const pidItem =
      facts.pid === null ? [] : [ev('pid', facts.pid.value.alive ? 'pid_alive' : 'pid_dead', facts.pid.stamp.at)];
    return {
      ruleId: 'S-7f',
      state: 'stale',
      staleKind: 'silent',
      presence: 'unknown',
      basis: 'inferred',
      confidence: s.pidAlive ? 'low' : 'medium',
      evidence: [prompt, quiet, ...pidItem],
    };
  }

  // S-8: after a turn end
  const turnEnd = s.turnEnd;
  if (turnEnd !== null) {
    if (s.childrenActive > 0 || (s.pendingAtEnd > 0 && s.quiet < staleMs)) {
      const observed = s.pendingAtEnd > 0 || s.childrenObserved;
      return {
        ruleId: 'S-8a',
        state: 'waiting_agent',
        presence: 'open',
        basis: observed ? 'observed' : 'inferred',
        confidence: observed ? 'high' : 'medium',
        evidence: [
          s.pendingAtEnd > 0
            ? ev(turnSource, 'background_pending', turnEnd.stamp.at, { count: s.pendingAtEnd })
            : ev('transcript', 'child_active', turnEnd.stamp.at, { count: s.childrenActive }),
        ],
      };
    }
    if (s.registryLive && registry?.status === 'idle') {
      return {
        ruleId: 'S-8b',
        state: 'waiting_input',
        waitReason: 'user',
        presence: 'open',
        basis: 'observed',
        confidence: 'high',
        evidence: [ev('registry', 'registry_status', facts.registry?.stamp.at ?? null, { value: 'idle' })],
      };
    }
    const idlePrompt = Object.hasOwn(facts.notifications, 'idle_prompt')
      ? facts.notifications['idle_prompt']
      : undefined;
    if (idlePrompt !== undefined && compareStamp(idlePrompt, turnEnd.stamp) > 0) {
      return {
        ruleId: 'S-8c',
        state: 'waiting_input',
        waitReason: 'idle_prompt',
        presence: 'open',
        basis: 'observed',
        confidence: 'high',
        evidence: [ev('hook', 'notification', idlePrompt.at, { value: 'idle_prompt' })],
      };
    }
    if (s.quiet >= abandonedMs && !s.pidAlive && !s.registryLive) {
      return {
        ruleId: 'S-8d',
        state: 'stale',
        staleKind: 'abandoned',
        presence: 'unknown',
        basis: 'inferred',
        confidence: 'medium',
        evidence: [quiet, turnEndEvidence(turnEnd)],
      };
    }
    const endedInferred = s.costStateTrailing && !s.pidAlive && !s.registryLive;
    const presence: Presence = endedInferred ? 'ended' : 'open';
    return {
      ruleId: 'S-8e',
      state: 'turn_ended',
      turnOutcome: turnEnd.kind === 'stop_failure' ? 'error' : turnEnd.kind === 'interrupted' ? 'interrupted' : 'ok',
      presence,
      basis: endedInferred ? 'inferred' : 'observed',
      confidence: endedInferred ? 'medium' : 'high',
      evidence: [turnEndEvidence(turnEnd)],
    };
  }
  // S-8f: SessionStart seen, no prompt yet (a compact start alone says nothing)
  if (s.prompt === null) {
    let start: { source: string; at: number } | null = null;
    for (const [source, stamp] of Object.entries(facts.starts)) {
      if (source === 'compact') continue;
      if (start === null || stamp.at > start.at) start = { source, at: stamp.at };
    }
    if (start !== null) {
      return {
        ruleId: 'S-8f',
        state: 'waiting_input',
        waitReason: 'user',
        presence: 'open',
        basis: 'observed',
        confidence: 'medium',
        evidence: [ev('hook', 'session_start', start.at, { value: start.source })],
      };
    }
  }

  // S-9: no turn structure
  if (s.registryLive && registry?.status === 'busy') {
    return {
      ruleId: 'S-9a',
      state: 'running',
      presence: 'open',
      basis: 'observed',
      confidence: 'high',
      evidence: [ev('registry', 'registry_status', facts.registry?.stamp.at ?? null, { value: 'busy' })],
    };
  }
  if (facts.transcriptMtime !== null && now - facts.transcriptMtime < activeMs) {
    return {
      ruleId: 'S-9b',
      state: 'running',
      presence: 'open',
      basis: 'inferred',
      confidence: 'medium',
      evidence: [ev('transcript', 'file_written', facts.transcriptMtime)],
    };
  }
  if (s.childrenActive > 0) {
    return {
      ruleId: 'S-9c',
      state: 'waiting_agent',
      presence: 'open',
      basis: 'inferred',
      confidence: 'medium',
      evidence: [ev('transcript', 'child_active', null, { count: s.childrenActive })],
    };
  }
  return {
    ruleId: 'S-10',
    state: 'unknown',
    presence: 'unknown',
    basis: 'inferred',
    confidence: 'low',
    evidence: [quiet],
  };
}

/**
 * The view of one session at `now` (02 7.4). `rows` are the tool rows of the session and the summaries of its agents and
 * workflow runs; an activity after SessionEnd beyond the tolerance (`isReopened`) adds an `activity_after_end` item.
 */
export function deriveSession(facts: SessionFacts, rows: SessionRows, now: number, cfg: LifecycleCfg): LifecycleView {
  const signals = sessionSignals(facts, rows, now, cfg);
  let decision = decideSession(facts, signals, cfg);
  if (signals.reopened && facts.lastActivity !== null) {
    const source =
      facts.lastHookAt !== null && facts.lastHookAt >= facts.lastActivity.at - cfg.crossSourceToleranceMs
        ? 'hook'
        : 'transcript';
    decision = {
      ...decision,
      evidence: [...decision.evidence, ev(source, 'activity_after_end', facts.lastActivity.at)],
    };
  }
  const nextCheck = sessionNextCheck({ ...decision, staleKind: decision.staleKind ?? null }, facts, rows, signals, cfg);
  return viewOf(decision, now, nextCheck);
}

// ---- a whole model ---------------------------------------------------------------------------------------------------

/**
 * What the derivation is given besides the facts: row-level state that is not a register, so that a later record can clear it
 * (CR-WP-28-2). Nothing given is the same as every flag not set.
 */
export interface ModelInputs {
  /** The main transcript file of the session ends in a cost-state record (`CostStatesRepo.sessionTrailing`). */
  readonly costStateTrailing?: boolean;
}

/** The views of every entity of a model at one time. */
export interface ModelViews {
  readonly session: LifecycleView;
  readonly agents: Readonly<Record<string, LifecycleView>>;
  readonly workflows: Readonly<Record<string, LifecycleView>>;
  /** SessionEnd is followed by later activity: the writer records `activity_after_end` once. */
  readonly reopened: boolean;
}

function sortedEntries<T>(map: ReadonlyMap<string, T>): [string, T][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Derives the session, its agents and its workflow runs together. The agents need the presence of their parent and the
 * parent needs the states of its agents; presence only depends on the states of the rules that end a session, so the
 * two are settled by a short fixed-point loop (at most three rounds).
 */
export function deriveModel(
  model: LifecycleModel,
  now: number,
  cfg: LifecycleCfg,
  inputs: ModelInputs = {},
): ModelViews {
  const agentIds = Object.keys(model.agents).sort();
  const runIds = [...new Set([...Object.keys(model.workflows), ...Object.values(model.agentRuns)])].sort();
  const toolRows: ToolCallRow[] = Object.values(model.tools);
  const agentFacts = new Map(agentIds.map((id) => [id, agentFactsOf(model, id)] as const));
  const runFacts = new Map(runIds.map((id) => [id, workflowFactsOf(model, id)] as const));

  const settle = (presence: Presence): ModelViews => {
    const agentViews = new Map<string, LifecycleView>();
    const summaries: AgentSummary[] = [];
    for (const [id, facts] of agentFacts) {
      const view = deriveAgent(
        facts,
        { tools: toolRows.filter((row) => row.agentId === id), parentPresence: presence },
        now,
        cfg,
      );
      agentViews.set(id, view);
      summaries.push({
        agentId: id,
        state: view.state,
        basis: view.basis,
        lastActivityAt: facts.lastActivity?.at ?? null,
        fileMtime: facts.fileMtime,
        nextCheckAt: view.nextCheckAt,
        workflowRunId: Object.hasOwn(model.agentRuns, id) ? (model.agentRuns[id] ?? null) : null,
      });
    }
    const runViews = new Map<string, LifecycleView>();
    const runSummaries: WorkflowSummary[] = [];
    for (const [id, facts] of runFacts) {
      const view = deriveWorkflow(
        facts,
        { parentPresence: presence, agents: summaries.filter((agent) => agent.workflowRunId === id) },
        now,
        cfg,
      );
      runViews.set(id, view);
      runSummaries.push({
        runId: id,
        state: view.state,
        basis: view.basis,
        lastAgentActivity: facts.lastAgentActivity,
        nextCheckAt: view.nextCheckAt,
      });
    }
    const session = deriveSession(
      model.session,
      {
        tools: toolRows,
        agents: summaries,
        workflows: runSummaries,
        ...(inputs.costStateTrailing === undefined ? {} : { costStateTrailing: inputs.costStateTrailing }),
      },
      now,
      cfg,
    );
    return {
      session,
      agents: Object.fromEntries(sortedEntries(agentViews)),
      workflows: Object.fromEntries(sortedEntries(runViews)),
      reopened: isReopened(model.session, cfg),
    };
  };

  // the first round assumes the parent is open; later rounds use the presence the previous round produced
  let assumed: Presence = 'open';
  let views = settle(assumed);
  for (let round = 0; round < 2 && views.session.presence !== assumed; round += 1) {
    assumed = views.session.presence;
    views = settle(assumed);
  }
  return views;
}
