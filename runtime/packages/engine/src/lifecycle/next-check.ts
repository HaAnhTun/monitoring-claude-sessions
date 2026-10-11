// `nextCheckAt` (02 7.8): the smallest future time at which an input of a decision table crosses a threshold, so the
// sweeper re-derives a row exactly when its view could change without a new event. Null when nothing time-driven is left.
//
// Soundness (property P7): for fixed facts, `derive(t)` equals `derive(evaluatedAt)` for every `t` before the value
// returned here. The candidates below are therefore listed per branch of the decision table; a branch may list a
// threshold that its current rule does not reach (a harmless early wake-up), never the other way round.
import type { AgentFacts, LifecycleCfg, LifecycleView, SessionFacts, WorkflowFacts } from './facts.ts';
import {
  agentSignals,
  msOf,
  sessionSignals,
  workflowSignals,
  type AgentRows,
  type AgentSignals,
  type SessionRows,
  type SessionSignals,
  type WorkflowRows,
  type WorkflowSignals,
} from './rules.ts';

export type NextCheckInput =
  | { readonly kind: 'session'; readonly facts: SessionFacts; readonly rows: SessionRows }
  | { readonly kind: 'agent'; readonly facts: AgentFacts; readonly rows: AgentRows }
  | { readonly kind: 'workflow'; readonly facts: WorkflowFacts; readonly rows: WorkflowRows };

type Decided = Pick<LifecycleView, 'state' | 'staleKind' | 'presence' | 'ruleId'>;

/** Session rules that read facts only (S-1 to S-4), or are monotone in time (S-5): nothing is left to wait for. */
const SESSION_TIME_INVARIANT: ReadonlySet<string> = new Set(['S-1', 'S-2', 'S-3a', 'S-3b', 'S-4a', 'S-4b', 'S-5']);

/** The smallest candidate strictly after `now`, or null. */
function earliestAfter(now: number, candidates: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (const candidate of candidates) {
    if (candidate === null || !Number.isFinite(candidate) || candidate <= now) continue;
    if (best === null || candidate < best) best = candidate;
  }
  return best;
}

function plus(base: number | null, ms: number): number | null {
  return base === null ? null : base + ms;
}

export function sessionNextCheck(
  decided: Decided,
  facts: SessionFacts,
  rows: SessionRows,
  s: SessionSignals,
  cfg: LifecycleCfg,
): number | null {
  if (SESSION_TIME_INVARIANT.has(decided.ruleId)) return null;
  if (decided.state === 'completed' || decided.state === 'failed') return null;
  const candidates: (number | null)[] = [];

  if (facts.registry?.value.pidAlive === true) {
    candidates.push(facts.registry.stamp.at + 2 * cfg.registryPollMs + 1);
  }
  if (s.pidDead) candidates.push(plus(s.lastEvidence, msOf(cfg.processGoneGraceSeconds)));

  const oldest = s.openTools[0];
  if (s.inTurn) {
    if (oldest?.startedAt !== null && oldest?.startedAt !== undefined) {
      candidates.push(oldest.startedAt + msOf(cfg.activeSeconds), oldest.startedAt + msOf(cfg.pendingToolGraceSeconds));
    } else {
      candidates.push(plus(s.lastEvidence, msOf(cfg.staleAfterSeconds)));
    }
  } else if (s.turnEnd !== null) {
    if (s.pendingAtEnd > 0) candidates.push(plus(s.lastEvidence, msOf(cfg.staleAfterSeconds)));
    candidates.push(plus(s.lastEvidence, msOf(cfg.abandonedAfterSeconds)));
  } else {
    candidates.push(plus(facts.transcriptMtime, msOf(cfg.activeSeconds)));
  }

  for (const agent of rows.agents) candidates.push(agent.nextCheckAt);
  for (const run of rows.workflows) candidates.push(run.nextCheckAt);
  if (facts.claudePid !== null && decided.presence === 'open') candidates.push(s.now + cfg.pidCheckIntervalMs);
  return earliestAfter(s.now, candidates);
}

export function agentNextCheck(decided: Decided, facts: AgentFacts, s: AgentSignals, cfg: LifecycleCfg): number | null {
  if (decided.state === 'completed' || decided.state === 'failed') return null;
  if (decided.state === 'stale' && decided.staleKind === 'parent_ended') return null;
  const candidates: (number | null)[] = [];
  const oldest = s.openTools[0];
  if (oldest?.startedAt !== null && oldest?.startedAt !== undefined) {
    candidates.push(oldest.startedAt + msOf(cfg.activeSeconds), oldest.startedAt + msOf(cfg.pendingToolGraceSeconds));
  } else {
    candidates.push(plus(s.recentActivity, msOf(cfg.subagentActiveSeconds)));
    if (s.openEpisode) candidates.push(plus(s.lastEvidence, msOf(cfg.staleAfterSeconds)));
    if (facts.lastTurnEnd?.value.kind === 'end_turn')
      candidates.push(plus(s.lastEvidence, msOf(cfg.subagentActiveSeconds)));
    candidates.push(plus(s.lastEvidence, msOf(cfg.staleAfterSeconds)));
  }
  return earliestAfter(s.now, candidates);
}

export function workflowNextCheck(
  decided: Decided,
  rows: WorkflowRows,
  s: WorkflowSignals,
  cfg: LifecycleCfg,
): number | null {
  if (decided.state === 'completed' || decided.state === 'failed') return null;
  if (decided.ruleId === 'W-3' || decided.ruleId === 'W-5') return null;
  const candidates: (number | null)[] = [
    plus(s.lastAgentActivity, msOf(cfg.subagentActiveSeconds)),
    plus(s.lastEvidence, msOf(cfg.staleAfterSeconds)),
  ];
  for (const agent of rows.agents) candidates.push(agent.nextCheckAt);
  return earliestAfter(s.now, candidates);
}

/** `nextCheckAt(view, input, cfg)` of the registry (98 2.5): evaluated at `view.evaluatedAt`. */
export function nextCheckAt(view: LifecycleView, input: NextCheckInput, cfg: LifecycleCfg): number | null {
  const now = view.evaluatedAt;
  switch (input.kind) {
    case 'session':
      return sessionNextCheck(view, input.facts, input.rows, sessionSignals(input.facts, input.rows, now, cfg), cfg);
    case 'agent':
      return agentNextCheck(view, input.facts, agentSignals(input.facts, input.rows, now, cfg), cfg);
    case 'workflow':
      return workflowNextCheck(view, input.rows, workflowSignals(input.facts, input.rows, now), cfg);
  }
}
