// The legacy five-state view (02 7.9): RUNNING IDLE COMPLETED FAILED UNKNOWN.
//
//  1. Sessions with no hook evidence use `classifyLegacy`, a line-by-line port of `classify_state` of
//     `src/backend/state.py` (CS:C.1): the evidence strings are byte-identical, Python's `%d` (truncation toward zero),
//     `//` (floor division of floats) and `%r` (repr of a string) are reproduced. It is the parity oracle target (T-LF-51).
//  2. Sessions with hook evidence map their new state through `toLegacy`; the evidence is the rendered new evidence.
//  3. `legacyDone` is the v1 `done` flag.
import type { LegacyState } from '@mcs/shared';

import { quoteText } from '../json/index.ts';
import type { LifecycleCfg, LifecycleView, SessionFacts, ToolCallRow } from './facts.ts';
import { renderEvidence, type AgentSummary } from './rules.ts';

/** The mapping of 02 7.9 item 2. */
export function toLegacy(view: Pick<LifecycleView, 'state'>): LegacyState {
  switch (view.state) {
    case 'running':
    case 'working':
    case 'waiting_agent':
    case 'waiting_tool':
      return 'RUNNING';
    case 'waiting_input':
    case 'turn_ended':
      return 'IDLE';
    case 'completed':
      return 'COMPLETED';
    case 'failed':
      return 'FAILED';
    case 'stale':
    case 'unknown':
      return 'UNKNOWN';
  }
}

// ---- Python semantics ----------------------------------------------------------------------------------------------

/** Python `float // float` (CPython `float_floor_div`): exact for the doubles it is given, unlike `Math.floor(a / b)`. */
export function pyFloorDiv(a: number, b: number): number {
  const mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0 && b < 0 !== mod < 0) div -= 1;
  if (div === 0) return a / b < 0 ? -0 : 0;
  let floored = Math.floor(div);
  if (div - floored > 0.5) floored += 1;
  return floored;
}

/** `'%d' % x` for a number: the integer part, truncated toward zero. */
function pyD(x: number): string {
  return String(Math.trunc(x) + 0);
}

// ---- classify_state ------------------------------------------------------------------------------------------------

const END_STOPS: readonly string[] = ['end_turn', 'stop_sequence'];

/** The arguments of `classify_state` (times in epoch seconds, the Python names in camel case). */
export interface LegacyClassifyInput {
  readonly mtime: number;
  readonly activeSeconds: number;
  readonly lastStop: string | null;
  readonly pending: number;
  /** Epoch seconds of the oldest tool call without result; null or 0 = unknown. */
  readonly oldestPendingTs: number | null;
  readonly agentMtimes: readonly number[];
  readonly graceSeconds: number;
  readonly registry: { readonly status?: string | null } | null;
  /** The attempts-table evidence; null = no entry. */
  readonly external: { readonly state: LegacyState; readonly evidence: string } | null;
  readonly hasRecords: boolean;
}

export interface LegacyClassification {
  readonly state: LegacyState;
  readonly evidence: string;
  /** `external`, `registry`, `transcript`; `hook` for sessions with hook evidence (a new value, 02 7.9). */
  readonly source: 'external' | 'registry' | 'transcript' | 'hook';
}

/** Port of `classify_state(now, mtime, ...)`: `now` in epoch seconds. */
export function classifyLegacy(input: LegacyClassifyInput, now: number): LegacyClassification {
  if (input.external !== null) {
    return { state: input.external.state, evidence: input.external.evidence, source: 'external' };
  }
  if (!input.hasRecords) return { state: 'UNKNOWN', evidence: 'no readable records', source: 'transcript' };
  const age = now - input.mtime;
  const registryStatus = input.registry?.status;
  if (registryStatus === 'busy') {
    return { state: 'RUNNING', evidence: 'Claude session registry reports busy', source: 'registry' };
  }
  if (age < input.activeSeconds) {
    return { state: 'RUNNING', evidence: `transcript written ${pyD(age)}s ago`, source: 'transcript' };
  }
  const recentAgents = input.agentMtimes.filter((mtime) => now - mtime < 60).length;
  if (recentAgents > 0) {
    return {
      state: 'RUNNING',
      evidence: `${String(recentAgents)} subagent(s) written within the last minute`,
      source: 'transcript',
    };
  }
  if (input.pending !== 0) {
    const oldest = input.oldestPendingTs;
    const waited = oldest !== null && oldest !== 0 ? now - oldest : age;
    if (waited < input.graceSeconds) {
      return {
        state: 'RUNNING',
        evidence: `${String(input.pending)} tool call(s) without result for ${pyD(waited)}s (within the ${pyD(input.graceSeconds)}s grace)`,
        source: 'transcript',
      };
    }
    return {
      state: 'UNKNOWN',
      evidence: `${String(input.pending)} tool call(s) without result for ${pyD(pyFloorDiv(waited, 60))}m: stalled, killed, waiting for permission or a very long tool`,
      source: 'transcript',
    };
  }
  if (registryStatus === 'idle') {
    return {
      state: 'IDLE',
      evidence: `Claude session registry reports idle; quiet ${pyD(pyFloorDiv(age, 60))}m`,
      source: 'registry',
    };
  }
  const quietMinutes = pyD(pyFloorDiv(age, 60));
  if (input.lastStop !== null && END_STOPS.includes(input.lastStop)) {
    return {
      state: 'IDLE',
      evidence: `turn ended (${input.lastStop}), quiet ${quietMinutes}m; the transcript cannot show whether the job is finished or waiting`,
      source: 'transcript',
    };
  }
  const stop = input.lastStop === null || input.lastStop === '' ? 'missing' : input.lastStop;
  return {
    state: 'UNKNOWN',
    evidence: `quiet ${quietMinutes}m and the last stop reason is ${quoteText(stop)}`,
    source: 'transcript',
  };
}

/** `classify_state` for an agent file: the override of `sessions.py` turns a quiet IDLE with an end stop into COMPLETED. */
export function classifyLegacyAgent(input: LegacyClassifyInput, now: number): LegacyClassification {
  const out = classifyLegacy(input, now);
  if (out.state === 'IDLE' && input.lastStop !== null && END_STOPS.includes(input.lastStop)) {
    return {
      state: 'COMPLETED',
      evidence: `subagent ended its turn (${input.lastStop}); it continues only if its parent resumes it`,
      source: out.source,
    };
  }
  return out;
}

/** v1 `done` of a session: quiet for `active_seconds`, an end stop, and no agent written within 60 s (int ages). */
export function legacyDone(input: {
  readonly age: number;
  readonly activeSeconds: number;
  readonly stop: string | null;
  readonly agentAges: readonly number[];
}): boolean {
  return (
    input.age >= input.activeSeconds &&
    input.stop !== null &&
    END_STOPS.includes(input.stop) &&
    !input.agentAges.some((age) => Math.trunc(age) < 60)
  );
}

/** v1 `done` of an agent. */
export function legacyAgentDone(age: number, stop: string | null): boolean {
  return age >= 60 && stop !== null && END_STOPS.includes(stop);
}

// ---- from facts ----------------------------------------------------------------------------------------------------

export interface LegacyRows {
  readonly tools: readonly ToolCallRow[];
  readonly agents: readonly Pick<AgentSummary, 'fileMtime'>[];
}

/** The inputs of `classify_state` as 02 7.9 item 1 derives them from the facts and rows. */
export function legacyInputOfFacts(
  facts: SessionFacts,
  rows: LegacyRows,
  now: number,
  cfg: LifecycleCfg,
): LegacyClassifyInput {
  const pending = rows.tools.filter((row) => row.agentId === null && row.transcriptUse && !row.transcriptResult);
  let oldest = 0;
  for (const row of pending) {
    if (row.startedAt === null) continue;
    const seconds = row.startedAt / 1000;
    if (oldest === 0 || seconds < oldest) oldest = seconds;
  }
  const registry = facts.registry?.value;
  const attempt = facts.attempt?.value ?? null;
  return {
    mtime: (facts.transcriptMtime ?? facts.lastActivity?.at ?? now) / 1000,
    activeSeconds: cfg.activeSeconds,
    lastStop: facts.legacy.lastStop?.value ?? null,
    pending: pending.length,
    oldestPendingTs: oldest,
    agentMtimes: rows.agents.flatMap((agent) => (agent.fileMtime === null ? [] : [agent.fileMtime / 1000])),
    graceSeconds: cfg.pendingToolGraceSeconds,
    registry:
      registry !== undefined && registry.pidAlive && (registry.status === 'busy' || registry.status === 'idle')
        ? { status: registry.status }
        : null,
    external: attempt === null ? null : { state: attempt.state, evidence: attempt.evidence },
    hasRecords: facts.hasRecords,
  };
}

/** `classifyLegacy` over facts and rows; `now` in epoch ms. */
export function classifyLegacyOfFacts(
  facts: SessionFacts,
  rows: LegacyRows,
  now: number,
  cfg: LifecycleCfg,
): LegacyClassification {
  return classifyLegacy(legacyInputOfFacts(facts, rows, now, cfg), now / 1000);
}

/** The legacy state and evidence of a session: the classifier port without hook evidence, the mapped view with it. */
export function legacyOfSession(
  facts: SessionFacts,
  rows: LegacyRows,
  view: LifecycleView,
  now: number,
  cfg: LifecycleCfg,
): LegacyClassification {
  if (facts.lastHookAt === null) return classifyLegacyOfFacts(facts, rows, now, cfg);
  return {
    state: toLegacy(view),
    evidence: view.evidence.map((item) => renderEvidence(item, now)).join('; '),
    source: 'hook',
  };
}
