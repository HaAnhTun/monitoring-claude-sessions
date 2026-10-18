// `ops.instances` (01 6.4, 3.4): the listing with and without the probe (a running, a stopped and a broken workspace) and the
// repair, a dry run without `--yes` that refuses while a runtime runs.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { InstanceRowSchema, McsError } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import type { Logger } from '../log/logger.ts';
import { defaultSkillDir } from '../config/defaults.ts';
import { list, listLines, repairIdentity } from './instances.ts';
import type { ProbeResult } from './probe.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '33333333-3333-4333-8333-333333333333';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

function setup(): { ctx: OpContext; tasksRoot: string } {
  const { repo, tasksRoot } = buildRepo(makeTemp('instances').path);
  const a = buildTaskWorkspace(repo, { slug: 'a', config: { title: 'A' }, instance: { slug: 'a', instanceId: ID_A } });
  buildTaskWorkspace(repo, { slug: 'b', config: { title: 'B' }, instance: { slug: 'b', instanceId: ID_B } });
  // `c` is a copy of `a`: its instance.json names `a` (broken until repaired)
  cpSync(a, path.join(tasksRoot, 'c'), { recursive: true });
  writeFileSync(
    path.join(tasksRoot, 'c', 'task.json'),
    readFileSync(path.join(tasksRoot, 'c', 'task.json'), 'utf8').replace('"id": "a"', '"id": "c"'),
  );
  const skillDir = defaultSkillDir();
  return {
    tasksRoot,
    ctx: {
      repo,
      root: tasksRoot,
      skillDir,
      runtimeDir: path.join(skillDir, 'runtime'),
      launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
      env: {},
      clock: new FakeClock(Date.UTC(2026, 9, 19)),
      log: silent,
    },
  };
}

function probeResult(over: Partial<ProbeResult>): ProbeResult {
  return {
    state: 'stopped',
    engine: null,
    pid: null,
    url: null,
    port: null,
    identity: null,
    stateFile: null,
    stateFileBytes: null,
    reason: '',
    ...over,
  };
}

describe('ops.instances.list', () => {
  it('shows a running, a stopped and a broken workspace with the probe', async () => {
    const { ctx } = setup();
    const identity = { codeStamp: 'old0000000', runtimeVersion: '4.0.1' } as ProbeResult['identity'];
    const result = await list(
      ctx,
      {},
      {
        probe: (ws) =>
          Promise.resolve(
            ws.slug === 'a'
              ? probeResult({ state: 'running', pid: 42, url: 'http://127.0.0.1:18601', identity })
              : probeResult({}),
          ),
        codeStamp: () => Promise.resolve('new0000000'),
      },
    );
    const rows = result.instances;
    expect(rows.map((r) => r.slug)).toEqual(['a', 'b', 'c']);
    for (const row of rows) expect(InstanceRowSchema.safeParse(row).success).toBe(true);
    expect(rows[0]).toMatchObject({ identity: 'node', state: 'running', pid: 42, version: '4.0.1', outdated: true });
    expect(rows[1]).toMatchObject({ identity: 'node', state: 'stopped', pid: null, outdated: false });
    expect(rows[2]).toMatchObject({ identity: 'broken', outdated: false });
    expect(rows[2]?.problem).toContain('instances repair');
    const lines = listLines(result);
    expect(lines[0]).toMatch(/^slug\s+identity\s+state\s+url\s+pid\s+version\s+outdated$/);
    expect(lines[1]).toMatch(/^a\s+node\s+running\s+http:\/\/127\.0\.0\.1:18601\s+42\s+4\.0\.1\s+yes$/);
  });

  it('--no-probe reads state.json only and never calls the probe', async () => {
    const { ctx } = setup();
    const result = await list(
      ctx,
      { probe: false },
      {
        probe: () => Promise.reject(new Error('the probe must not run')),
        codeStamp: () => Promise.reject(new Error('no stamp read either')),
      },
    );
    expect(result.instances.map((r) => r.state)).toEqual(['stopped', 'stopped', 'stopped']);
  });

  it('an empty tasks root lists nothing', async () => {
    const ctx = { ...setup().ctx, root: path.join(makeTemp('empty').path, 'tasks') };
    const result = await list(ctx, { probe: false });
    expect(result.instances).toEqual([]);
    expect(listLines(result)).toEqual(['no tasks']);
  });
});

describe('ops.instances.repairIdentity', () => {
  it('is a dry run without --yes and applies with it', async () => {
    const { ctx, tasksRoot } = setup();
    const before = snapshotTree(path.join(tasksRoot, 'c'));
    const dry = await repairIdentity(
      ctx,
      { task: 'c' },
      { newId: () => NEW_ID, isRunning: () => Promise.resolve(false) },
    );
    expect(dry).toMatchObject({ applied: false, plan: { oldInstanceId: ID_A, newInstanceId: NEW_ID, mismatch: true } });
    expect(snapshotTree(path.join(tasksRoot, 'c'))).toBe(before);
    const done = await repairIdentity(
      ctx,
      { task: 'c', yes: true },
      { newId: () => NEW_ID, isRunning: () => Promise.resolve(false) },
    );
    expect(done.applied).toBe(true);
    const instance = JSON.parse(readFileSync(path.join(tasksRoot, 'c', 'instance.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(instance).toMatchObject({ instanceId: NEW_ID, slug: 'c' });
    expect(existsSync(path.join(tasksRoot, 'a', 'instance.json'))).toBe(true);
  });

  it('refuses while a runtime of the identity runs', async () => {
    const { ctx } = setup();
    const error: unknown = await repairIdentity(
      ctx,
      { task: 'c', yes: true },
      { newId: () => NEW_ID, isRunning: () => Promise.resolve(true) },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McsError);
    expect((error as McsError).code).toBe('INSTANCE_RUNNING');
  });
});
