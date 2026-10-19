// Isolation snapshots (01 3.5, 1.1): sha256 over everything below a workspace except the runtime-mutable paths.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import { makeJunction, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import {
  RUNTIME_MUTABLE_PATHS,
  changedWorkspaces,
  isRuntimeMutable,
  snapshotWorkspace,
  snapshotWorkspaces,
} from './snapshot.ts';

const makeTemp = useTempDirs();

function tasksRoot(): string {
  const root = path.join(makeTemp('snapshot').path, 'tasks');
  mkdirSync(root);
  return root;
}

function workspace(root: string, slug: string, files: Record<string, string> = {}): string {
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  const all: Record<string, string> = { 'task.json': `{"id": "${slug}"}\n`, 'config.json': '{}\n', ...files };
  for (const [rel, text] of Object.entries(all)) {
    const file = path.join(dir, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

describe('RUNTIME_MUTABLE_PATHS (01 1.1, registry 9.1)', () => {
  it('is exactly the runtime-mutable set of the workspace tree', () => {
    expect([...RUNTIME_MUTABLE_PATHS]).toEqual(['state.json', 'run/**', 'data/**', 'logs/**', '*.tmp']);
  });

  it('matches whole folders, the state file and temp files by file name, and nothing else', () => {
    for (const rel of [
      'state.json',
      'run',
      'run/control.token',
      'data',
      'data/monitor.db',
      'data/exports/.tmp-9f2.db',
      'logs/runtime.log',
      'config.json.1234.ab12cd34.tmp',
      'audit/x.tmp',
    ]) {
      expect(isRuntimeMutable(rel), rel).toBe(true);
    }
    for (const rel of [
      'config.json',
      'task.json',
      'instance.json',
      'audit/changes.md',
      'datafile',
      'logs.txt',
      'sub/state.json',
    ]) {
      expect(isRuntimeMutable(rel), rel).toBe(false);
    }
  });
});

describe('snapshotWorkspace', () => {
  it('equals the testkit snapshot with the same exclusion list (one definition of the hash)', async () => {
    const root = tasksRoot();
    const dir = workspace(root, 'a', {
      'audit/changes.md': '# Changes\n\n',
      'data/monitor.db': 'db',
      'state.json': '{}',
    });
    expect(await snapshotWorkspace(dir)).toBe(snapshotTree(dir, { exclude: RUNTIME_MUTABLE_PATHS }));
  });

  it('ignores every runtime-mutable change and sees every other change', async () => {
    const root = tasksRoot();
    const dir = workspace(root, 'a', { 'audit/changes.md': '# Changes\n\n' });
    const base = await snapshotWorkspace(dir);

    writeFileSync(path.join(dir, 'state.json'), '{"pid": 1}');
    mkdirSync(path.join(dir, 'run'));
    writeFileSync(path.join(dir, 'run', 'control.token'), 'secret');
    mkdirSync(path.join(dir, 'data', 'exports'), { recursive: true });
    writeFileSync(path.join(dir, 'data', 'exports', '.tmp-1.db'), 'x');
    mkdirSync(path.join(dir, 'logs'));
    writeFileSync(path.join(dir, 'logs', 'runtime.log'), 'line');
    writeFileSync(path.join(dir, 'config.json.1.ab12cd34.tmp'), 'half');
    expect(await snapshotWorkspace(dir)).toBe(base);

    writeFileSync(path.join(dir, 'config.json'), '{"title": "x"}\n');
    const changedConfig = await snapshotWorkspace(dir);
    expect(changedConfig).not.toBe(base);
    writeFileSync(path.join(dir, 'audit', 'changes.md'), '# Changes\n\n## x\n');
    expect(await snapshotWorkspace(dir)).not.toBe(changedConfig);
  });

  it('sees a new, a removed and a renamed file', async () => {
    const root = tasksRoot();
    const dir = workspace(root, 'a', { 'notes.txt': 'n' });
    const base = await snapshotWorkspace(dir);
    writeFileSync(path.join(dir, 'extra.txt'), '');
    const added = await snapshotWorkspace(dir);
    expect(added).not.toBe(base);
    const other = workspace(root, 'b', { 'other.txt': 'n' });
    expect(await snapshotWorkspace(other)).not.toBe(await snapshotWorkspace(dir));
  });

  it('does not follow links: a link counts by its target text, not by the content behind it', async () => {
    const root = tasksRoot();
    const dir = workspace(root, 'a');
    const outside = path.join(makeTemp('snapshot-out').path, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'one');
    makeJunction(path.join(dir, 'ln'), outside);
    const before = await snapshotWorkspace(dir);
    writeFileSync(path.join(outside, 'secret.txt'), 'two');
    expect(await snapshotWorkspace(dir)).toBe(before);
  });

  it('fails for a folder that does not exist', async () => {
    const root = tasksRoot();
    const error = await snapshotWorkspace(path.join(root, 'absent')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({ code: 'WORKSPACE_INVALID' });
  });

  it('honours a custom exclusion list', async () => {
    const root = tasksRoot();
    const dir = workspace(root, 'a', { 'notes.txt': 'n' });
    const without = await snapshotWorkspace(dir, { exclude: ['notes.txt'] });
    writeFileSync(path.join(dir, 'notes.txt'), 'changed');
    expect(await snapshotWorkspace(dir, { exclude: ['notes.txt'] })).toBe(without);
    expect(await snapshotWorkspace(dir)).not.toBe(without);
  });
});

describe('snapshotWorkspaces and changedWorkspaces', () => {
  it('hashes every workspace of the root except the named one; staging folders and plain files are not workspaces', async () => {
    const root = tasksRoot();
    workspace(root, 'a');
    workspace(root, 'b');
    workspace(root, 'c');
    mkdirSync(path.join(root, '.init-d-123-ab12cd34'));
    mkdirSync(path.join(root, 'no-task-json'));
    writeFileSync(path.join(root, 'notes.txt'), 'x');
    const all = await snapshotWorkspaces(root);
    expect([...all.keys()]).toEqual(['a', 'b', 'c']);
    const others = await snapshotWorkspaces(root, { except: 'b' });
    expect([...others.keys()]).toEqual(['a', 'c']);
    expect(others.get('a')).toBe(all.get('a'));
  });

  it('an absent tasks root has no workspaces', async () => {
    const root = path.join(makeTemp('snapshot').path, 'nothing-here');
    expect((await snapshotWorkspaces(root)).size).toBe(0);
  });

  it('reports the workspaces that changed, appeared or vanished', async () => {
    const root = tasksRoot();
    const a = workspace(root, 'a');
    workspace(root, 'b');
    const before = await snapshotWorkspaces(root);
    writeFileSync(path.join(a, 'config.json'), '{"title": "x"}\n');
    workspace(root, 'c');
    const after = await snapshotWorkspaces(root);
    expect(changedWorkspaces(before, after)).toEqual(['a', 'c']);
    expect(changedWorkspaces(after, before)).toEqual(['a', 'c']);
    expect(changedWorkspaces(before, before)).toEqual([]);
  });

  it('runtime activity of another workspace is not a change (the legacy false positive, C-2)', async () => {
    const root = tasksRoot();
    const b = workspace(root, 'b');
    workspace(root, 'a');
    const before = await snapshotWorkspaces(root, { except: 'a' });
    mkdirSync(path.join(b, 'data'), { recursive: true });
    writeFileSync(path.join(b, 'data', 'monitor.db'), 'rows');
    writeFileSync(path.join(b, 'state.json'), '{"pid": 2}');
    expect(changedWorkspaces(before, await snapshotWorkspaces(root, { except: 'a' }))).toEqual([]);
  });
});

describe('names are ordered by code point (CR-WP-14-5)', () => {
  // U+FF5E is one UTF-16 unit (0xFF5E) and U+1F600 is the pair 0xD83D 0xDE00, so the unit order puts the astral name first.
  const BMP_HIGH = String.fromCodePoint(0xff5e);
  const ASTRAL = String.fromCodePoint(0x1f600);
  const NUL = String.fromCharCode(0);

  it('hashes the entries of a folder in code point order, the same as the testkit snapshot', async () => {
    const dir = path.join(makeTemp('snapshot').path, 'astral');
    mkdirSync(dir);
    writeFileSync(path.join(dir, ASTRAL), 'x');
    writeFileSync(path.join(dir, BMP_HIGH), 'x');
    const expected = createHash('sha256');
    for (const name of [BMP_HIGH, ASTRAL]) expected.update(`f${NUL}${name}${NUL}1${NUL}`).update('x');
    expect(await snapshotWorkspace(dir)).toBe(expected.digest('hex'));
    expect(snapshotTree(dir)).toBe(await snapshotWorkspace(dir));
  });

  it('lists the changed workspaces in code point order', () => {
    const before = new Map<string, string>();
    const after = new Map([
      [ASTRAL, 'h1'],
      [BMP_HIGH, 'h2'],
      ['a', 'h3'],
    ]);
    expect(changedWorkspaces(before, after)).toEqual(['a', BMP_HIGH, ASTRAL]);
  });
});
