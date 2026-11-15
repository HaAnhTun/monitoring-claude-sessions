// The checks of `mcs doctor` on injected seams (01 6.4, V4): every check has a passing and a failing case and a stable fix
// text; the bundle integrity check names a changed byte, a missing and an extra file; the port check treats a port held by
// this instance as free; the database check runs a read-only quick check on a copied database.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import type { DoctorCheck, InstanceFile } from '@mcs/shared';
import { FakeClock, allocatePort, buildRepo, buildTaskWorkspace, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { openSqlite } from '../db/driver.ts';
import type { Logger } from '../log/logger.ts';
import { hostPlatform } from '../platform/host.ts';
import { BUILD_STAMP_FILE, layoutOfRuntimeDir, type RuntimeLayout } from '../platform/layout.ts';
import { resolveWorkspace, type WorkspaceRef } from '../workspace/paths.ts';
import type { CheckResult } from './config.ts';
import * as checks from './doctor-checks.ts';
import type { CheckEnv, DoctorSeams } from './doctor-checks.ts';
import type { ProbeResult } from './probe.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 19, 10, 0, 0);
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

const LAYOUT: RuntimeLayout = {
  mode: 'source',
  skillDir: '/skill',
  runtimeDir: '/skill/runtime',
  launcherPath: '/skill/scripts/mcs.mjs',
  serverEntry: '/skill/runtime/server.js',
  hookEntry: '/skill/runtime/hook.js',
  webDir: '/skill/runtime/web',
  migrationsDir: '/skill/runtime/migrations',
  stampFile: '/skill/runtime/.mcs-build.json',
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

function fakeSeams(over: Partial<DoctorSeams> = {}): DoctorSeams {
  return {
    nodeVersion: '24.1.0',
    platform: hostPlatform,
    openMemoryDb: () => undefined,
    layoutOf: () => LAYOUT,
    exists: () => Promise.resolve(true),
    readFile: () => Promise.resolve(Buffer.from('')),
    readTail: () => Promise.resolve({ text: '{"a":1}\n{"b":2}\n', truncated: false }),
    listFiles: () => Promise.resolve([]),
    newestFiles: () => Promise.resolve(['/t/a.jsonl']),
    canBind: () => Promise.resolve(true),
    writable: () => Promise.resolve(true),
    freeBytes: () => Promise.resolve(10 * 1024 ** 3),
    mode: () => Promise.resolve(0o40700),
    run: () =>
      Promise.resolve({ ok: true, code: 0, stdout: '', stderr: '', error: null, truncated: false, durationMs: 1 }),
    probe: () => Promise.resolve(STOPPED),
    quickCheck: () => 'ok',
    codeStamp: () => Promise.resolve('abcdef0123'),
    ...over,
  };
}

const CONFIG: CheckResult = {
  line: '',
  title: 'T',
  repo: '/repo',
  transcripts: 'auto',
  rules: 1,
  windowHours: 8,
  panels: [],
  source: 'task',
  effectivePort: 18611,
  engine: 'node',
  regex: { checked: 2, ok: true },
};

interface Fixture {
  readonly ctx: OpContext;
  readonly ws: WorkspaceRef;
  readonly root: string;
}

function fixture(): Fixture {
  const root = makeTemp('doctor-checks').path;
  const { repo, tasksRoot } = buildRepo(path.join(root, 'repo'));
  buildTaskWorkspace(repo, { slug: 'demo', config: { title: 'Demo' }, instance: { slug: 'demo' } });
  const ctx: OpContext = {
    repo,
    root: tasksRoot,
    skillDir: path.join(root, 'skill'),
    runtimeDir: path.join(root, 'skill', 'runtime'),
    launcherPath: path.join(root, 'skill', 'scripts', 'mcs.mjs'),
    env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'), MCS_HOME: path.join(root, 'mcs-home') },
    clock: new FakeClock(NOW),
    log: silent,
  };
  return { ctx, ws: resolveWorkspace(tasksRoot, 'demo'), root };
}

function envOf(
  f: Fixture,
  seams: Partial<DoctorSeams> = {},
  o: { ws?: WorkspaceRef | null; probe?: ProbeResult; config?: () => Promise<CheckResult> } = {},
): CheckEnv {
  return {
    ctx: f.ctx,
    ws: o.ws === undefined ? f.ws : o.ws,
    seams: fakeSeams(seams),
    deps: {},
    probe: () => Promise.resolve(o.probe ?? STOPPED),
    config: o.config ?? (() => Promise.resolve(CONFIG)),
  };
}

function expectFail(check: DoctorCheck, level: DoctorCheck['level'], fix: string | RegExp): void {
  expect(check.ok).toBe(false);
  expect(check.level).toBe(level);
  expect(check.fix).toMatch(fix);
}

describe('machine-wide checks', () => {
  it('node.version passes at the floor and fails below it', async () => {
    const f = fixture();
    expect((await checks.nodeVersion(envOf(f, { nodeVersion: '22.22.0' }))).ok).toBe(true);
    expectFail(
      await checks.nodeVersion(envOf(f, { nodeVersion: '22.21.9' })),
      'error',
      'install Node 22.22.0 or newer',
    );
  });

  it('node.sqlite opens a real memory database, and fails when the driver throws', async () => {
    const f = fixture();
    expect((await checks.nodeSqlite(envOf(f, { openMemoryDb: checks.nodeDoctorSeams.openMemoryDb }))).ok).toBe(true);
    const broken = await checks.nodeSqlite(
      envOf(f, {
        openMemoryDb: () => {
          throw new Error('no such built-in module');
        },
      }),
    );
    expectFail(broken, 'error', /node:sqlite is built in/);
  });

  it('runtime.layout fails without a layout and with a missing entry', async () => {
    const f = fixture();
    expect((await checks.runtimeLayout(envOf(f))).ok).toBe(true);
    const none = await checks.runtimeLayout(
      envOf(f, {
        layoutOf: () => {
          throw new Error('no runtime layout found');
        },
      }),
    );
    expectFail(none, 'error', /reinstall the skill/);
    const missing = await checks.runtimeLayout(envOf(f, { exists: (p) => Promise.resolve(!p.endsWith('hook.js')) }));
    expectFail(missing, 'error', /reinstall the skill/);
    expect(missing.detail).toContain('hook.js');
  });

  it('claude.home warns when the folder is missing', async () => {
    const f = fixture();
    expect((await checks.claudeHome(envOf(f))).ok).toBe(true);
    expectFail(
      await checks.claudeHome(envOf(f, { exists: () => Promise.resolve(false) })),
      'warn',
      /CLAUDE_CONFIG_DIR/,
    );
  });

  it('transcripts.dir and transcripts.parse warn without a transcripts folder', async () => {
    const f = fixture();
    const e = envOf(f, {}, { ws: null });
    expectFail(await checks.transcriptsDir(e), 'warn', /mcs configure/);
    expectFail(await checks.transcriptsParse(e), 'warn', 'see transcripts.dir');
  });

  it('transcripts.parse applies the legacy threshold to the newest files', async () => {
    const f = fixture();
    const dir = path.join(f.root, 'transcripts');
    mkdirSync(dir);
    const e = (text: string): CheckEnv =>
      envOf(
        f,
        { readTail: () => Promise.resolve({ text, truncated: false }) },
        {
          config: () => Promise.resolve({ ...CONFIG, transcripts: dir }),
        },
      );
    expect((await checks.transcriptsParse(e('{"a":1}\nnot json\n'))).ok).toBe(true);
    const bad = await checks.transcriptsParse(e('x\n'.repeat(6)));
    expectFail(bad, 'warn', /session files/);
    expect(bad.detail).toBe('1 files, 6 lines, 6 unreadable');
  });

  it('mcshome.writable passes for a folder that can be created and fails when nothing is writable', async () => {
    const f = fixture();
    const created = await checks.mcsHomeWritable(envOf(f, { exists: (p) => Promise.resolve(p === f.root) }));
    expect(created).toMatchObject({ ok: true, detail: 'MCS_HOME can be created' });
    expectFail(await checks.mcsHomeWritable(envOf(f, { writable: () => Promise.resolve(false) })), 'error', /MCS_HOME/);
  });

  it('disk.free warns below 1 GiB', async () => {
    const f = fixture();
    expect((await checks.diskFree(envOf(f))).ok).toBe(true);
    expectFail(await checks.diskFree(envOf(f, { freeBytes: () => Promise.resolve(1024) })), 'warn', /free disk space/);
  });
});

describe('runtime.bundle-integrity', () => {
  function bundle(): { runtimeDir: string; f: Fixture } {
    const f = fixture();
    const runtimeDir = path.join(f.root, 'skill', 'bundle');
    mkdirSync(path.join(runtimeDir, 'web'), { recursive: true });
    const files: Record<string, string> = {
      'mcs-server.mjs': 'export {};\n',
      'mcs-cli.mjs': 'export {};\n',
      'web/index.html': '<!doctype html>\n',
    };
    const manifest: Record<string, { bytes: number; sha256: string }> = {};
    for (const [rel, text] of Object.entries(files)) {
      writeFileSync(path.join(runtimeDir, ...rel.split('/')), text);
      manifest[rel] = { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
    }
    writeFileSync(
      path.join(runtimeDir, BUILD_STAMP_FILE),
      JSON.stringify({ schemaVersion: 1, runtimeVersion: '4.0.0', buildStamp: 'x', codeStamp: 'x', files: manifest }),
    );
    return { runtimeDir, f };
  }

  function run(runtimeDir: string, f: Fixture): Promise<DoctorCheck> {
    const e = envOf(f, { ...checks.nodeDoctorSeams, layoutOf: (dir) => layoutOfRuntimeDir(dir) });
    return checks.bundleIntegrity({ ...e, ctx: { ...f.ctx, runtimeDir } });
  }

  it('passes for an unchanged bundle and skips the source layout', async () => {
    const { runtimeDir, f } = bundle();
    expect(await run(runtimeDir, f)).toMatchObject({ ok: true, detail: '3 files match the build stamp' });
    expect((await checks.bundleIntegrity(envOf(f))).detail).toBe('source layout: no bundle to verify');
  });

  it('names a changed byte, a missing and an extra file', async () => {
    const { runtimeDir, f } = bundle();
    writeFileSync(path.join(runtimeDir, 'mcs-cli.mjs'), 'export {}:\n');
    rmSync(path.join(runtimeDir, 'web', 'index.html'));
    writeFileSync(path.join(runtimeDir, 'web', 'extra.js'), '1');
    const check = await run(runtimeDir, f);
    expectFail(check, 'error', /reinstall the skill/);
    expect(check.detail).toBe('changed: mcs-cli.mjs; missing: web/index.html; extra: web/extra.js');
  });

  it('fails without a readable file list', async () => {
    const { runtimeDir, f } = bundle();
    writeFileSync(path.join(runtimeDir, BUILD_STAMP_FILE), '{"schemaVersion":1}');
    expectFail(await run(runtimeDir, f), 'error', /reinstall the skill/);
  });
});

describe('workspace checks', () => {
  it('skip without a task', async () => {
    const f = fixture();
    const e = envOf(f, {}, { ws: null });
    for (const check of [
      checks.portFree,
      checks.workspaceWritable,
      checks.instanceIdentity,
      checks.databaseIntegrity,
      checks.stateCurrent,
      checks.runtimeOutdated,
      checks.workspaceGitignored,
      checks.workspacePermissions,
    ]) {
      expect(await check(e)).toMatchObject({ ok: true, detail: 'no task selected (skipped)' });
    }
  });

  it('config.valid fails with the message of the configuration check', async () => {
    const f = fixture();
    expect((await checks.configValid(envOf(f))).ok).toBe(true);
    const bad = await checks.configValid(
      envOf(f, {}, { config: () => Promise.reject(new Error('window_hours: bad')) }),
    );
    expectFail(bad, 'error', 'mcs check --task demo, then fix the file it names');
    expect(bad.detail).toBe('window_hours: bad');
  });

  it('port.free: a port held by this instance is free, one held by a foreign process fails', async () => {
    const f = fixture();
    const running: ProbeResult = { ...STOPPED, state: 'running', port: 18611, pid: 7, url: 'http://127.0.0.1:18611' };
    const held = await checks.portFree(envOf(f, { canBind: () => Promise.resolve(false) }, { probe: running }));
    expect(held).toMatchObject({ ok: true, detail: 'port 18611 is held by this instance' });
    const foreign = await checks.portFree(envOf(f, { canBind: () => Promise.resolve(false) }));
    expectFail(
      foreign,
      'warn',
      'stop the other process, or choose another port: mcs configure --task demo --set port=<n>',
    );
  });

  it('port.free binds the real port and never connects', async () => {
    const f = fixture();
    const port = await allocatePort();
    const config = (): Promise<CheckResult> => Promise.resolve({ ...CONFIG, effectivePort: port });
    const real = { canBind: checks.nodeDoctorSeams.canBind };
    expect((await checks.portFree(envOf(f, real, { config }))).ok).toBe(true);
    let connections = 0;
    const holder = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => holder.listen({ host: '127.0.0.1', port }, resolve));
    try {
      expect((await checks.portFree(envOf(f, real, { config }))).ok).toBe(false);
      expect(connections).toBe(0);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  it('workspace.writable fails for a read-only folder', async () => {
    const f = fixture();
    expect((await checks.workspaceWritable(envOf(f))).ok).toBe(true);
    expectFail(
      await checks.workspaceWritable(envOf(f, { writable: () => Promise.resolve(false) })),
      'error',
      /write access/,
    );
  });

  it('instance.identity: missing warns, a copied workspace fails with the repair command', async () => {
    const f = fixture();
    expect((await checks.instanceIdentity(envOf(f))).ok).toBe(true);
    const copy = path.join(f.ctx.root, 'copy');
    mkdirSync(copy);
    for (const name of ['task.json', 'config.json', 'instance.json']) {
      copyFileSync(path.join(f.ws.dir, name), path.join(copy, name));
    }
    const copied = await checks.instanceIdentity(envOf(f, {}, { ws: resolveWorkspace(f.ctx.root, 'copy') }));
    expectFail(copied, 'error', 'mcs instances repair --task copy');
    rmSync(path.join(copy, 'instance.json'));
    const missing = await checks.instanceIdentity(envOf(f, {}, { ws: resolveWorkspace(f.ctx.root, 'copy') }));
    expectFail(missing, 'warn', 'mcs init --slug copy');
  });

  it('database.integrity runs a read-only quick check of a copied database', async () => {
    const f = fixture();
    const real = { quickCheck: checks.nodeDoctorSeams.quickCheck, exists: checks.nodeDoctorSeams.exists };
    expect(await checks.databaseIntegrity(envOf(f, real))).toMatchObject({ ok: true, detail: 'no database yet' });
    const source = path.join(f.root, 'source.db');
    const db = openSqlite(source, { readonly: false, fileMustExist: false, timeoutMs: 1000 });
    db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)');
    db.close();
    mkdirSync(path.join(f.ws.dir, 'data'), { recursive: true });
    const target = path.join(f.ws.dir, 'data', 'monitor.db');
    copyFileSync(source, target);
    expect(await checks.databaseIntegrity(envOf(f, real))).toMatchObject({ ok: true, detail: 'quick_check ok' });
    writeFileSync(target, 'not a database at all, just text that is long enough to be a header'.repeat(10));
    expectFail(
      await checks.databaseIntegrity(envOf(f, real)),
      'error',
      'mcs stop --task demo, then restore a backup or rebuild the database',
    );
  });

  it('state.current: stale and unhealthy fail with their fix', async () => {
    const f = fixture();
    expect((await checks.stateCurrent(envOf(f))).ok).toBe(true);
    expectFail(
      await checks.stateCurrent(envOf(f, {}, { probe: { ...STOPPED, state: 'stale' } })),
      'warn',
      'mcs stop --task demo',
    );
    expectFail(
      await checks.stateCurrent(envOf(f, {}, { probe: { ...STOPPED, state: 'unhealthy' } })),
      'warn',
      'mcs restart --task demo',
    );
  });

  it('runtime.outdated warns when the running code stamp differs from the one on disk', async () => {
    const f = fixture();
    const identity = { codeStamp: 'abcdef0123' } as ProbeResult['identity'];
    const running: ProbeResult = { ...STOPPED, state: 'running', identity };
    expect((await checks.runtimeOutdated(envOf(f, {}, { probe: running }))).ok).toBe(true);
    const changed = await checks.runtimeOutdated(
      envOf(f, { codeStamp: () => Promise.resolve('0000000000') }, { probe: running }),
    );
    expectFail(changed, 'warn', 'mcs restart --task demo');
  });

  it('workspace.gitignored: ignored passes, not ignored and no git warn', async () => {
    const f = fixture();
    const result = (code: number) => () =>
      Promise.resolve({ ok: code === 0, code, stdout: '', stderr: '', error: null, truncated: false, durationMs: 1 });
    expect((await checks.workspaceGitignored(envOf(f, { run: result(0) }))).ok).toBe(true);
    expectFail(await checks.workspaceGitignored(envOf(f, { run: result(1) })), 'warn', /\.gitignore/);
    expectFail(
      await checks.workspaceGitignored(envOf(f, { run: () => Promise.resolve(null) })),
      'warn',
      'install git to check this',
    );
  });

  it('workspace.permissions: POSIX group or world write and a Windows grant to Users warn', async () => {
    const f = fixture();
    expect((await checks.workspacePermissions(envOf(f, { platform: 'linux' }))).ok).toBe(true);
    expectFail(
      await checks.workspacePermissions(envOf(f, { platform: 'linux', mode: () => Promise.resolve(0o40777) })),
      'warn',
      /chmod -R go-w/,
    );
    const icacls = (stdout: string) => () =>
      Promise.resolve({ ok: true, code: 0, stdout, stderr: '', error: null, truncated: false, durationMs: 1 });
    const own = 'C:\\w NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\r\n';
    expect((await checks.workspacePermissions(envOf(f, { platform: 'win32', run: icacls(own) }))).ok).toBe(true);
    const open = `${own}    NT AUTHORITY\\Authenticated Users:(I)(OI)(CI)(M)\r\n`;
    const check = await checks.workspacePermissions(envOf(f, { platform: 'win32', run: icacls(open) }));
    expectFail(check, 'warn', /icacls/);
    expect(check.detail).toContain('Authenticated Users');
  });

  it('hooks: the default line is a warning', async () => {
    const f = fixture();
    expect(await checks.hooksDefault(envOf(f))).toMatchObject({
      ok: false,
      level: 'warn',
      detail: 'not installed or not checked',
    });
  });
});

describe('an instance that reads every project (CAW design 03 2.3)', () => {
  interface Scene {
    readonly f: Fixture;
    readonly projects: string;
    /** The check environment of the workspace, with the real defaults of the skill so that its configuration resolves. */
    env(seams?: Partial<DoctorSeams>, over?: { ws?: WorkspaceRef | null }): CheckEnv;
  }

  /** A workspace with the given `runtime.json` and `instance.json` keys, in a Claude home of its own. */
  function scene(o: { runtime?: Record<string, unknown>; instance?: Partial<InstanceFile> } = {}): Scene {
    const root = makeTemp('doctor-scope').path;
    const { repo, tasksRoot } = buildRepo(path.join(root, 'repo'));
    buildTaskWorkspace(repo, {
      slug: 'demo',
      config: { title: 'Demo' },
      instance: { slug: 'demo', ...o.instance },
      ...(o.runtime === undefined ? {} : { runtime: o.runtime }),
    });
    const claudeHome = path.join(root, 'claude-home');
    const ctx: OpContext = {
      repo,
      root: tasksRoot,
      skillDir: defaultSkillDir(),
      runtimeDir: path.join(root, 'skill', 'runtime'),
      launcherPath: path.join(root, 'skill', 'scripts', 'mcs.mjs'),
      env: { CLAUDE_CONFIG_DIR: claudeHome, MCS_HOME: path.join(root, 'mcs-home') },
      clock: new FakeClock(NOW),
      log: silent,
    };
    const f: Fixture = { ctx, ws: resolveWorkspace(tasksRoot, 'demo'), root };
    return {
      f,
      projects: path.join(claudeHome, 'projects'),
      env: (seams = {}, over = {}) => envOf(f, seams, { ws: over.ws === undefined ? f.ws : over.ws }),
    };
  }

  const ALL = { projects: { scope: 'all' } };
  const USER: Partial<InstanceFile> = { kind: 'user' };
  const HOOKS_ON: Partial<InstanceFile> = { hooks: { enabled: true } };

  describe('transcripts.dir', () => {
    it('passes when the projects folder of the Claude home exists, for the user instance and for a key that says all', async () => {
      for (const o of [{ instance: USER }, { runtime: ALL }]) {
        const s = scene(o);
        const e = s.env({ exists: (p) => Promise.resolve(p === s.projects) });
        const check = await checks.transcriptsDir(e);
        expect(check.ok).toBe(true);
        expect(check.detail).toContain('every project');
      }
    });

    it('warns when that folder is missing, and says so for the Claude home, not for a repository', async () => {
      const s = scene({ instance: USER });
      const check = await checks.transcriptsDir(s.env({ exists: () => Promise.resolve(false) }));
      expectFail(check, 'warn', /Claude Code once/);
      expect(check.detail).not.toContain('repository');
    });

    it('does not look for the folder of a repository in this scope', async () => {
      const s = scene({ instance: USER });
      // the folder named like the repository does not exist, and the check still passes
      expect((await checks.transcriptsDir(s.env({ exists: (p) => Promise.resolve(p === s.projects) }))).ok).toBe(true);
    });

    it('stays as it was for a task instance and for a user instance pinned to its repository', async () => {
      for (const o of [{}, { instance: USER, runtime: { projects: { scope: 'repo' } } }]) {
        const s = scene(o);
        expectFail(
          await checks.transcriptsDir(s.env({ exists: (p) => Promise.resolve(p === s.projects) })),
          'warn',
          /mcs configure/,
        );
      }
    });

    it('stays as it was without a task, or when the configuration does not resolve', async () => {
      const s = scene({ instance: USER });
      expectFail(await checks.transcriptsDir(s.env({}, { ws: null })), 'warn', /mcs configure/);
      const broken: CheckEnv = { ...s.env(), ctx: { ...s.f.ctx, skillDir: path.join(s.f.root, 'no-skill') } };
      expectFail(await checks.transcriptsDir(broken), 'warn', /mcs configure/);
    });
  });

  describe('transcripts.parse', () => {
    const lines = '{"a":1}\n{"b":2}\n';
    const seams = (projects: string, newest: string | null): Partial<DoctorSeams> => ({
      newestFiles: (dir, extension) => {
        if (dir === projects && extension === '') return Promise.resolve(newest === null ? [] : [newest]);
        const listed = newest !== null && dir === newest && extension === '.jsonl';
        return Promise.resolve(listed ? [path.join(dir, 'a.jsonl')] : []);
      },
      readTail: () => Promise.resolve({ text: lines, truncated: false }),
    });

    it('reads the newest files of the newest project folder', async () => {
      const s = scene({ instance: USER });
      const newest = path.join(s.projects, 'D--work-alpha');
      const check = await checks.transcriptsParse(s.env(seams(s.projects, newest)));
      expect(check).toMatchObject({ ok: true, detail: '1 files, 2 lines, 0 unreadable' });
    });

    it('passes with nothing to read while there is no project folder yet, or when the folder cannot be listed', async () => {
      const s = scene({ instance: USER });
      expect(await checks.transcriptsParse(s.env(seams(s.projects, null)))).toMatchObject({
        ok: true,
        detail: '0 files, 0 lines, 0 unreadable',
      });
      const failing = s.env({ newestFiles: () => Promise.reject(new Error('ENOTDIR')) });
      expect((await checks.transcriptsParse(failing)).ok).toBe(true);
    });

    it('is the legacy check for a task instance: the newest files of the folder itself', async () => {
      const s = scene();
      const asked: [string, string][] = [];
      const e = s.env({
        newestFiles: (dir, extension) => {
          asked.push([dir, extension]);
          return Promise.resolve([]);
        },
      });
      await checks.transcriptsParse(e);
      expect(asked.every(([, extension]) => extension !== '')).toBe(true);
    });
  });

  describe('hooks.scope', () => {
    it('warns when hooks are enabled and the instance reads every project, and names the way out', async () => {
      const s = scene({ instance: { ...USER, ...HOOKS_ON } });
      const check = await checks.hooksScope(s.env());
      expectFail(check, 'warn', /hooks disable --task demo/);
      expect(check.id).toBe('hooks.scope');
    });

    it('is quiet for the other combinations', async () => {
      for (const o of [
        { instance: USER },
        { instance: HOOKS_ON },
        { instance: { ...HOOKS_ON, ...USER }, runtime: { projects: { scope: 'repo' } } },
      ]) {
        const check = await checks.hooksScope(scene(o).env());
        expect(check, JSON.stringify(o)).toMatchObject({ id: 'hooks.scope', ok: true });
      }
    });

    it('warns for a task instance whose key says all and whose hooks are on', async () => {
      const s = scene({ runtime: ALL, instance: HOOKS_ON });
      expect((await checks.hooksScope(s.env())).ok).toBe(false);
    });

    it('is skipped without a task, and quiet when the configuration does not resolve', async () => {
      const s = scene({ instance: { ...USER, ...HOOKS_ON } });
      const skipped = await checks.hooksScope(s.env({}, { ws: null }));
      expect(skipped.ok).toBe(true);
      expect(skipped.detail).toContain('skipped');
      const withoutSkill: CheckEnv = { ...s.env(), ctx: { ...s.f.ctx, skillDir: path.join(s.f.root, 'no-skill') } };
      expect((await checks.hooksScope(withoutSkill)).ok).toBe(true);
    });

    it('is a built-in check before the hooks line, which an extra check replaces and which stays last', () => {
      const ids = checks.BUILTIN_CHECKS.map(([id]) => id);
      expect(ids).toContain('hooks.scope');
      expect(ids.indexOf('hooks.scope')).toBeLessThan(ids.indexOf('hooks'));
      expect(ids.at(-1)).toBe('hooks');
    });
  });
});
