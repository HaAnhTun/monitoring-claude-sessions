// Identity repair of a copied workspace (01 3.4): plan, apply, and the refusal while a runtime is alive.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { readInstanceFile } from './adopt.ts';
import { applyRepair, planRepair, type RepairOptions } from './repair.ts';
import { resolveWorkspace, type WorkspaceRef } from './paths.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';

interface Scenario {
  readonly root: string;
  readonly original: WorkspaceRef;
  readonly copy: WorkspaceRef;
}

/** Workspace `a` with a database, spool, state and token, copied to `c` (same instance.json, wrong slug). */
function copiedWorkspace(): Scenario {
  const { repo, tasksRoot } = buildRepo(makeTemp('repair').path);
  const a = buildTaskWorkspace(repo, {
    slug: 'a',
    config: { title: 'A' },
    instance: { instanceId: OLD_ID, dbSchemaVersion: 3, hooks: { enabled: true }, engine: 'node' },
  });
  mkdirSync(path.join(a, 'data', 'spool'), { recursive: true });
  mkdirSync(path.join(a, 'data', 'exports'), { recursive: true });
  mkdirSync(path.join(a, 'audit'));
  mkdirSync(path.join(a, 'logs'));
  mkdirSync(path.join(a, 'run'));
  writeFileSync(path.join(a, 'data', 'monitor.db'), 'database bytes');
  writeFileSync(path.join(a, 'data', 'spool', 'hooks-20261011T14Z.ndjson'), '{"line": 1}\n');
  writeFileSync(path.join(a, 'data', 'exports', '.tmp-1.db'), 'export');
  writeFileSync(path.join(a, 'state.json'), '{"pid": 4}');
  writeFileSync(path.join(a, 'run', 'control.token'), 'token');
  writeFileSync(path.join(a, 'audit', 'changes.md'), '# Changes\n\n');
  writeFileSync(path.join(a, 'logs', 'runtime.log'), 'log line\n');
  const c = path.join(tasksRoot, 'c');
  cpSync(a, c, { recursive: true });
  writeFileSync(
    path.join(c, 'task.json'),
    readFileSync(path.join(c, 'task.json'), 'utf8').replace('"id": "a"', '"id": "c"'),
  );
  return {
    root: tasksRoot,
    original: resolveWorkspace(tasksRoot, 'a'),
    copy: resolveWorkspace(tasksRoot, 'c'),
  };
}

function options(over: Partial<RepairOptions> = {}): RepairOptions {
  return { clock: new FakeClock(NOW), newId: () => NEW_ID, isRunning: () => Promise.resolve(false), ...over };
}

function tree(ws: WorkspaceRef): string {
  return snapshotTree(ws.dir);
}

describe('planRepair', () => {
  it('describes the repair of a copied workspace and writes nothing', async () => {
    const { copy } = copiedWorkspace();
    const before = tree(copy);
    const plan = await planRepair(copy, options());
    expect(plan).toEqual({
      slug: 'c',
      oldSlug: 'a',
      oldInstanceId: OLD_ID,
      newInstanceId: NEW_ID,
      mismatch: true,
      moveData: true,
      orphanedDir: 'data/backups/orphaned-20261011T140507Z',
      removeState: true,
      removeRun: true,
    });
    expect(tree(copy)).toBe(before);
  });

  it('still plans for a healthy workspace and says so (mismatch false); it never plans a run or state that is absent', async () => {
    const { original } = copiedWorkspace();
    const plan = await planRepair(original, options());
    expect(plan.mismatch).toBe(false);
    expect(plan.oldSlug).toBe('a');

    const bare = copiedWorkspace().copy;
    for (const rel of ['data', 'run', 'state.json']) rmSync(path.join(bare.dir, rel), { recursive: true });
    const emptyPlan = await planRepair(bare, options());
    expect(emptyPlan).toMatchObject({ moveData: false, orphanedDir: null, removeState: false, removeRun: false });
  });

  it('INSTANCE_NOT_INITIALIZED when there is no instance.json; WORKSPACE_INVALID when it is broken', async () => {
    const { copy } = copiedWorkspace();
    writeFileSync(path.join(copy.dir, 'instance.json'), '{');
    await expect(planRepair(copy, options())).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
    rmSync(path.join(copy.dir, 'instance.json'));
    await expect(planRepair(copy, options())).rejects.toMatchObject({
      code: 'INSTANCE_NOT_INITIALIZED',
      hint: `mcs init --slug ${copy.slug}`,
    });
  });
});

describe('applyRepair', () => {
  it('gives the copy a new identity, orphans its data, clears state and run, audits, and never touches the original', async () => {
    const { original, copy } = copiedWorkspace();
    const originalFull = tree(original);
    const plan = await planRepair(copy, options());
    const result = await applyRepair(copy, plan, options());
    expect(result.plan).toEqual(plan);

    // identity
    const instance = await readInstanceFile(copy);
    expect(instance).toMatchObject({
      instanceId: NEW_ID,
      slug: 'c',
      dbSchemaVersion: 0,
      hooks: { enabled: true },
      engine: 'node',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(Object.keys(instance ?? {})).toEqual([
      'schema_version',
      'instanceId',
      'slug',
      'createdAt',
      'createdBy',
      'runtimeVersion',
      'dbSchemaVersion',
      'engine',
      'hooks',
      'upgradedAt',
    ]);

    // data moved, not copied and not lost
    const orphaned = path.join(copy.dir, 'data', 'backups', 'orphaned-20261011T140507Z');
    expect(readFileSync(path.join(orphaned, 'monitor.db'), 'utf8')).toBe('database bytes');
    expect(readFileSync(path.join(orphaned, 'spool', 'hooks-20261011T14Z.ndjson'), 'utf8')).toBe('{"line": 1}\n');
    expect(readFileSync(path.join(orphaned, 'exports', '.tmp-1.db'), 'utf8')).toBe('export');
    expect(readdirSync(path.join(copy.dir, 'data'))).toEqual(['backups']);
    expect(readdirSync(path.join(copy.dir, 'data', 'backups'))).toEqual(['orphaned-20261011T140507Z']);
    expect(readdirSync(copy.dir).filter((n) => n.startsWith('data.'))).toEqual([]);

    // runtime state cleared
    expect(existsSync(path.join(copy.dir, 'state.json'))).toBe(false);
    expect(readdirSync(path.join(copy.dir, 'run'))).toEqual([]);

    // audit
    expect(readFileSync(path.join(copy.dir, 'audit', 'changes.md'), 'utf8')).toBe(
      '# Changes\n\n' +
        '## 2026-10-11T14:05:07Z | instances-repair\n' +
        '- Summary: new instance 22222222 (was 11111111); data moved to data/backups/orphaned-20261011T140507Z/\n' +
        '- Reason: not given\n' +
        '- Files changed: instance.json, data/\n' +
        '- Validation: schema ok\n' +
        '- Outcome: repaired\n' +
        '- Unresolved: none\n' +
        '\n',
    );

    // T-ISO-06 row: the other workspace is byte for byte what it was (runtime-mutable files included)
    expect(tree(original)).toBe(originalFull);
  });

  it('refuses to reuse the name of an orphaned folder of the same second and changes nothing', async () => {
    const { copy } = copiedWorkspace();
    mkdirSync(path.join(copy.dir, 'data', 'backups', 'orphaned-20261011T140507Z'), { recursive: true });
    const plan = await planRepair(copy, options());
    const before = tree(copy);
    await expect(applyRepair(copy, plan, options())).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
    expect(tree(copy)).toBe(before);
    expect(readdirSync(copy.dir).filter((n) => n.startsWith('data.'))).toEqual([]);
  });

  it('a workspace with nothing to move writes the shorter audit summary', async () => {
    const { copy } = copiedWorkspace();
    rmSync(path.join(copy.dir, 'data'), { recursive: true });
    const plan = await planRepair(copy, options());
    await applyRepair(copy, plan, options());
    expect(readFileSync(path.join(copy.dir, 'audit', 'changes.md'), 'utf8')).toContain(
      '- Summary: new instance 22222222 (was 11111111); no data to move\n',
    );
    expect(existsSync(path.join(copy.dir, 'data'))).toBe(false);
  });

  it('INSTANCE_RUNNING when a runtime of either identity is alive: nothing changes', async () => {
    const { copy } = copiedWorkspace();
    const before = tree(copy);
    const plan = await planRepair(copy, options());
    const seen: (readonly string[])[] = [];
    const error = await applyRepair(
      copy,
      plan,
      options({
        isRunning: (ids) => {
          seen.push(ids);
          return Promise.resolve(true);
        },
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({ code: 'INSTANCE_RUNNING' });
    expect(seen).toEqual([[OLD_ID, NEW_ID]]);
    expect(tree(copy)).toBe(before);
  });

  it('refuses a plan that no longer matches the file (the identity changed after the dry run)', async () => {
    const { copy } = copiedWorkspace();
    const plan = await planRepair(copy, options());
    await applyRepair(copy, plan, options());
    const before = tree(copy);
    await expect(applyRepair(copy, plan, options({ newId: () => 'ignored' }))).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
    });
    expect(tree(copy)).toBe(before);
  });

  it('the default running check lists the real runtime processes (none of these fresh identities runs)', async () => {
    const { copy } = copiedWorkspace();
    const plan = await planRepair(copy, { clock: new FakeClock(NOW), newId: () => NEW_ID });
    const result = await applyRepair(copy, plan, { clock: new FakeClock(NOW), newId: () => NEW_ID });
    expect(result.plan.newInstanceId).toBe(NEW_ID);
  });

  it('the default running check finds a runtime started from another folder of the same install (by instance id)', async () => {
    const { copy } = copiedWorkspace();
    const asked: (string | null)[] = [];
    const listRuntimeProcesses = (dir: string | null) => {
      asked.push(dir);
      return Promise.resolve([
        { pid: 900, instanceId: '99999999-8888-4777-8666-555555555555', instanceDir: null },
        { pid: 901, instanceId: OLD_ID, instanceDir: null },
      ]);
    };
    const base = { clock: new FakeClock(NOW), newId: () => NEW_ID, listRuntimeProcesses };
    const plan = await planRepair(copy, base);
    await expect(applyRepair(copy, plan, base)).rejects.toMatchObject({ code: 'INSTANCE_RUNNING' });
    expect(asked).toEqual([null]);
    const others = {
      ...base,
      listRuntimeProcesses: () =>
        Promise.resolve([{ pid: 900, instanceId: NEW_ID.replace(/^./, '9'), instanceDir: null }]),
    };
    expect((await applyRepair(copy, plan, others)).plan.newInstanceId).toBe(NEW_ID);
  });

  it('a repaired workspace reads back without a mismatch and a second repair makes yet another identity', async () => {
    const { copy } = copiedWorkspace();
    await applyRepair(copy, await planRepair(copy, options()), options());
    const instance = await readInstanceFile(copy);
    expect(instance?.slug).toBe('c');
    const second = await planRepair(copy, options({ newId: () => '33333333-3333-4333-8333-333333333333' }));
    expect(second.mismatch).toBe(false);
    expect(second.oldInstanceId).toBe(NEW_ID);
  });
});
