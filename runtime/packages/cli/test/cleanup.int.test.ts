// `cleanup` through the built CLI on real processes (01 6.4, T-CLI-06, ADR 0009): every scope is a dry run until `--yes`, the data
// scope needs the typed task name, a running monitor blocks `spool` and `data` and keeps its state file, a state file that names a
// live impostor is a stale one, links are skipped and their targets stay, and the result is the `CleanupResult` of the envelope.
// Every call passes `--repo <temp repo>`; ports come from the test range; the databases are real SQLite files of temp folders.
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RUNTIME_MUTABLE_PATHS, openInstanceDb } from '@mcs/engine';
import { CleanupResultSchema, CliEnvelopeSchema, RUNTIME_VERSION, type CleanupResult } from '@mcs/shared';
import {
  allocatePort,
  buildRepo,
  hermeticEnv,
  killAllTracked,
  makeJunction,
  runCli,
  snapshotTree,
  spawnImpostor,
  startInstance,
  useTempDirs,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const SLUG = 'demo';
const DAY = 86_400_000;

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly tasks: string;
  readonly ws: string;
  readonly env: Record<string, string>;
  mcs(args: readonly string[]): Promise<Run>;
}

function sandbox(purpose: string): Sandbox {
  const root = makeTemp(purpose).path;
  const { repo } = buildRepo(join(root, 'repo'));
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  const tasks = join(repo, '.claude', 'monitor', 'tasks');
  return {
    root,
    repo,
    tasks,
    ws: join(tasks, SLUG),
    env,
    mcs: (args) => runCli([...args, '--repo', repo], { mcsHome, env }),
  };
}

afterEach(async () => {
  await killAllTracked();
});

function envelope(run: Run): ReturnType<typeof CliEnvelopeSchema.parse> {
  return CliEnvelopeSchema.parse(JSON.parse(run.stdout));
}

function resultOf(run: Run): CleanupResult {
  expect(run.code, run.stderr || run.stdout).toBe(0);
  return CleanupResultSchema.parse(envelope(run).data);
}

async function initTask(sb: Sandbox, slug = SLUG, port?: number): Promise<void> {
  const run = await sb.mcs([
    'init',
    '--slug',
    slug,
    '--name',
    `FIXTURE ${slug}`,
    ...(port === undefined ? [] : ['--port', String(port)]),
  ]);
  expect(run.code, run.stderr).toBe(0);
}

function instanceId(sb: Sandbox): string {
  return (JSON.parse(readFileSync(join(sb.ws, 'instance.json'), 'utf8')) as { instanceId: string }).instanceId;
}

/** A schema-1 database written by the real engine, with sessions of the given ages in days. */
function makeDatabase(sb: Sandbox, ages: readonly number[] = []): string {
  const file = join(sb.ws, 'data', 'monitor.db');
  mkdirSync(join(sb.ws, 'data'), { recursive: true });
  const db = openInstanceDb({ path: file, expectedInstanceId: instanceId(sb), mode: 'serve', runtimeVersion: '4.0.0' });
  ages.forEach((age, index) => {
    const at = Date.now() - age * DAY;
    db.driver
      .prepare(
        `INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at, state)
         VALUES (:uid, :at, :at, :at, :at, 'completed')`,
      )
      .run({ uid: `dddddddd-0000-4000-8000-${String(index).padStart(12, '0')}`, at });
  });
  db.close();
  return file;
}

function sessionCount(sb: Sandbox): number {
  const db = openInstanceDb({
    path: join(sb.ws, 'data', 'monitor.db'),
    expectedInstanceId: instanceId(sb),
    mode: 'readonly',
    runtimeVersion: '4.0.0',
  });
  try {
    return db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM sessions').get()?.n ?? 0;
  } finally {
    db.close();
  }
}

function age(file: string, days: number): string {
  mkdirSync(join(file, '..'), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, 'x');
  const when = new Date(Date.now() - days * DAY);
  utimesSync(file, when, when);
  return file;
}

const auditOf = (sb: Sandbox): string => {
  const file = join(sb.ws, 'audit', 'changes.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

/** A `state.json` that names `pid` and `port`, as a crashed monitor (or a reused pid) leaves it. */
function writeState(sb: Sandbox, pid: number, port: number): Buffer {
  const state = {
    pid,
    url: `http://127.0.0.1:${String(port)}`,
    port,
    started: 1_700_000_000.5,
    version: RUNTIME_VERSION,
    task: SLUG,
    config: null,
    schema_version: 1,
    engine: 'node',
    instanceId: instanceId(sb),
    runtimeVersion: RUNTIME_VERSION,
    codeStamp: 'abcdef0123',
  };
  const file = join(sb.ws, 'state.json');
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return readFileSync(file);
}

const SNAPSHOT_OPTIONS = { exclude: ['data/monitor.db-wal', 'data/monitor.db-shm'] };

describe('T-CLI-06: every scope is a dry run without --yes', () => {
  it('lists the targets with relative paths, counts and bytes and changes nothing, for each of the six scopes', async () => {
    const sb = sandbox('cleanup-dry');
    await initTask(sb);
    makeDatabase(sb, [100, 90, 1]);
    age(join(sb.ws, 'logs', 'runtime.log.1'), 60);
    age(join(sb.ws, 'instance.json.1.aa.tmp'), 1);
    age(join(sb.tasks, '.init-demo-99999999-abcdef01', 'task.json'), 1);
    utimesSync(join(sb.tasks, '.init-demo-99999999-abcdef01'), new Date(Date.now() - DAY), new Date(Date.now() - DAY));
    expect((await sb.mcs(['backup', '--task', SLUG])).code).toBe(0);
    expect((await sb.mcs(['backup', '--task', SLUG])).code).toBe(0);
    const before = snapshotTree(sb.tasks, SNAPSHOT_OPTIONS);

    const expectations: [string[], number][] = [
      [['--scope', 'stale-state', '--task', SLUG], 1],
      [['--scope', 'init-leftovers'], 1],
      [['--scope', 'logs', '--task', SLUG], 1],
      [['--scope', 'backups', '--task', SLUG, '--keep', '1'], 1],
      [['--scope', 'spool', '--task', SLUG], 0],
      [['--scope', 'data', '--task', SLUG, '--older-than', '30'], 2],
    ];
    for (const [args, count] of expectations) {
      const run = await sb.mcs(['cleanup', ...args, '--json']);
      const result = resultOf(run);
      expect(result.applied, args.join(' ')).toBe(false);
      expect(result.count, args.join(' ')).toBe(count);
      for (const target of result.targets) {
        expect(target.path).not.toMatch(/^[A-Za-z]:|^\//u);
        expect(target.bytes).toBeGreaterThanOrEqual(0);
      }
      if (count > 0) expect(envelope(run).warnings[0]).toContain('dry run; pass --yes');
    }
    // text mode names the way forward
    const text = await sb.mcs(['cleanup', '--scope', 'logs', '--task', SLUG]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('logs/runtime.log.1');
    expect(text.stderr).toContain('warning: dry run; pass --yes to apply');
    expect(snapshotTree(sb.tasks, SNAPSHOT_OPTIONS)).toBe(before);
  }, 120_000);

  it('the data scope needs the typed task name: nothing is backed up or deleted without it, in any other letter case', async () => {
    const sb = sandbox('cleanup-confirm');
    await initTask(sb);
    const db = makeDatabase(sb, [100]);
    const before = snapshotTree(sb.tasks, SNAPSHOT_OPTIONS);
    for (const confirm of [undefined, 'DEMO', 'Demo', 'demo ', 'other']) {
      const run = await sb.mcs([
        'cleanup',
        '--scope',
        'data',
        '--task',
        SLUG,
        '--older-than',
        '30',
        '--yes',
        ...(confirm === undefined ? [] : ['--confirm', confirm]),
        '--json',
      ]);
      expect(run.code, String(confirm)).toBe(1);
      expect(envelope(run).error?.code, String(confirm)).toBe('CONFIRMATION_REQUIRED');
    }
    expect(existsSync(join(sb.ws, 'data', 'backups'))).toBe(false);
    expect(snapshotTree(sb.tasks, SNAPSHOT_OPTIONS)).toBe(before);
    expect(existsSync(db)).toBe(true);
  });

  it('usage errors exit 2: no scope, an unknown scope, a task for init-leftovers, no task for the others, bad numbers', async () => {
    const sb = sandbox('cleanup-usage');
    await initTask(sb);
    for (const args of [
      ['cleanup'],
      ['cleanup', '--scope', 'everything', '--task', SLUG],
      ['cleanup', '--scope', 'init-leftovers', '--task', SLUG],
      ['cleanup', '--scope', 'logs'],
      ['cleanup', '--scope', 'logs', '--task', SLUG, '--older-than', '0'],
      ['cleanup', '--scope', 'logs', '--task', SLUG, '--older-than', 'soon'],
      ['cleanup', '--scope', 'backups', '--task', SLUG, '--keep', '-1'],
      ['cleanup', '--scope', 'logs', '--task', SLUG, '--keep', '1'],
      ['cleanup', '--scope', 'stale-state', '--task', SLUG, '--older-than', '3'],
    ]) {
      const run = await sb.mcs([...args, '--json']);
      expect(run.code, args.join(' ')).toBe(2);
      expect(envelope(run).error?.code, args.join(' ')).toBe('USAGE');
    }
    const missing = await sb.mcs(['cleanup', '--scope', 'logs', '--task', 'nope', '--json']);
    expect(missing.code).toBe(1);
    expect(envelope(missing).error?.code).toBe('TASK_NOT_FOUND');
  });
});

describe('cleanup --scope logs and backups', () => {
  it('deletes rotated logs older than the age, leaves the live log and a link out of the workspace, audits the run', async () => {
    const sb = sandbox('cleanup-logs');
    await initTask(sb);
    const decoy = makeTemp('decoy').path;
    const canary = join(decoy, 'canary.txt');
    writeFileSync(canary, 'canary');
    const logs = join(sb.ws, 'logs');
    age(join(logs, 'runtime.log.1'), 40);
    age(join(logs, 'diagnostics-20260901T100000Z.json'), 40);
    const live = age(join(logs, 'runtime.log'), 400);
    const young = age(join(logs, 'runtime.log.2'), 2);
    makeJunction(join(logs, 'runtime.log.9'), decoy);

    const run = await sb.mcs(['cleanup', '--scope', 'logs', '--task', SLUG, '--yes', '--json']);
    const result = resultOf(run);
    expect(result).toMatchObject({ applied: true, count: 2, remaining: [], backup: null });
    expect(result.targets.map((t) => t.path).sort()).toEqual([
      'logs/diagnostics-20260901T100000Z.json',
      'logs/runtime.log.1',
    ]);
    expect(result.skipped.map((s) => s.path)).toEqual(['logs/runtime.log.9']);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(young)).toBe(true);
    expect(readFileSync(canary, 'utf8')).toBe('canary');
    expect(readdirSync(logs).sort()).toEqual(['runtime.log', 'runtime.log.2', 'runtime.log.9']);
    expect(auditOf(sb)).toContain('| cleanup');
    expect(auditOf(sb)).toContain('logs: deleted 2 files');

    // repeated: nothing to do, nothing more audited
    const again = resultOf(await sb.mcs(['cleanup', '--scope', 'logs', '--task', SLUG, '--yes', '--json']));
    expect(again.count).toBe(0);
    expect(auditOf(sb).match(/\| cleanup/gu)).toHaveLength(1);
    // the workspace itself is never a target
    for (const name of ['task.json', 'config.json', 'instance.json']) expect(existsSync(join(sb.ws, name))).toBe(true);
  }, 120_000);

  it('removes the oldest backups beyond --keep, keeps the unfinished ones, and the rest still restores', async () => {
    const sb = sandbox('cleanup-backups');
    await initTask(sb);
    makeDatabase(sb, [1]);
    const made: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await sb.mcs(['backup', '--task', SLUG, '--json']);
      expect(run.code, run.stderr).toBe(0);
      made.push((envelope(run).data as { id: string }).id);
    }
    const partial = join(sb.ws, 'data', 'backups', '20260101T000000Z-manual.partial');
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'monitor.db'), 'half a backup');
    const result = resultOf(
      await sb.mcs(['cleanup', '--scope', 'backups', '--task', SLUG, '--keep', '1', '--yes', '--json']),
    );
    expect(result.targets.map((t) => t.path)).toEqual(made.slice(0, 2).map((id) => `data/backups/${id}`));
    expect(readdirSync(join(sb.ws, 'data', 'backups')).sort()).toEqual(
      [made[2] ?? '', '20260101T000000Z-manual.partial'].sort(),
    );
    expect(readFileSync(join(partial, 'monitor.db'), 'utf8')).toBe('half a backup');
    expect(result.skipped.map((s) => s.path)).toContain('data/backups/20260101T000000Z-manual.partial');
    const listed = await sb.mcs(['backup', 'list', '--task', SLUG, '--verify', '--json']);
    expect(listed.code, listed.stderr).toBe(0);
    expect((envelope(listed).data as { backups: { id: string; verified: boolean }[] }).backups).toMatchObject([
      { id: made[2], verified: true },
    ]);
  }, 120_000);
});

describe('cleanup --scope stale-state and init-leftovers', () => {
  it('removes a state file whose process is gone, and one that names a live impostor, and kills nothing', async () => {
    const sb = sandbox('cleanup-stale');
    await initTask(sb);
    // a pid that has exited
    const gone = spawnImpostor(['FIXTURE-gone']);
    const gonePid = gone.pid;
    gone.kill();
    await gone.exited;
    writeState(sb, gonePid, 18999);
    const dry = resultOf(await sb.mcs(['cleanup', '--scope', 'stale-state', '--task', SLUG, '--json']));
    expect(dry.targets.map((t) => t.path)).toEqual(['state.json']);
    expect(existsSync(join(sb.ws, 'state.json'))).toBe(true);
    const done = resultOf(await sb.mcs(['cleanup', '--scope', 'stale-state', '--task', SLUG, '--yes', '--json']));
    expect(done).toMatchObject({ applied: true, count: 1, remaining: [] });
    expect(existsSync(join(sb.ws, 'state.json'))).toBe(false);

    // a live process that is not this instance: the state file is stale, the process is left alone
    const impostor = spawnImpostor(['FIXTURE-impostor']);
    writeState(sb, impostor.pid, 18998);
    const second = resultOf(await sb.mcs(['cleanup', '--scope', 'stale-state', '--task', SLUG, '--yes', '--json']));
    expect(second.targets.map((t) => t.path)).toEqual(['state.json']);
    expect(existsSync(join(sb.ws, 'state.json'))).toBe(false);
    expect(() => process.kill(impostor.pid, 0)).not.toThrow();
    expect(auditOf(sb)).not.toContain('| cleanup');
  }, 120_000);

  it('removes dead staging folders of the tasks root, with --repo only, and nothing else', async () => {
    const sb = sandbox('cleanup-staging');
    await initTask(sb);
    const staging = join(sb.tasks, '.init-demo-99999999-abcdef01');
    age(join(staging, 'task.json'), 1);
    utimesSync(staging, new Date(Date.now() - DAY), new Date(Date.now() - DAY));
    const run = await sb.mcs(['cleanup', '--scope', 'init-leftovers', '--yes', '--json']);
    const result = resultOf(run);
    expect(result).toMatchObject({ task: null, scope: 'init-leftovers', applied: true, count: 1, remaining: [] });
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(sb.ws)).toBe(true);
  });
});

describe('cleanup --scope spool and data on a running monitor and on a stopped one', () => {
  it('a running monitor blocks spool and data (also a dry run) and keeps its state file, token and database', async () => {
    const sb = sandbox('cleanup-running');
    const port = await allocatePort();
    await initTask(sb, SLUG, port);
    const running = await startInstance({ repo: sb.repo, slug: SLUG, env: sb.env }, { port });
    const state = readFileSync(join(sb.ws, 'state.json'));
    const before = snapshotTree(sb.tasks, { exclude: RUNTIME_MUTABLE_PATHS });

    for (const args of [
      ['--scope', 'spool'],
      ['--scope', 'spool', '--yes'],
      ['--scope', 'data', '--older-than', '1'],
      ['--scope', 'data', '--older-than', '1', '--yes', '--confirm', SLUG],
    ]) {
      const run = await sb.mcs(['cleanup', '--task', SLUG, ...args, '--json']);
      expect(run.code, args.join(' ')).toBe(1);
      expect(envelope(run).error?.code, args.join(' ')).toBe('INSTANCE_RUNNING');
    }
    const stale = resultOf(await sb.mcs(['cleanup', '--scope', 'stale-state', '--task', SLUG, '--yes', '--json']));
    expect(stale.targets).toEqual([]);
    expect(stale.skipped.map((s) => s.path)).toContain('state.json');
    expect(readFileSync(join(sb.ws, 'state.json')).equals(state)).toBe(true);
    expect(existsSync(join(sb.ws, 'run', 'control.token'))).toBe(true);
    expect(snapshotTree(sb.tasks, { exclude: RUNTIME_MUTABLE_PATHS })).toBe(before);
    await running.stop();
  }, 180_000);

  it('data on a stopped instance: backup first, old sessions deleted, recent ones kept, audit written', async () => {
    const sb = sandbox('cleanup-data');
    await initTask(sb);
    const db = makeDatabase(sb, [100, 90, 1]);
    const dry = resultOf(await sb.mcs(['cleanup', '--scope', 'data', '--task', SLUG, '--older-than', '30', '--json']));
    expect(dry).toMatchObject({ applied: false, count: 2, backup: null });
    expect(dry.data?.sessions).toBe(2);
    expect(sessionCount(sb)).toBe(3);
    expect(existsSync(join(sb.ws, 'data', 'backups'))).toBe(false);

    const run = await sb.mcs([
      'cleanup',
      '--scope',
      'data',
      '--task',
      SLUG,
      '--older-than',
      '30',
      '--yes',
      '--confirm',
      SLUG,
      '--json',
    ]);
    const result = resultOf(run);
    expect(result).toMatchObject({ applied: true, count: 2, data: { sessions: 2 } });
    expect(result.backup).toMatch(/-cleanup$/u);
    const manifest = JSON.parse(
      readFileSync(join(sb.ws, 'data', 'backups', result.backup ?? '', 'manifest.json'), 'utf8'),
    ) as { reason: string; dbCopy: string };
    expect(manifest).toMatchObject({ reason: 'cleanup', dbCopy: 'online' });
    expect(auditOf(sb)).toContain('data: deleted 2 sessions');
    // the database is still a database the CLI can back up again, and keeps the recent session
    expect(existsSync(db)).toBe(true);
    const listed = await sb.mcs(['backup', 'list', '--task', SLUG, '--verify', '--json']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(sessionCount(sb)).toBe(1);
  }, 120_000);
});
