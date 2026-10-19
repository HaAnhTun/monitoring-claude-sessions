// `explainCompletion` of the query layer (03 6.3, 12.1, I-08; 02 7.13) over a real instance database: the lookups over the
// repositories, the rebuilt facts behind a re-derivation, the exact-match rule of a label, the empty attempt part, the refusal of a
// malformed target before any read, and the scope of the context. Rows are written through the repositories, the way the writer
// stores them, so the stored views and facts are the ones the lifecycle produced.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CompletionEvidenceSchema, RUNTIME_VERSION, type CompletionEvidence } from '@mcs/shared';
import type { HookEnvelopeV1 } from '@mcs/shared/protocol';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_AGENT_ID, FIXTURE_SESSION_ID, fixtureEnvelope } from '../../test/fixtures/hooks.ts';
import { defaultSkillDir } from '../config/defaults.ts';
import { AgentsRepo } from '../db/repos/agents.ts';
import { AttemptsRepo } from '../db/repos/attempts.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { CostStatesRepo } from '../db/repos/cost-states.ts';
import { ToolCallsRepo } from '../db/repos/tool-calls.ts';
import { TranscriptFilesRepo } from '../db/repos/transcript-files.ts';
import { withWriteTx } from '../db/write.ts';
import type { LogicalEvent } from '../ingest/event-row.ts';
import { normalizeEnvelope } from '../ingest/hooks/normalize-envelope.ts';
import { CompletionTargetError, type CompletionTarget } from '../lifecycle/completion.ts';
import { deriveModel, type ModelInputs } from '../lifecycle/derive-session.ts';
import { DEFAULT_LIFECYCLE_CFG } from '../lifecycle/facts.ts';
import { applyEvent, emptyModel, type EventOrigin, type LifecycleModel } from '../lifecycle/merge.ts';
import type { Logger } from '../log/logger.ts';
import { buildInstanceContext, type InstanceContext } from '../runtime/context.ts';
import { initWorkspace } from '../workspace/init.ts';

const makeTemp = useTempDirs();
const CFG = DEFAULT_LIFECYCLE_CFG;
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const T = NOW - 2 * 3_600_000;
const HOUR = 3_600_000;
const sec = (n: number): number => n * 1000;
const min = (n: number): number => n * 60_000;
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const uidOf = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const opened: InstanceContext[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const ctx of opened.splice(0)) ctx.db.close();
});

function silentLogger(): Logger {
  const none = (): void => undefined;
  return {
    debug: none,
    info: none,
    warn: none,
    error: none,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

interface Instance {
  readonly ctx: InstanceContext;
  readonly clock: FakeClock;
}

/** A real instance (workspace, database, query layer) in a temp folder; the clock starts at `NOW`. */
async function instance(instanceId = ID): Promise<Instance> {
  const root = makeTemp('q-completion').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => instanceId });
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: silentLogger(),
  });
  opened.push(ctx);
  return { ctx, clock };
}

// ---- fixtures: events, models, rows -----------------------------------------------------------------------------------------

interface Tagged {
  readonly event: LogicalEvent;
  readonly origin: EventOrigin;
}

function hook(
  event: string,
  dt: number,
  data?: Record<string, string | number | boolean>,
  top?: Partial<HookEnvelopeV1>,
): Tagged[] {
  const envelope = fixtureEnvelope(event, {
    receivedAt: T + dt,
    eventUid: `uid-${event}-${String(dt)}-${top?.tool_use_id ?? ''}`,
    ...(data === undefined ? {} : { data }),
    ...(top === undefined ? {} : { top }),
  });
  return normalizeEnvelope(envelope).events.map((e) => ({ event: e, origin: 'hook' as const }));
}

const attemptEvent = (state: 'COMPLETED' | 'FAILED', observedDt: number): Tagged[] => [
  {
    event: {
      k: 'external.attempt',
      sessionId: FIXTURE_SESSION_ID,
      state,
      evidence: `chain log: exit=${state === 'COMPLETED' ? '0' : '1'} status=${state}`,
      rowKey: 'attempt:1',
      endedAt: T + observedDt - 1000,
      observedAt: T + observedDt,
    },
    origin: 'external',
  },
];

const prompted = (): Tagged[] => [...hook('SessionStart', 0), ...hook('UserPromptSubmit', sec(5))];
const stopped = (): Tagged[] => [...prompted(), ...hook('Stop', sec(20), { background_task_count: 0 })];
const ended = (): Tagged[] => [...stopped(), ...hook('SessionEnd', sec(30))];

function fold(events: readonly Tagged[]): LifecycleModel {
  return events.reduce((m, { event, origin }) => applyEvent(m, event, origin), emptyModel());
}

interface Persist {
  readonly label?: string;
  readonly startedAt?: number;
  readonly lastActivityAt?: number;
  readonly inputs?: ModelInputs;
}

/** Stores the session, its agents, its open tool calls and its stored view the way the writer does. */
function persist(ctx: InstanceContext, uid: string, model: LifecycleModel, evaluatedAt: number, o: Persist = {}): void {
  const { db, scope } = ctx;
  const sessions = new SessionsRepo(db);
  const agents = new AgentsRepo(db);
  const toolCalls = new ToolCallsRepo(db);
  const views = deriveModel(model, evaluatedAt, CFG, o.inputs ?? {});
  withWriteTx(db, scope, (tx) => {
    const created = sessions.ensure(scope, tx, { sessionUid: uid, projectId: null, startedAt: o.startedAt ?? T });
    sessions.update(
      scope,
      tx,
      created.id,
      { label: o.label ?? 'nightly', lastActivityAt: o.lastActivityAt ?? evaluatedAt },
      null,
    );
    const rowOf = new Map<string, number>([['main', created.agentId]]);
    for (const [agentUid, facts] of Object.entries(model.agents)) {
      const agent = agents.upsert(
        scope,
        tx,
        {
          sessionId: created.id,
          agentUid,
          parentAgentId: created.agentId,
          kind: 'subagent',
          depth: 1,
          startedAt: facts.started?.at ?? T,
        },
        null,
      );
      rowOf.set(agentUid, agent.id);
      const view = views.agents[agentUid];
      if (view !== undefined) agents.writeView(scope, tx, agent.id, view, JSON.stringify(facts));
    }
    for (const row of Object.values(model.tools)) {
      toolCalls.upsert(scope, tx, {
        sessionId: created.id,
        agentId: rowOf.get(row.agentId ?? 'main') ?? created.agentId,
        promptId: null,
        toolUseId: row.toolUseId,
        name: row.name ?? 'Bash',
        mcpServer: null,
        summary: null,
        inputHash: row.inputHash,
        inputBytes: null,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        batchAt: row.batchAt,
        outcome: row.outcome,
        exitCode: null,
        durationMs: null,
        durationSource: null,
        sources: 1,
        callFileId: null,
        callOffset: null,
        resultFileId: null,
        resultOffset: null,
        subagentId: null,
        workflowRunId: null,
      });
    }
    sessions.writeView(scope, tx, created.id, views.session, JSON.stringify(model.session));
  });
}

function explain(h: Instance, target: CompletionTarget): CompletionEvidence & { asOfSeq: number } {
  const result = h.ctx.queries.explainCompletion(h.ctx.scope, target);
  const { asOfSeq, ...evidence } = result;
  expect(CompletionEvidenceSchema.safeParse(evidence).success).toBe(true);
  expect(asOfSeq).toBe(h.ctx.db.headSeq());
  return result;
}

function errorOf(run: () => unknown): CompletionTargetError {
  try {
    run();
  } catch (error) {
    if (error instanceof CompletionTargetError) return error;
    throw error;
  }
  throw new Error('expected a CompletionTargetError');
}

// ---- by session id --------------------------------------------------------------------------------------------------------------

describe('explainCompletion over the database, a session id', () => {
  it('reads the stored view: completed after SessionEnd, with the change-log head and rendered words', async () => {
    const h = await instance();
    h.clock.set(T + sec(40));
    persist(h.ctx, uidOf(1), fold(ended()), T + sec(40));
    const result = explain(h, { sessionId: uidOf(1) });
    expect(result).toMatchObject({
      outcome: 'completed',
      state: 'completed',
      ruleId: 'S-3b',
      basis: 'observed',
      sessionId: uidOf(1),
      resolvedBy: 'session_id',
      candidates: 1,
      asOfSeq: h.ctx.db.headSeq(),
    });
    expect(result.evidence.map((item) => item.text)).toEqual(['session ended (other) 10s ago']);
    // the words move with the clock, the stored view does not
    h.clock.set(T + sec(40) + min(7));
    expect(explain(h, { sessionId: uidOf(1) }).evidence.map((item) => item.text)).toEqual([
      'session ended (other) 7m ago',
    ]);
  });

  it('is not terminal for a turn that ended without SessionEnd', async () => {
    const h = await instance();
    h.clock.set(T + sec(30));
    persist(h.ctx, uidOf(1), fold(stopped()), T + sec(30));
    expect(explain(h, { sessionId: uidOf(1) })).toMatchObject({
      outcome: 'not_terminal',
      state: 'turn_ended',
      ruleId: 'S-8e',
    });
  });

  it('answers an attempts-row failure as failed (S-1)', async () => {
    const h = await instance();
    h.clock.set(T + sec(30));
    persist(h.ctx, uidOf(1), fold([...prompted(), ...attemptEvent('FAILED', sec(26))]), T + sec(30));
    expect(explain(h, { sessionId: uidOf(1) })).toMatchObject({ outcome: 'failed', state: 'failed', ruleId: 'S-1' });
  });

  it('is target_not_found for a session the database does not hold, and target_invalid for a malformed id', async () => {
    const h = await instance();
    expect(errorOf(() => h.ctx.queries.explainCompletion(h.ctx.scope, { sessionId: uidOf(9) })).code).toBe(
      'target_not_found',
    );
    expect(errorOf(() => h.ctx.queries.explainCompletion(h.ctx.scope, { sessionId: 'nope' })).code).toBe(
      'target_invalid',
    );
  });

  it('never resolves an id that another instance holds, and refuses the context of another instance', async () => {
    const a = await instance(ID);
    const b = await instance(OTHER_ID);
    a.clock.set(T + sec(40));
    persist(a.ctx, uidOf(1), fold(ended()), T + sec(40));
    expect(explain(a, { sessionId: uidOf(1) }).outcome).toBe('completed');
    expect(errorOf(() => b.ctx.queries.explainCompletion(b.ctx.scope, { sessionId: uidOf(1) })).code).toBe(
      'target_not_found',
    );
    expect(() => b.ctx.queries.explainCompletion(a.ctx.scope, { sessionId: uidOf(1) })).toThrow();
  });
});

// ---- by label -----------------------------------------------------------------------------------------------------------------

describe('explainCompletion over the database, a label', () => {
  it('lets the newest session of the label decide and counts every match', async () => {
    const h = await instance();
    h.clock.set(T + HOUR + sec(10));
    persist(h.ctx, uidOf(1), fold(ended()), T + sec(40), { startedAt: T });
    const newer = fold([...hook('SessionStart', HOUR), ...hook('UserPromptSubmit', HOUR + sec(5))]);
    persist(h.ctx, uidOf(2), newer, HOUR + sec(10), { startedAt: T + HOUR, lastActivityAt: T + HOUR });
    persist(h.ctx, uidOf(3), fold(ended()), T + sec(40), { startedAt: T - HOUR, label: 'other' });
    expect(explain(h, { label: 'nightly' })).toMatchObject({
      outcome: 'not_terminal',
      state: 'working',
      ruleId: 'S-7e',
      sessionId: uidOf(2),
      resolvedBy: 'label',
      candidates: 2,
    });
  });

  it('matches only an equal label: wildcards and case are plain characters', async () => {
    const h = await instance();
    h.clock.set(T + sec(40));
    persist(h.ctx, uidOf(1), fold(ended()), T + sec(40), { label: '100%_done' });
    persist(h.ctx, uidOf(2), fold(ended()), T + sec(40), { label: '100 percent done' });
    persist(h.ctx, uidOf(3), fold(ended()), T + sec(40), { label: 'Release_Build' });
    expect(explain(h, { label: '100%_done' })).toMatchObject({ sessionId: uidOf(1), candidates: 1 });
    for (const label of ['100%', '%', '_', '100_done', '100%_DONE', 'release_build', 'Release%Build', 'Release_']) {
      expect(errorOf(() => h.ctx.queries.explainCompletion(h.ctx.scope, { label })).code, label).toBe(
        'target_not_found',
      );
    }
  });

  it('refuses an empty or a 201-character label as target_invalid', async () => {
    const h = await instance();
    for (const label of ['', 'a'.repeat(201), 'a'.repeat(10_000)]) {
      expect(errorOf(() => h.ctx.queries.explainCompletion(h.ctx.scope, { label })).code).toBe('target_invalid');
    }
  });
});

// ---- by attempt part ---------------------------------------------------------------------------------------------------------

describe('explainCompletion over the database, an attempt part', () => {
  interface RunSpec {
    readonly part: string;
    readonly startedAt: number;
    readonly offset: number;
    readonly end?: {
      readonly state: 'COMPLETED' | 'FAILED' | 'UNKNOWN';
      readonly at: number;
      readonly evidence: string;
    };
    readonly session?: number;
  }

  /** One chain-log source and its runs; `session` is a `sessions.id`. */
  function addRuns(h: Instance, runs: readonly RunSpec[]): void {
    const { db, scope } = h.ctx;
    const repo = new AttemptsRepo(db);
    withWriteTx(db, scope, (tx) => {
      const sourceId = repo.saveSource(scope, tx, {
        path: 'logs/chain.log',
        pathKey: 'logs/chain.log',
        generation: 1,
        ino: '1',
        headLen: 8,
        headHash: 'h'.repeat(64),
        readOffset: 0,
        configSha256: 'c'.repeat(64),
      });
      for (const spec of runs) {
        const id =
          repo.insertRun(scope, tx, {
            sourceId,
            generation: 1,
            startOffset: spec.offset,
            part: spec.part,
            nRaw: '1',
            model: null,
            effort: null,
            startedAt: spec.startedAt,
            evidence: 'START line',
          }) ?? -1;
        if (spec.session !== undefined) repo.setMatch(scope, tx, id, spec.session, 0);
        if (spec.end !== undefined) {
          repo.endRun(scope, tx, id, {
            endOffset: spec.offset + 50,
            endedAt: spec.end.at,
            exitRaw: '1',
            statusRaw: 'x',
            state: spec.end.state,
            evidence: spec.end.evidence,
          });
        }
      }
    });
  }

  it('an ended failed row that no session matched is failed, with no session', async () => {
    const h = await instance();
    addRuns(h, [
      { part: 'p', startedAt: T, offset: 0, end: { state: 'FAILED', at: T + sec(40), evidence: 'chain log: exit=1' } },
    ]);
    const result = explain(h, { attemptPart: 'p' });
    expect(result).toMatchObject({
      outcome: 'failed',
      state: 'failed',
      ruleId: 'C-ATT-ENDED',
      sessionId: null,
      resolvedBy: 'attempt_part',
      candidates: 1,
    });
    expect(result.evidence).toEqual([
      { kind: 'attempts:attempt_row', at: new Date(T + sec(40)).toISOString(), text: 'chain log: exit=1' },
    ]);
  });

  it('the latest start decides: an open row over an older passed one', async () => {
    const h = await instance();
    addRuns(h, [
      { part: 'p', startedAt: T, offset: 0, end: { state: 'COMPLETED', at: T + sec(30), evidence: 'PASS' } },
      { part: 'p', startedAt: T + HOUR, offset: 100 },
      { part: 'q', startedAt: T + 2 * HOUR, offset: 200 },
    ]);
    expect(explain(h, { attemptPart: 'p' })).toMatchObject({
      outcome: 'not_terminal',
      state: 'running',
      ruleId: 'C-ATT-OPEN',
      candidates: 2,
    });
  });

  it('the empty part is its own part', async () => {
    const h = await instance();
    addRuns(h, [
      { part: '', startedAt: T, offset: 0, end: { state: 'COMPLETED', at: T + sec(30), evidence: 'PASS' } },
      { part: 'named', startedAt: T + 10, offset: 100, end: { state: 'FAILED', at: T + sec(40), evidence: 'FAIL' } },
    ]);
    expect(explain(h, { attemptPart: '' })).toMatchObject({ outcome: 'completed', candidates: 1 });
    expect(explain(h, { attemptPart: 'named' })).toMatchObject({ outcome: 'failed', candidates: 1 });
  });

  it('an ended row matched to a session is decided by that session', async () => {
    const h = await instance();
    h.clock.set(T + sec(40));
    persist(h.ctx, uidOf(1), fold(stopped()), T + sec(30));
    const row = h.ctx.db.driver
      .prepare<{ id: number }>('SELECT id FROM sessions WHERE session_uid = ?')
      .get([uidOf(1)]);
    addRuns(h, [
      {
        part: 'p',
        startedAt: T,
        offset: 0,
        session: row?.id ?? -1,
        end: { state: 'COMPLETED', at: T + sec(30), evidence: 'PASS' },
      },
    ]);
    // the stored view of the session does not carry the attempts fact (it was retracted): the session decides
    expect(explain(h, { attemptPart: 'p' })).toMatchObject({
      outcome: 'not_terminal',
      state: 'turn_ended',
      ruleId: 'S-8e',
      sessionId: uidOf(1),
      resolvedBy: 'attempt_part',
    });
  });

  it('is target_not_found for a part nobody ran and target_invalid for a part of 513 characters', async () => {
    const h = await instance();
    expect(errorOf(() => h.ctx.queries.explainCompletion(h.ctx.scope, { attemptPart: 'none' })).code).toBe(
      'target_not_found',
    );
    expect(errorOf(() => h.ctx.queries.explainCompletion(h.ctx.scope, { attemptPart: 'p'.repeat(513) })).code).toBe(
      'target_invalid',
    );
    expect(errorOf(() => h.ctx.queries.explainCompletion(h.ctx.scope, { attemptPart: 'p'.repeat(512) })).code).toBe(
      'target_not_found',
    );
  });
});

// ---- re-derivation from the stored facts ----------------------------------------------------------------------------------------

describe('explainCompletion over the database, a stored view that is due', () => {
  it('re-derives from facts_json: a working view that went quiet is stale (S-7f)', async () => {
    const h = await instance();
    persist(h.ctx, uidOf(1), fold(prompted()), T + sec(10));
    h.clock.set(T + sec(10));
    expect(explain(h, { sessionId: uidOf(1) })).toMatchObject({ state: 'working', ruleId: 'S-7e' });
    h.clock.set(T + sec(5) + min(40));
    expect(explain(h, { sessionId: uidOf(1) })).toMatchObject({
      outcome: 'not_terminal',
      state: 'stale',
      ruleId: 'S-7f',
      basis: 'inferred',
    });
  });

  it('writes nothing: the stored view and the change-log head stay as they were', async () => {
    const h = await instance();
    persist(h.ctx, uidOf(1), fold(prompted()), T + sec(10));
    const head = h.ctx.db.headSeq();
    const columns = (): unknown =>
      h.ctx.db.driver
        .prepare(
          'SELECT state, state_rule, evaluated_at, next_check_at, updated_at FROM sessions WHERE session_uid = ?',
        )
        .get([uidOf(1)]);
    const before = columns();
    h.clock.set(T + sec(5) + min(40));
    explain(h, { sessionId: uidOf(1) });
    expect(h.ctx.db.headSeq()).toBe(head);
    expect(columns()).toEqual(before);
  });

  it('keeps the stored view when facts_json has no shape of this version', async () => {
    const h = await instance();
    persist(h.ctx, uidOf(1), fold(prompted()), T + sec(10));
    persist(h.ctx, uidOf(2), fold(prompted()), T + sec(10), { label: 'other' });
    h.ctx.db.driver.prepare('UPDATE sessions SET facts_json = ? WHERE session_uid = ?').run(['[1,2]', uidOf(1)]);
    h.ctx.db.driver.prepare('UPDATE sessions SET facts_json = ? WHERE session_uid = ?').run(['{"v":2}', uidOf(2)]);
    h.clock.set(T + sec(5) + min(40));
    for (const id of [uidOf(1), uidOf(2)]) {
      expect(explain(h, { sessionId: id })).toMatchObject({
        outcome: 'not_terminal',
        state: 'working',
        ruleId: 'S-7e',
      });
    }
  });

  it('rebuilds the open tool calls of the session: a tool open for three minutes is waiting_tool (S-7c)', async () => {
    const h = await instance();
    const events = [...prompted(), ...hook('PreToolUse', sec(8), { tool_name: 'Bash' }, { tool_use_id: 't1' })];
    persist(h.ctx, uidOf(1), fold(events), T + sec(10));
    h.clock.set(T + sec(10));
    expect(explain(h, { sessionId: uidOf(1) })).toMatchObject({ state: 'working', ruleId: 'S-7b' });
    h.clock.set(T + sec(8) + min(3));
    expect(explain(h, { sessionId: uidOf(1) })).toMatchObject({
      outcome: 'not_terminal',
      state: 'waiting_tool',
      ruleId: 'S-7c',
    });
  });

  it('rebuilds the subagents and their tool calls: an active child keeps a turn-ended session waiting_agent', async () => {
    const h = await instance();
    const events = [
      ...stopped(),
      ...hook('SubagentStart', sec(25), undefined, { agent_id: FIXTURE_AGENT_ID, agent_type: 'general-purpose' }),
      ...hook('PreToolUse', sec(26), { tool_name: 'Bash' }, { tool_use_id: 'tc', agent_id: FIXTURE_AGENT_ID }),
    ];
    const model = fold(events);
    expect(Object.keys(model.agents)).toEqual([FIXTURE_AGENT_ID]);
    persist(h.ctx, uidOf(1), model, T + sec(30));
    h.clock.set(T + sec(30));
    expect(explain(h, { sessionId: uidOf(1) })).toMatchObject({ state: 'waiting_agent', ruleId: 'S-8a' });
    // three minutes later the child's call is waiting_tool, which still counts as active; without the rows it would be S-8e
    h.clock.set(T + sec(26) + min(3));
    const later = deriveModel(model, T + sec(26) + min(3), CFG).session;
    expect(later).toMatchObject({ state: 'waiting_agent', ruleId: 'S-8a' });
    expect(explain(h, { sessionId: uidOf(1) })).toMatchObject({
      outcome: 'not_terminal',
      state: 'waiting_agent',
      ruleId: 'S-8a',
    });
  });

  it('reads the trailing cost-state flag of the transcript file: an inferred end, never completed', async () => {
    const h = await instance();
    persist(h.ctx, uidOf(1), fold(stopped()), T + sec(30));
    const { db, scope } = h.ctx;
    const row = db.driver.prepare<{ id: number }>('SELECT id FROM sessions WHERE session_uid = ?').get([uidOf(1)]);
    const sessionId = row?.id ?? -1;
    withWriteTx(db, scope, (tx) => {
      const file = new TranscriptFilesRepo(db).register(scope, tx, {
        path: 'FIXTURE/projects/session.jsonl',
        pathKey: 'fixture/projects/session.jsonl',
        kind: 'session',
        sessionUid: uidOf(1),
        agentUid: null,
        runUid: null,
        sessionId,
        agentId: null,
        workflowRunId: null,
        birthMs: null,
        firstSeenMtimeMs: null,
        mtimeSeen: null,
      });
      new CostStatesRepo(db).upsert(scope, tx, {
        fileId: file.id,
        sessionId,
        totalCostUsd: 0.5,
        modelUsage: {},
        byteOffset: 100,
        isTrailing: true,
        observedAt: T + sec(25),
      });
    });
    // the stored view was derived without the flag; the sweeper has not looked since: the answer reads the flag from the row
    db.driver.prepare('UPDATE sessions SET next_check_at = ? WHERE session_uid = ?').run([T + sec(31), uidOf(1)]);
    h.clock.set(T + sec(40));
    expect(explain(h, { sessionId: uidOf(1) })).toMatchObject({
      outcome: 'not_terminal',
      state: 'turn_ended',
      ruleId: 'S-8e',
      basis: 'inferred',
    });
    // without a trailing state the same re-derivation is observed
    db.driver.prepare('UPDATE cost_states SET is_trailing = 0').run();
    expect(explain(h, { sessionId: uidOf(1) })).toMatchObject({
      state: 'turn_ended',
      ruleId: 'S-8e',
      basis: 'observed',
    });
  });
});

// ---- refusal before any read ----------------------------------------------------------------------------------------------------

describe('explainCompletion over the database, a refused target', () => {
  it('never prepares a statement or opens a read for a malformed target', async () => {
    const h = await instance();
    const prepare = vi.spyOn(h.ctx.db.driver, 'prepare');
    const transaction = vi.spyOn(h.ctx.db.driver, 'transaction');
    for (const target of [
      { sessionId: 'x' },
      { label: 'a'.repeat(10_000) },
      { label: '' },
      { attemptPart: 'p'.repeat(513) },
    ]) {
      expect(errorOf(() => h.ctx.queries.explainCompletion(h.ctx.scope, target)).code).toBe('target_invalid');
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reads inside one transaction for a valid target', async () => {
    const h = await instance();
    h.clock.set(T + sec(40));
    persist(h.ctx, uidOf(1), fold(ended()), T + sec(40));
    const transaction = vi.spyOn(h.ctx.db.driver, 'transaction');
    explain(h, { sessionId: uidOf(1) });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
