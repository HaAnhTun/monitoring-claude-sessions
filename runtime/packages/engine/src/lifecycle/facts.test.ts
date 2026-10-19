// The table "logical event -> fact update" of 02 7.3 (one test per row) plus the constructors.
import type { Stamp } from '@mcs/shared/protocol';
import { describe, expect, it } from 'vitest';

import type { LogicalEvent } from '../ingest/event-row.ts';
import { agentFactsOf, applyEvent, emptyModel, workflowFactsOf } from './merge.ts';
import {
  agentFactsOfEvent,
  emptyAgentFacts,
  emptySessionFacts,
  emptyToolCallRow,
  emptyWorkflowFacts,
  parseAgentFacts,
  parseSessionFacts,
  parseToolCallRow,
  parseWorkflowFacts,
  sessionFactsOfEvent,
  sessionFactsWith,
  toolRowsOfEvent,
  workflowFactsOfEvent,
} from './facts.ts';

const SID = '22222222-2222-4222-8222-222222222222';
const st = (at: number, rank = 0, tie = ''): Stamp => ({ at, rank, tie });

describe('constructors', () => {
  it('start from empty registers and are JSON-safe', () => {
    const facts = emptySessionFacts();
    expect(JSON.parse(JSON.stringify(facts))).toEqual(facts);
    expect(facts.v).toBe(1);
    expect(facts.permissions).toEqual({});
    expect(emptyAgentFacts().kind).toBe('subagent');
    expect(emptyAgentFacts('internal').kind).toBe('internal');
    expect(emptyWorkflowFacts().started).toBe(0);
    expect(emptyToolCallRow('t1').toolUseId).toBe('t1');
    expect(sessionFactsWith({ hasRecords: true }).hasRecords).toBe(true);
  });
});

describe('session facts of an event (02 7.3)', () => {
  it('session.seen: firstSeenAt Min, lastHookAt from a hook, claudePid LWW', () => {
    const event: LogicalEvent = { k: 'session.seen', sessionId: SID, stamp: st(1000, 0, 'e1'), claudePid: 4242 };
    const facts = sessionFactsOfEvent(event, 'hook');
    expect(facts?.firstSeenAt).toBe(1000);
    expect(facts?.lastHookAt).toBe(1000);
    expect(facts?.claudePid).toEqual({ stamp: st(1000, 0, 'e1'), value: 4242 });
    const bare = sessionFactsOfEvent({ k: 'session.seen', sessionId: SID, stamp: st(5) }, 'hook');
    expect(bare?.claudePid).toBeNull();
  });

  it('a transcript event never sets lastHookAt', () => {
    const facts = sessionFactsOfEvent(
      { k: 'activity', sessionId: SID, agentId: null, stamp: st(7), via: 'user' },
      'transcript',
    );
    expect(facts?.lastHookAt).toBeNull();
    expect(facts?.firstSeenAt).toBe(7);
  });

  it('session.start: starts[source] Max, an unknown source is other', () => {
    expect(
      sessionFactsOfEvent({ k: 'session.start', sessionId: SID, stamp: st(10), startSource: 'resume' }, 'hook')?.starts,
    ).toEqual({ resume: st(10) });
    expect(
      sessionFactsOfEvent({ k: 'session.start', sessionId: SID, stamp: st(10), startSource: 'weird' }, 'hook')?.starts,
    ).toEqual({ other: st(10) });
  });

  it('session.end: end register', () => {
    expect(
      sessionFactsOfEvent({ k: 'session.end', sessionId: SID, stamp: st(20, 90), reason: 'other' }, 'hook')?.end,
    ).toEqual({ stamp: st(20, 90), reason: 'other' });
  });

  it('turn.prompt (main): lastPromptHook or lastPromptTx by origin, and lastActivity', () => {
    const event: LogicalEvent = {
      k: 'turn.prompt',
      sessionId: SID,
      agentId: null,
      promptId: 'p1',
      stamp: st(30, 10),
      origin: 'hook',
    };
    const hook = sessionFactsOfEvent(event, 'hook');
    expect(hook?.lastPromptHook).toEqual(st(30, 10));
    expect(hook?.lastPromptTx).toBeNull();
    expect(hook?.lastActivity).toEqual(st(30, 10));
    const tx = sessionFactsOfEvent({ ...event, origin: 'user' }, 'transcript');
    expect(tx?.lastPromptTx).toEqual(st(30, 10));
    expect(tx?.lastPromptHook).toBeNull();
  });

  it('turn.prompt of an agent is not a session fact', () => {
    expect(
      sessionFactsOfEvent(
        { k: 'turn.prompt', sessionId: SID, agentId: 'a1', promptId: null, stamp: st(1), origin: 'hook' },
        'hook',
      ),
    ).toBeNull();
  });

  it('turn.end (main): the hook register for Stop, the transcript register for end_turn and turn_duration', () => {
    const stop = sessionFactsOfEvent(
      {
        k: 'turn.end',
        sessionId: SID,
        agentId: null,
        promptId: 'p',
        stamp: st(40, 60),
        kind: 'stop',
        backgroundTasks: 2,
      },
      'hook',
    );
    expect(stop?.lastTurnEndHook).toEqual({
      stamp: st(40, 60),
      value: {
        kind: 'stop',
        promptId: 'p',
        error: null,
        backgroundTasks: 2,
        pendingBackgroundAgents: null,
        pendingWorkflows: null,
      },
    });
    expect(stop?.lastTurnEndTx).toBeNull();
    const duration = sessionFactsOfEvent(
      {
        k: 'turn.end',
        sessionId: SID,
        agentId: null,
        promptId: null,
        stamp: st(41, 61),
        kind: 'turn_duration',
        pendingBackgroundAgents: 1,
        pendingWorkflows: 2,
      },
      'transcript',
    );
    expect(duration?.lastTurnEndTx?.value).toMatchObject({
      kind: 'turn_duration',
      pendingBackgroundAgents: 1,
      pendingWorkflows: 2,
    });
    expect(duration?.lastTurnEndHook).toBeNull();
    const failure = sessionFactsOfEvent(
      {
        k: 'turn.end',
        sessionId: SID,
        agentId: null,
        promptId: null,
        stamp: st(42, 60),
        kind: 'stop_failure',
        error: 'rate_limit',
      },
      'hook',
    );
    expect(failure?.lastTurnEndHook?.value).toMatchObject({ kind: 'stop_failure', error: 'rate_limit' });
  });

  it('interrupt: lastInterrupt Max', () => {
    expect(
      sessionFactsOfEvent(
        { k: 'interrupt', sessionId: SID, agentId: null, stamp: st(50), via: 'user_marker' },
        'transcript',
      )?.lastInterrupt,
    ).toEqual(st(50));
  });

  it('tool.start, tool.end and tool.batch: lastActivity Max (the main agent only for start and end)', () => {
    const start: LogicalEvent = {
      k: 'tool.start',
      sessionId: SID,
      agentId: null,
      promptId: null,
      toolUseId: 't1',
      name: 'Bash',
      stamp: st(60, 20),
    };
    expect(sessionFactsOfEvent(start, 'hook')?.lastActivity).toEqual(st(60, 20));
    expect(sessionFactsOfEvent({ ...start, agentId: 'a1' }, 'hook')).toBeNull();
    expect(
      sessionFactsOfEvent(
        { k: 'tool.end', sessionId: SID, agentId: null, toolUseId: 't1', stamp: st(61, 30), outcome: 'ok' },
        'hook',
      )?.lastActivity,
    ).toEqual(st(61, 30));
    expect(
      sessionFactsOfEvent(
        { k: 'tool.batch', sessionId: SID, promptId: null, toolUseIds: ['t1'], stamp: st(62, 34) },
        'hook',
      )?.lastActivity,
    ).toEqual(st(62, 34));
  });

  it('permission.request: permissions[hash].requested', () => {
    expect(
      sessionFactsOfEvent(
        {
          k: 'permission.request',
          sessionId: SID,
          promptId: null,
          toolName: 'Bash',
          inputHash: 'h1',
          stamp: st(70, 22),
        },
        'hook',
      )?.permissions,
    ).toEqual({ h1: { requested: st(70, 22), resolved: null } });
  });

  it('notification: notifications[type] Max', () => {
    expect(
      sessionFactsOfEvent({ k: 'notification', sessionId: SID, type: 'idle_prompt', stamp: st(80, 50) }, 'hook')
        ?.notifications,
    ).toEqual({ idle_prompt: st(80, 50) });
  });

  it('activity (main): lastActivity, and hasRecords only from a transcript record', () => {
    const base: LogicalEvent = { k: 'activity', sessionId: SID, agentId: null, stamp: st(90), via: 'hook' };
    expect(sessionFactsOfEvent(base, 'hook')?.hasRecords).toBe(false);
    expect(sessionFactsOfEvent({ ...base, via: 'assistant' }, 'transcript')?.hasRecords).toBe(true);
    expect(sessionFactsOfEvent({ ...base, agentId: 'a1' }, 'hook')).toBeNull();
  });

  it('api_error and assistant.ok (main): lastApiError and lastAssistantOk', () => {
    expect(
      sessionFactsOfEvent({ k: 'api_error', sessionId: SID, agentId: null, stamp: st(100) }, 'transcript')
        ?.lastApiError,
    ).toEqual(st(100));
    expect(
      sessionFactsOfEvent({ k: 'assistant.ok', sessionId: SID, agentId: null, stamp: st(101) }, 'transcript')
        ?.lastAssistantOk,
    ).toEqual(st(101));
    expect(
      sessionFactsOfEvent({ k: 'api_error', sessionId: SID, agentId: 'a1', stamp: st(100) }, 'transcript'),
    ).toBeNull();
  });

  it('compaction counts as activity', () => {
    expect(
      sessionFactsOfEvent({ k: 'compaction', sessionId: SID, stamp: st(110, 53), trigger: 'auto' }, 'hook')
        ?.lastActivity,
    ).toEqual(st(110, 53));
  });

  it('cost_state contributes no fact: the trailing flag is an input of the derivation, not a register (CR-WP-28-2)', () => {
    const event: LogicalEvent = {
      k: 'cost_state',
      sessionId: SID,
      fileId: 1,
      byteOffset: 4096,
      totalCostUsd: 0.5,
      modelUsage: {},
    };
    for (const origin of ['hook', 'transcript', 'external'] as const) {
      expect(sessionFactsOfEvent(event, origin)).toBeNull();
    }
    const model = applyEvent(emptyModel(), event, 'transcript');
    expect(model.session.costStateTrailing).toBeNull();
    expect(model).toEqual(emptyModel());
  });

  it('hook.handler_error contributes no fact: the health counts its events row, not a Max register (CR-WP-28-2)', () => {
    const event: LogicalEvent = {
      k: 'hook.handler_error',
      sessionId: SID,
      hookEvent: 'Stop',
      exitCode: 1,
      stamp: st(120),
    };
    for (const origin of ['hook', 'transcript', 'external'] as const) {
      expect(sessionFactsOfEvent(event, origin)).toBeNull();
    }
    const model = applyEvent(emptyModel(), event, 'transcript');
    expect(model.session.hookHandlerErrors).toBe(0);
    expect(model).toEqual(emptyModel());
  });

  it('external.registry, external.job and external.pid: LWW registers stamped by observation time', () => {
    expect(
      sessionFactsOfEvent(
        {
          k: 'external.registry',
          sessionId: SID,
          status: 'waiting',
          waitingFor: 'permission',
          pid: 9,
          pidAlive: true,
          observedAt: 130,
        },
        'external',
      )?.registry,
    ).toEqual({ stamp: st(130), value: { status: 'waiting', waitingFor: 'permission', pid: 9, pidAlive: true } });
    expect(
      sessionFactsOfEvent(
        { k: 'external.job', sessionId: SID, jobId: 'j1', state: 'done', observedAt: 131 },
        'external',
      )?.job,
    ).toEqual({ stamp: st(131), value: { jobId: 'j1', state: 'done' } });
    expect(
      sessionFactsOfEvent({ k: 'external.pid', sessionId: SID, pid: 9, alive: false, checkedAt: 132 }, 'external')?.pid,
    ).toEqual({ stamp: st(132), value: { pid: 9, alive: false } });
  });

  it('external events never move firstSeenAt or lastHookAt', () => {
    const facts = sessionFactsOfEvent(
      { k: 'external.pid', sessionId: SID, pid: 9, alive: true, checkedAt: 5 },
      'external',
    );
    expect(facts?.firstSeenAt).toBeNull();
    expect(facts?.lastHookAt).toBeNull();
  });

  it('external.attempt: rank 1 and the row key as tie; external.attempt_cleared: rank 0 and a null value (I-18)', () => {
    const attempt = sessionFactsOfEvent(
      {
        k: 'external.attempt',
        sessionId: SID,
        state: 'COMPLETED',
        evidence: 'chain log: exit=0 status=PASS',
        rowKey: 'attempt:7',
        endedAt: 200,
        observedAt: 210,
      },
      'external',
    );
    expect(attempt?.attempt).toEqual({
      stamp: st(210, 1, 'attempt:7'),
      value: { state: 'COMPLETED', evidence: 'chain log: exit=0 status=PASS', rowKey: 'attempt:7', endedAt: 200 },
    });
    const cleared = sessionFactsOfEvent({ k: 'external.attempt_cleared', sessionId: SID, observedAt: 210 }, 'external');
    expect(cleared?.attempt).toEqual({ stamp: st(210, 0, ''), value: null });
  });

  it('events that carry no session fact give null', () => {
    expect(
      sessionFactsOfEvent({ k: 'title', sessionId: SID, source: 'ai', value: 't', order: 1 }, 'transcript'),
    ).toBeNull();
    expect(sessionFactsOfEvent({ k: 'session.continued_in', sessionId: SID, target: 'x' }, 'transcript')).toBeNull();
    expect(
      sessionFactsOfEvent({ k: 'agent.meta', sessionId: SID, agentId: 'a1', description: 'd' }, 'transcript'),
    ).toBeNull();
  });
});

describe('agent facts of an event (02 7.3)', () => {
  it('agent.start, agent.stop and agent.final: Max registers', () => {
    expect(
      agentFactsOfEvent({ k: 'agent.start', sessionId: SID, agentId: 'a1', agentType: 'x', stamp: st(1, 40) }, 'hook'),
    ).toEqual({
      agentId: 'a1',
      facts: { ...emptyAgentFacts(), started: st(1, 40) },
    });
    expect(
      agentFactsOfEvent({ k: 'agent.stop', sessionId: SID, agentId: 'a1', agentType: 'x', stamp: st(2, 44) }, 'hook')
        ?.facts.stopped,
    ).toEqual(st(2, 44));
    expect(
      agentFactsOfEvent(
        { k: 'agent.final', sessionId: SID, agentId: 'a1', stamp: st(3), via: 'structured_output' },
        'transcript',
      )?.facts.final,
    ).toEqual(st(3));
  });

  it('agent.link: the link register of the agent the link names', () => {
    expect(
      agentFactsOfEvent(
        { k: 'agent.link', sessionId: SID, agentId: 'a1', toolUseId: 't1', status: 'async_launched', stamp: st(4, 30) },
        'hook',
      )?.facts.link,
    ).toEqual({ stamp: st(4, 30), value: 'async_launched' });
    expect(
      agentFactsOfEvent(
        { k: 'agent.link', sessionId: SID, agentId: 'a1', toolUseId: 't1', status: null, stamp: st(4, 30) },
        'hook',
      )?.facts.link,
    ).toBeNull();
  });

  it('agent.meta with a workflow run makes a workflow agent', () => {
    expect(
      agentFactsOfEvent({ k: 'agent.meta', sessionId: SID, agentId: 'a1', workflowRunId: 'wf_x' }, 'transcript')?.facts
        .kind,
    ).toBe('workflow_agent');
    expect(agentFactsOfEvent({ k: 'agent.meta', sessionId: SID, agentId: 'a1' }, 'transcript')?.facts.kind).toBe(
      'subagent',
    );
  });

  it('turn.prompt, turn.end, activity, api_error and assistant.ok with an agent id', () => {
    expect(
      agentFactsOfEvent(
        { k: 'turn.prompt', sessionId: SID, agentId: 'a1', promptId: null, stamp: st(5), origin: 'hook' },
        'hook',
      )?.facts,
    ).toMatchObject({ lastPrompt: st(5), lastActivity: st(5) });
    expect(
      agentFactsOfEvent(
        { k: 'turn.end', sessionId: SID, agentId: 'a1', promptId: null, stamp: st(6), kind: 'end_turn' },
        'transcript',
      )?.facts.lastTurnEnd?.value.kind,
    ).toBe('end_turn');
    const activity = agentFactsOfEvent(
      { k: 'activity', sessionId: SID, agentId: 'a1', stamp: st(7), via: 'assistant' },
      'transcript',
    );
    expect(activity?.facts).toMatchObject({ lastActivity: st(7), hasRecords: true });
    expect(
      agentFactsOfEvent({ k: 'activity', sessionId: SID, agentId: 'a1', stamp: st(7), via: 'hook' }, 'hook')?.facts
        .hasRecords,
    ).toBe(false);
    expect(
      agentFactsOfEvent({ k: 'api_error', sessionId: SID, agentId: 'a1', stamp: st(8) }, 'transcript')?.facts
        .lastApiError,
    ).toEqual(st(8));
    expect(
      agentFactsOfEvent({ k: 'assistant.ok', sessionId: SID, agentId: 'a1', stamp: st(9) }, 'transcript')?.facts
        .lastAssistantOk,
    ).toEqual(st(9));
  });

  it('main-agent events and unrelated events give null', () => {
    expect(
      agentFactsOfEvent({ k: 'activity', sessionId: SID, agentId: null, stamp: st(7), via: 'hook' }, 'hook'),
    ).toBeNull();
    expect(agentFactsOfEvent({ k: 'session.end', sessionId: SID, stamp: st(1), reason: 'x' }, 'hook')).toBeNull();
  });
});

describe('workflow facts of an event (02 7.3)', () => {
  it('workflow.launch and workflow.status', () => {
    expect(
      workflowFactsOfEvent({ k: 'workflow.launch', sessionId: SID, runId: 'wf_1', toolUseId: 't', stamp: st(1) }),
    ).toEqual({
      runId: 'wf_1',
      facts: { ...emptyWorkflowFacts(), launched: st(1) },
    });
    const status = workflowFactsOfEvent({
      k: 'workflow.status',
      sessionId: SID,
      runId: 'wf_1',
      observedAt: 500,
      fileStatus: 'completed',
      agentCount: 3,
      started: 3,
      results: 2,
      failed: 1,
    });
    expect(status?.facts).toMatchObject({
      fileStatus: { stamp: st(500), value: 'completed' },
      agentCount: 3,
      started: 3,
      results: 2,
      failed: 1,
    });
    const journalOnly = workflowFactsOfEvent({
      k: 'workflow.status',
      sessionId: SID,
      runId: 'wf_1',
      observedAt: 500,
      fileStatus: null,
      started: 1,
      results: 0,
      failed: 0,
    });
    expect(journalOnly?.facts.fileStatus).toBeNull();
    expect(journalOnly?.facts.agentCount).toBeNull();
    expect(workflowFactsOfEvent({ k: 'session.end', sessionId: SID, stamp: st(1), reason: 'x' })).toBeNull();
  });
});

describe('tool rows of an event (02 4.1)', () => {
  it('tool.start opens a row and records the transcript bit by origin', () => {
    const event: LogicalEvent = {
      k: 'tool.start',
      sessionId: SID,
      agentId: null,
      promptId: null,
      toolUseId: 't1',
      name: 'Bash',
      stamp: st(10, 20),
      inputHash: 'h1',
    };
    expect(toolRowsOfEvent(event, 'hook')).toEqual([
      { ...emptyToolCallRow('t1'), name: 'Bash', startedAt: 10, inputHash: 'h1' },
    ]);
    expect(toolRowsOfEvent(event, 'transcript')[0]?.transcriptUse).toBe(true);
  });

  it('tool.end closes it with the outcome, tool.batch sets batchAt on every listed call', () => {
    expect(
      toolRowsOfEvent(
        { k: 'tool.end', sessionId: SID, agentId: 'a1', toolUseId: 't1', stamp: st(11, 30), outcome: 'error' },
        'transcript',
      ),
    ).toEqual([{ ...emptyToolCallRow('t1'), agentId: 'a1', endedAt: 11, outcome: 'error', transcriptResult: true }]);
    expect(
      toolRowsOfEvent(
        { k: 'tool.batch', sessionId: SID, promptId: null, toolUseIds: ['t1', 't2'], stamp: st(12, 34) },
        'hook',
      ).map((row) => [row.toolUseId, row.batchAt]),
    ).toEqual([
      ['t1', 12],
      ['t2', 12],
    ]);
  });

  it('agent.link names the spawn call; other events have no rows', () => {
    expect(
      toolRowsOfEvent(
        { k: 'agent.link', sessionId: SID, agentId: 'a1', toolUseId: 't1', status: 'async_launched', stamp: st(13) },
        'hook',
      )[0]?.link,
    ).toEqual({ stamp: st(13), value: 'async_launched' });
    expect(toolRowsOfEvent({ k: 'session.end', sessionId: SID, stamp: st(1), reason: 'x' }, 'hook')).toEqual([]);
  });
});

describe('persisted facts (facts_json boundary)', () => {
  const events: LogicalEvent[] = [
    { k: 'session.seen', sessionId: SID, stamp: st(1000, 0, 'e1'), claudePid: 4242 },
    { k: 'session.start', sessionId: SID, stamp: st(1000, 0, 'e1'), startSource: 'startup' },
    { k: 'turn.prompt', sessionId: SID, agentId: null, promptId: 'p1', stamp: st(2000, 10, 'e2'), origin: 'hook' },
    {
      k: 'permission.request',
      sessionId: SID,
      promptId: 'p1',
      toolName: 'Bash',
      inputHash: 'h1',
      stamp: st(2500, 22, 'e3'),
    },
    { k: 'notification', sessionId: SID, type: 'idle_prompt', stamp: st(2600, 50, 'e4') },
    {
      k: 'turn.end',
      sessionId: SID,
      agentId: null,
      promptId: 'p1',
      stamp: st(3000, 60, 'e5'),
      kind: 'stop',
      backgroundTasks: 1,
    },
    { k: 'external.registry', sessionId: SID, status: 'busy', pid: 4242, pidAlive: true, observedAt: 3100 },
    { k: 'external.job', sessionId: SID, jobId: 'j1', state: 'working', observedAt: 3200 },
    { k: 'external.pid', sessionId: SID, pid: 4242, alive: true, checkedAt: 3300 },
    { k: 'external.attempt_cleared', sessionId: SID, observedAt: 3400 },
    { k: 'agent.start', sessionId: SID, agentId: 'a1', agentType: 'g', stamp: st(2100, 40, 'e6') },
    { k: 'agent.link', sessionId: SID, agentId: 'a1', toolUseId: 't1', status: 'completed', stamp: st(2200, 30, 'e7') },
    {
      k: 'workflow.status',
      sessionId: SID,
      runId: 'wf_1',
      observedAt: 3500,
      fileStatus: 'running',
      started: 1,
      results: 0,
      failed: 0,
    },
    {
      k: 'tool.start',
      sessionId: SID,
      agentId: null,
      promptId: 'p1',
      toolUseId: 't1',
      name: 'Agent',
      stamp: st(2050, 20, 'e8'),
      inputHash: 'h1',
    },
  ];
  const model = events.reduce(
    (m, event) => applyEvent(m, event, event.k.startsWith('external') ? 'external' : 'hook'),
    emptyModel(),
  );

  it('a fact set read back from JSON is the fact set that was written (session, agent, workflow run, tool row)', () => {
    const session = parseSessionFacts(JSON.parse(JSON.stringify(model.session)));
    expect(session).toStrictEqual(model.session);
    const agent = parseAgentFacts(JSON.parse(JSON.stringify(agentFactsOf(model, 'a1'))));
    expect(agent).toStrictEqual(agentFactsOf(model, 'a1'));
    const run = parseWorkflowFacts(JSON.parse(JSON.stringify(workflowFactsOf(model, 'wf_1'))));
    expect(run).toStrictEqual(workflowFactsOf(model, 'wf_1'));
    const row = model.tools['t1'];
    expect(row).toBeDefined();
    expect(parseToolCallRow(JSON.parse(JSON.stringify(row)))).toStrictEqual(row);
    expect(parseSessionFacts(emptySessionFacts())).toStrictEqual(emptySessionFacts());
  });

  it('a stored facts blob that still carries the two deprecated keys parses, and a fresh fact set carries them at their defaults', () => {
    const stored = JSON.parse(JSON.stringify(model.session)) as Record<string, unknown>;
    const old = {
      ...stored,
      costStateTrailing: { stamp: st(4096), value: true },
      hookHandlerErrors: 3,
    };
    const parsed = parseSessionFacts(old);
    expect(parsed).toStrictEqual({
      ...model.session,
      costStateTrailing: { stamp: st(4096), value: true },
      hookHandlerErrors: 3,
    });
    // never written again: the empty set and every fold of events keep the defaults
    expect(emptySessionFacts()).toMatchObject({ costStateTrailing: null, hookHandlerErrors: 0 });
    expect(model.session).toMatchObject({ costStateTrailing: null, hookHandlerErrors: 0 });
  });

  it('refuses another version, an unknown key, a missing key and a value of the wrong type', () => {
    const good = JSON.parse(JSON.stringify(model.session)) as Record<string, unknown>;
    expect(parseSessionFacts({ ...good, v: 2 })).toBeNull();
    expect(parseSessionFacts({ ...good, extra: 1 })).toBeNull();
    const missing = Object.fromEntries(Object.entries(good).filter(([key]) => key !== 'hasRecords'));
    expect(parseSessionFacts(missing)).toBeNull();
    expect(parseSessionFacts({ ...good, hasRecords: 'yes' })).toBeNull();
    expect(parseSessionFacts({ ...good, firstSeenAt: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseSessionFacts({ ...good, lastActivity: { at: 1, rank: 0 } })).toBeNull();
    expect(parseSessionFacts({ ...good, starts: { sometimes: { at: 1, rank: 0, tie: '' } } })).toBeNull();
    expect(parseSessionFacts({ ...good, hookHandlerErrors: -1 })).toBeNull();
    expect(parseSessionFacts(null)).toBeNull();
    expect(parseSessionFacts('facts')).toBeNull();
    expect(parseAgentFacts({ ...emptyAgentFacts(), kind: 'teammate' })).toBeNull();
    expect(parseWorkflowFacts({ ...emptyWorkflowFacts(), started: 1.5 })).toBeNull();
    expect(parseToolCallRow({ ...emptyToolCallRow('t'), outcome: 'closed_by_batch' })).toBeNull();
  });
});
