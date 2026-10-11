// Listing the workspaces of a tasks root (legacy `list_tasks`, 01 1.1) with the Node identity of each.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { newInstanceFile, writeInstanceFile } from './adopt.ts';
import { listWorkspaceSlugs, listWorkspaces } from './list.ts';
import { resolveWorkspace } from './paths.ts';

const makeTemp = useTempDirs();
const FIXTURE = fileURLToPath(new URL('../../test/fixtures/legacy-workspace/', import.meta.url));
const NOW = Date.UTC(2026, 9, 12, 8, 0, 0);
const ID = '11111111-1111-4111-8111-111111111111';

function tasksRoot(): string {
  const root = path.join(makeTemp('list').path, 'tasks');
  mkdirSync(root);
  return root;
}

function workspace(root: string, slug: string): string {
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'task.json'), `{"schema_version": 1, "id": "${slug}"}`);
  return dir;
}

describe('listWorkspaceSlugs', () => {
  it('lists, in name order, the folders with a slug name and a task.json file', async () => {
    const root = tasksRoot();
    workspace(root, 'b');
    workspace(root, 'a');
    workspace(root, 'a-1');
    workspace(root, '0lead');
    mkdirSync(path.join(root, 'no-task-json'));
    mkdirSync(path.join(root, 'with-task-dir', 'task.json'), { recursive: true });
    mkdirSync(path.join(root, 'Upper'));
    writeFileSync(path.join(root, 'Upper', 'task.json'), '{}');
    mkdirSync(path.join(root, '.init-x-123-ab12cd34'));
    writeFileSync(path.join(root, '.init-x-123-ab12cd34', 'task.json'), '{}');
    writeFileSync(path.join(root, 'plain-file'), 'x');
    expect(await listWorkspaceSlugs(root)).toEqual(['0lead', 'a', 'a-1', 'b']);
  });

  it('an absent or empty root lists nothing', async () => {
    expect(await listWorkspaceSlugs(path.join(makeTemp('list').path, 'nothing'))).toEqual([]);
    expect(await listWorkspaceSlugs(tasksRoot())).toEqual([]);
  });

  it('does not list a workspace that is a link (it can be neither read nor written)', async () => {
    const root = tasksRoot();
    const real = workspace(root, 'real');
    makeJunction(path.join(root, 'alias'), real);
    expect(await listWorkspaceSlugs(root)).toEqual(['real']);
  });
});

describe('listWorkspaces', () => {
  it('reports the Node identity of each workspace: none for a legacy one, the instance file for an adopted one', async () => {
    const root = tasksRoot();
    cpSync(FIXTURE, path.join(root, 'legacy-demo'), { recursive: true });
    workspace(root, 'adopted');
    await writeInstanceFile(
      resolveWorkspace(root, 'adopted'),
      newInstanceFile('adopted', { nowMs: NOW, instanceId: ID, engine: 'legacy' }),
    );
    const entries = await listWorkspaces(root);
    expect(entries.map((e) => [e.slug, e.instance?.instanceId ?? null, e.instance?.engine ?? null, e.problem])).toEqual(
      [
        ['adopted', ID, 'legacy', null],
        ['legacy-demo', null, null, null],
      ],
    );
    expect(entries[0]?.ws?.dir).toBe(path.join(root, 'adopted'));
  });

  it('puts a broken instance.json in the problem field instead of failing the listing', async () => {
    const root = tasksRoot();
    workspace(root, 'good');
    const broken = workspace(root, 'broken');
    writeFileSync(path.join(broken, 'instance.json'), '{"schema_version": 1');
    const copied = workspace(root, 'copied');
    writeFileSync(
      path.join(copied, 'instance.json'),
      JSON.stringify(newInstanceFile('somewhere-else', { nowMs: NOW, instanceId: ID })),
    );
    const entries = await listWorkspaces(root);
    expect(entries.map((e) => e.slug)).toEqual(['broken', 'copied', 'good']);
    expect(entries[0]?.instance).toBeNull();
    expect(entries[0]?.problem).toContain('instance.json');
    expect(entries[1]?.instance).toBeNull();
    expect(entries[1]?.problem).toContain("belongs to 'somewhere-else' but sits in 'copied'");
    expect(entries[2]?.problem).toBeNull();
  });
});
