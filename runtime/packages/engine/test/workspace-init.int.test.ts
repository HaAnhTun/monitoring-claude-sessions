// The init transaction between real processes (01 4.12, 4.16): T-LC-10 (crash between staging and rename), T-LC-11
// (four concurrent inits), T-LC-12 (adoption of a legacy-created workspace through `init` and through `start`).
// The child processes import the built `dist`, so the integration gate builds the runtime first.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hermeticEnv, killAllTracked, spawnTracked, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { adoptWorkspace } from '../src/workspace/adopt.ts';
import { initWorkspace } from '../src/workspace/init.ts';
import { resolveWorkspace, tasksRootOf } from '../src/workspace/paths.ts';

const makeTemp = useTempDirs();
const runtimeDir = fileURLToPath(new URL('../../../', import.meta.url));
const distInit = path.join(runtimeDir, 'packages', 'engine', 'dist', 'workspace', 'init.js');
const distAdopt = path.join(runtimeDir, 'packages', 'engine', 'dist', 'workspace', 'adopt.js');
const distPaths = path.join(runtimeDir, 'packages', 'engine', 'dist', 'workspace', 'paths.js');
const FIXTURE = fileURLToPath(new URL('./fixtures/legacy-workspace/', import.meta.url));
const LEGACY_FILES = ['task.json', 'config.json', 'README.md'] as const;

afterEach(async () => {
  await killAllTracked();
});

function builtUrl(file: string): string {
  if (!existsSync(file)) throw new Error(`${file} is missing: run the integration gate (it builds first)`);
  return pathToFileURL(file).href;
}

/** Runs `initWorkspace` (or the adoption of `start`) of the built engine; the outcome goes into a JSON file. */
const CHILD = `
import { writeFileSync } from 'node:fs';
const [mode, initUrl, adoptUrl, pathsUrl, repo, slug, startAt, resultFile] = process.argv.slice(2);
const result = { ok: false };
try {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < Number(startAt)) Atomics.wait(wait, 0, 0, 1);
  if (mode === 'adopt') {
    const { adoptWorkspace } = await import(adoptUrl);
    const { resolveWorkspace, tasksRootOf } = await import(pathsUrl);
    const out = await adoptWorkspace(resolveWorkspace(tasksRootOf(repo), slug), {});
    result.ok = true;
    result.adopted = out.adopted;
    result.instanceId = out.instance.instanceId;
  } else {
    const { initWorkspace } = await import(initUrl);
    const opts = { repo, name: 'Concurrent demo', slug };
    if (mode === 'crash') opts.beforeRename = () => process.exit(70);
    const out = await initWorkspace(opts);
    result.ok = true;
    result.created = out.created;
    result.adopted = out.adopted;
    result.instanceId = out.instance.instanceId;
  }
} catch (error) {
  result.message = error instanceof Error ? error.message : String(error);
}
writeFileSync(resultFile, JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
`;

interface ChildResult {
  readonly ok: boolean;
  readonly created?: boolean;
  readonly adopted?: boolean;
  readonly instanceId?: string;
  readonly message?: string;
}

function startChild(
  dir: string,
  mode: 'init' | 'crash' | 'adopt',
  repo: string,
  slug: string,
  startAt: number,
  label: string,
): { pid: number; exited: Promise<number | null>; result: () => ChildResult | null } {
  const script = path.join(dir, 'child.mjs');
  if (!existsSync(script)) writeFileSync(script, CHILD);
  const resultFile = path.join(dir, `result-${label}.json`);
  const child = spawnTracked(
    process.execPath,
    [
      script,
      mode,
      builtUrl(distInit),
      builtUrl(distAdopt),
      builtUrl(distPaths),
      repo,
      slug,
      String(startAt),
      resultFile,
    ],
    { env: hermeticEnv(dir) },
  );
  return {
    pid: child.pid,
    exited: child.exited,
    result: () => (existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, 'utf8')) as ChildResult) : null),
  };
}

function bareRepo(): string {
  return makeTemp('init-int').path;
}

function stagingFolders(repo: string): string[] {
  const root = tasksRootOf(repo);
  return existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('.init-')) : [];
}

function countEntries(text: string, action: string): number {
  return text.split('\n').filter((line) => line.endsWith(`| ${action}`) && line.startsWith('## ')).length;
}

describe('T-LC-10: a crash between staging and rename', () => {
  it('leaves no workspace and one staging folder; the next init removes it (after its mtime is backdated) and succeeds', async () => {
    const repo = bareRepo();
    const scratch = makeTemp('init-int-scratch').path;
    const crashing = startChild(scratch, 'crash', repo, 'crashy', Date.now() + 500, 'crash');
    expect(await crashing.exited).toBe(70);

    const root = tasksRootOf(repo);
    expect(readdirSync(root)).toEqual([
      expect.stringMatching(new RegExp(`^\\.init-crashy-${String(crashing.pid)}-[0-9a-f]{8}$`)),
    ]);
    expect(existsSync(path.join(root, 'crashy'))).toBe(false);

    // A young leftover stays: it may belong to an init that is still working (rule: dead pid AND older than 10 minutes).
    await initWorkspace({ repo, name: 'Other', slug: 'other' });
    expect(stagingFolders(repo)).toHaveLength(1);

    const leftover = path.join(root, stagingFolders(repo)[0] ?? '');
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(leftover, old, old);
    const result = await initWorkspace({ repo, name: 'Crashy', slug: 'crashy' });
    expect(result.created).toBe(true);
    expect(stagingFolders(repo)).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(['crashy', 'other']);
    expect(countEntries(readFileSync(path.join(root, 'crashy', 'audit', 'changes.md'), 'utf8'), 'init-task')).toBe(1);
  });
});

describe('T-LC-11: concurrent init of the same slug', () => {
  it('four processes: one created, three reused, one init-task entry, no leftovers', async () => {
    const repo = bareRepo();
    const scratch = makeTemp('init-int-scratch').path;
    const startAt = Date.now() + 2500;
    const children = Array.from({ length: 4 }, (_, i) =>
      startChild(scratch, 'init', repo, 'shared', startAt, String(i)),
    );
    const codes = await Promise.all(children.map((child) => child.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    const results = children.map((child) => child.result());
    expect(results.every((r) => r?.ok === true)).toBe(true);
    expect(results.filter((r) => r?.created === true)).toHaveLength(1);
    expect(results.filter((r) => r?.created === false)).toHaveLength(3);
    expect(new Set(results.map((r) => r?.instanceId)).size).toBe(1);

    const dir = path.join(tasksRootOf(repo), 'shared');
    expect(readdirSync(dir).sort()).toEqual([
      'README.md',
      'audit',
      'config.json',
      'data',
      'instance.json',
      'logs',
      'task.json',
    ]);
    const changes = readFileSync(path.join(dir, 'audit', 'changes.md'), 'utf8');
    expect(countEntries(changes, 'init-task')).toBe(1);
    expect(countEntries(changes, 'adopt-instance')).toBe(0);
    expect(changes.match(/^# Changes$/gm)).toHaveLength(1);
    expect(stagingFolders(repo)).toEqual([]);
    expect(readdirSync(tasksRootOf(repo))).toEqual(['shared']);
  });
});

describe('T-LC-12: adoption of a legacy-created workspace', () => {
  function legacyCopy(repo: string): string {
    const dir = path.join(tasksRootOf(repo), 'legacy-demo');
    mkdirSync(path.dirname(dir), { recursive: true });
    cpSync(FIXTURE, dir, { recursive: true });
    return dir;
  }

  function expectAdopted(dir: string): void {
    for (const name of LEGACY_FILES) {
      expect(readFileSync(path.join(dir, name))).toEqual(readFileSync(path.join(FIXTURE, name)));
    }
    expect(readFileSync(path.join(dir, 'audit', 'decisions.md'))).toEqual(
      readFileSync(path.join(FIXTURE, 'audit', 'decisions.md')),
    );
    const original = readFileSync(path.join(FIXTURE, 'audit', 'changes.md'));
    const now = readFileSync(path.join(dir, 'audit', 'changes.md'));
    expect(now.subarray(0, original.length)).toEqual(original);
    expect(countEntries(now.toString('utf8'), 'adopt-instance')).toBe(1);
    expect(existsSync(path.join(dir, 'instance.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'data'))).toBe(true);
    expect(existsSync(path.join(dir, 'logs'))).toBe(true);
    expect(existsSync(path.join(dir, 'runtime.json'))).toBe(false);
  }

  it('through init', async () => {
    const repo = bareRepo();
    const dir = legacyCopy(repo);
    const first = await initWorkspace({ repo, name: 'Legacy demo task', slug: 'legacy-demo' });
    expect(first).toMatchObject({ created: false, adopted: true });
    expectAdopted(dir);
    const second = await initWorkspace({ repo, name: 'Legacy demo task', slug: 'legacy-demo' });
    expect(second).toMatchObject({ created: false, adopted: false });
    expectAdopted(dir);
  });

  it('through start (the adoption the start command performs)', async () => {
    const repo = bareRepo();
    const dir = legacyCopy(repo);
    const ws = resolveWorkspace(tasksRootOf(repo), 'legacy-demo');
    expect((await adoptWorkspace(ws)).adopted).toBe(true);
    expectAdopted(dir);
    expect((await adoptWorkspace(ws)).adopted).toBe(false);
    expectAdopted(dir);
  });

  it('two processes adopting at once: one adoption, one identity, one audit entry', async () => {
    const repo = bareRepo();
    const dir = legacyCopy(repo);
    const scratch = makeTemp('init-int-scratch').path;
    const startAt = Date.now() + 2500;
    const children = [0, 1].map((i) => startChild(scratch, 'adopt', repo, 'legacy-demo', startAt, String(i)));
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    const results = children.map((child) => child.result());
    expect(results.filter((r) => r?.adopted === true)).toHaveLength(1);
    expect(new Set(results.map((r) => r?.instanceId)).size).toBe(1);
    expectAdopted(dir);
    await waitFor(() => stagingFolders(repo).length === 0, { what: 'no staging folder' });
  });
});
