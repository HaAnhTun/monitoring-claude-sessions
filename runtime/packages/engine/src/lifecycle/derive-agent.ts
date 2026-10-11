// The agent decision table (02 7.5, rules A-1 to A-10): a pure function of the agent's facts, its open tool rows and the
// presence of its parent. First matching rule wins. A subagent never changes its parent's completed / failed state; it
// only feeds the parent's `childrenActive` (session rules S-7a, S-8a, S-9c).
import type { AgentFacts, LifecycleCfg, LifecycleView } from './facts.ts';
import { agentNextCheck } from './next-check.ts';
import { agentSignals, ev, msOf, viewOf, type AgentRows, type AgentSignals, type Decision } from './rules.ts';

function openToolDecision(s: AgentSignals, cfg: LifecycleCfg): Decision | null {
  const oldest = s.openTools[0];
  if (oldest?.startedAt === null || oldest?.startedAt === undefined) return null;
  const waited = s.now - oldest.startedAt;
  const evidence = [
    ev('hook', 'tool_open', oldest.startedAt, {
      ...(oldest.name === null ? {} : { value: oldest.name }),
      count: s.openTools.length,
    }),
  ];
  if (waited < msOf(cfg.activeSeconds)) {
    return { ruleId: 'A-5', state: 'working', presence: 'open', basis: 'observed', confidence: 'high', evidence };
  }
  if (waited < msOf(cfg.pendingToolGraceSeconds)) {
    return { ruleId: 'A-5', state: 'waiting_tool', presence: 'open', basis: 'observed', confidence: 'high', evidence };
  }
  return { ruleId: 'A-5', state: 'unknown', presence: 'unknown', basis: 'inferred', confidence: 'low', evidence };
}

function decideAgent(facts: AgentFacts, rows: AgentRows, s: AgentSignals, cfg: LifecycleCfg): Decision {
  if (!s.reopened) {
    const notification = facts.notification;
    if (notification?.value === 'completed') {
      return {
        ruleId: 'A-1',
        state: 'completed',
        presence: 'ended',
        basis: 'observed',
        confidence: 'high',
        evidence: [ev('transcript', 'agent_notification', notification.stamp.at, { value: notification.value })],
      };
    }
    if (notification !== null) {
      return {
        ruleId: 'A-2',
        state: 'failed',
        presence: 'ended',
        basis: 'observed',
        confidence: 'high',
        endReason: notification.value,
        evidence: [ev('transcript', 'agent_notification', notification.stamp.at, { value: notification.value })],
      };
    }
    if (facts.journal === 'failed') {
      return {
        ruleId: 'A-3',
        state: 'failed',
        presence: 'ended',
        basis: 'observed',
        confidence: 'high',
        endReason: 'journal_failed',
        evidence: [ev('journal', 'workflow_status', null, { value: 'failed' })],
      };
    }
    const closing =
      facts.journal === 'result'
        ? ev('journal', 'workflow_status', null, { value: 'result' })
        : facts.final !== null
          ? ev('transcript', 'agent_final', facts.final.at)
          : facts.stopped !== null
            ? ev('hook', 'agent_stop', facts.stopped.at)
            : facts.link?.value === 'completed'
              ? ev('hook', 'agent_link', facts.link.stamp.at, { value: facts.link.value })
              : null;
    if (closing !== null) {
      return {
        ruleId: 'A-4',
        state: 'completed',
        presence: 'ended',
        basis: 'observed',
        confidence: 'high',
        evidence: [closing],
      };
    }
  }

  const tools = openToolDecision(s, cfg);
  if (tools !== null) return tools;

  const subMs = msOf(cfg.subagentActiveSeconds);
  const staleMs = msOf(cfg.staleAfterSeconds);
  const quiet = ev('clock', 'quiet', s.lastEvidence);
  if ((s.recentActivity !== null && s.recentActivity > s.now - subMs) || (s.openEpisode && s.quiet < staleMs)) {
    const written =
      facts.fileMtime !== null && facts.fileMtime >= (facts.lastActivity?.at ?? 0)
        ? [ev('transcript', 'file_written', facts.fileMtime)]
        : [];
    return {
      ruleId: 'A-6',
      state: 'working',
      presence: 'open',
      basis: facts.started === null ? 'inferred' : 'observed',
      confidence: 'medium',
      evidence: [...written, quiet],
    };
  }
  if (rows.parentPresence === 'ended') {
    return {
      ruleId: 'A-7',
      state: 'stale',
      staleKind: 'parent_ended',
      presence: 'unknown',
      basis: 'inferred',
      confidence: 'medium',
      evidence: [ev('hook', 'parent_ended', null), quiet],
    };
  }
  const lastTurnEnd = facts.lastTurnEnd;
  if (lastTurnEnd?.value.kind === 'end_turn' && s.quiet >= subMs) {
    return {
      ruleId: 'A-8',
      state: 'completed',
      presence: 'ended',
      basis: 'inferred',
      confidence: 'medium',
      evidence: [ev('transcript', 'end_turn', lastTurnEnd.stamp.at)],
    };
  }
  if (s.lastEvidence !== null && s.quiet >= staleMs) {
    return {
      ruleId: 'A-9',
      state: 'stale',
      staleKind: 'silent',
      presence: 'unknown',
      basis: 'inferred',
      confidence: 'medium',
      evidence: [quiet],
    };
  }
  return {
    ruleId: 'A-10',
    state: 'unknown',
    presence: 'unknown',
    basis: 'inferred',
    confidence: 'low',
    evidence: [quiet],
  };
}

/** The view of one non-main agent at `now`. */
export function deriveAgent(facts: AgentFacts, rows: AgentRows, now: number, cfg: LifecycleCfg): LifecycleView {
  const signals = agentSignals(facts, rows, now, cfg);
  const decision = decideAgent(facts, rows, signals, cfg);
  return viewOf(
    decision,
    now,
    agentNextCheck({ ...decision, staleKind: decision.staleKind ?? null }, facts, signals, cfg),
  );
}
