// `db rebuild` through the built CLI on a real instance (T-CLI-12, 01 5.4, ADR 0009): refused while the server runs and without
// `--confirm <slug>`; applied, the database files are moved into a `db-rebuild` backup (`dbCopy: 'raw'`, sha256 per file),
// `instance.json` records schema 0, the audit trail says `db-rebuild`; the next `start` creates a new database and imports
// the transcripts again (the same sessions, and `cost_states` derived again); `backup restore` of that backup brings the old
// database back, including its `-wal` when the server was killed with data that only the WAL held. Every call passes
// `--repo <temp repo>` and a port of the test range; the transcripts are synthetic.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { forceKill, openSqlite, waitForExit } from '@mcs/engine';
import { BackupManifestSchema, CliEnvelopeSchema, DbRebuildResultSchema, type CliEnvelope } from '@mcs/shared';
import {
  allocatePort,
  buildClaudeHome,
  buildRepo,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  runCli,
  startInstance,
  useTempDirs,
  waitFor,
  type StartedInstance,
  type TranscriptBuilder,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const SLUG = 'demo';
const PROJECT = '-FIXTURE-rebuild-project';
/** FIXTURE ids: uuid-shaped and obviously synthetic. */
const SESSION_A = 'f1f1f1f1-0000-4000-8000-0000000000a1';
const SESSION_B = 'f1f1f1f1-0000-4000-8000-0000000000b2';
const USAGE = { input_tokens: 11, output_tokens: 60, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };

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
  readonly db: string;
  readonly port: number;
  mcs(args: readonly string[]): Promise<Run>;
  start(): Promise<StartedInstance>;
}

afterEach(async () => {
  await killAllTracked();
});

function envelope(run: Run): CliEnvelope<unknown> {
  return CliEnvelopeSchema.parse(JSON.parse(run.stdout));
}

/** An initialised task whose transcripts folder holds two synthetic sessions (A ends in a cost-state record). */
async function sandbox(purpose: string): Promise<Sandbox> {
  const root = makeTemp(purpose).path;
  const { repo } = buildRepo(join(root, 'repo'));
  const env = hermeticEnv(root);
  const claudeHome = env['CLAUDE_CONFIG_DIR'] ?? join(root, 'claude-home');
  const nowMs = Date.now();
  buildClaudeHome(claudeHome, {
    nowMs,
    sessions: [
      {
        id: SESSION_A,
        project: PROJECT,
        mtimeAgeMs: 10 * 60_000,
        build: (b: TranscriptBuilder) => {
          b.user('FIXTURE rebuild alpha');
          b.assistant({ messageId: 'msg_fixture_rebuild_a', usage: USAGE, stop: 'end_turn' });
          b.bookkeeping('cost-state');
        },
      },
      {
        id: SESSION_B,
        project: PROJECT,
        mtimeAgeMs: 20 * 60_000,
        build: (b: TranscriptBuilder) => {
          b.user('FIXTURE rebuild beta');
          b.assistant({ messageId: 'msg_fixture_rebuild_b', usage: USAGE, stop: 'end_turn' });
          b.turnEnd();
        },
      },
    ],
  });
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  const mcs = (args: readonly string[]): Promise<Run> => runCli([...args, '--repo', repo], { mcsHome, env });
  const port = await allocatePort();
  const init = await mcs(['init', '--slug', SLUG, '--name', 'FIXTURE demo', '--port', String(port)]);
  expect(init.code, init.stderr).toBe(0);
  const configured = await mcs([
    'configure',
    '--task',
    SLUG,
    '--set',
    `transcripts_dir=${JSON.stringify(join(claudeHome, 'projects', PROJECT))}`,
    '--set',
    `session_rules=${JSON.stringify([
      { match: 'FIXTURE rebuild alpha', label: 'Rebuild alpha' },
      { match: 'FIXTURE rebuild beta', label: 'Rebuild beta' },
    ])}`,
  ]);
  expect(configured.code, configured.stderr).toBe(0);
  const ws = join(repo, '.claude', 'monitor', 'tasks', SLUG);
  return {
    root,
    repo,
    ws,
    env,
    db: join(ws, 'data', 'monitor.db'),
    port,
    mcs,
    start: () => startInstance({ repo, slug: SLUG, env }, { port }),
  };
}

/** Both sessions are listed and no transcript file is behind: the importer is done. */
async function waitImported(sb: Sandbox): Promise<void> {
  const get = async (path: string): Promise<{ status: number; body: unknown }> => {
    const reply = await httpRequest(sb.port, path);
    try {
      return { status: reply.status, body: JSON.parse(reply.body) as unknown };
    } catch {
      return { status: reply.status, body: reply.body };
    }
  };
  await waitFor(
    async () => {
      for (const id of [SESSION_A, SESSION_B]) {
        const reply = await get(`/api/v3/sessions/${id}`);
        if (reply.status !== 200) return false;
        const files = (reply.body as { files?: { behindBytes: number; state: string }[] }).files ?? [];
        if (files.length === 0 || files.some((f) => f.behindBytes !== 0 || f.state !== 'active')) return false;
      }
      return true;
    },
    { what: 'both fixture sessions imported', timeoutMs: 60_000, intervalMs: 200 },
  );
}

interface Counts {
  readonly sessions: number;
  readonly events: number;
  readonly costStates: number;
}

function countsOf(file: string): Counts {
  const db = openSqlite(file, { readonly: true, fileMustExist: true, timeoutMs: 2000 });
  try {
    const n = (table: string): number => db.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
    return { sessions: n('sessions'), events: n('events'), costStates: n('cost_states') };
  } finally {
    db.close();
  }
}

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const dbFilesIn = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith('monitor.db'));

describe('T-CLI-12: db rebuild', () => {
  it('is refused while running and without --confirm; applied it moves the database into a raw backup, the next start imports again, a restore brings the old database back', async () => {
    const sb = await sandbox('rebuild-flow');
    const running = await sb.start();
    await waitImported(sb);

    // refused while the server runs; the dry run still prints the plan
    const refused = await sb.mcs(['db', 'rebuild', '--task', SLUG, '--yes', '--confirm', SLUG, '--json']);
    expect(refused.code).toBe(1);
    expect(envelope(refused).error?.code).toBe('INSTANCE_RUNNING');
    const plan = await sb.mcs(['db', 'rebuild', '--task', SLUG]);
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.stdout).toContain('data/monitor.db');
    await running.stop();
    const before = countsOf(sb.db);
    expect(before.sessions).toBe(2);
    expect(before.costStates).toBeGreaterThanOrEqual(1);
    expect(before.events).toBeGreaterThan(0);

    // without --yes and --confirm nothing moves
    const files = dbFilesIn(join(sb.ws, 'data'));
    expect((await sb.mcs(['db', 'rebuild', '--task', SLUG, '--confirm', SLUG])).code).toBe(0);
    for (const args of [['--yes'], ['--yes', '--confirm', 'other'], ['--yes', '--confirm', '']]) {
      const run = await sb.mcs(['db', 'rebuild', '--task', SLUG, ...args, '--json']);
      expect(run.code, args.join(' ')).toBe(1);
      expect(envelope(run).error?.code, args.join(' ')).toBe('CONFIRMATION_REQUIRED');
    }
    expect(dbFilesIn(join(sb.ws, 'data'))).toEqual(files);
    const oldDbSha = sha(sb.db);

    // applied
    const done = await sb.mcs(['db', 'rebuild', '--task', SLUG, '--yes', '--confirm', SLUG, '--json']);
    expect(done.code, done.stderr).toBe(0);
    const result = DbRebuildResultSchema.parse(envelope(done).data);
    expect(result).toMatchObject({ applied: true });
    expect(dbFilesIn(join(sb.ws, 'data'))).toEqual([]);
    const folder = join(sb.ws, 'data', 'backups', result.backup ?? 'missing');
    const manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')));
    expect(manifest).toMatchObject({ reason: 'db-rebuild', dbCopy: 'raw' });
    for (const entry of manifest.files) expect(sha(join(folder, entry.path))).toBe(entry.sha256);
    expect(manifest.files.find((f) => f.path === 'monitor.db')?.sha256).toBe(oldDbSha);
    expect(JSON.parse(readFileSync(join(sb.ws, 'instance.json'), 'utf8'))).toMatchObject({ dbSchemaVersion: 0 });
    const audit = readFileSync(join(sb.ws, 'audit', 'changes.md'), 'utf8');
    expect(audit).toContain('| db-rebuild');
    expect(audit).toContain(`- Outcome: moved; backup ${result.backup ?? ''}`);
    // a second call has nothing left to move
    const nothing = await sb.mcs(['db', 'rebuild', '--task', SLUG, '--yes', '--confirm', SLUG]);
    expect(nothing.code, nothing.stderr).toBe(0);
    expect(nothing.stdout).toContain('has no database');

    // the next start creates a new database and imports the transcripts again, cost_states included
    const second = await sb.start();
    await waitImported(sb);
    await second.stop();
    expect(countsOf(sb.db)).toEqual(before);

    // the old database comes back
    const restored = await sb.mcs(['backup', 'restore', '--task', SLUG, '--id', result.backup ?? '', '--yes']);
    expect(restored.code, restored.stderr).toBe(0);
    expect(sha(sb.db)).toBe(oldDbSha);
    expect(countsOf(sb.db)).toEqual(before);
    const third = await sb.start();
    await third.stop();
  }, 360_000);

  it('a server killed with data that only its -wal held: the rebuild moves the -wal too and the restore brings it back', async () => {
    const sb = await sandbox('rebuild-wal');
    const running = await sb.start();
    await waitImported(sb);
    await forceKill(running.pid);
    expect(await waitForExit(running.pid, 15_000)).toBe(true);
    const wal = `${sb.db}-wal`;
    expect(existsSync(wal) ? statSync(wal).size : 0, 'the killed server left its WAL behind').toBeGreaterThan(0);
    const walBytes = readFileSync(wal);

    const done = await sb.mcs(['db', 'rebuild', '--task', SLUG, '--yes', '--confirm', SLUG, '--json']);
    expect(done.code, done.stderr).toBe(0);
    const result = DbRebuildResultSchema.parse(envelope(done).data);
    expect(result.files.map((f) => f.path)).toContain('data/monitor.db-wal');
    expect(dbFilesIn(join(sb.ws, 'data'))).toEqual([]);
    const folder = join(sb.ws, 'data', 'backups', result.backup ?? 'missing');
    const manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')));
    expect(manifest.files.find((f) => f.path === 'monitor.db-wal')?.sha256).toBe(
      createHash('sha256').update(walBytes).digest('hex'),
    );

    const restored = await sb.mcs(['backup', 'restore', '--task', SLUG, '--id', result.backup ?? '', '--yes']);
    expect(restored.code, restored.stderr).toBe(0);
    expect(readFileSync(wal)).toEqual(walBytes);
    // the rows that only the WAL held are there without any import: nothing has run since the restore
    expect(countsOf(sb.db).sessions).toBe(2);
  }, 360_000);
});
