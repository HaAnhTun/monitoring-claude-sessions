// `ops.doctor.run` (01 6.4, V4): the order of the checks, the exit rule, the extension seam `extraChecks` (a provider that
// throws or hangs becomes one failed check), and that doctor writes nothing into the workspace or MCS_HOME.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DoctorReportSchema } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, snapshotTree, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import type { Logger } from '../log/logger.ts';
import { defaultSkillDir } from '../config/defaults.ts';
import { BUILTIN_CHECKS, type DoctorSeams } from './doctor-checks.ts';
import { PROVIDER_TIMEOUT_MS, doctorLines, run } from './doctor.ts';
import type { ProbeResult } from './probe.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

const STOPPED: ProbeResult = {
  state: 'stopped',
  engine: null,
  pid: null,
  url: null,
  port: null,
  identity: null,
  stateFile: null,
  stateFileBytes: null,
  reason: 'no state file',
};

/** Seams that keep the run hermetic: no real probe, no git, no icacls. */
const HERE = fileURLToPath(import.meta.url);
const SEAMS: Partial<DoctorSeams> = {
  // a source layout whose entries exist (unit tests run without a build)
  layoutOf: (runtimeDir) => ({
    mode: 'source',
    skillDir: path.dirname(runtimeDir),
    runtimeDir,
    launcherPath: HERE,
    serverEntry: HERE,
    hookEntry: HERE,
    webDir: path.dirname(HERE),
    migrationsDir: path.dirname(HERE),
    stampFile: path.join(runtimeDir, '.mcs-build.json'),
  }),
  probe: () => Promise.resolve(STOPPED),
  run: () => Promise.resolve(null),
  canBind: () => Promise.resolve(true),
};

function setup(): { ctx: OpContext; mcsHome: string; wsDir: string } {
  const root = makeTemp('doctor').path;
  const { repo, tasksRoot } = buildRepo(path.join(root, 'repo'));
  const wsDir = buildTaskWorkspace(repo, { slug: 'demo', config: { title: 'Demo' }, instance: { slug: 'demo' } });
  const mcsHome = path.join(root, 'mcs-home');
  mkdirSync(mcsHome);
  const skillDir = defaultSkillDir();
  return {
    ctx: {
      repo,
      root: tasksRoot,
      skillDir,
      runtimeDir: path.join(skillDir, 'runtime'),
      launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'), MCS_HOME: mcsHome },
      clock: new FakeClock(Date.UTC(2026, 9, 19)),
      log: silent,
    },
    mcsHome,
    wsDir,
  };
}

describe('ops.doctor.run', () => {
  it('runs every built-in check in order, validates, and writes nothing', async () => {
    const { ctx, mcsHome, wsDir } = setup();
    const before = [snapshotTree(wsDir), snapshotTree(mcsHome)];
    const report = await run(ctx, { task: 'demo' }, {}, SEAMS);
    expect(report.checks.map((c) => c.id)).toEqual(BUILTIN_CHECKS.map(([id]) => id));
    expect(DoctorReportSchema.safeParse(report).success).toBe(true);
    expect(report.task).toBe('demo');
    expect([snapshotTree(wsDir), snapshotTree(mcsHome)]).toEqual(before);
    expect(report.checks.find((c) => c.id === 'hooks')).toMatchObject({ ok: false, level: 'warn' });
    expect(doctorLines(report)).toContain('[warn] hooks: not installed or not checked');
  });

  it('is not ok iff an error-level check fails; warnings keep it ok', async () => {
    const { ctx } = setup();
    const warnOnly = await run(ctx, {}, {}, { ...SEAMS, freeBytes: () => Promise.resolve(1) });
    expect(warnOnly.checks.find((c) => c.id === 'disk.free')?.ok).toBe(false);
    expect(warnOnly.checks.filter((c) => !c.ok && c.level === 'error')).toEqual([]);
    expect(warnOnly.ok).toBe(true);
    const failing = await run(ctx, {}, {}, { ...SEAMS, nodeVersion: '20.0.0' });
    expect(failing.ok).toBe(false);
    const lines = doctorLines(failing);
    expect(lines).toContain('[FAIL] node.version: node 20.0.0 is older than 22.22.0');
    expect(lines).toContain('  fix: install Node 22.22.0 or newer');
  });

  it('without a task the workspace checks say skipped', async () => {
    const { ctx } = setup();
    const report = await run(ctx, {}, {}, SEAMS);
    expect(report.task).toBeNull();
    expect(report.checks.find((c) => c.id === 'database.integrity')?.detail).toBe('no task selected (skipped)');
  });

  it('a hooks provider replaces the default line; other providers are appended in key order', async () => {
    const { ctx } = setup();
    const report = await run(
      ctx,
      { task: 'demo' },
      {
        extraChecks: {
          'workspace.format': () => Promise.resolve({ id: 'workspace.format', ok: true, level: 'error', detail: 'v1' }),
          hooks: (_c, ws) =>
            Promise.resolve({ id: 'hooks', ok: true, level: 'warn', detail: `for ${ws?.slug ?? '-'}` }),
          'config.keys': () => Promise.resolve({ id: 'config.keys', ok: true, level: 'error', detail: 'known' }),
        },
      },
      SEAMS,
    );
    const ids = report.checks.map((c) => c.id);
    expect(ids.slice(-3)).toEqual(['hooks', 'config.keys', 'workspace.format']);
    expect(report.checks.find((c) => c.id === 'hooks')?.detail).toBe('for demo');
  });

  it('a provider that throws or hangs becomes one failed check, a built-in check that throws too', async () => {
    const { ctx } = setup();
    const started = performance.now();
    const report = await run(
      ctx,
      {},
      {
        extraChecks: {
          'a.throws': () => Promise.reject(new Error('boom')),
          'b.hangs': () => new Promise(() => undefined),
        },
      },
      {
        ...SEAMS,
        freeBytes: () => Promise.reject(new Error('statfs unsupported')),
      },
    );
    expect(performance.now() - started).toBeLessThan(PROVIDER_TIMEOUT_MS + 3000);
    expect(report.checks.find((c) => c.id === 'a.throws')).toMatchObject({ ok: false, detail: 'check failed: boom' });
    expect(report.checks.find((c) => c.id === 'b.hangs')).toMatchObject({
      ok: false,
      detail: `did not answer within ${String(PROVIDER_TIMEOUT_MS)} ms`,
    });
    expect(report.checks.find((c) => c.id === 'disk.free')).toMatchObject({
      ok: false,
      detail: 'check failed: statfs unsupported',
    });
  });

  it('a provider that answers null leaves its line out: of a built-in check and of an extra one', async () => {
    const { ctx } = setup();
    const report = await run(
      ctx,
      { task: 'demo' },
      { extraChecks: { hooks: () => Promise.resolve(null), 'app.claude': () => Promise.resolve(null) } },
      SEAMS,
    );
    const ids = report.checks.map((c) => c.id);
    expect(ids).not.toContain('hooks');
    expect(ids).not.toContain('app.claude');
    expect(ids).toEqual(BUILTIN_CHECKS.map(([id]) => id).filter((id) => id !== 'hooks'));
    expect(DoctorReportSchema.safeParse(report).success).toBe(true);
  });

  it('a provider may name its own time budget; a hang then ends at that budget, not at the default', async () => {
    const { ctx } = setup();
    const slow = Object.assign(() => new Promise<never>(() => undefined), { timeoutMs: 50 });
    const started = performance.now();
    const report = await run(ctx, {}, { extraChecks: { 'z.slow': slow } }, SEAMS);
    expect(performance.now() - started).toBeLessThan(PROVIDER_TIMEOUT_MS - 500);
    expect(report.checks.find((c) => c.id === 'z.slow')).toMatchObject({
      ok: false,
      detail: 'did not answer within 50 ms',
    });
  });

  describe('only', () => {
    const answer = (id: string) => (): Promise<{ id: string; ok: true; level: 'warn'; detail: string }> =>
      Promise.resolve({ id, ok: true, level: 'warn', detail: id });

    it('keeps the checks whose id is named exactly, in the usual order, and runs nothing else', async () => {
      const { ctx } = setup();
      let ran = 0;
      const report = await run(
        ctx,
        { only: ['claude.home', 'node.version'] },
        {},
        {
          ...SEAMS,
          freeBytes: () => {
            ran += 1;
            return Promise.resolve(1);
          },
          canBind: () => {
            ran += 1;
            return Promise.resolve(true);
          },
        },
      );
      expect(report.checks.map((c) => c.id)).toEqual(['node.version', 'claude.home']);
      expect(ran).toBe(0);
      expect(report.ok).toBe(true);
    });

    it('an entry that ends in a dot is a prefix: it selects every check of that family, built-in or extra', async () => {
      const { ctx } = setup();
      const extra = {
        'app.port': answer('app.port'),
        'app.claude': answer('app.claude'),
        'apple.pie': answer('apple.pie'),
      };
      const report = await run(ctx, { only: ['node.', 'app.'] }, { extraChecks: extra }, SEAMS);
      expect(report.checks.map((c) => c.id)).toEqual(['node.version', 'node.sqlite', 'app.claude', 'app.port']);
    });

    it('does not call a provider that is not selected, and a prefix is not a substring match', async () => {
      const { ctx } = setup();
      const called: string[] = [];
      const spy = (id: string) => (): Promise<{ id: string; ok: true; level: 'warn'; detail: string }> => {
        called.push(id);
        return Promise.resolve({ id, ok: true, level: 'warn', detail: id });
      };
      const report = await run(
        ctx,
        { only: ['app.'] },
        { extraChecks: { hooks: spy('hooks'), 'app.port': spy('app.port'), 'myapp.port': spy('myapp.port') } },
        SEAMS,
      );
      expect(called).toEqual(['app.port']);
      expect(report.checks.map((c) => c.id)).toEqual(['app.port']);
    });

    it('is ok iff no selected check failed at error level: a failure outside the selection does not count', async () => {
      const { ctx } = setup();
      const seams = { ...SEAMS, nodeVersion: '20.0.0' };
      const outside = await run(ctx, { only: ['claude.home'] }, {}, seams);
      expect(outside.ok).toBe(true);
      const inside = await run(ctx, { only: ['node.version'] }, {}, seams);
      expect(inside.ok).toBe(false);
    });

    it('a list that names nothing known gives an empty report that still validates, and an empty list selects nothing', async () => {
      const { ctx } = setup();
      for (const only of [['no.such.check'], []]) {
        const report = await run(ctx, { only }, {}, SEAMS);
        expect(report.checks).toEqual([]);
        expect(report.ok).toBe(true);
        expect(DoctorReportSchema.safeParse(report).success).toBe(true);
      }
    });

    it('without the option every check runs', async () => {
      const { ctx } = setup();
      const report = await run(ctx, {}, {}, SEAMS);
      expect(report.checks).toHaveLength(BUILTIN_CHECKS.length);
    });
  });

  it('refuses an unknown task', async () => {
    const { ctx } = setup();
    await expect(run(ctx, { task: 'nope' }, {}, SEAMS)).rejects.toThrow();
  });
});
