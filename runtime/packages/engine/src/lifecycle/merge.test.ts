// The join-semilattice laws (02 7.2, ADR 0018) on hand-built examples, the register semantics, and the in-memory model
// that folds events into facts and rows.
import type { Stamp } from '@mcs/shared/protocol';
import { describe, expect, it } from 'vitest';

import type { LogicalEvent } from '../ingest/event-row.ts';
import {
  agentFactsWith,
  emptyAgentFacts,
  emptySessionFacts,
  emptyToolCallRow,
  emptyWorkflowFacts,
  sessionFactsWith,
  workflowFactsWith,
  type AgentFacts,
  type Lww,
  type SessionFacts,
  type ToolCallRow,
  type WorkflowFacts,
} from './facts.ts';
import {
  PERMISSIONS_KEPT,
  agentFactsOf,
  applyEvent,
  emptyModel,
  joinLww,
  joinStamp,
  mergeAgentFacts,
  mergeFacts,
  mergeModels,
  mergeSessionFacts,
  mergeToolCallRow,
  mergeWorkflowFacts,
  workflowFactsOf,
  type EventOrigin,
} from './merge.ts';

const SID = '22222222-2222-4222-8222-222222222222';
const st = (at: number, rank = 0, tie = ''): Stamp => ({ at, rank, tie });
const lww = <T>(stamp: Stamp, value: T): Lww<T> => ({ stamp, value });

/** Checks commutativity, associativity and idempotence over every ordered pair and triple of the samples. */
function expectSemilattice<T>(samples: readonly T[], join: (a: T, b: T) => T): void {
  for (const a of samples) {
    expect(join(a, a)).toEqual(a);
    for (const b of samples) {
      expect(join(a, b)).toEqual(join(b, a));
      for (const c of samples) {
        expect(join(join(a, b), c)).toEqual(join(a, join(b, c)));
      }
    }
  }
}

describe('joinStamp and joinLww', () => {
  it('joinStamp keeps the greater stamp and treats null as the neutral element', () => {
    expect(joinStamp(null, null)).toBeNull();
    expect(joinStamp(st(1), null)).toEqual(st(1));
    expect(joinStamp(null, st(2))).toEqual(st(2));
    expect(joinStamp(st(1, 5), st(1, 6))).toEqual(st(1, 6));
    expect(joinStamp(st(1, 5, 'a'), st(1, 5, 'b'))).toEqual(st(1, 5, 'b'));
    expectSemilattice([null, st(1), st(2), st(2, 1), st(2, 1, 'x')], joinStamp);
  });

  it('joinLww keeps the greater stamp; equal stamps tie-break on the JSON of the value, in both orders', () => {
    expect(joinLww(lww(st(1), 'a'), lww(st(2), 'b'))).toEqual(lww(st(2), 'b'));
    expect(joinLww(lww(st(2), 'b'), lww(st(1), 'a'))).toEqual(lww(st(2), 'b'));
    expect(joinLww(lww(st(1), 'a'), lww(st(1), 'b'))).toEqual(lww(st(1), 'b'));
    expect(joinLww(lww(st(1), 'b'), lww(st(1), 'a'))).toEqual(lww(st(1), 'b'));
    expect(joinLww<string>(null, null)).toBeNull();
    expectSemilattice<Lww<string> | null>(
      [null, lww(st(1), 'a'), lww(st(1), 'b'), lww(st(2), 'a'), lww(st(2, 1), 'a')],
      joinLww,
    );
  });
});

const SESSION_SAMPLES: readonly SessionFacts[] = [
  emptySessionFacts(),
  sessionFactsWith({ firstSeenAt: 100, lastHookAt: 500, hasRecords: true, lastActivity: st(500, 30) }),
  sessionFactsWith({
    firstSeenAt: 50,
    lastPromptHook: st(200, 10),
    lastTurnEndHook: lww(st(300, 60), {
      kind: 'stop',
      promptId: null,
      error: null,
      backgroundTasks: null,
      pendingBackgroundAgents: null,
      pendingWorkflows: null,
    }),
    starts: { startup: st(10), resume: st(400) },
    end: { stamp: st(600, 90), reason: 'other' },
  }),
  sessionFactsWith({
    end: { stamp: st(700, 90), reason: 'logout' },
    permissions: { h1: { requested: st(100, 22), resolved: null }, h2: { requested: null, resolved: st(150, 30) } },
    notifications: { idle_prompt: st(250, 50) },
    attempt: lww(st(800, 1, 'attempt:1'), {
      state: 'COMPLETED' as const,
      evidence: 'e',
      rowKey: 'attempt:1',
      endedAt: 790,
    }),
  }),
  sessionFactsWith({
    permissions: { h1: { requested: st(120, 22), resolved: st(130, 30) } },
    attempt: lww(st(800, 0, ''), null),
    claudePid: lww(st(5), 4242),
    pid: lww(st(900), { pid: 4242, alive: false }),
    hookHandlerErrors: 3,
    legacy: {
      lastStop: lww(st(1), 'end_turn'),
      fileFirstTs: '2026-01-01T00:00:00Z',
      fileMaxTs: '2026-01-01T00:10:00Z',
    },
  }),
];

describe('mergeSessionFacts', () => {
  it('is a semilattice join on the samples (commutative, associative, idempotent)', () => {
    expectSemilattice(SESSION_SAMPLES, mergeSessionFacts);
  });

  it('has the empty facts as its neutral element', () => {
    for (const facts of SESSION_SAMPLES) {
      expect(mergeSessionFacts(facts, emptySessionFacts())).toEqual(facts);
      expect(mergeSessionFacts(emptySessionFacts(), facts)).toEqual(facts);
    }
  });

  it('mergeFacts is the session join', () => {
    expect(mergeFacts).toBe(mergeSessionFacts);
  });

  it('keeps Min / Max / Or semantics on the scalar registers', () => {
    const a = sessionFactsWith({ firstSeenAt: 100, lastHookAt: 10, transcriptMtime: 5, hasRecords: false });
    const b = sessionFactsWith({ firstSeenAt: 50, lastHookAt: 20, transcriptMtime: 3, hasRecords: true });
    expect(mergeSessionFacts(a, b)).toMatchObject({
      firstSeenAt: 50,
      lastHookAt: 20,
      transcriptMtime: 5,
      hasRecords: true,
    });
  });

  it('end is last-writer-wins by stamp: the later SessionEnd wins in both orders', () => {
    const early = sessionFactsWith({ end: { stamp: st(10, 90), reason: 'a' } });
    const late = sessionFactsWith({ end: { stamp: st(20, 90), reason: 'b' } });
    expect(mergeSessionFacts(early, late).end).toEqual({ stamp: st(20, 90), reason: 'b' });
    expect(mergeSessionFacts(late, early).end).toEqual({ stamp: st(20, 90), reason: 'b' });
  });

  it('permissions and starts join pointwise', () => {
    const a = sessionFactsWith({
      permissions: { h1: { requested: st(1), resolved: null } },
      starts: { startup: st(1) },
    });
    const b = sessionFactsWith({
      permissions: { h1: { requested: null, resolved: st(2) }, h2: { requested: st(3), resolved: null } },
      starts: { startup: st(5), resume: st(2) },
    });
    const m = mergeSessionFacts(a, b);
    expect(m.permissions).toEqual({
      h1: { requested: st(1), resolved: st(2) },
      h2: { requested: st(3), resolved: null },
    });
    expect(m.starts).toEqual({ startup: st(5), resume: st(2) });
  });

  it('keeps only the 64 newest permissions by requested time, deterministically', () => {
    const many: Record<string, { requested: Stamp | null; resolved: Stamp | null }> = {};
    for (let i = 0; i < PERMISSIONS_KEPT + 6; i += 1)
      many[`h${String(i).padStart(3, '0')}`] = { requested: st(1000 + i), resolved: null };
    const merged = mergeSessionFacts(sessionFactsWith({ permissions: many }), emptySessionFacts());
    const keys = Object.keys(merged.permissions);
    expect(keys).toHaveLength(PERMISSIONS_KEPT);
    expect(keys).not.toContain('h000');
    expect(keys).toContain(`h${String(PERMISSIONS_KEPT + 5).padStart(3, '0')}`);
    expect(mergeSessionFacts(emptySessionFacts(), sessionFactsWith({ permissions: many })).permissions).toEqual(
      merged.permissions,
    );
  });

  it('a cleared attempt (rank 0) loses to a same-tick republish (rank 1) and to a later one, but beats an older one (I-18)', () => {
    const attempt = lww(st(100, 1, 'attempt:1'), {
      state: 'FAILED' as const,
      evidence: 'x',
      rowKey: 'attempt:1',
      endedAt: 90,
    });
    const cleared = lww(st(100, 0, ''), null);
    const older = lww(st(50, 1, 'attempt:1'), { ...attempt.value, state: 'COMPLETED' as const });
    const later = lww(st(150, 1, 'attempt:1'), attempt.value);
    const mergeAttempts = (x: SessionFacts['attempt'], y: SessionFacts['attempt']): SessionFacts['attempt'] =>
      mergeSessionFacts(sessionFactsWith({ attempt: x }), sessionFactsWith({ attempt: y })).attempt;
    expect(mergeAttempts(attempt, cleared)).toEqual(attempt);
    expect(mergeAttempts(cleared, attempt)).toEqual(attempt);
    expect(mergeAttempts(older, cleared)).toEqual(cleared);
    expect(mergeAttempts(cleared, later)).toEqual(later);
    expect(mergeAttempts(cleared, older)).toEqual(cleared);
  });

  it('the legacy parity inputs join as LWW, Min string and Max string', () => {
    const a = sessionFactsWith({
      legacy: { lastStop: lww(st(1), 'tool_use'), fileFirstTs: '2026-02-01', fileMaxTs: '2026-02-05' },
    });
    const b = sessionFactsWith({
      legacy: { lastStop: lww(st(2), 'end_turn'), fileFirstTs: '2026-01-01', fileMaxTs: '2026-02-03' },
    });
    expect(mergeSessionFacts(a, b).legacy).toEqual({
      lastStop: lww(st(2), 'end_turn'),
      fileFirstTs: '2026-01-01',
      fileMaxTs: '2026-02-05',
    });
  });
});

const AGENT_SAMPLES: readonly AgentFacts[] = [
  emptyAgentFacts(),
  agentFactsWith({ started: st(10, 40), lastActivity: st(12), fileMtime: 100, journal: 'started' }),
  agentFactsWith({
    stopped: st(20, 44),
    kind: 'workflow_agent',
    journal: 'result',
    notification: lww(st(30), 'completed' as const),
  }),
  agentFactsWith({ journal: 'failed', kind: 'internal', link: lww(st(5), 'async_launched'), hasRecords: true }),
  agentFactsWith({ notification: lww(st(30), 'failed' as const), final: st(25) }),
];

describe('mergeAgentFacts', () => {
  it('is a semilattice join with the empty facts as neutral element', () => {
    expectSemilattice(AGENT_SAMPLES, mergeAgentFacts);
    for (const facts of AGENT_SAMPLES) expect(mergeAgentFacts(facts, emptyAgentFacts())).toEqual(facts);
  });

  it('the journal joins started < result < failed', () => {
    const j = (journal: AgentFacts['journal']): AgentFacts => agentFactsWith({ journal });
    expect(mergeAgentFacts(j('started'), j('result')).journal).toBe('result');
    expect(mergeAgentFacts(j('result'), j('failed')).journal).toBe('failed');
    expect(mergeAgentFacts(j('failed'), j('started')).journal).toBe('failed');
    expect(mergeAgentFacts(j(null), j('started')).journal).toBe('started');
  });

  it('the kind joins subagent < workflow_agent < internal', () => {
    const k = (kind: AgentFacts['kind']): AgentFacts => emptyAgentFacts(kind);
    expect(mergeAgentFacts(k('subagent'), k('workflow_agent')).kind).toBe('workflow_agent');
    expect(mergeAgentFacts(k('internal'), k('workflow_agent')).kind).toBe('internal');
  });
});

const WORKFLOW_SAMPLES: readonly WorkflowFacts[] = [
  emptyWorkflowFacts(),
  workflowFactsWith({ launched: st(5), started: 2, agentCount: 3 }),
  workflowFactsWith({ fileStatus: lww(st(50), 'completed'), results: 2, failed: 1, lastAgentActivity: 40 }),
  workflowFactsWith({ fileStatus: lww(st(40), 'running'), started: 3, lastAgentActivity: 45, agentCount: 4 }),
];

describe('mergeWorkflowFacts', () => {
  it('is a semilattice join with the empty facts as neutral element', () => {
    expectSemilattice(WORKFLOW_SAMPLES, mergeWorkflowFacts);
    for (const facts of WORKFLOW_SAMPLES) expect(mergeWorkflowFacts(facts, emptyWorkflowFacts())).toEqual(facts);
  });

  it('counters and activity join as Max, the file status as LWW', () => {
    const m = mergeWorkflowFacts(
      WORKFLOW_SAMPLES[2] ?? emptyWorkflowFacts(),
      WORKFLOW_SAMPLES[3] ?? emptyWorkflowFacts(),
    );
    expect(m).toMatchObject({ started: 3, results: 2, failed: 1, agentCount: 4, lastAgentActivity: 45 });
    expect(m.fileStatus).toEqual(lww(st(50), 'completed'));
  });
});

const ROW_SAMPLES: readonly ToolCallRow[] = [
  emptyToolCallRow('t1'),
  { ...emptyToolCallRow('t1'), name: 'Bash', startedAt: 100, inputHash: 'h1', transcriptUse: true },
  { ...emptyToolCallRow('t1'), startedAt: 90, endedAt: 200, outcome: 'ok', transcriptResult: true },
  { ...emptyToolCallRow('t1'), endedAt: 210, batchAt: 220, outcome: 'error', agentId: 'a1' },
  { ...emptyToolCallRow('t1'), outcome: 'denied', link: lww(st(5), 'async_launched'), name: 'unknown' },
  { ...emptyToolCallRow('t1'), outcome: 'interrupted', inputHash: 'h0', name: 'Agent' },
];

describe('mergeToolCallRow', () => {
  it('is a semilattice join with the empty row as neutral element', () => {
    expectSemilattice(ROW_SAMPLES, mergeToolCallRow);
    for (const row of ROW_SAMPLES) expect(mergeToolCallRow(row, emptyToolCallRow('t1'))).toEqual(row);
  });

  it('startedAt is Min, endedAt and batchAt are Max, the outcome follows error > denied > interrupted > ok', () => {
    const a: ToolCallRow = { ...emptyToolCallRow('t'), startedAt: 100, endedAt: 150, outcome: 'ok' };
    const b: ToolCallRow = {
      ...emptyToolCallRow('t'),
      startedAt: 90,
      endedAt: 160,
      batchAt: 170,
      outcome: 'interrupted',
    };
    expect(mergeToolCallRow(a, b)).toMatchObject({ startedAt: 90, endedAt: 160, batchAt: 170, outcome: 'interrupted' });
    const order = ['ok', 'interrupted', 'denied', 'error'] as const;
    for (let i = 0; i < order.length; i += 1) {
      for (let j = 0; j < order.length; j += 1) {
        const x = { ...emptyToolCallRow('t'), outcome: order[i] ?? null };
        const y = { ...emptyToolCallRow('t'), outcome: order[j] ?? null };
        expect(mergeToolCallRow(x, y).outcome).toBe(order[Math.max(i, j)]);
      }
    }
  });

  it('a placeholder name never beats a real one, and a known agent id beats the main agent', () => {
    expect(
      mergeToolCallRow({ ...emptyToolCallRow('t'), name: 'unknown' }, { ...emptyToolCallRow('t'), name: 'Bash' }).name,
    ).toBe('Bash');
    expect(mergeToolCallRow({ ...emptyToolCallRow('t'), agentId: 'a1' }, emptyToolCallRow('t')).agentId).toBe('a1');
  });
});

// ---- the model -----------------------------------------------------------------------------------------------------

interface Tagged {
  readonly event: LogicalEvent;
  readonly origin: EventOrigin;
}

const hookEvents: readonly Tagged[] = [
  { event: { k: 'session.seen', sessionId: SID, stamp: st(1000, 0, 'e1'), claudePid: 77 }, origin: 'hook' },
  { event: { k: 'session.start', sessionId: SID, stamp: st(1000, 0, 'e1'), startSource: 'startup' }, origin: 'hook' },
  {
    event: {
      k: 'turn.prompt',
      sessionId: SID,
      agentId: null,
      promptId: 'p1',
      stamp: st(2000, 10, 'e2'),
      origin: 'hook',
    },
    origin: 'hook',
  },
  {
    event: {
      k: 'tool.start',
      sessionId: SID,
      agentId: null,
      promptId: 'p1',
      toolUseId: 't1',
      name: 'Agent',
      stamp: st(3000, 20, 'e3'),
      inputHash: 'h1',
    },
    origin: 'hook',
  },
  {
    event: {
      k: 'agent.link',
      sessionId: SID,
      agentId: 'a1',
      toolUseId: 't1',
      status: 'completed',
      stamp: st(5000, 30, 'e5'),
    },
    origin: 'hook',
  },
  {
    event: { k: 'agent.start', sessionId: SID, agentId: 'a1', agentType: 'general', stamp: st(3100, 40, 'e4') },
    origin: 'hook',
  },
  {
    event: {
      k: 'agent.notification',
      sessionId: SID,
      toolUseId: 't1',
      taskId: null,
      status: 'completed',
      stamp: st(4000, 20, 'e6'),
    },
    origin: 'transcript',
  },
  {
    event: { k: 'tool.end', sessionId: SID, agentId: null, toolUseId: 't1', stamp: st(5000, 30, 'e5'), outcome: 'ok' },
    origin: 'hook',
  },
  {
    event: {
      k: 'workflow.status',
      sessionId: SID,
      runId: 'wf_1',
      observedAt: 6000,
      fileStatus: 'completed',
      started: 1,
      results: 1,
      failed: 0,
    },
    origin: 'transcript',
  },
  {
    event: { k: 'agent.meta', sessionId: SID, agentId: 'a1', workflowRunId: 'wf_1', spawnToolUseId: 't1' },
    origin: 'transcript',
  },
  {
    event: { k: 'activity', sessionId: SID, agentId: 'a1', stamp: st(4500, 20, 'e7'), via: 'assistant' },
    origin: 'transcript',
  },
];

function fold(events: readonly Tagged[]): ReturnType<typeof emptyModel> {
  return events.reduce((model, { event, origin }) => applyEvent(model, event, origin), emptyModel());
}

describe('the model (applyEvent, mergeModels)', () => {
  it('applying an event twice equals applying it once (P1)', () => {
    const once = fold(hookEvents);
    const twice = fold([...hookEvents, ...hookEvents]);
    expect(twice).toEqual(once);
    for (const { event, origin } of hookEvents) {
      expect(applyEvent(applyEvent(once, event, origin), event, origin)).toEqual(once);
    }
  });

  it('any order of the events gives the same model (P2)', () => {
    const forward = fold(hookEvents);
    expect(fold([...hookEvents].reverse())).toEqual(forward);
    for (let rotate = 1; rotate < hookEvents.length; rotate += 1) {
      expect(fold([...hookEvents.slice(rotate), ...hookEvents.slice(0, rotate)])).toEqual(forward);
    }
  });

  it('mergeModels of two halves equals the model of all events, in both orders and with itself', () => {
    const whole = fold(hookEvents);
    const left = fold(hookEvents.slice(0, 5));
    const right = fold(hookEvents.slice(5));
    expect(mergeModels(left, right)).toEqual(whole);
    expect(mergeModels(right, left)).toEqual(whole);
    expect(mergeModels(whole, whole)).toEqual(whole);
    expect(mergeModels(whole, emptyModel())).toEqual(whole);
  });

  it('routes each event to the session, the rows, the agent and the workflow it concerns', () => {
    const model = fold(hookEvents);
    expect(model.session.lastHookAt).toBe(5000);
    expect(model.session.claudePid?.value).toBe(77);
    expect(model.tools['t1']).toMatchObject({
      name: 'Agent',
      startedAt: 3000,
      endedAt: 5000,
      outcome: 'ok',
      inputHash: 'h1',
    });
    expect(model.tools['t1']?.link?.value).toBe('completed');
    expect(model.agents['a1']?.started).toEqual(st(3100, 40, 'e4'));
    expect(model.agents['a1']?.link?.value).toBe('completed');
    expect(model.workflows['wf_1']).toMatchObject({ started: 1, results: 1 });
    expect(model.spawns).toEqual({ t1: 'a1' });
    expect(model.agentRuns).toEqual({ a1: 'wf_1' });
  });

  it('joins the task notification to its agent through the spawn call, whatever the arrival order', () => {
    const notification = hookEvents.find((t) => t.event.k === 'agent.notification');
    const link = hookEvents.find((t) => t.event.k === 'agent.link');
    if (notification === undefined || link === undefined) throw new Error('fixture');
    const notificationFirst = fold([notification, link]);
    const linkFirst = fold([link, notification]);
    expect(notificationFirst).toEqual(linkFirst);
    expect(agentFactsOf(linkFirst, 'a1').notification).toEqual(lww(st(4000, 20, 'e6'), 'completed'));
    expect(agentFactsOf(fold([notification]), 'a1').notification).toBeNull();
  });

  it('agentFactsOf marks an agent of a workflow run and workflowFactsOf collects the activity of its agents', () => {
    const model = fold(hookEvents);
    expect(agentFactsOf(model, 'a1').kind).toBe('workflow_agent');
    expect(agentFactsOf(model, 'nobody')).toEqual(emptyAgentFacts());
    const wf = workflowFactsOf(model, 'wf_1');
    expect(wf.lastAgentActivity).toBe(4500);
    expect(wf.agentCount).toBe(1);
    expect(workflowFactsOf(model, 'wf_none')).toEqual(emptyWorkflowFacts());
  });

  it('ignores a notification without a status or a spawn call', () => {
    const model = applyEvent(
      emptyModel(),
      { k: 'agent.notification', sessionId: SID, toolUseId: null, taskId: 'x', status: 'completed', stamp: st(1) },
      'transcript',
    );
    expect(model.notifications).toEqual({});
    expect(model.agents).toEqual({});
    expect(model.spawns).toEqual({});
    const noStatus = applyEvent(
      emptyModel(),
      { k: 'agent.notification', sessionId: SID, toolUseId: 't9', taskId: null, status: null, stamp: st(1) },
      'transcript',
    );
    expect(noStatus.notifications).toEqual({});
  });
});
