// `mcs migrate-workspace` through the real built entry `packages/cli/dist/main.js` (ADR 0068, plan WP-95): the dry-run text
// and the `--json` envelope, `--apply`, a blocked workspace (exit 1, canary-free output), usage errors and the help page.
// Every call passes `--repo <temp repo>` and runs with a hermetic environment; no instance is started.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliEnvelopeSchema } from '@mcs/shared';
import { CANARY, buildRepo, buildTaskWorkspace, hermeticEnv, runCli, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();

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
    const unknown = await mcs(sb, ['migrate-workspace', '--task', 'shape-a', '--all']);
    expect(unknown.code).toBe(2);
    const help = await mcs(sb, ['help']);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain('migrate-workspace');
    const own = await mcs(sb, ['migrate-workspace', '--help']);
    expect(own.code).toBe(0);
    expect(own.stdout).toContain('--apply');
  });

  it('an unknown task is TASK_NOT_FOUND (exit 1)', async () => {
    const sb = sandbox();
    const run = await mcs(sb, ['migrate-workspace', '--task', 'nope', '--json']);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
  });
});
