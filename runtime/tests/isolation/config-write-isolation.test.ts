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
  /** Task A with a database written by the real engine (no server runs), an `instance.json` of an older runtime, and a backup. */
  async function taskAWithDatabase(t: TwoTasks): Promise<{ backupId: string }> {
    const { openInstanceDb } = await import('@mcs/engine');
    const { writeFileSync } = await import('node:fs');
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    const file = join(t.dirA, 'instance.json');
    const instance = JSON.parse(readFileSync(file, 'utf8')) as { instanceId: string };
    writeFileSync(file, `${JSON.stringify({ ...instance, runtimeVersion: '3.0.0' }, null, 2)}\n`);
    openInstanceDb({
      path: join(t.dirA, 'data', 'monitor.db'),
      expectedInstanceId: instance.instanceId,
      mode: 'serve',
      runtimeVersion: '3.0.0',
    }).close();
    const made = await t.mcs(['backup', '--task', 'a', '--json']);
    expect(made.code, made.stderr).toBe(0);
    return { backupId: (JSON.parse(made.stdout) as { data: { id: string } }).data.id };
  }

  it('upgrade --task a (dry run) and upgrade --task a --yes', async () => {
    const t = await twoTasks();
    await taskAWithDatabase(t);
    const before = t.snapshotB();
    const dry = await t.mcs(['upgrade', '--task', 'a']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('upgrade plan (dry run, nothing written)');
    expect(t.snapshotB()).toBe(before);
    const run = await t.mcs(['upgrade', '--task', 'a', '--yes']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("upgraded task 'a'");
    expect(readFileSync(join(t.dirA, 'instance.json'), 'utf8')).toContain('"runtimeVersion": "4.');
    expect(t.snapshotB()).toBe(before);
  });

  it('backup --task a', async () => {
    const t = await twoTasks();
    const before = t.snapshotB();
    await taskAWithDatabase(t);
    const run = await t.mcs(['backup', '--task', 'a', '--label', 'isolation']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('created backup');
    expect(existsSync(join(t.dirB, 'data', 'backups'))).toBe(false);
    expect(t.snapshotB()).toBe(before);
  });

  it('backup restore --task a --id <id> (dry run) and with --yes', async () => {
    const t = await twoTasks();
    const { backupId } = await taskAWithDatabase(t);
    const before = t.snapshotB();
    const dry = await t.mcs(['backup', 'restore', '--task', 'a', '--id', backupId]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(t.snapshotB()).toBe(before);
    const run = await t.mcs(['backup', 'restore', '--task', 'a', '--id', backupId, '--yes']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`restored backup ${backupId}`);
    expect(t.snapshotB()).toBe(before);
  });

  it('db migrate --task a --yes', async () => {
    const t = await twoTasks();
    await taskAWithDatabase(t);
    const before = t.snapshotB();
    const run = await t.mcs(['db', 'migrate', '--task', 'a', '--yes']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('already current');
    expect(t.snapshotB()).toBe(before);
  });

  it('db rebuild --task a --yes --confirm a', async () => {
    const t = await twoTasks();
    await taskAWithDatabase(t);
    const before = t.snapshotB();
    const dry = await t.mcs(['db', 'rebuild', '--task', 'a']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(t.snapshotB()).toBe(before);
    const run = await t.mcs(['db', 'rebuild', '--task', 'a', '--yes', '--confirm', 'a']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('moved the database to data/backups/');
    expect(existsSync(join(t.dirA, 'data', 'monitor.db'))).toBe(false);
    expect(t.snapshotB()).toBe(before);
  });
  // @wp-end WP-62

  // @wp-begin WP-140
  /** Two pre-4.0 workspaces (no instance.json, a pattern in Python syntax): both need the conversion, so a visit of the other would show. */
  async function twoOldTasks(t: TwoTasks): Promise<{ oldA: string; oldB: string }> {
    const { buildTaskWorkspace } = await import('@mcs/testkit');
    const config = (port: number): Record<string, unknown> => ({
      title: 'FIXTURE old task',
      port,
      attempts: {
        start: '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB BEGIN',
        end: '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB END',
        time_format: '%Y-%m-%d %H:%M:%S',
      },
    });
    return {
      oldA: buildTaskWorkspace(t.repo, { slug: 'old-a', config: config(18790) }),
      oldB: buildTaskWorkspace(t.repo, { slug: 'old-b', config: config(18791) }),
    };
  }

  it('migrate-workspace --task old-a (dry run) writes nothing in either workspace', async () => {
    const t = await twoTasks();
    const { oldA, oldB } = await twoOldTasks(t);
    const before = [snapshotTree(oldA), snapshotTree(oldB), t.snapshotB()];
    const run = await t.mcs(['migrate-workspace', '--task', 'old-a']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("task 'old-a': needs-migration (dry run, nothing written)");
    expect([snapshotTree(oldA), snapshotTree(oldB), t.snapshotB()]).toEqual(before);
  });

  it('migrate-workspace --task old-a --apply converts A only and leaves B, also an old-format one, byte for byte as it was', async () => {
    const t = await twoTasks();
    const { oldA, oldB } = await twoOldTasks(t);
    const before = [snapshotTree(oldB), t.snapshotB()];
    const configA = readFileSync(join(oldA, 'config.json'), 'utf8');
    const run = await t.mcs(['migrate-workspace', '--task', 'old-a', '--apply']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("task 'old-a': needs-migration (applied)");
    expect(existsSync(join(oldA, 'instance.json'))).toBe(true);
    expect(readFileSync(join(oldA, 'config.json'), 'utf8')).not.toBe(configA);
    expect(existsSync(join(oldB, 'instance.json'))).toBe(false);
    expect(existsSync(join(oldB, 'data'))).toBe(false);
    expect([snapshotTree(oldB), t.snapshotB()]).toEqual(before);
  });
  // @wp-end WP-140
});
