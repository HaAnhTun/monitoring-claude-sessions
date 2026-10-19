// Properties P1 to P9 of 02 7.12, T-LF-50 (the model part: only rows past next_check_at are re-evaluated) and T-LF-55
// (a retraction followed by a republish of the same evidence in one tick changes nothing). Each property runs 500 cases per
// scenario template (a -p run, an interactive turn pair, a foreground subagent, background subagents, a workflow, an
// interrupt, a StopFailure, a crash) with random noise: duplicates, delivery delays up to 60 s and drops of non-terminal
// events. The seed is part of every title and of every failure message: replay with MCS_TEST_SEED=<seed> (and
// MCS_TEST_CASES=1 to run only that case).
import type { LifecycleState } from '@mcs/shared';
import type { EnvelopeDataValue, HookEnvelopeV1, Stamp } from '@mcs/shared/protocol';
import { beforeAll, describe, expect, it } from 'vitest';

import { FIXTURE_SESSION_ID, fixtureEnvelope } from '../../test/fixtures/hooks.ts';
import { Prng, mulberry32, seedFromEnv } from '../../test/support/prng.ts';
import type { LogicalEvent } from '../ingest/event-row.ts';
import { normalizeEnvelope } from '../ingest/hooks/normalize-envelope.ts';
import { deriveModel, type ModelViews } from './derive-session.ts';
import {
  DEFAULT_LIFECYCLE_CFG,
  parseAgentFacts,
  parseSessionFacts,
  parseToolCallRow,
  parseWorkflowFacts,
  type LifecycleView,
} from './facts.ts';
import {
  applyEvent,
  emptyModel,
  mergeModels,
  mergeSessionFacts,
  type EventOrigin,
  type LifecycleModel,
} from './merge.ts';
import { viewChanged } from './rules.ts';

const T0 = 1_791_727_200_000;
const CFG = DEFAULT_LIFECYCLE_CFG;
const SID = FIXTURE_SESSION_ID;
const BASE_SEED = seedFromEnv(process.env, 20_261_012);
const CASES = Number(process.env['MCS_TEST_CASES'] ?? '500');

interface Tagged {
  readonly event: LogicalEvent;
  readonly origin: EventOrigin;
}

// the seed of the run is part of the output, not only of a failure message
beforeAll(() => {
  const line = `lifecycle properties: seed ${String(BASE_SEED)}, ${String(CASES)} cases per scenario template`;
  process.stdout.write([line, ''].join(String.fromCharCode(10)));
});

// ---- the seeded generator --------------------------------------------------------------------------------------------

describe('the seeded generator (test/support/prng.ts)', () => {
  it('reproduces the reference sequence of the public mulberry32 algorithm', () => {
    const next = mulberry32(42);
    expect([next(), next(), next()]).toEqual([0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
    const zero = mulberry32(0);
    expect([zero(), zero()]).toEqual([0.26642920868471265, 0.0003297457005828619]);
  });

  it('is deterministic per seed, differs between seeds and stays inside [0, 1)', () => {
    const a = new Prng(7);
    const b = new Prng(7);
    const c = new Prng(8);
    const seqA = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(seqA);
    let sum = 0;
    const uniform = new Prng(2026);
    for (let i = 0; i < 20_000; i += 1) {
      const v = uniform.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 20_000).toBeGreaterThan(0.48);
    expect(sum / 20_000).toBeLessThan(0.52);
  });

  it('draws integers inside the bounds, rejects bad bounds, shuffles into a permutation and keeps its seed', () => {
    const rng = new Prng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) seen.add(rng.int(5));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
    for (let i = 0; i < 200; i += 1) {
      const v = rng.range(-3, 3);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThanOrEqual(3);
    }
    expect(() => rng.pick([])).toThrow(RangeError);
    expect(() => rng.int(0)).toThrow(RangeError);
    expect(() => rng.int(1.5)).toThrow(RangeError);
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shuffled = new Prng(99).shuffle(input);
    expect(shuffled).toEqual(new Prng(99).shuffle(input));
    expect([...shuffled].sort((x, y) => x - y)).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(shuffled).not.toEqual(input);
    expect(new Prng(5).chance(0)).toBe(false);
    expect(new Prng(5).chance(1)).toBe(true);
    expect(new Prng(1234).seed).toBe(1234);
  });

  it('seedFromEnv takes MCS_TEST_SEED when it is a non-negative integer', () => {
    expect(seedFromEnv({ MCS_TEST_SEED: '77' }, 5)).toBe(77);
    expect(seedFromEnv({ MCS_TEST_SEED: 'abc' }, 5)).toBe(5);
    expect(seedFromEnv({ MCS_TEST_SEED: '-3' }, 5)).toBe(5);
    expect(seedFromEnv({}, 5)).toBe(5);
  });
});

// ---- scenario templates ------------------------------------------------------------------------------------------------

type HookData = Record<string, EnvelopeDataValue>;

function hook(event: string, at: number, top: Partial<HookEnvelopeV1> = {}, data: HookData = {}): Tagged[] {
  const envelope = fixtureEnvelope(event, { receivedAt: at, eventUid: `uid-${event}-${String(at)}`, top, data });
  return normalizeEnvelope(envelope).events.map((event2) => ({ event: event2, origin: 'hook' as const }));
}

function txStamp(at: number, rank: number, tie: string): Stamp {
  return { at, rank, tie };
}

interface Template {
  readonly name: string;
  readonly build: (rng: Prng) => Tagged[];
}

/** A cursor over the scenario clock: every call moves it forward by a random gap. */
class Clock {
  at = T0;
  readonly #rng: Prng;
  constructor(rng: Prng) {
    this.#rng = rng;
  }
  tick(minMs = 200, maxMs = 20_000): number {
    this.at += this.#rng.range(minMs, maxMs);
    return this.at;
  }
}

const AGENT = 'agent-a1';

const TEMPLATES: readonly Template[] = [
  {
    name: 'a -p run',
    build(rng) {
      const clock = new Clock(rng);
      const out: Tagged[] = hook('SessionStart', T0);
      out.push(...hook('UserPromptSubmit', clock.tick()));
      for (let i = 0; i < rng.range(0, 3); i += 1) {
        const id = `tool-${String(i)}`;
        out.push(...hook('PreToolUse', clock.tick(), { tool_use_id: id }));
        out.push(...hook('PostToolUse', clock.tick(), { tool_use_id: id }));
      }
      out.push(...hook('Stop', clock.tick(), {}, { background_task_count: 0 }));
      out.push(...hook('SessionEnd', clock.tick()));
      return out;
    },
  },
  {
    name: 'an interactive turn pair',
    build(rng) {
      const clock = new Clock(rng);
      const out: Tagged[] = hook('SessionStart', T0);
      out.push(...hook('UserPromptSubmit', clock.tick()));
      out.push(...hook('PreToolUse', clock.tick(), { tool_use_id: 'tool-0' }));
      out.push(...hook('PostToolUse', clock.tick(), { tool_use_id: 'tool-0' }));
      out.push(...hook('Stop', clock.tick(), {}, { background_task_count: 0 }));
      if (rng.chance(0.5)) out.push(...hook('Notification', clock.tick(), {}, { notification_type: 'idle_prompt' }));
      out.push(...hook('UserPromptSubmit', clock.tick(), { prompt_id: 'prompt-2' }));
      if (rng.chance(0.5)) out.push(...hook('PermissionRequest', clock.tick(), { prompt_id: 'prompt-2' }));
      out.push(...hook('Stop', clock.tick(), { prompt_id: 'prompt-2' }, { background_task_count: rng.range(0, 2) }));
      if (rng.chance(0.4)) out.push(...hook('SessionEnd', clock.tick()));
      return out;
    },
  },
  {
    name: 'a foreground subagent',
    build(rng) {
      const clock = new Clock(rng);
      const out: Tagged[] = hook('SessionStart', T0);
      out.push(...hook('UserPromptSubmit', clock.tick()));
      out.push(...hook('PreToolUse', clock.tick(), { tool_use_id: 'tA' }, { tool_name: 'Agent' }));
      out.push(...hook('SubagentStart', clock.tick(), { agent_id: AGENT, agent_type: 'general' }));
      out.push(...hook('SubagentStop', clock.tick(), { agent_id: AGENT, agent_type: 'general' }));
      out.push(
        ...hook(
          'PostToolUse',
          clock.tick(),
          { tool_use_id: 'tA' },
          { tool_name: 'Agent', agent_link_id: AGENT, agent_status: 'completed' },
        ),
      );
      out.push(...hook('Stop', clock.tick(), {}, { background_task_count: 0 }));
      out.push(...hook('SessionEnd', clock.tick()));
      return out;
    },
  },
  {
    name: 'background subagents',
    build(rng) {
      const clock = new Clock(rng);
      const out: Tagged[] = hook('SessionStart', T0);
      out.push(...hook('UserPromptSubmit', clock.tick()));
      out.push(...hook('PreToolUse', clock.tick(), { tool_use_id: 'tA' }, { tool_name: 'Agent' }));
      out.push(
        ...hook(
          'PostToolUse',
          clock.tick(),
          { tool_use_id: 'tA' },
          { tool_name: 'Agent', agent_link_id: AGENT, agent_status: 'async_launched' },
        ),
      );
      out.push(...hook('SubagentStart', clock.tick(), { agent_id: AGENT, agent_type: 'general' }));
      out.push(...hook('Stop', clock.tick(), {}, { background_task_count: 2 }));
      out.push({
        event: {
          k: 'agent.notification',
          sessionId: SID,
          toolUseId: 'tA',
          taskId: null,
          status: rng.pick(['completed', 'failed', 'killed'] as const),
          stamp: txStamp(clock.tick(), 20, 'tx-notification'),
        },
        origin: 'transcript',
      });
      out.push(...hook('UserPromptSubmit', clock.tick(), { prompt_id: 'prompt-2' }));
      out.push(...hook('Stop', clock.tick(), { prompt_id: 'prompt-2' }, { background_task_count: 0 }));
      out.push(...hook('SessionEnd', clock.tick()));
      return out;
    },
  },
  {
    name: 'a workflow',
    build(rng) {
      const clock = new Clock(rng);
      const out: Tagged[] = hook('SessionStart', T0);
      out.push(...hook('UserPromptSubmit', clock.tick()));
      out.push(...hook('PreToolUse', clock.tick(), { tool_use_id: 'tW' }, { tool_name: 'Workflow' }));
      out.push(...hook('PostToolUse', clock.tick(), { tool_use_id: 'tW' }, { tool_name: 'Workflow', run_id: 'wf_1' }));
      out.push({
        event: { k: 'agent.meta', sessionId: SID, agentId: AGENT, workflowRunId: 'wf_1' },
        origin: 'transcript',
      });
      out.push(...hook('SubagentStart', clock.tick(), { agent_id: AGENT, agent_type: 'workflow' }));
      const finished = clock.tick();
      out.push({
        event: {
          k: 'workflow.status',
          sessionId: SID,
          runId: 'wf_1',
          observedAt: finished,
          fileStatus: rng.chance(0.7) ? 'completed' : null,
          started: 1,
          results: rng.range(0, 1),
          failed: 0,
        },
        origin: 'transcript',
      });
      out.push(...hook('Stop', clock.tick(), {}, { background_task_count: 0 }));
      out.push(...hook('SessionEnd', clock.tick()));
      return out;
    },
  },
  {
    name: 'an interrupt',
    build(rng) {
      const clock = new Clock(rng);
      const out: Tagged[] = hook('SessionStart', T0);
      out.push(...hook('UserPromptSubmit', clock.tick()));
      out.push(...hook('PreToolUse', clock.tick(), { tool_use_id: 'tool-0' }));
      const at = clock.tick();
      out.push({
        event: {
          k: 'interrupt',
          sessionId: SID,
          agentId: null,
          stamp: txStamp(at, 10, 'tx-interrupt'),
          via: 'user_marker',
        },
        origin: 'transcript',
      });
      out.push({
        event: { k: 'activity', sessionId: SID, agentId: null, stamp: txStamp(at, 10, 'tx-interrupt'), via: 'user' },
        origin: 'transcript',
      });
      if (rng.chance(0.5)) out.push(...hook('SessionEnd', clock.tick()));
      return out;
    },
  },
  {
    name: 'a StopFailure',
    build(rng) {
      const clock = new Clock(rng);
      const out: Tagged[] = hook('SessionStart', T0);
      out.push(...hook('UserPromptSubmit', clock.tick()));
      out.push(...hook('PreToolUse', clock.tick(), { tool_use_id: 'tool-0' }));
      out.push(...hook('StopFailure', clock.tick()));
      if (rng.chance(0.5)) {
        const at = clock.tick();
        out.push({
          event: { k: 'api_error', sessionId: SID, agentId: null, stamp: txStamp(at, 20, 'tx-apierror'), status: 529 },
          origin: 'transcript',
        });
      }
      out.push(...hook('SessionEnd', clock.tick()));
      return out;
    },
  },
  {
    name: 'a crash',
    build(rng) {
      const clock = new Clock(rng);
      const out: Tagged[] = hook('SessionStart', T0);
      out.push(...hook('UserPromptSubmit', clock.tick()));
      out.push(...hook('PreToolUse', clock.tick(), { tool_use_id: 'tool-0' }));
      if (rng.chance(0.5)) out.push(...hook('PostToolUse', clock.tick(), { tool_use_id: 'tool-0' }));
      out.push({
        event: { k: 'external.pid', sessionId: SID, pid: 4242, alive: false, checkedAt: clock.tick(30_000, 90_000) },
        origin: 'external',
      });
      return out;
    },
  },
];

// ---- noise ----------------------------------------------------------------------------------------------------------

function eventTime(event: LogicalEvent): number {
  if ('stamp' in event) return event.stamp.at;
  if ('observedAt' in event) return event.observedAt;
  if ('checkedAt' in event) return event.checkedAt;
  return T0;
}

const TERMINAL_KINDS: ReadonlySet<LogicalEvent['k']> = new Set<LogicalEvent['k']>([
  'session.end',
  'external.attempt',
  'external.attempt_cleared',
  'external.job',
  'external.pid',
  'turn.end',
  'api_error',
]);

/** Drops non-terminal events at random: the events that end things (and the pid) always survive. */
function dropSome(rng: Prng, events: readonly Tagged[], probability: number): Tagged[] {
  return events.filter(({ event }) => TERMINAL_KINDS.has(event.k) || !rng.chance(probability));
}

/** Arrival order: duplicates (same stamps) and delays up to 60 s; the stamps are not touched. */
function arrival(rng: Prng, events: readonly Tagged[]): Tagged[] {
  const keyed: { at: number; item: Tagged }[] = [];
  for (const item of events) {
    keyed.push({ at: eventTime(item.event) + rng.range(0, 60_000), item });
    if (rng.chance(0.15)) keyed.push({ at: eventTime(item.event) + rng.range(0, 60_000), item });
  }
  return keyed.sort((a, b) => a.at - b.at).map((entry) => entry.item);
}

function fold(events: readonly Tagged[]): LifecycleModel {
  return events.reduce((model, { event, origin }) => applyEvent(model, event, origin), emptyModel());
}

function lastTime(events: readonly Tagged[]): number {
  return events.reduce((max, { event }) => Math.max(max, eventTime(event)), T0);
}

const OFFSETS_MS = [0, 5_000, 120_000, 600_000, 2_400_000, 7_200_000, 108_000_000, 259_200_000];

function pickNow(rng: Prng, events: readonly Tagged[]): number {
  return lastTime(events) + rng.pick(OFFSETS_MS) + rng.range(0, 999);
}

/**
 * Makes a scenario less tidy: sometimes a Claude registry entry or a live pid shows up, and (unless `whole`) the scenario
 * is cut at a random time so that the session is also seen in the middle of a turn, a tool call or a subagent.
 */
function decorate(rng: Prng, events: readonly Tagged[], whole: boolean): Tagged[] {
  const first = T0;
  const last = lastTime(events);
  const out = [...events];
  const middle = (): number => first + rng.int(Math.max(1, last - first));
  if (rng.chance(0.3)) {
    out.push({
      event: {
        k: 'external.registry',
        sessionId: SID,
        status: rng.pick(['busy', 'idle', 'waiting'] as const),
        ...(rng.chance(0.5) ? { waitingFor: 'permission prompt' } : {}),
        pid: 4242,
        pidAlive: true,
        observedAt: middle(),
      },
      origin: 'external',
    });
  }
  if (rng.chance(0.2)) {
    out.push({
      event: { k: 'external.pid', sessionId: SID, pid: 4242, alive: true, checkedAt: middle() },
      origin: 'external',
    });
  }
  if (rng.chance(0.2)) {
    out.push({
      event: { k: 'external.pid', sessionId: SID, pid: 4242, alive: false, checkedAt: middle() },
      origin: 'external',
    });
  }
  const end = events.find(({ event }) => event.k === 'session.end');
  if (end !== undefined && rng.chance(0.2)) {
    // a second SessionEnd (a retry, a hook that fired twice with another reason): the later stamp wins
    out.push({
      event: {
        k: 'session.end',
        sessionId: SID,
        stamp: { at: eventTime(end.event) + rng.range(0, 5000), rank: 90, tie: 'second-end' },
        reason: 'logout',
      },
      origin: 'hook',
    });
  }
  if (whole || !rng.chance(0.7)) return out;
  const cut = middle();
  return out.filter(({ event }) => eventTime(event) <= cut);
}

interface CaseOptions {
  /** Keep the scenario whole (the property needs its last events, for example the SessionEnd). */
  readonly whole?: boolean;
}

function forCases(
  property: string,
  body: (rng: Prng, events: Tagged[], template: Template) => void,
  options: CaseOptions = {},
): void {
  for (const template of TEMPLATES) {
    it(`${property} on ${template.name} (seed ${String(BASE_SEED)}, ${String(CASES)} cases)`, () => {
      for (let index = 0; index < CASES; index += 1) {
        const seed = BASE_SEED + index;
        const rng = new Prng(seed);
        try {
          body(rng, decorate(rng, template.build(rng), options.whole === true), template);
        } catch (error) {
          throw new Error(
            `${property} failed on ${template.name} with seed ${String(seed)} (replay: MCS_TEST_SEED=${String(seed)} MCS_TEST_CASES=1): ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
    }, 120_000);
  }
}

const TERMINAL_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>(['completed', 'failed']);

function viewsEqual(a: ModelViews, b: ModelViews): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

describe('P1 idempotence', () => {
  forCases('P1', (rng, events) => {
    const noisy = arrival(rng, events);
    const model = fold(noisy);
    // merge(f, f) == f for the facts and the whole model
    expect(mergeSessionFacts(model.session, model.session)).toEqual(model.session);
    expect(mergeModels(model, model)).toEqual(model);
    // the facts survive the facts_json round trip: written as JSON, read back through the schemas, equal
    expect(parseSessionFacts(JSON.parse(JSON.stringify(model.session)))).toStrictEqual(model.session);
    for (const [id, facts] of Object.entries(model.agents)) {
      expect(parseAgentFacts(JSON.parse(JSON.stringify(facts))), id).toStrictEqual(facts);
    }
    for (const [id, facts] of Object.entries(model.workflows)) {
      expect(parseWorkflowFacts(JSON.parse(JSON.stringify(facts))), id).toStrictEqual(facts);
    }
    for (const [id, row] of Object.entries(model.tools)) {
      expect(parseToolCallRow(JSON.parse(JSON.stringify(row))), id).toStrictEqual(row);
    }
    // applying any event twice equals applying it once
    for (const { event, origin } of noisy) {
      const once = applyEvent(model, event, origin);
      expect(once).toEqual(model);
      expect(applyEvent(once, event, origin)).toEqual(once);
    }
    // the same list twice equals the list once
    expect(fold([...noisy, ...noisy])).toEqual(model);
  });
});

describe('P2 order independence', () => {
  forCases('P2', (rng, events) => {
    const noisy = arrival(rng, events);
    const model = fold(noisy);
    const now = pickNow(rng, events);
    const views = deriveModel(model, now, CFG);
    for (let round = 0; round < 3; round += 1) {
      const shuffled = fold(rng.shuffle(noisy));
      expect(shuffled).toEqual(model);
      expect(viewsEqual(deriveModel(shuffled, now, CFG), views)).toBe(true);
    }
    expect(fold([...noisy].reverse())).toEqual(model);
    // also: the model of two halves joined equals the model of all
    const cut = rng.range(0, noisy.length);
    expect(mergeModels(fold(noisy.slice(0, cut)), fold(noisy.slice(cut)))).toEqual(model);
  });
});

describe('P3 duplicate invariance', () => {
  forCases('P3', (rng, events) => {
    const plain = fold(events);
    const now = pickNow(rng, events);
    const duplicated = [...events];
    for (let i = 0; i < rng.range(1, 12); i += 1)
      duplicated.splice(rng.int(duplicated.length + 1), 0, rng.pick(events));
    const model = fold(duplicated);
    expect(model).toEqual(plain);
    expect(viewsEqual(deriveModel(model, now, CFG), deriveModel(plain, now, CFG))).toBe(true);
  });
});

/** Late events, stamped no later than `limit`: tool traffic, activity, notifications, prompts and agent events. */
function lateEvents(rng: Prng, limit: number, withFailures: boolean): Tagged[] {
  const out: Tagged[] = [];
  const count = rng.range(1, 6);
  for (let i = 0; i < count; i += 1) {
    const at = limit - rng.range(0, 120_000);
    const choice = rng.int(withFailures ? 9 : 7);
    switch (choice) {
      case 0:
        out.push(...hook('PostToolUse', at, { tool_use_id: `late-${String(i)}` }));
        break;
      case 1:
        out.push(...hook('PreToolUse', at, { tool_use_id: `late-${String(i)}` }));
        break;
      case 2:
        out.push(...hook('Notification', at, {}, { notification_type: 'permission_prompt' }));
        break;
      case 3:
        out.push(...hook('PermissionRequest', at));
        break;
      case 4:
        out.push(...hook('UserPromptSubmit', at, { prompt_id: `late-prompt-${String(i)}` }));
        break;
      case 5:
        out.push(...hook('SubagentStop', at, { agent_id: AGENT, agent_type: 'general' }));
        break;
      case 6:
        out.push(...hook('SubagentStart', at, { agent_id: AGENT, agent_type: 'general' }));
        break;
      case 7:
        out.push(...hook('StopFailure', at));
        break;
      default:
        out.push({
          event: {
            k: 'api_error',
            sessionId: SID,
            agentId: null,
            stamp: txStamp(at, 20, `late-error-${String(i)}`),
            status: 529,
          },
          origin: 'transcript',
        });
    }
  }
  return out;
}

describe('P4 terminal non-regression', () => {
  forCases(
    'P4',
    (rng, events) => {
      const end = events.find(({ event }) => event.k === 'session.end');
      if (end === undefined) return; // the interactive and interrupt templates sometimes end without SessionEnd
      const endAt = eventTime(end.event);
      const base = fold(events);
      const now = endAt + rng.pick([0, 1000, 60_000, 3_600_000, 259_200_000]);
      const before = deriveModel(base, now, CFG).session;
      expect(TERMINAL_STATES.has(before.state)).toBe(true);
      // late events stamped at most reopenToleranceMs after SessionEnd never move completed / failed
      const late = lateEvents(rng, endAt + CFG.reopenToleranceMs, true);
      const after = deriveModel(fold([...events, ...late]), now, CFG).session;
      expect(TERMINAL_STATES.has(after.state), `${before.state} -> ${after.state} (${after.ruleId})`).toBe(true);
      // without a StopFailure or an API error among them the state is the same
      const calm = lateEvents(rng, endAt + CFG.reopenToleranceMs, false);
      const calmAfter = deriveModel(fold([...events, ...calm]), now, CFG).session;
      expect(calmAfter.state).toBe(before.state);
      expect(calmAfter.ruleId).toBe(before.ruleId);
    },
    { whole: true },
  );
});

describe('P5 missing events never imply success', () => {
  forCases('P5', (rng, events) => {
    const withoutEnd = dropSome(rng, events, 0.15).filter(({ event }) => event.k !== 'session.end');
    const model = fold(arrival(rng, withoutEnd));
    for (const offset of OFFSETS_MS) {
      const view = deriveModel(model, lastTime(events) + offset, CFG).session;
      expect(view.state, `no SessionEnd, job or attempt: ${view.ruleId}`).not.toBe('completed');
      expect(view.state, `no SessionEnd, job or attempt: ${view.ruleId}`).not.toBe('failed');
    }
    // with SessionEnd but without StopFailure or an API error the session is never failed
    const calm = fold(
      arrival(
        rng,
        dropSome(rng, events, 0.15).filter(
          ({ event }) => event.k !== 'api_error' && !(event.k === 'turn.end' && event.kind === 'stop_failure'),
        ),
      ),
    );
    expect(deriveModel(calm, pickNow(rng, events), CFG).session.state).not.toBe('failed');
  });
});

describe('P6 time monotonicity', () => {
  forCases('P6', (rng, events) => {
    const model = fold(arrival(rng, dropSome(rng, events, 0.1)));
    const times = Array.from({ length: 6 }, () => pickNow(rng, events)).sort((a, b) => a - b);
    let staleSince: number | null = null;
    for (const now of times) {
      const views = deriveModel(model, now, CFG);
      if (staleSince !== null) {
        expect(views.session.state, `stale at ${String(staleSince)}, ${views.session.state} at ${String(now)}`).toBe(
          'stale',
        );
      }
      if (views.session.state === 'stale') staleSince ??= now;
    }
  });
});

/** Everything of a view that must not move before `nextCheckAt` (the time stamps are allowed to). */
function frozen(view: LifecycleView): LifecycleView {
  return { ...view, evaluatedAt: 0, nextCheckAt: null };
}

describe('P7 nextCheckAt soundness', () => {
  forCases('P7', (rng, events) => {
    const built = fold(arrival(rng, dropSome(rng, events, 0.1)));
    const evaluatedAt = pickNow(rng, events);
    // as it is; without the Claude pid (the pid check every pidCheckIntervalMs would otherwise bound every window); and
    // with a transcript written shortly before the evaluation (the importer sets the file mtime, not an event)
    const withoutPid: LifecycleModel = { ...built, session: { ...built.session, claudePid: null } };
    const written: LifecycleModel = {
      ...withoutPid,
      session: { ...withoutPid.session, transcriptMtime: evaluatedAt - rng.range(0, 180_000) },
    };
    const variants: LifecycleModel[] = [built, withoutPid, written];
    for (const model of variants) {
      const base = deriveModel(model, evaluatedAt, CFG);
      const entities: [string, LifecycleView][] = [
        ['session', base.session],
        ...Object.entries(base.agents).map(([id, view]): [string, LifecycleView] => [`agent ${id}`, view]),
        ...Object.entries(base.workflows).map(([id, view]): [string, LifecycleView] => [`workflow ${id}`, view]),
      ];
      for (const [name, view] of entities) {
        expect(
          view.nextCheckAt === null || view.nextCheckAt > evaluatedAt,
          `${name} nextCheckAt is in the future`,
        ).toBe(true);
      }
      // the earliest check of the whole model bounds the interval in which nothing may change
      const nexts = entities.flatMap(([, view]) => (view.nextCheckAt === null ? [] : [view.nextCheckAt]));
      const horizon = nexts.length === 0 ? evaluatedAt + 3 * 86_400_000 : Math.min(...nexts);
      // 49 times spread over [evaluatedAt, horizon) and the last millisecond before the horizon
      for (let sample = 0; sample < 50; sample += 1) {
        const at = sample === 49 ? horizon - 1 : evaluatedAt + Math.floor(((horizon - evaluatedAt) * sample) / 49);
        if (at >= horizon || at < evaluatedAt) continue;
        const later = deriveModel(model, at, CFG);
        const offset = String(at - evaluatedAt);
        expect(frozen(later.session), `session at +${offset} ms`).toEqual(frozen(base.session));
        for (const [id, view] of Object.entries(base.agents)) {
          expect(frozen(later.agents[id] ?? view), `agent ${id} at +${offset} ms`).toEqual(frozen(view));
        }
        for (const [id, view] of Object.entries(base.workflows)) {
          expect(frozen(later.workflows[id] ?? view), `workflow ${id} at +${offset} ms`).toEqual(frozen(view));
        }
      }
    }
  });
});

describe('P8 subagent isolation', () => {
  forCases('P8', (rng, events) => {
    const base = events.filter(({ event }) => event.k !== 'session.end');
    const now = pickNow(rng, events);
    const before = deriveModel(fold(base), now, CFG).session;
    const stamp = (dt: number, tie: string): Stamp => ({ at: lastTime(events) + dt, rank: 44, tie });
    const agentEvents: Tagged[] = [
      {
        event: { k: 'agent.stop', sessionId: SID, agentId: AGENT, agentType: 'general', stamp: stamp(10, 'p8-stop') },
        origin: 'hook',
      },
      {
        event: {
          k: 'agent.final',
          sessionId: SID,
          agentId: AGENT,
          stamp: stamp(11, 'p8-final'),
          via: 'tool_ends_turn',
        },
        origin: 'transcript',
      },
      {
        event: {
          k: 'agent.notification',
          sessionId: SID,
          toolUseId: 'tA',
          taskId: null,
          status: rng.pick(['completed', 'failed', 'killed', 'stopped'] as const),
          stamp: stamp(12, 'p8-note'),
        },
        origin: 'transcript',
      },
      {
        event: {
          k: 'workflow.status',
          sessionId: SID,
          runId: 'wf_1',
          observedAt: lastTime(events) + 13,
          fileStatus: rng.pick(['completed', 'failed'] as const),
          started: 1,
          results: 1,
          failed: 0,
        },
        origin: 'transcript',
      },
    ];
    const chosen = agentEvents.filter(() => rng.chance(0.6));
    const after = deriveModel(fold([...base, ...chosen]), now, CFG).session;
    if (!TERMINAL_STATES.has(before.state)) {
      expect(
        TERMINAL_STATES.has(after.state),
        `${before.state} (${before.ruleId}) -> ${after.state} (${after.ruleId})`,
      ).toBe(false);
    }
  });
});

describe('P9 Stop is not SessionEnd', () => {
  forCases('P9', (rng, events) => {
    const kept = dropSome(rng, events, 0.1).filter(({ event }) => event.k !== 'session.end');
    const hasStop = kept.some(({ event }) => event.k === 'turn.end');
    const model = fold(arrival(rng, kept));
    for (const offset of OFFSETS_MS) {
      const view = deriveModel(model, lastTime(events) + offset, CFG).session;
      expect(view.state, `${String(hasStop)}: ${view.ruleId}`).not.toBe('completed');
    }
  });
});

describe('P2 and P7 with a daemon job fact (ADR 0069)', () => {
  const HOUR = 3_600_000;
  const JOB_AT = T0 + 30_000;
  const started = hook('SessionStart', T0);
  const earlier = [
    ...hook('UserPromptSubmit', T0 + 5000),
    ...hook('Stop', T0 + 20_000, {}, { background_task_count: 0 }),
  ];
  const job: Tagged[] = [
    {
      event: { k: 'external.job', sessionId: SID, jobId: 'job-1', state: 'done', observedAt: JOB_AT },
      origin: 'external',
    },
  ];
  const later = hook('UserPromptSubmit', JOB_AT + HOUR);

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
    );
  }

  it('P2: every order of {job done, later activity, earlier activity} gives the same facts and view', () => {
    const now = JOB_AT + HOUR + 5000;
    const orders = permutations([job, later, earlier]).map((groups) => fold([...started, ...groups.flat()]));
    const views = deriveModel(orders[0] ?? emptyModel(), now, CFG);
    expect(views.session).toMatchObject({ state: 'working', ruleId: 'S-7e' });
    for (const model of orders) {
      expect(model).toEqual(orders[0]);
      expect(viewsEqual(deriveModel(model, now, CFG), views)).toBe(true);
    }
  });

  it('P7: S-4a has no nextCheckAt and stays the same at any later time, in every order', () => {
    for (const groups of permutations([job, earlier])) {
      const model = fold([...started, ...groups.flat()]);
      const view = deriveModel(model, JOB_AT + 10_000, CFG).session;
      expect(view).toMatchObject({ ruleId: 'S-4a', nextCheckAt: null, since: JOB_AT });
      for (const offset of OFFSETS_MS) {
        expect(frozen(deriveModel(model, JOB_AT + 10_000 + offset, CFG).session)).toEqual(frozen(view));
      }
    }
  });
});

// ---- T-LF-50 (model part) and T-LF-55 ------------------------------------------------------------------------------

describe('T-LF-50 (model part): only rows past nextCheckAt are re-evaluated and an unchanged view publishes nothing', () => {
  it(`1,000 sessions at two sweep times (seed ${String(BASE_SEED)})`, () => {
    const rng = new Prng(BASE_SEED);
    interface Row {
      readonly model: LifecycleModel;
      readonly stored: ModelViews;
    }
    const rows: Row[] = [];
    const t0 = T0 + 3_600_000;
    for (let i = 0; i < 1000; i += 1) {
      const template = TEMPLATES[i % TEMPLATES.length];
      if (template === undefined) throw new Error('no template');
      const events = dropSome(rng, decorate(rng, template.build(rng), false), 0.1);
      const model = fold(arrival(rng, events));
      rows.push({ model, stored: deriveModel(model, t0 + rng.range(0, 3_600_000), CFG) });
    }
    const sweepAt = t0 + 3_600_000 + 90_000;
    let evaluated = 0;
    let published = 0;
    let changedAmongAll = 0;
    for (const { model, stored } of rows) {
      const due = [
        stored.session.nextCheckAt,
        ...Object.values(stored.agents).map((v) => v.nextCheckAt),
        ...Object.values(stored.workflows).map((v) => v.nextCheckAt),
      ].some((next) => next !== null && next <= sweepAt);
      const fresh = deriveModel(model, sweepAt, CFG);
      const changed =
        viewChanged(stored.session, fresh.session) ||
        Object.entries(fresh.agents).some(([id, view]) => viewChanged(stored.agents[id] ?? null, view)) ||
        Object.entries(fresh.workflows).some(([id, view]) => viewChanged(stored.workflows[id] ?? null, view));
      if (changed) changedAmongAll += 1;
      if (due) {
        evaluated += 1;
        if (changed) published += 1;
      } else {
        // a row that is not due must not have changed: skipping it loses nothing
        expect(changed).toBe(false);
      }
    }
    expect(published).toBe(changedAmongAll);
    expect(evaluated).toBeLessThan(rows.length);
    expect(evaluated).toBeGreaterThan(0);
  });
});

describe('T-LF-55 retraction and republish', () => {
  forCases('T-LF-55', (rng, events) => {
    const evidence = (observedAt: number): Tagged => ({
      event: {
        k: 'external.attempt',
        sessionId: SID,
        state: rng.pick(['COMPLETED', 'FAILED'] as const),
        evidence: 'chain log: exit=0 status=PASS',
        rowKey: 'attempt:1',
        endedAt: T0 + 1000,
        observedAt,
      },
      origin: 'external',
    });
    const at = lastTime(events) + 1000;
    const first = evidence(at);
    // the same row republished with the same state
    const same: Tagged = first;
    const tick = at + rng.range(1, 60_000);
    const retraction: Tagged = {
      event: { k: 'external.attempt_cleared', sessionId: SID, observedAt: tick },
      origin: 'external',
    };
    const republished: Tagged = { event: { ...same.event, observedAt: tick } as LogicalEvent, origin: 'external' };
    const before = fold([...events, first]);
    const now = pickNow(rng, events);
    const viewBefore = deriveModel(before, now, CFG);
    // clear and republish in the same tick, in both arrival orders
    for (const order of [
      [retraction, republished],
      [republished, retraction],
    ]) {
      const after = fold([...events, first, ...order]);
      const viewAfter = deriveModel(after, now, CFG);
      expect(viewChanged(viewBefore.session, viewAfter.session)).toBe(false);
      expect(frozen(viewAfter.session)).toEqual(frozen(viewBefore.session));
    }
    // a retraction alone removes the evidence
    const cleared = deriveModel(fold([...events, first, retraction]), now, CFG).session;
    expect(cleared.ruleId).not.toBe('S-1');
  });
});

describe('P2 and P7 with the trailing cost-state input (CR-WP-28-2, WP-99)', () => {
  const FLAGS = [true, false] as const;

  forCases('P2 trailing flag', (rng, events) => {
    const noisy = arrival(rng, events);
    const model = fold(noisy);
    const now = pickNow(rng, events);
    for (const costStateTrailing of FLAGS) {
      const inputs = { costStateTrailing };
      const views = deriveModel(model, now, CFG, inputs);
      for (let round = 0; round < 2; round += 1) {
        const shuffled = fold(rng.shuffle(noisy));
        expect(viewsEqual(deriveModel(shuffled, now, CFG, inputs), views)).toBe(true);
      }
    }
    // no input is the flag not set
    expect(viewsEqual(deriveModel(model, now, CFG), deriveModel(model, now, CFG, { costStateTrailing: false }))).toBe(
      true,
    );
    // the flag decides the presence of rule S-8e and nothing about the rule or the state
    const on = deriveModel(model, now, CFG, { costStateTrailing: true }).session;
    const off = deriveModel(model, now, CFG, { costStateTrailing: false }).session;
    expect([on.state, on.ruleId]).toEqual([off.state, off.ruleId]);
    if (on.presence !== off.presence) expect(on.ruleId).toBe('S-8e');
  });

  forCases('P7 trailing flag', (rng, events) => {
    const built = fold(arrival(rng, dropSome(rng, events, 0.1)));
    const evaluatedAt = pickNow(rng, events);
    const withoutPid: LifecycleModel = { ...built, session: { ...built.session, claudePid: null } };
    for (const model of [built, withoutPid]) {
      const inputs = { costStateTrailing: true };
      const base = deriveModel(model, evaluatedAt, CFG, inputs);
      const entities: [string, LifecycleView][] = [
        ['session', base.session],
        ...Object.entries(base.agents).map(([id, view]): [string, LifecycleView] => [`agent ${id}`, view]),
        ...Object.entries(base.workflows).map(([id, view]): [string, LifecycleView] => [`workflow ${id}`, view]),
      ];
      for (const [name, view] of entities) {
        expect(
          view.nextCheckAt === null || view.nextCheckAt > evaluatedAt,
          `${name} nextCheckAt is in the future`,
        ).toBe(true);
      }
      const nexts = entities.flatMap(([, view]) => (view.nextCheckAt === null ? [] : [view.nextCheckAt]));
      const horizon = nexts.length === 0 ? evaluatedAt + 3 * 86_400_000 : Math.min(...nexts);
      for (let sample = 0; sample < 25; sample += 1) {
        const at = sample === 24 ? horizon - 1 : evaluatedAt + Math.floor(((horizon - evaluatedAt) * sample) / 24);
        if (at >= horizon || at < evaluatedAt) continue;
        const later = deriveModel(model, at, CFG, inputs);
        expect(frozen(later.session), `session at +${String(at - evaluatedAt)} ms`).toEqual(frozen(base.session));
      }
    }
  });
});
