// The ingest service over a real workspace, database, spool, Claude home and writer (02 4.9, 4.10; T-PL-01, T-PL-13, T-HE-01
// to T-HE-03, T-HE-05, T-LF-50). Real timers; every directory is a temp directory and nothing leaves this process.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { IngestHealthSchema, RUNTIME_VERSION } from '@mcs/shared';
import { sanitizeProjectName, type HookEnvelopeV1 } from '@mcs/shared/protocol';
import {
  bigTranscript,
  buildClaudeHome,
  killAllTracked,
  spawnTracked,
  useTempDirs,
  waitFor,
  type SessionSpec,
  type TranscriptBuilder,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { ingestHealthEvaluatorOf } from '../src/health/ingest-health.ts';
import { SpoolSegmentNotFoundError } from '../src/ingest/errors.ts';
import { readRouteFile } from '../src/ingest/routes-file.ts';
import {
  IngestIdleTimeoutError,
  createIngestService,
  publishRouteFile,
  type IngestService,
  type IngestServiceOptions,
} from '../src/ingest/service.ts';
import { nodeExternalFs } from '../src/external/fs.ts';
import { renderEvidence } from '../src/lifecycle/rules.ts';
import { createLifecycleSweeper } from '../src/lifecycle/sweeper.ts';
import { createInstanceRuntime } from '../src/runtime/instance-runtime.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { initWorkspace } from '../src/workspace/init.ts';
import { jobState, registryEntry, writeJob, writeRegistry } from './fixtures/external.ts';
import { PROMPT_ID, SUBAGENT_ID, TOOL_AGENT, TOOL_BASH, TOOL_READ, labSequence } from './fixtures/hook-sequences.ts';
import { fixtureEnvelope } from './fixtures/hooks.ts';
import { appendEnvelopes } from './fixtures/spool.ts';

const makeTemp = useTempDirs();
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');
const SESSION = '66666666-6666-4666-8666-666666666666';
const MIN = 60_000;
/** 05 4.6: performance assertions scale with `MCS_PERF_FACTOR` (default 1). */
const PERF_FACTOR = Number(process.env['MCS_PERF_FACTOR'] ?? '1') || 1;

interface Harness {
  readonly ctx: InstanceContext;
  readonly root: string;
  readonly repo: string;
  readonly claudeHome: string;
  readonly spoolDir: string;
  readonly projectDir: string;
  readonly service: IngestService;
  /** A second service over the same context (a restart). */
  another(): IngestService;
  all<T>(sql: string, params?: Record<string, string | number>): T[];
  one(sql: string, params?: Record<string, string | number>): number;
}

const services: IngestService[] = [];
const contexts: InstanceContext[] = [];

afterEach(async () => {
  await killAllTracked();
  for (const service of services.splice(0)) await service.stop(Date.now() + 2000).catch(() => undefined);
  for (const ctx of contexts.splice(0)) {
    ctx.db.close();
    // the log file of the workspace is open until the logger is closed; Windows cannot delete the folder before that
    await ctx.logger.close();
  }
});

interface HarnessOptions {
  /** `runtime.json` of the workspace. */
  readonly runtime?: Record<string, unknown>;
  /** The sessions of the Claude home (their project folder is the one the repository maps to). */
  readonly sessions?: (repo: string) => SessionSpec[];
  readonly registry?: (claudeHome: string) => void;
  readonly service?: IngestServiceOptions;
}

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  const root = makeTemp('ingest-service').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo' });
  if (o.runtime !== undefined) {
    writeFileSync(path.join(ws.dir, 'runtime.json'), JSON.stringify({ schema_version: 1, ...o.runtime }));
  }
  const claudeHome = path.join(root, 'claude-home');
  buildClaudeHome(claudeHome, { nowMs: Date.now(), sessions: o.sessions?.(repo) ?? [] });
  o.registry?.(claudeHome);
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: claudeHome },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
  });
  contexts.push(ctx);
  const service = createIngestService(ctx, o.service);
  services.push(service);
  return {
    ctx,
    root,
    repo,
    claudeHome,
    spoolDir: path.join(ctx.instanceDir, 'data', 'spool'),
    projectDir: path.join(claudeHome, 'projects', sanitizeProjectName(repo)),
    service,
    another: () => {
      const next = createIngestService(ctx, o.service);
      services.push(next);
      return next;
    },
    all: (sql, params = {}) => ctx.db.driver.prepare<never>(sql).all(params),
    one: (sql, params = {}) => ctx.db.driver.prepare<{ n: number }>(sql).get(params)?.n ?? -1,
  };
}

/** A session of the Claude home for the repository of the harness. */
function session(
  repo: string,
  startMs: number,
  build: SessionSpec['build'],
  extra: Partial<SessionSpec> = {},
): SessionSpec {
  return { id: SESSION, project: sanitizeProjectName(repo), cwd: repo, startMs, build, ...extra };
}

const PromptIdSchema = z.object({ promptId: z.string() });

/** The lab sequence of the hooks for `SESSION`, with the prompt id the transcript uses. */
function hooksFor(h: Harness, startAt: number, promptId: string = PROMPT_ID, stepMs = 1000): HookEnvelopeV1[] {
  return labSequence({ startAt, stepMs, sessionId: SESSION, instanceId: h.ctx.instanceId }).map((envelope) =>
    envelope.prompt_id === PROMPT_ID ? { ...envelope, prompt_id: promptId } : envelope,
  );
}

const NOW = (): number => Date.now();

describe('T-PL-13 start, untilIdle, stop', () => {
  it('start drains a pre-filled spool before it resolves (T-PL-01 hooks half, T-HE-03 a)', async () => {
    const h = await harness();
    appendEnvelopes(h.spoolDir, hooksFor(h, NOW() - 20 * MIN));
    await h.service.start();
    expect(h.one('SELECT count(*) AS n FROM sessions')).toBe(1);
    expect(h.one('SELECT count(*) AS n FROM tool_calls')).toBe(5);
    expect(h.one("SELECT count(*) AS n FROM agents WHERE agent_uid <> 'main'")).toBe(1);
    const kinds = h.all<{ kind: string }>('SELECT DISTINCT kind FROM events').map((row) => row.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['prompt.submit', 'tool.call', 'tool.result', 'tool.failure', 'permission.denied']),
    );
    // the envelopes are older than the start of this process: the downtime is recorded once
    expect(h.one("SELECT count(*) AS n FROM reconciliations WHERE kind = 'runtime_unavailable'")).toBe(1);
    expect(h.service.stats()).toMatchObject({ spoolBytesBehind: 0, queued: 0, failures: 0 });
    await h.service.stop(NOW() + 2000);
  });

  it('untilIdle on a stopped service rejects instead of reporting idle', async () => {
    const h = await harness();
    await h.service.start();
    await h.service.stop(NOW() + 2000);
    await expect(h.service.untilIdle({ timeoutMs: 1000 })).rejects.toMatchObject({ name: 'IngestWriterClosedError' });
  });

  it('merges the transcript of the same session into the rows the hooks made (T-PL-01, T-HE-01)', async () => {
    const t0 = NOW() - 20 * MIN;
    let promptId = '';
    const h = await harness({
      sessions: (repo) => [
        session(repo, t0 + 500, (b) => {
          b.user('FIXTURE prompt');
          promptId = PromptIdSchema.parse(JSON.parse(b.lines()[0] ?? '{}')).promptId;
          b.toolResult(b.toolUse('Bash', undefined, { id: TOOL_BASH }));
          b.assistant({ messageId: 'msg_fixture_end', stop: 'end_turn' });
        }),
      ],
    });
    appendEnvelopes(h.spoolDir, hooksFor(h, t0, promptId));
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });

    expect(h.one('SELECT count(*) AS n FROM sessions')).toBe(1);
    expect(h.one('SELECT count(*) AS n FROM tool_calls')).toBe(5);
    const sourcesOf = (id: string): number =>
      h.one('SELECT sources AS n FROM tool_calls WHERE tool_use_id = :id', { id });
    // hook pre (1) + hook post (2) + transcript use (4) + transcript result (8), one row; the batch bit (16) is the hook batch
    expect(sourcesOf(TOOL_BASH) & 15).toBe(15);
    expect(h.one('SELECT count(*) AS n FROM tool_calls WHERE tool_use_id = :id', { id: TOOL_BASH })).toBe(1);
    // a call that only the hooks know keeps its own bits
    expect(sourcesOf('toolu_seq_denied_004') & 12).toBe(0);
    // the prompt of both sources is one row
    expect(h.one("SELECT count(*) AS n FROM events WHERE kind = 'prompt.submit'")).toBe(1);
    expect(h.one("SELECT count(*) AS n FROM events WHERE kind = 'prompt.submit' AND sources = 3")).toBe(1);
    expect(
      h.all<{ coverage: string; tools: number; turns: number }>(
        'SELECT hook_coverage AS coverage, hook_missing_tools AS tools, hook_missing_turns AS turns FROM sessions',
      ),
    ).toEqual([{ coverage: 'full', tools: 0, turns: 0 }]);
    await h.service.stop(NOW() + 2000);
  });

  it('links the file of a subagent to the agent the hooks made and merges its tool call (T-HE-01)', async () => {
    const t0 = NOW() - 20 * MIN;
    let promptId = '';
    const h = await harness({
      sessions: (repo) => [
        session(
          repo,
          t0 + 500,
          (b) => {
            b.user('FIXTURE prompt');
            promptId = PromptIdSchema.parse(JSON.parse(b.lines()[0] ?? '{}')).promptId;
          },
          {
            subagents: [
              {
                agentId: SUBAGENT_ID,
                meta: { agentType: 'general-purpose', description: 'FIXTURE helper', toolUseId: TOOL_AGENT },
                build: (b: TranscriptBuilder) => {
                  b.user('FIXTURE helper prompt');
                  b.toolResult(b.toolUse('Read', undefined, { id: TOOL_READ }));
                },
              },
            ],
          },
        ),
      ],
    });
    appendEnvelopes(h.spoolDir, hooksFor(h, t0, promptId));
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    expect(h.one("SELECT count(*) AS n FROM agents WHERE agent_uid <> 'main'")).toBe(1);
    expect(h.one('SELECT count(*) AS n FROM tool_calls WHERE tool_use_id = :id', { id: TOOL_READ })).toBe(1);
    expect(h.one('SELECT sources AS n FROM tool_calls WHERE tool_use_id = :id', { id: TOOL_READ }) & 15).toBe(15);
    // the coverage of this session is not asserted: the writer counts the first prompt record of the subagent file as a
    // transcript prompt without a hook (CR-WP-35-3), which makes the coverage `partial`
    await h.service.stop(NOW() + 2000);
  });

  it('counts a hook gap when transcript tools have no hook, and ignores the last 5 s before the end (T-HE-02)', async () => {
    const t0 = NOW() - 30 * MIN;
    const h = await harness({
      sessions: (repo) => [
        session(repo, t0, (b) => {
          b.user('FIXTURE prompt');
          b.toolResult(b.toolUse('Bash', undefined, { id: 'toolu_gap_a' })); // t0 + 1 s, no hook
          b.advance(93_000);
          b.toolResult(b.toolUse('Bash', undefined, { id: 'toolu_gap_b' })); // t0 + 96 s, 4 s before the end
        }),
      ],
    });
    const lab = hooksFor(h, t0, PROMPT_ID, 4000);
    const start = lab[0];
    const end = lab[lab.length - 1];
    if (start === undefined || end === undefined) throw new Error('the lab sequence is empty');
    // the session ends 100 s after it began: the second tool call started 4 s before that
    appendEnvelopes(h.spoolDir, [start, { ...end, received_at: t0 + 100_000 }]);
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const row = h.all<{ coverage: string; tools: number; turns: number }>(
      'SELECT hook_coverage AS coverage, hook_missing_tools AS tools, hook_missing_turns AS turns FROM sessions',
    );
    expect(row).toEqual([{ coverage: 'partial', tools: 1, turns: 0 }]);
    expect(h.one("SELECT count(*) AS n FROM reconciliations WHERE kind = 'hook_gap'")).toBe(1);
    await h.service.stop(NOW() + 2000);
  });

  it('imports a 30 MB transcript and untilIdle resolves when nothing is left (T-PL-13)', async () => {
    const h = await harness({
      runtime: { import: { backfillShare: 1 } },
      sessions: (repo) => [session(repo, NOW() - 60 * MIN, () => undefined)],
    });
    bigTranscript({ sessionId: SESSION, targetBytes: 30 * 1024 * 1024 }).write(
      path.join(h.projectDir, `${SESSION}.jsonl`),
    );
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 120_000 });
    const stats = h.service.stats();
    expect(stats).toMatchObject({ transcriptBytesBehind: 0, backfillRemainingBytes: 0, queued: 0 });
    expect(stats.filesTracked).toBeGreaterThanOrEqual(1);
    expect(h.one('SELECT count(*) AS n FROM sessions WHERE session_uid = :uid', { uid: SESSION })).toBe(1);
    await h.service.stop(NOW() + 2000);
  }, 180_000);

  it('untilIdle rejects with the stats of what is left while a file keeps growing', async () => {
    const h = await harness({
      sessions: (repo) => [
        session(repo, NOW() - 10 * MIN, (b) => {
          b.user('FIXTURE prompt');
        }),
      ],
      service: {
        idlePollMs: 5,
        // the file grows at every look of untilIdle: it can never be caught up
        onIdlePoll: () => {
          appendFileSync(
            path.join(path.join(tempProject.current, `${SESSION}.jsonl`)),
            `${JSON.stringify({ type: 'user', uuid: `u-${String(NOW())}`, sessionId: SESSION, timestamp: new Date().toISOString(), message: { role: 'user', content: 'FIXTURE growing' } })}\n`,
          );
        },
      },
    });
    tempProject.current = h.projectDir;
    await h.service.start();
    const started = NOW();
    const failure = await h.service.untilIdle({ timeoutMs: 400 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(IngestIdleTimeoutError);
    expect(failure instanceof IngestIdleTimeoutError ? failure.name : '').toBe('IngestIdleTimeoutError');
    expect(failure instanceof IngestIdleTimeoutError ? failure.pending.filesTracked : 0).toBeGreaterThanOrEqual(1);
    expect(NOW() - started).toBeLessThan(2000);
    await h.service.stop(NOW() + 2000);
  });

  it('stop with a full queue returns by its deadline and a restart ingests the rest without duplicates', async () => {
    const h = await harness({
      runtime: { ingest: { queueMaxItems: 100 } },
      service: {
        // many small batches: one batch is one unit of a transaction
        drainer: { sliceMs: 1, chunkBytes: 8192 },
        writer: {
          maxItemsPerTx: 20,
          // every transaction takes 30 ms, so a queue of 4000 lines is full for seconds
          beforeCommit: () => {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
          },
        },
      },
    });
    await h.service.start();
    const base = NOW() - 5 * MIN;
    const envelopes: HookEnvelopeV1[] = [];
    for (let n = 0; n < 4000; n += 1) {
      envelopes.push(
        fixtureEnvelope('Notification', {
          eventUid: `00000000-0000-4000-8000-${(n + 100).toString(16).padStart(12, '0')}`,
          receivedAt: base + n,
          top: {
            instance_id: h.ctx.instanceId,
            session_id: SESSION,
            content_hash: (n + 100).toString(16).padStart(32, '0'),
          },
          data: { notification_type: 'idle_prompt', message_preview: `FIXTURE ${String(n)}` },
        }),
      );
    }
    appendEnvelopes(h.spoolDir, envelopes);
    h.service.nudge();
    await waitFor(() => h.service.stats().queued > 0 || h.one('SELECT count(*) AS n FROM events') > 0, {
      what: 'the first batches',
    });
    const started = NOW();
    await h.service.stop(NOW() + 500);
    const took = NOW() - started;
    // T-PL-13: `stop(500)` with a full queue returns within 600 ms (scaled for a slower machine)
    expect(took).toBeLessThan(600 * PERF_FACTOR);
    const partial = h.one("SELECT count(*) AS n FROM events WHERE hook_event = 'Notification'");
    expect(partial).toBeLessThan(4000);

    const again = h.another();
    await again.start();
    await again.untilIdle({ timeoutMs: 60_000 });
    expect(h.one("SELECT count(*) AS n FROM events WHERE hook_event = 'Notification'")).toBe(4000);
    expect(h.one("SELECT count(DISTINCT event_uid) AS n FROM events WHERE hook_event = 'Notification'")).toBe(4000);
    await again.stop(NOW() + 2000);
  }, 120_000);

  it('a nudge makes new lines visible at once', async () => {
    const h = await harness({ runtime: { spool: { pollMs: 10_000 } } });
    await h.service.start();
    appendEnvelopes(h.spoolDir, hooksFor(h, NOW() - 5_000).slice(0, 3));
    h.service.nudge();
    await waitFor(() => h.one('SELECT count(*) AS n FROM sessions') === 1, { what: 'the session of the nudge' });
    await h.service.untilIdle({ timeoutMs: 10_000 });
    expect(h.service.stats().spoolBytesBehind).toBe(0);
    await h.service.stop(NOW() + 2000);
  });

  it('replay resets the cursors, reads the lines again and adds no row (T-PL-03)', async () => {
    const h = await harness();
    appendEnvelopes(h.spoolDir, hooksFor(h, NOW() - 20 * MIN));
    await h.service.start();
    const before = h.one('SELECT count(*) AS n FROM events');
    const result = await h.service.replay(null);
    expect(result.segmentsReset).toBeGreaterThanOrEqual(1);
    await h.service.untilIdle({ timeoutMs: 10_000 });
    expect(h.one('SELECT count(*) AS n FROM events')).toBe(before);
    await expect(h.service.replay('hooks-20200101T00Z.ndjson')).rejects.toBeInstanceOf(SpoolSegmentNotFoundError);
    await h.service.stop(NOW() + 2000);
    await expect(h.service.replay(null)).rejects.toThrow(/closed/);
  });

  it('start twice is one start, stop twice is one stop, and a stopped service cannot start again', async () => {
    const h = await harness();
    const first = h.service.start();
    expect(h.service.start()).toBe(first);
    await first;
    const stopping = h.service.stop(NOW() + 2000);
    expect(h.service.stop(NOW() + 9000)).toBe(stopping);
    await stopping;
    await expect(h.service.start()).rejects.toThrow(/stopped/);
    await expect(h.service.stop(Number.NaN)).rejects.toThrow(RangeError);
  });

  it('a service that never started stops without writing a route file', async () => {
    const h = await harness();
    await h.service.stop(NOW() + 1000);
    expect(readRouteFile(h.ctx.mcsHome, h.ctx.instanceId)).toBeNull();
  });

  it('writes the route file at start and marks it stopped at stop', async () => {
    const h = await harness({
      runtime: { hooks: { spoolWhileStoppedHours: 2 } },
      sessions: (repo) => [session(repo, NOW() - 10 * MIN, (b) => b.user('FIXTURE prompt'))],
    });
    expect(readRouteFile(h.ctx.mcsHome, h.ctx.instanceId)).toBeNull();
    await h.service.start();
    const running = readRouteFile(h.ctx.mcsHome, h.ctx.instanceId);
    expect(running).toMatchObject({ instanceId: h.ctx.instanceId, stoppedAt: null, enabled: h.ctx.hooksEnabled });
    expect(running?.spoolDir.endsWith('/data/spool')).toBe(true);
    expect(running?.match.transcriptsDirs.length).toBeGreaterThanOrEqual(1);
    // component 6 of the composition root writes the same content again
    await publishRouteFile(h.ctx);
    expect(readRouteFile(h.ctx.mcsHome, h.ctx.instanceId)).toMatchObject({ stoppedAt: null });
    const before = NOW();
    await h.service.stop(NOW() + 2000);
    const stopped = readRouteFile(h.ctx.mcsHome, h.ctx.instanceId);
    expect(stopped?.stoppedAt).toBeGreaterThanOrEqual(before);
    expect((stopped?.spoolUntil ?? 0) - (stopped?.stoppedAt ?? 0)).toBe(2 * 3_600_000);
  });
});

describe('external evidence', () => {
  it('feeds the registry and the job state of a known session into its facts, and ignores unknown sessions', async () => {
    const t0 = NOW() - 5 * MIN;
    let pid = 0;
    const h = await harness({
      runtime: { lifecycle: { registryPollMs: 1000, jobsPollMs: 1000 } },
      registry: (home) => {
        const child = spawnTracked(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)']);
        pid = child.pid;
        writeRegistry(home, [
          registryEntry({ pid, sessionId: SESSION, status: 'busy' }),
          registryEntry({ pid: pid + 1, sessionId: '77777777-7777-4777-8777-777777777777', status: 'idle' }),
        ]);
        writeJob(home, 'job-1', jobState({ state: 'working', sessionId: SESSION }));
      },
    });
    appendEnvelopes(h.spoolDir, hooksFor(h, t0).slice(0, 3));
    await h.service.start();
    const facts = z.object({
      registry: z.object({ value: z.object({ status: z.string(), pid: z.number(), pidAlive: z.boolean() }) }),
      job: z.object({ value: z.object({ state: z.string(), jobId: z.string() }) }),
    });
    const parsed = await waitFor(
      () => {
        const [row] = h.all<{ facts: string }>('SELECT facts_json AS facts FROM sessions WHERE session_uid = :uid', {
          uid: SESSION,
        });
        const result = facts.safeParse(JSON.parse(row?.facts ?? '{}'));
        return result.success ? result.data : null;
      },
      { what: 'registry and job facts', timeoutMs: 15_000 },
    );
    expect(parsed.registry.value).toMatchObject({ status: 'busy', pid, pidAlive: true });
    expect(parsed.job.value).toEqual({ jobId: 'job-1', state: 'working' });
    // the entry of the unknown session did not create a session
    expect(h.one('SELECT count(*) AS n FROM sessions')).toBe(1);
    await h.service.stop(NOW() + 2000);
  });
});

describe('external evidence keeps its own time (ADR 0069, the live bug of 2026-10-18)', () => {
  it('a job that finished six days ago completes its old session at the job time; a later session stays open', async () => {
    const DAY = 86_400_000;
    const jobAt = NOW() - 6 * DAY;
    const LATER = '88888888-8888-4888-8888-888888888888';
    const turn = (b: TranscriptBuilder): void => {
      b.user('FIXTURE prompt');
      b.assistant({ messageId: `msg_fixture_${String(b.lines().length)}`, stop: 'end_turn' });
    };
    const h = await harness({
      runtime: { import: { lookbackHours: 24 * 30 }, lifecycle: { jobsPollMs: 1000 } },
      sessions: (repo) => [
        session(repo, jobAt - 10 * MIN, turn, { mtimeAgeMs: 6 * DAY }),
        session(repo, jobAt + 60 * MIN, turn, { id: LATER, mtimeAgeMs: 6 * DAY - 2 * 60 * MIN }),
      ],
      registry: (home) => {
        const times = { createdAt: jobAt - 20 * MIN, updatedAt: jobAt, terminalAt: jobAt };
        writeJob(home, 'job-1', jobState({ state: 'done', sessionId: SESSION, ...times }));
        writeJob(home, 'job-2', jobState({ state: 'done', sessionId: LATER, ...times }));
      },
    });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    interface ViewRow {
      readonly uid: string;
      readonly state: string;
      readonly rule: string;
      readonly since: number | null;
      readonly evidence: string;
      readonly facts: string;
    }
    const rows = await waitFor(
      () => {
        const found = h.all<ViewRow>(
          `SELECT session_uid AS uid, state, state_rule AS rule, state_since AS since, state_evidence AS evidence,
                  facts_json AS facts FROM sessions ORDER BY session_uid`,
        );
        const withJob = found.filter((row) => (JSON.parse(row.facts) as { job?: unknown }).job);
        return withJob.length === 2 ? found : null;
      },
      { what: 'job facts of both sessions', timeoutMs: 15_000 },
    );
    const old = rows.find((row) => row.uid === SESSION);
    const later = rows.find((row) => row.uid === LATER);
    expect(old).toMatchObject({ state: 'completed', rule: 'S-4a', since: jobAt });
    const evidence = z
      .array(
        z.object({ source: z.string(), fact: z.string(), at: z.number().nullable(), value: z.string().optional() }),
      )
      .parse(JSON.parse(old?.evidence ?? '[]'));
    expect(evidence[0]).toMatchObject({ source: 'job', fact: 'job_state', at: jobAt, value: 'done' });
    const stored = { at: evidence[0]?.at ?? null, value: evidence[0]?.value ?? '' };
    expect(renderEvidence({ source: 'job', fact: 'job_state', ...stored }, NOW())).toBe('daemon job done 6d ago');
    // the transcript of the second session was written after the job: the job does not complete it
    expect(later?.state).not.toBe('completed');
    expect(later?.rule).not.toBe('S-4a');
    await h.service.stop(NOW() + 2000);
  });
});

describe('external evidence: damaged files', () => {
  it('records one EXTERNAL_READ_FAILED for a damaged registry file, not one per poll', async () => {
    let registryPolls = 0;
    const h = await harness({
      runtime: { lifecycle: { registryPollMs: 1000 } },
      registry: (home) => {
        const dir = writeRegistry(home, []);
        writeFileSync(path.join(dir, '4242.json'), '{"pid": 4242, FIXTURE damaged');
      },
      service: {
        externalFs: {
          readdir: (dir) => {
            if (path.basename(dir) === 'sessions') registryPolls += 1;
            return nodeExternalFs.readdir(dir);
          },
          readSmall: (file, max) => nodeExternalFs.readSmall(file, max),
        },
      },
    });
    await h.service.start();
    await waitFor(() => registryPolls >= 3 && h.service.stats().queued === 0, {
      what: 'three polls of the registry',
      timeoutMs: 15_000,
    });
    await h.service.writer.flushNow();
    expect(h.one("SELECT count(*) AS n FROM ingest_errors WHERE code = 'EXTERNAL_READ_FAILED'")).toBe(1);
    await h.service.stop(NOW() + 2000);
  });
});

describe('the composition root with the real factories (registry C06)', () => {
  it('ingests on its own, ingestUntilIdle says idle, and the health of the runtime is evaluated', async () => {
    const t0 = NOW() - 20 * MIN;
    const h = await harness({
      sessions: (repo) => [session(repo, t0 + 500, (b) => b.user('FIXTURE prompt'))],
    });
    appendEnvelopes(h.spoolDir, hooksFor(h, t0));
    const runtime = createInstanceRuntime(h.ctx);
    await runtime.start();
    const result = await runtime.ingestUntilIdle({ timeoutMs: 30_000 });
    expect(result.idle).toBe(true);
    expect(result.stats).toMatchObject({ queued: 0, spoolBytesBehind: 0, transcriptBytesBehind: 0 });
    expect(h.one('SELECT count(*) AS n FROM sessions')).toBe(1);
    // the schedule of the runtime evaluated the ingestion health at start
    const health = await waitFor(
      () => {
        const report = runtime.health();
        return report.ingestion.status === 'unknown' ? null : report;
      },
      { what: 'the first ingestion health report', timeoutMs: 10_000 },
    );
    expect(health.ingestion.transcripts.dirFound).toBe(true);
    expect((await runtime.stop(NOW() + 5000)).completed).toBe(true);
    expect(readRouteFile(h.ctx.mcsHome, h.ctx.instanceId)?.stoppedAt).not.toBeNull();
  });

  it('ingestReplay goes through the ingest service', async () => {
    const h = await harness();
    appendEnvelopes(h.spoolDir, hooksFor(h, NOW() - 20 * MIN));
    const runtime = createInstanceRuntime(h.ctx);
    await runtime.start();
    expect((await runtime.ingestReplay(null)).segments).toBeGreaterThanOrEqual(1);
    await runtime.stop(NOW() + 5000);
  });
});

describe('the lifecycle sweeper over the real writer (T-LF-50)', () => {
  it('re-derives a due session and publishes nothing when its view did not change', async () => {
    const h = await harness();
    appendEnvelopes(h.spoolDir, hooksFor(h, NOW() - 20 * MIN).slice(0, 2));
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 10_000 });
    const before = h.all<{ at: number; next: number | null; changed: number }>(
      'SELECT evaluated_at AS at, next_check_at AS next, updated_seq AS changed FROM sessions',
    )[0];
    const changes = h.one("SELECT count(*) AS n FROM changes WHERE kind = 'session'");
    // make the row due without changing anything the view depends on
    h.ctx.db.driver.prepare('UPDATE sessions SET next_check_at = :at').run({ at: NOW() - 1 });
    const sweeper = createLifecycleSweeper(h.ctx, h.service, { pidAlive: () => true });
    await sweeper.tickNow();
    await h.service.writer.flushNow();
    const after = h.all<{ at: number; next: number | null; changed: number }>(
      'SELECT evaluated_at AS at, next_check_at AS next, updated_seq AS changed FROM sessions',
    )[0];
    expect(after?.at ?? 0).toBeGreaterThan(before?.at ?? Number.POSITIVE_INFINITY);
    expect(after?.next === null || (after?.next ?? 0) > NOW()).toBe(true);
    expect(after?.changed).toBe(before?.changed);
    expect(h.one("SELECT count(*) AS n FROM changes WHERE kind = 'session'")).toBe(changes);
    await h.service.stop(NOW() + 2000);
  });
});

describe('ingestion health over the real service', () => {
  it('reports a valid, ok-or-degraded report and shows the transcripts and the spool of this instance (T-HE-03)', async () => {
    const t0 = NOW() - 20 * MIN;
    const h = await harness({
      sessions: (repo) => [session(repo, t0 + 500, (b) => b.user('FIXTURE prompt'))],
    });
    appendEnvelopes(h.spoolDir, hooksFor(h, t0));
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const report = await ingestHealthEvaluatorOf(h.ctx).refresh();
    expect(IngestHealthSchema.parse(report)).toEqual(report);
    expect(report.receiving.transcripts).toMatchObject({ dirFound: true, filesTracked: 1, bytesBehind: 0 });
    expect(report.receiving.hooks.lastEnvelopeAt).toBe(t0 + 26_000);
    expect(report.receiving.spool).toMatchObject({ bytesBehind: 0, foreignFiles: 0 });
    expect(report.persisted.status).toBe('ok');
    expect(report.status).not.toBe('down');
    // the transcripts of another folder are not this instance's: removing the folder changes only that block (c)
    await h.service.stop(NOW() + 2000);
  });

  it('shows a removed transcripts folder in the transcripts block only (T-HE-03 c)', async () => {
    const t0 = NOW() - 20 * MIN;
    const h = await harness({ sessions: (repo) => [session(repo, t0 + 500, (b) => b.user('FIXTURE prompt'))] });
    appendEnvelopes(h.spoolDir, hooksFor(h, t0));
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const before = await ingestHealthEvaluatorOf(h.ctx).refresh();
    expect(before.receiving.transcripts.status).not.toBe('not_found');
    rmSync(h.projectDir, { recursive: true, force: true });
    const after = await ingestHealthEvaluatorOf(h.ctx).refresh();
    expect(after.receiving.transcripts).toMatchObject({ status: 'not_found', dirFound: false });
    expect(after.receiving.hooks.status).toBe(before.receiving.hooks.status);
    expect(after.persisted.status).toBe('ok');
    await h.service.stop(NOW() + 2000);
  });

  it('shows a database that cannot be written in the persisted block only (T-HE-03 b)', async () => {
    const t0 = NOW() - 20 * MIN;
    const h = await harness({
      service: { writer: { retryBaseMs: 1, retryMaxMs: 2, sleep: () => Promise.resolve() } },
    });
    appendEnvelopes(h.spoolDir, hooksFor(h, t0).slice(0, 3));
    await h.service.start();
    const healthy = await ingestHealthEvaluatorOf(h.ctx).refresh();
    expect(healthy.receiving.hooks.status).toBe('ok');
    // the file stays readable, writes are refused
    h.ctx.db.driver.pragma('query_only = ON');
    appendEnvelopes(h.spoolDir, hooksFor(h, t0 + 60_000, PROMPT_ID, 1000).slice(3, 6));
    h.service.nudge();
    await waitFor(() => h.service.stats().failures > 0, { what: 'a failed commit' });
    const report = await ingestHealthEvaluatorOf(h.ctx).refresh();
    expect(report.persisted.status).toBe('failing');
    expect(report.persisted.lastError).not.toBeNull();
    expect(report.receiving.hooks.status).toBe('ok');
    expect(report.status).toBe('down');
    h.ctx.db.driver.pragma('query_only = OFF');
    await h.service.stop(NOW() + 2000);
  });

  it('counts the hook failures of the transcripts that carry the marker of our handler (T-HE-05)', async () => {
    const t0 = NOW() - 20 * MIN;
    const h = await harness({
      sessions: (repo) => [
        session(repo, t0, (b) => {
          b.user('FIXTURE prompt');
          b.attachment('hook_success', {
            type: 'hook_non_blocking_error',
            hookEvent: 'Stop',
            command: 'node FIXTURE/mcs-hook.mjs --mcs-hook Stop',
            exitCode: 1,
          });
          b.attachment('hook_success', {
            type: 'hook_non_blocking_error',
            hookEvent: 'Stop',
            command: 'node FIXTURE/another-tool.mjs',
            exitCode: 1,
          });
        }),
      ],
    });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const report = await ingestHealthEvaluatorOf(h.ctx).refresh();
    expect(report.receiving.hooks.transcriptHookFailures).toBe(1);
    expect(report.receiving.hooks.status).toBe('failing');
    await h.service.stop(NOW() + 2000);
  });

  it('keeps lastSyncAt where it is while a file is behind and moves it when everything is caught up (T-HE-06)', async () => {
    const h = await harness({
      sessions: (repo) => [session(repo, NOW() - 10 * MIN, (b) => b.user('FIXTURE prompt'))],
    });
    await h.service.start();
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const caught = (await ingestHealthEvaluatorOf(h.ctx).refresh()).receiving.transcripts;
    expect(caught.lastSyncAt).not.toBeNull();
    expect(caught.maxLagMs).toBe(0);
    writeFileSync(
      path.join(h.projectDir, `${SESSION}.jsonl`),
      readFileSync(path.join(h.projectDir, `${SESSION}.jsonl`)),
    );
    appendFileSync(
      path.join(h.projectDir, `${SESSION}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: 'u-late', sessionId: SESSION, timestamp: new Date().toISOString(), message: { role: 'user', content: 'FIXTURE later' } })}\n`,
    );
    await h.service.untilIdle({ timeoutMs: 30_000 });
    const later = (await ingestHealthEvaluatorOf(h.ctx).refresh()).receiving.transcripts;
    expect(later.lastSyncAt ?? 0).toBeGreaterThanOrEqual(caught.lastSyncAt ?? Number.POSITIVE_INFINITY);
    expect(later.bytesBehind).toBe(0);
    await h.service.stop(NOW() + 2000);
  });
});

/** The folder of the growing transcript, known after the harness exists (the callback is built before it). */
const tempProject: { current: string } = { current: '' };
