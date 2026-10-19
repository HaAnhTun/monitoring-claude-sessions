// `backup`, `backup list` and `backup restore` through the built CLI on real processes (01 5.5, ADR 0009, ADR 0028): T-UP-08 (a
// backup while the server runs goes through the control op, `list --verify`, a restore on a stopped instance gives back exactly
// the data of the backup and removes a stale `-wal`), the manifest on every backup, the confirmation rules (T-CLI-06), pruning that
// leaves the folders of `migrate-workspace` alone, and two backups at once. Every call passes `--repo <temp repo>` and a port of
// the test range; the databases are real SQLite files of temp folders.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RUNTIME_MUTABLE_PATHS, openInstanceDb, openSqlite } from '@mcs/engine';
import {
  BackupCreateResultSchema,
  BackupListResultSchema,
  BackupManifestSchema,
  BackupRestoreResultSchema,
  CliEnvelopeSchema,
  type CliEnvelope,
} from '@mcs/shared';
import {
  allocatePort,
  buildRepo,
  buildTaskWorkspace,
  hermeticEnv,
  killAllTracked,
  runCli,
  snapshotTree,
  startInstance,
  useTempDirs,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const SLUG = 'demo';

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly ws: string;
  readonly env: Record<string, string>;
  mcs(args: readonly string[]): Promise<Run>;
}

function sandbox(purpose: string, o: { repoName?: string } = {}): Sandbox {
  const root = makeTemp(purpose).path;
  const { repo } = buildRepo(join(root, o.repoName ?? 'repo'));
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  return {
    root,
    repo,
    ws: join(repo, '.claude', 'monitor', 'tasks', SLUG),
    env,
    mcs: (args) => runCli([...args, '--repo', repo], { mcsHome, env }),
  };
}

afterEach(async () => {
  await killAllTracked();
});

function envelope(run: Run): CliEnvelope<unknown> {
  return CliEnvelopeSchema.parse(JSON.parse(run.stdout));
}

async function initTask(sb: Sandbox, port?: number): Promise<void> {
  const run = await sb.mcs([
    'init',
    '--slug',
    SLUG,
    '--name',
    'FIXTURE demo',
    ...(port === undefined ? [] : ['--port', String(port)]),
  ]);
  expect(run.code, run.stderr).toBe(0);
}

function instanceId(sb: Sandbox): string {
  return (JSON.parse(readFileSync(join(sb.ws, 'instance.json'), 'utf8')) as { instanceId: string }).instanceId;
}

/** A schema-1 database for the task written by the real engine, with one marker row. */
function makeDatabase(sb: Sandbox, marker = 'before-backup'): string {
  const file = join(sb.ws, 'data', 'monitor.db');
  mkdirSync(join(sb.ws, 'data'), { recursive: true });
  const db = openInstanceDb({ path: file, expectedInstanceId: instanceId(sb), mode: 'serve', runtimeVersion: '4.0.0' });
  db.driver
    .prepare('INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES (?, ?, 1, 1)')
    .run([marker, 'P']);
  db.close();
  return file;
}

function addMarker(sb: Sandbox, marker: string): void {
  const db = openInstanceDb({
    path: join(sb.ws, 'data', 'monitor.db'),
    expectedInstanceId: instanceId(sb),
    mode: 'maintenance',
    runtimeVersion: '4.0.0',
  });
  db.driver
    .prepare('INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES (?, ?, 2, 2)')
    .run([marker, 'P']);
  db.close();
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

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const auditOf = (sb: Sandbox): string => {
  const file = join(sb.ws, 'audit', 'changes.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const backupsOf = (sb: Sandbox): string => join(sb.ws, 'data', 'backups');

describe('T-UP-08: backup while the server runs, list --verify, restore on a stopped instance', () => {
  it('copies the database through the control op, verifies, and a restore gives back exactly that data and drops a stale -wal', async () => {
    const sb = sandbox('backup-flow');
    const port = await allocatePort();
    await initTask(sb, port);
    const running = await startInstance({ repo: sb.repo, slug: SLUG, env: sb.env }, { port });

    // the running server makes the copy: the CLI never opens the database of a running instance
    const made = await sb.mcs(['backup', '--task', SLUG, '--json']);
    expect(made.code, made.stderr).toBe(0);
    const created = BackupCreateResultSchema.parse(envelope(made).data);
    expect(created).toMatchObject({ reason: 'manual', dbCopy: 'online', dbCopiedBy: 'server' });
    expect(created.id).toMatch(/^[0-9]{8}T[0-9]{6}Z-manual$/u);
    const folder = join(backupsOf(sb), created.id);
    const manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')));
    expect(manifest.files.map((f) => f.path)).toEqual(['monitor.db', 'instance.json', 'config.json', 'task.json']);
    for (const entry of manifest.files) expect(sha(join(folder, entry.path))).toBe(entry.sha256);
    expect(readdirSync(backupsOf(sb)).filter((n) => n.endsWith('.partial'))).toEqual([]);
    expect(auditOf(sb)).toContain(`- Summary: created backup ${created.id} (manual)`);

    const listed = await sb.mcs(['backup', 'list', '--task', SLUG, '--verify', '--json']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(BackupListResultSchema.parse(envelope(listed).data).backups).toMatchObject([
      { id: created.id, verified: true },
    ]);

    // a restore needs a stopped instance
    const refused = await sb.mcs(['backup', 'restore', '--task', SLUG, '--id', created.id, '--yes', '--json']);
    expect(refused.code).toBe(1);
    expect(envelope(refused).error?.code).toBe('INSTANCE_RUNNING');

    await running.stop();
    const live = join(sb.ws, 'data', 'monitor.db');
    const snapshotBytes = sha(join(folder, 'monitor.db'));
    addMarker(sb, 'after-backup');
    expect(markers(live)).toContain('after-backup');
    // a crashed server's leftovers: a -wal that no longer belongs to the file
    writeFileSync(`${live}-wal`, Buffer.alloc(4152, 7));
    writeFileSync(`${live}-shm`, Buffer.alloc(32768, 1));

    const dry = await sb.mcs(['backup', 'restore', '--task', SLUG, '--id', created.id]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('dry run, nothing changed');
    expect(dry.stderr).toContain('warning: dry run; pass --yes to apply');
    expect(markers(live)).toContain('after-backup');
    expect(existsSync(`${live}-wal`)).toBe(true);

    const restored = await sb.mcs(['backup', 'restore', '--task', SLUG, '--id', created.id, '--yes', '--json']);
    expect(restored.code, restored.stderr).toBe(0);
    const result = BackupRestoreResultSchema.parse(envelope(restored).data);
    expect(result).toMatchObject({ applied: true, restores: ['data/monitor.db'] });
    // the data equals the snapshot byte for byte, and the stale -wal and -shm are gone
    expect(sha(live)).toBe(snapshotBytes);
    expect(existsSync(`${live}-wal`)).toBe(false);
    expect(existsSync(`${live}-shm`)).toBe(false);
    expect(markers(live)).not.toContain('after-backup');
    const pre = BackupListResultSchema.parse(
      envelope(await sb.mcs(['backup', 'list', '--task', SLUG, '--verify', '--json'])).data,
    ).backups.find((b) => b.id === result.preRestoreBackup);
    expect(pre).toMatchObject({ reason: 'pre-restore', verified: true });
    expect(auditOf(sb)).toContain('| backup-restore');
    expect(auditOf(sb)).toContain(
      `restored backup ${created.id} (pre-restore backup ${result.preRestoreBackup ?? ''})`,
    );

    // the restored database is a database the server can run on
    const again = await startInstance({ repo: sb.repo, slug: SLUG, env: sb.env }, { port });
    await again.stop();
  }, 300_000);
});

describe('T-CLI-06: restore changes nothing without --yes; usage and refusals', () => {
  it('restore without --yes, and every refusal, leave the workspace as it was', async () => {
    const sb = sandbox('backup-dry');
    await initTask(sb);
    const db = makeDatabase(sb);
    const made = BackupCreateResultSchema.parse(envelope(await sb.mcs(['backup', '--task', SLUG, '--json'])).data);
    addMarker(sb, 'after-backup');
    const before = snapshotTree(sb.ws, { exclude: ['data/monitor.db-wal', 'data/monitor.db-shm'] });
    const dry = await sb.mcs(['backup', 'restore', '--task', SLUG, '--id', made.id, '--json']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(BackupRestoreResultSchema.parse(envelope(dry).data)).toMatchObject({
      applied: false,
      preRestoreBackup: null,
    });
    expect(envelope(dry).warnings).toEqual(['dry run; pass --yes to apply']);
    for (const id of ['20200101T000000Z-manual', '../demo', '20200101T000000Z-manual.partial']) {
      const run = await sb.mcs(['backup', 'restore', '--task', SLUG, '--id', id, '--yes', '--json']);
      expect(run.code, id).toBe(1);
      expect(envelope(run).error?.code, id).toBe('BACKUP_NOT_FOUND');
    }
    expect(snapshotTree(sb.ws, { exclude: ['data/monitor.db-wal', 'data/monitor.db-shm'] })).toBe(before);
    expect(markers(db)).toContain('after-backup');

    // usage errors exit 2
    expect((await sb.mcs(['backup'])).code).toBe(2);
    expect((await sb.mcs(['backup', 'list'])).code).toBe(2);
    expect((await sb.mcs(['backup', 'restore', '--task', SLUG])).code).toBe(2);
    expect((await sb.mcs(['backup', 'restore', '--task', SLUG, '--id'])).code).toBe(2);
    const help = await sb.mcs(['backup', 'restore', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--include-runtime-config');
    // `backup create` is the same command
    const alias = await sb.mcs(['backup', 'create', '--task', SLUG, '--json']);
    expect(alias.code, alias.stderr).toBe(0);
    expect(envelope(alias).command).toBe('backup');
  }, 240_000);

  it('a manifest of another instance, and a changed byte, are BACKUP_INVALID; nothing is restored', async () => {
    const sb = sandbox('backup-invalid');
    await initTask(sb);
    const db = makeDatabase(sb);
    const made = BackupCreateResultSchema.parse(envelope(await sb.mcs(['backup', '--task', SLUG, '--json'])).data);
    addMarker(sb, 'after-backup');
    const manifestFile = join(backupsOf(sb), made.id, 'manifest.json');
    const original = readFileSync(manifestFile, 'utf8');
    writeFileSync(manifestFile, original.replace(instanceId(sb), '22222222-2222-4222-8222-222222222222'));
    const other = await sb.mcs(['backup', 'restore', '--task', SLUG, '--id', made.id, '--yes', '--json']);
    expect(other.code).toBe(1);
    expect(envelope(other).error?.code).toBe('BACKUP_INVALID');
    writeFileSync(manifestFile, original);
    const bytes = readFileSync(join(backupsOf(sb), made.id, 'monitor.db'));
    bytes[200] = (bytes[200] ?? 0) ^ 0x10;
    writeFileSync(join(backupsOf(sb), made.id, 'monitor.db'), bytes);
    const tampered = await sb.mcs(['backup', 'restore', '--task', SLUG, '--id', made.id, '--yes', '--json']);
    expect(tampered.code).toBe(1);
    expect(envelope(tampered).error?.code).toBe('BACKUP_INVALID');
    const verified = await sb.mcs(['backup', 'list', '--task', SLUG, '--verify']);
    expect(verified.code).toBe(1);
    expect(verified.stdout).toContain('FAILED: monitor.db does not match the sha256 of the manifest');
    expect(markers(db)).toContain('after-backup');
    expect(readdirSync(backupsOf(sb)).filter((n) => n.endsWith('pre-restore'))).toEqual([]);
  }, 240_000);
});

describe('backups of a folder with a space in its path, two at once, and pruning', () => {
  it('works for a repository path with a space and verifies', async () => {
    const sb = sandbox('backup-space', { repoName: 'repo with space' });
    await initTask(sb);
    makeDatabase(sb);
    const run = await sb.mcs(['backup', '--task', SLUG, '--label', 'with a space', '--json']);
    expect(run.code, run.stderr).toBe(0);
    expect(auditOf(sb)).toContain('- Reason: with a space');
    const listed = await sb.mcs(['backup', 'list', '--task', SLUG, '--verify']);
    expect(listed.code, listed.stdout + listed.stderr).toBe(0);
  }, 240_000);

  it('two backups started at once are serialized by the task mutex: both succeed, with distinct ids, and verify', async () => {
    const sb = sandbox('backup-parallel');
    await initTask(sb);
    makeDatabase(sb);
    const [a, b] = await Promise.all([
      sb.mcs(['backup', '--task', SLUG, '--json']),
      sb.mcs(['backup', '--task', SLUG, '--json']),
    ]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    const ids = [a, b].map((run) => BackupCreateResultSchema.parse(envelope(run).data).id);
    expect(new Set(ids).size).toBe(2);
    const listed = BackupListResultSchema.parse(
      envelope(await sb.mcs(['backup', 'list', '--task', SLUG, '--verify', '--json'])).data,
    );
    expect(listed.backups).toHaveLength(2);
    expect(listed.backups.every((x) => x.verified === true)).toBe(true);
    expect(readdirSync(backupsOf(sb)).filter((n) => n.endsWith('.partial'))).toEqual([]);
    expect((auditOf(sb).match(/\| backup\n/gu) ?? []).length).toBe(2);
  }, 240_000);

  it('automatic pruning keeps backup.keep, never touches a pre-migrate folder or a .partial folder, and list ignores them', async () => {
    const sb = sandbox('backup-prune');
    await initTask(sb);
    makeDatabase(sb);
    const keep = await sb.mcs(['configure', '--task', SLUG, '--set', 'backup.keep=2']);
    expect(keep.code, keep.stderr).toBe(0);
    const backups = backupsOf(sb);
    mkdirSync(join(backups, 'pre-migrate-20200101T000000Z'), { recursive: true });
    writeFileSync(join(backups, 'pre-migrate-20200101T000000Z', 'config.json'), '{}\n');
    mkdirSync(join(backups, '20200101T000000Z-manual.partial'), { recursive: true });
    writeFileSync(join(backups, '20200101T000000Z-manual.partial', 'monitor.db'), 'half a copy');
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const run = await sb.mcs(['backup', '--task', SLUG, '--json']);
      expect(run.code, run.stderr).toBe(0);
      ids.push(BackupCreateResultSchema.parse(envelope(run).data).id);
    }
    const left = readdirSync(backups).sort();
    expect(left).toEqual(['20200101T000000Z-manual.partial', 'pre-migrate-20200101T000000Z', ...ids.slice(-2)].sort());
    expect(readFileSync(join(backups, 'pre-migrate-20200101T000000Z', 'config.json'), 'utf8')).toBe('{}\n');
    const listed = BackupListResultSchema.parse(
      envelope(await sb.mcs(['backup', 'list', '--task', SLUG, '--json'])).data,
    );
    expect(listed.backups.map((x) => x.id)).toEqual([...ids.slice(-2)].reverse());
  }, 240_000);

  it('a task without a database gets a files-only backup, and a stopped task keeps the workspace files it did not need to change', async () => {
    const sb = sandbox('backup-files-only');
    await initTask(sb);
    const before = snapshotTree(sb.ws, { exclude: [...RUNTIME_MUTABLE_PATHS, 'audit/**'] });
    const run = await sb.mcs(['backup', '--task', SLUG, '--json']);
    expect(run.code, run.stderr).toBe(0);
    expect(BackupCreateResultSchema.parse(envelope(run).data)).toMatchObject({
      dbCopy: 'none',
      dbCopiedBy: null,
      files: 3,
    });
    expect(snapshotTree(sb.ws, { exclude: [...RUNTIME_MUTABLE_PATHS, 'audit/**'] })).toBe(before);
  }, 240_000);

  it('a workspace without instance.json is INSTANCE_NOT_INITIALIZED (exit 1, hint: migrate-workspace)', async () => {
    const sb = sandbox('backup-pre-v4');
    buildTaskWorkspace(sb.repo, { slug: SLUG, config: { title: 'FIXTURE pre-4.0' } });
    const run = await sb.mcs(['backup', '--task', SLUG, '--json']);
    expect(run.code).toBe(1);
    expect(envelope(run).error).toMatchObject({ code: 'INSTANCE_NOT_INITIALIZED' });
    expect(envelope(run).error?.hint).toContain('migrate-workspace');
    expect(existsSync(join(sb.ws, 'data', 'backups'))).toBe(false);
  }, 240_000);
});
