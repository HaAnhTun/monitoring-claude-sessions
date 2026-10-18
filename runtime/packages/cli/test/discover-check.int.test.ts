// WP-85 (CR-WP-15-2, CR-WP-14-2) through the real built CLI: `discover` and `check` resolve `transcripts_dir: auto` in a
// hermetic Claude home built by the testkit, `configure` of a key that routes rewrites the route file of the instance, and a
// live instance is never shown as `unverified`. The real `~/.claude` is never read: every call runs with `hermeticEnv`.
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { projectFolderName } from '@mcs/engine';
import { routeKey } from '@mcs/shared/protocol';
import {
  buildClaudeHome,
  buildRepo,
  hermeticEnv,
  killAllTracked,
  runCli,
  startInstance,
  useTempDirs,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const LF = String.fromCharCode(10);
const SID = '0a1b2c3d-1111-4222-8333-444455556666';
const PROMPT = 'FIXTURE first prompt of the discovered session';
/** In the test range 18000-18999 and away from the ports of the other integration files. */
const PORT = 18857;

interface Sandbox {
  readonly root: string;
  readonly repo: string;
  readonly env: Record<string, string>;
  readonly claudeHome: string;
  readonly mcsHome: string;
}

function sandbox(withSession = true): Sandbox {
  const root = makeTemp('discover-check').path;
  const { repo } = buildRepo(join(root, 'repo'));
  const env = hermeticEnv(root);
  const claudeHome = env['CLAUDE_CONFIG_DIR'] ?? join(root, 'claude-home');
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  if (withSession) {
    buildClaudeHome(claudeHome, {
      nowMs: Date.now(),
      sessions: [
        { id: SID, project: projectFolderName(repo).name, cwd: repo, mtimeAgeMs: 60_000, build: (b) => b.user(PROMPT) },
      ],
    });
  } else {
    mkdirSync(claudeHome, { recursive: true });
  }
  return { root, repo, env, claudeHome, mcsHome };
}

function mcs(sb: Sandbox, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCli([...args, '--repo', sb.repo], { mcsHome: sb.mcsHome, env: sb.env });
}

async function initTask(sb: Sandbox): Promise<string> {
  const result = await mcs(sb, ['init', '--name', 'Alpha task']);
  expect(result.code, result.stderr).toBe(0);
  const slug = /created task '([a-z0-9-]+)'/.exec(result.stdout)?.[1];
  if (slug === undefined) throw new Error('init printed no slug');
  return slug;
}

function routeOfInstance(sb: Sandbox): Record<string, unknown> {
  const dir = join(sb.mcsHome, 'routes');
  const [file] = readdirSync(dir).filter((name) => name.endsWith('.json'));
  if (file === undefined) throw new Error('no route file');
  return JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
}

afterEach(async () => {
  await killAllTracked();
});

describe('transcripts_dir auto through the CLI', () => {
  it('discover prints the discovered folder and its sessions with the first prompt', async () => {
    const sb = sandbox();
    const run = await mcs(sb, ['discover']);
    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.split(LF);
    const folder = join(sb.claudeHome, 'projects', projectFolderName(sb.repo).name);
    expect(lines[1]).toBe(`transcripts: ${folder}`);
    expect(lines[2]).toBe('recent sessions (newest first):');
    expect(lines[3]).toContain(SID);
    expect(lines[3]).toContain(PROMPT);
    expect(run.stderr).not.toContain(PROMPT);
  });

  it('discover says the folder is not found for an empty Claude home and still exits 0', async () => {
    const sb = sandbox(false);
    const run = await mcs(sb, ['discover']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.split(LF)[1]).toBe('transcripts: (not found: pass transcripts_dir explicitly)');
  });

  it('check prints the resolved folder instead of None, and never the first prompt', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const run = await mcs(sb, ['check', '--task', slug]);
    expect(run.code, run.stderr).toBe(0);
    const folder = join(sb.claudeHome, 'projects', projectFolderName(sb.repo).name);
    expect(run.stdout).toContain(`| transcripts: ${folder} |`);
    expect(run.stdout).not.toContain('transcripts: None');
    expect(run.stdout).not.toContain(PROMPT);
  });
});

describe('a live instance and its route file', () => {
  it('is not unverified in inspect and discover, and configure --set repo rewrites its route file', async () => {
    const sb = sandbox();
    const slug = await initTask(sb);
    const started = await startInstance({ repo: sb.repo, slug, env: sb.env }, { port: PORT });
    try {
      const inspect = await mcs(sb, ['inspect', '--task', slug]);
      expect(inspect.code, inspect.stderr).toBe(0);
      expect(inspect.stdout).not.toContain('unverified');
      const discover = await mcs(sb, ['discover']);
      expect(discover.code, discover.stderr).toBe(0);
      expect(discover.stdout).not.toContain('unverified');
      expect(discover.stdout).toContain(`${slug} engine=node state=`);
    } finally {
      await started.stop();
    }

    const before = routeOfInstance(sb);
    expect(before['stoppedAt']).toEqual(expect.any(Number));
    const other = join(sb.root, 'other-repo');
    mkdirSync(other);
    const otherFolder = join(sb.claudeHome, 'projects', projectFolderName(other).name);
    mkdirSync(otherFolder, { recursive: true });
    const configure = await mcs(sb, ['configure', '--task', slug, '--set', `repo=${other}`]);
    expect(configure.code, configure.stderr).toBe(0);

    const after = routeOfInstance(sb);
    const match = after['match'] as { transcriptsDirs: string[] };
    expect(match.transcriptsDirs).toContain(routeKey(otherFolder));
    expect(after['stoppedAt']).toBe(before['stoppedAt']);
    expect(after['spoolUntil']).toBe(before['spoolUntil']);
  }, 90_000);
});
