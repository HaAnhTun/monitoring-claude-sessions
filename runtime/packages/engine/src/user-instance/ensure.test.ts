// `ensureUserInstance` (06 1.4): the user instance is made once, reused after that, never from a link, and its identity
// says `kind: "user"`.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { InstanceFileSchema } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import type { Logger } from '../log/logger.ts';
import type { OpContext } from '../ops/workspace.ts';
import { readInstanceFile } from '../workspace/adopt.ts';
import { resolveWorkspace } from '../workspace/paths.ts';
import { ensureUserInstance } from './ensure.ts';
import { USER_DEFAULT_PORT, USER_INSTANCE_NAME, userInstanceDirOf, userOpContext, userRootOf } from './paths.ts';

const makeTemp = useTempDirs();
const FIXTURE = fileURLToPath(new URL('../../test/fixtures/legacy-workspace/', import.meta.url));
const NOW = Date.UTC(2026, 10, 14, 9, 30, 0);
const ID = '11111111-1111-4111-8111-111111111111';

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

/** A context whose home is a fresh temp folder; the repository and the tasks root of the caller are never used. */
function setup(env: Record<string, string> = {}): { ctx: OpContext; home: string } {
  const home = makeTemp('user-ensure').path;
  const skillDir = path.resolve('skill');
  const ctx: OpContext = {
    repo: path.join(home, 'not-used-repo'),
    root: path.join(home, 'not-used-root'),
    skillDir,
    runtimeDir: path.join(skillDir, 'runtime'),
    launcherPath: path.join(skillDir, 'scripts', 'caw.mjs'),
    env: { MCS_HOME: home, ...env },
    clock: new FakeClock(NOW),
    log: silent,
  };
  return { ctx, home };
}

function read(ctx: OpContext, ...rel: string[]): string {
  return readFileSync(path.join(userInstanceDirOf(ctx.env), ...rel), 'utf8');
}

describe('ensureUserInstance: the first call', () => {
  it('makes the workspace below <MCS_HOME>/instances with the identity, the title and the port of the user instance', async () => {
    const { ctx } = setup();
    const result = await ensureUserInstance(ctx, { newId: () => ID });
    expect(result.created).toBe(true);
    expect(result.ws.slug).toBe('user');
    expect(result.ws.root).toBe(userRootOf(ctx.env));
    expect(result.ws.dir).toBe(userInstanceDirOf(ctx.env));
    expect(result.instance).toMatchObject({ instanceId: ID, slug: 'user', kind: 'user', engine: 'node' });
    expect(InstanceFileSchema.safeParse(await readInstanceFile(result.ws)).success).toBe(true);

    expect(readdirSync(userRootOf(ctx.env))).toEqual(['user']);
    expect(read(ctx, 'config.json')).toBe(
      `{\n  "schema_version": 1,\n  "title": "${USER_INSTANCE_NAME}",\n  "port": ${String(USER_DEFAULT_PORT)}\n}\n`,
    );
    expect(read(ctx, 'task.json')).toContain(`"name": "${USER_INSTANCE_NAME}"`);
    expect(read(ctx, 'task.json')).toContain('"id": "user"');
    expect(read(ctx, 'instance.json')).toContain('  "engine": "node",\n  "kind": "user",\n  "hooks": {');
  });

  it('rewrites the README once with the text of the user instance, not the one of a monitoring task', async () => {
    const { ctx } = setup();
    await ensureUserInstance(ctx);
    const readme = read(ctx, 'README.md');
    expect(readme.startsWith(`# ${USER_INSTANCE_NAME}\n`)).toBe(true);
    expect(readme).not.toContain('Monitoring task');
    expect(readme).toContain('user-wide');
    expect(readme).toContain('instance.json');
    expect(readme.endsWith('\n')).toBe(true);
  });

  it('creates the folder of the user root on demand and reads nothing of the repository of the caller', async () => {
    const { ctx, home } = setup();
    const before = readdirSync(home);
    await ensureUserInstance(ctx);
    expect(readdirSync(home).filter((name) => !before.includes(name))).toEqual(['instances']);
  });

  it('audits the creation once and leaves no staging folder', async () => {
    const { ctx } = setup();
    await ensureUserInstance(ctx);
    expect(read(ctx, 'audit', 'changes.md').match(/\| init-task$/gm)).toHaveLength(1);
    expect(readdirSync(userRootOf(ctx.env)).filter((name) => name.startsWith('.init-'))).toEqual([]);
  });

  it('CONFIG_INVALID when no home can be found, and nothing is created', async () => {
    const { ctx } = setup();
    await expect(ensureUserInstance({ ...ctx, env: {} })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('ensureUserInstance: a user instance that exists', () => {
  it('reuses it: created is false, the identity and the files are not touched', async () => {
    const { ctx } = setup();
    const first = await ensureUserInstance(ctx, { newId: () => ID });
    const bytes = ['instance.json', 'config.json', 'task.json', 'README.md', path.join('audit', 'changes.md')].map(
      (file) => read(ctx, file),
    );
    const second = await ensureUserInstance(ctx, { newId: () => '22222222-2222-4222-8222-222222222222' });
    expect(second.created).toBe(false);
    expect(second.instance).toEqual(first.instance);
    expect(
      ['instance.json', 'config.json', 'task.json', 'README.md', path.join('audit', 'changes.md')].map((file) =>
        read(ctx, file),
      ),
    ).toEqual(bytes);
  });

  it('reuses it after the person changed the port: no WORKSPACE_EXISTS_CONFIG_DIFFERS, the port stays theirs', async () => {
    const { ctx } = setup();
    await ensureUserInstance(ctx);
    const file = path.join(userInstanceDirOf(ctx.env), 'config.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace(String(USER_DEFAULT_PORT), '7733'));
    const again = await ensureUserInstance(ctx);
    expect(again.created).toBe(false);
    expect(read(ctx, 'config.json')).toContain('"port": 7733');
  });

  it('adopts a workspace named user that has no instance.json, as a user instance', async () => {
    const { ctx } = setup();
    const dir = userInstanceDirOf(ctx.env);
    mkdirSync(userRootOf(ctx.env), { recursive: true });
    cpSync(FIXTURE, dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'task.json'),
      readFileSync(path.join(dir, 'task.json'), 'utf8').replace(/"id": "[^"]*"/, '"id": "user"'),
    );
    const result = await ensureUserInstance(ctx, { newId: () => ID });
    expect(result.created).toBe(false);
    expect(result.instance).toMatchObject({ slug: 'user', kind: 'user' });
    expect(read(ctx, 'instance.json')).toContain('"kind": "user"');
  });

  it('refuses a workspace named user that is a task instance, and changes nothing', async () => {
    const { ctx } = setup();
    mkdirSync(userRootOf(ctx.env), { recursive: true });
    const { repo } = buildRepo(makeTemp('task-repo').path);
    const built = buildTaskWorkspace(repo, {
      slug: 'user',
      config: { title: 'Not the user instance' },
      instance: { instanceId: ID },
    });
    cpSync(built, userInstanceDirOf(ctx.env), { recursive: true });
    const before = read(ctx, 'instance.json');
    await expect(ensureUserInstance(ctx)).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
    expect(read(ctx, 'instance.json')).toBe(before);
  });

  it('serves other workspaces of the user root alone: they are neither listed nor changed', async () => {
    const { ctx } = setup();
    mkdirSync(path.join(userRootOf(ctx.env), 'other'), { recursive: true });
    await ensureUserInstance(ctx);
    expect(readdirSync(userRootOf(ctx.env)).sort()).toEqual(['other', 'user']);
    expect(readdirSync(path.join(userRootOf(ctx.env), 'other'))).toEqual([]);
  });
});

describe('ensureUserInstance: concurrent callers', () => {
  it('three callers at once make one instance: one creates, the others reuse, one audit entry', async () => {
    const { ctx } = setup();
    const results = await Promise.all([ensureUserInstance(ctx), ensureUserInstance(ctx), ensureUserInstance(ctx)]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.instance.instanceId)).size).toBe(1);
    expect(read(ctx, 'audit', 'changes.md').match(/\| init-task$/gm)).toHaveLength(1);
    expect(read(ctx, 'README.md').startsWith(`# ${USER_INSTANCE_NAME}\n`)).toBe(true);
    expect(readdirSync(userRootOf(ctx.env)).filter((name) => name.startsWith('.init-'))).toEqual([]);
  });
});

describe('ensureUserInstance: links', () => {
  it('refuses a user root that is a link, with WORKSPACE_SYMLINK, and writes nothing through it', async () => {
    const { ctx, home } = setup();
    const elsewhere = path.join(makeTemp('elsewhere').path, 'real');
    mkdirSync(elsewhere);
    makeJunction(path.join(home, 'instances'), elsewhere);
    await expect(ensureUserInstance(ctx)).rejects.toMatchObject({ code: 'WORKSPACE_SYMLINK' });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a user workspace that is a link', async () => {
    const { ctx } = setup();
    const real = path.join(userRootOf(ctx.env), 'real');
    mkdirSync(real, { recursive: true });
    makeJunction(userInstanceDirOf(ctx.env), real);
    await expect(ensureUserInstance(ctx)).rejects.toMatchObject({ code: 'WORKSPACE_SYMLINK' });
    expect(readdirSync(real)).toEqual([]);
  });
});

describe('ensureUserInstance with userOpContext', () => {
  it('works with the context that userOpContext builds, and the workspace resolves from the user root', async () => {
    const { ctx } = setup();
    const userCtx = userOpContext({
      skillDir: ctx.skillDir,
      runtimeDir: ctx.runtimeDir,
      launcherPath: ctx.launcherPath,
      env: ctx.env,
      clock: ctx.clock,
      log: ctx.log,
    });
    const result = await ensureUserInstance(userCtx);
    expect(result.ws).toEqual(resolveWorkspace(userCtx.root, 'user'));
  });
});
