// 02 9.3 item 8: the worked example of 02 6.4 through the whole product path. The transcripts of the example are written into a
// temp Claude home (two sessions, one subagent file, a resume copy), the real ingest service imports them into a real database,
// and the totals that the query layer behind the API reports equal the table of 02 6.4. `worked-example.test.ts` proves the same
// numbers from records fed to the accumulator and `analytics.int.test.ts` from rows written into the tables; this file is the
// one that reads files from disk (T-TK-01 end to end, CR-WP-34-1: the usage rows survive the import).
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  RUNTIME_VERSION,
  SessionUsageQuerySchema,
  UsageQuerySchema,
  isoMsZ,
  type UsageReport,
  type UsageRow,
} from '@mcs/shared';
import { sanitizeProjectName } from '@mcs/shared/protocol';
import { buildClaudeHome, useTempDirs, waitFor, type TranscriptBuilder } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { createIngestService, type IngestService } from '../src/ingest/service.ts';
import type { Logger } from '../src/log/logger.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { initWorkspace } from '../src/workspace/init.ts';

const makeTemp = useTempDirs();

/** FIXTURE ids. S1 sorts before S2, so a tie in the birth time of their files still names S1 the owner of the shared message. */
const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const AGENT = 'a1b2c3';
const SYNTHETIC_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const MIN = 60_000;

const contexts: InstanceContext[] = [];
const services: IngestService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop(Date.now() + 2000).catch(() => undefined);
  for (const ctx of contexts.splice(0)) {
    ctx.db.close();
    await ctx.logger.close();
  }
});

function quietLogger(): Logger {
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

// ---- the records of 02 6.4 ----------------------------------------------------------------------------------------------

interface Four {
  readonly i: number;
  readonly o: number;
  readonly cr: number;
  readonly cc: number;
  /** The 5-minute and 1-hour parts of the cache creation. */
  readonly split?: readonly [number, number];
}

const usageObject = (f: Four): Record<string, unknown> => ({
  input_tokens: f.i,
  output_tokens: f.o,
  cache_read_input_tokens: f.cr,
  cache_creation_input_tokens: f.cc,
  ...(f.split === undefined
    ? {}
    : { cache_creation: { ephemeral_5m_input_tokens: f.split[0], ephemeral_1h_input_tokens: f.split[1] } }),
});

interface Msg {
  /** The message id. */
  readonly id: string;
  readonly model: string;
  /** `null`: the record has no `usage` object at all. */
  readonly usage: Four | null;
  /** The top-level counters are `usage`; `iterations[0]` is the same four (the final record of a streamed message). */
  readonly iterations?: Four;
  readonly stop: string | null;
}

const A: Four = { i: 10, o: 200, cr: 5000, cc: 1000, split: [0, 1000] };
const B: Four = { i: 4, o: 50, cr: 6000, cc: 0, split: [0, 0] };
const Z: Four = { i: 2, o: 300, cr: 959_572, cc: 4000, split: [0, 4000] };
const E: Four = { i: 6, o: 70, cr: 7000, cc: 500, split: [0, 500] };
const ZERO: Four = { i: 0, o: 0, cr: 0, cc: 0 };
const C = (o: number): Four => ({ i: 3, o, cr: 1000, cc: 200, split: [200, 0] });
const D: Four = { i: 5, o: 8, cr: 800, cc: 0, split: [0, 0] };

let uuidSeq = 0;
const nextUuid = (): string => `00000000-0000-4000-8000-${String((uuidSeq += 1)).padStart(12, '0')}`;

/** One assistant record; `uuid` and `at` are fixed by the caller so that a resume copy can repeat them. */
function assistant(
  b: TranscriptBuilder,
  ctx: { sessionId: string; cwd: string; agentId?: string },
  m: Msg,
  at: number,
  uuid: string = nextUuid(),
): void {
  const usage =
    m.usage === null
      ? undefined
      : { ...usageObject(m.usage), ...(m.iterations === undefined ? {} : { iterations: [usageObject(m.iterations)] }) };
  b.raw({
    type: 'assistant',
    uuid,
    parentUuid: null,
    isSidechain: ctx.agentId !== undefined,
    ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    timestamp: isoMsZ(at),
    message: {
      id: m.id,
      type: 'message',
      role: 'assistant',
      model: m.model,
      content: [{ type: 'text', text: 'FIXTURE reply' }],
      stop_reason: m.stop,
      stop_sequence: null,
      ...(usage === undefined ? {} : { usage }),
    },
  });
}

const msgA1: Msg = { id: 'msg_A', model: 'model-x', usage: A, stop: null };
const msgA2: Msg = { id: 'msg_A', model: 'model-x', usage: A, iterations: A, stop: 'end_turn' };

interface Example {
  readonly ctx: InstanceContext;
  readonly service: IngestService;
}

/** The worked example imported by the real service: F1 = S1 main, F2 = S1 subagent, F3 = S2 main (a resume of S1). */
async function importedExample(): Promise<Example> {
  const root = makeTemp('import-tokens').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo' });
  const claudeHome = path.join(root, 'claude-home');
  const project = sanitizeProjectName(repo);
  const t0 = Date.now() - 3 * 60 * MIN;
  const nowMs = Date.now();

  // the copies in F3 repeat the uuid and the time of the records of F1, as a resumed session does
  const copyUuids = [nextUuid(), nextUuid()];
  const mainOf = (sessionId: string) => ({ sessionId, cwd: repo });

  // S1 first: its files are older than the file of S2
  buildClaudeHome(claudeHome, {
    nowMs,
    sessions: [
      {
        id: S1,
        project,
        cwd: repo,
        startMs: t0,
        build: (b) => {
          b.user('FIXTURE worked example');
          const at = (n: number): number => t0 + n * 1000;
          assistant(b, mainOf(S1), msgA1, at(1), copyUuids[0]);
          assistant(b, mainOf(S1), msgA2, at(2), copyUuids[1]);
          assistant(b, mainOf(S1), { id: 'msg_B', model: 'model-x', usage: B, iterations: B, stop: 'tool_use' }, at(3));
          assistant(
            b,
            mainOf(S1),
            { id: 'msg_Z', model: 'model-x', usage: ZERO, iterations: Z, stop: 'tool_use' },
            at(4),
          );
          assistant(
            b,
            mainOf(S1),
            { id: SYNTHETIC_ID, model: '<synthetic>', usage: ZERO, stop: 'stop_sequence' },
            at(5),
          );
          assistant(b, mainOf(S1), { id: 'msg_N', model: 'model-x', usage: null, stop: 'end_turn' }, at(6));
        },
        subagents: [
          {
            agentId: AGENT,
            meta: { agentType: 'reviewer', description: 'FIXTURE reviewer' },
            startMs: t0 + 5 * MIN,
            build: (b) => {
              b.user('FIXTURE reviewer task');
              const ctx = { ...mainOf(S1), agentId: AGENT };
              const at = (n: number): number => t0 + 5 * MIN + n * 1000;
              const c = (o: number, last: boolean): Msg => ({
                id: 'msg_C',
                model: 'model-y',
                usage: C(o),
                ...(last ? { iterations: C(o) } : {}),
                stop: last ? 'tool_use' : null,
              });
              assistant(b, ctx, c(8, false), at(1));
              assistant(b, ctx, c(8, false), at(2));
              assistant(b, ctx, c(412, true), at(3));
              // msg_D never gets a final record: its output is a lower bound
              assistant(b, ctx, { id: 'msg_D', model: 'model-y', usage: D, stop: null }, at(4));
              assistant(b, ctx, { id: 'msg_D', model: 'model-y', usage: D, stop: null }, at(5));
            },
          },
        ],
      },
    ],
  });
  // the files of S2 must be born after those of S1: let the clock move on
  const firstFilesAt = Date.now();
  await waitFor(() => Date.now() > firstFilesAt + 30, { what: 'the clock to move past the files of S1' });
  buildClaudeHome(claudeHome, {
    nowMs,
    sessions: [
      {
        id: S2,
        project,
        cwd: repo,
        startMs: t0 + 60 * MIN,
        build: (b) => {
          b.user('FIXTURE resumed');
          assistant(b, mainOf(S2), msgA1, t0 + 1000, copyUuids[0]);
          assistant(b, mainOf(S2), msgA2, t0 + 2000, copyUuids[1]);
          assistant(
            b,
            mainOf(S2),
            { id: 'msg_E', model: 'model-x', usage: E, iterations: E, stop: 'end_turn' },
            t0 + 60 * MIN + 2000,
          );
        },
      },
    ],
  });

  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: claudeHome },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    logger: quietLogger(),
  });
  contexts.push(ctx);
  const service = createIngestService(ctx);
  services.push(service);
  await service.start();
  await service.untilIdle({ timeoutMs: 60_000 });
  return { ctx, service };
}

// ---- reading the numbers the way the API does ----------------------------------------------------------------------------

function usageOf(ctx: InstanceContext, params: Record<string, string> = {}): UsageReport {
  return ctx.queries.usage(ctx.scope, UsageQuerySchema.parse({ groupBy: 'none', range: 'all', ...params }));
}

const four = (row: UsageRow): (number | null)[] => [
  row.usage.input,
  row.usage.output,
  row.usage.cacheRead,
  row.usage.cacheCreation,
];

function rowOf(report: UsageReport, key: string): UsageRow {
  const row = report.rows.find((r) => r.key === key);
  if (row === undefined) throw new Error(`no row ${key} in ${JSON.stringify(report.rows.map((r) => r.key))}`);
  return row;
}

describe('02 9.3 item 8: the worked example, imported from files, equals the table of 02 6.4', () => {
  it('imports the three files and nothing is left to read', async () => {
    const { ctx, service } = await importedExample();
    const files = ctx.db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM transcript_files').get()?.n;
    expect(files).toBe(3);
    expect(service.stats()).toMatchObject({ transcriptBytesBehind: 0, queued: 0, failures: 0 });
    expect(ctx.db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM sessions').get()?.n).toBe(2);
  }, 90_000);

  it('S1 in total, S2 and the instance have the totals of the table', async () => {
    const { ctx } = await importedExample();
    const s1 = usageOf(ctx, { session: S1 }).totals;
    expect(four(s1)).toEqual([24, 970, 972_372, 5200]);
    expect(s1.usage).toMatchObject({ turns: 7, synthetic: 1, unfinalized: 1, lowerBound: true });
    expect(s1.usage.missing).toEqual({ input: 1, output: 1, cacheCreation: 1, cacheRead: 1 });
    expect(s1.sessions).toBe(1);

    const s2 = usageOf(ctx, { session: S2 }).totals;
    expect(four(s2)).toEqual([6, 70, 7000, 500]);

    const instance = usageOf(ctx).totals;
    expect(four(instance)).toEqual([30, 1040, 979_372, 5700]);
    expect(instance.usage).toMatchObject({ turns: 8, synthetic: 1 });
    expect(instance.sessions).toBe(2);
  }, 90_000);

  it('the models add up to the instance, and the synthetic message belongs to no model row', async () => {
    const { ctx } = await importedExample();
    const report = usageOf(ctx, { groupBy: 'model' });
    expect(report.rows.map((r) => r.key)).toEqual(['model-x', 'model-y']);
    expect(four(rowOf(report, 'model-x'))).toEqual([22, 620, 977_572, 5500]);
    expect(rowOf(report, 'model-x').usage.turns).toBe(5);
    expect(four(rowOf(report, 'model-y'))).toEqual([8, 420, 1800, 200]);
    expect(rowOf(report, 'model-y').usage.lowerBound).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      const sum = report.rows.reduce((n, row) => n + (four(row)[i] ?? 0), 0);
      expect(sum).toBe(four(report.totals)[i]);
    }
  }, 90_000);

  it('the main agent and the subagent of S1 add up to S1', async () => {
    const { ctx } = await importedExample();
    const report = ctx.queries.sessionUsage(ctx.scope, S1, SessionUsageQuerySchema.parse({}));
    expect(report.groupBy).toBe('agent');
    expect(four(rowOf(report, 'main'))).toEqual([16, 550, 970_572, 5000]);
    const sub = report.rows.find((r) => r.key !== 'main');
    expect(sub?.key).toContain(AGENT);
    expect(sub === undefined ? null : four(sub)).toEqual([8, 420, 1800, 200]);
    expect(four(report.totals)).toEqual([24, 970, 972_372, 5200]);
  }, 90_000);

  it('a restart of the service reads nothing again: the totals are the same', async () => {
    const { ctx, service } = await importedExample();
    const before = usageOf(ctx).totals;
    await service.stop(Date.now() + 2000);
    const next = createIngestService(ctx);
    services.push(next);
    await next.start();
    await next.untilIdle({ timeoutMs: 60_000 });
    expect(usageOf(ctx).totals).toEqual(before);
    expect(four(usageOf(ctx).totals)).toEqual([30, 1040, 979_372, 5700]);
  }, 90_000);
});
