// T-ISO-06 (01 3.5): task A cannot overwrite the configuration of task B. The rows of this file snapshot B (runtime-mutable paths
// left out) around each command that writes into A: `init a`, `configure --task a` (L and R keys) and `decide --task a`. Both
// workspaces are made by the real `init`; no instance is started, so the rows do not need the setup file of WP-20.
// Later work packages add the rows of their commands inside their own marked blocks at the end of the `describe`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RUNTIME_MUTABLE_PATHS } from '@mcs/engine';
import { buildRepo, hermeticEnv, runCli, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();

interface TwoTasks {
  readonly repo: string;
  readonly tasksRoot: string;
  readonly env: Record<string, string>;
  readonly dirA: string;
  readonly dirB: string;
  /** `mcs <args> --repo <repo>` with the hermetic environment. */
  mcs(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Snapshot of B without the runtime-mutable paths (01 1.1). */
  snapshotB(): string;
}

/** A repo with workspace B created by `init` and given a runtime.json; workspace A is made by the rows that need it. */
async function twoTasks(): Promise<TwoTasks> {
  const root = makeTemp('iso-config').path;
  const { repo, tasksRoot } = buildRepo(join(root, 'repo'));
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  const mcs = (args: readonly string[]) => runCli([...args, '--repo', repo], { mcsHome, env });
  const made = await mcs(['init', '--name', 'Task B', '--slug', 'b']);
  expect(made.code, made.stderr).toBe(0);
  const seeded = await mcs(['configure', '--task', 'b', '--set', 'window_hours=6', '--set', 'server.portScan=7']);
  expect(seeded.code, seeded.stderr).toBe(0);
  const dirB = join(tasksRoot, 'b');
  return {
    repo,
    tasksRoot,
    env,
    dirA: join(tasksRoot, 'a'),
    dirB,
    mcs,
    snapshotB: () => snapshotTree(dirB, { exclude: RUNTIME_MUTABLE_PATHS }),
  };
}

describe('config write isolation (T-ISO-06): the commands of task A leave task B byte for byte as it was', () => {
  it('init a', async () => {
    const t = await twoTasks();
    const before = t.snapshotB();
    const run = await t.mcs(['init', '--name', 'Task A', '--slug', 'a']);
    expect(run.code, run.stderr).toBe(0);
    expect(existsSync(join(t.dirA, 'task.json'))).toBe(true);
    expect(t.snapshotB()).toBe(before);
    const again = await t.mcs(['init', '--name', 'Task A', '--slug', 'a']);
    expect(again.code, again.stderr).toBe(0);
    expect(t.snapshotB()).toBe(before);
  });

  it('configure --task a with a legacy (L) key, and itself reports isolation ok', async () => {
    const t = await twoTasks();
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    const before = t.snapshotB();
    const configA = readFileSync(join(t.dirA, 'config.json'), 'utf8');
    const run = await t.mcs(['configure', '--task', 'a', '--set', 'window_hours=3', '--reason', 'isolation']);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ changed: true, isolation: 'ok' });
    expect(readFileSync(join(t.dirA, 'config.json'), 'utf8')).not.toBe(configA);
    expect(t.snapshotB()).toBe(before);
  });

  it('configure --task a with a runtime (R) key creates runtime.json in A only', async () => {
    const t = await twoTasks();
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    const before = t.snapshotB();
    const run = await t.mcs(['configure', '--task', 'a', '--set', 'server.portScan=3', '--set', 'logLevel="warn"']);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ changed: true, isolation: 'ok', files: ['runtime.json'] });
    expect(existsSync(join(t.dirA, 'runtime.json'))).toBe(true);
    expect(t.snapshotB()).toBe(before);
  });

  it('decide --task a', async () => {
    const t = await twoTasks();
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    const before = t.snapshotB();
    const run = await t.mcs(['decide', '--task', 'a', '--title', 'Only A', '--decision', 'not B']);
    expect(run.code, run.stderr).toBe(0);
    expect(readFileSync(join(t.dirA, 'audit', 'decisions.md'), 'utf8')).toContain('Only A');
    expect(existsSync(join(t.dirB, 'audit', 'decisions.md'))).toBe(false);
    expect(t.snapshotB()).toBe(before);
  });

  it('a configure of A that fails validation leaves both workspaces unchanged', async () => {
    const t = await twoTasks();
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    const beforeB = t.snapshotB();
    const beforeA = snapshotTree(t.dirA, { exclude: RUNTIME_MUTABLE_PATHS });
    const run = await t.mcs(['configure', '--task', 'a', '--set', 'window_hours="soon"']);
    expect(run.code).toBe(1);
    expect(t.snapshotB()).toBe(beforeB);
    expect(snapshotTree(t.dirA, { exclude: RUNTIME_MUTABLE_PATHS })).toBe(beforeA);
  });

  // @wp-begin WP-22
  it('instances repair --task a --yes', async () => {
    const t = await twoTasks();
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    const before = t.snapshotB();
    const run = await t.mcs(['instances', 'repair', '--task', 'a', '--yes']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('repaired');
    expect(t.snapshotB()).toBe(before);
  });
  // @wp-end WP-22

  // @wp-begin WP-38
  // @wp-end WP-38

  // @wp-begin WP-39
  // @wp-end WP-39

  // @wp-begin WP-62
  // @wp-end WP-62
});
