import type {
  ActivityEvent,
  AgentNode,
  AlertItem,
  HealthReport,
  Page,
  SessionDetail,
  SessionSummary,
  StreamChange,
  ToolCallItem,
  WorkflowRunItem,
  WorkItem,
  WorkItemBoard,
} from '@mcs/shared';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../data/query-client.ts';
import { qk } from '../data/query-keys.ts';
import {
  agentId,
  FIXTURE_INSTANCE_ID,
  iso,
  makeAgent,
  makeAgentPage,
  makeEvent,
  makeEventPage,
  makeHealth,
  makeSession,
  makeSessionDetail,
  makeSessionPage,
  makeState,
  makeWorkItem,
  makeWorkItemBoard,
  runId,
  sessionId,
  toolUseId,
} from '../test/fixtures/index.ts';
import { createLiveBufferRegistry, type LiveBufferHandle } from './live-buffer.ts';
import { createPatchLedger, ledgerKey } from './patch-ledger.ts';
import {
  applyChange,
  createReconciler,
  installLedgerReapply,
  type Reconciler,
  type ReconcilerOptions,
  type TranscriptRegistry,
} from './reconcile.ts';

const IID = FIXTURE_INSTANCE_ID;
const S1 = sessionId(1);
const S2 = sessionId(2);

// ---- frames ----------------------------------------------------------------------------------------------------------------

function base(seq: number) {
  return { seq, at: iso(0), instanceId: IID };
}

const frames = {
  sessionUpsert: (data: SessionSummary | null, sid: string = S1, seq = 1): StreamChange => ({
    ...base(seq),
    kind: 'session',
    op: 'upsert',
    sessionId: sid,
    data,
  }),
  sessionDelete: (sid: string = S1, seq = 1): StreamChange => ({
    ...base(seq),
    kind: 'session',
    op: 'delete',
    sessionId: sid,
    data: null,
  }),
  agentUpsert: (data: AgentNode | null, sid: string = S1, seq = 1): StreamChange => ({
    ...base(seq),
    kind: 'agent',
    op: 'upsert',
    sessionId: sid,
    data,
  }),
  workflowUpsert: (data: WorkflowRunItem | null, sid: string = S1, seq = 1): StreamChange => ({
    ...base(seq),
    kind: 'workflow',
    op: 'upsert',
    sessionId: sid,
    data,
  }),
  toolCall: (items: ToolCallItem[], truncated = false, sid: string = S1): StreamChange => ({
    ...base(1),
    kind: 'tool_call',
    op: 'upsert',
    sessionId: sid,
    data: { items, truncated },
  }),
  eventAppend: (items: ActivityEvent[], truncated = false, sid: string = S1): StreamChange => ({
    ...base(1),
    kind: 'event',
    op: 'append',
    sessionId: sid,
    data: { items, count: items.length, truncated },
  }),
  transcript: (data: { agentId: string; sizeBytes: number } | null, sid: string = S1): StreamChange => ({
    ...base(1),
    kind: 'transcript',
    op: 'append',
    sessionId: sid,
    data,
  }),
  workItem: (data: WorkItem | null): StreamChange => ({
    ...base(1),
    kind: 'work_item',
    op: 'upsert',
    sessionId: null,
    data,
  }),
  usage: (sid: string = S1): StreamChange => ({
    ...base(1),
    kind: 'usage',
    op: 'invalidate',
    sessionId: sid,
    data: { sessionId: sid },
  }),
  alert: (data: AlertItem | null): StreamChange => ({
    ...base(1),
    kind: 'alert',
    op: 'upsert',
    sessionId: null,
    data,
  }),
  health: (data: HealthReport): StreamChange => ({
    ...base(1),
    kind: 'health',
    op: 'upsert',
    sessionId: null,
    data,
  }),
  attempt: (): StreamChange => ({
    ...base(1),
    kind: 'attempt',
    op: 'upsert',
    sessionId: null,
    data: { ids: [1], truncated: false },
  }),
};

function toolCallItem(over: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    id: 1,
    seq: 2,
    toolUseId: toolUseId(1),
    sessionId: S1,
    agentId: 'main',
    promptId: null,
    name: 'Bash',
    mcpServer: null,
    status: 'succeeded',
    outcome: 'ok',
    summary: null,
    inputBytes: null,
    startedAt: null,
    endedAt: null,
    batchAt: null,
    durationMs: 120,
    durationSource: null,
    exitCode: null,
    sources: [],
    subagentId: null,
    workflowRunId: null,
    transcriptRef: null,
    ...over,
  };
}

function alertItem(over: Partial<AlertItem> = {}): AlertItem {
  return {
    id: 5,
    seq: 3,
    ruleId: 'inactivity',
    rule: 'inactivity',
    severity: 'critical',
    status: 'open',
    title: 'Session idle for 2 h',
    scope: { kind: 'session', key: S1 },
    sessionId: S1,
    since: iso(-60),
    lastFiredAt: iso(-10),
    fireCount: 1,
    resolvedAt: null,
    resolvedReason: null,
    detail: {},
    ...over,
  };
}

function workflowItem(over: Partial<WorkflowRunItem> = {}): WorkflowRunItem {
  return {
    runId: runId(1),
    seq: 4,
    sessionId: S1,
    name: 'FIXTURE flow',
    state: makeState('completed'),
    agentCount: 2,
    started: 2,
    results: 2,
    failed: 0,
    startedAt: iso(-100),
    endedAt: iso(-1),
    ...over,
  };
}

// ---- harness ---------------------------------------------------------------------------------------------------------------

interface Env {
  qc: QueryClient;
  r: Reconciler;
  announce: ReturnType<typeof vi.fn<(m: string) => void>>;
  buffers: ReturnType<typeof createLiveBufferRegistry>;
  bufferHandle: LiveBufferHandle;
  transcripts: TranscriptRegistry & {
    refresh: ReturnType<typeof vi.fn<() => void>>;
    refreshSession: ReturnType<typeof vi.fn<(sid: string) => void>>;
    refreshAll: ReturnType<typeof vi.fn<() => void>>;
  };
}

function setup(over: Partial<ReconcilerOptions> = {}): Env {
  const qc = createQueryClient({ retry: false });
  const announce = vi.fn<(m: string) => void>();
  const buffers = createLiveBufferRegistry();
  const bufferHandle: LiveBufferHandle = {
    offer: vi.fn(),
    refetchFirstPage: vi.fn(),
    patchToolCalls: vi.fn(),
    clear: vi.fn(),
  };
  buffers.register(bufferHandle);
  const refresh = vi.fn<() => void>();
  const refreshSession = vi.fn<(sid: string) => void>();
  const refreshAll = vi.fn<() => void>();
  const transcripts = {
    get: vi.fn((_sid: string, aid: string) => (aid === 'main' ? { refresh } : undefined)),
    refresh,
    refreshSession,
    refreshAll,
  };
  const r = createReconciler({
    queryClient: qc,
    iid: IID,
    liveBuffers: buffers,
    transcriptRegistry: transcripts,
    announce,
    ledger: createPatchLedger(),
    ...over,
  });
  return { qc, r, announce, buffers, bufferHandle, transcripts };
}

function infinite<T>(...pages: Page<T>[]): InfiniteData<Page<T>> {
  return { pages, pageParams: pages.map((_, i) => (i === 0 ? null : `cursor-${String(i)}`)) };
}

function invalidated(qc: QueryClient, key: readonly unknown[]): boolean {
  return qc.getQueryState(key)?.isInvalidated === true;
}

const LIST_KEY = qk.sessions(IID, {});
const SIDEBAR_KEY = qk.sidebarSessions(IID, false);

function labels(data: InfiniteData<Page<SessionSummary>> | undefined): string[] {
  return (data?.pages ?? []).flatMap((p) => p.items.map((s) => s.label));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- session ---------------------------------------------------------------------------------------------------------------

describe('session / upsert with data', () => {
  it('puts the session in the ledger', () => {
    const e = setup();
    applyChange(frames.sessionUpsert(makeSession({ seq: 5 })), e.r.ctx);
    expect(e.r.ledger.get('session', ledgerKey.session(S1))?.seq).toBe(5);
  });

  it('merges into a cached detail when newer, keeping the detail-only fields (R1)', () => {
    const e = setup();
    e.qc.setQueryData(qk.session(IID, S1), makeSessionDetail({ seq: 5, label: 'old', cwd: '/fixture/cwd' }));
    applyChange(frames.sessionUpsert(makeSession({ seq: 6, label: 'new' })), e.r.ctx);
    const detail = e.qc.getQueryData<SessionDetail>(qk.session(IID, S1));
    expect(detail?.label).toBe('new');
    expect(detail?.seq).toBe(6);
    expect(detail?.cwd).toBe('/fixture/cwd');
    expect(e.qc.getQueryData<{ asOfSeq: number }>(qk.session(IID, S1))?.asOfSeq).toBe(10);
  });

  it('does not touch a detail that is as new or newer, and does not create one', () => {
    const e = setup();
    e.qc.setQueryData(qk.session(IID, S1), makeSessionDetail({ seq: 6, label: 'kept' }));
    applyChange(frames.sessionUpsert(makeSession({ seq: 6, label: 'same seq' })), e.r.ctx);
    applyChange(frames.sessionUpsert(makeSession({ seq: 2, label: 'older' })), e.r.ctx);
    expect(e.qc.getQueryData<SessionDetail>(qk.session(IID, S1))?.label).toBe('kept');
    applyChange(frames.sessionUpsert(makeSession({ id: S2, seq: 9 }), S2), e.r.ctx);
    expect(e.qc.getQueryData(qk.session(IID, S2))).toBeUndefined();
  });

  it('replaces the row of every cached list in place, without reordering (R3)', () => {
    const e = setup();
    const rows = [
      makeSession({ id: sessionId(1), seq: 1, label: 'one' }),
      makeSession({ id: sessionId(2), seq: 1, label: 'two' }),
      makeSession({ id: sessionId(3), seq: 1, label: 'three' }),
    ];
    e.qc.setQueryData(LIST_KEY, infinite(makeSessionPage(rows)));
    applyChange(
      frames.sessionUpsert(makeSession({ id: sessionId(2), seq: 4, label: 'two v2' }), sessionId(2)),
      e.r.ctx,
    );
    expect(labels(e.qc.getQueryData(LIST_KEY))).toEqual(['one', 'two v2', 'three']);
    expect(e.r.pending.get(LIST_KEY)).toBe(0);
  });

  it('keeps a row that is as new or newer than the patch (R1)', () => {
    const e = setup();
    e.qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession({ seq: 8, label: 'kept' })])));
    applyChange(frames.sessionUpsert(makeSession({ seq: 8, label: 'same' })), e.r.ctx);
    applyChange(frames.sessionUpsert(makeSession({ seq: 3, label: 'older' })), e.r.ctx);
    expect(labels(e.qc.getQueryData(LIST_KEY))).toEqual(['kept']);
  });

  it('a session absent from a cached list counts as a pending change for that list only (R3)', () => {
    const e = setup();
    const other = qk.sessions(IID, { state: 'running' });
    e.qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession({ id: S2, seq: 1 })])));
    e.qc.setQueryData(other, infinite(makeSessionPage([makeSession({ id: S1, seq: 1 })])));
    applyChange(frames.sessionUpsert(makeSession({ id: S1, seq: 2 })), e.r.ctx);
    expect(e.r.pending.get(LIST_KEY)).toBe(1);
    expect(e.r.pending.get(other)).toBe(0);
    expect(labels(e.qc.getQueryData(LIST_KEY))).toEqual(['FIXTURE build step A']);
    applyChange(frames.sessionUpsert(makeSession({ id: S1, seq: 3 })), e.r.ctx);
    expect(e.r.pending.get(LIST_KEY)).toBe(2);
    expect(e.r.pending.total()).toBe(2);
  });

  it('first page only and not scrolled: no pending count, the first page is invalidated after 2 s instead', () => {
    const e = setup({ listAtTop: () => true });
    e.qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession({ id: S2, seq: 1 })])));
    applyChange(frames.sessionUpsert(makeSession({ id: S1, seq: 2 })), e.r.ctx);
    expect(e.r.pending.get(LIST_KEY)).toBe(0);
    vi.advanceTimersByTime(1_999);
    expect(invalidated(e.qc, LIST_KEY)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(invalidated(e.qc, LIST_KEY)).toBe(true);
  });

  it('two pages loaded: the exception does not apply even at the top', () => {
    const e = setup({ listAtTop: () => true });
    e.qc.setQueryData(
      LIST_KEY,
      infinite(
        makeSessionPage([makeSession({ id: S2, seq: 1 })], { nextCursor: 'c1' }),
        makeSessionPage([makeSession({ id: sessionId(3), seq: 1 })]),
      ),
    );
    applyChange(frames.sessionUpsert(makeSession({ id: S1, seq: 2 })), e.r.ctx);
    expect(e.r.pending.get(LIST_KEY)).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(invalidated(e.qc, LIST_KEY)).toBe(false);
  });

  it('the sidebar list replaces the row, or inserts it first; it never counts pending changes', () => {
    const e = setup();
    e.qc.setQueryData(
      SIDEBAR_KEY,
      makeSessionPage([makeSession({ id: S2, seq: 1, label: 'two' }), makeSession({ id: sessionId(3), seq: 1 })]),
    );
    applyChange(frames.sessionUpsert(makeSession({ id: S2, seq: 3, label: 'two v2' }), S2), e.r.ctx);
    applyChange(frames.sessionUpsert(makeSession({ id: S1, seq: 2, label: 'fresh' })), e.r.ctx);
    const page = e.qc.getQueryData<Page<SessionSummary>>(SIDEBAR_KEY);
    expect(page?.items.map((s) => s.label)).toEqual(['fresh', 'two v2', 'FIXTURE build step A']);
    expect(e.r.pending.total()).toBe(0);
  });

  it('invalidates the overview after a 2 s debounce, once for a burst', () => {
    const e = setup();
    e.qc.setQueryData(qk.overview(IID), { marker: true });
    for (let i = 1; i <= 5; i += 1) applyChange(frames.sessionUpsert(makeSession({ seq: i })), e.r.ctx);
    vi.advanceTimersByTime(1_999);
    expect(invalidated(e.qc, qk.overview(IID))).toBe(false);
    const spy = vi.spyOn(e.qc, 'invalidateQueries');
    vi.advanceTimersByTime(1);
    expect(invalidated(e.qc, qk.overview(IID))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('session / upsert with null data', () => {
  it('invalidates the detail and counts a pending change on every list that holds the session', () => {
    const e = setup();
    const other = qk.sessions(IID, { state: 'running' });
    e.qc.setQueryData(qk.session(IID, S1), makeSessionDetail());
    e.qc.setQueryData(qk.agents(IID, S1), infinite(makeAgentPage([makeAgent()])));
    e.qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession({ id: S1 })])));
    e.qc.setQueryData(other, infinite(makeSessionPage([makeSession({ id: S2 })])));
    applyChange(frames.sessionUpsert(null), e.r.ctx);
    expect(invalidated(e.qc, qk.session(IID, S1))).toBe(true);
    expect(invalidated(e.qc, qk.agents(IID, S1))).toBe(false);
    expect(e.r.pending.get(LIST_KEY)).toBe(1);
    expect(e.r.pending.get(other)).toBe(0);
  });
});

describe('session / delete', () => {
  it('removes the row from every list and the sidebar, drops the detail and its children, tells the page', () => {
    const onSessionRemoved = vi.fn();
    const e = setup({ onSessionRemoved });
    e.qc.setQueryData(
      LIST_KEY,
      infinite(makeSessionPage([makeSession({ id: S1 }), makeSession({ id: S2, label: 'two' })])),
    );
    e.qc.setQueryData(SIDEBAR_KEY, makeSessionPage([makeSession({ id: S1 }), makeSession({ id: S2, label: 'two' })]));
    e.qc.setQueryData(qk.session(IID, S1), makeSessionDetail());
    e.qc.setQueryData(qk.agents(IID, S1), infinite(makeAgentPage([makeAgent()])));
    e.qc.setQueryData(qk.session(IID, S2), makeSessionDetail({ id: S2 }));
    e.r.ledger.put('session', makeSession({ seq: 3 }));
    applyChange(frames.sessionDelete(), e.r.ctx);
    expect(labels(e.qc.getQueryData(LIST_KEY))).toEqual(['two']);
    expect(e.qc.getQueryData<Page<SessionSummary>>(SIDEBAR_KEY)?.items.map((s) => s.label)).toEqual(['two']);
    expect(e.qc.getQueryData(qk.session(IID, S1))).toBeUndefined();
    expect(e.qc.getQueryData(qk.agents(IID, S1))).toBeUndefined();
    expect(e.qc.getQueryData(qk.session(IID, S2))).toBeDefined();
    expect(e.r.ledger.get('session', ledgerKey.session(S1))).toBeUndefined();
    expect(onSessionRemoved).toHaveBeenCalledWith(S1);
  });
});

// ---- agent and workflow ----------------------------------------------------------------------------------------------------

describe('agent / upsert', () => {
  it('ledger.put and replace by id in the cached agents (R1); older patches are ignored', () => {
    const e = setup();
    e.qc.setQueryData(
      qk.agents(IID, S1),
      infinite(
        makeAgentPage([
          makeAgent({ id: agentId(1), seq: 2, label: 'a1' }),
          makeAgent({ id: agentId(2), seq: 2, label: 'a2' }),
        ]),
      ),
    );
    applyChange(frames.agentUpsert(makeAgent({ id: agentId(2), seq: 5, label: 'a2 v2' })), e.r.ctx);
    applyChange(frames.agentUpsert(makeAgent({ id: agentId(1), seq: 1, label: 'older' })), e.r.ctx);
    const data = e.qc.getQueryData<InfiniteData<Page<AgentNode>>>(qk.agents(IID, S1));
    expect(data?.pages[0]?.items.map((a) => a.label)).toEqual(['a1', 'a2 v2']);
    expect(e.r.ledger.get('agent', ledgerKey.agent(S1, agentId(2)))?.seq).toBe(5);
  });

  it('appends an agent the cache has not seen to the last loaded page', () => {
    const e = setup();
    e.qc.setQueryData(
      qk.agents(IID, S1),
      infinite(
        makeAgentPage([makeAgent({ id: agentId(1), label: 'a1' })], { nextCursor: 'c' }),
        makeAgentPage([makeAgent({ id: agentId(2), label: 'a2' })]),
      ),
    );
    applyChange(frames.agentUpsert(makeAgent({ id: agentId(3), seq: 2, label: 'a3' })), e.r.ctx);
    const data = e.qc.getQueryData<InfiniteData<Page<AgentNode>>>(qk.agents(IID, S1));
    expect(data?.pages.map((p) => p.items.map((a) => a.label))).toEqual([['a1'], ['a2', 'a3']]);
  });

  it('does not create a cache entry for an agents list nobody loaded', () => {
    const e = setup();
    applyChange(frames.agentUpsert(makeAgent({ seq: 2 })), e.r.ctx);
    expect(e.qc.getQueryData(qk.agents(IID, S1))).toBeUndefined();
    expect(e.r.ledger.size).toBe(1);
  });

  it('null data invalidates the agents of the session', () => {
    const e = setup();
    e.qc.setQueryData(qk.agents(IID, S1), infinite(makeAgentPage([makeAgent()])));
    applyChange(frames.agentUpsert(null), e.r.ctx);
    expect(invalidated(e.qc, qk.agents(IID, S1))).toBe(true);
  });
});

describe('workflow / upsert', () => {
  function seedAgents(e: Env): void {
    const inWorkflow = { runId: runId(1), name: 'FIXTURE flow', phase: null, state: 'working' as const };
    e.qc.setQueryData(
      qk.agents(IID, S1),
      infinite(
        makeAgentPage([
          makeAgent({ id: agentId(1), workflow: inWorkflow }),
          makeAgent({ id: agentId(2), workflow: { ...inWorkflow, runId: runId(2) } }),
          makeAgent({ id: agentId(3), workflow: null }),
        ]),
      ),
    );
  }

  it('sets workflow.state on the agents of that run only', () => {
    const e = setup();
    seedAgents(e);
    applyChange(frames.workflowUpsert(workflowItem()), e.r.ctx);
    const items = e.qc.getQueryData<InfiniteData<Page<AgentNode>>>(qk.agents(IID, S1))?.pages[0]?.items ?? [];
    expect(items.map((a) => a.workflow?.state ?? null)).toEqual(['completed', 'working', null]);
    expect(e.r.ledger.get('workflow', ledgerKey.workflow(runId(1)))?.seq).toBe(4);
  });

  it('a patch that is not newer than the ledger copy is ignored (R1)', () => {
    const e = setup();
    seedAgents(e);
    applyChange(frames.workflowUpsert(workflowItem({ seq: 4, state: makeState('failed') })), e.r.ctx);
    applyChange(frames.workflowUpsert(workflowItem({ seq: 4, state: makeState('completed') })), e.r.ctx);
    applyChange(frames.workflowUpsert(workflowItem({ seq: 2, state: makeState('completed') })), e.r.ctx);
    const items = e.qc.getQueryData<InfiniteData<Page<AgentNode>>>(qk.agents(IID, S1))?.pages[0]?.items ?? [];
    expect(items[0]?.workflow?.state).toBe('failed');
  });

  it('null data invalidates the agents of the session', () => {
    const e = setup();
    seedAgents(e);
    applyChange(frames.workflowUpsert(null), e.r.ctx);
    expect(invalidated(e.qc, qk.agents(IID, S1))).toBe(true);
  });
});

// ---- tool_call, event, transcript ------------------------------------------------------------------------------------------

describe('tool_call / upsert', () => {
  const row = (over: Partial<ActivityEvent> = {}): ActivityEvent =>
    makeEvent({ id: 1, toolUseId: toolUseId(1), toolStatus: 'pending', durationMs: null, ...over });

  it('updates toolStatus and durationMs in place in cached timeline and activity pages, no reorder', () => {
    const e = setup();
    const timelineKey = qk.timeline(IID, S1, {});
    const activityKey = qk.activity(IID, {});
    const rows = [
      row({ id: 3, toolUseId: toolUseId(9) }),
      row({ id: 2 }),
      row({ id: 1, toolUseId: null, toolStatus: null }),
    ];
    e.qc.setQueryData(timelineKey, infinite(makeEventPage(rows)));
    e.qc.setQueryData(activityKey, infinite(makeEventPage([row()])));
    applyChange(frames.toolCall([toolCallItem()]), e.r.ctx);
    const timeline = e.qc.getQueryData<InfiniteData<Page<ActivityEvent>>>(timelineKey);
    expect(timeline?.pages[0]?.items.map((r) => [r.id, r.toolStatus, r.durationMs])).toEqual([
      [3, 'pending', null],
      [2, 'succeeded', 120],
      [1, null, null],
    ]);
    const activity = e.qc.getQueryData<InfiniteData<Page<ActivityEvent>>>(activityKey);
    expect(activity?.pages[0]?.items[0]?.toolStatus).toBe('succeeded');
  });

  it('hands the items to every mounted live buffer', () => {
    const e = setup();
    const items = [toolCallItem()];
    applyChange(frames.toolCall(items), e.r.ctx);
    expect(e.bufferHandle.patchToolCalls).toHaveBeenCalledWith(items);
  });

  it('truncated: debounced (2 s) invalidate of that session timeline; not truncated: none', () => {
    const e = setup();
    const timelineKey = qk.timeline(IID, S1, {});
    const otherKey = qk.timeline(IID, S2, {});
    e.qc.setQueryData(timelineKey, infinite(makeEventPage([row()])));
    e.qc.setQueryData(otherKey, infinite(makeEventPage([row()])));
    applyChange(frames.toolCall([toolCallItem()], false), e.r.ctx);
    vi.advanceTimersByTime(5_000);
    expect(invalidated(e.qc, timelineKey)).toBe(false);
    applyChange(frames.toolCall([toolCallItem()], true), e.r.ctx);
    vi.advanceTimersByTime(1_999);
    expect(invalidated(e.qc, timelineKey)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(invalidated(e.qc, timelineKey)).toBe(true);
    expect(invalidated(e.qc, otherKey)).toBe(false);
  });
});

describe('event / append', () => {
  it('offers the items to every mounted buffer; no refetch unless truncated', () => {
    const e = setup();
    const items = [makeEvent({ id: 1 }), makeEvent({ id: 2 })];
    applyChange(frames.eventAppend(items), e.r.ctx);
    expect(e.bufferHandle.offer).toHaveBeenCalledWith(items);
    expect(e.bufferHandle.refetchFirstPage).not.toHaveBeenCalled();
  });

  it('truncated: every buffer refetches its first page', () => {
    const e = setup();
    applyChange(frames.eventAppend([makeEvent({ id: 1 })], true), e.r.ctx);
    expect(e.bufferHandle.refetchFirstPage).toHaveBeenCalledTimes(1);
  });

  it('invalidates the overview after a 2 s debounce', () => {
    const e = setup();
    e.qc.setQueryData(qk.overview(IID), { marker: true });
    applyChange(frames.eventAppend([makeEvent()]), e.r.ctx);
    vi.advanceTimersByTime(1_999);
    expect(invalidated(e.qc, qk.overview(IID))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(invalidated(e.qc, qk.overview(IID))).toBe(true);
  });
});

describe('transcript / append', () => {
  it('refreshes only the mounted viewer of that agent', () => {
    const e = setup();
    applyChange(frames.transcript({ agentId: 'main', sizeBytes: 100 }), e.r.ctx);
    expect(e.transcripts.get).toHaveBeenCalledWith(S1, 'main');
    expect(e.transcripts.refresh).toHaveBeenCalledTimes(1);
    applyChange(frames.transcript({ agentId: agentId(7), sizeBytes: 100 }), e.r.ctx);
    expect(e.transcripts.refresh).toHaveBeenCalledTimes(1);
  });

  it('null data refreshes every mounted viewer of the session', () => {
    const e = setup();
    applyChange(frames.transcript(null), e.r.ctx);
    expect(e.transcripts.refreshSession).toHaveBeenCalledWith(S1);
  });
});

// ---- work item, usage, alert, health, attempt -------------------------------------------------------------------------------

describe('work_item / upsert', () => {
  it('patches the board item in place (R1) and keeps the ledger copy', () => {
    const e = setup();
    e.qc.setQueryData(
      qk.workItems(IID),
      makeWorkItemBoard({
        items: [makeWorkItem({ id: 1, seq: 1, title: 'one' }), makeWorkItem({ id: 2, seq: 1, title: 'two' })],
      }),
    );
    applyChange(frames.workItem(makeWorkItem({ id: 2, seq: 5, title: 'two v2' })), e.r.ctx);
    applyChange(frames.workItem(makeWorkItem({ id: 1, seq: 0, title: 'stale' })), e.r.ctx);
    const board = e.qc.getQueryData<WorkItemBoard>(qk.workItems(IID));
    expect(board?.items.map((i) => i.title)).toEqual(['one', 'two v2']);
    expect(e.r.ledger.get('work_item', ledgerKey.workItem(2))?.seq).toBe(5);
    expect(invalidated(e.qc, qk.workItems(IID))).toBe(false);
  });

  it('an id that is not on the board invalidates the board', () => {
    const e = setup();
    e.qc.setQueryData(qk.workItems(IID), makeWorkItemBoard({ items: [makeWorkItem({ id: 1 })] }));
    applyChange(frames.workItem(makeWorkItem({ id: 9, seq: 2 })), e.r.ctx);
    expect(invalidated(e.qc, qk.workItems(IID))).toBe(true);
  });

  it('invalidates, after 2 s, the cached session details that list the item', () => {
    const e = setup();
    const listed = qk.session(IID, S1);
    const unrelated = qk.session(IID, S2);
    e.qc.setQueryData(listed, makeSessionDetail({ workItems: [{ id: 2, title: 't', state: 'working' }] }));
    e.qc.setQueryData(unrelated, makeSessionDetail({ id: S2, workItems: [] }));
    e.qc.setQueryData(qk.workItems(IID), makeWorkItemBoard({ items: [makeWorkItem({ id: 2, seq: 1 })] }));
    applyChange(frames.workItem(makeWorkItem({ id: 2, seq: 3 })), e.r.ctx);
    expect(invalidated(e.qc, listed)).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(invalidated(e.qc, listed)).toBe(true);
    expect(invalidated(e.qc, unrelated)).toBe(false);
  });

  it('null data invalidates the board', () => {
    const e = setup();
    e.qc.setQueryData(qk.workItems(IID), makeWorkItemBoard());
    applyChange(frames.workItem(null), e.r.ctx);
    expect(invalidated(e.qc, qk.workItems(IID))).toBe(true);
  });
});

describe('usage / invalidate', () => {
  it('invalidates analytics and the overview after a 10 s debounce', () => {
    const e = setup();
    const analytics = qk.analytics(IID, 'usage', {});
    e.qc.setQueryData(analytics, { marker: true });
    e.qc.setQueryData(qk.overview(IID), { marker: true });
    applyChange(frames.usage(), e.r.ctx);
    vi.advanceTimersByTime(9_999);
    expect(invalidated(e.qc, analytics)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(invalidated(e.qc, analytics)).toBe(true);
    expect(invalidated(e.qc, qk.overview(IID))).toBe(true);
  });
});

describe('alert / upsert', () => {
  it('ledger.put, debounced (2 s) invalidate of health and overview', () => {
    const e = setup();
    e.qc.setQueryData(qk.health(IID), makeHealth());
    e.qc.setQueryData(qk.overview(IID), { marker: true });
    applyChange(frames.alert(alertItem()), e.r.ctx);
    expect(e.r.ledger.get('alert', ledgerKey.alert(5))?.seq).toBe(3);
    vi.advanceTimersByTime(1_999);
    expect(invalidated(e.qc, qk.health(IID))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(invalidated(e.qc, qk.health(IID))).toBe(true);
    expect(invalidated(e.qc, qk.overview(IID))).toBe(true);
  });

  it('announces a new open critical alert once', () => {
    const e = setup();
    e.qc.setQueryData(qk.health(IID), makeHealth());
    applyChange(frames.alert(alertItem({ seq: 3 })), e.r.ctx);
    expect(e.announce).toHaveBeenCalledWith('Alert: Session idle for 2 h');
    applyChange(frames.alert(alertItem({ seq: 3 })), e.r.ctx);
    expect(e.announce).toHaveBeenCalledTimes(1);
  });

  it('does not announce a warning, a resolved alert or one the cached health already lists', () => {
    const e = setup();
    e.qc.setQueryData(qk.health(IID), makeHealth('ok', { alerts: [alertItem({ id: 7 })] }));
    applyChange(frames.alert(alertItem({ id: 6, severity: 'warning' })), e.r.ctx);
    applyChange(frames.alert(alertItem({ id: 8, status: 'resolved' })), e.r.ctx);
    applyChange(frames.alert(alertItem({ id: 7, seq: 9 })), e.r.ctx);
    expect(e.announce).not.toHaveBeenCalled();
  });

  it('null data: same invalidation, no announcement', () => {
    const e = setup();
    e.qc.setQueryData(qk.health(IID), makeHealth());
    applyChange(frames.alert(null), e.r.ctx);
    vi.advanceTimersByTime(2_000);
    expect(invalidated(e.qc, qk.health(IID))).toBe(true);
    expect(e.announce).not.toHaveBeenCalled();
  });
});

describe('health / upsert', () => {
  it('replaces the cached report when checkedAt is newer, not otherwise', () => {
    const e = setup();
    e.qc.setQueryData(qk.health(IID), makeHealth('ok', { checkedAt: iso(0) }));
    applyChange(frames.health(makeHealth('degraded', { checkedAt: iso(-5) })), e.r.ctx);
    expect(e.qc.getQueryData<HealthReport>(qk.health(IID))?.status).toBe('ok');
    applyChange(frames.health(makeHealth('degraded', { checkedAt: iso(5) })), e.r.ctx);
    expect(e.qc.getQueryData<HealthReport>(qk.health(IID))?.status).toBe('degraded');
  });
});

describe('attempt / upsert', () => {
  it('invalidates the attempts panel query', () => {
    const e = setup();
    e.qc.setQueryData(qk.panel(IID, 'attempts'), { marker: true });
    e.qc.setQueryData(qk.panel(IID, 'git'), { marker: true });
    applyChange(frames.attempt(), e.r.ctx);
    expect(invalidated(e.qc, qk.panel(IID, 'attempts'))).toBe(true);
    expect(invalidated(e.qc, qk.panel(IID, 'git'))).toBe(false);
  });
});

// ---- batches, R5, instance change, timers -----------------------------------------------------------------------------------

describe('applyBatch', () => {
  it('applies every change in order', () => {
    const e = setup();
    e.qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession({ seq: 1, label: 'v1' })])));
    e.r.applyBatch([
      frames.sessionUpsert(makeSession({ seq: 2, label: 'v2' })),
      frames.sessionUpsert(makeSession({ seq: 3, label: 'v3' })),
    ]);
    expect(labels(e.qc.getQueryData(LIST_KEY))).toEqual(['v3']);
  });

  it('a change that throws does not stop the others; the batch then resyncs (R5)', () => {
    const e = setup();
    e.qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession({ seq: 1, label: 'v1' })])));
    vi.mocked(e.bufferHandle.offer).mockImplementation(() => {
      throw new Error('boom');
    });
    const failing = vi.spyOn(e.transcripts, 'get').mockImplementation(() => {
      throw new Error('viewer exploded');
    });
    e.r.ledger.put('session', makeSession({ id: S2, seq: 9 }));
    e.r.applyBatch([
      frames.transcript({ agentId: 'main', sizeBytes: 1 }),
      frames.sessionUpsert(makeSession({ seq: 2, label: 'v2' })),
    ]);
    expect(failing).toHaveBeenCalled();
    expect(labels(e.qc.getQueryData(LIST_KEY))).toEqual(['v2']);
    expect(e.r.ledger.size).toBe(0);
    expect(invalidated(e.qc, LIST_KEY)).toBe(true);
  });
});

describe('R5 resync', () => {
  it('clears ledger, buffers and pending counts, invalidates the instance queries, refreshes transcripts', () => {
    const e = setup();
    e.qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession({ id: S2 })])));
    e.qc.setQueryData(qk.session(IID, S1), makeSessionDetail());
    e.qc.setQueryData(qk.instance(), { marker: 'boot' });
    e.r.ledger.put('session', makeSession({ seq: 4 }));
    applyChange(frames.sessionUpsert(makeSession({ id: S1, seq: 5 })), e.r.ctx);
    expect(e.r.pending.total()).toBe(1);
    e.r.resync('gap');
    expect(e.r.ledger.size).toBe(0);
    expect(e.r.pending.total()).toBe(0);
    expect(e.bufferHandle.clear).toHaveBeenCalledTimes(1);
    expect(e.transcripts.refreshAll).toHaveBeenCalledTimes(1);
    expect(invalidated(e.qc, LIST_KEY)).toBe(true);
    expect(invalidated(e.qc, qk.session(IID, S1))).toBe(true);
    expect(invalidated(e.qc, qk.instance())).toBe(false);
  });

  it('cancels the debounced work it makes redundant', () => {
    const e = setup();
    e.qc.setQueryData(qk.overview(IID), { marker: true });
    applyChange(frames.sessionUpsert(makeSession({ seq: 2 })), e.r.ctx);
    e.r.resync('reset');
    const spy = vi.spyOn(e.qc, 'invalidateQueries');
    vi.advanceTimersByTime(20_000);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('instance change', () => {
  it('clears every cached query except the boot query, which is invalidated for a refetch', () => {
    const e = setup();
    e.qc.setQueryData(qk.instance(), { marker: 'boot' });
    e.qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession()])));
    e.qc.setQueryData(qk.health(IID), makeHealth());
    e.qc.setQueryData(qk.health('99999999-9999-4999-8999-999999999999'), makeHealth());
    e.r.ledger.put('session', makeSession({ seq: 4 }));
    e.r.instanceChanged();
    expect(e.qc.getQueryData(LIST_KEY)).toBeUndefined();
    expect(e.qc.getQueryData(qk.health(IID))).toBeUndefined();
    expect(e.qc.getQueryData(qk.health('99999999-9999-4999-8999-999999999999'))).toBeUndefined();
    expect(e.qc.getQueryData(qk.instance())).toBeDefined();
    expect(invalidated(e.qc, qk.instance())).toBe(true);
    expect(e.r.ledger.size).toBe(0);
    expect(e.bufferHandle.clear).toHaveBeenCalled();
  });
});

describe('dispose', () => {
  it('leaves zero timers and runs nothing afterwards', () => {
    const e = setup();
    e.qc.setQueryData(qk.overview(IID), { marker: true });
    applyChange(frames.sessionUpsert(makeSession({ seq: 2 })), e.r.ctx);
    applyChange(frames.usage(), e.r.ctx);
    const withReconciler = vi.getTimerCount();
    e.r.dispose();
    expect(vi.getTimerCount()).toBeLessThan(withReconciler);
    // what is left are the garbage-collection timers of the query cache itself
    e.qc.clear();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(invalidated(e.qc, qk.overview(IID))).toBe(false);
  });
});

// ---- R4 late snapshot ------------------------------------------------------------------------------------------------------

describe('installLedgerReapply (R4)', () => {
  function withReapply() {
    const qc = createQueryClient({ retry: false });
    const ledger = createPatchLedger();
    const off = installLedgerReapply(qc, ledger, IID);
    return { qc, ledger, off };
  }

  it('a snapshot older than a patch cannot overwrite it (sessions list)', () => {
    const { qc, ledger, off } = withReapply();
    ledger.put('session', makeSession({ seq: 9, label: 'patched' }));
    qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession({ seq: 7, label: 'stale' })], { asOfSeq: 8 })));
    expect(labels(qc.getQueryData(LIST_KEY))).toEqual(['patched']);
    off();
  });

  it('keeps newer snapshot rows and evicts what the snapshot includes', () => {
    const { qc, ledger, off } = withReapply();
    ledger.put('session', makeSession({ seq: 9, label: 'patched' }));
    qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession({ seq: 12, label: 'newer' })], { asOfSeq: 12 })));
    expect(labels(qc.getQueryData(LIST_KEY))).toEqual(['newer']);
    expect(ledger.size).toBe(0);
    off();
  });

  it('protects the sidebar list, a detail (merged, detail fields kept), agents and the board', () => {
    const { qc, ledger, off } = withReapply();
    ledger.put('session', makeSession({ seq: 9, label: 'patched' }));
    ledger.put('agent', makeAgent({ seq: 9, label: 'agent patched' }));
    ledger.put('work_item', makeWorkItem({ seq: 9, title: 'item patched' }));
    qc.setQueryData(SIDEBAR_KEY, makeSessionPage([makeSession({ seq: 3, label: 'stale' })], { asOfSeq: 5 }));
    qc.setQueryData(
      qk.session(IID, S1),
      makeSessionDetail({ seq: 3, label: 'stale', cwd: '/fixture/cwd', asOfSeq: 5 }),
    );
    qc.setQueryData(
      qk.agents(IID, S1),
      infinite(makeAgentPage([makeAgent({ seq: 3, label: 'stale' })], { asOfSeq: 5 })),
    );
    qc.setQueryData(
      qk.workItems(IID),
      makeWorkItemBoard({ asOfSeq: 5, items: [makeWorkItem({ seq: 3, title: 'stale' })] }),
    );
    expect(qc.getQueryData<Page<SessionSummary>>(SIDEBAR_KEY)?.items[0]?.label).toBe('patched');
    const detail = qc.getQueryData<SessionDetail & { asOfSeq: number }>(qk.session(IID, S1));
    expect(detail?.label).toBe('patched');
    expect(detail?.cwd).toBe('/fixture/cwd');
    expect(detail?.asOfSeq).toBe(5);
    expect(qc.getQueryData<InfiniteData<Page<AgentNode>>>(qk.agents(IID, S1))?.pages[0]?.items[0]?.label).toBe(
      'agent patched',
    );
    expect(qc.getQueryData<WorkItemBoard>(qk.workItems(IID))?.items[0]?.title).toBe('item patched');
    off();
  });

  it('writes the cache once per snapshot (no update loop) and leaves unrelated queries alone', () => {
    const { qc, ledger, off } = withReapply();
    ledger.put('session', makeSession({ seq: 9, label: 'patched' }));
    const spy = vi.spyOn(qc, 'setQueryData');
    qc.setQueryData(qk.overview(IID), { marker: true });
    qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession({ seq: 7 })], { asOfSeq: 8 })));
    // two calls above plus exactly one corrective write
    expect(spy).toHaveBeenCalledTimes(3);
    off();
  });

  it('stops reapplying after uninstall', () => {
    const { qc, ledger, off } = withReapply();
    off();
    ledger.put('session', makeSession({ seq: 9, label: 'patched' }));
    qc.setQueryData(LIST_KEY, infinite(makeSessionPage([makeSession({ seq: 7, label: 'stale' })], { asOfSeq: 8 })));
    expect(labels(qc.getQueryData(LIST_KEY))).toEqual(['stale']);
  });

  it('ignores a cache value that is not the expected shape', () => {
    const { qc, ledger, off } = withReapply();
    ledger.put('session', makeSession({ seq: 9, label: 'patched' }));
    expect(() => {
      qc.setQueryData(LIST_KEY, { weird: true });
      qc.setQueryData(SIDEBAR_KEY, 'text');
    }).not.toThrow();
    off();
  });
});
