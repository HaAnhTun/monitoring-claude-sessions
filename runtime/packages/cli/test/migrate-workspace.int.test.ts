// `mcs migrate-workspace` through the real built entry `packages/cli/dist/main.js` (ADR 0068, plan WP-95 and WP-140): the dry-run
// text and the `--json` envelope, `--apply`, a blocked workspace (exit 1, canary-free output), usage errors and the help page,
// the `--all` sweep with its `--yes` rule, and the `workspace.format` line of `mcs doctor`. Every call passes
// `--repo <temp repo>` and runs with a hermetic environment; one test starts a real instance on an allocated port to prove
// that a sweep leaves a running monitor alone.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CliEnvelopeSchema } from '@mcs/shared';
import {
  CANARY,
  allocatePort,
  buildRepo,
  buildTaskWorkspace,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  makeJunction,
  runCli,
  snapshotTree,
  startInstance,
  useTempDirs,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();

afterEach(async () => {
  await killAllTracked();
});

/** Two synthetic pre-4.0 shapes (the engine test has all four): A has no pattern, D has Python named groups in attempts. */
const SHAPES = {
  A: { title: 'FIXTURE shape A', port: 18770, transcripts_dir: 'auto', panels: { machine: true, git: true } },
  D: {
    title: 'FIXTURE shape D',
    port: 18773,
    attempts: {
      start: '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB (?P<part>[A-Z0-9]+) BEGIN',
      end: '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB (?P<part>[A-Z0-9]+) END code=(?P<exit>[0-9]+)',
      time_format: '%Y-%m-%d %H:%M:%S',
    },
  },
} as const;

function buildShape(repo: string, name: keyof typeof SHAPES): string {
  return buildTaskWorkspace(repo, { slug: `shape-${name.toLowerCase()}`, config: SHAPES[name] });
}

interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly env: Record<string, string>;
}

function sandbox(): Sandbox {
  const root = makeTemp('cli-migrate').path;
  const { repo } = buildRepo(join(root, 'repo'));
  return { root, repo, env: hermeticEnv(root) };
}

function mcs(sb: Sandbox, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCli([...args, '--repo', sb.repo], {
    mcsHome: sb.env['MCS_HOME'] ?? join(sb.root, 'mcs-home'),
    env: sb.env,
  });
}

function dataOf(stdout: string): Record<string, unknown> {
  const envelope = CliEnvelopeSchema.parse(JSON.parse(stdout));
  return envelope.data as Record<string, unknown>;
}

describe('mcs migrate-workspace', () => {
  it('prints the dry run as text and as a --json envelope, and writes nothing', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'D');
    const before = snapshotTree(ws);
    const text = await mcs(sb, ['migrate-workspace', '--task', 'shape-d']);
    expect(text.code, text.stderr).toBe(0);
    const lines = text.stdout.trim().split(/\r?\n/u);
    expect(lines[0]).toBe("task 'shape-d': needs-migration (dry run, nothing written)");
    expect(lines).toContain('  would translate attempts.start to the JavaScript dialect');
    expect(lines.at(-1)).toBe(
      'run `mcs migrate-workspace --task shape-d --apply` to convert it (a backup is written first)',
    );
    const json = await mcs(sb, ['migrate-workspace', '--task', 'shape-d', '--json']);
    expect(json.code, json.stderr).toBe(0);
    expect(dataOf(json.stdout)).toMatchObject({
      slug: 'shape-d',
      verdict: 'needs-migration',
      mode: 'dry-run',
      backup: null,
      blockers: [],
    });
    expect(snapshotTree(ws)).toBe(before);
  });

  it('--apply converts the workspace; a second run is current', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'A');
    const applied = await mcs(sb, ['migrate-workspace', '--task', 'shape-a', '--apply', '--json']);
    expect(applied.code, applied.stderr).toBe(0);
    const data = dataOf(applied.stdout);
    expect(data).toMatchObject({ verdict: 'needs-migration', mode: 'applied' });
    expect(String(data['backup'])).toMatch(/^data\/backups\/pre-migrate-\d{8}T\d{6}Z\/$/u);
    expect(existsSync(join(ws, 'instance.json'))).toBe(true);
    const again = await mcs(sb, ['migrate-workspace', '--task', 'shape-a', '--apply']);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout.trim()).toBe("task 'shape-a': current (applied)");
  });

  it('a blocked workspace exits 1, is untouched and the output holds no pattern text', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'A');
    const config = JSON.parse(readFileSync(join(ws, 'config.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(
      join(ws, 'config.json'),
      `${JSON.stringify({ ...config, session_rules: [{ match: `(?x) ${CANARY.key}`, label: 'x' }] }, null, 2)}\n`,
    );
    const before = snapshotTree(ws);
    const run = await mcs(sb, ['migrate-workspace', '--task', 'shape-a', '--apply', '--json']);
    expect(run.code).toBe(1);
    const data = dataOf(run.stdout);
    expect(data['verdict']).toBe('blocked');
    expect(String((data['blockers'] as string[])[0])).toMatch(/^REGEX_UNSUPPORTED: session_rules\[0\]\.match /u);
    expect(run.stdout + run.stderr).not.toContain(CANARY.key);
    expect(snapshotTree(ws)).toBe(before);
  });

  it('usage errors exit 2 and the help page lists the command', async () => {
    const sb = sandbox();
    buildShape(sb.repo, 'A');
    const missing = await mcs(sb, ['migrate-workspace']);
    expect(missing.code).toBe(2);
    const both = await mcs(sb, ['migrate-workspace', '--task', 'shape-a', '--all']);
    expect(both.code).toBe(2);
    const unknown = await mcs(sb, ['migrate-workspace', '--task', 'shape-a', '--bogus']);
    expect(unknown.code).toBe(2);
    const help = await mcs(sb, ['help']);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain('migrate-workspace');
    const own = await mcs(sb, ['migrate-workspace', '--help']);
    expect(own.code).toBe(0);
    expect(own.stdout).toContain('--apply');
    expect(own.stdout).toContain('--all');
    expect(own.stdout).toContain('--yes');
  });

  it('an unknown task is TASK_NOT_FOUND (exit 1)', async () => {
    const sb = sandbox();
    const run = await mcs(sb, ['migrate-workspace', '--task', 'nope', '--json']);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
  });
});

/** The blocked workspace: a pattern that cannot be translated and does not compile; the canary must never be echoed. */
function buildBlocked(repo: string): string {
  return buildTaskWorkspace(repo, {
    slug: 'shape-blocked',
    config: { title: 'FIXTURE blocked', session_rules: [{ match: `(?x) ${CANARY.key}`, label: 'x' }] },
  });
}

describe('mcs migrate-workspace --all', () => {
  it('the dry run prints one block per workspace and a tally, exits 1 because one is blocked, and writes nothing', async () => {
    const sb = sandbox();
    buildShape(sb.repo, 'A');
    buildBlocked(sb.repo);
    buildShape(sb.repo, 'D');
    const tasksRoot = join(sb.repo, '.claude', 'monitor', 'tasks');
    const before = snapshotTree(tasksRoot);
    const text = await mcs(sb, ['migrate-workspace', '--all']);
    expect(text.code, text.stderr).toBe(1);
    const lines = text.stdout.trim().split(/\r?\n/u);
    expect(lines.filter((l) => l.startsWith("task '"))).toEqual([
      "task 'shape-a': needs-migration (dry run, nothing written)",
      "task 'shape-blocked': blocked (dry run, nothing written)",
      "task 'shape-d': needs-migration (dry run, nothing written)",
    ]);
    expect(lines.some((l) => l.startsWith('  blocked: REGEX_UNSUPPORTED: session_rules[0].match '))).toBe(true);
    expect(lines).toContain('3 task workspaces: 2 needing migration, 0 current, 1 blocked (dry run, nothing written)');
    expect(lines.at(-1)).toBe(
      'run `mcs migrate-workspace --all --apply --yes` to convert them (a backup is written first)',
    );
    expect(lines.filter((l) => l.startsWith('run `mcs migrate-workspace --task'))).toEqual([]);
    expect(text.stdout + text.stderr).not.toContain(CANARY.key);

    const json = await mcs(sb, ['migrate-workspace', '--all', '--json']);
    expect(json.code, json.stderr).toBe(1);
    const data = dataOf(json.stdout);
    expect(data).toMatchObject({
      mode: 'dry-run',
      skipped: [],
      counts: { total: 3, current: 0, needsMigration: 2, blocked: 1 },
    });
    expect((data['workspaces'] as { slug: string; verdict: string }[]).map((w) => `${w.slug}:${w.verdict}`)).toEqual([
      'shape-a:needs-migration',
      'shape-blocked:blocked',
      'shape-d:needs-migration',
    ]);
    expect(json.stdout).not.toContain(CANARY.key);
    expect(snapshotTree(tasksRoot)).toBe(before);
  });

  it('--all --apply without --yes is a usage error: exit 2 and nothing is written', async () => {
    const sb = sandbox();
    buildShape(sb.repo, 'A');
    buildShape(sb.repo, 'D');
    const tasksRoot = join(sb.repo, '.claude', 'monitor', 'tasks');
    const before = snapshotTree(tasksRoot);
    const text = await mcs(sb, ['migrate-workspace', '--all', '--apply']);
    expect(text.code).toBe(2);
    expect(text.stdout + text.stderr).toContain('--yes');
    const json = await mcs(sb, ['migrate-workspace', '--all', '--apply', '--json']);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
    expect(snapshotTree(tasksRoot)).toBe(before);
    expect(readdirSync(join(tasksRoot, 'shape-a')).includes('instance.json')).toBe(false);
  });

  it('--all --task SLUG is a usage error, also with --apply --yes', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'A');
    const before = snapshotTree(ws);
    for (const extra of [[], ['--apply', '--yes']]) {
      const run = await mcs(sb, ['migrate-workspace', '--all', '--task', 'shape-a', ...extra]);
      expect(run.code, extra.join(' ')).toBe(2);
    }
    expect(snapshotTree(ws)).toBe(before);
  });

  it('--all --apply --yes converts the others around a blocked workspace in the middle and exits 1', async () => {
    const sb = sandbox();
    const a = buildShape(sb.repo, 'A');
    const blocked = buildBlocked(sb.repo);
    const d = buildShape(sb.repo, 'D');
    const blockedBefore = snapshotTree(blocked);
    const run = await mcs(sb, ['migrate-workspace', '--all', '--apply', '--yes']);
    expect(run.code, run.stderr).toBe(1);
    const lines = run.stdout.trim().split(/\r?\n/u);
    expect(lines).toContain("task 'shape-a': needs-migration (applied)");
    expect(lines).toContain("task 'shape-blocked': blocked (applied)");
    expect(lines).toContain("task 'shape-d': needs-migration (applied)");
    expect(lines.at(-1)).toBe('3 task workspaces: 2 migrated, 0 already current, 1 blocked');
    expect(lines.filter((l) => l.startsWith('  backup: data/backups/pre-migrate-'))).toHaveLength(2);
    expect(existsSync(join(a, 'instance.json'))).toBe(true);
    expect(existsSync(join(d, 'instance.json'))).toBe(true);
    expect(snapshotTree(blocked)).toBe(blockedBefore);
    expect(run.stdout + run.stderr).not.toContain(CANARY.key);

    const again = await mcs(sb, ['migrate-workspace', '--all', '--apply', '--yes', '--json']);
    expect(again.code, again.stderr).toBe(1);
    expect(dataOf(again.stdout)).toMatchObject({ counts: { total: 3, current: 2, needsMigration: 0, blocked: 1 } });
    expect(snapshotTree(blocked)).toBe(blockedBefore);
  });

  it('over workspaces that can all be converted it exits 0, and a second run says they are current', async () => {
    const sb = sandbox();
    buildShape(sb.repo, 'A');
    buildShape(sb.repo, 'D');
    const first = await mcs(sb, ['migrate-workspace', '--all', '--apply', '--yes']);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout.trim().split(/\r?\n/u).at(-1)).toBe(
      '2 task workspaces: 2 migrated, 0 already current, 0 blocked',
    );
    const tasksRoot = join(sb.repo, '.claude', 'monitor', 'tasks');
    const tree = snapshotTree(tasksRoot);
    const second = await mcs(sb, ['migrate-workspace', '--all', '--apply', '--yes']);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout.trim().split(/\r?\n/u).at(-1)).toBe(
      '2 task workspaces: 0 migrated, 2 already current, 0 blocked',
    );
    expect(snapshotTree(tasksRoot)).toBe(tree);
    const dry = await mcs(sb, ['migrate-workspace', '--all']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).not.toContain('run `mcs migrate-workspace');
  });

  it('over zero workspaces it exits 0 and says so, with and without --apply --yes', async () => {
    const sb = sandbox();
    const tasksRoot = join(sb.repo, '.claude', 'monitor', 'tasks');
    expect(readdirSync(tasksRoot)).toEqual([]);
    for (const extra of [[], ['--apply', '--yes']]) {
      const run = await mcs(sb, ['migrate-workspace', '--all', ...extra]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('no task workspaces found in the tasks root');
    }
    expect(readdirSync(tasksRoot)).toEqual([]);
  });

  it('a running monitor is never touched: its workspace is blocked, keeps serving, and the others are converted', async () => {
    const sb = sandbox();
    const port = await allocatePort();
    const made = await mcs(sb, ['init', '--name', 'Live task', '--slug', 'live', '--port', String(port)]);
    expect(made.code, made.stderr).toBe(0);
    const a = buildShape(sb.repo, 'A');
    const instance = await startInstance({ repo: sb.repo, slug: 'live', env: sb.env }, { port });
    const live = join(sb.repo, '.claude', 'monitor', 'tasks', 'live');
    const mutable = ['logs', 'data', 'state.json', 'run'];
    const before = snapshotTree(live, { exclude: mutable });

    const run = await mcs(sb, ['migrate-workspace', '--all', '--apply', '--yes']);
    expect(run.code, run.stderr).toBe(1);
    const lines = run.stdout.split(/\r?\n/u);
    expect(lines).toContain("task 'live': blocked (applied)");
    expect(lines.some((l) => l.startsWith('  blocked: INSTANCE_RUNNING: ') && l.includes('mcs stop --task live'))).toBe(
      true,
    );
    expect(lines).toContain("task 'shape-a': needs-migration (applied)");
    expect(existsSync(join(a, 'instance.json'))).toBe(true);
    expect(snapshotTree(live, { exclude: mutable })).toBe(before);
    expect((await httpRequest(port, '/api/v3/health')).status).toBe(200);
    await instance.stop();
  });

  it('a task folder that is a link is skipped and never followed', async () => {
    const sb = sandbox();
    const a = buildShape(sb.repo, 'A');
    const outside = makeTemp('cli-migrate-outside').path;
    const { repo: otherRepo } = buildRepo(join(outside, 'repo'));
    const target = buildTaskWorkspace(otherRepo, { slug: 'outside-task', config: SHAPES.A });
    mkdirSync(join(sb.repo, '.claude', 'monitor', 'tasks'), { recursive: true });
    makeJunction(join(sb.repo, '.claude', 'monitor', 'tasks', 'linked'), target);
    const targetBefore = snapshotTree(target);
    const run = await mcs(sb, ['migrate-workspace', '--all', '--apply', '--yes', '--json']);
    expect(run.code, run.stderr).toBe(0);
    const data = dataOf(run.stdout);
    expect((data['skipped'] as { slug: string }[]).map((s) => s.slug)).toEqual(['linked']);
    expect((data['workspaces'] as { slug: string }[]).map((w) => w.slug)).toEqual(['shape-a']);
    expect(existsSync(join(a, 'instance.json'))).toBe(true);
    expect(snapshotTree(target)).toBe(targetBefore);
    const text = await mcs(sb, ['migrate-workspace', '--all']);
    expect(text.stdout).toContain("skipped 'linked': a link, not a folder");
  });

  it('the command reaches no process signal', () => {
    const text = readFileSync(fileURLToPath(new URL('../src/commands/migrate-workspace.ts', import.meta.url)), 'utf8');
    expect(text).not.toMatch(/process\.kill|forceKill|taskkill/u);
  });
});

describe('mcs doctor: workspace.format', () => {
  it('warns on an old-format workspace with the fix, and says ok once it is converted', async () => {
    const sb = sandbox();
    const ws = buildShape(sb.repo, 'D');
    const before = snapshotTree(ws);
    const old = await mcs(sb, ['doctor', '--task', 'shape-d']);
    const oldLines = old.stdout.split(/\r?\n/u);
    const at = oldLines.findIndex((l) => l.startsWith('[warn] workspace.format: '));
    expect(at, old.stdout + old.stderr).toBeGreaterThanOrEqual(0);
    expect(oldLines[at]).toContain('written before 4.0');
    expect(oldLines[at + 1]).toBe('  fix: mcs migrate-workspace --task shape-d');
    expect(snapshotTree(ws)).toBe(before);

    const applied = await mcs(sb, ['migrate-workspace', '--task', 'shape-d', '--apply']);
    expect(applied.code, applied.stderr).toBe(0);
    const converted = await mcs(sb, ['doctor', '--task', 'shape-d']);
    const lines = converted.stdout.split(/\r?\n/u);
    expect(lines.some((l) => l.startsWith('[warn] workspace.format'))).toBe(false);
    expect(lines.some((l) => l.startsWith('[ok] workspace.format: '))).toBe(true);
  });

  it('is skipped without a task', async () => {
    const sb = sandbox();
    const run = await mcs(sb, ['doctor']);
    expect(run.stdout.split(/\r?\n/u)).toContain('[ok] workspace.format: no task selected (skipped)');
  });
});
