// T-LF-01..48: every row of the transition table of 02 7.7 (47 rows: N1-N16, F1-F6, D1-D5, M1-M7, L1-L4, O1-O6, C1-C3).
// A row is a prior event list, the input events (possibly in several steps) and the expected view at a time. Hook events
// come from the real envelope normalizer (`normalizeEnvelope` on the fixture envelopes), transcript events are built
// the way the record normalizer produces them. Every row runs in two delivery orders, as listed and with the input
// arriving before its predecessor (stamps unchanged), plus the fully reversed list; all must give the listed result and
// the same views. T-LF-48 asserts that every row ran.
import type { LifecycleState } from '@mcs/shared';
import type { EnvelopeDataValue, HookEnvelopeV1, Stamp } from '@mcs/shared/protocol';
import { describe, expect, it } from 'vitest';

import { FIXTURE_AGENT_ID, FIXTURE_SESSION_ID, fixtureEnvelope } from '../../test/fixtures/hooks.ts';
import type { LogicalEvent } from '../ingest/event-row.ts';
import { normalizeEnvelope } from '../ingest/hooks/normalize-envelope.ts';
import { deriveModel, type ModelViews } from './derive-session.ts';
import { DEFAULT_LIFECYCLE_CFG, sessionFactsWith, type Lww, type SessionFacts } from './facts.ts';
import { legacyOfSession } from './legacy.ts';
import { applyEvent, emptyModel, mergeSessionFacts, type EventOrigin, type LifecycleModel } from './merge.ts';
import { viewChanged } from './rules.ts';

const T = 1_791_727_200_000;
const CFG = DEFAULT_LIFECYCLE_CFG;
const SID = FIXTURE_SESSION_ID;
const sec = (n: number): number => n * 1000;
const min = (n: number): number => n * 60_000;
const HOUR = 3_600_000;

interface Tagged {
  readonly event: LogicalEvent;
  readonly origin: EventOrigin;
}

// ---- event builders -------------------------------------------------------------------------------------------------

interface HookOptions {
  readonly data?: Record<string, EnvelopeDataValue>;
  readonly top?: Partial<HookEnvelopeV1>;
  readonly uid?: string;
}

/** The logical events of one hook delivery at `T + dt`, through the real normalizer. */
function hook(event: string, dt: number, opts: HookOptions = {}): Tagged[] {
  const envelope = fixtureEnvelope(event, {
    receivedAt: T + dt,
    eventUid: opts.uid ?? `uid-${event}-${String(dt)}`,
    ...(opts.data === undefined ? {} : { data: opts.data }),
    ...(opts.top === undefined ? {} : { top: opts.top }),
  });
  return normalizeEnvelope(envelope).events.map((e) => ({ event: e, origin: 'hook' as const }));
}

const stamp = (dt: number, rank: number, tie: string): Stamp => ({ at: T + dt, rank, tie });

/** Transcript records as the record normalizer produces them (ranks: user 10, assistant 20, tool_result 30). */
const tx = {
  prompt(dt: number): Tagged[] {
    const at = stamp(dt, 10, `tx-prompt-${String(dt)}`);
    return [
      {
        event: { k: 'turn.prompt', sessionId: SID, agentId: null, promptId: null, stamp: at, origin: 'user' },
        origin: 'transcript',
      },
      { event: { k: 'activity', sessionId: SID, agentId: null, stamp: at, via: 'user' }, origin: 'transcript' },
    ];
  },
  assistant(dt: number): Tagged[] {
    const at = stamp(dt, 20, `tx-assistant-${String(dt)}`);
    return [
      { event: { k: 'activity', sessionId: SID, agentId: null, stamp: at, via: 'assistant' }, origin: 'transcript' },
      { event: { k: 'assistant.ok', sessionId: SID, agentId: null, stamp: at }, origin: 'transcript' },
    ];
  },
  toolUse(dt: number, id: string, name: string): Tagged[] {
    const at = stamp(dt, 20, `tx-tool-${id}`);
    return [
      { event: { k: 'activity', sessionId: SID, agentId: null, stamp: at, via: 'assistant' }, origin: 'transcript' },
      {
        event: { k: 'tool.start', sessionId: SID, agentId: null, promptId: null, toolUseId: id, name, stamp: at },
        origin: 'transcript',
      },
    ];
  },
  endTurn(dt: number): Tagged[] {
    return [
      {
        event: {
          k: 'turn.end',
          sessionId: SID,
          agentId: null,
          promptId: null,
          stamp: stamp(dt, 20, `tx-end-${String(dt)}`),
          kind: 'end_turn',
        },
        origin: 'transcript',
      },
    ];
  },
  interrupt(dt: number): Tagged[] {
    const at = stamp(dt, 10, `tx-interrupt-${String(dt)}`);
    return [
      { event: { k: 'interrupt', sessionId: SID, agentId: null, stamp: at, via: 'user_marker' }, origin: 'transcript' },
      { event: { k: 'activity', sessionId: SID, agentId: null, stamp: at, via: 'user' }, origin: 'transcript' },
    ];
  },
  apiError(dt: number): Tagged[] {
    const at = stamp(dt, 20, `tx-apierror-${String(dt)}`);
    return [
      { event: { k: 'activity', sessionId: SID, agentId: null, stamp: at, via: 'assistant' }, origin: 'transcript' },
      { event: { k: 'api_error', sessionId: SID, agentId: null, stamp: at, status: 529 }, origin: 'transcript' },
    ];
  },
};

const external = {
  attempt(state: 'COMPLETED' | 'FAILED' | 'UNKNOWN', rowKey: string, observedDt: number): Tagged[] {
    return [
      {
        event: {
          k: 'external.attempt',
          sessionId: SID,
          state,
          evidence: `chain log: exit=${state === 'COMPLETED' ? '0' : '1'} status=${state}`,
          rowKey,
          endedAt: T + observedDt - 1000,
          observedAt: T + observedDt,
        },
        origin: 'external',
      },
    ];
  },
  cleared(observedDt: number): Tagged[] {
    return [
      { event: { k: 'external.attempt_cleared', sessionId: SID, observedAt: T + observedDt }, origin: 'external' },
    ];
  },
  job(state: string, observedDt: number): Tagged[] {
    return [
      {
        event: { k: 'external.job', sessionId: SID, jobId: 'job-1', state, observedAt: T + observedDt },
        origin: 'external',
      },
    ];
  },
  pid(alive: boolean, checkedDt: number): Tagged[] {
    return [
      { event: { k: 'external.pid', sessionId: SID, pid: 4242, alive, checkedAt: T + checkedDt }, origin: 'external' },
    ];
  },
};

// shared prefixes
const started = (): Tagged[] => hook('SessionStart', 0);
const prompted = (): Tagged[] => [...started(), ...hook('UserPromptSubmit', sec(5))];
const stop = (dt: number, background = 0): Tagged[] =>
  hook('Stop', dt, { data: { background_task_count: background } });
const stopped = (dt = sec(20)): Tagged[] => [...prompted(), ...stop(dt)];
const preTool = (dt: number, id: string, name = 'Bash'): Tagged[] =>
  hook('PreToolUse', dt, { top: { tool_use_id: id }, data: { tool_name: name } });
const postTool = (dt: number, id: string): Tagged[] => hook('PostToolUse', dt, { top: { tool_use_id: id } });
const agentTool = (dt: number): Tagged[] => preTool(dt, 'tA', 'Agent');
const agentFlow = (): Tagged[] => [
  ...hook('SubagentStart', sec(9)),
  ...hook('SubagentStop', sec(20)),
  ...hook('PostToolUse', sec(21), {
    top: { tool_use_id: 'tA' },
    data: { tool_name: 'Agent', agent_link_id: FIXTURE_AGENT_ID, agent_status: 'completed' },
  }),
];

// ---- running a row ---------------------------------------------------------------------------------------------------

function fold(events: readonly Tagged[], patch?: Partial<SessionFacts>): LifecycleModel {
  const model = events.reduce((m, { event, origin }) => applyEvent(m, event, origin), emptyModel());
  return patch === undefined ? model : { ...model, session: mergeSessionFacts(model.session, sessionFactsWith(patch)) };
}

interface Expectation {
  readonly state: LifecycleState;
  readonly rule: string;
  readonly waitReason?: string | null;
  readonly turnOutcome?: string | null;
  readonly presence?: string;
  readonly basis?: string;
  readonly confidence?: string;
}

interface Step {
  readonly input: readonly Tagged[];
  /** Evaluation time as an offset from T. */
  readonly now: number;
  readonly expect: Expectation;
  readonly agents?: Readonly<Record<string, { state: LifecycleState; rule: string }>>;
  readonly check?: (views: ModelViews, model: LifecycleModel, priorViews: ModelViews) => void;
  readonly legacy?: string;
}

interface Row {
  readonly id: string;
  readonly title: string;
  readonly prior: readonly Tagged[];
  readonly steps: readonly Step[];
  readonly patch?: Partial<SessionFacts>;
}

const ran = new Set<string>();

function matchSession(views: ModelViews, expected: Expectation): void {
  const { rule, ...rest } = expected;
  expect(views.session).toMatchObject({ state: rest.state, ruleId: rule });
  if (rest.waitReason !== undefined) expect(views.session.waitReason).toBe(rest.waitReason);
  if (rest.turnOutcome !== undefined) expect(views.session.turnOutcome).toBe(rest.turnOutcome);
  if (rest.presence !== undefined) expect(views.session.presence).toBe(rest.presence);
  if (rest.basis !== undefined) expect(views.session.basis).toBe(rest.basis);
  if (rest.confidence !== undefined) expect(views.session.confidence).toBe(rest.confidence);
}

function runRow(row: Row): void {
  const cumulative: Tagged[] = [];
  for (const step of row.steps) {
    cumulative.push(...step.input);
    const listed = fold([...row.prior, ...cumulative], row.patch);
    const inputFirst = fold([...cumulative, ...row.prior], row.patch);
    const reversed = fold([...row.prior, ...cumulative].reverse(), row.patch);
    const now = T + step.now;

    // the facts, rows and views do not depend on the delivery order
    expect(inputFirst).toEqual(listed);
    expect(reversed).toEqual(listed);
    const views = deriveModel(listed, now, CFG);
    expect(deriveModel(inputFirst, now, CFG)).toEqual(views);
    expect(deriveModel(reversed, now, CFG)).toEqual(views);

    matchSession(views, step.expect);
    for (const [agentId, expected] of Object.entries(step.agents ?? {})) {
      expect(views.agents[agentId], `agent ${agentId}`).toMatchObject({ state: expected.state, ruleId: expected.rule });
    }
    if (step.legacy !== undefined) {
      const rows = {
        tools: Object.values(listed.tools),
        agents: Object.values(views.agents).map(() => ({ fileMtime: null })),
      };
      expect(legacyOfSession(listed.session, rows, views.session, now, CFG).state).toBe(step.legacy);
    }
    if (step.check !== undefined) {
      step.check(views, listed, deriveModel(fold([...row.prior], row.patch), now, CFG));
    }
  }
  ran.add(row.id);
}

const lww = <T2>(at: Stamp, value: T2): Lww<T2> => ({ stamp: at, value });

// ---- the rows (02 7.7) ----------------------------------------------------------------------------------------------

const N: readonly Row[] = [
  {
    id: 'N1',
    title: 'SessionStart(startup) waits for the user',
    prior: [],
    steps: [
      {
        input: hook('SessionStart', 0),
        now: sec(10),
        expect: { state: 'waiting_input', rule: 'S-8f', waitReason: 'user' },
      },
    ],
  },
  {
    id: 'N2',
    title: 'UserPromptSubmit after N1 is working',
    prior: started(),
    steps: [{ input: hook('UserPromptSubmit', sec(5)), now: sec(10), expect: { state: 'working', rule: 'S-7e' } }],
  },
  {
    id: 'N3',
    title: 'PreToolUse(Bash) keeps the turn working',
    prior: prompted(),
    steps: [{ input: preTool(sec(8), 't1'), now: sec(10), expect: { state: 'working', rule: 'S-7b' } }],
  },
  {
    id: 'N4',
    title: 'a tool open for 3 minutes is waiting_tool',
    prior: [...prompted(), ...preTool(sec(8), 't1')],
    steps: [{ input: [], now: sec(8) + min(3), expect: { state: 'waiting_tool', rule: 'S-7c' } }],
  },
  {
    id: 'N5',
    title: 'PostToolUse after N4 is working again',
    prior: [...prompted(), ...preTool(sec(8), 't1')],
    steps: [{ input: postTool(sec(190), 't1'), now: sec(200), expect: { state: 'working', rule: 'S-7e' } }],
  },
  {
    id: 'N6',
    title: 'a foreground Agent call is waiting_agent',
    prior: prompted(),
    steps: [{ input: agentTool(sec(8)), now: sec(10), expect: { state: 'waiting_agent', rule: 'S-7a' } }],
  },
  {
    id: 'N7',
    title: 'SubagentStart, SubagentStop and PostToolUse(Agent completed): working, agent completed',
    prior: [...prompted(), ...agentTool(sec(8))],
    steps: [
      {
        input: agentFlow(),
        now: sec(25),
        expect: { state: 'working', rule: 'S-7e' },
        agents: { [FIXTURE_AGENT_ID]: { state: 'completed', rule: 'A-4' } },
      },
    ],
  },
  {
    id: 'N8',
    title: 'Stop ends the turn',
    prior: prompted(),
    steps: [{ input: stop(sec(20)), now: sec(30), expect: { state: 'turn_ended', rule: 'S-8e', turnOutcome: 'ok' } }],
  },
  {
    id: 'N9',
    title: 'SessionEnd after N8 completes the session',
    prior: stopped(),
    steps: [{ input: hook('SessionEnd', sec(30)), now: sec(40), expect: { state: 'completed', rule: 'S-3b' } }],
  },
  {
    id: 'N10',
    title: 'Notification(idle_prompt) after N8 waits for the user',
    prior: stopped(),
    steps: [
      {
        input: hook('Notification', sec(25), { data: { notification_type: 'idle_prompt' } }),
        now: sec(30),
        expect: { state: 'waiting_input', rule: 'S-8c', waitReason: 'idle_prompt' },
      },
    ],
  },
  {
    id: 'N11',
    title: 'PermissionRequest waits for permission',
    prior: prompted(),
    steps: [
      {
        input: hook('PermissionRequest', sec(10)),
        now: sec(12),
        expect: { state: 'waiting_input', rule: 'S-6a', waitReason: 'permission' },
      },
    ],
  },
  {
    id: 'N12',
    title: 'PostToolUse of the same input hash resolves the request',
    prior: [...prompted(), ...preTool(sec(8), 't1'), ...hook('PermissionRequest', sec(10))],
    steps: [
      {
        input: postTool(sec(15), 't1'),
        now: sec(20),
        expect: { state: 'working', rule: 'S-7e' },
        check: (_views, _model, prior) => {
          expect(prior.session).toMatchObject({ state: 'waiting_input', ruleId: 'S-6a' });
        },
      },
    ],
  },
  {
    id: 'N13',
    title: 'Stop with background_tasks 2 waits for the agents',
    prior: prompted(),
    steps: [
      { input: stop(sec(20), 2), now: sec(25), expect: { state: 'waiting_agent', rule: 'S-8a', basis: 'observed' } },
    ],
  },
  {
    id: 'N14',
    title: 'the background report turn is working, then ends',
    prior: [...prompted(), ...stop(sec(20), 2)],
    steps: [
      {
        input: hook('UserPromptSubmit', sec(30), { top: { prompt_id: 'prompt-2' } }),
        now: sec(35),
        expect: { state: 'working', rule: 'S-7e' },
      },
      { input: stop(sec(40), 0), now: sec(45), expect: { state: 'turn_ended', rule: 'S-8e' } },
    ],
  },
  {
    id: 'N15',
    title: 'PreCompact, PostCompact and SessionStart(compact) keep the turn working',
    prior: prompted(),
    steps: [
      {
        input: [
          ...hook('PreCompact', sec(10)),
          ...hook('PostCompact', sec(11)),
          ...hook('SessionStart', sec(12), { data: { source: 'compact' } }),
        ],
        now: sec(15),
        expect: { state: 'working', rule: 'S-7e' },
      },
    ],
  },
  {
    id: 'N16',
    title: 'transcript only, last record end_turn, quiet 5 minutes: turn_ended, legacy IDLE',
    prior: [],
    patch: {
      transcriptMtime: T + sec(1),
      legacy: { lastStop: lww(stamp(sec(1), 20, 'ls'), 'end_turn'), fileFirstTs: null, fileMaxTs: null },
    },
    steps: [
      {
        input: [...tx.prompt(0), ...tx.assistant(sec(1)), ...tx.endTurn(sec(1))],
        now: sec(1) + min(5),
        expect: { state: 'turn_ended', rule: 'S-8e' },
        legacy: 'IDLE',
      },
    ],
  },
];

const F: readonly Row[] = [
  {
    id: 'F1',
    title: 'StopFailure ends the turn with outcome error',
    prior: prompted(),
    steps: [
      {
        input: hook('StopFailure', sec(20)),
        now: sec(25),
        expect: { state: 'turn_ended', rule: 'S-8e', turnOutcome: 'error' },
      },
    ],
  },
  {
    id: 'F2',
    title: 'SessionEnd after a StopFailure fails the session',
    prior: [...prompted(), ...hook('StopFailure', sec(20))],
    steps: [{ input: hook('SessionEnd', sec(30)), now: sec(40), expect: { state: 'failed', rule: 'S-3a' } }],
  },
  {
    id: 'F3',
    title: 'an attempts row with exit 1 fails the session',
    prior: prompted(),
    steps: [
      {
        input: external.attempt('FAILED', 'attempt:1', sec(26)),
        now: sec(30),
        expect: { state: 'failed', rule: 'S-1' },
      },
    ],
  },
  {
    id: 'F4',
    title: 'PostToolUseFailure(Exit code 2) is a tool error, not a session failure',
    prior: [...prompted(), ...preTool(sec(8), 't1')],
    steps: [
      {
        input: hook('PostToolUseFailure', sec(12), { top: { tool_use_id: 't1' }, data: { exit_code: 2 } }),
        now: sec(15),
        expect: { state: 'working', rule: 'S-7e' },
      },
    ],
  },
  {
    id: 'F5',
    title: 'a transcript API error as the last assistant record, then SessionEnd, fails the session',
    prior: [...tx.prompt(0), ...tx.apiError(sec(5))],
    steps: [{ input: hook('SessionEnd', sec(10)), now: sec(20), expect: { state: 'failed', rule: 'S-3a' } }],
  },
  {
    id: 'F6',
    title: 'a daemon job state done completes a turn_ended session',
    prior: stopped(),
    steps: [{ input: external.job('done', sec(30)), now: sec(40), expect: { state: 'completed', rule: 'S-4a' } }],
  },
];

const D: readonly Row[] = [
  {
    id: 'D1',
    title: 'Stop twice, 20 ms apart, is one turn end',
    prior: prompted(),
    steps: [
      {
        input: [
          ...stop(sec(20)),
          ...hook('Stop', sec(20) + 20, { uid: 'uid-Stop-copy', data: { background_task_count: 0 } }),
        ],
        now: sec(30),
        expect: { state: 'turn_ended', rule: 'S-8e' },
      },
    ],
  },
  {
    id: 'D2',
    title: 'a duplicate SessionEnd changes nothing',
    prior: [...stopped(), ...hook('SessionEnd', sec(30))],
    steps: [
      {
        input: hook('SessionEnd', sec(30)),
        now: sec(40),
        expect: { state: 'completed', rule: 'S-3b' },
        check: (views, _model, prior) => {
          expect(viewChanged(prior.session, views.session)).toBe(false);
          expect(views).toEqual(prior);
        },
      },
    ],
  },
  {
    id: 'D3',
    title: 'PreToolUse twice with the same tool_use_id is one tool call',
    prior: prompted(),
    steps: [
      {
        input: [
          ...preTool(sec(8), 't1'),
          ...hook('PreToolUse', sec(8) + 10, { uid: 'uid-copy', top: { tool_use_id: 't1' } }),
        ],
        now: sec(10),
        expect: { state: 'working', rule: 'S-7b' },
        check: (_views, model) => {
          expect(Object.keys(model.tools)).toEqual(['t1']);
        },
      },
    ],
  },
  {
    id: 'D4',
    title: 'SubagentStop twice leaves the agent completed and unchanged',
    prior: [...prompted(), ...agentTool(sec(8)), ...agentFlow()],
    steps: [
      {
        input: hook('SubagentStop', sec(20) + 10, { uid: 'uid-copy' }),
        now: sec(25),
        expect: { state: 'working', rule: 'S-7e' },
        agents: { [FIXTURE_AGENT_ID]: { state: 'completed', rule: 'A-4' } },
        check: (views, _model, prior) => {
          const before = prior.agents[FIXTURE_AGENT_ID];
          const after = views.agents[FIXTURE_AGENT_ID];
          expect(before).toBeDefined();
          expect(after).toBeDefined();
          if (before !== undefined && after !== undefined) expect(viewChanged(before, after)).toBe(false);
        },
      },
    ],
  },
  {
    id: 'D5',
    title: 'replaying the whole spool gives identical views',
    prior: [...prompted(), ...preTool(sec(8), 't1'), ...postTool(sec(12), 't1'), ...stop(sec(20))],
    steps: [
      {
        input: [...prompted(), ...preTool(sec(8), 't1'), ...postTool(sec(12), 't1'), ...stop(sec(20))],
        now: sec(30),
        expect: { state: 'turn_ended', rule: 'S-8e' },
        check: (views, _model, prior) => {
          expect(views).toEqual(prior);
        },
      },
    ],
  },
];

const M: readonly Row[] = [
  {
    id: 'M1',
    title: 'no further events for 30 minutes: stale/silent',
    prior: prompted(),
    steps: [
      {
        input: [],
        now: sec(5) + min(30),
        expect: { state: 'stale', rule: 'S-7f' },
        check: (views) => {
          expect(views.session.staleKind).toBe('silent');
        },
      },
    ],
  },
  {
    id: 'M2',
    title: 'a dead pid 30 seconds after the turn end is stale/process_gone, never completed',
    prior: stopped(),
    steps: [
      {
        input: external.pid(false, sec(45)),
        now: sec(50),
        expect: { state: 'stale', rule: 'S-5', presence: 'ended' },
        check: (views) => {
          expect(views.session.staleKind).toBe('process_gone');
        },
      },
    ],
  },
  {
    id: 'M3',
    title: 'a resting turn with no pid information becomes abandoned after 24 hours',
    prior: stopped(),
    steps: [
      {
        input: [],
        now: sec(20) + 24 * HOUR,
        expect: { state: 'stale', rule: 'S-8d' },
        check: (views) => {
          expect(views.session.staleKind).toBe('abandoned');
        },
      },
    ],
  },
  {
    id: 'M4',
    title: 'a transcript tool_use without a PreToolUse hook: working, then waiting_tool after 2 minutes',
    prior: prompted(),
    steps: [
      { input: tx.toolUse(sec(10), 'tx1', 'Bash'), now: sec(15), expect: { state: 'working', rule: 'S-7b' } },
      { input: [], now: sec(10) + min(2), expect: { state: 'waiting_tool', rule: 'S-7c' } },
    ],
  },
  {
    id: 'M5',
    title: 'hooks installed mid-session: the transcript prompt gives working (inferred)',
    prior: [],
    steps: [
      {
        input: [...tx.prompt(0), ...tx.assistant(sec(5))],
        now: sec(10),
        expect: { state: 'working', rule: 'S-7e', basis: 'inferred', confidence: 'medium' },
      },
    ],
  },
  {
    id: 'M6',
    title: 'no hooks at all: the new state per 7.4 and the legacy projection of the Python classifier',
    prior: [],
    patch: {
      transcriptMtime: T + sec(2),
      legacy: { lastStop: lww(stamp(sec(2), 20, 'ls'), 'end_turn'), fileFirstTs: null, fileMaxTs: null },
    },
    steps: [
      {
        input: [...tx.prompt(0), ...tx.assistant(sec(2)), ...tx.endTurn(sec(2))],
        now: sec(2) + min(10),
        expect: { state: 'turn_ended', rule: 'S-8e' },
        legacy: 'IDLE',
        check: (views, model) => {
          const out = legacyOfSession(
            model.session,
            { tools: [], agents: [] },
            views.session,
            T + sec(2) + min(10),
            CFG,
          );
          expect(out.evidence).toBe(
            'turn ended (end_turn), quiet 10m; the transcript cannot show whether the job is finished or waiting',
          );
        },
      },
    ],
  },
  {
    id: 'M7',
    title: 'a transcript interrupt marker without a Stop hook ends the turn (interrupted)',
    prior: prompted(),
    steps: [
      {
        input: tx.interrupt(sec(20)),
        now: sec(25),
        expect: { state: 'turn_ended', rule: 'S-8e', turnOutcome: 'interrupted' },
      },
    ],
  },
];

const L: readonly Row[] = [
  {
    id: 'L1',
    title: 'a PostToolUse stamped before SessionEnd that arrives later does not move completed',
    prior: [...stopped(), ...hook('SessionEnd', sec(100))],
    steps: [{ input: postTool(sec(90), 't9'), now: sec(200), expect: { state: 'completed', rule: 'S-3b' } }],
  },
  {
    id: 'L2',
    title: 'an async PostToolUse stamped 30 ms after Stop (jitter) leaves turn_ended',
    prior: stopped(),
    steps: [{ input: postTool(sec(20) + 30, 't1'), now: sec(30), expect: { state: 'turn_ended', rule: 'S-8e' } }],
  },
  {
    id: 'L3',
    title: 'a 10-minute outage drained at start gives the same views as live',
    prior: [],
    steps: [
      {
        input: [
          ...started(),
          ...hook('UserPromptSubmit', sec(5)),
          ...preTool(sec(8), 't1'),
          ...postTool(sec(12), 't1'),
          ...stop(sec(20)),
          ...hook('SessionEnd', sec(30)),
        ],
        now: min(10),
        expect: { state: 'completed', rule: 'S-3b' },
      },
    ],
  },
  {
    id: 'L4',
    title: 'SessionEnd delivered before Stop (arrival), stamps ordered: completed',
    prior: [...prompted(), ...preTool(sec(8), 't1')],
    steps: [
      {
        input: [...hook('SessionEnd', sec(30)), ...stop(sec(20))],
        now: sec(40),
        expect: { state: 'completed', rule: 'S-3b' },
      },
    ],
  },
];

const O: readonly Row[] = [
  {
    id: 'O1',
    title: 'PostToolUse before its PreToolUse closes the call',
    prior: prompted(),
    steps: [
      {
        input: [...postTool(sec(12), 't1'), ...preTool(sec(8), 't1')],
        now: sec(15),
        expect: { state: 'working', rule: 'S-7e' },
        check: (_views, model) => {
          expect(model.tools['t1']).toMatchObject({ startedAt: T + sec(8), endedAt: T + sec(12) });
        },
      },
    ],
  },
  {
    id: 'O2',
    title: 'SubagentStop before SubagentStart still completes the agent',
    prior: [...prompted(), ...agentTool(sec(8))],
    steps: [
      {
        input: [...hook('SubagentStop', sec(20)), ...hook('SubagentStart', sec(9))],
        now: sec(25),
        expect: { state: 'waiting_agent', rule: 'S-7a' },
        agents: { [FIXTURE_AGENT_ID]: { state: 'completed', rule: 'A-4' } },
      },
    ],
  },
  {
    id: 'O3',
    title: 'Stop before UserPromptSubmit of the same turn: turn_ended',
    prior: started(),
    steps: [
      {
        input: [...stop(sec(20)), ...hook('UserPromptSubmit', sec(5))],
        now: sec(30),
        expect: { state: 'turn_ended', rule: 'S-8e' },
      },
    ],
  },
  {
    id: 'O4',
    title: 'a prompt genuinely after SessionEnd reopens the session (activity_after_end)',
    prior: [...stopped(), ...hook('SessionEnd', sec(100))],
    steps: [
      {
        input: hook('UserPromptSubmit', sec(110), { top: { prompt_id: 'prompt-2' } }),
        now: sec(115),
        expect: { state: 'working', rule: 'S-7e' },
        check: (views) => {
          expect(views.reopened).toBe(true);
          expect(views.session.evidence.map((e) => e.fact)).toContain('activity_after_end');
        },
      },
    ],
  },
  {
    id: 'O5',
    title: 'a second SubagentStart (resume) makes the agent working again',
    prior: [...prompted(), ...hook('SubagentStart', sec(9)), ...hook('SubagentStop', sec(20))],
    steps: [
      {
        input: hook('SubagentStart', sec(60), { uid: 'uid-resume' }),
        now: sec(65),
        expect: { state: 'working', rule: 'S-7e' },
        agents: { [FIXTURE_AGENT_ID]: { state: 'working', rule: 'A-6' } },
      },
    ],
  },
  {
    id: 'O6',
    title: 'a backfill of old transcript records changes nothing',
    prior: prompted(),
    steps: [
      {
        input: [...tx.prompt(-min(10)), ...tx.assistant(-min(10) + sec(10)), ...tx.endTurn(-min(10) + sec(10))],
        now: sec(10),
        expect: { state: 'working', rule: 'S-7e' },
        check: (views, _model, prior) => {
          expect(viewChanged(prior.session, views.session)).toBe(false);
          expect(views.session.evidence).toEqual(prior.session.evidence);
        },
      },
    ],
  },
];

const C: readonly Row[] = (() => {
  const base = [...stopped(), ...external.attempt('COMPLETED', 'attempt:1', sec(30))];
  const precondition = (_views: ModelViews, _model: LifecycleModel, prior: ModelViews): void => {
    expect(prior.session).toMatchObject({ state: 'completed', ruleId: 'S-1' });
  };
  return [
    {
      id: 'C1',
      title: 'a retraction after a config rebuild re-derives the session without S-1',
      prior: base,
      steps: [
        {
          input: external.cleared(sec(40)),
          now: sec(50),
          expect: { state: 'turn_ended', rule: 'S-8e', turnOutcome: 'ok' },
          check: precondition,
        },
      ],
    },
    {
      id: 'C2',
      title: 'a same-tick republish of a failed row beats the retraction',
      prior: base,
      steps: [
        {
          input: [...external.cleared(sec(40)), ...external.attempt('FAILED', 'attempt:2', sec(40))],
          now: sec(50),
          expect: { state: 'failed', rule: 'S-1' },
          check: precondition,
        },
      ],
    },
    {
      id: 'C3',
      title: 'a late attempt older than the retraction loses',
      prior: [...base, ...external.cleared(sec(40))],
      steps: [
        {
          input: external.attempt('FAILED', 'attempt:3', sec(35)),
          now: sec(50),
          expect: { state: 'turn_ended', rule: 'S-8e' },
        },
      ],
    },
  ];
})();

const ROWS: readonly Row[] = [...N, ...F, ...D, ...M, ...L, ...O, ...C];
const pad = (n: number): string => String(n).padStart(2, '0');

describe('transition table of 02 7.7 (T-LF-01..47)', () => {
  it('has the 47 rows of the design table', () => {
    expect(ROWS.map((row) => row.id)).toEqual([
      ...Array.from({ length: 16 }, (_, i) => `N${String(i + 1)}`),
      ...Array.from({ length: 6 }, (_, i) => `F${String(i + 1)}`),
      ...Array.from({ length: 5 }, (_, i) => `D${String(i + 1)}`),
      ...Array.from({ length: 7 }, (_, i) => `M${String(i + 1)}`),
      ...Array.from({ length: 4 }, (_, i) => `L${String(i + 1)}`),
      ...Array.from({ length: 6 }, (_, i) => `O${String(i + 1)}`),
      ...Array.from({ length: 3 }, (_, i) => `C${String(i + 1)}`),
    ]);
  });

  ROWS.forEach((row, index) => {
    it(`T-LF-${pad(index + 1)} ${row.id}: ${row.title}`, () => {
      runRow(row);
    });
  });

  it('T-LF-48: every row ran in both delivery orders (and fully reversed)', () => {
    expect([...ran].sort()).toEqual(ROWS.map((row) => row.id).sort());
    expect(ran.size).toBe(47);
  });
});
