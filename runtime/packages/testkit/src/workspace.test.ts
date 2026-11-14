import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { InstanceFileSchema, RUNTIME_VERSION } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { FIXTURE_EPOCH_MS } from './clock.ts';
import { useTempDirs } from './temp.ts';
import { buildRepo, buildTaskWorkspace, snapshotTree } from './workspace.ts';

const tempDir = useTempDirs();

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('buildRepo', () => {
  it('returns the repo and its tasks root and writes the marker', () => {
    const root = join(tempDir('repo').path, 'FIXTURE-repo');
    const { repo, tasksRoot } = buildRepo(root);
    expect(repo).toBe(root);
    expect(tasksRoot).toBe(join(root, '.claude', 'monitor', 'tasks'));
    expect(existsSync(tasksRoot)).toBe(true);
    expect(readFileSync(join(root, 'FIXTURE.md'), 'utf8')).toContain('Synthetic test data');
  });

  it('is idempotent', () => {
    const root = join(tempDir('repo2').path, 'r');
    buildRepo(root);
    expect(() => buildRepo(root)).not.toThrow();
  });
});

describe('buildTaskWorkspace', () => {
  it('writes the legacy files: task.json, config.json, README.md (no instance.json)', () => {
    const { repo, tasksRoot } = buildRepo(join(tempDir('ws').path, 'r'));
    const ws = buildTaskWorkspace(repo, { slug: 'e2e-a', config: { title: 'FIXTURE title', window_hours: 8 } });
    expect(ws).toBe(join(tasksRoot, 'e2e-a'));
    expect(readdirSync(ws).sort()).toEqual(['README.md', 'config.json', 'task.json']);
    const task = json(join(ws, 'task.json'));
    expect(Object.keys(task)).toEqual(['schema_version', 'id', 'name', 'description', 'created', 'repo', 'links']);
    expect(task).toMatchObject({ schema_version: 1, id: 'e2e-a', name: 'FIXTURE e2e-a', links: [] });
    expect(task['created']).toBe('2026-01-01T00:00:00Z');
    expect(task['repo']).toBe('../../../..');
    const config = json(join(ws, 'config.json'));
    expect(Object.keys(config)).toEqual(['schema_version', 'title', 'window_hours']);
    expect(config['schema_version']).toBe(1);
    expect(readFileSync(join(ws, 'README.md'), 'utf8')).toMatch(/^FIXTURE/);
  });

  it('writes runtime.json only when given, with its own schema_version', () => {
    const { repo } = buildRepo(join(tempDir('ws2').path, 'r'));
    const ws = buildTaskWorkspace(repo, { slug: 'a', config: {}, runtime: { spool: { pollMs: 250 } } });
    expect(json(join(ws, 'runtime.json'))).toEqual({ schema_version: 1, spool: { pollMs: 250 } });
  });

  it('instance: {} writes a complete instance.json that InstanceFileSchema parses, in schema key order', () => {
    const { repo } = buildRepo(join(tempDir('ws3').path, 'r'));
    const ws = buildTaskWorkspace(repo, { slug: 'a', config: {}, instance: {} });
    const raw = json(join(ws, 'instance.json'));
    const parsed = InstanceFileSchema.parse(raw);
    // `kind` is written only for a user instance; a task file has no such key (06 1.3).
    expect(Object.keys(raw)).toEqual(Object.keys(InstanceFileSchema.shape).filter((key) => key !== 'kind'));
    expect(parsed).toMatchObject({
      schema_version: 1,
      slug: 'a',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: `mcs ${RUNTIME_VERSION}`,
      runtimeVersion: RUNTIME_VERSION,
      dbSchemaVersion: 0,
      engine: 'node',
      hooks: { enabled: false },
      upgradedAt: null,
    });
    expect(FIXTURE_EPOCH_MS).toBe(Date.UTC(2026, 0, 1));
  });

  it('seeds the instance id from the slug: same slug same id, other slug other id', () => {
    const { repo } = buildRepo(join(tempDir('ws4').path, 'r'));
    const a = json(join(buildTaskWorkspace(repo, { slug: 'a', config: {}, instance: {} }), 'instance.json'));
    const again = json(join(buildTaskWorkspace(repo, { slug: 'a', config: {}, instance: {} }), 'instance.json'));
    const b = json(join(buildTaskWorkspace(repo, { slug: 'b', config: {}, instance: {} }), 'instance.json'));
    expect(a['instanceId']).toBe(again['instanceId']);
    expect(a['instanceId']).not.toBe(b['instanceId']);
  });

  it('overlays the given instance fields and validates the result', () => {
    const { repo } = buildRepo(join(tempDir('ws5').path, 'r'));
    const ws = buildTaskWorkspace(repo, {
      slug: 'a',
      config: {},
      instance: { hooks: { enabled: true }, dbSchemaVersion: 3 },
    });
    expect(InstanceFileSchema.parse(json(join(ws, 'instance.json')))).toMatchObject({
      engine: 'node',
      hooks: { enabled: true },
      dbSchemaVersion: 3,
    });
    expect(() => buildTaskWorkspace(repo, { slug: 'a', config: {}, instance: { dbSchemaVersion: -1 } })).toThrow();
  });

  it('writes kind between engine and hooks when the instance is a user instance', () => {
    const { repo } = buildRepo(join(tempDir('ws5k').path, 'r'));
    const ws = buildTaskWorkspace(repo, { slug: 'a', config: {}, instance: { kind: 'user' } });
    const raw = json(join(ws, 'instance.json'));
    expect(raw['kind']).toBe('user');
    expect(Object.keys(raw)).toEqual(Object.keys(InstanceFileSchema.shape));
  });

  it('rejects slugs that are not valid workspace names', () => {
    const { repo } = buildRepo(join(tempDir('ws6').path, 'r'));
    for (const slug of ['../b', 'a/b', 'A', 'con', '', '.x']) {
      expect(() => buildTaskWorkspace(repo, { slug, config: {} }), slug).toThrow();
    }
  });

  it('refuses to write through a link at the workspace path', () => {
    const { repo, tasksRoot } = buildRepo(join(tempDir('ws7').path, 'r'));
    const elsewhere = join(tempDir('ws7b').path, 'x');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(tasksRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => buildTaskWorkspace(repo, { slug: 'linked', config: {} })).toThrow(/link/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe('snapshotTree', () => {
  it('is a hex sha256 that depends on paths and bytes', () => {
    const dir = tempDir('snap').path;
    writeFileSync(join(dir, 'a.txt'), 'one');
    const first = snapshotTree(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotTree(dir)).toBe(first);
    writeFileSync(join(dir, 'a.txt'), 'two');
    expect(snapshotTree(dir)).not.toBe(first);
  });

  it('notices renames, new files and new empty folders', () => {
    const dir = tempDir('snap2').path;
    writeFileSync(join(dir, 'a.txt'), 'one');
    const base = snapshotTree(dir);
    renameSync(join(dir, 'a.txt'), join(dir, 'b.txt'));
    const renamed = snapshotTree(dir);
    expect(renamed).not.toBe(base);
    mkdirSync(join(dir, 'empty'));
    expect(snapshotTree(dir)).not.toBe(renamed);
  });

  it('does not depend on creation order', () => {
    const one = tempDir('snap3').path;
    const two = tempDir('snap4').path;
    writeFileSync(join(one, 'a'), 'A');
    writeFileSync(join(one, 'b'), 'B');
    writeFileSync(join(two, 'b'), 'B');
    writeFileSync(join(two, 'a'), 'A');
    expect(snapshotTree(one)).toBe(snapshotTree(two));
  });

  it('excludes exact paths, folder prefixes and file name suffixes', () => {
    const dir = tempDir('snap5').path;
    mkdirSync(join(dir, 'data', 'spool'), { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{}');
    const base = snapshotTree(dir, { exclude: ['state.json', 'data/**', '*.tmp'] });
    writeFileSync(join(dir, 'state.json'), '{"pid":1}');
    writeFileSync(join(dir, 'data', 'spool', 'x.ndjson'), 'line');
    writeFileSync(join(dir, 'config.json.tmp'), 'x');
    expect(snapshotTree(dir, { exclude: ['state.json', 'data/**', '*.tmp'] })).toBe(base);
    writeFileSync(join(dir, 'config.json'), '{"a":1}');
    expect(snapshotTree(dir, { exclude: ['state.json', 'data/**', '*.tmp'] })).not.toBe(base);
  });

  it('throws for a folder that does not exist', () => {
    expect(() => snapshotTree(join(tempDir('snap6').path, 'missing'))).toThrow(/missing/);
  });
});
