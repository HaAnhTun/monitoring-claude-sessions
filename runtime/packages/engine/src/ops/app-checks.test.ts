// The `app.*` checks of `caw check` and `caw doctor` (06 2.6, amendment A6): one case per check id with scripted seams, the
// `null` answer outside the user scope, the claude version probe, and the `icacls` reading of the run folder. Nothing here starts
// a program, binds a port or loads the terminal addon.
import path from 'node:path';

import type { AutostartStatus, DoctorCheck } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { Logger } from '../log/logger.ts';
import type { ChildResult } from '../platform/exec.ts';
import type { CommandFs } from '../terminal/command.ts';
import type { TerminalDiagnosis } from '../terminal/diagnose.ts';
import { userOpContext, userRootOf } from '../user-instance/paths.ts';
import { resolveWorkspace, type WorkspaceRef } from '../workspace/paths.ts';
import {
  APP_CHECK_IDS,
  appCheckProviders,
  claudeVersionOf,
  openRunFolderGroups,
  userCheckIds,
  type AppCheckDeps,
  type AppSettings,
} from './app-checks.ts';
import { PROVIDER_TIMEOUT_MS } from './doctor.ts';
import { BUILTIN_CHECKS } from './doctor-checks.ts';
import type { HttpAttempt, IdentifyResponse, ProbeResult, ProbeState } from './probe.ts';
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

const ID = '11111111-2222-4333-8444-555555555555';

interface Scene {
  readonly ctx: OpContext;
  readonly taskCtx: OpContext;
  readonly ws: WorkspaceRef;
  readonly claudeHome: string;
}

/** A user-scope context (the root is the user root) and a task-scope one, both over a temp MCS_HOME. */
function scene(): Scene {
  const root = makeTemp('app-checks').path;
  const skillDir = defaultSkillDir();
  const claudeHome = path.join(root, 'claude-home');
  const env = { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: claudeHome };
  const base = {
    skillDir,
    runtimeDir: path.join(skillDir, 'runtime'),
    launcherPath: path.join(root, 'skill', 'scripts', 'caw.mjs'),
    env,
    clock: new FakeClock(Date.UTC(2026, 10, 14)),
    log: silent,
  };
  const ctx = userOpContext(base);
  const taskRoot = path.join(root, 'repo', '.claude', 'monitor', 'tasks');
  const taskCtx: OpContext = { ...base, repo: path.join(root, 'repo'), root: taskRoot };
  return { ctx, taskCtx, ws: resolveWorkspace(userRootOf(env), 'user'), claudeHome };
}

const SETTINGS: AppSettings = {
  terminal: { command: 'claude', conptyDll: false },
  openAppWindow: false,
  effectivePort: 7690,
  portScan: 19,
};

const diagnosis = (over: Partial<TerminalDiagnosis> = {}): TerminalDiagnosis => ({
  supported: true,
  reason: null,
  nodePty: { via: 'bundle', loaded: true },
  claude: { found: true, kind: 'shim', display: '~\\npm\\claude.cmd' },
  conptyDll: { filesPresent: true },
  windowsBuild: { build: 26200, ok: true },
  ...over,
});

/** Deps that fail loudly when a check asks for something the test did not script. */
function deps(over: AppCheckDeps = {}): AppCheckDeps {
  const unscripted = (name: string) => (): never => {
    throw new Error(`the test did not script ${name}`);
  };
  return {
    platform: 'win32',
    settings: () => Promise.resolve(SETTINGS),
    diagnose: () => diagnosis(),
    claudeVersion: () => Promise.resolve(null),
    probe: unscripted('probe'),
    canBind: unscripted('canBind'),
    httpGet: unscripted('httpGet'),
    exists: unscripted('exists'),
    findAppBrowser: unscripted('findAppBrowser'),
    autostart: unscripted('autostart'),
    codeStamp: unscripted('codeStamp'),
    icacls: unscripted('icacls'),
    ...over,
  };
}

async function check(
  id: string,
  d: AppCheckDeps,
  s: Scene,
  ws: WorkspaceRef | null = null,
): Promise<DoctorCheck | null> {
  const provider = appCheckProviders(d)[id];
  if (provider === undefined) throw new Error(`no provider ${id}`);
  return provider(s.ctx, ws);
}

async function must(id: string, d: AppCheckDeps, s: Scene, ws: WorkspaceRef | null = null): Promise<DoctorCheck> {
  const result = await check(id, d, s, ws);
  if (result === null) throw new Error(`${id} answered null in the user scope`);
  return result;
}

function probeOf(state: ProbeState, over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    state,
    engine: state === 'stopped' ? null : 'node',
    pid: state === 'stopped' ? null : 4242,
    url: null,
    port: null,
    identity: null,
    stateFile: null,
    stateFileBytes: null,
    reason: `scripted ${state}`,
    ...over,
  };
}

function identity(over: Partial<IdentifyResponse> = {}): IdentifyResponse {
  return {
    v: 1,
    ok: true,
    op: 'identify',
    instanceId: ID,
    pid: 4242,
    phase: 'ready',
    runtimeVersion: '4.1.0',
    codeStamp: 'stamp-a',
    port: 7690,
    url: 'http://127.0.0.1:7690',
    startedAt: '2026-11-14T08:00:00.000Z',
    ...over,
  };
}

const runningProbe = (over: Partial<IdentifyResponse> = {}, port = 7690): ProbeResult =>
  probeOf('running', { port, url: `http://127.0.0.1:${String(port)}`, identity: identity({ ...over, port }) });

// ---- the registry ------------------------------------------------------------------------------------------------------------

describe('the registry of app checks', () => {
  it('has the eight ids of design 06 2.6 and a time budget for each, longer than the default of the doctor', () => {
    const providers = appCheckProviders(deps());
    expect(Object.keys(providers).sort()).toEqual([...APP_CHECK_IDS].sort());
    expect([...APP_CHECK_IDS]).toEqual([
      'app.claude',
      'app.pty',
      'app.windows',
      'app.port',
      'app.memory',
      'app.browser',
      'app.autostart',
      'app.instance',
    ]);
    for (const id of APP_CHECK_IDS) {
      expect(providers[id]?.timeoutMs, id).toBeGreaterThan(PROVIDER_TIMEOUT_MS);
    }
  });

  it('userCheckIds is what `caw check` runs: five machine checks of the doctor and the app. family', () => {
    expect(userCheckIds).toEqual([
      'node.version',
      'node.sqlite',
      'runtime.layout',
      'claude.home',
      'mcshome.writable',
      'app.',
    ]);
    const builtin = new Set(BUILTIN_CHECKS.map(([id]) => id));
    for (const id of userCheckIds.filter((entry) => !entry.endsWith('.'))) expect(builtin.has(id), id).toBe(true);
    for (const id of APP_CHECK_IDS) expect(id.startsWith('app.')).toBe(true);
  });

  it('every check answers null outside the user scope and asks nothing of the machine', async () => {
    const s = scene();
    const providers = appCheckProviders(
      deps({
        diagnose: () => {
          throw new Error('asked');
        },
        settings: () => {
          throw new Error('asked');
        },
      }),
    );
    for (const id of APP_CHECK_IDS) {
      expect(await providers[id]?.(s.taskCtx, null), id).toBeNull();
    }
  });

  it('a context without a home folder is no user scope either: null, not a throw', async () => {
    const s = scene();
    const ctx: OpContext = { ...s.ctx, env: {} };
    const providers = appCheckProviders(deps());
    for (const id of APP_CHECK_IDS) expect(await providers[id]?.(ctx, null), id).toBeNull();
  });
});

// ---- app.claude --------------------------------------------------------------------------------------------------------------

describe('app.claude', () => {
  it('passes when claude is found: the path and, best effort, the version', async () => {
    const s = scene();
    const seen: { command: string }[] = [];
    const result = await must(
      'app.claude',
      deps({
        claudeVersion: (command) => {
          seen.push({ command });
          return Promise.resolve('2.1.289');
        },
      }),
      s,
    );
    expect(result).toEqual({
      id: 'app.claude',
      ok: true,
      level: 'error',
      detail: 'claude found: ~\\npm\\claude.cmd (2.1.289)',
    });
    expect(seen).toEqual([{ command: 'claude' }]);
  });

  it('a version that cannot be read is no failure', async () => {
    const result = await must('app.claude', deps(), scene());
    expect(result).toMatchObject({ ok: true, detail: 'claude found: ~\\npm\\claude.cmd' });
  });

  it('fails at error level when it is not found, and says how to fix it', async () => {
    let probed = 0;
    const result = await must(
      'app.claude',
      deps({
        diagnose: () => diagnosis({ claude: { found: false, kind: null, display: null } }),
        claudeVersion: () => {
          probed += 1;
          return Promise.resolve('2.1.289');
        },
      }),
      scene(),
    );
    expect(result).toEqual({
      id: 'app.claude',
      ok: false,
      level: 'error',
      detail: '"claude" was not found (terminal.command)',
      fix: 'install Claude Code, or: caw config set terminal.command <full path to claude>',
    });
    expect(probed).toBe(0);
  });

  it('fails when the program is found but is of a kind the terminal cannot start', async () => {
    const result = await must(
      'app.claude',
      deps({ diagnose: () => diagnosis({ claude: { found: true, kind: null, display: 'C:\\tools\\claude.ps1' } }) }),
      scene(),
    );
    expect(result).toMatchObject({
      ok: false,
      level: 'error',
      detail: 'C:\\tools\\claude.ps1 cannot be started in the terminal (only .exe, .com, .cmd and .bat programs can)',
      fix: 'install Claude Code, or: caw config set terminal.command <full path to claude>',
    });
  });

  it('reads terminal.command and conptyDll of the configuration and the environment of the caller', async () => {
    const s = scene();
    let given: unknown = null;
    await must(
      'app.claude',
      deps({
        settings: () =>
          Promise.resolve({ ...SETTINGS, terminal: { command: 'D:\\tools\\claude.exe', conptyDll: true } }),
        diagnose: (input) => {
          given = input;
          return diagnosis();
        },
      }),
      s,
    );
    expect(given).toEqual({ config: { command: 'D:\\tools\\claude.exe', conptyDll: true }, env: s.ctx.env });
  });
});

describe('claudeVersionOf (the best-effort probe)', () => {
  const WIN_ENV = { PATH: 'C:\\bin;C:\\npm', PATHEXT: '.exe;.cmd;.bat', SystemRoot: 'C:\\Windows' };
  const files = (...present: string[]): CommandFs => ({
    isFile: (file) => present.some((known) => known.toLowerCase() === file.toLowerCase()),
  });
  const ok = (stdout: string): ChildResult => ({
    ok: true,
    code: 0,
    stdout,
    stderr: '',
    error: null,
    truncated: false,
    durationMs: 1,
  });
  const calls: { kind: string; file: string; args: readonly string[]; timeoutMs: number }[] = [];
  const run =
    (answer: ChildResult) =>
    (spec: { kind: string; file: string; args: readonly string[]; timeoutMs: number }): Promise<ChildResult> => {
      calls.push({ kind: spec.kind, file: spec.file, args: spec.args, timeoutMs: spec.timeoutMs });
      return Promise.resolve(answer);
    };

  it('runs an .exe directly with --version only (the configured arguments stay out of it)', async () => {
    calls.length = 0;
    const version = await claudeVersionOf('claude', {
      env: WIN_ENV,
      platform: 'win32',
      fs: files('C:\\bin\\claude.exe'),
      exec: run(ok('2.1.289 (Claude Code)\r\n')),
    });
    expect(version).toBe('2.1.289');
    expect(calls).toEqual([{ kind: 'claude', file: 'C:\\bin\\claude.exe', args: ['--version'], timeoutMs: 5000 }]);
  });

  it('runs a .cmd shim through cmd.exe /d /s /c, once, when its path needs no quoting', async () => {
    calls.length = 0;
    const version = await claudeVersionOf('claude', {
      env: WIN_ENV,
      platform: 'win32',
      fs: files('C:\\npm\\claude.cmd', 'C:\\Windows\\System32\\cmd.exe'),
      exec: run(ok('2.1.289 (Claude Code)\n')),
    });
    expect(version).toBe('2.1.289');
    expect(calls).toEqual([
      {
        kind: 'claude',
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', 'C:\\npm\\claude.cmd --version'],
        timeoutMs: 5000,
      },
    ]);
  });

  it('does not probe a shim whose path holds a space: there is no safe way to quote it for cmd.exe', async () => {
    calls.length = 0;
    const version = await claudeVersionOf('C:\\Program Files\\claude.cmd', {
      env: WIN_ENV,
      platform: 'win32',
      fs: files('C:\\Program Files\\claude.cmd', 'C:\\Windows\\System32\\cmd.exe'),
      exec: run(ok('2.1.289\n')),
    });
    expect(version).toBeNull();
    expect(calls).toEqual([]);
  });

  it('is null when nothing is found, when the program fails, and when the output is no version; the output is never passed on', async () => {
    const base = { env: WIN_ENV, platform: 'win32' as const, fs: files('C:\\bin\\claude.exe') };
    expect(await claudeVersionOf('claude', { ...base, fs: files(), exec: run(ok('2.1.289')) })).toBeNull();
    expect(
      await claudeVersionOf('claude', {
        ...base,
        exec: run({ ...ok(''), ok: false, code: 1, error: 'NONZERO_EXIT' }),
      }),
    ).toBeNull();
    expect(
      await claudeVersionOf('claude', { ...base, exec: run(ok('welcome, you are signed in as somebody\n')) }),
    ).toBeNull();
    expect(await claudeVersionOf('claude', { ...base, exec: run(ok('')) })).toBeNull();
  });

  it('keeps a pre-release suffix and nothing after the first space', async () => {
    const base = { env: WIN_ENV, platform: 'win32' as const, fs: files('C:\\bin\\claude.exe') };
    expect(await claudeVersionOf('claude', { ...base, exec: run(ok('3.0.0-beta.2 (Claude Code)')) })).toBe(
      '3.0.0-beta.2',
    );
  });

  it('a program that is refused for its kind or arguments is no version, not a throw', async () => {
    const base = { env: WIN_ENV, platform: 'win32' as const, exec: run(ok('2.1.289')) };
    expect(await claudeVersionOf('claude', { ...base, fs: files('C:\\bin\\claude.cmd') })).toBeNull(); // no cmd.exe
    expect(
      await claudeVersionOf('claude', { ...base, env: { PATH: 'C:\\bin' }, fs: files('C:\\bin\\claude.cmd') }),
    ).toBeNull();
  });
});

// ---- app.pty and app.windows -------------------------------------------------------------------------------------------------

describe('app.pty', () => {
  it('passes when the module loads and the ConPTY files sit next to it', async () => {
    expect(await must('app.pty', deps(), scene())).toEqual({
      id: 'app.pty',
      ok: true,
      level: 'error',
      detail: 'terminal module loaded from the bundle; ConPTY files present',
    });
  });

  it('says so when the ConPTY files could not be looked for, and when the module came from node_modules', async () => {
    const result = await must(
      'app.pty',
      deps({
        diagnose: () =>
          diagnosis({ nodePty: { via: 'node_modules', loaded: true }, conptyDll: { filesPresent: null } }),
      }),
      scene(),
    );
    expect(result).toMatchObject({
      ok: true,
      detail: 'terminal module loaded from node_modules; ConPTY files not checked',
    });
  });

  it('fails at error level on Windows for each reason, with the fix of design 06', async () => {
    const reinstall = 'reinstall the skill (the bundle folder is incomplete)';
    const cases: [Partial<TerminalDiagnosis>, string, string][] = [
      [
        { supported: false, reason: 'native-missing', nodePty: { via: null, loaded: false } },
        'the terminal module (node-pty) was not found',
        reinstall,
      ],
      [
        { supported: false, reason: 'native-load-failed', nodePty: { via: null, loaded: false } },
        'the terminal module (node-pty) failed to load',
        reinstall,
      ],
      [
        { supported: false, reason: 'unsupported-os', nodePty: { via: null, loaded: false } },
        'no terminal module ships for this operating system or processor',
        reinstall,
      ],
      [
        { supported: false, reason: 'os-too-old', nodePty: { via: null, loaded: false } },
        'the Windows build is too old for the pseudo console',
        'Windows 10 1809 or newer is needed for the terminal',
      ],
      [
        { conptyDll: { filesPresent: false } },
        'conpty.dll or OpenConsole.exe is missing next to the terminal module',
        reinstall,
      ],
    ];
    for (const [over, detail, fix] of cases) {
      const result = await must('app.pty', deps({ diagnose: () => diagnosis(over) }), scene());
      expect(result, detail).toEqual({ id: 'app.pty', ok: false, level: 'error', detail, fix });
    }
  });

  it('is a warning elsewhere, with the line that says monitoring works', async () => {
    const result = await must(
      'app.pty',
      deps({
        platform: 'linux',
        diagnose: () =>
          diagnosis({
            supported: false,
            reason: 'unsupported-os',
            nodePty: { via: null, loaded: false },
            conptyDll: { filesPresent: null },
            windowsBuild: null,
          }),
      }),
      scene(),
    );
    expect(result).toEqual({
      id: 'app.pty',
      ok: false,
      level: 'warn',
      detail: 'no terminal module ships for this operating system or processor',
      fix: 'the terminal is not supported on this OS; monitoring works',
    });
  });
});

describe('app.windows', () => {
  it('passes from build 17763, naming the build', async () => {
    const result = await must(
      'app.windows',
      deps({ diagnose: () => diagnosis({ windowsBuild: { build: 17763, ok: true } }) }),
      scene(),
    );
    expect(result).toEqual({
      id: 'app.windows',
      ok: true,
      level: 'error',
      detail: 'Windows build 17763 (the pseudo console needs 17763 or newer)',
    });
  });

  it('fails below it, at error level', async () => {
    const result = await must(
      'app.windows',
      deps({ diagnose: () => diagnosis({ windowsBuild: { build: 17134, ok: false } }) }),
      scene(),
    );
    expect(result).toEqual({
      id: 'app.windows',
      ok: false,
      level: 'error',
      detail: 'Windows build 17134 is older than 17763',
      fix: 'Windows 10 1809 or newer is needed for the terminal',
    });
  });

  it('fails when the build cannot be read', async () => {
    const result = await must(
      'app.windows',
      deps({ diagnose: () => diagnosis({ windowsBuild: { build: null, ok: false } }) }),
      scene(),
    );
    expect(result).toMatchObject({ ok: false, level: 'error', detail: 'the Windows build could not be read' });
  });

  it('passes off Windows: nothing to check there', async () => {
    const result = await must(
      'app.windows',
      deps({ platform: 'linux', diagnose: () => diagnosis({ windowsBuild: null }) }),
      scene(),
    );
    expect(result).toEqual({ id: 'app.windows', ok: true, level: 'error', detail: 'not Windows (not needed)' });
  });
});

// ---- app.port ----------------------------------------------------------------------------------------------------------------

describe('app.port', () => {
  const body = (value: unknown): HttpAttempt => ({ ok: true, reply: { status: 200, body: JSON.stringify(value) } });

  it('passes when the configured port is free', async () => {
    const result = await must('app.port', deps({ canBind: () => Promise.resolve(true) }), scene());
    expect(result).toEqual({ id: 'app.port', ok: true, level: 'warn', detail: 'port 7690 is free' });
  });

  it('passes when this instance holds it, without binding anything', async () => {
    const s = scene();
    const result = await must(
      'app.port',
      deps({ probe: () => Promise.resolve(runningProbe()), canBind: () => Promise.reject(new Error('must not bind')) }),
      s,
      s.ws,
    );
    expect(result).toEqual({ id: 'app.port', ok: true, level: 'warn', detail: 'port 7690 is held by this instance' });
  });

  it('warns when something else holds it, names the next free port and the fix', async () => {
    const asked: number[] = [];
    const result = await must(
      'app.port',
      deps({
        canBind: (port) => {
          asked.push(port);
          return Promise.resolve(port === 7692);
        },
        httpGet: () => Promise.resolve({ ok: false, reason: 'refused' }),
      }),
      scene(),
    );
    expect(result).toEqual({
      id: 'app.port',
      ok: false,
      level: 'warn',
      detail: 'port 7690 is held by something else; the next free port is 7692',
      fix: 'caw start picks the next free port; set a fixed one with caw config set server.port N',
    });
    expect(asked).toEqual([7690, 7691, 7692]);
  });

  it('says that MTOP answers there when GET /api/state returns a body with folders', async () => {
    const urls: string[] = [];
    const result = await must(
      'app.port',
      deps({
        canBind: (port) => Promise.resolve(port === 7691),
        httpGet: (url) => {
          urls.push(url);
          return Promise.resolve(body({ folders: [], sessions: [] }));
        },
      }),
      scene(),
    );
    expect(result).toMatchObject({
      ok: false,
      detail: 'port 7690 is held by something else (MTOP answers there); the next free port is 7691',
    });
    expect(urls).toEqual(['http://127.0.0.1:7690/api/state']);
  });

  it('does not take a body without folders, a non-200 answer or a body that is not JSON for MTOP', async () => {
    for (const answer of [
      body({ ok: true }),
      body([]),
      { ok: true, reply: { status: 404, body: '{"folders":[]}' } } satisfies HttpAttempt,
      { ok: true, reply: { status: 200, body: 'not json' } } satisfies HttpAttempt,
    ]) {
      const result = await must(
        'app.port',
        deps({ canBind: (port) => Promise.resolve(port === 7691), httpGet: () => Promise.resolve(answer) }),
        scene(),
      );
      expect(result.detail).toBe('port 7690 is held by something else; the next free port is 7691');
    }
  });

  it('says so when no port of the scan range is free', async () => {
    const result = await must(
      'app.port',
      deps({
        settings: () => Promise.resolve({ ...SETTINGS, portScan: 2 }),
        canBind: () => Promise.resolve(false),
        httpGet: () => Promise.resolve({ ok: false, reason: 'timeout' }),
      }),
      scene(),
    );
    expect(result).toMatchObject({
      ok: false,
      detail: 'port 7690 is held by something else; no port is free up to 7692',
    });
  });

  it('when this instance runs on another port, 7690 is still reported as held by something else', async () => {
    const s = scene();
    const result = await must(
      'app.port',
      deps({
        probe: () => Promise.resolve(runningProbe({}, 7691)),
        canBind: (port) => Promise.resolve(port !== 7690 && port !== 7691),
        httpGet: () => Promise.resolve({ ok: false, reason: 'refused' }),
      }),
      s,
      s.ws,
    );
    expect(result).toMatchObject({
      ok: false,
      level: 'warn',
      detail: 'port 7690 is held by something else; this app runs on 7691',
    });
  });

  it('uses the configured port, not the default', async () => {
    const result = await must(
      'app.port',
      deps({
        settings: () => Promise.resolve({ ...SETTINGS, effectivePort: 18123 }),
        canBind: () => Promise.resolve(true),
      }),
      scene(),
    );
    expect(result.detail).toBe('port 18123 is free');
  });
});

// ---- app.memory --------------------------------------------------------------------------------------------------------------

describe('app.memory', () => {
  it('passes when <claude home>/memory/index.json exists', async () => {
    const s = scene();
    const asked: string[] = [];
    const result = await must(
      'app.memory',
      deps({
        exists: (file) => {
          asked.push(file);
          return Promise.resolve(true);
        },
      }),
      s,
    );
    expect(result).toEqual({ id: 'app.memory', ok: true, level: 'warn', detail: 'DA memory index found' });
    expect(asked).toEqual([path.join(s.claudeHome, 'memory', 'index.json')]);
  });

  it('warns, with the optional fix, when it does not', async () => {
    const result = await must('app.memory', deps({ exists: () => Promise.resolve(false) }), scene());
    expect(result).toEqual({
      id: 'app.memory',
      ok: false,
      level: 'warn',
      detail: 'no memory/index.json in the Claude home (DA memory)',
      fix: 'optional: without it the project list shows ~/.claude/projects only',
    });
  });
});

// ---- app.browser -------------------------------------------------------------------------------------------------------------

describe('app.browser', () => {
  it('passes without looking when the default browser is used', async () => {
    const result = await must(
      'app.browser',
      deps({ findAppBrowser: () => Promise.reject(new Error('must not look')) }),
      scene(),
    );
    expect(result).toEqual({
      id: 'app.browser',
      ok: true,
      level: 'warn',
      detail: 'the default browser tab is used (app.openAppWindow is false)',
    });
  });

  it('passes when an app window is wanted and Edge or Chrome is found', async () => {
    const s = scene();
    let env: unknown = null;
    const found = await must(
      'app.browser',
      deps({
        settings: () => Promise.resolve({ ...SETTINGS, openAppWindow: true }),
        findAppBrowser: (given) => {
          env = given;
          return Promise.resolve({ kind: 'edge', file: 'C:\\x\\msedge.exe' });
        },
      }),
      s,
    );
    expect(found).toEqual({ id: 'app.browser', ok: true, level: 'warn', detail: 'an app window opens in Edge' });
    expect(env).toBe(s.ctx.env);
    const chrome = await must(
      'app.browser',
      deps({
        settings: () => Promise.resolve({ ...SETTINGS, openAppWindow: true }),
        findAppBrowser: () => Promise.resolve({ kind: 'chrome', file: 'C:\\x\\chrome.exe' }),
      }),
      s,
    );
    expect(chrome.detail).toBe('an app window opens in Chrome');
  });

  it('warns when an app window is wanted and neither is found', async () => {
    const result = await must(
      'app.browser',
      deps({
        settings: () => Promise.resolve({ ...SETTINGS, openAppWindow: true }),
        findAppBrowser: () => Promise.resolve(null),
      }),
      scene(),
    );
    expect(result).toEqual({
      id: 'app.browser',
      ok: false,
      level: 'warn',
      detail: 'app.openAppWindow is true but neither Edge nor Chrome was found',
      fix: 'falls back to the default browser; install Edge or Chrome, or caw config set app.openAppWindow false',
    });
  });
});

// ---- app.autostart -----------------------------------------------------------------------------------------------------------

describe('app.autostart', () => {
  const status = (over: Partial<AutostartStatus> = {}): AutostartStatus => ({
    supported: true,
    enabled: true,
    shortcut: 'C:\\Startup\\Claude Agent Workspace.lnk',
    target: 'C:\\node\\node.exe',
    arguments: '"C:\\skill\\caw.mjs" start --no-open',
    targetExists: true,
    matchesLauncher: true,
    note: null,
    ...over,
  });
  const with$ = (answer: AutostartStatus) => deps({ autostart: () => Promise.resolve(answer) });

  it('passes when it is off, current, or not available here', async () => {
    const s = scene();
    expect(
      await must(
        'app.autostart',
        with$(
          status({
            enabled: false,
            shortcut: null,
            target: null,
            arguments: null,
            targetExists: null,
            matchesLauncher: null,
          }),
        ),
        s,
      ),
    ).toEqual({
      id: 'app.autostart',
      ok: true,
      level: 'warn',
      detail: 'autostart is off',
    });
    expect((await must('app.autostart', with$(status()), s)).detail).toBe('autostart is on and current');
    expect(
      (
        await must(
          'app.autostart',
          with$(
            status({
              supported: false,
              enabled: false,
              shortcut: null,
              target: null,
              arguments: null,
              targetExists: null,
              matchesLauncher: null,
            }),
          ),
          s,
        )
      ).detail,
    ).toBe('autostart is available on Windows only');
  });

  it('asks about the launcher of this install', async () => {
    const s = scene();
    let given: unknown = null;
    await must(
      'app.autostart',
      deps({
        autostart: (_ctx, o) => {
          given = o;
          return Promise.resolve(status());
        },
      }),
      s,
    );
    expect(given).toEqual({ launcherPath: s.ctx.launcherPath });
  });

  it('warns for a shortcut that points to a missing program, to another launcher, or that cannot be read', async () => {
    const s = scene();
    const fix = 'caw autostart enable refreshes it';
    expect(await must('app.autostart', with$(status({ targetExists: false, note: 'x' })), s)).toEqual({
      id: 'app.autostart',
      ok: false,
      level: 'warn',
      detail: 'the autostart shortcut points to a program that does not exist',
      fix,
    });
    expect((await must('app.autostart', with$(status({ matchesLauncher: false, note: 'x' })), s)).detail).toBe(
      'the autostart shortcut points to another launcher',
    );
    expect(
      (
        await must(
          'app.autostart',
          with$(status({ target: null, arguments: null, targetExists: null, matchesLauncher: null, note: 'x' })),
          s,
        )
      ).detail,
    ).toBe('the autostart shortcut exists but could not be read');
  });
});

// ---- app.instance ------------------------------------------------------------------------------------------------------------

describe('app.instance', () => {
  const ICACLS_OK = (stdout: string): ChildResult => ({
    ok: true,
    code: 0,
    stdout,
    stderr: '',
    error: null,
    truncated: false,
    durationMs: 1,
  });
  const SAFE = [
    'D:\\data\\mcs\\instances\\user\\run NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    '                                                      BUILTIN\\Administrators:(OI)(CI)(F)',
    '                                                      DESKTOP\\x:(OI)(CI)(F)',
    '',
    'Successfully processed 1 files; Failed processing 0 files',
  ].join('\r\n');
  const OPEN = (account: string, rights: string): string =>
    [
      `C:\\data\\mcs\\instances\\user\\run ${account}:${rights}`,
      '                                    DESKTOP\\x:(OI)(CI)(F)',
      '',
      'Successfully processed 1 files; Failed processing 0 files',
    ].join('\r\n');

  const instanceDeps = (over: AppCheckDeps = {}): AppCheckDeps =>
    deps({
      probe: () => Promise.resolve(probeOf('stopped')),
      exists: () => Promise.resolve(true),
      icacls: () => Promise.resolve(ICACLS_OK(SAFE)),
      codeStamp: () => Promise.resolve('stamp-a'),
      ...over,
    });

  it('passes before the instance exists, and says what creates it', async () => {
    const result = await must('app.instance', deps(), scene(), null);
    expect(result).toEqual({
      id: 'app.instance',
      ok: true,
      level: 'warn',
      detail: 'the app instance has not been created yet (caw start creates it)',
    });
  });

  it('passes when it is not running', async () => {
    const s = scene();
    const result = await must('app.instance', instanceDeps({ exists: () => Promise.resolve(false) }), s, s.ws);
    expect(result).toEqual({ id: 'app.instance', ok: true, level: 'warn', detail: 'the app is not running' });
  });

  it('passes when it runs the code that is installed', async () => {
    const s = scene();
    const result = await must('app.instance', instanceDeps({ probe: () => Promise.resolve(runningProbe()) }), s, s.ws);
    expect(result).toEqual({ id: 'app.instance', ok: true, level: 'warn', detail: 'the app is running and current' });
  });

  it('warns when the code on disk changed since it started', async () => {
    const s = scene();
    const result = await must(
      'app.instance',
      instanceDeps({ probe: () => Promise.resolve(runningProbe()), codeStamp: () => Promise.resolve('stamp-b') }),
      s,
      s.ws,
    );
    expect(result).toEqual({
      id: 'app.instance',
      ok: false,
      level: 'warn',
      detail: 'the running app is outdated: the installed code changed since it started',
      fix: 'caw restart',
    });
  });

  it('a stamp that cannot be read is not "outdated"', async () => {
    const s = scene();
    const result = await must(
      'app.instance',
      instanceDeps({ probe: () => Promise.resolve(runningProbe()), codeStamp: () => Promise.resolve(null) }),
      s,
      s.ws,
    );
    expect(result.ok).toBe(true);
  });

  it('reports a hung or foreign instance with the reason of the probe', async () => {
    const s = scene();
    const hung = await must(
      'app.instance',
      instanceDeps({ probe: () => Promise.resolve(probeOf('unhealthy', { reason: 'no HTTP' })) }),
      s,
      s.ws,
    );
    expect(hung).toMatchObject({
      ok: false,
      level: 'warn',
      detail: 'the app does not answer properly (no HTTP)',
      fix: 'caw restart',
    });
    const starting = await must(
      'app.instance',
      instanceDeps({ probe: () => Promise.resolve(probeOf('starting')) }),
      s,
      s.ws,
    );
    expect(starting).toMatchObject({ ok: true, detail: 'the app is starting' });
  });

  it('warns for each group that can read the run folder, where control.token lives (amendment A6)', async () => {
    const s = scene();
    const ws = s.ws;
    const cases: [string, string, string][] = [
      ['BUILTIN\\Users', '(OI)(CI)(RX)', 'Users'],
      ['Everyone', '(OI)(CI)(R)', 'Everyone'],
      ['NT AUTHORITY\\Authenticated Users', '(OI)(CI)(M)', 'Authenticated Users'],
    ];
    for (const [account, rights, name] of cases) {
      const result = await must(
        'app.instance',
        instanceDeps({ icacls: () => Promise.resolve(ICACLS_OK(OPEN(account, rights))) }),
        s,
        ws,
      );
      expect(result, name).toEqual({
        id: 'app.instance',
        ok: false,
        level: 'warn',
        detail: `${name} can read the run folder of the app, where the control token lives`,
        fix: 'restrict the run folder of the app instance to your own account (icacls <folder> /inheritance:r), or move MCS_HOME to a folder in your profile',
      });
    }
  });

  it('runs icacls on the run folder with that one argument, on Windows only, and only when the folder exists', async () => {
    const s = scene();
    const asked: string[] = [];
    const icacls = (dir: string): Promise<ChildResult> => {
      asked.push(dir);
      return Promise.resolve(ICACLS_OK(SAFE));
    };
    const ws = s.ws;
    await must('app.instance', instanceDeps({ icacls }), s, ws);
    expect(asked).toEqual([path.join(ws.dir, 'run')]);

    asked.length = 0;
    await must('app.instance', instanceDeps({ icacls, platform: 'linux' }), s, ws);
    expect(asked).toEqual([]);

    await must('app.instance', instanceDeps({ icacls, exists: () => Promise.resolve(false) }), s, ws); // no run folder
    expect(asked).toEqual([]);
  });

  it('an icacls that is missing or fails is no finding', async () => {
    const s = scene();
    const ws = s.ws;
    expect((await must('app.instance', instanceDeps({ icacls: () => Promise.resolve(null) }), s, ws)).ok).toBe(true);
    expect(
      (
        await must(
          'app.instance',
          instanceDeps({
            icacls: () => Promise.resolve({ ...ICACLS_OK(''), ok: false, code: 5, error: 'NONZERO_EXIT' }),
          }),
          s,
          ws,
        )
      ).ok,
    ).toBe(true);
  });

  it('both findings are one line: the outdated notice and the open folder, with both fixes', async () => {
    const s = scene();
    const ws = s.ws;
    const result = await must(
      'app.instance',
      instanceDeps({
        probe: () => Promise.resolve(runningProbe()),
        codeStamp: () => Promise.resolve('stamp-b'),
        icacls: () => Promise.resolve(ICACLS_OK(OPEN('Everyone', '(OI)(CI)(R)'))),
      }),
      s,
      ws,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(
      'the running app is outdated: the installed code changed since it started; Everyone can read the run folder of the app, where the control token lives',
    );
    expect(result.fix).toContain('caw restart');
    expect(result.fix).toContain('icacls');
  });
});

describe('openRunFolderGroups (the reading of icacls)', () => {
  it('finds Everyone, Users and Authenticated Users with any right to read or write', () => {
    const text = [
      'C:\\a\\run Everyone:(R)',
      '           BUILTIN\\Users:(OI)(CI)(RX)',
      '           NT AUTHORITY\\Authenticated Users:(I)(OI)(CI)(M)',
      '',
    ].join('\n');
    expect(openRunFolderGroups(text)).toEqual(['Everyone', 'Users', 'Authenticated Users']);
  });

  it('knows the rights that open a folder, as letters and as lists', () => {
    for (const rights of ['(F)', '(M)', '(RX)', '(R)', '(W)', '(GR)', '(GA)', '(RD)', '(OI)(CI)(RD,WD,AD)', '(I)(R)']) {
      expect(openRunFolderGroups(`C:\\a\\run Everyone:${rights}`), rights).toEqual(['Everyone']);
    }
  });

  it('ignores rights that only traverse or read attributes, and denied entries', () => {
    for (const rights of ['(X)', '(RA)', '(REA)', '(RC)', '(OI)(CI)(S)', '(DENY)(R)', '(OI)(CI)(DENY)(F)']) {
      expect(openRunFolderGroups(`C:\\a\\run Everyone:${rights}`), rights).toEqual([]);
    }
  });

  it('ignores the account of the person, the administrators and the system, and the summary line', () => {
    const text = [
      'C:\\a\\run NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
      '           BUILTIN\\Administrators:(OI)(CI)(F)',
      '           DESKTOP\\someone:(OI)(CI)(F)',
      '',
      'Successfully processed 1 files; Failed processing 0 files',
    ].join('\r\n');
    expect(openRunFolderGroups(text)).toEqual([]);
  });

  it('names a group once, however many entries it has, and matches the names without regard to case', () => {
    expect(openRunFolderGroups('C:\\a\\run everyone:(R)\n   EVERYONE:(W)\n   builtin\\users:(R)')).toEqual([
      'Everyone',
      'Users',
    ]);
  });

  it('does not take a folder or a user whose name merely ends in a group name', () => {
    expect(openRunFolderGroups('C:\\a\\run DESKTOP\\NotEveryone:(F)')).toEqual([]);
    expect(openRunFolderGroups('C:\\a\\run BUILTIN\\Power Users:(M)')).toEqual([]);
  });

  it('empty or garbled output has no finding', () => {
    expect(openRunFolderGroups('')).toEqual([]);
    expect(openRunFolderGroups('::(((\n(R)\n')).toEqual([]);
  });
});

// ---- the whole set through the doctor ----------------------------------------------------------------------------------------

describe('together', () => {
  it('every provider answers a valid doctor check in the user scope', async () => {
    const s = scene();
    const d = deps({
      probe: () => Promise.resolve(probeOf('stopped')),
      canBind: () => Promise.resolve(true),
      exists: () => Promise.resolve(false),
      autostart: () =>
        Promise.resolve({
          supported: true,
          enabled: false,
          shortcut: null,
          target: null,
          arguments: null,
          targetExists: null,
          matchesLauncher: null,
          note: null,
        }),
      codeStamp: () => Promise.resolve(null),
      icacls: () => Promise.resolve(null),
    });
    const providers = appCheckProviders(d);
    for (const id of APP_CHECK_IDS) {
      const result = await providers[id]?.(s.ctx, s.ws);
      expect(result, id).not.toBeNull();
      expect(result?.id).toBe(id);
      expect(typeof result?.detail).toBe('string');
      if (result?.ok === false) expect(typeof result.fix).toBe('string');
    }
  });
});
