// T-ISO-06 (01 3.5): task A cannot overwrite the configuration of task B. The rows of this file snapshot B (runtime-mutable paths
// left out) around each command that writes into A: `init a`, `configure --task a` (L and R keys) and `decide --task a`. Both
// workspaces are made by the real `init`; no instance is started, so the rows do not need the setup file of WP-20.
// Later work packages add the rows of their commands inside their own marked blocks at the end of the `describe`.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RUNTIME_MUTABLE_PATHS } from '@mcs/engine';
import { buildRepo, hermeticEnv, killAllTracked, runCli, snapshotTree, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();

// Runs before the temp-folder removal (hooks run in stack order): a command still running when a row times out is ended
// first, so it cannot hold the folder (EPERM on Windows).
afterEach(async () => {
  await killAllTracked();
}, 120_000);

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

// Every row starts the real CLI two to ten times (`twoTasks` alone runs it twice); on a loaded machine a row needs far more than
// 10 s. A row with its own limit keeps it.
const ROW_TIMEOUT_MS = 180_000;

const SUITE = 'config write isolation (T-ISO-06): the commands of task A leave task B byte for byte as it was';

describe(SUITE, { timeout: ROW_TIMEOUT_MS }, () => {
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
  it('hooks enable --task a writes instance.json and the route file of A only', async () => {
    const t = await twoTasks();
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    const before = t.snapshotB();
    const mcsHome = t.env['MCS_HOME'] ?? '';
    const run = await t.mcs(['hooks', 'enable', '--task', 'a']);
    expect(run.code, run.stderr).toBe(0);
    const instanceA = JSON.parse(readFileSync(join(t.dirA, 'instance.json'), 'utf8')) as {
      instanceId: string;
      hooks: { enabled: boolean };
    };
    expect(instanceA.hooks.enabled).toBe(true);
    // one route file, the one of A; B has none and its own instance.json still says hooks are off
    const routes = readdirSync(join(mcsHome, 'routes'));
    expect(routes).toEqual([`${instanceA.instanceId}.json`]);
    expect(t.snapshotB()).toBe(before);
    expect(JSON.parse(readFileSync(join(t.dirB, 'instance.json'), 'utf8'))).toMatchObject({
      hooks: { enabled: false },
    });
    // no settings file was written for either task or in the Claude home
    expect(existsSync(join(t.repo, '.claude', 'settings.local.json'))).toBe(false);
    expect(existsSync(join(t.env['CLAUDE_CONFIG_DIR'] ?? '', 'settings.json'))).toBe(false);
    const off = await t.mcs(['hooks', 'disable', '--task', 'a']);
    expect(off.code, off.stderr).toBe(0);
    expect(t.snapshotB()).toBe(before);
  });

  it('ingest replay --task a --yes resets cursors in the database of A only', async () => {
    const { allocatePort, startInstance } = await import('@mcs/testkit');
    const t = await twoTasks();
    const portA = await allocatePort();
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a', '--port', String(portA)])).code).toBe(0);
    // A has run once, so it has a database; its spool holds a segment that nothing read
    const runA = await startInstance({ repo: t.repo, slug: 'a', env: t.env }, { port: portA });
    await runA.stop();
    const segment = 'hooks-20261011T08Z.ndjson';
    mkdirSync(join(t.dirA, 'data', 'spool'), { recursive: true });
    writeFileSync(join(t.dirA, 'data', 'spool', segment), '');
    const before = t.snapshotB();
    const run = await t.mcs(['ingest', 'replay', '--task', 'a', '--yes', '--json']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, data: { mode: 'stopped', segmentsReset: 1 } });
    expect(readFileSync(join(t.dirA, 'audit', 'changes.md'), 'utf8')).toContain('| ingest-replay');
    expect(t.snapshotB()).toBe(before);
  });
  // @wp-end WP-38

  // @wp-begin WP-39
  it('T-ISO-08 A ingests hook and transcript activity for 10 s while B is stopped: the full tree of B, runtime-mutable paths included, is unchanged', async () => {
    const hooks = await import('./_hooks.ts');
    const { allocatePort, startInstance, waitFor } = await import('@mcs/testkit');
    const t = await twoTasks();
    const portA = await allocatePort();
    const portB = await allocatePort();

    // B has run once and is stopped: its database, logs and run folder exist, so a stray write would show
    const runB = await startInstance({ repo: t.repo, slug: 'b', env: t.env }, { port: portB });
    await runB.stop();
    const dirB = join(t.tasksRoot, 'b');
    expect(existsSync(join(dirB, 'data', 'monitor.db'))).toBe(true);

    // A watches a folder of its own (B watches the folder of the repository) and has hooks on
    const made = await t.mcs(['init', '--name', 'Task A', '--slug', 'a', '--port', String(portA)]);
    expect(made.code, made.stderr).toBe(0);
    const wsA = { slug: 'a', dir: t.dirA, mcs: (args: readonly string[]) => t.mcs(args) };
    hooks.enableHooks(wsA);
    const folderA = hooks.transcriptsFolder(t.env, 'a');
    await hooks.watchTranscriptsIn(wsA, folderA);

    const before = snapshotTree(dirB);
    const runA = await startInstance({ repo: t.repo, slug: 'a', env: t.env }, { port: portA });
    try {
      const session = 'a0a0a0a0-0000-4000-8000-00000000000a';
      const source = hooks.hookSource(t.env, folderA, session);
      const transcript = new hooks.GrowingTranscript(folderA, session, hooks.forward(folderA), Date.now() - 60_000);
      transcript.turn();
      const until = Date.now() + 10_000;
      let sent = 0;
      while (Date.now() < until) {
        await hooks.fireNotification(source, sent);
        sent += 1;
        if (sent % 4 === 0) transcript.turn();
      }
      expect(sent).toBeGreaterThan(0);
      expect(transcript.turns).toBeGreaterThan(1);

      // A took it all in
      const dbA = join(t.dirA, 'data', 'monitor.db');
      await waitFor(() => hooks.countNotifications(dbA) === sent, {
        what: `${String(sent)} notification events in the database of A`,
        timeoutMs: 30_000,
        intervalMs: 200,
      });
      await waitFor(async () => (await hooks.tokenTotals(portA)).output === transcript.expected().output, {
        what: 'the turns of the transcript of A in its token totals',
        timeoutMs: 30_000,
        intervalMs: 200,
      });
      expect(snapshotTree(dirB)).toBe(before);
    } finally {
      // a failure in the middle must not leave the instance (and its port) behind
      await runA.stop();
    }

    expect(snapshotTree(dirB)).toBe(before);
  }, 180_000);
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

  // @wp-begin WP-107
  /** A file of `days` days ago in `dir` (created when missing). */
  async function agedFile(file: string, days: number, content = 'x'): Promise<string> {
    const { mkdirSync, utimesSync, writeFileSync } = await import('node:fs');
    const nodePath = await import('node:path');
    mkdirSync(nodePath.dirname(file), { recursive: true });
    writeFileSync(file, content);
    const when = new Date(Date.now() - days * 86_400_000);
    utimesSync(file, when, when);
    return file;
  }

  /** Task A with a database (written by the real engine; no server runs) that holds one old and one recent session. */
  async function taskAWithSessions(t: TwoTasks): Promise<void> {
    const { openInstanceDb } = await import('@mcs/engine');
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    const instance = JSON.parse(readFileSync(join(t.dirA, 'instance.json'), 'utf8')) as { instanceId: string };
    const db = openInstanceDb({
      path: join(t.dirA, 'data', 'monitor.db'),
      expectedInstanceId: instance.instanceId,
      mode: 'serve',
      runtimeVersion: '4.0.0',
    });
    for (const [index, ageDays] of [100, 1].entries()) {
      const at = Date.now() - ageDays * 86_400_000;
      db.driver
        .prepare(
          `INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at, state)
           VALUES (:uid, :at, :at, :at, :at, 'completed')`,
        )
        .run({ uid: `dddddddd-0000-4000-8000-${String(index).padStart(12, '0')}`, at });
    }
    db.close();
  }

  it('config migrate --task a (dry run) and --yes: nothing is pending, nothing is written in either workspace', async () => {
    const t = await twoTasks();
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    const before = [snapshotTree(t.dirA), snapshotTree(t.dirB)];
    for (const extra of [[], ['--yes']]) {
      const run = await t.mcs(['config', 'migrate', '--task', 'a', ...extra]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain('already current');
    }
    expect([snapshotTree(t.dirA), snapshotTree(t.dirB)]).toEqual(before);
  });

  it('cleanup --task a --scope logs --yes deletes the old rotated logs of A and nothing of B, whose old logs stay', async () => {
    const t = await twoTasks();
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    const oldA = await agedFile(join(t.dirA, 'logs', 'runtime.log.1'), 60);
    const oldB = await agedFile(join(t.dirB, 'logs', 'runtime.log.1'), 60);
    const before = snapshotTree(t.dirB);
    const dry = await t.mcs(['cleanup', '--task', 'a', '--scope', 'logs']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(existsSync(oldA)).toBe(true);
    const run = await t.mcs(['cleanup', '--task', 'a', '--scope', 'logs', '--yes']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('logs/runtime.log.1');
    expect(existsSync(oldA)).toBe(false);
    expect(existsSync(oldB)).toBe(true);
    expect(snapshotTree(t.dirB)).toBe(before);
  });

  it('cleanup --task a --scope backups --keep 0 --yes removes the backups of A only', async () => {
    const { readdirSync } = await import('node:fs');
    const t = await twoTasks();
    expect((await t.mcs(['init', '--name', 'Task A', '--slug', 'a'])).code).toBe(0);
    expect((await t.mcs(['backup', '--task', 'a'])).code).toBe(0);
    expect((await t.mcs(['backup', '--task', 'b'])).code).toBe(0);
    const before = snapshotTree(t.dirB);
    expect(readdirSync(join(t.dirA, 'data', 'backups'))).toHaveLength(1);
    const run = await t.mcs(['cleanup', '--task', 'a', '--scope', 'backups', '--keep', '0', '--yes']);
    expect(run.code, run.stderr).toBe(0);
    expect(readdirSync(join(t.dirA, 'data', 'backups'))).toEqual([]);
    expect(readdirSync(join(t.dirB, 'data', 'backups'))).toHaveLength(1);
    expect(snapshotTree(t.dirB)).toBe(before);
  });

  it('cleanup --task a --scope data --older-than 30 --yes --confirm a deletes the old sessions of A and touches nothing of B', async () => {
    const t = await twoTasks();
    await taskAWithSessions(t);
    const before = snapshotTree(t.dirB);
    const wrong = await t.mcs([
      'cleanup',
      '--task',
      'a',
      '--scope',
      'data',
      '--older-than',
      '30',
      '--yes',
      '--confirm',
      'b',
    ]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('--confirm a');
    const run = await t.mcs([
      'cleanup',
      '--task',
      'a',
      '--scope',
      'data',
      '--older-than',
      '30',
      '--yes',
      '--confirm',
      'a',
      '--json',
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ data: { applied: true, count: 1 } });
    expect(readFileSync(join(t.dirA, 'audit', 'changes.md'), 'utf8')).toContain('data: deleted 1 sessions');
    expect(snapshotTree(t.dirB)).toBe(before);
  });
  // @wp-end WP-107

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
