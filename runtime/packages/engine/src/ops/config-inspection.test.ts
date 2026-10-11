// `inspect` and `ConfigInspection` (01 6.4, I-20): the legacy keys in the legacy order, the Node keys after them, and
// `toConfigInspection` as a pure projection of the same resolved configuration.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigInspectionSchema, McsError, systemClock, toConfigInspection, type Clock } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { resolveConfig } from '../config/resolve.ts';
import type { Logger } from '../log/logger.ts';
import { resolveWorkspace } from '../workspace/paths.ts';
import { configure, inspect } from './config.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

function contextFor(repo: string, clock: Clock = new FakeClock(NOW)): OpContext {
  const skillDir = defaultSkillDir();
  return {
    repo,
    root: path.join(repo, '.claude', 'monitor', 'tasks'),
    skillDir,
    runtimeDir: path.join(skillDir, 'runtime'),
    launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
    env: {},
    clock,
    log: silent,
  };
}

function repoWith(...slugs: string[]): { repo: string; ctx: OpContext } {
  const { repo } = buildRepo(makeTemp('inspect').path);
  for (const slug of slugs) {
    buildTaskWorkspace(repo, {
      slug,
      config: { title: `Fixture ${slug}` },
      instance: { slug },
    });
  }
  return { repo, ctx: contextFor(repo) };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function valueAt(root: unknown, dotted: string): unknown {
  let cur = root;
  for (const part of dotted.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

describe('ops.config.inspect without a task', () => {
  it('lists the workspaces in the legacy line', async () => {
    const { ctx } = repoWith('b-task', 'a-task');
    const result = await inspect(ctx, {});
    expect(result.tasks).toEqual(['a-task', 'b-task']);
    expect(result.line).toBe('tasks: a-task, b-task');
  });

  it('says (none) for a repo without workspaces', async () => {
    const { ctx } = repoWith();
    expect((await inspect(ctx, {})).line).toBe('tasks: (none)');
  });
});

describe('ops.config.inspect of a task', () => {
  it('returns the legacy keys first, in the legacy order, then the Node keys', async () => {
    const { ctx } = repoWith('alpha');
    const { report } = await inspect(ctx, { task: 'alpha' });
    expect(Object.keys(report)).toEqual([
      'task',
      'dir',
      'effective',
      'provenance',
      'runtime',
      'last_change',
      'config_hash',
      'recent_audit',
      'overridden_keys',
      'inherited_keys',
      'instance',
      'runtime_effective',
      'effective_port',
      'files',
      'engine',
      'probe',
    ]);
  });

  it('reports the task file, the folder and the effective legacy configuration with an absolute repo', async () => {
    const { repo, ctx } = repoWith('alpha');
    const { report } = await inspect(ctx, { task: 'alpha' });
    expect(report.dir).toBe(path.join(ctx.root, 'alpha'));
    expect(report.task['id']).toBe('alpha');
    expect(report.effective['title']).toBe('Fixture alpha');
    expect(report.effective['port']).toBe(8765);
    expect(path.isAbsolute(String(report.effective['repo']))).toBe(true);
    expect(path.resolve(String(report.effective['repo']))).toBe(path.resolve(repo));
    expect(report.effective_port).toBe(8765);
    expect(report.engine).toBe('node');
  });

  it('computes config_hash as the first 12 hex digits of the sha1 of the key-sorted effective JSON', async () => {
    const { ctx } = repoWith('alpha');
    const { report } = await inspect(ctx, { task: 'alpha' });
    const expected = createHash('sha1')
      .update(JSON.stringify(sortKeysDeep(report.effective)))
      .digest('hex')
      .slice(0, 12);
    expect(report.config_hash).toBe(expected);
    expect(report.config_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('splits overridden and inherited keys by provenance and keeps both sorted', async () => {
    const { repo, ctx } = repoWith('alpha');
    writeFileSync(
      path.join(ctx.root, 'alpha', 'runtime.json'),
      `${JSON.stringify({ schema_version: 1, server: { port: 19000 } }, null, 2)}\n`,
    );
    const { report } = await inspect(ctx, { task: 'alpha' });
    expect(report.provenance['title']).toBe('config');
    expect(report.provenance['port']).toBe('skill');
    expect(report.provenance['server.port']).toBe('runtime');
    expect(report.overridden_keys).toContain('title');
    expect(report.overridden_keys).toContain('server.port');
    expect(report.overridden_keys).not.toContain('port');
    expect(report.inherited_keys).toContain('port');
    expect(report.inherited_keys).not.toContain('title');
    expect(report.overridden_keys).toEqual([...report.overridden_keys].sort());
    expect(report.inherited_keys).toEqual([...report.inherited_keys].sort());
    expect(report.runtime_effective['server']).toMatchObject({ port: 19000 });
    expect(report.effective_port).toBe(19000);
    expect(repo).toBeTruthy();
  });

  it('reads the last change and the recent audit from the audit trail', async () => {
    const { ctx } = repoWith('alpha');
    await configure(ctx, { task: 'alpha', set: ['port=9001'], reason: 'test' });
    const { report } = await inspect(ctx, { task: 'alpha' });
    expect(report.last_change).toEqual({ t: '2026-10-11T14:05:07Z', summary: 'port: (default 8765) -> 9001' });
    expect(report.recent_audit).toContain('## 2026-10-11T14:05:07Z | configure\n');
    expect(report.recent_audit).toContain('- Summary: port: (default 8765) -> 9001\n');
  });

  it('has no last change and an empty recent audit without an audit trail', async () => {
    const { ctx } = repoWith('alpha');
    const { report } = await inspect(ctx, { task: 'alpha' });
    expect(report.last_change).toBeNull();
    expect(report.recent_audit).toBe('');
  });

  it('shows the instance file, or null and engine legacy for a legacy-only workspace', async () => {
    const { repo, ctx } = repoWith('alpha');
    buildTaskWorkspace(repo, { slug: 'legacy-only', config: { title: 'Old' } });
    const withInstance = (await inspect(ctx, { task: 'alpha' })).report;
    expect(withInstance.instance?.slug).toBe('alpha');
    const legacy = (await inspect(ctx, { task: 'legacy-only' })).report;
    expect(legacy.instance).toBeNull();
    expect(legacy.engine).toBe('legacy');
  });

  it('reports the raw state file and a cheap probe without any network access', async () => {
    const { ctx } = repoWith('alpha');
    const stopped = (await inspect(ctx, { task: 'alpha' })).report;
    expect(stopped.runtime).toBeNull();
    expect(stopped.probe).toEqual({ state: 'stopped', pid: null, url: null });
    const state = {
      pid: 2_147_483_000,
      url: 'http://127.0.0.1:18999',
      port: 18999,
      started: 1,
      version: '3.0.0',
      task: 'alpha',
      config: null,
    };
    writeFileSync(path.join(ctx.root, 'alpha', 'state.json'), JSON.stringify(state));
    const stale = (await inspect(ctx, { task: 'alpha' })).report;
    expect(stale.runtime).toEqual(state);
    expect(stale.probe.state).toBe('legacy-stale');
    expect(stale.probe.url).toBe('http://127.0.0.1:18999');
  });

  it('uses an injected probe instead of the cheap one', async () => {
    const { ctx } = repoWith('alpha');
    const { report } = await inspect(
      ctx,
      { task: 'alpha' },
      { probe: () => Promise.resolve({ state: 'running', pid: 7, url: 'http://127.0.0.1:18998' }) },
    );
    expect(report.probe).toEqual({ state: 'running', pid: 7, url: 'http://127.0.0.1:18998' });
  });

  it('fails with the config error for an invalid config and with TASK_NOT_FOUND for an unknown task', async () => {
    const { ctx } = repoWith('alpha');
    writeFileSync(path.join(ctx.root, 'alpha', 'config.json'), '{"schema_version": 1, "port": 0}\n');
    await expect(inspect(ctx, { task: 'alpha' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(inspect(ctx, { task: 'nope' })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(inspect(ctx, { task: '../x' })).rejects.toBeInstanceOf(McsError);
  });
});

describe('ConfigInspection is a pure projection of the resolved configuration', () => {
  it('lists every provenance key except effectivePort once, sorted by code point, with the effective value', async () => {
    const { ctx } = repoWith('alpha');
    mkdirSync(path.join(ctx.root, 'alpha'), { recursive: true });
    writeFileSync(
      path.join(ctx.root, 'alpha', 'runtime.json'),
      `${JSON.stringify({ schema_version: 1, logLevel: 'debug', server: { port: 19000 } }, null, 2)}\n`,
    );
    const { report, inspection } = await inspect(ctx, { task: 'alpha' });
    const expectedKeys = Object.keys(report.provenance)
      .filter((k) => k !== 'effectivePort')
      .sort();
    expect(inspection.entries.map((e) => e.key)).toEqual(expectedKeys);
    expect(new Set(inspection.entries.map((e) => e.key)).size).toBe(inspection.entries.length);
    for (const entry of inspection.entries) {
      const root = entry.key.split('.')[0] ?? '';
      const isRuntime = Object.hasOwn(report.runtime_effective, root);
      const expected = valueAt(isRuntime ? report.runtime_effective : report.effective, entry.key);
      expect(entry.value).toEqual(expected ?? null);
      expect(entry.source).toBe(report.provenance[entry.key]);
    }
    expect(inspection.entries.find((e) => e.key === 'logLevel')).toMatchObject({ value: 'debug', source: 'runtime' });
    expect(inspection.effectivePort).toBe(19000);
    expect(inspection.files).toEqual(report.files);
    expect(inspection.engine).toBe('node');
  });

  it('validates against the shared response schema', async () => {
    const { ctx } = repoWith('alpha');
    const { inspection } = await inspect(ctx, { task: 'alpha' });
    expect(ConfigInspectionSchema.safeParse(inspection).success).toBe(true);
  });

  it('equals toConfigInspection applied to a separate resolution of the same workspace', async () => {
    const { ctx } = repoWith('alpha');
    const ws = resolveWorkspace(ctx.root, 'alpha');
    const resolved = await resolveConfig({ workspace: ws, env: {}, cli: {}, skillDir: ctx.skillDir });
    const { inspection } = await inspect(ctx, { task: 'alpha' });
    expect(inspection).toEqual(toConfigInspection(resolved, 'node'));
  });

  it('lists the four config files with their status', async () => {
    const { ctx } = repoWith('alpha');
    const { inspection } = await inspect(ctx, { task: 'alpha' });
    expect(inspection.files.map((f) => f.name)).toEqual([
      'defaults.json',
      'runtime/defaults.json',
      'config.json',
      'runtime.json',
    ]);
    expect(inspection.files.find((f) => f.name === 'runtime.json')).toMatchObject({ present: false, ok: true });
    expect(inspection.files.find((f) => f.name === 'config.json')).toMatchObject({ present: true, schemaVersion: 1 });
  });

  it('is not affected by the clock', async () => {
    const { ctx } = repoWith('alpha');
    const a = await inspect({ ...ctx, clock: systemClock }, { task: 'alpha' });
    const b = await inspect(ctx, { task: 'alpha' });
    expect(a.inspection).toEqual(b.inspection);
  });
});
