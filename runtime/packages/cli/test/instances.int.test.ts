// `mcs instances list` and `mcs instances repair` through the real built CLI (01 6.4, 3.4): the JSON rows of a running, a
// stopped and a copied workspace; `--no-probe`; the repair is a dry run without `--yes` and refuses while the original runs.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliEnvelopeSchema, InstanceRowSchema } from '@mcs/shared';
import { allocatePort, buildRepo, hermeticEnv, killAllTracked, runCli, startInstance, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const LF = String.fromCharCode(10);

afterEach(async () => {
  await killAllTracked();
});

interface Sandbox {
  readonly repo: string;
  readonly tasksRoot: string;
  readonly env: Record<string, string>;
  mcs(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

function sandbox(purpose: string): Sandbox {
  const root = makeTemp(purpose).path;
  const { repo, tasksRoot } = buildRepo(join(root, 'repo'));
  const env = hermeticEnv(root);
  const mcsHome = env['MCS_HOME'] ?? join(root, 'mcs-home');
  return { repo, tasksRoot, env, mcs: (args) => runCli([...args, '--repo', repo], { mcsHome, env }) };
}

function idOf(sb: Sandbox, slug: string): unknown {
  const file = JSON.parse(readFileSync(join(sb.tasksRoot, slug, 'instance.json'), 'utf8')) as { instanceId: unknown };
  return file.instanceId;
}

/** A copy of workspace `from` as `to`: the folder and `task.json` say `to`, `instance.json` still names `from` (01 3.4). */
function copyWorkspace(sb: Sandbox, from: string, to: string): void {
  const dir = join(sb.tasksRoot, to);
  cpSync(join(sb.tasksRoot, from), dir, {
    recursive: true,
    filter: (src) =>
      !src.startsWith(join(sb.tasksRoot, from, 'data')) && !src.startsWith(join(sb.tasksRoot, from, 'run')),
  });
  const task = join(dir, 'task.json');
  writeFileSync(task, readFileSync(task, 'utf8').replace(`"id": "${from}"`, `"id": "${to}"`));
}

describe('mcs instances', () => {
  it('lists running, stopped and broken workspaces, and repairs the copy', async () => {
    const sb = sandbox('instances-int');
    const port = await allocatePort();
    for (const slug of ['a', 'b']) {
      const made = await sb.mcs(['init', '--name', `Task ${slug}`, '--slug', slug, '--port', String(port)]);
      expect(made.code, made.stderr).toBe(0);
    }
    copyWorkspace(sb, 'b', 'c');
    const instance = await startInstance({ repo: sb.repo, slug: 'a', env: sb.env }, { port });

    const listed = await sb.mcs(['instances', 'list', '--json']);
    expect(listed.code, listed.stderr).toBe(0);
    const data = CliEnvelopeSchema.parse(JSON.parse(listed.stdout)).data;
    expect(Array.isArray(data)).toBe(true);
    const rows = (data as unknown[]).map((row) => InstanceRowSchema.parse(row));
    expect(rows.map((r) => [r.slug, r.identity, r.state])).toEqual([
      ['a', 'node', 'running'],
      ['b', 'node', 'stopped'],
      ['c', 'broken', 'stopped'],
    ]);
    expect(rows[0]).toMatchObject({ pid: instance.pid, outdated: false });
    expect(rows[0]?.url).toContain(String(port));

    const quick = await sb.mcs(['instances', 'list', '--no-probe']);
    expect(quick.code, quick.stderr).toBe(0);
    expect(quick.stdout.split(LF)[0]).toMatch(/^slug\s+identity\s+state/);
    expect(quick.stdout).toMatch(/a\s+node\s+unverified/);

    const dry = await sb.mcs(['instances', 'repair', '--task', 'c']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('dry run: nothing changed');
    expect(idOf(sb, 'c')).toBe(idOf(sb, 'b'));
    const applied = await sb.mcs(['instances', 'repair', '--task', 'c', '--yes']);
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.stdout).toContain('repaired');
    expect(idOf(sb, 'c')).not.toBe(idOf(sb, 'b'));
    await instance.stop();
  });

  it('repair refuses while the runtime of the identity runs', async () => {
    const sb = sandbox('instances-run');
    const port = await allocatePort();
    const made = await sb.mcs(['init', '--name', 'Task a', '--slug', 'a', '--port', String(port)]);
    expect(made.code, made.stderr).toBe(0);
    const instance = await startInstance({ repo: sb.repo, slug: 'a', env: sb.env }, { port });
    copyWorkspace(sb, 'a', 'c');
    const refused = await sb.mcs(['instances', 'repair', '--task', 'c', '--yes', '--json']);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: { code: 'INSTANCE_RUNNING' } });
    await instance.stop();
  });
});
