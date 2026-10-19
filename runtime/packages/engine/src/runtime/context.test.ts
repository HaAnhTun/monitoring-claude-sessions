// The composition root's context (01 4.4a, slice S8): what `buildInstanceContext` reads, how its failures map onto the
// boot exit names of 4.1, and the six query deps of registry C09. Real workspace, real database, fake clock.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { McsError, RUNTIME_VERSION, isoSecondsZ, type InstanceFile } from '@mcs/shared';
import { FakeClock, makeJunction, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { claudeHomeOf } from '../ingest/transcripts/discovery.ts';
import { DbError, DB_ERROR_CODES } from '../db/errors.ts';
import { DB_OPEN_EXIT_CODES, openInstanceDb } from '../db/open.ts';
import { childStats, execFileText, resolveExecutable } from '../platform/exec.ts';
import { canonicalPath, samePath } from '../platform/paths.ts';
import type { LogFields, LogLevel, Logger } from '../log/logger.ts';
import { initWorkspace } from '../workspace/init.ts';
import { writeInstanceFile } from '../workspace/adopt.ts';
import type { WorkspaceRef } from '../workspace/paths.ts';
import {
  bindHealthGauges,
  bindOwnershipConflict,
  bindPanelStats,
  buildInstanceContext,
  buildInstanceContextWith,
  contextFactories,
  healthGaugesOf,
  mapDbOpenError,
  panelStatsOf,
  type BuildContextInput,
  type ExecApi,
  type InstanceContext,
} from './context.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const BUILD = { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' } as const;
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');
const SHIPPED_MIGRATIONS = new URL('../../migrations/', import.meta.url);

const opened: InstanceContext[] = [];

// registered after useTempDirs(): Vitest runs afterEach hooks in reverse order, so the databases close before the folders go
afterEach(() => {
  for (const ctx of opened.splice(0)) ctx.db.close();
});

interface LoggedCall {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: LogFields;
}

function fakeLogger(): { logger: Logger; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const record =
    (level: LogLevel) =>
    (event: string, fields?: LogFields): void => {
      calls.push({ level, event, fields: fields ?? {} });
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
  return { logger, calls };
}

interface Fixture {
  readonly root: string;
  readonly skill: string;
  readonly runtimeDir: string;
  readonly repo: string;
  readonly ws: WorkspaceRef;
  readonly clock: FakeClock;
  readonly calls: LoggedCall[];
  readonly input: BuildContextInput;
}

/** A throw-away skill, a repo with one initialised workspace (instance id `ID`) and the input that builds its context. */
async function fixture(o: { env?: Record<string, string | undefined>; logger?: boolean } = {}): Promise<Fixture> {
  const root = makeTemp('ctx').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => ID });
  const { logger, calls } = fakeLogger();
  const base: BuildContextInput = {
    instanceDir: ws.dir,
    env: o.env ?? { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: BUILD,
    clock,
  };
  const input: BuildContextInput = o.logger === false ? base : { ...base, logger };
  return { root, skill, runtimeDir, repo, ws, clock, calls, input };
}

async function build(fx: Fixture, over: Partial<BuildContextInput> = {}): Promise<InstanceContext> {
  const ctx = await buildInstanceContext({ ...fx.input, ...over });
  opened.push(ctx);
  return ctx;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error.code;
    throw error;
  }
  return 'RESOLVED';
}

describe('buildInstanceContext: the fields of InstanceContext', () => {
  it('reads identity, config, folders and the database of the workspace', async () => {
    const fx = await fixture();
    const ctx = await build(fx);
    expect(ctx.instanceId).toBe(ID);
    expect(ctx.slug).toBe('demo');
    expect(ctx.instanceDir).toBe(canonicalPath(fx.ws.dir));
    expect(samePath(ctx.repoDir, fx.repo)).toBe(true);
    expect(ctx.repoDir).toBe(ctx.config.monitor.repo);
    expect(ctx.skillDir).toBe(fx.skill);
    expect(ctx.runtimeDir).toBe(fx.runtimeDir);
    expect(ctx.claudeHome).toBe(path.join(fx.root, 'claude-home'));
    expect(ctx.mcsHome).toBe(path.join(fx.root, 'mcs-home'));
    expect(ctx.instance.instanceId).toBe(ID);
    expect(ctx.hooksEnabled).toBe(false);
    expect(ctx.clock).toBe(fx.clock);
    expect(ctx.scope).toEqual({ instanceId: ID });
    expect(ctx.db.instanceId).toBe(ID);
    expect(ctx.db.mode).toBe('serve');
    expect(existsSync(path.join(fx.ws.dir, 'data', 'monitor.db'))).toBe(true);
    expect(ctx.errors.list()).toEqual([]);
    expect(typeof ctx.queries).toBe('object');
  });

  it('has no workspaceDir field: every design reads ctx.instanceDir (registry C07)', async () => {
    const ctx = await build(await fixture());
    expect(Object.hasOwn(ctx, 'workspaceDir')).toBe(false);
    expect(Object.keys(ctx).sort()).toEqual(
      [
        'claudeHome',
        'clock',
        'config',
        'db',
        'errors',
        'exec',
        'hooksEnabled',
        'instance',
        'instanceDir',
        'instanceId',
        'logger',
        'mcsHome',
        'process',
        'queries',
        'repoDir',
        'runtimeDir',
        'scope',
        'skillDir',
        'slug',
      ].sort(),
    );
  });

  it('follows hooks.enabled of instance.json', async () => {
    const fx = await fixture();
    const instance: InstanceFile = {
      schema_version: 1,
      instanceId: ID,
      slug: 'demo',
      createdAt: isoSecondsZ(NOW),
      createdBy: `mcs ${RUNTIME_VERSION}`,
      runtimeVersion: RUNTIME_VERSION,
      dbSchemaVersion: 0,
      engine: 'node',
      hooks: { enabled: true },
      upgradedAt: null,
    };
    await writeInstanceFile(fx.ws, instance);
    const ctx = await build(fx);
    expect(ctx.hooksEnabled).toBe(true);
    expect(ctx.instance.hooks.enabled).toBe(true);
  });

  it('uses the CLI and environment values of config resolution (log level, port)', async () => {
    const fx = await fixture();
    const ctx = await build(fx, { cli: { port: 18123, logLevel: 'debug' } });
    expect(ctx.config.effectivePort).toBe(18123);
    expect(ctx.config.runtime.logLevel).toBe('debug');
  });

  it('creates the runtime logger itself when none is given: <workspace>/logs/runtime.log at the configured level', async () => {
    const fx = await fixture({ logger: false });
    const ctx = await build(fx);
    expect(fx.input.logger).toBeUndefined();
    ctx.logger.info('context_built', { instanceId: ID });
    ctx.logger.debug('hidden_at_info_level');
    await ctx.logger.close();
    const lines = readFileSync(path.join(fx.ws.dir, 'logs', 'runtime.log'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ event: 'context_built', level: 'info', instanceId: ID });
  });

  it('keeps a logger that the caller passes, and does not close it', async () => {
    const fx = await fixture();
    const ctx = await build(fx);
    expect(ctx.logger).toBe(fx.input.logger);
  });

  it('exposes the platform functions as ExecApi unless tests inject fakes', async () => {
    const fx = await fixture();
    const real = await build(fx);
    expect(real.exec.execFileText).toBe(execFileText);
    expect(real.exec.resolveExecutable).toBe(resolveExecutable);
    expect(real.exec.childStats).toBe(childStats);
    const fake: ExecApi = {
      execFileText: vi.fn(),
      resolveExecutable: vi.fn(),
      childStats: vi.fn(),
    };
    const injected = await build(fx, { exec: fake });
    expect(injected.exec).toBe(fake);
  });

  it('resolves claudeHome and mcsHome from the environment, an explicit input, or the home folder', async () => {
    const fx = await fixture();
    const explicit = await build(fx, { claudeHome: path.join(fx.root, 'ch2'), mcsHome: path.join(fx.root, 'mh2') });
    expect(explicit.claudeHome).toBe(path.join(fx.root, 'ch2'));
    expect(explicit.mcsHome).toBe(path.join(fx.root, 'mh2'));
    explicit.db.close();

    const fallback = await fixture({ env: { MCS_HOME: path.join(os.tmpdir(), 'mcs-home-x') } });
    const viaHome = await build(fallback);
    expect(viaHome.claudeHome).toBe(path.join(os.homedir(), '.claude'));
    // the context uses the one definition of transcript discovery
    expect(viaHome.claudeHome).toBe(claudeHomeOf({}));
    viaHome.db.close();

    const relative = await fixture({
      env: { MCS_HOME: path.join(os.tmpdir(), 'mcs-home-y'), CLAUDE_CONFIG_DIR: 'rel/claude' },
    });
    const viaRelative = await build(relative);
    expect(path.isAbsolute(viaRelative.claudeHome)).toBe(true);
    expect(viaRelative.claudeHome).toBe(path.resolve('rel/claude'));
    expect(viaRelative.claudeHome).toBe(claudeHomeOf({ CLAUDE_CONFIG_DIR: 'rel/claude' }));
  });
});

describe('buildInstanceContext: RuntimeProcessInfo', () => {
  it('takes live defaults: pid, boot time, versions, no unclean previous run, phase starting', async () => {
    const fx = await fixture();
    const ctx = await build(fx);
    expect(ctx.process.pid).toBe(process.pid);
    expect(ctx.process.startedAtMs).toBe(NOW);
    expect(ctx.process.runtimeVersion).toBe(RUNTIME_VERSION);
    expect(ctx.process.bootCodeStamp).toBe('abcdef0123');
    expect(ctx.process.previousRunUnclean).toBe(false);
    expect(ctx.process.phase()).toBe('starting');
    expect(ctx.process.ownershipConflict()).toBe(false);
  });

  it('lets the caller override any field (tests: fixed values; server: live getters)', async () => {
    const fx = await fixture();
    let phase: 'starting' | 'ready' = 'starting';
    const ctx = await build(fx, {
      processInfo: { pid: 4242, previousRunUnclean: true, phase: () => phase, ownershipConflict: () => true },
    });
    expect(ctx.process.pid).toBe(4242);
    expect(ctx.process.previousRunUnclean).toBe(true);
    expect(ctx.process.phase()).toBe('starting');
    phase = 'ready';
    expect(ctx.process.phase()).toBe('ready');
    expect(ctx.process.ownershipConflict()).toBe(true);
  });

  it('binds the ownership flag late: false until the watchdog exists, then its answer', async () => {
    const ctx = await build(await fixture());
    expect(ctx.process.ownershipConflict()).toBe(false);
    let conflict = false;
    bindOwnershipConflict(ctx, () => conflict);
    expect(ctx.process.ownershipConflict()).toBe(false);
    conflict = true;
    expect(ctx.process.ownershipConflict()).toBe(true);
    expect(() => {
      bindOwnershipConflict(ctx, () => false);
    }).toThrow(/already/);
  });

  describe('outdated() (01 5.3)', () => {
    function stamp(fx: Fixture, codeStamp: string, runtimeVersion = RUNTIME_VERSION): void {
      writeFileSync(
        path.join(fx.runtimeDir, '.mcs-build.json'),
        `${JSON.stringify({ schemaVersion: 1, runtimeVersion, buildStamp: 'f'.repeat(64), codeStamp, node: 'v24.0.0', builtAt: '2026-01-01T00:00:00.000Z' })}\n`,
      );
    }

    it('is false without a stamp file and while the stamp on disk equals the boot stamp', async () => {
      const fx = await fixture();
      const ctx = await build(fx);
      expect(ctx.process.outdated()).toEqual({ outdated: false, reason: null });
      stamp(fx, 'abcdef0123');
      fx.clock.advance(10_000);
      expect(ctx.process.outdated()).toEqual({ outdated: false, reason: null });
    });

    it('reads the disk stamp at most every 10 seconds and names the reason', async () => {
      const fx = await fixture();
      stamp(fx, 'abcdef0123');
      const ctx = await build(fx);
      expect(ctx.process.outdated().outdated).toBe(false);
      stamp(fx, '0123456789');
      fx.clock.advance(9_999);
      expect(ctx.process.outdated()).toEqual({ outdated: false, reason: null }); // still the answer of the last read
      fx.clock.advance(1);
      expect(ctx.process.outdated()).toEqual({ outdated: true, reason: 'code_stamp_changed' });
      stamp(fx, '0123456789', '3.1.0');
      fx.clock.advance(10_000);
      expect(ctx.process.outdated()).toEqual({ outdated: true, reason: 'runtime_version_changed' });
    });

    it('keeps the last answer when the stamp file disappears or is not valid', async () => {
      const fx = await fixture();
      stamp(fx, 'abcdef0123');
      const ctx = await build(fx);
      stamp(fx, '0123456789');
      fx.clock.advance(10_000);
      expect(ctx.process.outdated().outdated).toBe(true);
      rmSync(path.join(fx.runtimeDir, '.mcs-build.json'));
      fx.clock.advance(10_000);
      expect(ctx.process.outdated().outdated).toBe(true);
      writeFileSync(path.join(fx.runtimeDir, '.mcs-build.json'), '{ not json');
      fx.clock.advance(10_000);
      expect(ctx.process.outdated().outdated).toBe(true);
      stamp(fx, 'abcdef0123');
      fx.clock.advance(10_000);
      expect(ctx.process.outdated()).toEqual({ outdated: false, reason: null });
    });
  });
});

describe('buildInstanceContext: query deps (registry C09, 01 4.4a "Query deps")', () => {
  it('passes exactly the six deps to createQueries and keeps its answer as ctx.queries', async () => {
    const fx = await fixture();
    const childStatsFake = vi.fn(childStats);
    const exec: ExecApi = { execFileText, resolveExecutable, childStats: childStatsFake };
    const seen: { db: unknown; deps: unknown }[] = [];
    const queries = { tag: 'queries' };
    const ctx = await buildInstanceContextWith(
      { ...fx.input, exec },
      {
        createQueries: (db, deps) => {
          seen.push({ db, deps });
          return queries as never;
        },
      },
    );
    opened.push(ctx);
    expect(ctx.queries).toBe(queries);
    expect(seen).toHaveLength(1);
    const deps = seen[0]?.deps as Record<string, unknown>;
    expect(seen[0]?.db).toBe(ctx.db);
    expect(Object.keys(deps).sort()).toEqual([
      'audit',
      'childStats',
      'config',
      'healthGauges',
      'now',
      'panelStats',
      'process',
    ]);
    expect(deps['config']).toBe(ctx.config);
    expect(deps['process']).toBe(ctx.process);
    expect(deps['childStats']).toBe(childStatsFake);
    const now = deps['now'] as () => number;
    expect(now()).toBe(NOW);
    fx.clock.advance(5);
    expect(now()).toBe(NOW + 5); // an arrow over the clock, not a detached method
  });

  it('binds entriesBetween to this workspace and panelStats to the late getter', async () => {
    const fx = await fixture();
    let deps: Record<string, unknown> = {};
    const ctx = await buildInstanceContextWith(fx.input, {
      createQueries: (_db, d) => {
        deps = Object.fromEntries(Object.entries(d));
        return {} as never;
      },
    });
    opened.push(ctx);
    const audit = deps['audit'] as {
      entriesBetween(from: number, to: number, limit: number): Promise<{ title: string }[]>;
    };
    const refs = await audit.entriesBetween(NOW - 1000, NOW + 1000, 10);
    expect(refs.length).toBeGreaterThan(0); // `init` wrote its entry into audit/changes.md of this workspace
    expect(await audit.entriesBetween(NOW + 60_000, NOW + 120_000, 10)).toEqual([]);

    const panelStats = deps['panelStats'] as () => Record<string, unknown>;
    expect(panelStats()).toEqual({});
    expect(panelStatsOf(ctx)).toEqual({});
    const stats = { 'git.status': { refreshes: 1, failures: 0, lastDurationMs: 5, lastStatus: 'ok' } } as const;
    bindPanelStats(ctx, () => stats);
    expect(panelStats()).toBe(stats);
    expect(panelStatsOf(ctx)).toBe(stats);
  });

  it('answers zero gauges until they are bound, and follows each bound gauge (CR-WP-17-3)', async () => {
    const fx = await fixture();
    let deps: Record<string, unknown> = {};
    const ctx = await buildInstanceContextWith(fx.input, {
      createQueries: (_db, d) => {
        deps = Object.fromEntries(Object.entries(d));
        return {} as never;
      },
    });
    opened.push(ctx);
    const gauges = deps['healthGauges'] as () => unknown;
    const none = {
      sseClients: 0,
      search: { total: 0, byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 } },
    };
    expect(gauges()).toEqual(none);
    expect(healthGaugesOf(ctx)).toEqual(none);

    let open = 3;
    bindHealthGauges(ctx, { sseClients: () => open });
    expect(gauges()).toEqual({ ...none, sseClients: 3 });
    open = 0;
    expect(healthGaugesOf(ctx).sseClients).toBe(0);

    const search = { total: 5, byStoppedBy: { complete: 4, match_limit: 1, time_budget: 0, cancelled: 0 } };
    bindHealthGauges(ctx, { search: () => search });
    open = 2;
    expect(gauges()).toEqual({ sseClients: 2, search });
  });

  it('makes a gauge that answers nonsense a count: negative, fractional and non-finite values become whole numbers', async () => {
    const ctx = await build(await fixture());
    let value = -4;
    bindHealthGauges(ctx, { sseClients: () => value });
    expect(healthGaugesOf(ctx).sseClients).toBe(0);
    value = 2.9;
    expect(healthGaugesOf(ctx).sseClients).toBe(2);
    value = Number.NaN;
    expect(healthGaugesOf(ctx).sseClients).toBe(0);
    value = Number.POSITIVE_INFINITY;
    expect(healthGaugesOf(ctx).sseClients).toBe(0);
  });

  it('binds each gauge once and throws on a second bind of the same one; a context assembled by hand is ignored', async () => {
    const ctx = await build(await fixture());
    bindHealthGauges(ctx, { sseClients: () => 1 });
    expect(() => {
      bindHealthGauges(ctx, { sseClients: () => 2 });
    }).toThrow(/already/);
    expect(healthGaugesOf(ctx).sseClients).toBe(1);
    expect(() => {
      bindHealthGauges(ctx, {
        search: () => ({ total: 0, byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 } }),
      });
    }).not.toThrow();
    expect(() => {
      bindHealthGauges(ctx, {
        search: () => ({ total: 1, byStoppedBy: { complete: 1, match_limit: 0, time_budget: 0, cancelled: 0 } }),
      });
    }).toThrow(/already/);
    expect(() => {
      bindHealthGauges(ctx, {});
    }).not.toThrow();
    const byHand = { ...ctx };
    expect(() => {
      bindHealthGauges(byHand, { sseClients: () => 9 });
    }).not.toThrow();
    expect(healthGaugesOf(byHand).sseClients).toBe(0);
  });

  it('allows bindPanelStats once only, and ignores a context that was assembled by hand', async () => {
    const ctx = await build(await fixture());
    bindPanelStats(ctx, () => ({}));
    expect(() => {
      bindPanelStats(ctx, () => ({}));
    }).toThrow(/already/);
    const byHand = { ...ctx };
    expect(() => {
      bindPanelStats(byHand, () => ({}));
    }).not.toThrow();
    expect(panelStatsOf(byHand)).toEqual({});
  });
});

describe('buildInstanceContext: failures map onto the boot exit names of 01 4.1', () => {
  it('SLUG_INVALID, WORKSPACE_ESCAPE and WORKSPACE_SYMLINK become WORKSPACE_INVALID (exit 17) and keep the reason', async () => {
    const fx = await fixture();
    const tasksRoot = path.dirname(fx.ws.dir);
    const reasonOf = async (instanceDir: string): Promise<unknown> => {
      const error = await buildInstanceContext({ ...fx.input, instanceDir }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(McsError);
      if (!(error instanceof McsError)) throw new Error('expected an McsError');
      expect(error.code).toBe('WORKSPACE_INVALID');
      return error.details?.['reason'];
    };
    expect(await reasonOf(path.join(tasksRoot, 'Bad Slug'))).toBe('SLUG_INVALID');
    makeJunction(path.join(tasksRoot, 'linked'), fx.ws.dir);
    expect(await reasonOf(path.join(tasksRoot, 'linked'))).toBe('WORKSPACE_SYMLINK');
    makeJunction(path.join(tasksRoot, 'escape'), makeTemp('ctx-outside').path);
    expect(await reasonOf(path.join(tasksRoot, 'escape'))).toBe('WORKSPACE_ESCAPE');
  });

  it('a workspace without instance.json or task.json is WORKSPACE_INVALID (exit 17)', async () => {
    const fx = await fixture();
    rmSync(path.join(fx.ws.dir, 'instance.json'));
    expect(await codeOf(buildInstanceContext(fx.input))).toBe('WORKSPACE_INVALID');
    const other = await fixture();
    rmSync(path.join(other.ws.dir, 'task.json'));
    expect(await codeOf(buildInstanceContext(other.input))).toBe('WORKSPACE_INVALID');
  });

  it('the hint of a workspace without instance.json or task.json is the init option that exists: --slug', async () => {
    const fx = await fixture();
    rmSync(path.join(fx.ws.dir, 'instance.json'));
    const error = await buildInstanceContext(fx.input).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'WORKSPACE_INVALID', hint: 'mcs init --slug demo' });
    const other = await fixture();
    rmSync(path.join(other.ws.dir, 'task.json'));
    const missingTask = await buildInstanceContext(other.input).catch((e: unknown) => e);
    expect(missingTask).toMatchObject({ code: 'WORKSPACE_INVALID', hint: 'mcs init --slug demo' });
  });

  it('an instance.json of another folder, and a task.json of another id, are IDENTITY_MISMATCH (exit 11)', async () => {
    const fx = await fixture();
    const text = readFileSync(path.join(fx.ws.dir, 'instance.json'), 'utf8');
    writeFileSync(path.join(fx.ws.dir, 'instance.json'), text.replace('"slug": "demo"', '"slug": "copied"'));
    expect(await codeOf(buildInstanceContext(fx.input))).toBe('IDENTITY_MISMATCH');
    const other = await fixture();
    const task = readFileSync(path.join(other.ws.dir, 'task.json'), 'utf8');
    writeFileSync(path.join(other.ws.dir, 'task.json'), task.replace('"id": "demo"', '"id": "another"'));
    expect(await codeOf(buildInstanceContext(other.input))).toBe('IDENTITY_MISMATCH');
  });

  it('an invalid config.json, runtime.json or CLI value is CONFIG_INVALID (exit 10) and opens no database', async () => {
    const fx = await fixture();
    writeFileSync(path.join(fx.ws.dir, 'runtime.json'), '{"schema_version": 1, "server": {"portScan": "many"}}\n');
    expect(await codeOf(buildInstanceContext(fx.input))).toBe('CONFIG_INVALID');
    expect(existsSync(path.join(fx.ws.dir, 'data', 'monitor.db'))).toBe(false);

    const other = await fixture();
    expect(await codeOf(buildInstanceContext({ ...other.input, cli: { port: 99_999 } }))).toBe('CONFIG_INVALID');

    const third = await fixture();
    writeFileSync(path.join(third.ws.dir, 'config.json'), '{"schema_version": 99}\n');
    expect(await codeOf(buildInstanceContext(third.input))).toBe('CONFIG_INVALID');
  });

  it('a database of another instance is IDENTITY_MISMATCH (exit 11)', async () => {
    const fx = await fixture();
    openInstanceDb({
      path: path.join(fx.ws.dir, 'data', 'monitor.db'),
      expectedInstanceId: OTHER_ID,
      mode: 'serve',
      runtimeVersion: RUNTIME_VERSION,
    }).close();
    expect(await codeOf(buildInstanceContext(fx.input))).toBe('IDENTITY_MISMATCH');
  });

  it('a database newer than the runtime is DB_NEWER_THAN_RUNTIME (exit 15)', async () => {
    const fx = await fixture();
    const future = makeTemp('ctx-migrations').path;
    copyFileSync(fileURLToPath(new URL('0001_initial.sql', SHIPPED_MIGRATIONS)), path.join(future, '0001_initial.sql'));
    writeFileSync(
      path.join(future, '0002_future.sql'),
      '-- mcs:migration version=2 name=future\nCREATE TABLE future_probe (id INTEGER PRIMARY KEY) STRICT;\n',
    );
    openInstanceDb({
      path: path.join(fx.ws.dir, 'data', 'monitor.db'),
      expectedInstanceId: ID,
      mode: 'serve',
      runtimeVersion: RUNTIME_VERSION,
      migrationsDir: pathToFileURL(`${future}/`),
    }).close();
    expect(await codeOf(buildInstanceContext(fx.input))).toBe('DB_NEWER_THAN_RUNTIME');
  });

  it('any other failure to open the database is DB_ERROR (exit 14) and keeps the cause', async () => {
    const fx = await fixture();
    rmSync(path.join(fx.ws.dir, 'data'), { recursive: true });
    writeFileSync(path.join(fx.ws.dir, 'data'), 'a file where the folder should be');
    const error = await buildInstanceContext(fx.input).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McsError);
    expect(error instanceof McsError && error.code).toBe('DB_ERROR');
    expect(error instanceof McsError && error.cause instanceof DbError).toBe(true);
  });

  it('does not leave a database open when a later step fails (the folder can be removed at once)', async () => {
    const fx = await fixture();
    const failing = buildInstanceContextWith(fx.input, {
      createQueries: () => {
        throw new Error('query layer failed');
      },
    });
    await expect(failing).rejects.toThrow('query layer failed');
    rmSync(path.join(fx.ws.dir, 'data'), { recursive: true });
    expect(existsSync(path.join(fx.ws.dir, 'data'))).toBe(false);
  });
});

describe('mapDbOpenError (03 4.5 DB_OPEN_EXIT_CODES)', () => {
  const EXIT_NAMES = {
    11: 'IDENTITY_MISMATCH',
    14: 'DB_ERROR',
    15: 'DB_NEWER_THAN_RUNTIME',
    16: 'DB_UPGRADE_REQUIRED',
  } as const;

  it('maps every DbErrorCode to the CLI code of its boot exit code', () => {
    for (const code of DB_ERROR_CODES) {
      const mapped = mapDbOpenError(new DbError(code, 'message of the database layer'));
      expect(mapped).toBeInstanceOf(McsError);
      expect(mapped.code, code).toBe(EXIT_NAMES[DB_OPEN_EXIT_CODES[code]]);
      expect(mapped.message).toBe('message of the database layer');
    }
  });

  it('keeps the database error as the cause', () => {
    const cause = new DbError('db_busy', 'busy');
    expect(mapDbOpenError(cause).cause).toBe(cause);
  });
});

describe('buildInstanceContext: the registration of the real query layer', () => {
  // WP-17 registers `createQueries` at import time; a test restores the slot it touched
  const registered = contextFactories.createQueries;
  afterEach(() => {
    contextFactories.createQueries = registered;
  });

  it('calls the factory that the owner of the query layer registered', async () => {
    const queries = { tag: 'real query layer' };
    let calls = 0;
    contextFactories.createQueries = () => {
      calls += 1;
      return queries as never;
    };
    const ctx = await build(await fixture());
    expect(calls).toBe(1);
    expect(ctx.queries).toBe(queries);
  });
});
