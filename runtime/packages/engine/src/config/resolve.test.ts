import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { McsError, R_KEY_CATALOGUE, toConfigInspection } from '@mcs/shared';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { parseJson, type JsonObject } from '../json/index.ts';
import { hostPlatform } from '../platform/host.ts';
import { defaultSkillDir } from './defaults.ts';
import { resolveConfig, type ResolveInput, type ResolvedConfig } from './resolve.ts';

const makeTemp = useTempDirs();
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');

interface Fixture {
  readonly root: string;
  readonly skill: string;
  readonly ws: string;
}

/** A throw-away skill (the shipped legacy defaults, a runtime/defaults.json) and an empty workspace folder. */
function fixture(o: { skillRuntime?: string | null; defaults?: string } = {}): Fixture {
  const root = makeTemp('cfg-resolve').path;
  const skill = path.join(root, 'skill');
  const ws = path.join(root, 'tasks', 'demo');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), o.defaults ?? SHIPPED_DEFAULTS);
  if (o.skillRuntime !== null) {
    writeFileSync(path.join(skill, 'runtime', 'defaults.json'), o.skillRuntime ?? '{"schema_version": 1}\n');
  }
  return { root, skill, ws };
}

function put(f: Fixture, name: 'task.json' | 'config.json' | 'runtime.json', value: unknown): void {
  writeFileSync(path.join(f.ws, name), typeof value === 'string' ? value : JSON.stringify(value));
}

function input(f: Fixture, o: Partial<ResolveInput> = {}): ResolveInput {
  return { workspace: { dir: f.ws }, env: {}, cli: {}, skillDir: f.skill, ...o };
}

async function failure(run: () => Promise<unknown>): Promise<McsError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof McsError) return e;
    throw e;
  }
  throw new Error('expected McsError');
}

function plainAt(root: unknown, dotted: string): unknown {
  let cur: unknown = root;
  for (const part of dotted.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function taskConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_version: 1, ...extra };
}

describe('resolution without a workspace (legacy: shared defaults only)', () => {
  it('resolves the shipped skill: source defaults, port 8765, repo is the working directory', async () => {
    const r = await resolveConfig({ workspace: null, env: {}, cli: {} });
    expect(r.source).toBe('defaults');
    expect(r.effectivePort).toBe(8765);
    expect(r.monitor.port).toBe(8765);
    expect(r.monitor.repo).toBe(path.resolve(process.cwd()));
    expect(r.monitor.title).toBe('Claude sessions monitor');
    expect(r.runtime.logLevel).toBe('info');
    expect(r.files.map((f) => `${f.name}:${String(f.present)}`)).toEqual([
      'defaults.json:true',
      'runtime/defaults.json:true',
    ]);
  });

  it('uses the layers below the workspace for provenance: every L key is skill', async () => {
    const f = fixture();
    const r = await resolveConfig(input(f, { workspace: null }));
    expect(new Set(Object.values(r.provenance))).toEqual(new Set(['skill', 'builtin']));
    expect(r.provenance['port']).toBe('skill');
    expect(r.provenance['panels.git']).toBe('skill');
    expect(r.provenance['effectivePort']).toBe('skill');
    expect(r.provenance['server.port']).toBe('builtin');
  });
});

describe('legacy layer: shared defaults, task.json and config.json', () => {
  it('merges config.json over the defaults per the C-3 rule and tags provenance', async () => {
    const f = fixture();
    put(f, 'task.json', { id: 'demo' });
    put(f, 'config.json', taskConfig({ title: 'Mine', panels: { git: false }, session_ids: ['s1'] }));
    const r = await resolveConfig(input(f));
    expect(r.source).toBe('task');
    expect(r.monitor.title).toBe('Mine');
    expect(r.monitor.panels).toEqual({
      machine: true,
      git: false,
      logs: true,
      ledger: false,
      chain_log: false,
      attempts: false,
    });
    expect(r.monitor.session_ids).toEqual(['s1']);
    expect(r.provenance['title']).toBe('config');
    expect(r.provenance['panels.git']).toBe('config');
    expect(r.provenance['panels.machine']).toBe('skill');
    expect(r.provenance['port']).toBe('skill');
    expect(r.provenance['session_ids']).toBe('config');
  });

  it('never exposes underscore keys or the legacy _source_path', async () => {
    const f = fixture();
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig({ _comment: 'kept for humans' }));
    const r = await resolveConfig(input(f));
    expect(Object.keys(r.monitor).filter((k) => k.startsWith('_'))).toEqual([]);
    expect(Object.keys(r.provenance).filter((k) => k.startsWith('_'))).toEqual([]);
  });

  it('resolves a relative repo against the workspace folder, an absolute repo as given', async () => {
    const f = fixture();
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig({ repo: '../../repo' }));
    expect((await resolveConfig(input(f))).monitor.repo).toBe(path.resolve(f.ws, '..', '..', 'repo'));
    const abs = path.join(f.root, 'elsewhere');
    put(f, 'config.json', taskConfig({ repo: abs }));
    expect((await resolveConfig(input(f))).monitor.repo).toBe(path.resolve(abs));
  });

  it('uses task.json repo only when config.json has no repo key, and only a non-empty string', async () => {
    const f = fixture();
    put(f, 'task.json', { repo: 'work/repo' });
    put(f, 'config.json', taskConfig());
    expect((await resolveConfig(input(f))).monitor.repo).toBe(path.resolve(f.ws, 'work', 'repo'));
    put(f, 'config.json', taskConfig({ repo: 'mine' }));
    expect((await resolveConfig(input(f))).monitor.repo).toBe(path.resolve(f.ws, 'mine'));
    put(f, 'task.json', { repo: '' });
    put(f, 'config.json', taskConfig());
    expect((await resolveConfig(input(f))).monitor.repo).toBe(path.resolve(f.ws, '.'));
    put(f, 'task.json', { repo: 5 });
    expect((await resolveConfig(input(f))).monitor.repo).toBe(path.resolve(f.ws, '.'));
  });

  it('refuses a missing or non-object task.json and a missing config.json (CONFIG_UNREADABLE / CONFIG_INVALID)', async () => {
    const f = fixture();
    put(f, 'config.json', taskConfig());
    expect((await failure(() => resolveConfig(input(f)))).code).toBe('CONFIG_UNREADABLE');
    put(f, 'task.json', '[1]');
    expect((await failure(() => resolveConfig(input(f)))).code).toBe('CONFIG_INVALID');
    put(f, 'task.json', {});
    const g = fixture();
    put(g, 'task.json', {});
    const e = await failure(() => resolveConfig(input(g)));
    expect(e.code).toBe('CONFIG_UNREADABLE');
    expect(e.message).toContain(path.join(g.ws, 'config.json'));
  });

  it('applies the schema gate to config.json (N-05: a flat config without schema_version is refused)', async () => {
    const f = fixture();
    put(f, 'task.json', {});
    put(f, 'config.json', { title: 'flat', port: 9000 });
    const e = await failure(() => resolveConfig(input(f)));
    expect(e.code).toBe('CONFIG_SCHEMA_MISSING');
    expect(e.message).toBe(
      `${path.join(f.ws, 'config.json')} has no schema_version; refusing to guess (add "schema_version": 1 after checking the keys against reference/configuration.md in the skill folder)`,
    );
    put(f, 'config.json', { schema_version: 2 });
    expect((await failure(() => resolveConfig(input(f)))).code).toBe('CONFIG_SCHEMA_UNSUPPORTED');
  });

  it('refuses unknown keys strictly and lists every problem in the legacy format', async () => {
    const f = fixture();
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig({ bogus: 1, port: 0, title: 5 }));
    const e = await failure(() => resolveConfig(input(f)));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toBe(
      `invalid task config ${path.join(f.ws, 'config.json')}: unknown key 'bogus'; port: expected integer 1-65535, got 0; title: expected non-empty string, got 5`,
    );
  });

  it('reports a pattern that is not JavaScript as a validation problem with the legacy line', async () => {
    const f = fixture();
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig({ session_rules: [{ match: '(' }], attempts: { start: 'a', end: '[x' } }));
    const e = await failure(() => resolveConfig(input(f)));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toContain("session_rules: invalid regex '(' (Unterminated group)");
    expect(e.message).toContain('attempts.end: invalid regex (Unterminated character class)');
    expect(e.message).not.toContain('migrate-workspace');
  });

  it('reports Python regex syntax as CONFIG_INVALID with the migration hint, listing every pattern', async () => {
    const f = fixture();
    put(f, 'task.json', {});
    put(
      f,
      'config.json',
      taskConfig({
        session_rules: [{ match: 'ok' }, { match: '(?P<n>a)' }],
        attempts: { start: '(?i)a', end: 'fine' },
      }),
    );
    const e = await failure(() => resolveConfig(input(f)));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toContain(
      "session_rules: invalid regex '(?P<n>a)' (Invalid group; this looks like Python regex syntax; run",
    );
    expect(e.message).toContain(
      'attempts.start: invalid regex (Invalid group; this looks like Python regex syntax; run',
    );
    expect(e.message).toContain('mcs migrate-workspace --task <slug>');
    expect(e.message).not.toContain("'ok'");
    expect(e.message).not.toContain('attempts.end');
  });

  it('compiles the patterns into ResolvedConfig.patterns', async () => {
    const f = fixture();
    put(f, 'task.json', {});
    put(
      f,
      'config.json',
      taskConfig({
        session_rules: [{ match: 'job-(?<n>\\d+)', label: 'Job {n}' }],
        attempts: { start: '^begin (?<id>\\w+)', end: '^done' },
      }),
    );
    const r = await resolveConfig(input(f));
    expect(r.patterns.sessionRules).toHaveLength(1);
    expect(r.patterns.sessionRules[0]?.exec('x job-12 y')?.groupdict()).toEqual({ n: '12' });
    expect(r.patterns.attempts?.start.exec('begin a9')?.groupdict()).toEqual({ id: 'a9' });
    expect((await resolveConfig(input(fixtureWith()))).patterns).toEqual({ sessionRules: [], attempts: null });
  });

  it('reports attempts.time_format problems and, on win32 only, /c/ paths as CONFIG_INVALID', async () => {
    const f = fixture();
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig({ attempts: { start: 'a', end: 'b', time_format: '%X' } }));
    const bad = await failure(() => resolveConfig(input(f)));
    expect(bad.code).toBe('CONFIG_INVALID');
    expect(bad.message).toContain('attempts.time_format: unsupported directive %X (supported: %Y %m');
    put(f, 'config.json', taskConfig({ chain_log: '/c/logs/chain.log' }));
    if (hostPlatform === 'win32') {
      const e = await failure(() => resolveConfig(input(f)));
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.message).toContain('chain_log: use C:/... instead of /c/...');
    } else {
      expect((await resolveConfig(input(f))).monitor.chain_log).toBe('/c/logs/chain.log');
    }
  });
});

function fixtureWith(config: Record<string, unknown> = {}, runtime?: Record<string, unknown>): Fixture {
  const f = fixture();
  put(f, 'task.json', {});
  put(f, 'config.json', taskConfig(config));
  if (runtime !== undefined) put(f, 'runtime.json', { schema_version: 1, ...runtime });
  return f;
}

describe('runtime layers: skill runtime/defaults.json and the instance runtime.json', () => {
  it('absent runtime.json and absent runtime/defaults.json mean the built-in defaults', async () => {
    const f = fixture({ skillRuntime: null });
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig());
    const r = await resolveConfig(input(f));
    expect(r.runtime.server.portScan).toBe(19);
    expect(r.provenance['server.portScan']).toBe('builtin');
    expect(r.files.map((x) => `${x.name}:${String(x.present)}:${String(x.ok)}:${String(x.schemaVersion)}`)).toEqual([
      'defaults.json:true:true:1',
      'runtime/defaults.json:false:true:null',
      'config.json:true:true:1',
      'runtime.json:false:true:null',
    ]);
  });

  it('merges skill, then runtime.json per sub-key, and tags each leaf with its layer', async () => {
    const f = fixture({
      skillRuntime: '{"schema_version": 1, "server": {"portScan": 3, "requestTimeoutMs": 5000}, "backup": {"keep": 2}}',
    });
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig());
    put(f, 'runtime.json', { schema_version: 1, server: { portScan: 4 }, spool: { pollMs: 250 } });
    const r = await resolveConfig(input(f));
    expect(r.runtime.server).toMatchObject({ port: null, portScan: 4, requestTimeoutMs: 5000, shutdownGraceMs: 5000 });
    expect(r.runtime.backup.keep).toBe(2);
    expect(r.runtime.spool.pollMs).toBe(250);
    expect(r.provenance['server.portScan']).toBe('runtime');
    expect(r.provenance['server.requestTimeoutMs']).toBe('skill');
    expect(r.provenance['backup.keep']).toBe('skill');
    expect(r.provenance['spool.pollMs']).toBe('runtime');
    expect(r.provenance['spool.sealGraceMs']).toBe('builtin');
    expect(r.files.find((x) => x.name === 'runtime.json')).toMatchObject({ present: true, ok: true, schemaVersion: 1 });
  });

  it('applies the schema gate to both runtime files (missing and unsupported versions)', async () => {
    const f = fixtureWith();
    put(f, 'runtime.json', { server: { portScan: 1 } });
    const missing = await failure(() => resolveConfig(input(f)));
    expect(missing.code).toBe('CONFIG_SCHEMA_MISSING');
    expect(missing.message).toContain(path.join(f.ws, 'runtime.json'));
    put(f, 'runtime.json', { schema_version: 2 });
    const unsupported = await failure(() => resolveConfig(input(f)));
    expect(unsupported.code).toBe('CONFIG_SCHEMA_UNSUPPORTED');
    expect(unsupported.hint).toContain('mcs config migrate');
    const g = fixture({ skillRuntime: '{"schema_version": 3}' });
    put(g, 'task.json', {});
    put(g, 'config.json', taskConfig());
    const skillFile = await failure(() => resolveConfig(input(g)));
    expect(skillFile.code).toBe('CONFIG_SCHEMA_UNSUPPORTED');
    expect(skillFile.message).toContain(path.join(g.skill, 'runtime', 'defaults.json'));
  });

  it('reports unknown keys and wrong values against the file as runtime.json: <path>: <zod message>', async () => {
    const f = fixtureWith({}, { server: { bogus: 1, portScan: 500 }, logLevel: 'loud', nosuch: {} });
    const e = await failure(() => resolveConfig(input(f)));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toContain('runtime.json: server: Unrecognized key: "bogus"');
    expect(e.message).toContain('runtime.json: server.portScan: ');
    expect(e.message).toContain('runtime.json: logLevel: ');
    expect(e.message).toContain('runtime.json: Unrecognized key: "nosuch"');
    expect(e.message.startsWith(`invalid runtime config ${path.join(f.ws, 'runtime.json')}: `)).toBe(true);
  });

  it('rejects a runtime.json that is not an object and an unsafe integer', async () => {
    const f = fixtureWith();
    put(f, 'runtime.json', '[]');
    expect((await failure(() => resolveConfig(input(f)))).code).toBe('CONFIG_INVALID');
    put(f, 'runtime.json', '{"schema_version": 1, "backup": {"keep": 99999999999999999999}}');
    const e = await failure(() => resolveConfig(input(f)));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toContain('runtime.json');
  });

  it('completes a partial alert rule override through the schema, and does not merge below the first level', async () => {
    const f = fixture({ skillRuntime: '{"schema_version": 1, "alerts": {"rules": {"inactivity": {"minutes": 7}}}}' });
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig());
    put(f, 'runtime.json', { schema_version: 1, alerts: { rules: { import_lag: { cooldownMinutes: 3 } } } });
    const r = await resolveConfig(input(f));
    expect(r.runtime.alerts.rules.import_lag).toEqual({ enabled: true, cooldownMinutes: 3 });
    expect(r.runtime.alerts.rules.inactivity.minutes).toBe(30);
    expect(r.provenance['alerts.rules.import_lag.cooldownMinutes']).toBe('runtime');
    expect(r.provenance['alerts.rules.inactivity.minutes']).toBe('builtin');
  });
});

describe('precedence D4: builtin < skill < config/runtime < env (MCS_LOG_LEVEL only) < cli', () => {
  it('MCS_LOG_LEVEL beats runtime.json and the skill layer; the CLI beats the environment', async () => {
    const f = fixture({ skillRuntime: '{"schema_version": 1, "logLevel": "warn"}' });
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig());
    put(f, 'runtime.json', { schema_version: 1, logLevel: 'error' });
    expect((await resolveConfig(input(f))).runtime.logLevel).toBe('error');
    expect((await resolveConfig(input(f))).provenance['logLevel']).toBe('runtime');
    const withEnv = await resolveConfig(input(f, { env: { MCS_LOG_LEVEL: 'debug' } }));
    expect(withEnv.runtime.logLevel).toBe('debug');
    expect(withEnv.provenance['logLevel']).toBe('env');
    const withCli = await resolveConfig(input(f, { env: { MCS_LOG_LEVEL: 'debug' }, cli: { logLevel: 'info' } }));
    expect(withCli.runtime.logLevel).toBe('info');
    expect(withCli.provenance['logLevel']).toBe('cli');
  });

  it('the skill layer alone is tagged skill', async () => {
    const f = fixture({ skillRuntime: '{"schema_version": 1, "logLevel": "warn"}' });
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig());
    const r = await resolveConfig(input(f));
    expect(r.runtime.logLevel).toBe('warn');
    expect(r.provenance['logLevel']).toBe('skill');
  });

  it('an invalid MCS_LOG_LEVEL is CONFIG_INVALID naming the variable; an empty one too', async () => {
    const f = fixtureWith();
    for (const bad of ['loud', 'DEBUG', '', ' info']) {
      const e = await failure(() => resolveConfig(input(f, { env: { MCS_LOG_LEVEL: bad } })));
      expect(e.code, bad).toBe('CONFIG_INVALID');
      expect(e.message, bad).toContain('MCS_LOG_LEVEL');
    }
    expect((await resolveConfig(input(f, { env: { MCS_LOG_LEVEL: undefined } }))).runtime.logLevel).toBe('info');
  });

  it('no other environment variable changes configuration (the closed list of 01 2.10)', async () => {
    const f = fixtureWith();
    const base = await resolveConfig(input(f));
    const noisy = await resolveConfig(
      input(f, {
        env: {
          MCS_PORT: '9999',
          MCS_SERVER_PORT: '9998',
          MCS_HOME: '/tmp/x',
          MCS_HOOK_DISABLE: '1',
          MCS_FS_WATCH: '0',
          CLAUDE_CONFIG_DIR: '/tmp/claude',
          PORT: '9997',
        },
      }),
    );
    expect(noisy.runtime).toEqual(base.runtime);
    expect(noisy.monitor).toEqual(base.monitor);
    expect(noisy.effectivePort).toBe(base.effectivePort);
    expect(noisy.provenance).toEqual(base.provenance);
  });

  it('validates the CLI values at the boundary', async () => {
    const f = fixtureWith();
    for (const port of [-1, 65536, 1.5, Number.NaN]) {
      const e = await failure(() => resolveConfig(input(f, { cli: { port } })));
      expect(e.code, String(port)).toBe('CONFIG_INVALID');
      expect(e.message).toContain('--port');
    }
    const e = await failure(() => resolveConfig(input(f, { cli: { logLevel: 'loud' as never } })));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toContain('--log-level');
  });
});

describe('effectivePort (01 2.1)', () => {
  it('is config.json port when nothing else is set, tagged with that layer', async () => {
    const f = fixtureWith({ port: 9100 });
    const r = await resolveConfig(input(f));
    expect(r.effectivePort).toBe(9100);
    expect(r.provenance['effectivePort']).toBe('config');
    expect(r.runtime.server.port).toBeNull();
  });

  it('server.port of runtime.json beats port; the CLI beats both; --port 0 means not given', async () => {
    const f = fixtureWith({ port: 9100 }, { server: { port: 9200 } });
    const a = await resolveConfig(input(f));
    expect(a.effectivePort).toBe(9200);
    expect(a.provenance['effectivePort']).toBe('runtime');
    const b = await resolveConfig(input(f, { cli: { port: 9300 } }));
    expect(b.effectivePort).toBe(9300);
    expect(b.provenance['effectivePort']).toBe('cli');
    const c = await resolveConfig(input(f, { cli: { port: 0 } }));
    expect(c.effectivePort).toBe(9200);
    expect(c.provenance['effectivePort']).toBe('runtime');
    expect(c.runtime.server.port).toBe(9200);
  });

  it('server.port from the skill layer is tagged skill', async () => {
    const f = fixture({ skillRuntime: '{"schema_version": 1, "server": {"port": 9400}}' });
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig());
    const r = await resolveConfig(input(f));
    expect(r.effectivePort).toBe(9400);
    expect(r.provenance['effectivePort']).toBe('skill');
  });
});

describe('derived defaults (01 1.6)', () => {
  it('fills the five derived keys from the merged legacy values, with the provenance of the legacy key', async () => {
    const f = fixtureWith({ window_hours: 12, limits: { event_window_mb: 2 }, active_seconds: 90 });
    const r = await resolveConfig(input(f));
    expect(r.runtime.import.lookbackHours).toBe(12);
    expect(r.runtime.import.tailWindowBytes).toBe(2_097_152);
    expect(r.runtime.import.backfillMaxBytes).toBe(512 * 1_048_576);
    expect(r.runtime.lifecycle.activeSeconds).toBe(90);
    expect(r.runtime.lifecycle.pendingToolGraceSeconds).toBe(900);
    expect(r.provenance['import.lookbackHours']).toBe('config');
    expect(r.provenance['import.tailWindowBytes']).toBe('config');
    expect(r.provenance['import.backfillMaxBytes']).toBe('skill');
    expect(r.provenance['lifecycle.activeSeconds']).toBe('config');
    expect(r.provenance['lifecycle.pendingToolGraceSeconds']).toBe('skill');
  });

  it('the shipped defaults give 8 hours, 8 MiB and 512 MiB, 120 s and 900 s', async () => {
    const r = await resolveConfig({ workspace: null, env: {}, cli: {} });
    expect(r.runtime.import).toMatchObject({
      lookbackHours: 8,
      tailWindowBytes: 8_388_608,
      backfillMaxBytes: 536_870_912,
    });
    expect(r.runtime.lifecycle).toMatchObject({ activeSeconds: 120, pendingToolGraceSeconds: 900 });
  });

  it('an explicit R key wins over the derivation and has the runtime provenance', async () => {
    const f = fixtureWith({ limits: { event_window_mb: 2 } }, { import: { tailWindowBytes: 4_194_304 } });
    const r = await resolveConfig(input(f));
    expect(r.runtime.import.tailWindowBytes).toBe(4_194_304);
    expect(r.provenance['import.tailWindowBytes']).toBe('runtime');
  });

  it('refuses fractional values the owner bounds reject, naming both keys and the R key to set instead', async () => {
    const f = fixtureWith({ limits: { event_window_mb: 0.5 }, window_hours: 1.5 });
    const e = await failure(() => resolveConfig(input(f)));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toMatch(
      /runtime: import\.lookbackHours derived from window_hours \(1\.5\): .+; set import\.lookbackHours in runtime\.json/,
    );
    expect(e.message).toMatch(
      /runtime: import\.tailWindowBytes derived from limits\.event_window_mb \(0\.5\): .+; set import\.tailWindowBytes in runtime\.json/,
    );
  });

  it('an explicit R key makes a refused legacy value acceptable', async () => {
    const f = fixtureWith({ window_hours: 1.5 }, { import: { lookbackHours: 2 } });
    const r = await resolveConfig(input(f));
    expect(r.runtime.import.lookbackHours).toBe(2);
    expect(r.monitor.window_hours).toBe(1.5);
  });

  it('refuses an active_seconds above the lifecycle bound', async () => {
    const f = fixtureWith({ active_seconds: 100_000 });
    const e = await failure(() => resolveConfig(input(f)));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toContain('runtime: lifecycle.activeSeconds derived from active_seconds (100000)');
    expect(e.message).toContain('set lifecycle.activeSeconds in runtime.json');
  });

  it('refuses when the shipped defaults lack the legacy value to derive from', async () => {
    const lean = JSON.parse(SHIPPED_DEFAULTS) as Record<string, unknown>;
    lean['limits'] = { max_events: 20000 };
    const f = fixture({ defaults: JSON.stringify(lean) });
    put(f, 'task.json', {});
    put(f, 'config.json', taskConfig());
    const e = await failure(() => resolveConfig(input(f)));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toContain('import.tailWindowBytes derived from limits.event_window_mb');
  });
});

describe('purity, files and the inspection projection', () => {
  it('writes nothing: the shipped defaults and the workspace are byte for byte unchanged', async () => {
    const shipped = path.join(defaultSkillDir(), 'config', 'defaults.json');
    const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
    const before = { cfg: hash(shipped), rt: hash(path.join(defaultSkillDir(), 'runtime', 'defaults.json')) };
    const f = fixtureWith({ title: 'x' }, { logLevel: 'warn' });
    const snap = (): string[] =>
      readdirSync(f.ws).map(
        (n) => `${n}:${String(statSync(path.join(f.ws, n)).size)}:${String(statSync(path.join(f.ws, n)).mtimeMs)}`,
      );
    const ws0 = snap();
    await resolveConfig(input(f));
    await resolveConfig({ workspace: null, env: {}, cli: {} });
    expect(snap()).toEqual(ws0);
    expect(hash(shipped)).toBe(before.cfg);
    expect(hash(path.join(defaultSkillDir(), 'runtime', 'defaults.json'))).toBe(before.rt);
  });

  it('returns independent objects on every call and does not mutate its input', async () => {
    const f = fixtureWith();
    const i = input(f, { env: { MCS_LOG_LEVEL: 'warn' }, cli: { port: 9000 } });
    const copy = structuredClone(i);
    const a = await resolveConfig(i);
    expect(i).toEqual(copy);
    a.monitor.panels['git'] = false;
    a.runtime.board.items.push({ key: 'x', title: 'X', match: {} });
    const b = await resolveConfig(i);
    expect(b.monitor.panels['git']).toBe(true);
    expect(b.runtime.board.items).toEqual([]);
  });

  it('lists the four files with absolute paths and the schema versions found', async () => {
    const f = fixtureWith({}, {});
    const r: ResolvedConfig = await resolveConfig(input(f));
    expect(r.files.map((x) => x.name)).toEqual([
      'defaults.json',
      'runtime/defaults.json',
      'config.json',
      'runtime.json',
    ]);
    expect(r.files.map((x) => x.path)).toEqual([
      path.join(f.skill, 'config', 'defaults.json'),
      path.join(f.skill, 'runtime', 'defaults.json'),
      path.join(f.ws, 'config.json'),
      path.join(f.ws, 'runtime.json'),
    ]);
    expect(r.files.every((x) => x.present && x.ok && x.schemaVersion === 1)).toBe(true);
  });

  it('provenance has an entry for every L default key (sub-keys for the four dicts), every R leaf and effectivePort', async () => {
    const r = await resolveConfig({ workspace: null, env: {}, cli: {} });
    for (const key of [
      'title',
      'port',
      'panels.git',
      'ui.theme',
      'poll.events_ms',
      'limits.usage_max_mb',
      'session_rules',
      'attempts',
      'docker',
    ]) {
      expect(r.provenance[key], key).toBeDefined();
    }
    for (const e of R_KEY_CATALOGUE) {
      const covered = e.key in r.provenance || Object.keys(r.provenance).some((k) => k.startsWith(`${e.key}.`));
      expect(covered, e.key).toBe(true);
    }
    expect(r.provenance['effectivePort']).toBeDefined();
    expect(Object.keys(r.provenance).filter((k) => k === 'panels' || k === 'schema_version_runtime')).toEqual([]);
  });

  it('feeds toConfigInspection: values at the provenance keys equal the resolved values', async () => {
    const f = fixtureWith({ title: 'T', panels: { git: false } }, { server: { portScan: 4 } });
    const r = await resolveConfig(input(f, { cli: { port: 9555 } }));
    const view = toConfigInspection(r, 'node');
    expect(view.effectivePort).toBe(9555);
    const by = Object.fromEntries(view.entries.map((e) => [e.key, e]));
    expect(by['title']).toEqual({ key: 'title', value: 'T', source: 'config' });
    expect(by['panels.git']).toEqual({ key: 'panels.git', value: false, source: 'config' });
    expect(by['server.portScan']).toEqual({ key: 'server.portScan', value: 4, source: 'runtime' });
    for (const e of view.entries) {
      const root = e.key.split('.')[0];
      const value = plainAt(
        [
          'logLevel',
          'server',
          'process',
          'backup',
          'lifecycle',
          'hooks',
          'ingest',
          'import',
          'spool',
          'health',
          'analytics',
          'board',
          'panelOptions',
          'retention',
          'alerts',
          'pricing',
        ].includes(root ?? '')
          ? r.runtime
          : r.monitor,
        e.key,
      );
      expect(e.value, e.key).toEqual(value);
    }
  });
});

describe('override: already parsed documents stand in for the files (CR-WP-14-4)', () => {
  function doc(value: unknown): JsonObject {
    const parsed = parseJson(JSON.stringify(value));
    if (parsed.k !== 'obj') throw new Error('expected an object');
    return parsed;
  }

  /** The names in the workspace folder with their size and mtime: a resolution must not change any of it. */
  function snapshot(f: Fixture): string[] {
    return readdirSync(f.ws).map(
      (n) => `${n}:${String(statSync(path.join(f.ws, n)).size)}:${String(statSync(path.join(f.ws, n)).mtimeMs)}`,
    );
  }

  it('resolves the given config instead of config.json, without reading or writing it', async () => {
    const f = fixtureWith({ title: 'on disk', window_hours: 4 }, { logLevel: 'warn' });
    const before = snapshot(f);
    const r = await resolveConfig(
      input(f, { override: { config: doc(taskConfig({ title: 'intended', window_hours: 12 })) } }),
    );
    expect(r.monitor.title).toBe('intended');
    expect(r.monitor.window_hours).toBe(12);
    expect(r.provenance['title']).toBe('config');
    expect(r.runtime.logLevel).toBe('warn');
    expect(snapshot(f)).toEqual(before);
    const plain = await resolveConfig(input(f));
    expect(plain.monitor.title).toBe('on disk');
  });

  it('uses the given runtime document, and null means that runtime.json does not exist', async () => {
    const f = fixtureWith({}, { logLevel: 'warn' });
    const given = await resolveConfig(
      input(f, { override: { runtime: doc({ schema_version: 1, logLevel: 'debug' }) } }),
    );
    expect(given.runtime.logLevel).toBe('debug');
    expect(given.provenance['logLevel']).toBe('runtime');
    expect(given.files.find((x) => x.name === 'runtime.json')).toMatchObject({ present: true, ok: true });
    const absent = await resolveConfig(input(f, { override: { runtime: null } }));
    expect(absent.runtime.logLevel).toBe('info');
    expect(absent.files.find((x) => x.name === 'runtime.json')).toMatchObject({ present: false, ok: true });
  });

  it('reads the file for a key that is not given', async () => {
    const f = fixtureWith({ title: 'on disk' }, { logLevel: 'warn' });
    const r = await resolveConfig(input(f, { override: {} }));
    expect(r.monitor.title).toBe('on disk');
    expect(r.runtime.logLevel).toBe('warn');
  });

  it('validates the given documents exactly like the files, and names the paths of the workspace', async () => {
    const f = fixtureWith({}, {});
    const bad = await failure(() => resolveConfig(input(f, { override: { config: doc(taskConfig({ port: 0 })) } })));
    expect(bad.code).toBe('CONFIG_INVALID');
    expect(bad.message).toContain(path.join(f.ws, 'config.json'));
    expect(bad.message).toContain('port: expected integer 1-65535, got 0');
    const gate = await failure(() => resolveConfig(input(f, { override: { config: doc({ title: 'no version' }) } })));
    expect(gate.code).toBe('CONFIG_SCHEMA_MISSING');
    const runtime = await failure(() =>
      resolveConfig(input(f, { override: { runtime: doc({ schema_version: 1, nope: true }) } })),
    );
    expect(runtime.code).toBe('CONFIG_INVALID');
    expect(runtime.message).toContain(path.join(f.ws, 'runtime.json'));
  });

  it('is ignored without a workspace', async () => {
    const r = await resolveConfig({
      workspace: null,
      env: {},
      cli: {},
      override: { config: doc(taskConfig({ title: 'x' })) },
    });
    expect(r.monitor.title).toBe('Claude sessions monitor');
  });
});
