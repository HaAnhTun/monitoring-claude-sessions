// `upgrade` and `db migrate` through the built CLI on real processes (01 5.4, 5.7, ADR 0009, ADR 0021): T-UP-05 (a dry run writes
// nothing, the backup comes before the first database change, an injected failing migration restores the database), T-UP-06
// (`start` on an older database is refused, `upgrade --restart` migrates and runs), T-UP-07 (the downgrade matrix), the refusal of
// a workspace without `instance.json`, and the monitors this runtime did not start. The runtime of these tests is a bundle built
// from the current sources into a temp folder (never the tracked one), whose `migrations/` folder gets extra, test-only steps:
// the CLI and the server it starts both read that folder, so a database written at schema 1 is older than that runtime. Every
// call passes `--repo <temp repo>` and a port of the test range.
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  defaultMigrationsDir,
  defaultSkillDir,
  forceKill,
  RUNTIME_MUTABLE_PATHS,
  listRuntimeProcesses,
  openInstanceDb,
  openSqlite,
  waitForExit,
} from '@mcs/engine';
import {
  CliEnvelopeSchema,
  DbMigrateResultSchema,
  RUNTIME_VERSION,
  UpgradeResultSchema,
  type CliEnvelope,
} from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  buildRepo,
  buildTaskWorkspace,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  snapshotTree,
  spawnTracked,
  useTempDirs,
  waitFor,
} from '@mcs/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as bundleModule from '../../../scripts/bundle.mjs';

const { ENTRIES, buildBundle } = bundleModule as unknown as {
  ENTRIES: Record<string, string>;
  buildBundle: (opts: { outDir: string; entries?: Record<string, string>; web?: boolean }) => Promise<unknown>;
};

const makeTemp = useTempDirs();
const LF = String.fromCharCode(10);
const SLUG = 'demo';
const OLD = '3.0.0';
const WAL_AND_SHM = ['data/monitor.db-wal', 'data/monitor.db-shm'];

const STEP_2 = {
  '0002_probe_table.sql':
    "-- mcs:migration version=2 name=probe_table\nCREATE TABLE probe_table (id INTEGER PRIMARY KEY NOT NULL, note TEXT) STRICT;\nINSERT INTO probe_table (id, note) VALUES (1, 'migrated');\n",
};
const BROKEN_STEP_3 = {
  '0003_broken_step.sql':
    '-- mcs:migration version=3 name=broken_step\nCREATE TABLE half_done (id INTEGER PRIMARY KEY NOT NULL) STRICT;\nINSERT INTO no_such_table (id) VALUES (1);\n',
};

interface Install {
  readonly skillDir: string;
  readonly runtimeDir: string;
  readonly cliEntry: string;
}

interface Sandbox extends Install {
  readonly root: string;
  readonly repo: string;
  readonly ws: string;
  readonly env: Record<string, string>;
  /** The port of the task (`init --port`). */
  port: number;
}

const installs: Install[] = [];

/** A bundle of the current sources (CLI and server), built once for the file and copied for every sandbox. */
let template = '';

beforeAll(async () => {
  // outside the per-test temp folders of useTempDirs: it must outlive them
  template = mkdtempSync(path.join(tmpdir(), 'mcs-upgrade-bundle-'));
  await buildBundle({
    outDir: path.join(template, 'bundle'),
    entries: { 'mcs-cli': ENTRIES['mcs-cli'] ?? '', 'mcs-server': ENTRIES['mcs-server'] ?? '' },
    web: false,
  });
}, 120_000);

afterAll(() => {
  if (template !== '') rmSync(template, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * A skill folder shaped like an installed one: `bundle/` is a copy of the template bundle with a stub web folder and a
 * `migrations/` folder that holds the real files plus `extra`. The CLI and the server it starts both read that folder.
 */
function installRuntime(root: string, extra: Record<string, string>): Install {
  const skillDir = path.join(root, 'skill');
  const runtimeDir = path.join(skillDir, 'bundle');
  mkdirSync(path.join(skillDir, 'config'), { recursive: true });
  mkdirSync(path.join(skillDir, 'runtime'), { recursive: true });
  cpSync(path.join(template, 'bundle'), runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skillDir, 'config', 'defaults.json'));
  copyFileSync(
    path.join(defaultSkillDir(), 'runtime', 'defaults.json'),
    path.join(skillDir, 'runtime', 'defaults.json'),
  );
  mkdirSync(path.join(runtimeDir, 'web'), { recursive: true });
  writeFileSync(path.join(runtimeDir, 'web', 'index.html'), '<!doctype html><title>FIXTURE</title>');
  for (const [name, sql] of Object.entries(extra)) writeFileSync(path.join(runtimeDir, 'migrations', name), sql);
  const install = { skillDir, runtimeDir, cliEntry: path.join(runtimeDir, 'mcs-cli.mjs') };
  installs.push(install);
  return install;
}

function sandbox(purpose: string, extra: Record<string, string> = {}): Sandbox {
  const root = makeTemp(purpose).path;
  const { repo } = buildRepo(path.join(root, 'repo'));
  const install = installRuntime(root, extra);
  return {
    ...install,
    root,
    repo,
    ws: path.join(repo, '.claude', 'monitor', 'tasks', SLUG),
    env: hermeticEnv(root),
    port: 0,
  };
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI of the sandbox to its end; `--repo` is always passed. */
function mcs(sb: Sandbox, args: readonly string[], timeoutMs = 90_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const withPort = args[0] === 'start' && !args.includes('--port') ? [...args, '--port', String(sb.port)] : args;
    const child = spawn(process.execPath, [sb.cliEntry, ...withPort, '--repo', sb.repo], {
      cwd: sb.root,
      env: sb.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.once('error', (error) => {
      reject(new Error(`mcs ${args.join(' ')} did not finish within ${String(timeoutMs)} ms: ${error.message}`));
    });
    child.once('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function envelope(run: Run): CliEnvelope<unknown> {
  return CliEnvelopeSchema.parse(JSON.parse(run.stdout));
}

/** `init`, with a port, and an `instance.json` that an older runtime wrote. */
async function initOlderTask(sb: Sandbox, o: { runtimeVersion?: string } = {}): Promise<void> {
  sb.port = await allocatePort();
  const run = await mcs(sb, ['init', '--slug', SLUG, '--name', 'FIXTURE demo', '--port', String(sb.port)]);
  expect(run.code, run.stderr).toBe(0);
  const file = path.join(sb.ws, 'instance.json');
  const instance = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(
    file,
    `${JSON.stringify({ ...instance, runtimeVersion: o.runtimeVersion ?? OLD, createdBy: `mcs ${OLD}` }, null, 2)}\n`,
  );
}

function instanceOf(sb: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(sb.ws, 'instance.json'), 'utf8')) as Record<string, unknown>;
}

/** A schema-1 database for the task, written by the real engine with the migrations of the source tree (one file). */
function makeDatabase(sb: Sandbox, location: { migrationsDir?: URL } = {}): string {
  const instanceId = String(instanceOf(sb)['instanceId']);
  const file = path.join(sb.ws, 'data', 'monitor.db');
  mkdirSync(path.dirname(file), { recursive: true });
  const db = openInstanceDb({
    path: file,
    expectedInstanceId: instanceId,
    mode: 'serve',
    runtimeVersion: OLD,
    ...location,
  });
  db.driver
    .prepare('INSERT INTO projects (project_key, dir_name, first_seen_at, last_activity_at) VALUES (?, ?, 1, 1)')
    .run(['before-upgrade', 'P']);
  db.close();
  return file;
}

function versionsOf(file: string): number[] {
  const db = openSqlite(file, { readonly: true, fileMustExist: true, timeoutMs: 2000 });
  try {
    return db
      .prepare<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => row.version);
  } finally {
    db.close();
  }
}

/** The tree hash of the workspace; a read-only open of a WAL database leaves an empty `-wal` and a `-shm` (SQLite's own doing). */
const snap = (sb: Sandbox): string => snapshotTree(sb.ws, { exclude: WAL_AND_SHM });

function auditOf(sb: Sandbox): string {
  const file = path.join(sb.ws, 'audit', 'changes.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

afterEach(async () => {
  await killAllTracked();
  for (const install of installs.splice(0)) {
    for (const found of await listRuntimeProcesses(install.runtimeDir)) {
      await forceKill(found.pid);
      await waitForExit(found.pid, 5000);
    }
  }
});

describe('T-UP-05: upgrade changes nothing without --yes, backs up first, and undoes a failing migration', () => {
  it('prints the plan for a dry run (text and --json) without writing; --yes migrates after a verified backup', async () => {
    const sb = sandbox('up-apply', STEP_2);
    await initOlderTask(sb);
    const db = makeDatabase(sb);
    const before = snap(sb);

    const text = await mcs(sb, ['upgrade', '--task', SLUG]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain(`runtime: ${OLD} -> ${RUNTIME_VERSION}`);
    expect(text.stdout).toContain('database: schema 1 -> 2 (0002 probe_table)');
    expect(text.stdout).toContain('backup first: data/backups/');
    expect(text.stderr).toContain('warning: dry run; pass --yes to apply');
    const json = envelope(await mcs(sb, ['upgrade', '--task', SLUG, '--json', '--dry-run', '--yes']));
    expect(json).toMatchObject({ ok: true, command: 'upgrade', warnings: ['dry run; pass --yes to apply'] });
    expect(UpgradeResultSchema.parse(json.data)).toMatchObject({ outcome: 'dry-run', backup: null });
    expect(snap(sb)).toBe(before);
    expect(existsSync(path.join(sb.ws, 'data', 'backups'))).toBe(false);

    const applied = await mcs(sb, ['upgrade', '--task', SLUG, '--yes', '--json']);
    expect(applied.code, applied.stderr).toBe(0);
    const result = UpgradeResultSchema.parse(envelope(applied).data);
    expect(result).toMatchObject({ outcome: 'upgraded', integrity: 'ok', restart: null, exitCode: 0 });
    expect(versionsOf(db)).toEqual([1, 2]);
    expect(instanceOf(sb)).toMatchObject({ runtimeVersion: RUNTIME_VERSION, dbSchemaVersion: 2 });
    // the backup was written before the first database change (the files were not touched afterwards), and it verifies
    const folder = path.join(sb.ws, 'data', 'backups', result.backup ?? 'missing');
    expect(statSync(path.join(folder, 'manifest.json')).mtimeMs).toBeLessThanOrEqual(statSync(db).mtimeMs);
    expect(versionsOf(path.join(folder, 'monitor.db'))).toEqual([1]);
    const listed = envelope(await mcs(sb, ['backup', 'list', '--task', SLUG, '--verify', '--json']));
    expect(listed.data).toMatchObject({
      verify: true,
      backups: [{ id: result.backup, reason: 'upgrade', verified: true }],
    });
    expect(auditOf(sb)).toContain('| upgrade');
    expect(auditOf(sb)).toContain(`- Summary: runtime ${OLD} -> ${RUNTIME_VERSION}; db schema 1 -> 2; files: none`);

    const again = await mcs(sb, ['upgrade', '--task', SLUG, '--yes']);
    expect(again.code).toBe(0);
    expect(again.stdout.trim()).toBe(`already current: runtime ${RUNTIME_VERSION}, db schema 2`);
  }, 240_000);

  it('an injected failing migration restores the database from the backup, writes no upgrade entry and exits 1', async () => {
    const sb = sandbox('up-fail', { ...STEP_2, ...BROKEN_STEP_3 });
    await initOlderTask(sb);
    const db = makeDatabase(sb);
    const instanceBefore = readFileSync(path.join(sb.ws, 'instance.json'));
    const run = await mcs(sb, ['upgrade', '--task', SLUG, '--yes', '--json']);
    expect(run.code).toBe(1);
    const failed = envelope(run);
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe('DB_ERROR');
    expect(failed.error?.message).toContain('migration 3 (broken_step) failed');
    expect(failed.error?.message).toMatch(/restored from backup [0-9]{8}T[0-9]{6}Z-upgrade/u);
    // step 2 had committed before step 3 failed: only the restore takes it back
    expect(versionsOf(db)).toEqual([1]);
    expect(readFileSync(path.join(sb.ws, 'instance.json'))).toEqual(instanceBefore);
    expect(auditOf(sb)).not.toContain('| upgrade');
    const listed = envelope(await mcs(sb, ['backup', 'list', '--task', SLUG, '--verify', '--json']));
    expect(listed.data).toMatchObject({ backups: [{ reason: 'upgrade', verified: true }] });
  }, 240_000);
});

describe('T-UP-06: start refuses an older database, upgrade --restart migrates and runs', () => {
  it('start exits 1 naming DB_UPGRADE_REQUIRED, then upgrade --restart leaves a running server on the migrated database', async () => {
    const sb = sandbox('up-restart', STEP_2);
    await initOlderTask(sb);
    const db = makeDatabase(sb);
    const refused = await mcs(sb, ['start', '--task', SLUG, '--json']);
    expect(refused.code).toBe(1);
    expect(envelope(refused).error).toMatchObject({ code: 'DB_UPGRADE_REQUIRED' });
    expect(envelope(refused).error?.hint).toBe(`mcs upgrade --task ${SLUG} --restart`);
    expect(versionsOf(db)).toEqual([1]);

    const upgraded = await mcs(sb, ['upgrade', '--task', SLUG, '--yes', '--restart'], 150_000);
    expect(upgraded.code, upgraded.stderr).toBe(0);
    expect(upgraded.stdout).toContain(`started: http://127.0.0.1:${String(sb.port)}`);
    expect(upgraded.stdout).toContain('integrity: ok');
    await waitFor(async () => (await httpRequest(sb.port, '/api/v3/health')).status === 200, {
      what: 'the restarted server answers health',
      timeoutMs: 20_000,
      intervalMs: 100,
    });
    const stopped = await mcs(sb, ['stop', '--task', SLUG]);
    expect(stopped.code, stopped.stderr).toBe(0);
    await assertPortClosed(sb.port);
    expect(versionsOf(db)).toEqual([1, 2]);
    expect(instanceOf(sb)).toMatchObject({ runtimeVersion: RUNTIME_VERSION, dbSchemaVersion: 2 });
  }, 300_000);

  it('a running server is refused without --restart and stopped, upgraded and started again with it', async () => {
    const sb = sandbox('up-running', STEP_2);
    await initOlderTask(sb);
    const started = await mcs(sb, ['start', '--task', SLUG]);
    expect(started.code, started.stderr).toBe(0);
    // the server created its database at schema 2 itself; instance.json still names the older runtime, so there is a version
    // to record
    expect(instanceOf(sb)['runtimeVersion']).toBe(OLD);
    const before = snapshotTree(sb.ws, { exclude: RUNTIME_MUTABLE_PATHS });
    const refused = await mcs(sb, ['upgrade', '--task', SLUG, '--yes', '--json']);
    expect(refused.code).toBe(1);
    expect(envelope(refused).error).toMatchObject({ code: 'INSTANCE_RUNNING' });
    expect(snapshotTree(sb.ws, { exclude: RUNTIME_MUTABLE_PATHS })).toBe(before);
    const dry = await mcs(sb, ['upgrade', '--task', SLUG]);
    expect(dry.code, dry.stderr).toBe(0);
    const upgraded = await mcs(sb, ['upgrade', '--task', SLUG, '--yes', '--restart'], 150_000);
    expect(upgraded.code, upgraded.stderr).toBe(0);
    expect(upgraded.stdout).toContain('stopped the running server first');
    expect(upgraded.stdout).toContain(`started: http://127.0.0.1:${String(sb.port)}`);
    expect((await httpRequest(sb.port, '/api/v3/health')).status).toBe(200);
    expect((await mcs(sb, ['stop', '--task', SLUG])).code).toBe(0);
    await assertPortClosed(sb.port);
    expect(instanceOf(sb)['runtimeVersion']).toBe(RUNTIME_VERSION);
  }, 300_000);
});

describe('T-UP-07: the downgrade matrix (01 5.7)', () => {
  it('an instance.json from a newer runtime is DOWNGRADE_REFUSED, untouched; a database newer than the runtime is DB_NEWER_THAN_RUNTIME, untouched', async () => {
    const sb = sandbox('up-matrix');
    await initOlderTask(sb, { runtimeVersion: '9.9.9' });
    const db = makeDatabase(sb);
    const before = snap(sb);
    const downgrade = await mcs(sb, ['upgrade', '--task', SLUG, '--yes', '--json']);
    expect(downgrade.code).toBe(1);
    expect(envelope(downgrade).error?.code).toBe('DOWNGRADE_REFUSED');
    expect(snap(sb)).toBe(before);
    // the data commands that do not rewrite the version still work
    const migrate = await mcs(sb, ['db', 'migrate', '--task', SLUG, '--yes', '--json']);
    expect(migrate.code, migrate.stderr).toBe(0);
    expect(DbMigrateResultSchema.parse(envelope(migrate).data).outcome).toBe('current');

    // a database written by a runtime that ships one more step
    const newer = sandbox('up-matrix-newer');
    await initOlderTask(newer);
    const extra = path.join(newer.root, 'extra-migrations');
    mkdirSync(extra, { recursive: true });
    for (const name of readdirSync(fileURLToPath(defaultMigrationsDir()))) {
      copyFileSync(path.join(fileURLToPath(defaultMigrationsDir()), name), path.join(extra, name));
    }
    writeFileSync(path.join(extra, '0002_probe_table.sql'), STEP_2['0002_probe_table.sql']);
    const newerDb = makeDatabase(newer, { migrationsDir: pathToFileURL(extra + path.sep) });
    expect(versionsOf(newerDb)).toEqual([1, 2]);
    const bytes = readFileSync(newerDb);
    const beforeNewer = snap(newer);
    const refusals: string[][] = [
      ['upgrade', '--task', SLUG, '--yes'],
      ['db', 'migrate', '--task', SLUG, '--yes'],
      ['start', '--task', SLUG],
    ];
    for (const args of refusals) {
      const run = await mcs(newer, [...args, '--json']);
      expect(run.code, args.join(' ')).toBe(1);
      expect(envelope(run).error?.code, args.join(' ')).toBe('DB_NEWER_THAN_RUNTIME');
    }
    expect(readFileSync(newerDb)).toEqual(bytes);
    expect(snap(newer)).toBe(beforeNewer);
    expect(db).not.toBe(newerDb);
  }, 240_000);
});

describe('workspaces and monitors that upgrade must not touch', () => {
  it('a workspace without instance.json is INSTANCE_NOT_INITIALIZED with the migrate-workspace hint, for every command, and is never written', async () => {
    const sb = sandbox('up-pre-v4');
    buildTaskWorkspace(sb.repo, { slug: SLUG, config: { title: 'FIXTURE pre-4.0' } });
    const before = snapshotTree(sb.ws);
    const commands: string[][] = [
      ['upgrade', '--yes'],
      ['db', 'migrate', '--yes'],
      ['db', 'rebuild', '--yes', '--confirm', SLUG],
      ['backup'],
      ['backup', 'restore', '--id', '20261019T101500Z-manual', '--yes'],
    ];
    for (const words of commands) {
      const head = words[0] === 'db' || (words[0] === 'backup' && words[1] === 'restore') ? 2 : 1;
      const run = await mcs(sb, [...words.slice(0, head), '--task', SLUG, ...words.slice(head), '--json']);
      expect(run.code, words.join(' ')).toBe(1);
      const error = envelope(run).error;
      expect(error?.code, words.join(' ')).toBe('INSTANCE_NOT_INITIALIZED');
      expect(error?.hint, words.join(' ')).toContain(`mcs migrate-workspace --task ${SLUG}`);
    }
    expect(snapshotTree(sb.ws)).toBe(before);
    expect(existsSync(path.join(sb.ws, 'instance.json'))).toBe(false);
  }, 240_000);

  it('a monitor that this runtime did not start blocks upgrade, db migrate, db rebuild and backup restore like a running one', async () => {
    const sb = sandbox('up-unmanaged', STEP_2);
    await initOlderTask(sb);
    const db = makeDatabase(sb);
    // a backup to restore, made while nothing runs
    const made = envelope(await mcs(sb, ['backup', '--task', SLUG, '--json']));
    const backupId = (made.data as { id: string }).id;
    const viewer = spawnTracked(process.execPath, [
      '-e',
      [
        "const http = require('node:http');",
        'http.createServer((req, res) => {',
        "  res.setHeader('Content-Type', 'application/json');",
        '  res.end(JSON.stringify({ ok: true, pid: process.pid }));',
        `}).listen(${String(sb.port)}, '127.0.0.1');`,
        'setInterval(() => undefined, 60000);',
      ].join(LF),
    ]);
    await waitFor(async () => (await httpRequest(sb.port, '/api/health').catch(() => ({ status: 0 }))).status === 200, {
      what: 'the stand-in monitor answers /api/health',
      timeoutMs: 30_000,
      intervalMs: 100,
    });
    writeFileSync(
      path.join(sb.ws, 'state.json'),
      JSON.stringify(
        {
          pid: viewer.pid,
          url: `http://127.0.0.1:${String(sb.port)}`,
          port: sb.port,
          started: 1_700_000_000.5,
          version: '2.9.0',
          task: SLUG,
          config: null,
        },
        null,
        2,
      ),
    );
    const before = snap(sb);
    const bytes = readFileSync(db);
    const attempts: string[][] = [
      ['upgrade', '--task', SLUG, '--yes', '--restart'],
      ['db', 'migrate', '--task', SLUG, '--yes'],
      ['db', 'rebuild', '--task', SLUG, '--yes', '--confirm', SLUG],
      ['backup', 'restore', '--task', SLUG, '--id', backupId, '--yes'],
    ];
    for (const args of attempts) {
      const run = await mcs(sb, [...args, '--json']);
      expect(run.code, args.join(' ')).toBe(1);
      expect(envelope(run).error?.code, args.join(' ')).toBe('INSTANCE_RUNNING');
      expect(envelope(run).error?.message, args.join(' ')).toContain('not started by this runtime');
    }
    // the dry runs still show their plans
    expect((await mcs(sb, ['upgrade', '--task', SLUG])).code).toBe(0);
    expect(snap(sb)).toBe(before);
    expect(readFileSync(db)).toEqual(bytes);
  }, 240_000);
});

describe('db migrate', () => {
  it('is a dry run without --yes, then migrates after a backup and leaves the runtime version of instance.json alone', async () => {
    const sb = sandbox('migrate', STEP_2);
    await initOlderTask(sb);
    const db = makeDatabase(sb);
    const before = snap(sb);
    const dry = await mcs(sb, ['db', 'migrate', '--task', SLUG]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('db migrate plan (dry run, nothing written)');
    expect(dry.stderr).toContain('warning: dry run; pass --yes to apply');
    expect(snap(sb)).toBe(before);
    const applied = await mcs(sb, ['db', 'migrate', '--task', SLUG, '--yes', '--json']);
    expect(applied.code, applied.stderr).toBe(0);
    expect(DbMigrateResultSchema.parse(envelope(applied).data)).toMatchObject({ outcome: 'migrated', integrity: 'ok' });
    expect(versionsOf(db)).toEqual([1, 2]);
    expect(instanceOf(sb)).toMatchObject({ runtimeVersion: OLD, dbSchemaVersion: 2 });
    expect(auditOf(sb)).toContain('| db-migrate');
    const again = await mcs(sb, ['db', 'migrate', '--task', SLUG, '--yes']);
    expect(again.stdout.trim()).toBe('already current: db schema 2');
  }, 240_000);
});

describe('a migration that is killed in the middle', () => {
  // step 2 is quick, step 3 is slow: the kill lands somewhere between the backup and the end, and every place is legal
  const SLOW_STEPS = {
    ...STEP_2,
    '0003_slow_table.sql': [
      '-- mcs:migration version=3 name=slow_table',
      'CREATE TABLE slow_table (id INTEGER PRIMARY KEY NOT NULL) STRICT;',
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000)',
      'INSERT INTO slow_table (id) SELECT x FROM c;',
      '',
    ].join(LF),
  };

  it('leaves a whole database at a finished version and an intact backup; running it again finishes the job', async () => {
    const sb = sandbox('up-killed', SLOW_STEPS);
    await initOlderTask(sb);
    const db = makeDatabase(sb);
    const backups = path.join(sb.ws, 'data', 'backups');
    const child = spawnTracked(
      process.execPath,
      [sb.cliEntry, 'db', 'migrate', '--task', SLUG, '--yes', '--repo', sb.repo],
      { env: sb.env },
    );
    // the backup folder gets its final name only when its manifest is written: kill as soon as it is there
    await waitFor(
      () =>
        existsSync(backups) &&
        readdirSync(backups).some(
          (name) => name.endsWith('-upgrade') && existsSync(path.join(backups, name, 'manifest.json')),
        ),
      { what: 'the upgrade backup to be complete', timeoutMs: 60_000, intervalMs: 5 },
    );
    child.kill();
    await child.exited;

    const check = openSqlite(db, { readonly: true, fileMustExist: true, timeoutMs: 5000 });
    try {
      expect(check.prepare<{ integrity_check: string }>('PRAGMA integrity_check').all()).toEqual([
        { integrity_check: 'ok' },
      ]);
      const userVersion = check.prepare<{ user_version: number }>('PRAGMA user_version').get()?.user_version;
      const applied = check
        .prepare<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => row.version);
      // the last finished version, and nothing in between: a step is one transaction
      expect(applied).toEqual(Array.from({ length: applied.length }, (_, i) => i + 1));
      expect(userVersion).toBe(applied.at(-1));
      expect(check.prepare<{ project_key: string }>('SELECT project_key FROM projects').all()).toEqual([
        { project_key: 'before-upgrade' },
      ]);
    } finally {
      check.close();
    }
    // the backup is whole, and the audit trail has no entry of a migration that did not finish
    const listed = await mcs(sb, ['backup', 'list', '--task', SLUG, '--verify', '--json']);
    expect(listed.code, listed.stdout + listed.stderr).toBe(0);
    expect(listed.stdout).toContain('"verified": true');
    expect(auditOf(sb)).not.toContain('| db-migrate');
    expect(readdirSync(backups).filter((name) => name.endsWith('.partial'))).toEqual([]);

    const again = await mcs(sb, ['db', 'migrate', '--task', SLUG, '--yes', '--json'], 150_000);
    expect(again.code, again.stdout + again.stderr).toBe(0);
    expect(versionsOf(db)).toEqual([1, 2, 3]);
    expect(instanceOf(sb)).toMatchObject({ dbSchemaVersion: 3 });
    expect(auditOf(sb)).toContain('| db-migrate');
  }, 240_000);
});
