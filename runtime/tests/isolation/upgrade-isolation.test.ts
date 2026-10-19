// Upgrades never overwrite user-owned files and never reach another instance (01 3.5, brief 4 bullet 8): T-ISO-24 (a checked-in
// workspace that an older runtime wrote: after `upgrade --yes`, `config.json`, `task.json` and `README.md` are byte for byte what
// they were, the old audit bytes are a prefix of the new, the backup exists and its sha256 values match the files from before) and
// T-ISO-26 (a database newer than the runtime: `start` and `upgrade` refuse it, nothing in the workspace changes). One more row
// runs a backup and an upgrade of A while B keeps running and shows B untouched. T-ISO-25 (the launcher) belongs to area A and
// T-ISO-27 (`config migrate`) to its own work package.
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RUNTIME_MUTABLE_PATHS, defaultMigrationsDir, openInstanceDb, openSqlite, pidAlive } from '@mcs/engine';
import {
  BackupManifestSchema,
  CliEnvelopeSchema,
  RUNTIME_VERSION,
  UpgradeResultSchema,
  type CliEnvelope,
} from '@mcs/shared';
import { buildRepo, hermeticEnv, runCli, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { RUNTIME_DIR, twoInstances, twoWorkspaces } from './_setup.ts';

const makeTemp = useTempDirs();
const FIXTURE = join(RUNTIME_DIR, 'packages', 'cli', 'test', 'fixtures', 'workspaces', 'older-runtime');
const SLUG = 'older-runtime';
/** The empty `-wal` and `-shm` that a read-only open of a WAL database leaves are SQLite's own doing, not a change of the workspace. */
const SIDE_FILES = ['data/monitor.db-wal', 'data/monitor.db-shm'];

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** A version older than `version`: the fixture says 3.0.0, and this stays older after the next version bump. */
function olderThan(version: string): string {
  const major = Number(version.split('.')[0]);
  return `${String(Math.max(major - 1, 0))}.0.0`;
}

function envelope(stdout: string): CliEnvelope<unknown> {
  return CliEnvelopeSchema.parse(JSON.parse(stdout));
}

function rewriteInstance(dir: string, patch: Record<string, unknown>): void {
  const file = join(dir, 'instance.json');
  const instance = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...instance, ...patch }, null, 2)}\n`);
}

function markers(file: string): string[] {
  const db = openSqlite(file, { readonly: true, fileMustExist: true, timeoutMs: 2000 });
  try {
    return db
      .prepare<{ project_key: string }>('SELECT project_key FROM projects ORDER BY project_key')
      .all()
      .map((row) => row.project_key);
  } finally {
    db.close();
  }
}

describe('upgrades never overwrite user-owned files (T-ISO-24, T-ISO-26)', () => {
  it('T-ISO-24 a workspace written by an older runtime: config.json, task.json and README.md stay byte for byte, the old audit bytes are a prefix of the new, the backup matches the files from before', async () => {
    const root = makeTemp('iso-upgrade').path;
    const { repo, tasksRoot } = buildRepo(join(root, 'repo'));
    const ws = join(tasksRoot, SLUG);
    cpSync(FIXTURE, ws, { recursive: true });
    const older = olderThan(RUNTIME_VERSION);
    rewriteInstance(ws, { runtimeVersion: older, createdBy: `mcs ${older}` });
    const instanceId = (JSON.parse(readFileSync(join(ws, 'instance.json'), 'utf8')) as { instanceId: string })
      .instanceId;
    mkdirSync(join(ws, 'data'), { recursive: true });
    const db = openInstanceDb({
      path: join(ws, 'data', 'monitor.db'),
      expectedInstanceId: instanceId,
      mode: 'serve',
      runtimeVersion: older,
    });
    db.driver
      .prepare('INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES (?, ?, 1, 1)')
      .run(['before-upgrade', 'P']);
    db.close();

    const files = ['config.json', 'task.json', 'README.md', 'instance.json'];
    const before = new Map(files.map((name) => [name, readFileSync(join(ws, name))]));
    const changesBefore = readFileSync(join(ws, 'audit', 'changes.md'));
    const decisionsBefore = readFileSync(join(ws, 'audit', 'decisions.md'));

    const env = hermeticEnv(root);
    const run = await runCli(['upgrade', '--task', SLUG, '--yes', '--json', '--repo', repo], {
      mcsHome: env['MCS_HOME'] ?? join(root, 'mcs-home'),
      env,
    });
    expect(run.code, run.stderr).toBe(0);
    const result = UpgradeResultSchema.parse(envelope(run.stdout).data);
    expect(result).toMatchObject({ outcome: 'upgraded', plan: { runtimeFrom: older, runtimeTo: RUNTIME_VERSION } });

    // user-owned files: not rewritten
    for (const name of ['config.json', 'task.json', 'README.md']) {
      expect(readFileSync(join(ws, name)).equals(before.get(name) ?? Buffer.alloc(0)), name).toBe(true);
    }
    // the audit trail only grew
    const changesAfter = readFileSync(join(ws, 'audit', 'changes.md'));
    expect(changesAfter.length).toBeGreaterThan(changesBefore.length);
    expect(changesAfter.subarray(0, changesBefore.length).equals(changesBefore)).toBe(true);
    expect(changesAfter.toString('utf8').slice(changesBefore.length)).toContain('| upgrade');
    expect(readFileSync(join(ws, 'audit', 'decisions.md')).equals(decisionsBefore)).toBe(true);
    // the only file the upgrade rewrote is instance.json
    expect(JSON.parse(readFileSync(join(ws, 'instance.json'), 'utf8'))).toMatchObject({
      runtimeVersion: RUNTIME_VERSION,
    });

    // the backup exists, is complete, and holds the files as they were before
    const folder = join(ws, 'data', 'backups', result.backup ?? 'missing');
    const manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')));
    expect(manifest).toMatchObject({ reason: 'upgrade', instanceId, slug: SLUG });
    for (const entry of manifest.files) expect(sha256(join(folder, entry.path)), entry.path).toBe(entry.sha256);
    for (const name of ['config.json', 'task.json', 'instance.json']) {
      expect(manifest.files.find((f) => f.path === name)?.sha256, name).toBe(
        createHash('sha256')
          .update(before.get(name) ?? Buffer.alloc(0))
          .digest('hex'),
      );
    }
    expect(markers(join(folder, 'monitor.db'))).toEqual(['before-upgrade']);
  }, 180_000);

  it('T-ISO-26 a database newer than the runtime: start and upgrade refuse it with DB_NEWER_THAN_RUNTIME and nothing in the workspace changes', async () => {
    const { a, b } = await twoWorkspaces();
    // a database written by a runtime that ships one more step than this one
    const extra = makeTemp('iso-newer-migrations').path;
    const real = fileURLToPath(defaultMigrationsDir());
    for (const name of readdirSync(real)) copyFileSync(join(real, name), join(extra, name));
    writeFileSync(
      join(extra, '0002_future_step.sql'),
      '-- mcs:migration version=2 name=future_step\nCREATE TABLE future_table (id INTEGER PRIMARY KEY NOT NULL) STRICT;\n',
    );
    mkdirSync(join(a.dir, 'data'), { recursive: true });
    const future = openInstanceDb({
      path: a.dbPath,
      expectedInstanceId: a.instanceId,
      mode: 'serve',
      runtimeVersion: '9.0.0',
      migrationsDir: pathToFileURL(extra + sep),
    });
    future.close();
    const bytes = sha256(a.dbPath);
    const treeA = snapshotTree(a.dir, { exclude: SIDE_FILES });
    const treeB = snapshotTree(b.dir, { exclude: SIDE_FILES });

    for (const args of [
      ['start', '--task', 'a', '--port', String(a.configuredPort)],
      ['upgrade', '--task', 'a', '--yes'],
      ['db', 'migrate', '--task', 'a', '--yes'],
    ]) {
      const run = await a.mcs([...args, '--json']);
      expect(run.code, args.join(' ')).toBe(1);
      expect(envelope(run.stdout).error?.code, args.join(' ')).toBe('DB_NEWER_THAN_RUNTIME');
    }
    expect(sha256(a.dbPath)).toBe(bytes);
    expect(snapshotTree(a.dir, { exclude: SIDE_FILES })).toBe(treeA);
    expect(snapshotTree(b.dir, { exclude: SIDE_FILES })).toBe(treeB);
    expect(a.readState()).toBeNull();
    expect(await a.markerProcesses()).toEqual([]);
  }, 180_000);

  it('an instance.json from a newer runtime: upgrade is DOWNGRADE_REFUSED and the workspace is byte for byte what it was', async () => {
    const { a } = await twoWorkspaces();
    rewriteInstance(a.dir, { runtimeVersion: '99.0.0' });
    const tree = snapshotTree(a.dir);
    const run = await a.mcs(['upgrade', '--task', 'a', '--yes', '--json']);
    expect(run.code).toBe(1);
    expect(envelope(run.stdout).error?.code).toBe('DOWNGRADE_REFUSED');
    expect(snapshotTree(a.dir)).toBe(tree);
  }, 180_000);

  it('a backup of A while it runs and an upgrade of A once stopped leave the running B untouched', async () => {
    const pair = await twoInstances();
    const { a, b } = pair;
    const treeB = snapshotTree(b.dir, { exclude: RUNTIME_MUTABLE_PATHS });
    const stateB = b.stateBytes();

    const backup = await a.mcs(['backup', '--task', 'a', '--json']);
    expect(backup.code, backup.stderr).toBe(0);
    expect(envelope(backup.stdout).data).toMatchObject({ dbCopy: 'online', dbCopiedBy: 'server' });
    await a.handle.stop();

    rewriteInstance(a.dir, { runtimeVersion: olderThan(RUNTIME_VERSION) });
    const upgraded = await a.mcs(['upgrade', '--task', 'a', '--yes', '--json']);
    expect(upgraded.code, upgraded.stderr).toBe(0);
    expect(UpgradeResultSchema.parse(envelope(upgraded.stdout).data).outcome).toBe('upgraded');
    expect(readdirSync(join(a.dir, 'data', 'backups')).length).toBe(2);
    const backupsOfB = join(b.dir, 'data', 'backups');
    expect(existsSync(backupsOfB) ? readdirSync(backupsOfB) : []).toEqual([]);

    expect(snapshotTree(b.dir, { exclude: RUNTIME_MUTABLE_PATHS })).toBe(treeB);
    expect(pidAlive(b.pid)).toBe(true);
    expect(await b.health(b.port)).toEqual({ status: 200, instanceId: b.instanceId });
    expect(b.stateBytes()?.equals(stateB ?? Buffer.alloc(0))).toBe(true);
    await pair.teardown();
  }, 240_000);
});
