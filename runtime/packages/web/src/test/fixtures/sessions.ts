// FIXTURE: invented data for tests
import type {
  LegacyState,
  LifecycleState,
  Page,
  SessionDetail,
  SessionSummary,
  StateAssessment,
  TokenUsage,
} from '@mcs/shared';

import { iso, sessionId } from './ids.ts';
import { makePage } from './pages.ts';

export function makeUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input: 100,
    output: 50,
    cacheCreation: 10,
    cacheRead: 200,
    total: 360,
    missing: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    turns: 3,
    synthetic: 0,
    unfinalized: 0,
    completeness: 'complete',
    scannedPct: 100,
    lowerBound: false,
    ...overrides,
  };
}

const LEGACY: Record<LifecycleState, LegacyState> = {
  running: 'RUNNING',
  working: 'RUNNING',
  waiting_input: 'IDLE',
  waiting_tool: 'RUNNING',
  waiting_agent: 'RUNNING',
  turn_ended: 'IDLE',
  completed: 'COMPLETED',
  failed: 'FAILED',
  stale: 'UNKNOWN',
  unknown: 'UNKNOWN',
};

export function makeState(
  state: LifecycleState = 'working',
  overrides: Partial<StateAssessment> = {},
): StateAssessment {
  return {
    state,
    presence: state === 'completed' || state === 'failed' ? 'ended' : 'open',
    waitReason: null,
    staleKind: null,
    endReason: null,
    turnOutcome: null,
    basis: 'observed',
    confidence: 'high',
    rule: 'S-1',
    evidence: [],
    since: iso(-60),
    evaluatedAt: iso(0),
    legacyState: LEGACY[state],
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: sessionId(1),
    seq: 1,
    label: 'FIXTURE build step A',
    labelSource: 'first_prompt',
    matched: true,
    pinned: false,
    projectId: 'fixture-project',
    projectLabel: 'FIXTURE project',
    workItemIds: [],
    provider: 'claude-code',
    entrypoint: null,
    ccVersion: null,
    models: ['fixture-model'],
    lastModel: 'fixture-model',
    startedAt: iso(-3600),
    lastActivityAt: iso(-30),
    endedAt: null,
    durationMs: 3_570_000,
    state: makeState('working'),
    agentCount: 1,
    activeAgentCount: 1,
    toolCallCount: 4,
    pendingTools: 0,
    errorCount: 0,
    warningCount: 0,
    usage: makeUsage(),
    usageInclSubagents: makeUsage(),
    cost: null,
    reportedCost: null,
    partial: false,
    sources: { hooks: false, transcript: true },
    freshness: {
      lastHookAt: null,
      lastTranscriptAt: iso(-30),
      transcriptLagBytes: 0,
      hookCoverage: 'none',
      eventsComplete: true,
      usageComplete: true,
    },
    ...overrides,
  };
}

/** The body of `GET /sessions/:id`: the detail plus `asOfSeq`. */
export type SessionDetailResponse = SessionDetail & { asOfSeq: number };

export function makeSessionDetail(overrides: Partial<SessionDetailResponse> = {}): SessionDetailResponse {
  return {
    ...makeSession(),
    cwd: null,
    gitBranch: null,
    permissionMode: null,
    claudePid: null,
    continuedIn: null,
    copiedFrom: null,
    hookMissing: { tools: 0, turns: 0 },
    external: [],
    workItems: [],
    files: [],
    filesTruncated: false,
    copiedMessages: 0,
    reconciliations: [],
    auditRefs: [],
    asOfSeq: 10,
    ...overrides,
  };
}

export function makeSessionPage(
  items: SessionSummary[],
  meta: Partial<Omit<Page<SessionSummary>, 'items'>> = {},
): Page<SessionSummary> {
  return makePage(items, meta);
}
