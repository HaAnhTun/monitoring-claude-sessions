// The workflow run decision table (02 7.6, rules W-1 to W-7). First matching rule wins. The run file
// `workflows/<runId>.json` is written only for finished runs (TS:6.2), so a run without it is never completed.
import type { LifecycleCfg, LifecycleView, WorkflowFacts } from './facts.ts';
import { workflowNextCheck } from './next-check.ts';
import { ev, msOf, viewOf, workflowSignals, type Decision, type WorkflowRows } from './rules.ts';

const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set(['failed', 'error', 'cancelled', 'killed']);

function decideWorkflow(
  facts: WorkflowFacts,
  rows: WorkflowRows,
  s: ReturnType<typeof workflowSignals>,
  cfg: LifecycleCfg,
): Decision {
  const file = facts.fileStatus;
  if (file !== null) {
    const evidence = [ev('workflow_file', 'workflow_status', file.stamp.at, { value: file.value })];
    if (file.value === 'completed') {
      return { ruleId: 'W-1', state: 'completed', presence: 'ended', basis: 'observed', confidence: 'high', evidence };
    }
    if (FAILED_RUN_STATUSES.has(file.value)) {
      return {
        ruleId: 'W-2',
        state: 'failed',
        presence: 'ended',
        basis: 'observed',
        confidence: 'high',
        endReason: file.value,
        evidence,
      };
    }
    return { ruleId: 'W-3', state: 'unknown', presence: 'unknown', basis: 'observed', confidence: 'low', evidence };
  }

  const subMs = msOf(cfg.subagentActiveSeconds);
  const staleMs = msOf(cfg.staleAfterSeconds);
  if (s.agentBusy || (s.lastAgentActivity !== null && s.lastAgentActivity > s.now - subMs)) {
    return {
      ruleId: 'W-4',
      state: 'running',
      presence: 'open',
      basis: 'observed',
      confidence: 'high',
      evidence: [
        s.agentBusy ? ev('transcript', 'child_active', s.lastAgentActivity) : ev('clock', 'quiet', s.lastAgentActivity),
      ],
    };
  }
  if (rows.parentPresence === 'ended') {
    return {
      ruleId: 'W-5',
      state: 'stale',
      staleKind: 'parent_ended',
      presence: 'unknown',
      basis: 'inferred',
      confidence: 'medium',
      evidence: [ev('hook', 'parent_ended', null)],
    };
  }
  if (s.lastEvidence !== null && s.lastEvidence > s.now - staleMs) {
    return {
      ruleId: 'W-6',
      state: 'running',
      presence: 'open',
      basis: 'inferred',
      confidence: 'medium',
      evidence: [ev('clock', 'quiet', s.lastEvidence)],
    };
  }
  return {
    ruleId: 'W-7',
    state: 'stale',
    staleKind: 'silent',
    presence: 'unknown',
    basis: 'inferred',
    confidence: 'medium',
    evidence: [ev('clock', 'quiet', s.lastEvidence)],
  };
}

/** The view of one workflow run at `now`. */
export function deriveWorkflow(
  facts: WorkflowFacts,
  rows: WorkflowRows,
  now: number,
  cfg: LifecycleCfg,
): LifecycleView {
  const signals = workflowSignals(facts, rows, now);
  const decision = decideWorkflow(facts, rows, signals, cfg);
  return viewOf(
    decision,
    now,
    workflowNextCheck({ ...decision, staleKind: decision.staleKind ?? null }, rows, signals, cfg),
  );
}
