// TC-EVW-06: `followEvents` and `waitFor` over a scripted feed, a scripted reader and a fake clock (ADR 0108).
import path from 'node:path';

import {
  CliEventSchema,
  McsError,
  WaitResultSchema,
  type CliEvent,
  type CompletionResponse,
  type SessionSummary,
  type StateAssessment,
  type StreamChange,
} from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { Logger } from '../log/logger.ts';
import type { ChangeFeedEvent, ChangeFeedOptions, FeedSleep, openChangeFeed } from '../reader/change-feed.ts';
import type { InstanceReader } from '../reader/open.ts';
import { WAIT_POLL_MS, followEvents, waitFor, type WaitInput, type WatchDeps } from './watch.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 10, 20, 10, 0, 0);
const AT = '2026-11-20T10:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';
const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_SESSION = 'aaaaaaaa-0000-4000-8000-000000000002';
const EPOCH = '0a1b2c3d';

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

function stateOf(over: Partial<StateAssessment>): StateAssessment {
  return {
    state: 'working',
    presence: 'open',
    waitReason: null,
    staleKind: null,
    endReason: null,
    turnOutcome: null,
    basis: 'observed',
    confidence: 'high',
    rule: 'S-7a',
    evidence: [{ kind: 'registry:busy', at: AT, text: 'CANARY evidence words' }],
    since: AT,
    evaluatedAt: AT,
    legacyState: 'IDLE',
    ...over,
  };
}

const WORKING = stateOf({});
const NEEDS_YOU = stateOf({ state: 'waiting_input', waitReason: 'permission', rule: 'S-6b' });
const TURN_ENDED = stateOf({ state: 'turn_ended', turnOutcome: 'ok', rule: 'S-8b' });
const OVER = stateOf({ state: 'completed', presence: 'ended', rule: 'S-1' });
/** The row says completed, nothing observed says the process ended. */
const UNPROVEN = stateOf({ state: 'completed', presence: 'unknown', rule: 'S-1' });

/** A session as the stream and the reader carry it: the label and the folder must never leave the machine. */
function sessionOf(state: StateAssessment): SessionSummary {
  return { id: SESSION, label: 'CANARY label', cwd: 'CANARY/folder', state } as unknown as SessionSummary;
}

const hello = (headSeq: number, reconnect = false): ChangeFeedEvent => ({
  type: 'hello',
  reconnect,
  hello: {
    instanceId: ID,
    epoch: EPOCH,
    headSeq,
    heartbeatMs: 15000,
    serverTime: AT,
    runtimeVersion: '4.0.0',
    codeStamp: 'stamp',
  },
});

function sessionChange(seq: number, state: StateAssessment | null, sessionId = SESSION): ChangeFeedEvent {
  const change = { seq, at: AT, instanceId: ID, kind: 'session', op: 'upsert', sessionId };
  return { type: 'change', change: { ...change, data: state === null ? null : sessionOf(state) } as StreamChange };
}

const agentChange = (seq: number): ChangeFeedEvent => ({
  type: 'change',
  change: { seq, at: AT, instanceId: ID, kind: 'agent', op: 'upsert', sessionId: SESSION, data: null },
});

interface Harness {
  readonly ctx: OpContext;
  readonly clock: FakeClock;
  readonly deps: WatchDeps;
  /** The options every feed was opened with. */
  readonly feeds: ChangeFeedOptions[];
  /** How often the session was read. */
  reads(): number;
}

/**
 * A feed that yields `events` and then stays silent, a reader that answers the session states of `sessions` in order (the
 * last one again afterwards) and a timer that fires as soon as the feed has nothing left, moving the clock by the time asked.
 */
function harness(o: {
  events?: readonly ChangeFeedEvent[];
  feedError?: McsError;
  sessions?: readonly (StateAssessment | null)[];
  completion?: Pick<CompletionResponse, 'outcome' | 'ruleId'>;
}): Harness {
  const { repo } = buildRepo(makeTemp('watch-ops').path);
  buildTaskWorkspace(repo, {
    slug: 'demo',
    config: { title: 'FIXTURE demo' },
    instance: { slug: 'demo', instanceId: ID, runtimeVersion: '4.0.0', dbSchemaVersion: 1 },
  });
  const skillDir = defaultSkillDir();
  const clock = new FakeClock(NOW);
  const ctx: OpContext = {
    repo,
    root: path.join(repo, '.claude', 'monitor', 'tasks'),
    skillDir,
    runtimeDir: path.join(skillDir, 'runtime'),
    launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
    env: {},
    clock,
    log: silent,
  };

  const feeds: ChangeFeedOptions[] = [];
  let quiet: () => void = () => undefined;
  const silence = new Promise<void>((resolve) => {
    quiet = resolve;
  });
  const openFeed: typeof openChangeFeed = async function* (
    _ws: unknown,
    _deps: unknown,
    given?: ChangeFeedOptions,
  ): AsyncGenerator<ChangeFeedEvent, void, void> {
    const options = given ?? {};
    feeds.push(options);
    if (o.feedError !== undefined) {
      quiet();
      throw o.feedError;
    }
    for (const event of o.events ?? []) yield event;
    quiet();
    await new Promise<void>((resolve) => {
      options.signal?.addEventListener('abort', () => {
        resolve();
      });
    });
  };
  const sleep: FeedSleep = async (ms, signal) => {
    await silence;
    // one turn of the event loop: whatever is ready (a frame, a failure of the feed) is seen before the timer fires
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (signal?.aborted !== true) clock.advance(ms);
  };

  let reads = 0;
  const sessions = o.sessions ?? [WORKING];
  const reader = {
    mode: 'api',
    instanceId: ID,
    session: () => {
      const state = sessions[Math.min(reads, sessions.length - 1)] ?? null;
      reads += 1;
      return Promise.resolve(state === null ? null : { ...sessionOf(state), asOfSeq: 10 });
    },
    explainCompletion: () =>
      o.completion === undefined
        ? Promise.reject(new Error('the completion check was not expected'))
        : Promise.resolve(o.completion),
    close: () => Promise.resolve(),
  } as unknown as InstanceReader;

  return {
    ctx,
    clock,
    feeds,
    reads: () => reads,
    deps: { openFeed, sleep, openReader: () => Promise.resolve(reader) },
  };
}

const waitInput = (over: Partial<WaitInput>): WaitInput => ({
  task: 'demo',
  sessionId: SESSION,
  until: 'needs_you',
  timeoutMs: 60_000,
  holdMs: 0,
  next: false,
  appearMs: 30_000,
  ...over,
});

describe('waitFor', () => {
  it('reads the session, follows the stream from the seq of that read, and is met once needs_you has held', async () => {
    const h = harness({
      events: [hello(10), sessionChange(11, NEEDS_YOU, OTHER_SESSION), sessionChange(12, NEEDS_YOU)],
    });
    const result = WaitResultSchema.parse(await waitFor(h.ctx, waitInput({ holdMs: 3000 }), h.deps));
    expect(result).toMatchObject({
      outcome: 'met',
      sessionId: SESSION,
      alreadyTrue: false,
      waitedMs: 3000,
      state: { state: 'waiting_input', rule: 'S-6b' },
      attention: { posture: 'needs_you', reason: 'permission' },
      completion: null,
    });
    expect(h.feeds.map((options) => options.since)).toEqual([10]);
    expect(h.reads()).toBe(1);
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('times out on completed while the completion check says not_terminal, and reports that answer', async () => {
    const h = harness({ sessions: [UNPROVEN], completion: { outcome: 'not_terminal', ruleId: 'S-1' } });
    const result = await waitFor(h.ctx, waitInput({ until: 'completed', timeoutMs: 5000 }), h.deps);
    expect(result).toMatchObject({
      outcome: 'timeout',
      waitedMs: 5000,
      completion: { outcome: 'not_terminal', ruleId: 'S-1' },
    });
  });

  it('answers completed from one read when the timeout is 0 and the check proves it, without a stream', async () => {
    const h = harness({ sessions: [OVER], completion: { outcome: 'completed', ruleId: 'S-1' } });
    const result = await waitFor(h.ctx, waitInput({ until: 'completed', timeoutMs: 0 }), h.deps);
    expect(result).toMatchObject({ outcome: 'met', alreadyTrue: true, completion: { outcome: 'completed' } });
    expect(h.feeds).toEqual([]);
  });

  it('reads the session again after an upsert without data and after a reset, and ends when the session is over', async () => {
    const h = harness({
      events: [hello(10), sessionChange(11, null), { type: 'reset', reset: { headSeq: 20, reason: 'cursor_too_old' } }],
      sessions: [WORKING, WORKING, OVER],
    });
    const result = await waitFor(h.ctx, waitInput({}), h.deps);
    expect(result).toMatchObject({ outcome: 'ended', state: { state: 'completed', presence: 'ended' } });
    expect(h.reads()).toBe(3);
  });

  it('is missing when the session never appears; a delete of a session that was seen is ended', async () => {
    const never = harness({ events: [hello(10)], sessions: [null] });
    const missing = await waitFor(never.ctx, waitInput({}), never.deps);
    expect(missing).toMatchObject({ outcome: 'missing', state: null, attention: null, waitedMs: 30_000 });
    // no seq to subscribe at: the stream starts at the head and the session is read again behind it
    expect(never.feeds.map((options) => options.since)).toEqual([undefined]);
    expect(never.reads()).toBe(2);

    const deleted: ChangeFeedEvent = {
      type: 'change',
      change: { seq: 11, at: AT, instanceId: ID, kind: 'session', op: 'delete', sessionId: SESSION, data: null },
    };
    const gone = harness({ events: [hello(10), deleted] });
    expect(await waitFor(gone.ctx, waitInput({}), gone.deps)).toMatchObject({ outcome: 'ended' });
  });

  it('polls the session every 3 s when the instance has no free stream', async () => {
    const full = new McsError('API_ERROR', 'every live stream of the instance is taken', {
      details: { reason: 'stream_limit' },
    });
    const h = harness({ feedError: full, sessions: [WORKING, WORKING, WORKING, TURN_ENDED] });
    const result = await waitFor(h.ctx, waitInput({ until: 'turn_ended' }), h.deps);
    expect(result).toMatchObject({ outcome: 'met', waitedMs: 2 * WAIT_POLL_MS, state: { rule: 'S-8b' } });
    expect(h.reads()).toBe(4);
  });

  it('passes on every other failure of the stream, and refuses an id that is not one', async () => {
    const stopped = new McsError('INSTANCE_NOT_RUNNING', 'not running');
    const h = harness({ feedError: stopped });
    await expect(waitFor(h.ctx, waitInput({}), h.deps)).rejects.toBe(stopped);
    await expect(waitFor(h.ctx, waitInput({ sessionId: 'nope' }), h.deps)).rejects.toMatchObject({ code: 'USAGE' });
  });
});

async function linesOf(lines: AsyncGenerator<CliEvent, void, void>, limit = 50): Promise<CliEvent[]> {
  const seen: CliEvent[] = [];
  for await (const line of lines) {
    seen.push(CliEventSchema.parse(line));
    if (seen.length === limit) break;
  }
  return seen;
}

describe('followEvents', () => {
  it('prints the hello line and ends when nothing else was asked for', async () => {
    const h = harness({ events: [hello(10), sessionChange(11, WORKING)] });
    const lines = await linesOf(followEvents(h.ctx, { task: 'demo', follow: false, kinds: ['session'] }, h.deps));
    expect(lines).toEqual([
      { schema: 'caw.event/1', type: 'hello', instanceId: ID, epoch: EPOCH, headSeq: 10, serverTime: AT },
    ]);
  });

  it('replays after --since up to the head of the hello, reports the asked kinds only, and ends', async () => {
    const h = harness({
      events: [hello(12), agentChange(11), sessionChange(12, NEEDS_YOU), sessionChange(13, WORKING)],
    });
    const input = { task: 'demo', follow: false, since: 10, kinds: ['session'] as const };
    const lines = await linesOf(followEvents(h.ctx, input, h.deps));
    expect(lines.map((line) => line.type)).toEqual(['hello', 'change', 'end']);
    expect(lines[1]).toMatchObject({
      seq: 12,
      kind: 'session',
      sessionId: SESSION,
      session: { state: 'waiting_input', rule: 'S-6b', attention: { posture: 'needs_you', reason: 'permission' } },
    });
    expect(lines[2]).toEqual({ schema: 'caw.event/1', type: 'end', headSeq: 12, count: 1 });
    expect(h.feeds.map((options) => options.since)).toEqual([10]);
    expect(JSON.stringify(lines)).not.toContain('CANARY');

    const ahead = harness({ events: [hello(12), { type: 'reset', reset: { headSeq: 12, reason: 'cursor_ahead' } }] });
    const reset = await linesOf(followEvents(ahead.ctx, { ...input, since: 99 }, ahead.deps));
    expect(reset.map((line) => line.type)).toEqual(['hello', 'reset', 'end']);
  });

  it('stays with --follow: every kind when asked, a reset as a line, no line for a reconnect or a heartbeat', async () => {
    const h = harness({
      events: [
        hello(10),
        agentChange(11),
        { type: 'heartbeat', heartbeat: { headSeq: 11, epoch: EPOCH, serverTime: AT } },
        hello(11, true),
        { type: 'reset', reset: { headSeq: 30, reason: 'epoch_changed' } },
        sessionChange(31, null),
      ],
    });
    const lines = await linesOf(followEvents(h.ctx, { task: 'demo', follow: true, kinds: null }, h.deps), 4);
    expect(lines.map((line) => (line.type === 'change' ? `${line.kind} ${String(line.seq)}` : line.type))).toEqual([
      'hello',
      'agent 11',
      'reset',
      'session 31',
    ]);
    expect(lines[3]).toMatchObject({ session: null });
  });
});
