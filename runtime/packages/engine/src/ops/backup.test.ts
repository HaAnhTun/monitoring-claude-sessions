// `ops.backup` (01 5.5, ADR 0009, ADR 0028): create (stopped, running through the control op, refused states), the manifest on
// every backup, list and `--verify`, pruning, and restore (dry run, stale `-wal`, pre-restore backup, a restore that fails halfway,
// a manifest of another instance, a tampered file). Every workspace is a temp one; the databases are real SQLite files.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BackupManifestSchema, McsError, RUNTIME_VERSION, type InstanceFile } from '@mcs/shared';
import type { ControlRequest } from '@mcs/shared/protocol';
import { FakeClock, buildRepo, buildTaskWorkspace, makeJunction, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { backupDb } from '../db/backup.ts';
import { openSqlite } from '../db/driver.ts';
import { defaultMigrationsDir } from '../db/migrations.ts';
import { openInstanceDb } from '../db/open.ts';
import { withTaskMutex, resolveWorkspace, type WorkspaceRef } from '../workspace/paths.ts';
import type { Logger } from '../log/logger.ts';
import {
  create,
  createLines,
  list,
  listBackups,
  listLines,
  make,
  prune,
  restore,
  restoreLines,
  verifyBackup,
  type BackupOpDeps,
} from './backup.ts';
import type { ControlAttempt, ProbeResult, ProbeState } from './probe.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const T0 = Date.UTC(2026, 9, 20, 10, 15, 0);
const TOKEN = 'a'.repeat(64);

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

interface Fixture {
  readonly ctx: OpContext;
  readonly clock: FakeClock;
  readonly ws: WorkspaceRef;
  readonly dir: string;
  readonly dbFile: string;
  readonly backups: string;
}

/** `migrations/` of the runtime plus the given extra files: a runtime that ships more steps than the real one. */
function migrationsWith(extra: Record<string, string>): { migrationsDir: URL } {
  const dir = makeTemp('migrations').path;
  const real = fileURLToPath(defaultMigrationsDir());
  for (const name of readdirSync(real)) copyFileSync(join(real, name), join(dir, name));
  for (const [name, sql] of Object.entries(extra)) writeFileSync(join(dir, name), sql);
  return { migrationsDir: pathToFileURL(dir + sep) };
}

function createDatabase(file: string, instanceId: string, marker: string): void {
  const db = openInstanceDb({ path: file, expectedInstanceId: instanceId, mode: 'serve', runtimeVersion: '4.0.0' });
  db.driver
    .prepare('INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES (?, ?, 1, 1)')
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

function setup(
  o: { db?: boolean; instance?: Partial<InstanceFile>; rootName?: string; dbOf?: string; runtime?: boolean } = {},
): Fixture {
  const root = makeTemp('backup').path;
  const { repo } = buildRepo(join(root, o.rootName ?? 'repo'));
  const dir = buildTaskWorkspace(repo, {
    slug: 'demo',
    config: { title: 'FIXTURE demo' },
    ...(o.runtime === true ? { runtime: { backup: { keep: 10 } } } : {}),
    instance: { slug: 'demo', instanceId: ID, runtimeVersion: '4.0.0', dbSchemaVersion: 1, ...o.instance },
  });
  mkdirSync(join(dir, 'data'), { recursive: true });
  const dbFile = join(dir, 'data', 'monitor.db');
  if (o.db !== false) createDatabase(dbFile, o.dbOf ?? ID, 'before-backup');
  const clock = new FakeClock(T0);
  const skillDir = defaultSkillDir();
  const ctx: OpContext = {
    repo,
    root: join(repo, '.claude', 'monitor', 'tasks'),
    skillDir,
    runtimeDir: join(skillDir, 'runtime'),
    launcherPath: join(skillDir, 'scripts', 'mcs.mjs'),
    env: {},
    clock,
    log: silent,
  };
  return { ctx, clock, ws: resolveWorkspace(ctx.root, 'demo'), dir, dbFile, backups: join(dir, 'data', 'backups') };
}

function probeResult(state: ProbeState): ProbeResult {
  return {
    state,
    engine: state === 'stopped' ? null : 'node',
    pid: state === 'stopped' ? null : 4242,
    url: state === 'running' ? 'http://127.0.0.1:18001' : null,
    port: state === 'running' ? 18001 : null,
    identity: null,
    stateFile: null,
    stateFileBytes: null,
    reason: 'scripted',
  };
}

function probing(state: ProbeState): BackupOpDeps {
  return { probe: () => Promise.resolve(probeResult(state)) };
}

/** The running server as the control channel sees it: it copies its database (`source`) to `dest` and says how many bytes. */
function serverControl(source: string, seen: ControlRequest[]): NonNullable<BackupOpDeps['control']> {
  return async (_address, message): Promise<ControlAttempt> => {
    seen.push(message);
    if (message.op !== 'backup') return { kind: 'refusal', error: 'BAD_REQUEST' };
    const copied = await backupDb({ path: source, expectedInstanceId: ID }, message.dest);
    return {
      kind: 'reply',
      response: { v: 1, ok: true, op: 'backup', bytes: copied.bytes, dbSchemaVersion: copied.dbSchemaVersion },
    };
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<McsError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected an McsError');
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function auditOf(f: Fixture): string {
  const file = join(f.dir, 'audit', 'changes.md');
  return existsSync(file) ? read(file) : '';
}

/** A crashed server's leftovers: the database as it was, plus a `-wal` that holds rows the database file does not. */
function leaveStaleWal(f: Fixture, marker: string): void {
  const db = openInstanceDb({ path: f.dbFile, expectedInstanceId: ID, mode: 'serve', runtimeVersion: '4.0.0' });
  db.driver.exec('PRAGMA wal_autocheckpoint = 0');
  db.driver
    .prepare('INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES (?, ?, 1, 1)')
    .run([marker, 'P']);
  const side = makeTemp('stale-wal').path;
  copyFileSync(f.dbFile, join(side, 'monitor.db'));
  copyFileSync(`${f.dbFile}-wal`, join(side, 'monitor.db-wal'));
  db.close();
  copyFileSync(join(side, 'monitor.db'), f.dbFile);
  copyFileSync(join(side, 'monitor.db-wal'), `${f.dbFile}-wal`);
}

describe('backup create', () => {
  it('copies a stopped instance: manifest, database, reference files, audit entry, no partial folder', async () => {
    const f = setup();
    const result = await create(f.ctx, { task: 'demo' });
    expect(result).toMatchObject({
      task: 'demo',
      id: '20261020T101500Z-manual',
      reason: 'manual',
      folder: 'data/backups/20261020T101500Z-manual/',
      dbCopy: 'online',
      dbSchemaVersion: 1,
      files: 4,
      dbCopiedBy: 'cli',
      pruned: [],
    });
    const folder = join(f.backups, result.id);
    expect(readdirSync(folder).sort()).toEqual([
      'config.json',
      'instance.json',
      'manifest.json',
      'monitor.db',
      'task.json',
    ]);
    expect(readdirSync(f.backups)).toEqual([result.id]);
    const manifest = BackupManifestSchema.parse(JSON.parse(read(join(folder, 'manifest.json'))));
    expect(manifest).toMatchObject({
      schema_version: 1,
      instanceId: ID,
      slug: 'demo',
      createdAt: '2026-10-20T10:15:00Z',
      reason: 'manual',
      runtimeVersion: RUNTIME_VERSION,
      dbCopy: 'online',
    });
    expect(manifest.files.map((x) => x.path)).toEqual(['monitor.db', 'instance.json', 'config.json', 'task.json']);
    expect(await verifyBackup(folder, manifest)).toEqual([]);
    // the reference copies are the live bytes
    expect(readFileSync(join(folder, 'config.json'))).toEqual(readFileSync(join(f.dir, 'config.json')));
    expect(markers(join(folder, 'monitor.db'))).toEqual(['before-backup']);
    expect(auditOf(f)).toBe(
      [
        '# Changes',
        '',
        '## 2026-10-20T10:15:00Z | backup',
        '- Summary: created backup 20261020T101500Z-manual (manual)',
        '- Reason: not given',
        '- Files changed: data/backups/20261020T101500Z-manual/',
        '- Validation: sha256 recorded for 4 files',
        '- Outcome: created',
        '- Unresolved: none',
        '',
        '',
      ].join('\n'),
    );
    expect(createLines(result)[0]).toMatch(
      /^created backup 20261020T101500Z-manual [(]manual[)]: 4 files, [0-9]+([.][0-9])? (B|KiB|MiB)$/,
    );
  });

  it('keeps --label in the audit entry and a second backup in the same second gets a suffix', async () => {
    const f = setup();
    const first = await create(f.ctx, { task: 'demo', label: 'before the refactor' });
    const second = await create(f.ctx, { task: 'demo' });
    expect(second.id).toBe(`${first.id}-2`);
    expect(auditOf(f)).toContain('- Reason: before the refactor');
    expect((await list(f.ctx, { task: 'demo' })).backups.map((b) => b.id)).toEqual([`${first.id}-2`, first.id]);
  });

  it('a task without a database gets a files-only backup (dbCopy none)', async () => {
    const f = setup({ db: false });
    const result = await create(f.ctx, { task: 'demo' });
    expect(result).toMatchObject({ dbCopy: 'none', dbSchemaVersion: 0, files: 3, dbCopiedBy: null });
    expect(existsSync(join(f.backups, result.id, 'monitor.db'))).toBe(false);
  });

  it('a running instance makes its own copy over the control op; this process never opens the database', async () => {
    const f = setup();
    mkdirSync(join(f.dir, 'run'), { recursive: true });
    writeFileSync(join(f.dir, 'run', 'control.token'), `${TOKEN}\n`);
    const seen: ControlRequest[] = [];
    // the server's copy comes from a side file; the live file is junk, so a CLI that opened it would fail
    const side = join(makeTemp('server-side').path, 'monitor.db');
    copyFileSync(f.dbFile, side);
    writeFileSync(f.dbFile, 'a file this process must not open');
    const result = await create(f.ctx, { task: 'demo' }, { ...probing('running'), control: serverControl(side, seen) });
    expect(result).toMatchObject({ dbCopy: 'online', dbCopiedBy: 'server', files: 4 });
    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request).toMatchObject({ v: 1, op: 'backup', instanceId: ID, token: TOKEN });
    if (request?.op !== 'backup') throw new Error('expected a backup request');
    expect(request.dest).toBe(join(f.backups, `${result.id}.partial`, 'monitor.db'));
    expect(markers(join(f.backups, result.id, 'monitor.db'))).toEqual(['before-backup']);
  });

  it('a running instance that cannot make the copy is DB_ERROR and leaves no folder behind', async () => {
    const f = setup();
    mkdirSync(join(f.dir, 'run'), { recursive: true });
    const control =
      (kind: ControlAttempt): NonNullable<BackupOpDeps['control']> =>
      () =>
        Promise.resolve(kind);
    // no token
    expect(
      await failureOf(() =>
        create(f.ctx, { task: 'demo' }, { ...probing('running'), control: control({ kind: 'absent' }) }),
      ),
    ).toMatchObject({ code: 'DB_ERROR' });
    writeFileSync(join(f.dir, 'run', 'control.token'), TOKEN);
    for (const attempt of [
      { kind: 'refusal', error: 'BACKUP_FAILED' },
      { kind: 'silent', reason: 'timeout' },
      { kind: 'absent' },
    ] as const) {
      const error = await failureOf(() =>
        create(f.ctx, { task: 'demo' }, { ...probing('running'), control: control(attempt) }),
      );
      expect(error.code).toBe('DB_ERROR');
    }
    // the server says yes but left no file
    const liar = control({ kind: 'reply', response: { v: 1, ok: true, op: 'backup', bytes: 1, dbSchemaVersion: 1 } });
    expect(
      (await failureOf(() => create(f.ctx, { task: 'demo' }, { ...probing('running'), control: liar }))).code,
    ).toBe('DB_ERROR');
    expect(readdirSync(f.backups)).toEqual([]);
    expect(auditOf(f)).toBe('');
  });

  it.each(['starting', 'stopping', 'unhealthy', 'unmanaged-running'] as const)(
    'an instance that is %s is INSTANCE_RUNNING: the database is copied only when its owner is known',
    async (state) => {
      const f = setup();
      const before = snapshotTree(f.dir);
      const error = await failureOf(() => create(f.ctx, { task: 'demo' }, probing(state)));
      expect(error.code).toBe('INSTANCE_RUNNING');
      expect(snapshotTree(f.dir)).toBe(before);
    },
  );

  it.each(['stale', 'foreign-pid'] as const)('a %s state file does not stop a backup', async (state) => {
    const f = setup();
    const result = await create(f.ctx, { task: 'demo' }, probing(state));
    expect(result.dbCopiedBy).toBe('cli');
  });

  it('a workspace without instance.json is INSTANCE_NOT_INITIALIZED with the migrate-workspace hint and nothing is written', async () => {
    const f = setup();
    rmSync(join(f.dir, 'instance.json'));
    const before = snapshotTree(f.dir);
    const error = await failureOf(() => create(f.ctx, { task: 'demo' }));
    expect(error).toMatchObject({ code: 'INSTANCE_NOT_INITIALIZED' });
    expect(error.hint).toContain('mcs migrate-workspace --task demo');
    expect(snapshotTree(f.dir)).toBe(before);
  });

  it('a database of another instance fails the backup, removes the partial folder and writes no audit entry', async () => {
    const f = setup({ dbOf: OTHER_ID });
    const error = await failureOf(() => create(f.ctx, { task: 'demo' }));
    expect(error.code).toBe('IDENTITY_MISMATCH');
    expect(readdirSync(f.backups)).toEqual([]);
    expect(auditOf(f)).toBe('');
  });

  it('refuses a data/backups that is a link and writes nothing through it', async () => {
    const f = setup();
    const elsewhere = makeTemp('elsewhere').path;
    rmSync(f.backups, { recursive: true, force: true });
    makeJunction(f.backups, elsewhere);
    const error = await failureOf(() => create(f.ctx, { task: 'demo' }));
    expect(error.code).toBe('WORKSPACE_SYMLINK');
    expect(readdirSync(elsewhere)).toEqual(['FIXTURE.md']);
  });

  it('works in a folder with a space in its path', async () => {
    const f = setup({ rootName: 'repo with space' });
    const result = await create(f.ctx, { task: 'demo' });
    expect(result.dbCopy).toBe('online');
    const [only] = await listBackups(f.ws);
    expect(only?.id).toBe(result.id);
    expect(await verifyBackup(only?.dir ?? '', only?.manifest ?? (undefined as never))).toEqual([]);
  });

  it('another command holding the task makes it WORKSPACE_BUSY after the wait', async () => {
    const f = setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = withTaskMutex(f.ws, async () => {
      acquired();
      await held;
    });
    await gate;
    const error = await failureOf(() => create(f.ctx, { task: 'demo' }, { mutexTimeoutMs: 150 }));
    expect(error.code).toBe('WORKSPACE_BUSY');
    release();
    await holder;
  });
});

describe('backup list', () => {
  it('lists only folders with a valid manifest, newest first, and ignores partial, pre-migrate and damaged folders', async () => {
    const f = setup();
    const a = await create(f.ctx, { task: 'demo' });
    f.clock.advance(3_600_000);
    const b = await make(f.ctx, f.ws, JSON.parse(read(join(f.dir, 'instance.json'))) as InstanceFile, {
      reason: 'upgrade',
    });
    mkdirSync(join(f.backups, '20260101T000000Z-manual.partial'));
    writeFileSync(join(f.backups, '20260101T000000Z-manual.partial', 'monitor.db'), 'half');
    mkdirSync(join(f.backups, 'pre-migrate-20260101T000000Z'));
    writeFileSync(join(f.backups, 'pre-migrate-20260101T000000Z', 'config.json'), '{}');
    mkdirSync(join(f.backups, 'orphaned-20260101T000000Z'));
    mkdirSync(join(f.backups, '20260102T000000Z-manual'));
    writeFileSync(join(f.backups, '20260102T000000Z-manual', 'manifest.json'), '{ not json');
    writeFileSync(join(f.backups, 'stray.txt'), 'x');
    const result = await list(f.ctx, { task: 'demo' });
    expect(result.backups.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(result.backups[0]).toMatchObject({ reason: 'upgrade', dbCopy: 'online', verified: null, problems: [] });
    expect(result.verify).toBe(false);
    expect(listLines(result)[0]).toMatch(/^id\s+reason\s+created\s+db\s+runtime\s+files\s+size$/);
    expect(listLines({ ...result, backups: [] })).toEqual(["no backups for task 'demo'"]);
  });

  it('--verify re-reads every file: a changed byte, a truncation and a missing file are named, never their content', async () => {
    const f = setup();
    const a = await create(f.ctx, { task: 'demo' });
    f.clock.advance(1000);
    const b = await create(f.ctx, { task: 'demo' });
    f.clock.advance(1000);
    const c = await create(f.ctx, { task: 'demo' });
    const clean = await list(f.ctx, { task: 'demo', verify: true });
    expect(clean.backups.every((x) => x.verified === true && x.problems.length === 0)).toBe(true);
    const flip = join(f.backups, a.id, 'monitor.db');
    const bytes = readFileSync(flip);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeFileSync(flip, bytes);
    writeFileSync(join(f.backups, b.id, 'config.json'), 'short');
    rmSync(join(f.backups, c.id, 'task.json'));
    const result = await list(f.ctx, { task: 'demo', verify: true });
    const byId = new Map(result.backups.map((x) => [x.id, x]));
    expect(byId.get(a.id)).toMatchObject({
      verified: false,
      problems: ['monitor.db does not match the sha256 of the manifest'],
    });
    expect(byId.get(b.id)?.problems[0]).toMatch(/^config\.json has 5 bytes, the manifest says \d+$/);
    expect(byId.get(c.id)).toMatchObject({ verified: false, problems: ['task.json is missing'] });
    expect(listLines(result).join('\n')).toContain('FAILED: task.json is missing');
  });
});

describe('pruning (backup.keep)', () => {
  async function four(f: Fixture): Promise<string[]> {
    const instance = JSON.parse(read(join(f.dir, 'instance.json'))) as InstanceFile;
    const ids: string[] = [];
    for (const reason of ['upgrade', 'manual', 'manual', 'manual'] as const) {
      ids.push((await make(f.ctx, f.ws, instance, { reason })).id);
      f.clock.advance(60_000);
    }
    return ids;
  }

  it('removes the oldest beyond keep, never the newest upgrade or db-rebuild backup, never an id in protect', async () => {
    const f = setup();
    const [upgrade, m1, m2, m3] = await four(f);
    f.clock.advance(1000);
    const rebuild = await make(f.ctx, f.ws, JSON.parse(read(join(f.dir, 'instance.json'))) as InstanceFile, {
      reason: 'db-rebuild',
    });
    f.clock.advance(60_000);
    const m4 = await make(f.ctx, f.ws, JSON.parse(read(join(f.dir, 'instance.json'))) as InstanceFile, {
      reason: 'manual',
    });
    mkdirSync(join(f.backups, 'pre-migrate-20200101T000000Z'));
    writeFileSync(join(f.backups, 'pre-migrate-20200101T000000Z', 'config.json'), '{}');
    mkdirSync(join(f.backups, '20200101T000000Z-manual.partial'));
    // 6 backups: keep the 3 newest (m4, rebuild, m3); the old upgrade backup survives as the newest upgrade; m2 is protected
    // by the caller; m1 is the only one left over
    const removed = await prune(f.ws, 3, [m2 ?? '']);
    expect(removed).toEqual([m1]);
    const left = (await listBackups(f.ws)).map((x) => x.id);
    expect(left).toEqual([m4.id, rebuild.id, m3, m2, upgrade]);
    expect(existsSync(join(f.backups, m1 ?? ''))).toBe(false);
    expect(readdirSync(f.backups).sort()).toEqual(
      [...left, '20200101T000000Z-manual.partial', 'pre-migrate-20200101T000000Z'].sort(),
    );
  });

  it('create applies backup.keep from the configuration and reports what it removed', async () => {
    const f = setup();
    writeFileSync(
      join(f.dir, 'runtime.json'),
      `${JSON.stringify({ schema_version: 1, backup: { keep: 1 } }, null, 2)}\n`,
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      f.clock.advance(1000);
      const result = await create(f.ctx, { task: 'demo' });
      ids.push(result.id);
      expect(result.pruned).toEqual(i === 0 ? [] : [ids[i - 1] ?? '']);
    }
    expect(readdirSync(f.backups)).toEqual([ids[2]]);
  });

  it('a configuration that does not resolve prunes nothing', async () => {
    const f = setup();
    for (let i = 0; i < 3; i += 1) {
      f.clock.advance(1000);
      await create(f.ctx, { task: 'demo' });
    }
    writeFileSync(join(f.dir, 'runtime.json'), '{ broken');
    f.clock.advance(1000);
    const result = await create(f.ctx, { task: 'demo' });
    expect(result.pruned).toEqual([]);
    expect(readdirSync(f.backups)).toHaveLength(4);
  });
});

describe('backup restore', () => {
  async function backedUp(f: Fixture): Promise<string> {
    const made = await create(f.ctx, { task: 'demo' });
    f.clock.advance(60_000);
    return made.id;
  }

  it('is a dry run without --yes: the backup is checked and nothing changes', async () => {
    const f = setup();
    const id = await backedUp(f);
    const before = snapshotTree(f.dir);
    const result = await restore(f.ctx, { task: 'demo', id });
    expect(result).toMatchObject({
      applied: false,
      preRestoreBackup: null,
      dbCopy: 'online',
      restores: ['data/monitor.db'],
      upgradeNeeded: false,
    });
    expect(snapshotTree(f.dir)).toBe(before);
    expect(restoreLines(result).join('\n')).toContain('dry run, nothing changed');
  });

  it('with --yes the data equals the snapshot: later rows are gone, a verified pre-restore backup exists, the user files are untouched', async () => {
    const f = setup();
    const id = await backedUp(f);
    const db = openInstanceDb({ path: f.dbFile, expectedInstanceId: ID, mode: 'maintenance', runtimeVersion: '4.0.0' });
    db.driver.exec(
      "INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES ('after-backup', 'P', 2, 2)",
    );
    db.close();
    expect(markers(f.dbFile)).toEqual(['after-backup', 'before-backup']);
    const config = readFileSync(join(f.dir, 'config.json'));
    const task = readFileSync(join(f.dir, 'task.json'));
    const readme = readFileSync(join(f.dir, 'README.md'));
    const auditBefore = auditOf(f);
    const result = await restore(f.ctx, { task: 'demo', id, yes: true });
    expect(result.applied).toBe(true);
    expect(markers(f.dbFile)).toEqual(['before-backup']);
    expect(result.preRestoreBackup).toBe('20261020T101600Z-pre-restore');
    const pre = (await listBackups(f.ws)).find((x) => x.id === result.preRestoreBackup);
    expect(pre?.manifest.reason).toBe('pre-restore');
    expect(await verifyBackup(pre?.dir ?? '', pre?.manifest ?? (undefined as never))).toEqual([]);
    expect(markers(join(pre?.dir ?? '', 'monitor.db'))).toEqual(['after-backup', 'before-backup']);
    expect(readFileSync(join(f.dir, 'config.json'))).toEqual(config);
    expect(readFileSync(join(f.dir, 'task.json'))).toEqual(task);
    expect(readFileSync(join(f.dir, 'README.md'))).toEqual(readme);
    const audit = auditOf(f);
    expect(audit.startsWith(auditBefore)).toBe(true);
    expect(audit.slice(auditBefore.length)).toBe(
      [
        '## 2026-10-20T10:16:00Z | backup-restore',
        `- Summary: restored backup ${id} (pre-restore backup 20261020T101600Z-pre-restore)`,
        '- Reason: not given',
        '- Files changed: data/monitor.db',
        '- Validation: manifest ok; sha256 ok; instance id ok',
        '- Outcome: restored',
        '- Unresolved: none',
        '',
        '',
      ].join('\n'),
    );
    expect(JSON.parse(read(join(f.dir, 'instance.json')))).toMatchObject({
      dbSchemaVersion: 1,
      runtimeVersion: '4.0.0',
    });
  });

  it('removes a stale -wal and -shm before the swap: rows that only the WAL held do not leak into the restored file', async () => {
    const f = setup();
    const id = await backedUp(f);
    leaveStaleWal(f, 'only-in-the-wal');
    expect(existsSync(`${f.dbFile}-wal`)).toBe(true);
    await restore(f.ctx, { task: 'demo', id, yes: true });
    expect(existsSync(`${f.dbFile}-wal`)).toBe(false);
    expect(existsSync(`${f.dbFile}-shm`)).toBe(false);
    expect(markers(f.dbFile)).toEqual(['before-backup']);
    // and the stale WAL was kept in the pre-restore backup (raw or online, it holds the row)
    const pre = (await listBackups(f.ws)).find((x) => x.manifest.reason === 'pre-restore');
    expect(markers(join(pre?.dir ?? '', 'monitor.db'))).toContain('only-in-the-wal');
  });

  it('makes the pre-restore backup of a damaged live database as a raw copy and still restores', async () => {
    const f = setup();
    const id = await backedUp(f);
    writeFileSync(f.dbFile, 'this is not a database'.repeat(300));
    const result = await restore(f.ctx, { task: 'demo', id, yes: true });
    expect(markers(f.dbFile)).toEqual(['before-backup']);
    const pre = (await listBackups(f.ws)).find((x) => x.id === result.preRestoreBackup);
    expect(pre?.manifest).toMatchObject({ reason: 'pre-restore', dbCopy: 'raw' });
    expect(readFileSync(join(pre?.dir ?? '', 'monitor.db'), 'utf8').startsWith('this is not a database')).toBe(true);
  });

  it('works when the live database is gone (after a db rebuild): the pre-restore backup is files only', async () => {
    const f = setup();
    const id = await backedUp(f);
    rmSync(f.dbFile);
    const result = await restore(f.ctx, { task: 'demo', id, yes: true });
    expect(markers(f.dbFile)).toEqual(['before-backup']);
    const pre = (await listBackups(f.ws)).find((x) => x.id === result.preRestoreBackup);
    expect(pre?.manifest.dbCopy).toBe('none');
  });

  it.each(['running', 'starting', 'stopping', 'unhealthy', 'unmanaged-running'] as const)(
    'is INSTANCE_RUNNING for a %s instance and changes nothing',
    async (state) => {
      const f = setup();
      const id = await backedUp(f);
      const before = snapshotTree(f.dir);
      const error = await failureOf(() => restore(f.ctx, { task: 'demo', id, yes: true }, probing(state)));
      expect(error.code).toBe('INSTANCE_RUNNING');
      expect(snapshotTree(f.dir)).toBe(before);
    },
  );

  it('a manifest of another instance is BACKUP_INVALID and nothing changes', async () => {
    const f = setup();
    const id = await backedUp(f);
    const manifestFile = join(f.backups, id, 'manifest.json');
    writeFileSync(manifestFile, read(manifestFile).replace(ID, OTHER_ID));
    const before = snapshotTree(f.dir);
    const error = await failureOf(() => restore(f.ctx, { task: 'demo', id, yes: true }));
    expect(error.code).toBe('BACKUP_INVALID');
    expect(error.message).toContain('another instance');
    expect(snapshotTree(f.dir)).toBe(before);
  });

  it('a tampered sha256 in the manifest, or a changed database byte, is BACKUP_INVALID and nothing changes', async () => {
    const f = setup();
    const id = await backedUp(f);
    const manifestFile = join(f.backups, id, 'manifest.json');
    const original = read(manifestFile);
    const sha = /"sha256": "([0-9a-f]{64})"/.exec(original)?.[1] ?? '';
    writeFileSync(manifestFile, original.replace(sha, '0'.repeat(64)));
    const live = readFileSync(f.dbFile);
    const tampered = await failureOf(() => restore(f.ctx, { task: 'demo', id, yes: true }));
    expect(tampered).toMatchObject({ code: 'BACKUP_INVALID' });
    expect(tampered.message).toContain('does not verify');
    writeFileSync(manifestFile, original);
    const bytes = readFileSync(join(f.backups, id, 'monitor.db'));
    bytes[100] = (bytes[100] ?? 0) ^ 0x01;
    writeFileSync(join(f.backups, id, 'monitor.db'), bytes);
    const changed = await failureOf(() => restore(f.ctx, { task: 'demo', id, yes: true }));
    expect(changed.code).toBe('BACKUP_INVALID');
    expect(readFileSync(f.dbFile)).toEqual(live);
    expect(markers(f.dbFile)).toEqual(['before-backup']);
    expect((await listBackups(f.ws)).filter((x) => x.manifest.reason === 'pre-restore')).toEqual([]);
  });

  it('refuses names that are no backup, a partial folder, an unknown id and a traversal: BACKUP_NOT_FOUND', async () => {
    const f = setup();
    const id = await backedUp(f);
    mkdirSync(join(f.backups, '20260101T000000Z-manual.partial'));
    for (const name of [
      '20260101T000000Z-manual.partial',
      '20260101T000000Z-manual',
      '../demo',
      `${id}/..`,
      'pre-migrate-20260101T000000Z',
      '',
    ]) {
      const error = await failureOf(() => restore(f.ctx, { task: 'demo', id: name, yes: true }));
      expect(error.code, name).toBe('BACKUP_NOT_FOUND');
    }
  });

  it('a backup folder whose manifest was removed or damaged is BACKUP_INVALID', async () => {
    const f = setup();
    const id = await backedUp(f);
    writeFileSync(join(f.backups, id, 'manifest.json'), '{ nope');
    expect((await failureOf(() => restore(f.ctx, { task: 'demo', id }))).code).toBe('BACKUP_INVALID');
    rmSync(join(f.backups, id, 'manifest.json'));
    expect((await failureOf(() => restore(f.ctx, { task: 'demo', id }))).code).toBe('BACKUP_INVALID');
  });

  it('a backup that holds no database is BACKUP_INVALID', async () => {
    const f = setup({ db: false });
    const id = await backedUp(f);
    const error = await failureOf(() => restore(f.ctx, { task: 'demo', id, yes: true }));
    expect(error).toMatchObject({ code: 'BACKUP_INVALID', message: `backup ${id} holds no database` });
  });

  it('refuses a backup whose schema is newer than the runtime and allows an older one, which needs an upgrade', async () => {
    const f = setup();
    const id = await backedUp(f);
    const manifestFile = join(f.backups, id, 'manifest.json');
    const original = read(manifestFile);
    writeFileSync(manifestFile, original.replace('"dbSchemaVersion": 1', '"dbSchemaVersion": 99'));
    expect((await failureOf(() => restore(f.ctx, { task: 'demo', id, yes: true }))).code).toBe('DB_NEWER_THAN_RUNTIME');
    writeFileSync(manifestFile, original);
    const twoSteps = migrationsWith({
      '0002_probe_table.sql':
        '-- mcs:migration version=2 name=probe_table\nCREATE TABLE probe_table (id INTEGER PRIMARY KEY NOT NULL) STRICT;\n',
    });
    const dry = await restore(f.ctx, { task: 'demo', id }, { migrations: twoSteps });
    expect(dry.upgradeNeeded).toBe(true);
    const done = await restore(f.ctx, { task: 'demo', id, yes: true }, { migrations: twoSteps });
    expect(restoreLines(done).join('\n')).toContain('mcs upgrade --task demo');
  });

  it('a restore that fails halfway keeps the pre-restore backup, names it, leaves the database as it was and no temp file', async () => {
    const f = setup();
    const id = await backedUp(f);
    const db = openInstanceDb({ path: f.dbFile, expectedInstanceId: ID, mode: 'maintenance', runtimeVersion: '4.0.0' });
    db.driver.exec(
      "INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES ('live-row', 'P', 2, 2)",
    );
    db.close();
    const auditBefore = auditOf(f);
    const error = await failureOf(() =>
      restore(
        f.ctx,
        { task: 'demo', id, yes: true },
        { rename: () => Promise.reject(new McsError('WORKSPACE_INVALID', 'cannot move monitor.db: EPERM')) },
      ),
    );
    expect(error.code).toBe('WORKSPACE_INVALID');
    const pre = (await listBackups(f.ws)).find((x) => x.manifest.reason === 'pre-restore');
    expect(pre).toBeDefined();
    expect(error.message).toContain(pre?.id ?? 'missing');
    expect(error.hint).toBe(`mcs backup restore --task demo --id ${pre?.id ?? ''} --yes`);
    expect(error.details).toMatchObject({ preRestoreBackup: pre?.id });
    expect(await verifyBackup(pre?.dir ?? '', pre?.manifest ?? (undefined as never))).toEqual([]);
    expect(markers(f.dbFile)).toEqual(['before-backup', 'live-row']);
    expect(readdirSync(join(f.dir, 'data')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(auditOf(f)).toBe(auditBefore);
  });

  it('--include-runtime-config restores runtime.json and the hooks field, and removes a runtime.json the backup did not have', async () => {
    const f = setup();
    writeFileSync(join(f.dir, 'runtime.json'), `${JSON.stringify({ schema_version: 1, logLevel: 'warn' }, null, 2)}\n`);
    const instance = JSON.parse(read(join(f.dir, 'instance.json'))) as InstanceFile;
    writeFileSync(
      join(f.dir, 'instance.json'),
      `${JSON.stringify({ ...instance, hooks: { enabled: true } }, null, 2)}\n`,
    );
    const withRuntime = await backedUp(f);
    writeFileSync(
      join(f.dir, 'runtime.json'),
      `${JSON.stringify({ schema_version: 1, logLevel: 'debug' }, null, 2)}\n`,
    );
    writeFileSync(
      join(f.dir, 'instance.json'),
      `${JSON.stringify({ ...instance, hooks: { enabled: false } }, null, 2)}\n`,
    );
    // without the option nothing of the runtime configuration comes back
    await restore(f.ctx, { task: 'demo', id: withRuntime, yes: true });
    expect(read(join(f.dir, 'runtime.json'))).toContain('debug');
    expect((JSON.parse(read(join(f.dir, 'instance.json'))) as InstanceFile).hooks).toEqual({ enabled: false });
    const result = await restore(f.ctx, { task: 'demo', id: withRuntime, yes: true, includeRuntimeConfig: true });
    expect(result.restores).toEqual(['data/monitor.db', 'runtime.json', 'instance.json']);
    expect(read(join(f.dir, 'runtime.json'))).toContain('warn');
    expect((JSON.parse(read(join(f.dir, 'instance.json'))) as InstanceFile).hooks).toEqual({ enabled: true });
    // a backup made without a runtime.json deletes the live one
    rmSync(join(f.dir, 'runtime.json'));
    f.clock.advance(60_000);
    const without = await backedUp(f);
    writeFileSync(join(f.dir, 'runtime.json'), `${JSON.stringify({ schema_version: 1 }, null, 2)}\n`);
    await restore(f.ctx, { task: 'demo', id: without, yes: true, includeRuntimeConfig: true });
    expect(existsSync(join(f.dir, 'runtime.json'))).toBe(false);
  });
});
