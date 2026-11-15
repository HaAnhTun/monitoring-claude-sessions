// `ops.instanceUpgrade` (01 5.4, 5.7, ADR 0009, ADR 0021): `upgrade`, `db migrate` and `db rebuild`. The runtime of the test
// ships a migration set with extra steps (a temp `migrations/` folder), so a database written at schema 1 is "older" and a
// failing step can be injected. Every workspace is a temp one and every database a real SQLite file.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BackupManifestSchema, McsError, RUNTIME_VERSION, type InstanceFile } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { openSqlite } from '../db/driver.ts';
import { defaultMigrationsDir, peekDbSchemaVersion, type MigrationsLocation } from '../db/migrations.ts';
import { openInstanceDb } from '../db/open.ts';
import type { Logger } from '../log/logger.ts';
import { resolveWorkspace, withTaskMutex, type WorkspaceRef } from '../workspace/paths.ts';
import { listBackups, restore, verifyBackup } from './backup.ts';
import {
  compareSemver,
  migrateDb,
  migrateLines,
  rebuildDb,
  rebuildLines,
  run,
  runLines,
  type UpgradeDeps,
  type UpgradeStep,
} from './instance-upgrade.ts';
import type { StartResult, StopInput, StopResult } from './lifecycle.ts';
import type { ProbeResult, ProbeState } from './probe.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111';
const T0 = Date.UTC(2026, 9, 20, 10, 15, 0);
const OLD = '3.0.0';

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

const STEP_2 = {
  '0002_probe_table.sql':
    "-- mcs:migration version=2 name=probe_table\nCREATE TABLE probe_table (id INTEGER PRIMARY KEY NOT NULL, note TEXT) STRICT;\nINSERT INTO probe_table (id, note) VALUES (1, 'migrated');\n",
};
const BROKEN_STEP_3 = {
  '0003_broken_step.sql':
    '-- mcs:migration version=3 name=broken_step\nCREATE TABLE half_done (id INTEGER PRIMARY KEY NOT NULL) STRICT;\nINSERT INTO no_such_table (id) VALUES (1);\n',
};

/** The migration files of the runtime plus `extra`: a runtime that ships more steps than the real one. */
function migrationsWith(extra: Record<string, string>): MigrationsLocation {
  const dir = makeTemp('migrations').path;
  const real = fileURLToPath(defaultMigrationsDir());
  for (const name of readdirSync(real)) copyFileSync(join(real, name), join(dir, name));
  for (const [name, sql] of Object.entries(extra)) writeFileSync(join(dir, name), sql);
  return { migrationsDir: pathToFileURL(dir + sep) };
}

interface Fixture {
  readonly ctx: OpContext;
  readonly clock: FakeClock;
  readonly ws: WorkspaceRef;
  readonly dir: string;
  readonly dbFile: string;
  readonly backups: string;
}

function setup(
  o: { db?: boolean; instance?: Partial<InstanceFile>; location?: MigrationsLocation; rootName?: string } = {},
): Fixture {
  const root = makeTemp('upgrade').path;
  const { repo } = buildRepo(join(root, o.rootName ?? 'repo'));
  const dir = buildTaskWorkspace(repo, {
    slug: 'demo',
    config: { title: 'FIXTURE demo' },
    instance: {
      slug: 'demo',
      instanceId: ID,
      runtimeVersion: OLD,
      createdBy: `mcs ${OLD}`,
      dbSchemaVersion: 1,
      ...o.instance,
    },
  });
  mkdirSync(join(dir, 'data'), { recursive: true });
  const dbFile = join(dir, 'data', 'monitor.db');
  if (o.db !== false) {
    const db = openInstanceDb({
      path: dbFile,
      expectedInstanceId: ID,
      mode: 'serve',
      runtimeVersion: OLD,
      ...(o.location ?? {}),
    });
    db.driver
      .prepare('INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES (?, ?, 1, 1)')
      .run(['before-upgrade', 'P']);
    db.close();
  }
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

async function failureOf(run: () => Promise<unknown>): Promise<McsError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected an McsError');
}

/**
 * The hash of a workspace tree. A read-only open of a WAL database (the plan of `upgrade`, as the peek of `start`) leaves an
 * empty `-wal` and a `-shm` next to it: that is SQLite's own behaviour, and not a change of the instance's data.
 */
const snap = (dir: string): string => snapshotTree(dir, { exclude: ['data/monitor.db-wal', 'data/monitor.db-shm'] });

const read = (file: string): string => readFileSync(file, 'utf8');
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const auditOf = (f: Fixture): string => {
  const file = join(f.dir, 'audit', 'changes.md');
  return existsSync(file) ? read(file) : '';
};
const instanceOf = (f: Fixture): InstanceFile => JSON.parse(read(join(f.dir, 'instance.json'))) as InstanceFile;

function sqliteRows<T extends Record<string, unknown>>(file: string, sql: string): T[] {
  const db = openSqlite(file, { readonly: true, fileMustExist: true, timeoutMs: 2000 });
  try {
    return db.prepare<T>(sql).all();
  } finally {
    db.close();
  }
}

const migrationVersions = (file: string): number[] =>
  sqliteRows<{ version: number }>(file, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version);

const hasTable = (file: string, name: string): boolean =>
  sqliteRows(file, `SELECT name FROM sqlite_schema WHERE name = '${name}'`).length === 1;

/** A crashed server's leftovers: the database as it was, plus a `-wal` that holds a row the database file does not. */
function leaveStaleWal(f: Fixture, marker: string): void {
  const db = openInstanceDb({ path: f.dbFile, expectedInstanceId: ID, mode: 'serve', runtimeVersion: OLD });
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

/** Scripted `stop` and `start` of `--restart`, and a probe that follows them. */
function scriptedLifecycle(
  initial: ProbeState,
  o: { startExit?: 0 | 1; startFails?: McsError; stopFails?: McsError } = {},
) {
  const calls: string[] = [];
  /** What `--restart` asked `stop` to do, one entry per call. */
  const stops: StopInput[] = [];
  let state: ProbeState = initial;
  const stopResult: StopResult = {
    outcome: 'stopped',
    slug: 'demo',
    pid: 4242,
    url: null,
    forced: false,
    reason: null,
    terminalsEnded: 0,
    exitCode: 0,
    message: ['stopped runtime pid 4242'],
  };
  const deps: UpgradeDeps = {
    probe: () => Promise.resolve(probeResult(state)),
    lifecycle: {
      stop: (_ctx, input) => {
        calls.push('stop');
        stops.push(input ?? {});
        if (o.stopFails !== undefined) return Promise.reject(o.stopFails);
        state = 'stopped';
        return Promise.resolve(stopResult);
      },
      start: () => {
        calls.push('start');
        if (o.startFails !== undefined) return Promise.reject(o.startFails);
        const result: StartResult = {
          outcome: 'started',
          slug: 'demo',
          dir: '',
          instanceId: ID,
          engine: 'node',
          url: 'http://127.0.0.1:18002',
          pid: 5151,
          createdDefault: false,
          adopted: false,
          opened: null,
          exitCode: o.startExit ?? 0,
          message: ['started: http://127.0.0.1:18002 (pid 5151)'],
          warnings: [],
        };
        return Promise.resolve(result);
      },
    },
    beforeStep: (step) => {
      calls.push(`step:${step}`);
    },
  };
  return { calls, deps, stops };
}

describe('compareSemver', () => {
  it.each([
    ['3.0.0', '4.0.0', -1],
    ['4.0.0', '4.0.0', 0],
    ['4.1.0', '4.0.9', 1],
    ['4.0.10', '4.0.9', 1],
    ['10.0.0', '9.9.9', 1],
    ['4.0.0-rc.1', '4.0.0', -1],
    ['4.0.0', '4.0.0-rc.1', 1],
    ['4.0.0-rc.2', '4.0.0-rc.10', -1],
    ['4.0.0-alpha', '4.0.0-1', 1],
    ['4.0.0-alpha', '4.0.0-alpha.1', -1],
    ['4.0.0-alpha', '4.0.0-beta', -1],
    ['not a version', '4.0.0', 1],
  ])('%s against %s is %i', (a, b, expected) => {
    expect(Math.sign(compareSemver(a, b))).toBe(expected);
  });
});

describe('upgrade', () => {
  it('is already current when the runtime version is the same and no migration is pending: nothing is written', async () => {
    const f = setup({ instance: { runtimeVersion: RUNTIME_VERSION } });
    const before = snap(f.dir);
    const result = await run(f.ctx, { task: 'demo', yes: true });
    expect(result).toMatchObject({
      outcome: 'current',
      backup: null,
      exitCode: 0,
      plan: { needed: false, backup: null },
    });
    expect(runLines(result)).toEqual([`already current: runtime ${RUNTIME_VERSION}, db schema 1`]);
    expect(snap(f.dir)).toBe(before);
  });

  it('is a dry run without --yes and with --dry-run: the plan names the steps and the backup, and nothing is written', async () => {
    const location = migrationsWith(STEP_2);
    const f = setup();
    const before = snap(f.dir);
    for (const input of [{ task: 'demo' }, { task: 'demo', yes: true, dryRun: true }]) {
      const result = await run(f.ctx, input, { migrations: location });
      expect(result).toMatchObject({
        outcome: 'dry-run',
        backup: null,
        plan: {
          runtimeFrom: OLD,
          runtimeTo: RUNTIME_VERSION,
          db: { from: 1, to: 2, steps: [{ version: 2, name: 'probe_table' }] },
          files: [],
          needed: true,
          backup: 'data/backups/20261020T101500Z-upgrade/',
        },
      });
      expect(runLines(result).join('\n')).toContain('database: schema 1 -> 2 (0002 probe_table)');
    }
    expect(snap(f.dir)).toBe(before);
  });

  it('records the new runtime version: the backup exists first, the user files and the old audit bytes are untouched', async () => {
    const f = setup();
    const config = readFileSync(join(f.dir, 'config.json'));
    const task = readFileSync(join(f.dir, 'task.json'));
    const readme = readFileSync(join(f.dir, 'README.md'));
    const instanceBytes = readFileSync(join(f.dir, 'instance.json'));
    mkdirSync(join(f.dir, 'audit'), { recursive: true });
    writeFileSync(
      join(f.dir, 'audit', 'changes.md'),
      '# Changes\n\n## 2026-01-01T00:00:00Z | init-task\n- Summary: old entry\n\n',
    );
    const auditBefore = auditOf(f);
    const result = await run(f.ctx, { task: 'demo', yes: true });
    expect(result).toMatchObject({
      outcome: 'upgraded',
      backup: '20261020T101500Z-upgrade',
      integrity: null,
      restart: null,
      exitCode: 0,
    });
    const instance = instanceOf(f);
    expect(instance).toMatchObject({
      runtimeVersion: RUNTIME_VERSION,
      dbSchemaVersion: 1,
      upgradedAt: '2026-10-20T10:15:00Z',
      createdBy: `mcs ${OLD}`,
      instanceId: ID,
    });
    expect(readFileSync(join(f.dir, 'config.json'))).toEqual(config);
    expect(readFileSync(join(f.dir, 'task.json'))).toEqual(task);
    expect(readFileSync(join(f.dir, 'README.md'))).toEqual(readme);
    // the backup holds the files as they were before the upgrade, with matching sha256 values
    const folder = join(f.backups, '20261020T101500Z-upgrade');
    const manifest = BackupManifestSchema.parse(JSON.parse(read(join(folder, 'manifest.json'))));
    expect(manifest.reason).toBe('upgrade');
    expect(readFileSync(join(folder, 'instance.json'))).toEqual(instanceBytes);
    for (const entry of manifest.files) expect(sha(join(folder, entry.path))).toBe(entry.sha256);
    expect(await verifyBackup(folder, manifest)).toEqual([]);
    const audit = auditOf(f);
    expect(audit.startsWith(auditBefore)).toBe(true);
    expect(audit.slice(auditBefore.length)).toBe(
      [
        '## 2026-10-20T10:15:00Z | upgrade',
        `- Summary: runtime ${OLD} -> ${RUNTIME_VERSION}; db schema 1 -> 1; files: none`,
        '- Reason: not given',
        '- Files changed: instance.json',
        '- Validation: no migrations pending',
        '- Outcome: upgraded; backup 20261020T101500Z-upgrade',
        '- Unresolved: none',
        '',
        '',
      ].join('\n'),
    );
    // idempotent: a second run is current
    expect((await run(f.ctx, { task: 'demo', yes: true })).outcome).toBe('current');
  });

  it('a task without a database just gets the new version; the first start creates the database', async () => {
    const f = setup({ db: false, instance: { dbSchemaVersion: 0 } });
    const result = await run(f.ctx, { task: 'demo', yes: true });
    expect(result).toMatchObject({ outcome: 'upgraded', plan: { db: null } });
    expect(instanceOf(f)).toMatchObject({ runtimeVersion: RUNTIME_VERSION, dbSchemaVersion: 0 });
    expect(runLines(result)[0]).toContain('database: none yet');
  });

  it('makes the backup before the first change, migrates, checks the integrity, then writes instance.json and the audit entry', async () => {
    const location = migrationsWith(STEP_2);
    const f = setup();
    const seen: string[] = [];
    const deps: UpgradeDeps = {
      migrations: location,
      beforeStep: async (step: UpgradeStep) => {
        const backup = (await listBackups(f.ws)).find((b) => b.manifest.reason === 'upgrade');
        const version = peekDbSchemaVersion(f.dbFile, location)?.userVersion;
        seen.push(
          `${step}: backup=${backup === undefined ? 'no' : (await verifyBackup(backup.dir, backup.manifest)).length === 0 ? 'verified' : 'broken'} db=${String(version)} instance=${instanceOf(f).runtimeVersion} audit=${auditOf(f) === '' ? 'none' : 'some'}`,
        );
      },
    };
    const result = await run(f.ctx, { task: 'demo', yes: true }, deps);
    expect(seen).toEqual([
      `backup: backup=no db=1 instance=${OLD} audit=none`,
      `migrate: backup=verified db=1 instance=${OLD} audit=none`,
      `integrity: backup=verified db=2 instance=${OLD} audit=none`,
      `instance: backup=verified db=2 instance=${OLD} audit=none`,
      `audit: backup=verified db=2 instance=${RUNTIME_VERSION} audit=none`,
    ]);
    expect(result).toMatchObject({ outcome: 'upgraded', integrity: 'ok', plan: { db: { from: 1, to: 2 } } });
    expect(migrationVersions(f.dbFile)).toEqual([1, 2]);
    expect(sqliteRows(f.dbFile, 'SELECT note FROM probe_table')).toEqual([{ note: 'migrated' }]);
    expect(instanceOf(f)).toMatchObject({ runtimeVersion: RUNTIME_VERSION, dbSchemaVersion: 2 });
    // the backup holds the database as it was (schema 1, no probe table)
    const folder = join(f.backups, result.backup ?? 'missing');
    expect(migrationVersions(join(folder, 'monitor.db'))).toEqual([1]);
    expect(hasTable(join(folder, 'monitor.db'), 'probe_table')).toBe(false);
    expect(auditOf(f)).toContain(`- Summary: runtime ${OLD} -> ${RUNTIME_VERSION}; db schema 1 -> 2; files: none`);
    expect(auditOf(f)).toContain('- Validation: migrations applied; integrity ok');
    expect(auditOf(f)).toContain(`- Outcome: upgraded; backup ${result.backup ?? 'missing'}`);
  });

  it('a failing migration restores the database from the backup, writes no upgrade entry and names the backup', async () => {
    const location = migrationsWith({ ...STEP_2, ...BROKEN_STEP_3 });
    const f = setup();
    const dbBefore = sha(f.dbFile);
    const instanceBefore = readFileSync(join(f.dir, 'instance.json'));
    const error = await failureOf(() => run(f.ctx, { task: 'demo', yes: true }, { migrations: location }));
    expect(error.code).toBe('DB_ERROR');
    expect(error.message).toContain('migration 3 (broken_step) failed');
    expect(error.message).toContain('restored from backup 20261020T101500Z-upgrade');
    expect(error.details).toMatchObject({ backup: '20261020T101500Z-upgrade' });
    // step 2 had committed before step 3 failed: the restore is what takes it back
    // (read before anything opens the file: a read-only open of a WAL database leaves an empty -wal behind)
    expect(existsSync(`${f.dbFile}-wal`)).toBe(false);
    expect(migrationVersions(f.dbFile)).toEqual([1]);
    expect(hasTable(f.dbFile, 'probe_table')).toBe(false);
    expect(hasTable(f.dbFile, 'half_done')).toBe(false);
    expect(sqliteRows(f.dbFile, 'SELECT project_key FROM projects')).toEqual([{ project_key: 'before-upgrade' }]);
    expect(readFileSync(join(f.dir, 'instance.json'))).toEqual(instanceBefore);
    expect(auditOf(f)).toBe('');
    // the backup stays and is the database as it was
    expect(sha(join(f.backups, '20261020T101500Z-upgrade', 'monitor.db'))).toBe(sha(f.dbFile));
    expect(dbBefore).not.toBe('');
    // the database passes its checks and the next run, with a good step, works
    expect(sqliteRows<{ quick_check: string }>(f.dbFile, 'PRAGMA quick_check')).toEqual([{ quick_check: 'ok' }]);
    f.clock.advance(1000);
    const good = await run(f.ctx, { task: 'demo', yes: true }, { migrations: migrationsWith(STEP_2) });
    expect(good.outcome).toBe('upgraded');
  });

  it('a failed integrity check after the migrations restores the database as well', async () => {
    const location = migrationsWith(STEP_2);
    const f = setup();
    const error = await failureOf(() =>
      run(
        f.ctx,
        { task: 'demo', yes: true },
        {
          migrations: location,
          beforeStep: (step) => {
            if (step === 'integrity')
              throw new McsError('DB_ERROR', 'the migrated database does not pass PRAGMA quick_check');
          },
        },
      ),
    );
    expect(error.code).toBe('DB_ERROR');
    expect(error.message).toContain('does not pass PRAGMA quick_check');
    expect(migrationVersions(f.dbFile)).toEqual([1]);
    expect(auditOf(f)).toBe('');
  });

  it('a restore that fails after a failed migration says how to restore by hand', async () => {
    const location = migrationsWith({ ...STEP_2, ...BROKEN_STEP_3 });
    const f = setup();
    const error = await failureOf(() =>
      run(
        f.ctx,
        { task: 'demo', yes: true },
        {
          migrations: location,
          rename: () => Promise.reject(new McsError('WORKSPACE_INVALID', 'cannot move monitor.db: EPERM')),
        },
      ),
    );
    expect(error.code).toBe('DB_ERROR');
    expect(error.message).toContain('restoring the database from backup 20261020T101500Z-upgrade failed too');
    expect(error.hint).toBe('mcs backup restore --task demo --id 20261020T101500Z-upgrade --yes');
    expect(auditOf(f)).toBe('');
  });

  it('if instance.json cannot be written after the migration, the database stays migrated, nothing is audited and a rerun finishes', async () => {
    const location = migrationsWith(STEP_2);
    const f = setup();
    const error = await failureOf(() =>
      run(
        f.ctx,
        { task: 'demo', yes: true },
        {
          migrations: location,
          beforeStep: (step) => {
            if (step === 'instance') throw new McsError('WORKSPACE_INVALID', 'cannot replace instance.json: EPERM');
          },
        },
      ),
    );
    expect(error.code).toBe('WORKSPACE_INVALID');
    expect(migrationVersions(f.dbFile)).toEqual([1, 2]);
    expect(instanceOf(f).runtimeVersion).toBe(OLD);
    expect(auditOf(f)).toBe('');
    f.clock.advance(1000);
    const again = await run(f.ctx, { task: 'demo', yes: true }, { migrations: location });
    expect(again).toMatchObject({ outcome: 'upgraded', plan: { db: { from: 2, to: 2, steps: [] } } });
    expect(instanceOf(f)).toMatchObject({ runtimeVersion: RUNTIME_VERSION, dbSchemaVersion: 2 });
  });

  describe('the downgrade rules (01 5.7)', () => {
    it('an instance.json from a newer runtime is DOWNGRADE_REFUSED and nothing changes', async () => {
      const f = setup({ instance: { runtimeVersion: '9.9.9' } });
      const before = snap(f.dir);
      const error = await failureOf(() => run(f.ctx, { task: 'demo', yes: true }));
      expect(error.code).toBe('DOWNGRADE_REFUSED');
      expect(snap(f.dir)).toBe(before);
      // allowed: the data commands that do not rewrite the version
      expect((await migrateDb(f.ctx, { task: 'demo', yes: true })).outcome).toBe('current');
    });

    it('a database newer than the runtime is DB_NEWER_THAN_RUNTIME, the file is not modified, for upgrade and db migrate', async () => {
      const newer = migrationsWith(STEP_2);
      const f = setup({ location: newer });
      const bytes = sha(f.dbFile);
      const before = snap(f.dir);
      expect((await failureOf(() => run(f.ctx, { task: 'demo', yes: true }))).code).toBe('DB_NEWER_THAN_RUNTIME');
      expect((await failureOf(() => migrateDb(f.ctx, { task: 'demo', yes: true }))).code).toBe('DB_NEWER_THAN_RUNTIME');
      expect(sha(f.dbFile)).toBe(bytes);
      expect(snap(f.dir)).toBe(before);
    });

    it('an instance.json with a schema version this runtime does not know is refused untouched', async () => {
      const f = setup();
      writeFileSync(
        join(f.dir, 'instance.json'),
        read(join(f.dir, 'instance.json')).replace('"schema_version": 1', '"schema_version": 2'),
      );
      const before = snap(f.dir);
      const error = await failureOf(() => run(f.ctx, { task: 'demo', yes: true }));
      expect(error.code).toBe('WORKSPACE_INVALID');
      expect(snap(f.dir)).toBe(before);
    });
  });

  it('refuses a workspace without instance.json (INSTANCE_NOT_INITIALIZED, hint: migrate-workspace) and never writes it', async () => {
    const f = setup();
    rmSync(join(f.dir, 'instance.json'));
    const before = snap(f.dir);
    for (const apply of [false, true]) {
      const error = await failureOf(() => run(f.ctx, { task: 'demo', yes: apply }));
      expect(error.code).toBe('INSTANCE_NOT_INITIALIZED');
      expect(error.hint).toContain('mcs migrate-workspace --task demo');
    }
    expect((await failureOf(() => migrateDb(f.ctx, { task: 'demo', yes: true }))).code).toBe(
      'INSTANCE_NOT_INITIALIZED',
    );
    expect((await failureOf(() => rebuildDb(f.ctx, { task: 'demo', yes: true, confirm: 'demo' }))).code).toBe(
      'INSTANCE_NOT_INITIALIZED',
    );
    expect(snap(f.dir)).toBe(before);
  });

  describe('a monitor that runs', () => {
    it.each(['running', 'starting', 'stopping', 'unhealthy', 'unmanaged-running'] as const)(
      'is INSTANCE_RUNNING for %s without --restart; the dry run still shows the plan; nothing changes',
      async (state) => {
        const f = setup();
        const before = snap(f.dir);
        const { deps, calls } = scriptedLifecycle(state);
        const error = await failureOf(() => run(f.ctx, { task: 'demo', yes: true }, deps));
        expect(error.code).toBe('INSTANCE_RUNNING');
        if (state !== 'unmanaged-running') expect(error.hint).toContain('--restart');
        expect(calls.filter((c) => c === 'stop' || c === 'start')).toEqual([]);
        expect((await run(f.ctx, { task: 'demo' }, deps)).outcome).toBe('dry-run');
        expect(snap(f.dir)).toBe(before);
      },
    );

    it('a monitor of another runtime is never stopped, not even with --restart', async () => {
      const f = setup();
      const before = snap(f.dir);
      const { deps, calls } = scriptedLifecycle('unmanaged-running');
      const error = await failureOf(() => run(f.ctx, { task: 'demo', yes: true, restart: true }, deps));
      expect(error.code).toBe('INSTANCE_RUNNING');
      expect(error.message).toContain('not started by this runtime');
      expect(calls.filter((c) => c === 'stop' || c === 'start')).toEqual([]);
      expect(snap(f.dir)).toBe(before);
    });

    it('--restart stops it before the backup, migrates, and starts it at the end', async () => {
      const f = setup();
      const { deps, calls } = scriptedLifecycle('running');
      const result = await run(
        f.ctx,
        { task: 'demo', yes: true, restart: true },
        { ...deps, migrations: migrationsWith(STEP_2) },
      );
      expect(calls).toEqual([
        'stop',
        'step:backup',
        'step:migrate',
        'step:integrity',
        'step:instance',
        'step:audit',
        'start',
      ]);
      expect(result).toMatchObject({
        outcome: 'upgraded',
        exitCode: 0,
        restart: { stopped: true, started: true, url: 'http://127.0.0.1:18002', pid: 5151 },
      });
      expect(runLines(result)).toEqual(
        expect.arrayContaining(['stopped the running server first', 'started: http://127.0.0.1:18002 (pid 5151)']),
      );
    });

    it('--force passes through to the stop of --restart, and without it the stop is not told to force', async () => {
      const forced = setup();
      const scripted = scriptedLifecycle('running');
      await run(
        forced.ctx,
        { task: 'demo', yes: true, restart: true, force: true },
        { ...scripted.deps, migrations: migrationsWith(STEP_2) },
      );
      expect(scripted.stops).toEqual([{ task: 'demo', force: true, purpose: 'upgrade' }]);

      const plain = setup();
      const plainScript = scriptedLifecycle('running');
      await run(plain.ctx, { task: 'demo', yes: true, restart: true }, plainScript.deps);
      expect(plainScript.stops).toEqual([{ task: 'demo', purpose: 'upgrade' }]);
      expect(Object.hasOwn(plainScript.stops[0] ?? {}, 'force')).toBe(false);
    });

    it('a refusal of the stop (terminals are live) ends the upgrade before the backup: nothing is written, the refusal is the error', async () => {
      const f = setup();
      const before = snap(f.dir);
      const refusal = new McsError('TERMINALS_LIVE', '1 terminal session is live (api-1); upgrading would end it', {
        details: { live: 1, sessions: ['api-1'] },
      });
      const { deps, calls } = scriptedLifecycle('running', { stopFails: refusal });
      const error = await failureOf(() => run(f.ctx, { task: 'demo', yes: true, restart: true }, deps));
      expect(error).toBe(refusal);
      expect(calls).toEqual(['stop']);
      expect(snap(f.dir)).toBe(before);
    });

    it('--force without --restart changes nothing: a live monitor is still INSTANCE_RUNNING', async () => {
      const f = setup();
      const { deps, calls } = scriptedLifecycle('running');
      const error = await failureOf(() => run(f.ctx, { task: 'demo', yes: true, force: true }, deps));
      expect(error.code).toBe('INSTANCE_RUNNING');
      expect(calls).toEqual([]);
    });

    it('--restart on a stopped task still starts it at the end (the old database made start fail with DB_UPGRADE_REQUIRED)', async () => {
      const f = setup();
      const { deps, calls } = scriptedLifecycle('stopped');
      const result = await run(f.ctx, { task: 'demo', yes: true, restart: true }, deps);
      expect(calls.at(-1)).toBe('start');
      expect(calls).not.toContain('stop');
      expect(result.restart).toMatchObject({ stopped: false, started: true });
    });

    it('nothing to do means no restart', async () => {
      const f = setup({ instance: { runtimeVersion: RUNTIME_VERSION } });
      const { deps, calls } = scriptedLifecycle('running');
      const result = await run(f.ctx, { task: 'demo', yes: true, restart: true }, deps);
      expect(result.outcome).toBe('current');
      expect(calls).toEqual([]);
    });

    it('a start that reports failure is exit code 1, a start that throws names the finished upgrade', async () => {
      const f = setup();
      const failed = await run(
        f.ctx,
        { task: 'demo', yes: true, restart: true },
        scriptedLifecycle('stopped', { startExit: 1 }).deps,
      );
      expect(failed).toMatchObject({ outcome: 'upgraded', exitCode: 1, restart: { started: false } });
      const g = setup();
      const error = await failureOf(() =>
        run(
          g.ctx,
          { task: 'demo', yes: true, restart: true },
          scriptedLifecycle('stopped', { startFails: new McsError('START_FAILED', 'runtime exited during start') })
            .deps,
        ),
      );
      expect(error.code).toBe('START_FAILED');
      expect(error.message).toContain('the upgrade is done');
      expect(instanceOf(g).runtimeVersion).toBe(RUNTIME_VERSION);
    });

    it('a step that fails after --restart stopped the server says that the server is down', async () => {
      const f = setup();
      const { deps } = scriptedLifecycle('running');
      const error = await failureOf(() =>
        run(
          f.ctx,
          { task: 'demo', yes: true, restart: true },
          {
            ...deps,
            beforeStep: (step) => {
              if (step === 'instance') throw new McsError('WORKSPACE_INVALID', 'cannot replace instance.json: EPERM');
            },
          },
        ),
      );
      expect(error.message).toContain(
        'the server was stopped for the upgrade (`mcs start --task demo` starts it again)',
      );
    });
  });

  it('works in a folder with a space in its path', async () => {
    const f = setup({ rootName: 'repo with space' });
    const result = await run(f.ctx, { task: 'demo', yes: true });
    expect(result.outcome).toBe('upgraded');
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
    const error = await failureOf(() => run(f.ctx, { task: 'demo', yes: true }, { mutexTimeoutMs: 150 }));
    expect(error.code).toBe('WORKSPACE_BUSY');
    release();
    await holder;
  });
});

describe('db migrate', () => {
  it('has nothing to do without a database or when the schema is current', async () => {
    const none = setup({ db: false });
    expect(await migrateDb(none.ctx, { task: 'demo', yes: true })).toMatchObject({ outcome: 'no-database', db: null });
    expect(migrateLines(await migrateDb(none.ctx, { task: 'demo' }))[0]).toContain('has no database yet');
    const current = setup();
    const result = await migrateDb(current.ctx, { task: 'demo', yes: true });
    expect(result).toMatchObject({ outcome: 'current', db: { from: 1, to: 1, steps: [] } });
    expect(migrateLines(result)).toEqual(['already current: db schema 1']);
    expect(auditOf(current)).toBe('');
  });

  it('is a dry run without --yes, then migrates after an upgrade backup and records only the schema mirror', async () => {
    const location = migrationsWith(STEP_2);
    const f = setup();
    const before = snap(f.dir);
    const dry = await migrateDb(f.ctx, { task: 'demo' }, { migrations: location });
    expect(dry).toMatchObject({ outcome: 'dry-run', db: { from: 1, to: 2 }, backup: null });
    expect(migrateLines(dry).join('\n')).toContain('0002 probe_table');
    expect(snap(f.dir)).toBe(before);
    const result = await migrateDb(f.ctx, { task: 'demo', yes: true }, { migrations: location });
    expect(result).toMatchObject({ outcome: 'migrated', backup: '20261020T101500Z-upgrade', integrity: 'ok' });
    expect(migrationVersions(f.dbFile)).toEqual([1, 2]);
    // the runtime version of instance.json is the business of `upgrade`
    expect(instanceOf(f)).toMatchObject({ runtimeVersion: OLD, dbSchemaVersion: 2, upgradedAt: null });
    expect(auditOf(f)).toContain('| db-migrate');
    expect(auditOf(f)).toContain('- Summary: db schema 1 -> 2');
    expect(auditOf(f)).toContain('- Files changed: instance.json, data/monitor.db');
    expect(auditOf(f)).toContain('- Outcome: migrated; backup 20261020T101500Z-upgrade');
    expect(migrateLines(result)[0]).toContain('db schema 1 -> 2');
  });

  it('a failing step restores the database and writes no entry; a running instance blocks it', async () => {
    const f = setup();
    const error = await failureOf(() =>
      migrateDb(f.ctx, { task: 'demo', yes: true }, { migrations: migrationsWith({ ...STEP_2, ...BROKEN_STEP_3 }) }),
    );
    expect(error.code).toBe('DB_ERROR');
    expect(migrationVersions(f.dbFile)).toEqual([1]);
    expect(auditOf(f)).toBe('');
    const g = setup();
    const before = snap(g.dir);
    for (const state of ['running', 'unmanaged-running'] as const) {
      const blocked = await failureOf(() =>
        migrateDb(
          g.ctx,
          { task: 'demo', yes: true },
          { migrations: migrationsWith(STEP_2), probe: () => Promise.resolve(probeResult(state)) },
        ),
      );
      expect(blocked.code).toBe('INSTANCE_RUNNING');
    }
    expect(snap(g.dir)).toBe(before);
  });
});

describe('db rebuild', () => {
  it('is a dry run without --yes: it lists the files and the consequences and moves nothing', async () => {
    const f = setup();
    const before = snap(f.dir);
    const result = await rebuildDb(f.ctx, { task: 'demo' });
    expect(result).toMatchObject({ applied: false, backup: null });
    expect(result.files.map((x) => x.path)).toEqual(['data/monitor.db']);
    const text = rebuildLines(result).join('\n');
    expect(text).toContain('moves into a db-rebuild backup: data/monitor.db');
    expect(text).toContain('lost: hook-only evidence');
    expect(text).toContain('run again with --yes --confirm demo to apply');
    expect(snap(f.dir)).toBe(before);
  });

  it('--yes without the right --confirm is CONFIRMATION_REQUIRED and changes nothing', async () => {
    const f = setup();
    const before = snap(f.dir);
    for (const confirm of [undefined, '', 'other', 'DEMO']) {
      const error = await failureOf(() =>
        rebuildDb(f.ctx, { task: 'demo', yes: true, ...(confirm === undefined ? {} : { confirm }) }),
      );
      expect(error.code).toBe('CONFIRMATION_REQUIRED');
      expect(error.hint).toBe('mcs db rebuild --task demo --yes --confirm demo');
    }
    // --confirm alone is still a dry run
    expect((await rebuildDb(f.ctx, { task: 'demo', confirm: 'demo' })).applied).toBe(false);
    expect(snap(f.dir)).toBe(before);
  });

  it.each(['running', 'starting', 'stopping', 'unhealthy', 'unmanaged-running'] as const)(
    'is refused for a %s instance',
    async (state) => {
      const f = setup();
      const before = snap(f.dir);
      const error = await failureOf(() =>
        rebuildDb(
          f.ctx,
          { task: 'demo', yes: true, confirm: 'demo' },
          { probe: () => Promise.resolve(probeResult(state)) },
        ),
      );
      expect(error.code).toBe('INSTANCE_RUNNING');
      expect(snap(f.dir)).toBe(before);
    },
  );

  it('moves the database files into a raw backup with a sha256 per file, records schema 0 and audits; restoring brings back the old database with its -wal', async () => {
    const f = setup();
    leaveStaleWal(f, 'only-in-the-wal');
    const original = new Map(
      ['monitor.db', 'monitor.db-wal'].map((name) => [name, readFileSync(join(f.dir, 'data', name))]),
    );
    const config = readFileSync(join(f.dir, 'config.json'));
    const result = await rebuildDb(f.ctx, { task: 'demo', yes: true, confirm: 'demo' });
    expect(result).toMatchObject({ applied: true, backup: '20261020T101500Z-db-rebuild' });
    expect(result.files.map((x) => x.path)).toEqual(['data/monitor.db', 'data/monitor.db-wal']);
    expect(readdirSync(join(f.dir, 'data')).filter((n) => n.startsWith('monitor.db'))).toEqual([]);
    const folder = join(f.backups, '20261020T101500Z-db-rebuild');
    const manifest = BackupManifestSchema.parse(JSON.parse(read(join(folder, 'manifest.json'))));
    expect(manifest).toMatchObject({ reason: 'db-rebuild', dbCopy: 'raw', dbSchemaVersion: 1, instanceId: ID });
    expect(manifest.files.map((x) => x.path)).toEqual([
      'monitor.db',
      'monitor.db-wal',
      'instance.json',
      'config.json',
      'task.json',
    ]);
    for (const entry of manifest.files) expect(sha(join(folder, entry.path))).toBe(entry.sha256);
    for (const [name, bytes] of original) expect(readFileSync(join(folder, name))).toEqual(bytes);
    expect(instanceOf(f).dbSchemaVersion).toBe(0);
    expect(readFileSync(join(f.dir, 'config.json'))).toEqual(config);
    const bytes = original.get('monitor.db')?.length ?? 0;
    const walBytes = original.get('monitor.db-wal')?.length ?? 0;
    expect(auditOf(f)).toContain(
      `- Summary: database moved to backup 20261020T101500Z-db-rebuild (${String(bytes + walBytes)} bytes); a new database is created at the next start`,
    );
    expect(auditOf(f)).toContain('- Files changed: data/monitor.db, instance.json');
    expect(auditOf(f)).toContain('- Validation: sha256 recorded for 5 files');
    expect(auditOf(f)).toContain('- Outcome: moved; backup 20261020T101500Z-db-rebuild');
    expect(rebuildLines(result)[0]).toContain('moved the database to data/backups/20261020T101500Z-db-rebuild/');
    // the old database comes back, including the rows that only its -wal held
    f.clock.advance(60_000);
    const restored = await restore(f.ctx, { task: 'demo', id: '20261020T101500Z-db-rebuild', yes: true });
    expect(restored.applied).toBe(true);
    expect(readFileSync(`${f.dbFile}-wal`)).toEqual(original.get('monitor.db-wal'));
    expect(readFileSync(f.dbFile)).toEqual(original.get('monitor.db'));
    expect(
      sqliteRows<{ project_key: string }>(f.dbFile, 'SELECT project_key FROM projects ORDER BY project_key').map(
        (r) => r.project_key,
      ),
    ).toEqual(['before-upgrade', 'only-in-the-wal']);
    expect(instanceOf(f).dbSchemaVersion).toBe(1);
    // the newest db-rebuild backup is never pruned
    const pre = (await listBackups(f.ws)).filter((b) => b.manifest.reason === 'pre-restore');
    expect(pre).toHaveLength(1);
    expect(pre[0]?.manifest.dbCopy).toBe('none');
  });

  it('reports a task without a database and moves nothing; a second rebuild after the first has nothing to move', async () => {
    const f = setup({ db: false });
    const before = snap(f.dir);
    const result = await rebuildDb(f.ctx, { task: 'demo', yes: true, confirm: 'demo' });
    expect(result).toMatchObject({ applied: false, files: [], backup: null });
    expect(rebuildLines(result)[0]).toContain('has no database');
    expect(snap(f.dir)).toBe(before);
    const g = setup();
    expect((await rebuildDb(g.ctx, { task: 'demo', yes: true, confirm: 'demo' })).applied).toBe(true);
    g.clock.advance(1000);
    const again = await rebuildDb(g.ctx, { task: 'demo', yes: true, confirm: 'demo' });
    expect(again.files).toEqual([]);
    expect(await listBackups(g.ws)).toHaveLength(1);
  });

  it('puts the files back when a move fails halfway and leaves no partial folder, no entry and instance.json unchanged', async () => {
    const f = setup();
    leaveStaleWal(f, 'only-in-the-wal');
    const dbBefore = readFileSync(f.dbFile);
    const walBefore = readFileSync(`${f.dbFile}-wal`);
    const instanceBefore = readFileSync(join(f.dir, 'instance.json'));
    const error = await failureOf(() =>
      rebuildDb(
        f.ctx,
        { task: 'demo', yes: true, confirm: 'demo' },
        {
          rename: (from, to) => {
            if (to.endsWith('monitor.db-wal'))
              return Promise.reject(new McsError('WORKSPACE_INVALID', 'cannot move monitor.db-wal: EPERM'));
            renameSync(from, to);
            return Promise.resolve();
          },
        },
      ),
    );
    expect(error.code).toBe('WORKSPACE_INVALID');
    expect(readFileSync(f.dbFile)).toEqual(dbBefore);
    expect(readFileSync(`${f.dbFile}-wal`)).toEqual(walBefore);
    expect(readdirSync(f.backups)).toEqual([]);
    expect(readFileSync(join(f.dir, 'instance.json'))).toEqual(instanceBefore);
    expect(auditOf(f)).toBe('');
  });

  it('moves a damaged database file as well: no SQLite is opened', async () => {
    const f = setup();
    writeFileSync(f.dbFile, 'this is not a database'.repeat(100));
    const result = await rebuildDb(f.ctx, { task: 'demo', yes: true, confirm: 'demo' });
    expect(result.applied).toBe(true);
    const [backup] = await listBackups(f.ws);
    // not a SQLite file: the schema version falls back to the mirror in instance.json
    expect(backup?.manifest).toMatchObject({ dbCopy: 'raw', dbSchemaVersion: 1 });
    expect(existsSync(f.dbFile)).toBe(false);
  });
});
