// `decide` and `audit` (01 6.4, 7.1, 7.2): the decision entry bytes, and the legacy plus Node checks of a workspace.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { McsError, type Clock } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, makeJunction, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { Logger } from '../log/logger.ts';
import { check, recordDecision } from './audit.ts';
import { resolveWorkspace, withTaskMutex } from '../workspace/paths.ts';
import { init, type OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const STAMP = '2026-10-11T14:05:07Z';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

function contextFor(repo: string, clock: Clock = new FakeClock(NOW)): OpContext {
  const skillDir = defaultSkillDir();
  return {
    repo,
    root: path.join(repo, '.claude', 'monitor', 'tasks'),
    skillDir,
    runtimeDir: path.join(skillDir, 'runtime'),
    launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
    env: {},
    clock,
    log: silent,
  };
}

async function nodeRepo(...names: string[]): Promise<OpContext> {
  const { repo } = buildRepo(makeTemp('audit').path);
  const ctx = contextFor(repo);
  for (const name of names) await init(ctx, { name });
  return ctx;
}

function wsPath(ctx: OpContext, slug: string, ...rel: string[]): string {
  return path.join(ctx.root, slug, ...rel);
}

async function failure(promise: Promise<unknown>): Promise<McsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('recordDecision', () => {
  it('appends the decision entry with the legacy bytes and reports the file', async () => {
    const ctx = await nodeRepo('alpha');
    const result = await recordDecision(ctx, {
      task: 'alpha',
      title: 'Use port 9000',
      decision: 'Pin the port.',
      rejected: 'Random port.',
    });
    const file = wsPath(ctx, 'alpha', 'audit', 'decisions.md');
    expect(readFileSync(file, 'utf8')).toBe(
      `# Decisions\n\n## ${STAMP} | Use port 9000\n- Decision: Pin the port.\n- Rejected alternatives: Random port.\n\n`,
    );
    expect(result.path).toBe(file);
    expect(result.message).toBe(`recorded decision in ${file}`);
  });

  it('stamps the entry when it is appended, not when the call started waiting for the task lock', async () => {
    const clock = new FakeClock(NOW);
    const { repo } = buildRepo(makeTemp('audit').path);
    const ctx = contextFor(repo, clock);
    await init(ctx, { name: 'alpha' });
    const ws = resolveWorkspace(ctx.root, 'alpha');
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const isHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holder = withTaskMutex(
      ws,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          held();
        }),
    );
    await isHeld;
    const pending = recordDecision(ctx, { task: 'alpha', title: 'Waited', decision: 'Stamped late.' });
    await sleep(100);
    clock.advance(5000);
    release();
    await holder;
    await pending;
    expect(readFileSync(wsPath(ctx, 'alpha', 'audit', 'decisions.md'), 'utf8')).toContain(
      '## 2026-10-11T14:05:12Z | Waited',
    );
  });

  it('writes "none recorded" without alternatives and appends a second entry under one header', async () => {
    const ctx = await nodeRepo('alpha');
    await recordDecision(ctx, { task: 'alpha', title: 'One', decision: 'a' });
    await recordDecision(ctx, { task: 'alpha', title: 'Two', decision: 'b', rejected: '' });
    const text = readFileSync(wsPath(ctx, 'alpha', 'audit', 'decisions.md'), 'utf8');
    expect(text.match(/^# Decisions$/gm)).toHaveLength(1);
    expect(text.match(/^## /gm)).toHaveLength(2);
    expect(text.match(/- Rejected alternatives: none recorded/g)).toHaveLength(2);
  });

  it('cannot forge a second entry through a line break in a field (T-AU-05)', async () => {
    const ctx = await nodeRepo('alpha');
    await recordDecision(ctx, {
      task: 'alpha',
      title: 'T\n## 2026-01-01T00:00:00Z | fake',
      decision: 'd\r\n## x',
      rejected: 'r\n## y',
    });
    const lines = readFileSync(wsPath(ctx, 'alpha', 'audit', 'decisions.md'), 'utf8').split('\n');
    expect(lines.filter((line) => line.startsWith('## '))).toHaveLength(1);
  });

  it('works on a legacy-only workspace and does not create runtime files', async () => {
    const { repo } = buildRepo(makeTemp('audit').path);
    buildTaskWorkspace(repo, { slug: 'old-task', config: { title: 'Old' } });
    const ctx = contextFor(repo);
    await recordDecision(ctx, { task: 'old-task', title: 'x', decision: 'y' });
    expect(readFileSync(wsPath(ctx, 'old-task', 'audit', 'decisions.md'), 'utf8')).toContain('| x\n');
  });

  it('leaves other workspaces alone', async () => {
    const ctx = await nodeRepo('alpha', 'beta');
    const before = snapshotTree(wsPath(ctx, 'beta'));
    await recordDecision(ctx, { task: 'alpha', title: 'x', decision: 'y' });
    expect(snapshotTree(wsPath(ctx, 'beta'))).toBe(before);
  });

  it('fails for an unknown task and an invalid slug, and writes nothing', async () => {
    const ctx = await nodeRepo('alpha');
    const before = snapshotTree(ctx.root);
    expect((await failure(recordDecision(ctx, { task: 'nope', title: 'x', decision: 'y' }))).code).toBe(
      'TASK_NOT_FOUND',
    );
    expect((await failure(recordDecision(ctx, { task: '../alpha', title: 'x', decision: 'y' }))).code).toBe(
      'SLUG_INVALID',
    );
    expect(snapshotTree(ctx.root)).toBe(before);
  });
});

describe('audit check: a healthy workspace', () => {
  it('reports ok for a workspace made by init', async () => {
    const ctx = await nodeRepo('alpha');
    expect(await check(ctx, { task: 'alpha' })).toEqual([{ task: 'alpha', ok: true, problems: [] }]);
  });

  it('covers every workspace in slug order without a task and none for an empty root', async () => {
    const ctx = await nodeRepo('beta', 'alpha');
    expect((await check(ctx, {})).map((r) => r.task)).toEqual(['alpha', 'beta']);
    const empty = contextFor(buildRepo(makeTemp('audit').path).repo);
    expect(await check(empty, {})).toEqual([]);
  });

  it('accepts a legacy-only workspace that has an audit trail', async () => {
    const { repo } = buildRepo(makeTemp('audit').path);
    const ws = buildTaskWorkspace(repo, { slug: 'old-task', config: { title: 'Old' } });
    mkdirSync(path.join(ws, 'audit'));
    writeFileSync(path.join(ws, 'audit', 'changes.md'), '# Changes\n\n');
    expect(await check(contextFor(repo), { task: 'old-task' })).toEqual([{ task: 'old-task', ok: true, problems: [] }]);
  });

  it('does not change anything', async () => {
    const ctx = await nodeRepo('alpha');
    const before = snapshotTree(ctx.root);
    await check(ctx, {});
    expect(snapshotTree(ctx.root)).toBe(before);
  });
});

describe('audit check: the legacy problems with the legacy texts', () => {
  it('reports a task.json id that does not match the folder and an unsupported schema version', async () => {
    const ctx = await nodeRepo('alpha');
    const file = wsPath(ctx, 'alpha', 'task.json');
    const task = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...task, id: 'other', schema_version: 2 }, null, 2));
    const [report] = await check(ctx, { task: 'alpha' });
    expect(report?.ok).toBe(false);
    expect(report?.problems).toContain("task.json id 'other' does not match folder 'alpha'");
    expect(report?.problems).toContain('task.json schema_version 2 unsupported');
  });

  it('shows a list or an object id with the Python repr', async () => {
    const ctx = await nodeRepo('alpha');
    const file = wsPath(ctx, 'alpha', 'task.json');
    writeFileSync(file, '{"id": {"a": [1, 2.5, null, true, "x"], "b": {}}, "schema_version": []}');
    const [report] = await check(ctx, { task: 'alpha' });
    expect(report?.problems).toContain(
      `task.json id {'a': [1, 2.5, None, True, 'x'], 'b': {}} does not match folder 'alpha'`,
    );
    expect(report?.problems).toContain('task.json schema_version [] unsupported');
  });

  it('shows a missing schema_version as None and a missing id as None', async () => {
    const ctx = await nodeRepo('alpha');
    writeFileSync(wsPath(ctx, 'alpha', 'task.json'), '{"name": "x"}\n');
    const [report] = await check(ctx, { task: 'alpha' });
    expect(report?.problems).toContain("task.json id None does not match folder 'alpha'");
    expect(report?.problems).toContain('task.json schema_version None unsupported');
  });

  it('reports an invalid configuration with the config error text', async () => {
    const ctx = await nodeRepo('alpha');
    writeFileSync(wsPath(ctx, 'alpha', 'config.json'), '{"schema_version": 1, "title": "x", "bogus": 1}\n');
    const [report] = await check(ctx, { task: 'alpha' });
    expect(report?.problems).toEqual([
      `invalid task config ${wsPath(ctx, 'alpha', 'config.json')}: unknown key 'bogus'`,
    ]);
  });

  it('reports a missing changes.md', async () => {
    const { repo } = buildRepo(makeTemp('audit').path);
    buildTaskWorkspace(repo, { slug: 'old-task', config: { title: 'Old' } });
    const [report] = await check(contextFor(repo), { task: 'old-task' });
    expect(report?.problems).toEqual(['audit/changes.md missing']);
  });

  it('reports a transcript copy anywhere in the workspace with a relative path using slashes', async () => {
    const ctx = await nodeRepo('alpha');
    mkdirSync(wsPath(ctx, 'alpha', 'data', 'deep'), { recursive: true });
    writeFileSync(wsPath(ctx, 'alpha', 'copy.jsonl'), '{}\n');
    writeFileSync(wsPath(ctx, 'alpha', 'data', 'deep', 'session.jsonl'), '{}\n');
    const [report] = await check(ctx, { task: 'alpha' });
    expect(report?.problems).toEqual([
      'transcript copy found (never copy transcripts): copy.jsonl',
      'transcript copy found (never copy transcripts): data/deep/session.jsonl',
    ]);
  });

  it('does not flag the Node spool files, which are .ndjson', async () => {
    const ctx = await nodeRepo('alpha');
    mkdirSync(wsPath(ctx, 'alpha', 'data', 'spool'), { recursive: true });
    writeFileSync(wsPath(ctx, 'alpha', 'data', 'spool', 'hooks-20261011T14Z.ndjson'), '{}\n');
    expect((await check(ctx, { task: 'alpha' }))[0]?.ok).toBe(true);
  });

  it('reports a link inside the workspace', async () => {
    const ctx = await nodeRepo('alpha');
    const outside = makeTemp('audit-target').path;
    makeJunction(wsPath(ctx, 'alpha', 'linked'), outside);
    const [report] = await check(ctx, { task: 'alpha' });
    expect(report?.problems).toContain('symlink inside task workspace: linked');
  });

  it('reports a workspace that is not there as a problem instead of failing the whole report', async () => {
    const ctx = await nodeRepo('alpha');
    const reports = await check(ctx, { task: 'nope' });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.ok).toBe(false);
    expect(reports[0]?.problems[0]).toContain('task.json');
    const bad = await check(ctx, { task: '../x' });
    expect(bad[0]?.problems[0]).toContain('invalid task slug');
  });
});

describe('audit check: the Node checks, only when instance.json exists', () => {
  it('reports an instance.json that belongs to another slug (a copied workspace)', async () => {
    const ctx = await nodeRepo('alpha');
    const file = wsPath(ctx, 'alpha', 'instance.json');
    const instance = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...instance, slug: 'copy-of-it' }, null, 2));
    const [report] = await check(ctx, { task: 'alpha' });
    expect(report?.ok).toBe(false);
    expect(report?.problems[0]).toContain("instance.json belongs to 'copy-of-it' but sits in 'alpha'");
  });

  it('reports an invalid instance.json', async () => {
    const ctx = await nodeRepo('alpha');
    writeFileSync(wsPath(ctx, 'alpha', 'instance.json'), '{"schema_version": 1}\n');
    const [report] = await check(ctx, { task: 'alpha' });
    expect(report?.problems[0]).toContain('instance.json is invalid');
  });

  it('reports an invalid runtime.json once', async () => {
    const ctx = await nodeRepo('alpha');
    writeFileSync(wsPath(ctx, 'alpha', 'runtime.json'), '{"schema_version": 1, "server": {"nope": 1}}\n');
    const [report] = await check(ctx, { task: 'alpha' });
    expect(report?.ok).toBe(false);
    expect(report?.problems).toHaveLength(1);
    expect(report?.problems[0]).toContain('runtime.json: server');
  });

  it('reports every spool file that is not a segment and accepts the segments', async () => {
    const ctx = await nodeRepo('alpha');
    const spool = wsPath(ctx, 'alpha', 'data', 'spool');
    mkdirSync(spool, { recursive: true });
    writeFileSync(path.join(spool, 'hooks-20261011T14Z.ndjson'), '{}\n');
    writeFileSync(path.join(spool, 'notes.txt'), 'x');
    writeFileSync(path.join(spool, 'hooks-20261011T14Z.ndjson.tmp'), 'x');
    const [report] = await check(ctx, { task: 'alpha' });
    expect(report?.problems).toEqual([
      'unexpected file in data/spool: hooks-20261011T14Z.ndjson.tmp',
      'unexpected file in data/spool: notes.txt',
    ]);
  });

  it('does not run the Node checks for a legacy-only workspace', async () => {
    const { repo } = buildRepo(makeTemp('audit').path);
    const ws = buildTaskWorkspace(repo, { slug: 'old-task', config: { title: 'Old' } });
    mkdirSync(path.join(ws, 'audit'));
    writeFileSync(path.join(ws, 'audit', 'changes.md'), '# Changes\n\n');
    mkdirSync(path.join(ws, 'data', 'spool'), { recursive: true });
    writeFileSync(path.join(ws, 'data', 'spool', 'anything.txt'), 'x');
    expect((await check(contextFor(repo), { task: 'old-task' }))[0]?.ok).toBe(true);
  });

  it('reports a state.json that names another instance', async () => {
    const ctx = await nodeRepo('alpha');
    const state = {
      schema_version: 1,
      engine: 'node',
      pid: 2_147_483_000,
      url: 'http://127.0.0.1:18999',
      port: 18999,
      started: 1,
      version: '3.0.0',
      task: 'alpha',
      config: null,
      instanceId: INSTANCE_ID,
      runtimeVersion: '3.0.0',
      codeStamp: 'abcdef0123',
    };
    writeFileSync(wsPath(ctx, 'alpha', 'state.json'), JSON.stringify(state));
    const [report] = await check(ctx, { task: 'alpha' });
    expect(report?.problems).toEqual(['state.json instanceId does not match instance.json']);
  });

  it('accepts a node state file of the own instance (one engine, ADR 0066)', async () => {
    const { repo } = buildRepo(makeTemp('audit').path);
    const ctx = contextFor(repo);
    await init(ctx, { name: 'Old engine' });
    const instance = JSON.parse(readFileSync(wsPath(ctx, 'old-engine', 'instance.json'), 'utf8')) as {
      instanceId: string;
    };
    writeFileSync(
      wsPath(ctx, 'old-engine', 'state.json'),
      JSON.stringify({
        schema_version: 1,
        engine: 'node',
        pid: 2_147_483_000,
        url: 'http://127.0.0.1:18999',
        port: 18999,
        started: 1,
        version: '3.0.0',
        task: 'old-engine',
        config: null,
        instanceId: instance.instanceId,
        runtimeVersion: '3.0.0',
        codeStamp: 'abcdef0123',
      }),
    );
    const [report] = await check(ctx, { task: 'old-engine' });
    expect(report?.problems).toEqual([]);
  });

  it('accepts a legacy state file and ignores a state file that cannot be read', async () => {
    const ctx = await nodeRepo('alpha');
    writeFileSync(
      wsPath(ctx, 'alpha', 'state.json'),
      JSON.stringify({
        pid: 1,
        url: 'http://127.0.0.1:18999',
        port: 18999,
        started: 1,
        version: '2.0.2',
        task: 'alpha',
        config: null,
      }),
    );
    expect((await check(ctx, { task: 'alpha' }))[0]?.ok).toBe(true);
    writeFileSync(wsPath(ctx, 'alpha', 'state.json'), 'not json');
    expect((await check(ctx, { task: 'alpha' }))[0]?.ok).toBe(true);
  });
});
