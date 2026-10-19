// `explainCompletion` of the query layer (03 6.1, 6.3, 12.1, I-08, registry C16): builds a `CompletionLookup` over the
// repositories and hands it to the pure function of 02 7.13. The lookups are `SessionsRepo.completionCandidates` (a unique
// index for an id, a scan for an exact label, O-5) and `AttemptsRepo.runsByPart` (a scan, O-5); both are operator triggered
// (`verify-completion`, the completion route) and never polled. Nothing here writes: a stored view that is due is derived again
// in memory, and the sweeper stays the only writer of views.
//
// A malformed target is refused before a statement is prepared or a read is opened. The target (a label may be private) is
// never logged and never put into an error message.
import type { CompletionEvidence } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import { AgentsRepo } from '../db/repos/agents.ts';
import { AttemptsRepo } from '../db/repos/attempts.ts';
import { CostStatesRepo } from '../db/repos/cost-states.ts';
import { SessionsRepo, type CompletionCandidate as StoredCandidate } from '../db/repos/sessions.ts';
import { ToolCallsRepo, type ToolCallRow as DbToolCall } from '../db/repos/tool-calls.ts';
import { WorkflowRunsRepo } from '../db/repos/workflow-runs.ts';
import { lifecycleCfgOf } from '../ingest/service.ts';
import {
  explainCompletion,
  validateCompletionTarget,
  type CompletionCandidate,
  type CompletionDerivation,
  type CompletionLookup,
  type CompletionTarget,
} from '../lifecycle/completion.ts';
import {
  EVIDENCE_FACTS,
  EVIDENCE_SOURCES,
  parseAgentFacts,
  parseSessionFacts,
  parseWorkflowFacts,
  type AgentFacts,
  type LifecycleEvidence,
  type LifecycleView,
  type ToolCallRow as ModelToolCall,
  type WorkflowFacts,
} from '../lifecycle/facts.ts';
import { emptyModel, type LifecycleModel } from '../lifecycle/merge.ts';
import type { QueryDeps } from '../runtime/context.ts';
import { snapshot } from './transitions.ts';

export interface CompletionQueries {
  /**
   * Whether the run named by `target` finished (02 7.13). Throws `CompletionTargetError`: `target_invalid` (the route answers 400
   * `validation_failed`) or `target_not_found` (404 `completion_target_not_found`); there is no `null` result.
   */
  explainCompletion(ctx: RepoContext, target: CompletionTarget): CompletionEvidence & { asOfSeq: number };
}

/** The open tool calls read for a re-derivation, as many as the ingest writer reads when it rebuilds a session. */
const OPEN_TOOLS_READ = 200;
const MAX_EVIDENCE_ITEMS = 8;

/** The stored view as the engine form: an evidence item with a source or fact this version does not know is left out. */
function lifecycleViewOf(stored: StoredCandidate['view']): LifecycleView {
  const evidence: LifecycleEvidence[] = [];
  for (const item of stored.evidence) {
    const source = EVIDENCE_SOURCES.find((known) => known === item.source);
    const fact = EVIDENCE_FACTS.find((known) => known === item.fact);
    if (source === undefined || fact === undefined) continue;
    evidence.push({
      source,
      fact,
      at: item.at,
      ...(item.count === undefined ? {} : { count: item.count }),
      ...(item.value === undefined ? {} : { value: item.value }),
    });
    if (evidence.length === MAX_EVIDENCE_ITEMS) break;
  }
  return { ...stored, evidence };
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function modelToolOf(row: DbToolCall, agentUids: ReadonlyMap<number, string>): ModelToolCall {
  const agentUid = agentUids.get(row.agentId);
  return {
    toolUseId: row.toolUseId,
    agentId: agentUid === undefined || agentUid === 'main' ? null : agentUid,
    name: row.name,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    batchAt: row.batchAt,
    outcome: row.outcome,
    inputHash: row.inputHash,
    link: null,
    transcriptUse: (row.sources & 4) !== 0,
    transcriptResult: (row.sources & 8) !== 0,
  };
}

export function createCompletionQueries(db: InstanceDb, deps: QueryDeps): CompletionQueries {
  const sessions = new SessionsRepo(db);
  const attempts = new AttemptsRepo(db);
  const agents = new AgentsRepo(db);
  const runs = new WorkflowRunsRepo(db);
  const toolCalls = new ToolCallsRepo(db);
  const costStates = new CostStatesRepo(db);

  /**
   * The facts and rows `deriveModel` reads for one session, rebuilt from the database like the ingest writer rebuilds a
   * session that left its cache (02 4.6 step 1): the facts of the session, of its subagents and workflow runs, the open tool
   * calls, and the trailing flag of the cost state. `null` when the facts of the session are missing or are not of this version.
   */
  function derivationOf(ctx: RepoContext, sessionUid: string): CompletionDerivation | null {
    const rowId = sessions.idByUid(ctx, sessionUid);
    if (rowId === undefined) return null;
    const stored = sessions.readView(ctx, rowId);
    if (stored === undefined) return null;
    const session = parseSessionFacts(parsedJson(stored.factsJson));
    if (session === null) return null;

    const runUidById = new Map<number, string>();
    const workflows: Record<string, WorkflowFacts> = {};
    for (const run of runs.listBySession(ctx, rowId)) {
      runUidById.set(run.id, run.runUid);
      const view = runs.readView(ctx, run.id);
      const facts = view === undefined ? null : parseWorkflowFacts(parsedJson(view.factsJson));
      if (facts !== null) Object.assign(workflows, { [run.runUid]: facts });
    }

    const agentUids = new Map<number, string>();
    const agentFacts: Record<string, AgentFacts> = {};
    const spawns: Record<string, string> = {};
    const agentRuns: Record<string, string> = {};
    for (const agent of agents.listBySession(ctx, rowId)) {
      agentUids.set(agent.id, agent.agentUid);
      if (agent.kind === 'main') continue;
      const view = agents.readView(ctx, agent.id);
      const facts = view === undefined ? null : parseAgentFacts(parsedJson(view.factsJson));
      if (facts !== null) Object.assign(agentFacts, { [agent.agentUid]: facts });
      if (agent.spawnToolUseId !== null) Object.assign(spawns, { [agent.spawnToolUseId]: agent.agentUid });
      const run = agent.workflowRunId === null ? undefined : runUidById.get(agent.workflowRunId);
      if (run !== undefined) Object.assign(agentRuns, { [agent.agentUid]: run });
    }

    const tools: Record<string, ModelToolCall> = {};
    for (const row of toolCalls.openForSession(ctx, rowId, OPEN_TOOLS_READ)) {
      Object.assign(tools, { [row.toolUseId]: modelToolOf(row, agentUids) });
    }
    const model: LifecycleModel = { ...emptyModel(), session, agents: agentFacts, workflows, spawns, agentRuns, tools };
    return {
      model,
      inputs: { costStateTrailing: costStates.sessionTrailing(ctx, rowId) },
      cfg: lifecycleCfgOf(deps.config),
    };
  }

  function lookupOver(ctx: RepoContext): CompletionLookup {
    const candidateOf = (row: StoredCandidate): CompletionCandidate => ({
      sessionId: row.sessionId,
      label: row.label,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
      view: lifecycleViewOf(row.view),
      derivation: () => derivationOf(ctx, row.sessionId),
    });
    return {
      sessionById: (sessionId) => {
        const row = sessions.completionCandidates(ctx, { sessionId })[0];
        return row === undefined ? null : candidateOf(row);
      },
      sessionsByLabel: (label) => sessions.completionCandidates(ctx, { label }).map(candidateOf),
      attemptRowsByPart: (part) => attempts.runsByPart(ctx, part),
    };
  }

  return {
    explainCompletion: (ctx, target) => {
      db.assertScope(ctx);
      validateCompletionTarget(target);
      return snapshot(db, ctx, (asOfSeq) => ({
        ...explainCompletion(lookupOver(ctx), target, deps.now()),
        asOfSeq,
      }));
    },
  };
}
