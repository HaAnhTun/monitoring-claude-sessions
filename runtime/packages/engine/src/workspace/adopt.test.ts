// `instance.json` and the adoption of a legacy-created workspace (01 1.5, 3.2, 4.12 step 4; ADR 0001). T-LC-12 (unit
// part) and the T-ISO-21 helper (identity check of a copied workspace).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { InstanceFileSchema, McsError, RUNTIME_VERSION } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { withTaskMutex, resolveWorkspace, type WorkspaceRef } from './paths.ts';
import { adoptWorkspace, newInstanceFile, readInstanceFile, readTaskFile, writeInstanceFile } from './adopt.ts';

const makeTemp = useTempDirs();
const FIXTURE = fileURLToPath(new URL('../../test/fixtures/legacy-workspace/', import.meta.url));
const NOW = Date.UTC(2026, 9, 12, 8, 0, 0, 500);
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

function tasksRoot(): string {
  const root = path.join(makeTemp('adopt').path, 'tasks');
  mkdirSync(root);
  return root;
}

/** A copy of the workspace the legacy `init-task` made, under `<root>/<slug>`. */
function legacyWorkspace(root: string, slug = 'legacy-demo'): WorkspaceRef {
  const dir = path.join(root, slug);
  cpSync(FIXTURE, dir, { recursive: true });
  return resolveWorkspace(root, slug);
}

function read(ws: WorkspaceRef, ...rel: string[]): string {
  return readFileSync(path.join(ws.dir, ...rel), 'utf8');
}

const LEGACY_FILES = ['task.json', 'config.json', 'README.md', 'audit/changes.md', 'audit/decisions.md'] as const;

function legacyBytes(ws: WorkspaceRef): Buffer[] {
  return LEGACY_FILES.map((rel) => readFileSync(path.join(ws.dir, ...rel.split('/'))));
}

describe('newInstanceFile', () => {
  it('has the keys of InstanceFileSchema in schema order with the creation defaults', () => {
    const file = newInstanceFile('demo', { nowMs: NOW, instanceId: ID });
    // `kind` is optional and written only for the user instance (06 1.3): a task file has every other key, in order.
    expect(Object.keys(file)).toEqual(Object.keys(InstanceFileSchema.shape).filter((key) => key !== 'kind'));
    expect(file).toEqual({
      schema_version: 1,
      instanceId: ID,
      slug: 'demo',
      createdAt: '2026-10-12T08:00:00Z',
      createdBy: `mcs ${RUNTIME_VERSION}`,
      runtimeVersion: RUNTIME_VERSION,
      dbSchemaVersion: 0,
      engine: 'node',
      hooks: { enabled: false },
      upgradedAt: null,
    });
    expect(InstanceFileSchema.safeParse(file).success).toBe(true);
  });

  it('generates a version 4 uuid when no id is given and always records the node engine', () => {
    const file = newInstanceFile('demo', { nowMs: NOW });
    expect(file.engine).toBe('node');
    expect(InstanceFileSchema.safeParse(file).success).toBe(true);
    expect(InstanceFileSchema.safeParse({ ...file, engine: 'legacy' }).success).toBe(false);
    expect(newInstanceFile('demo', { nowMs: NOW }).instanceId).not.toBe(file.instanceId);
  });
});

describe('writeInstanceFile and readInstanceFile', () => {
  it('writes the Python-formatted file and reads it back', async () => {
    const root = tasksRoot();
    const ws = legacyWorkspace(root);
    const file = newInstanceFile('legacy-demo', { nowMs: NOW, instanceId: ID });
    await writeInstanceFile(ws, file);
    expect(read(ws, 'instance.json')).toBe(
      '{\n' +
        '  "schema_version": 1,\n' +
        `  "instanceId": "${ID}",\n` +
        '  "slug": "legacy-demo",\n' +
        '  "createdAt": "2026-10-12T08:00:00Z",\n' +
        `  "createdBy": "mcs ${RUNTIME_VERSION}",\n` +
        `  "runtimeVersion": "${RUNTIME_VERSION}",\n` +
        '  "dbSchemaVersion": 0,\n' +
        '  "engine": "node",\n' +
        '  "hooks": {\n    "enabled": false\n  },\n' +
        '  "upgradedAt": null\n' +
        '}\n',
    );
    expect(await readInstanceFile(ws)).toEqual(file);
  });

  it('an absent file is null', async () => {
    const ws = legacyWorkspace(tasksRoot());
    expect(await readInstanceFile(ws)).toBeNull();
  });

  it('refuses invalid JSON and a file that breaks the schema with WORKSPACE_INVALID', async () => {
    const ws = legacyWorkspace(tasksRoot());
    writeFileSync(path.join(ws.dir, 'instance.json'), '{"schema_version": 1,');
    await expect(readInstanceFile(ws)).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
    const good = newInstanceFile('legacy-demo', { nowMs: NOW, instanceId: ID });
    writeFileSync(path.join(ws.dir, 'instance.json'), JSON.stringify({ ...good, extra: 1, instanceId: 'nope' }));
    const error = await readInstanceFile(ws).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({ code: 'WORKSPACE_INVALID' });
    expect((error as McsError).message).toContain('instance.json');
    expect((error as McsError).message).toContain('instanceId');
  });

  it('T-ISO-21 helper: a copied workspace is IDENTITY_MISMATCH with the repair hint', async () => {
    const root = tasksRoot();
    const original = legacyWorkspace(root);
    await writeInstanceFile(original, newInstanceFile('legacy-demo', { nowMs: NOW, instanceId: ID }));
    cpSync(original.dir, path.join(root, 'copy'), { recursive: true });
    const copy = resolveWorkspace(root, 'copy');
    const error = await readInstanceFile(copy).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McsError);
    expect(error).toMatchObject({
      code: 'IDENTITY_MISMATCH',
      message:
        "instance.json belongs to 'legacy-demo' but sits in 'copy' (copied workspace?); run `mcs instances repair --task copy`",
      hint: 'mcs instances repair --task copy',
    });
    expect((await readInstanceFile(copy, { allowSlugMismatch: true }))?.slug).toBe('legacy-demo');
  });
});

describe('readTaskFile', () => {
  it('returns the parsed task.json when its id is the folder name', async () => {
    const ws = legacyWorkspace(tasksRoot());
    const task = await readTaskFile(ws);
    expect(task.k).toBe('obj');
    expect(task.v.find(([key]) => key === 'id')?.[1]).toEqual({ k: 'str', v: 'legacy-demo' });
  });

  it('TASK_NOT_FOUND without task.json, with the init hint', async () => {
    const root = tasksRoot();
    mkdirSync(path.join(root, 'empty'));
    const error = await readTaskFile(resolveWorkspace(root, 'empty')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'TASK_NOT_FOUND', hint: 'mcs init --slug empty' });
  });

  it('IDENTITY_MISMATCH with the legacy wording when task.json names another id', async () => {
    const ws = legacyWorkspace(tasksRoot());
    writeFileSync(path.join(ws.dir, 'task.json'), '{"schema_version": 1, "id": "other"}');
    await expect(readTaskFile(ws)).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
      message: "task.json id 'other' does not match folder 'legacy-demo'",
    });
  });

  it('refuses a task.json that is not an object', async () => {
    const ws = legacyWorkspace(tasksRoot());
    writeFileSync(path.join(ws.dir, 'task.json'), '[1]');
    await expect(readTaskFile(ws)).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
  });
});

describe('adoptWorkspace (T-LC-12, unit part)', () => {
  it('adds instance.json, data/ and logs/, audits adopt-instance once and never touches a legacy file', async () => {
    const root = tasksRoot();
    const ws = legacyWorkspace(root);
    const before = legacyBytes(ws);
    const auditBefore = readFileSync(path.join(ws.dir, 'audit', 'changes.md'));
    const result = await adoptWorkspace(ws, { clock: new FakeClock(NOW), newId: () => ID });
    expect(result.adopted).toBe(true);
    expect(result.instance).toEqual(newInstanceFile('legacy-demo', { nowMs: NOW, instanceId: ID }));

    expect(await readInstanceFile(ws)).toEqual(result.instance);
    expect(existsSync(path.join(ws.dir, 'data'))).toBe(true);
    expect(existsSync(path.join(ws.dir, 'logs'))).toBe(true);
    expect(existsSync(path.join(ws.dir, 'runtime.json'))).toBe(false);
    expect(existsSync(path.join(ws.dir, 'state.json'))).toBe(false);
    expect(readdirSync(ws.dir).sort()).toEqual([
      'README.md',
      'audit',
      'config.json',
      'data',
      'instance.json',
      'logs',
      'task.json',
    ]);

    // Legacy files byte-equal; the audit file only grew at the end.
    const after = legacyBytes(ws);
    for (const i of [0, 1, 2, 4]) expect(after[i]).toEqual(before[i]);
    const changes = after[3] ?? Buffer.alloc(0);
    expect(changes.subarray(0, auditBefore.length)).toEqual(auditBefore);
    expect(changes.subarray(auditBefore.length).toString('utf8')).toBe(
      '## 2026-10-12T08:00:00Z | adopt-instance\n' +
        "- Summary: added Node runtime files to workspace 'legacy-demo' (instance 11111111)\n" +
        '- Reason: not given\n' +
        '- Files changed: instance.json\n' +
        '- Validation: schema ok\n' +
        '- Outcome: adopted\n' +
        '- Unresolved: none\n' +
        '\n',
    );
  });

  it('is idempotent: a second call changes nothing and adds no second audit entry', async () => {
    const root = tasksRoot();
    const ws = legacyWorkspace(root);
    const first = await adoptWorkspace(ws, { clock: new FakeClock(NOW), newId: () => ID });
    const bytes = [read(ws, 'instance.json'), read(ws, 'audit', 'changes.md')];
    const second = await adoptWorkspace(ws, { clock: new FakeClock(NOW + 60_000), newId: () => ID2 });
    expect(second).toEqual({ adopted: false, instance: first.instance });
    expect([read(ws, 'instance.json'), read(ws, 'audit', 'changes.md')]).toEqual(bytes);
    expect(read(ws, 'audit', 'changes.md').match(/\| adopt-instance$/gm)).toHaveLength(1);
  });

  it('creates audit/ when the workspace has none and keeps existing data/ content', async () => {
    const root = tasksRoot();
    const dir = path.join(root, 'bare');
    mkdirSync(path.join(dir, 'data', 'spool'), { recursive: true });
    writeFileSync(path.join(dir, 'data', 'spool', 'keep.txt'), 'keep');
    writeFileSync(path.join(dir, 'task.json'), '{"schema_version": 1, "id": "bare"}');
    const ws = resolveWorkspace(root, 'bare');
    await adoptWorkspace(ws, { clock: new FakeClock(NOW), newId: () => ID });
    expect(readFileSync(path.join(dir, 'data', 'spool', 'keep.txt'), 'utf8')).toBe('keep');
    expect(read(ws, 'audit', 'changes.md').startsWith('# Changes\n\n## 2026-10-12T08:00:00Z | adopt-instance\n')).toBe(
      true,
    );
  });

  it('records the node engine in the instance file it creates', async () => {
    const ws = legacyWorkspace(tasksRoot());
    const result = await adoptWorkspace(ws, { clock: new FakeClock(NOW), newId: () => ID });
    expect(result.instance.engine).toBe('node');
    expect((await readInstanceFile(ws))?.engine).toBe('node');
  });

  it('refuses a workspace without task.json (TASK_NOT_FOUND) and creates nothing', async () => {
    const root = tasksRoot();
    mkdirSync(path.join(root, 'empty'));
    const ws = resolveWorkspace(root, 'empty');
    await expect(adoptWorkspace(ws, { clock: new FakeClock(NOW) })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(readdirSync(ws.dir)).toEqual([]);
  });

  it('refuses a task.json that names another id and a copied workspace (IDENTITY_MISMATCH); nothing is written', async () => {
    const root = tasksRoot();
    const original = legacyWorkspace(root);
    await adoptWorkspace(original, { clock: new FakeClock(NOW), newId: () => ID });
    cpSync(original.dir, path.join(root, 'copy'), { recursive: true });
    const copy = resolveWorkspace(root, 'copy');
    // task.json of the copy still says "legacy-demo": the first identity check fires.
    await expect(adoptWorkspace(copy, { clock: new FakeClock(NOW) })).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
    });
    writeFileSync(path.join(copy.dir, 'task.json'), '{"schema_version": 1, "id": "copy"}');
    const instanceBytes = read(copy, 'instance.json');
    const auditBytes = read(copy, 'audit', 'changes.md');
    await expect(adoptWorkspace(copy, { clock: new FakeClock(NOW) })).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
    });
    expect(read(copy, 'instance.json')).toBe(instanceBytes);
    expect(read(copy, 'audit', 'changes.md')).toBe(auditBytes);
  });

  it('works inside a caller that holds the task mutex', async () => {
    const ws = legacyWorkspace(tasksRoot());
    const result = await withTaskMutex(ws, () => adoptWorkspace(ws, { clock: new FakeClock(NOW), newId: () => ID }), {
      timeoutMs: 500,
    });
    expect(result.adopted).toBe(true);
  });
});

describe('kind of an instance (06 1.3)', () => {
  it('newInstanceFile writes kind only for a user instance, after engine and before hooks', () => {
    const user = newInstanceFile('user', { nowMs: NOW, instanceId: ID, kind: 'user' });
    expect(user.kind).toBe('user');
    expect(InstanceFileSchema.safeParse(user).success).toBe(true);
    expect(Object.keys(user)).toEqual(Object.keys(InstanceFileSchema.shape));
    // a task never carries the key: asked for explicitly or not at all, the file is the same bytes
    const task = newInstanceFile('demo', { nowMs: NOW, instanceId: ID, kind: 'task' });
    expect('kind' in task).toBe(false);
    expect(task).toEqual(newInstanceFile('demo', { nowMs: NOW, instanceId: ID }));
  });

  it('the file of a user instance has the kind line after the engine line; the file of a task is byte-identical to before', async () => {
    const root = tasksRoot();
    const userWs = legacyWorkspace(root, 'user');
    await writeInstanceFile(userWs, newInstanceFile('user', { nowMs: NOW, instanceId: ID, kind: 'user' }));
    expect(read(userWs, 'instance.json')).toContain('  "engine": "node",\n  "kind": "user",\n  "hooks": {');
    expect(await readInstanceFile(userWs)).toMatchObject({ kind: 'user' });

    const taskWs = legacyWorkspace(root, 'task-one');
    await writeInstanceFile(taskWs, newInstanceFile('task-one', { nowMs: NOW, instanceId: ID, kind: 'task' }));
    expect(read(taskWs, 'instance.json')).not.toContain('kind');
  });

  it('adoptWorkspace gives an adopted workspace the requested kind, and leaves an existing file alone', async () => {
    const root = tasksRoot();
    const ws = legacyWorkspace(root);
    const adopted = await adoptWorkspace(ws, { clock: new FakeClock(NOW), newId: () => ID, kind: 'user' });
    expect(adopted.adopted).toBe(true);
    expect(adopted.instance.kind).toBe('user');
    expect(read(ws, 'instance.json')).toContain('"kind": "user"');
    // a second call, even with another kind, changes nothing (the identity file is never rewritten by an adoption)
    const again = await adoptWorkspace(ws, { clock: new FakeClock(NOW + 1000), newId: () => ID2, kind: 'task' });
    expect(again).toEqual({ adopted: false, instance: adopted.instance });
  });

  it('adoptWorkspace without a kind writes a task file with no kind key', async () => {
    const ws = legacyWorkspace(tasksRoot());
    await adoptWorkspace(ws, { clock: new FakeClock(NOW), newId: () => ID });
    expect(read(ws, 'instance.json')).not.toContain('kind');
  });
});
