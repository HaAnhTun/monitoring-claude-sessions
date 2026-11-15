// Autostart (06 2.7): a shortcut in the Startup folder made by one constant script, values only in `CAW_LNK_*` variables, read
// back as base64, healed when its target is gone. The shortcut program is a seam in most tests (an in-memory store that writes
// a placeholder `.lnk`); one test per Windows host runs the real Windows PowerShell on a temp `APPDATA`.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import type { Logger } from '../log/logger.ts';
import { execFileText, resolveExecutable, type ChildResult, type ChildSpec } from '../platform/exec.ts';
import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import {
  AUTOSTART_SHORTCUT_NAME,
  CREATE_SHORTCUT_SCRIPT,
  READ_SHORTCUT_SCRIPT,
  autostartStatus,
  disableAutostart,
  enableAutostart,
  refreshAutostartIfEnabled,
  type AutostartDeps,
} from './autostart.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
/** Compiling code in a script, or evaluating text as code: neither may appear in a constant script (the spelling is assembled so that no guard sees it here). */
const COMPILE_OR_EVAL = new RegExp(`${['Add', 'Type'].join('-')}|Invoke-Expression|iex\\b`, 'i');
const STARTUP_PARTS = ['Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'] as const;

interface Sandbox {
  readonly dir: string;
  readonly appData: string;
  readonly startup: string;
  readonly lnk: string;
  readonly profile: string;
  readonly nodePath: string;
  /** Launcher of the current install: a plugin cache version folder. */
  readonly launcher: string;
  readonly warnings: string[];
  readonly ctx: OpContext;
}

function makeLogger(warnings: string[]): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (event) => {
      warnings.push(event);
    },
    error: () => undefined,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

/** A temp `APPDATA` and a temp profile; real files stand in for node.exe and the launcher so that "exists" is a real answer. */
function sandbox(over: { env?: Record<string, string | undefined> } = {}): Sandbox {
  const dir = makeTemp('autostart').path;
  const appData = path.join(dir, 'Roaming');
  const profile = path.join(dir, 'profile');
  const startup = path.join(appData, ...STARTUP_PARTS);
  const nodePath = path.join(dir, 'node', 'node.exe');
  const launcher = path.join(dir, 'plugins', 'cache', 'market', 'caw', '1.0.0', 'skills', 'caw', 'scripts', 'caw.mjs');
  for (const file of [nodePath, launcher]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'x');
  }
  mkdirSync(profile, { recursive: true });
  const warnings: string[] = [];
  const skillDir = path.join(dir, 'skill');
  return {
    dir,
    appData,
    startup,
    lnk: path.join(startup, AUTOSTART_SHORTCUT_NAME),
    profile,
    nodePath,
    launcher,
    warnings,
    ctx: {
      repo: dir,
      root: dir,
      skillDir,
      runtimeDir: path.join(skillDir, 'runtime'),
      launcherPath: launcher,
      env: { APPDATA: appData, USERPROFILE: profile, ...over.env },
      clock: new FakeClock(1),
      log: makeLogger(warnings),
    },
  };
}

function decodeScript(args: readonly string[]): string {
  const at = args.indexOf('-EncodedCommand');
  return Buffer.from(args[at + 1] ?? '', 'base64').toString('utf16le');
}

function ok(stdout = ''): ChildResult {
  return { ok: true, code: 0, stdout, stderr: '', error: null, truncated: false, durationMs: 1 };
}
function failed(stderr = 'blocked'): ChildResult {
  return { ok: false, code: 1, stdout: '', stderr, error: 'NONZERO_EXIT', truncated: false, durationMs: 1 };
}

interface Shell {
  readonly deps: AutostartDeps;
  readonly calls: ChildSpec[];
  readonly store: Map<string, { target: string; args: string }>;
  failCreate: boolean;
  failRead: boolean;
}

/** The two constant scripts of the module, played in memory: a create writes a placeholder `.lnk`, a read answers base64. */
function fakeShell(platform: HostPlatform = 'win32'): Shell {
  const calls: ChildSpec[] = [];
  const store = new Map<string, { target: string; args: string }>();
  const shell: Shell = {
    calls,
    store,
    failCreate: false,
    failRead: false,
    deps: {
      platform,
      resolveExecutable: (name) => Promise.resolve(name === 'powershell' ? POWERSHELL : null),
      execFileText: (spec) => {
        calls.push(spec);
        const env = spec.extraEnv ?? {};
        const script = decodeScript(spec.args);
        const key = env['CAW_LNK_PATH'] ?? '';
        if (script === CREATE_SHORTCUT_SCRIPT) {
          if (shell.failCreate) return Promise.resolve(failed());
          writeFileSync(key, 'placeholder');
          store.set(key, { target: env['CAW_LNK_TARGET'] ?? '', args: env['CAW_LNK_ARGS'] ?? '' });
          return Promise.resolve(ok());
        }
        if (script === READ_SHORTCUT_SCRIPT) {
          const entry = store.get(key);
          if (shell.failRead || entry === undefined) return Promise.resolve(failed());
          const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
          return Promise.resolve(ok(`${b64(entry.target)}\t${b64(entry.args)}\r\n`));
        }
        return Promise.reject(new Error('an unknown script was run'));
      },
    },
  };
  return shell;
}

function expectedArgs(launcher: string): string {
  return `"${launcher}" start --no-open`;
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

describe('the two scripts are constants (TC-LIF-autostart-script)', () => {
  it('create: WScript.Shell, a minimized window, every value from a CAW_LNK_* variable, no compiled code', () => {
    expect(CREATE_SHORTCUT_SCRIPT).toContain("$ErrorActionPreference='Stop'");
    expect(CREATE_SHORTCUT_SCRIPT).toContain('New-Object -ComObject WScript.Shell');
    expect(CREATE_SHORTCUT_SCRIPT).toContain('$s.WindowStyle=7');
    for (const name of ['PATH', 'TARGET', 'ARGS', 'WORKDIR', 'DESC']) {
      expect(CREATE_SHORTCUT_SCRIPT).toContain(`$env:CAW_LNK_${name}`);
    }
    expect(CREATE_SHORTCUT_SCRIPT).not.toMatch(COMPILE_OR_EVAL);
    expect(CREATE_SHORTCUT_SCRIPT).not.toMatch(/[^\x20-\x7e]/);
  });

  it('read: prints the base64 of the target, a tab, the base64 of the arguments, from CAW_LNK_PATH only', () => {
    expect(READ_SHORTCUT_SCRIPT).toContain('$env:CAW_LNK_PATH');
    expect(READ_SHORTCUT_SCRIPT).toContain('ToBase64String');
    expect(READ_SHORTCUT_SCRIPT).toContain('[char]9');
    expect(READ_SHORTCUT_SCRIPT).not.toMatch(/\$env:CAW_LNK_(TARGET|ARGS|WORKDIR|DESC)/);
    expect(READ_SHORTCUT_SCRIPT).not.toMatch(COMPILE_OR_EVAL);
  });
});

describe('enableAutostart (TC-LIF-autostart-enable)', () => {
  it('creates the Startup shortcut: the constant script, the values in the environment of the child and nowhere else', async () => {
    const sb = sandbox({ env: { APPDATA: undefined } });
    const home = path.join(sb.dir, 'Łukasz Żółć', 'x');
    const appData = path.join(home, 'AppData');
    const ctx: OpContext = { ...sb.ctx, env: { APPDATA: appData, USERPROFILE: sb.profile } };
    const shell = fakeShell();
    const status = await enableAutostart(ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps);

    // one create, then one read of the shortcut for the status
    expect(shell.calls.map((call) => decodeScript(call.args))).toEqual([CREATE_SHORTCUT_SCRIPT, READ_SHORTCUT_SCRIPT]);
    const spec = shell.calls[0];
    expect(spec?.kind).toBe('powershell.shortcut');
    expect(spec?.file).toBe(POWERSHELL);
    expect(spec?.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ]);
    expect(decodeScript(spec?.args ?? [])).toBe(CREATE_SHORTCUT_SCRIPT);
    const lnk = path.join(appData, ...STARTUP_PARTS, AUTOSTART_SHORTCUT_NAME);
    expect(spec?.extraEnv).toEqual({
      CAW_LNK_PATH: lnk,
      CAW_LNK_TARGET: sb.nodePath,
      CAW_LNK_ARGS: expectedArgs(sb.launcher),
      CAW_LNK_WORKDIR: sb.profile,
      CAW_LNK_DESC: 'Claude Agent Workspace: starts the app in the background at sign-in',
    });
    // no value is in the arguments of the program (the script is the only argument that carries text)
    const joined = (spec?.args ?? []).join(' ');
    for (const value of Object.values(spec?.extraEnv ?? {})) expect(joined).not.toContain(value);
    expect(spec?.timeoutMs).toBeGreaterThan(0);
    expect(spec?.encoding).toBe('utf8');

    expect(status).toEqual({
      supported: true,
      enabled: true,
      shortcut: lnk,
      target: sb.nodePath,
      arguments: expectedArgs(sb.launcher),
      targetExists: true,
      matchesLauncher: true,
      note: null,
    });
    expect(existsSync(lnk)).toBe(true);
  });

  it('creates the Startup folder when it is not there, and overwrites an earlier shortcut', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    expect(existsSync(sb.startup)).toBe(false);
    await enableAutostart(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps);
    const second = path.join(sb.dir, 'node2', 'node.exe');
    mkdirSync(path.dirname(second), { recursive: true });
    writeFileSync(second, 'x');
    const status = await enableAutostart(sb.ctx, { launcherPath: sb.launcher, nodePath: second }, shell.deps);
    expect(status.target).toBe(second);
    expect(readdirSync(sb.startup)).toEqual([AUTOSTART_SHORTCUT_NAME]);
  });

  it('round-trips a profile path with non-ASCII letters, spaces and an apostrophe', async () => {
    const sb = sandbox();
    const odd = path.join(sb.dir, "Łukasz Żółć O'Brien", 'scripts', 'caw.mjs');
    mkdirSync(path.dirname(odd), { recursive: true });
    writeFileSync(odd, 'x');
    const shell = fakeShell();
    const status = await enableAutostart(sb.ctx, { launcherPath: odd, nodePath: sb.nodePath }, shell.deps);
    expect(status.arguments).toBe(expectedArgs(odd));
    expect(status.matchesLauncher).toBe(true);
    expect((await autostartStatus(sb.ctx, { launcherPath: odd }, shell.deps)).arguments).toBe(expectedArgs(odd));
  });

  it('UNSUPPORTED_PLATFORM off Windows, and nothing is run', async () => {
    const sb = sandbox();
    for (const platform of ['linux', 'darwin', 'other'] as const) {
      const shell = fakeShell(platform);
      expect(
        await codeOf(enableAutostart(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps)),
      ).toBe('UNSUPPORTED_PLATFORM');
      expect(shell.calls).toEqual([]);
    }
  });

  it('CONFIG_INVALID without a usable APPDATA, and nothing is run or created', async () => {
    const sb = sandbox();
    for (const appData of [undefined, '', 'relative\\Roaming']) {
      const shell = fakeShell();
      const ctx = {
        ...sb.ctx,
        env: { USERPROFILE: sb.profile, ...(appData === undefined ? {} : { APPDATA: appData }) },
      };
      expect(await codeOf(enableAutostart(ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps))).toBe(
        'CONFIG_INVALID',
      );
      expect(shell.calls).toEqual([]);
    }
  });

  it('refuses a node path that is not an absolute .exe and a launcher that is not an absolute path or holds a quote', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    const bad: [string, string][] = [
      ['node.exe', sb.launcher],
      [path.join(sb.dir, 'node', 'node.cmd'), sb.launcher],
      [sb.nodePath, 'caw.mjs'],
      [sb.nodePath, `${sb.launcher}" & calc "`],
      [sb.nodePath, `${sb.launcher}\r\nx`],
      [sb.nodePath, ''],
    ];
    for (const [nodePath, launcherPath] of bad) {
      expect(await codeOf(enableAutostart(sb.ctx, { launcherPath, nodePath }, shell.deps))).toBe('USAGE');
    }
    expect(shell.calls).toEqual([]);
  });

  it('says that WScript.Shell may be blocked, with the manual instruction, when the script fails; no stderr text is repeated', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    shell.failCreate = true;
    const error = await enableAutostart(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(McsError);
    const message = `${(error as McsError).message} ${(error as McsError).hint ?? ''}`;
    expect(message).toMatch(/WScript\.Shell/);
    expect(message).toContain(sb.startup);
    expect(message).toContain(expectedArgs(sb.launcher));
    expect(message).not.toContain('blocked');
  });

  it('a shortcut that is missing after a script that said ok is a failure, not a success', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    const silent: AutostartDeps = { ...shell.deps, execFileText: () => Promise.resolve(ok()) };
    expect(await codeOf(enableAutostart(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, silent))).toBe(
      'INTERNAL',
    );
  });
});

describe('autostartStatus (TC-LIF-autostart-status)', () => {
  it('is off, with no program run, when there is no shortcut', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    expect(await autostartStatus(sb.ctx, { launcherPath: sb.launcher }, shell.deps)).toEqual({
      supported: true,
      enabled: false,
      shortcut: null,
      target: null,
      arguments: null,
      targetExists: null,
      matchesLauncher: null,
      note: null,
    });
    expect(shell.calls).toEqual([]);
  });

  it('is unsupported, every other field empty, off Windows', async () => {
    const sb = sandbox();
    expect(await autostartStatus(sb.ctx, { launcherPath: sb.launcher }, fakeShell('linux').deps)).toEqual({
      supported: false,
      enabled: false,
      shortcut: null,
      target: null,
      arguments: null,
      targetExists: null,
      matchesLauncher: null,
      note: null,
    });
  });

  it('says that the Startup folder is unknown when APPDATA is missing, without failing', async () => {
    const sb = sandbox();
    const status = await autostartStatus({ ...sb.ctx, env: {} }, { launcherPath: sb.launcher }, fakeShell().deps);
    expect(status).toMatchObject({ supported: true, enabled: false, shortcut: null });
    expect(status.note).toMatch(/APPDATA/);
  });

  it('reports a stale target: the program of the shortcut no longer exists', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    await enableAutostart(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps);
    shell.store.set(sb.lnk, { target: path.join(sb.dir, 'gone', 'node.exe'), args: expectedArgs(sb.launcher) });
    const status = await autostartStatus(sb.ctx, { launcherPath: sb.launcher }, shell.deps);
    expect(status).toMatchObject({ enabled: true, targetExists: false, matchesLauncher: true });
    expect(status.note).toMatch(/does not exist/);
    expect(status.note).toContain('caw autostart enable');
  });

  it('reports another launcher: the arguments name a different file than the one that runs the command', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    await enableAutostart(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps);
    const other = path.join(sb.dir, 'checkout', 'scripts', 'caw.mjs');
    const status = await autostartStatus(sb.ctx, { launcherPath: other }, shell.deps);
    expect(status).toMatchObject({ enabled: true, targetExists: true, matchesLauncher: false });
    expect(status.note).toMatch(/another launcher/);
    expect(status.note).toContain('caw autostart enable');
  });

  it('compares the launcher without regard to case, as Windows does', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    await enableAutostart(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps);
    const status = await autostartStatus(sb.ctx, { launcherPath: sb.launcher.toUpperCase() }, shell.deps);
    expect(status.matchesLauncher).toBe(true);
  });

  it('an unreadable shortcut is enabled with empty fields and a note, never a failure', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    await enableAutostart(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps);
    shell.failRead = true;
    const status = await autostartStatus(sb.ctx, { launcherPath: sb.launcher }, shell.deps);
    expect(status).toMatchObject({
      enabled: true,
      shortcut: sb.lnk,
      target: null,
      arguments: null,
      targetExists: null,
      matchesLauncher: null,
    });
    expect(status.note).toMatch(/could not be read/);
  });
});

describe('disableAutostart (TC-LIF-autostart-disable)', () => {
  it('removes the shortcut with no program, and is the same when there is none', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    await enableAutostart(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps);
    const before = shell.calls.length;
    const status = await disableAutostart(sb.ctx, shell.deps);
    expect(status).toMatchObject({ supported: true, enabled: false, shortcut: null });
    expect(existsSync(sb.lnk)).toBe(false);
    expect(await disableAutostart(sb.ctx, shell.deps)).toEqual(status);
    expect(shell.calls).toHaveLength(before);
    expect(readdirSync(sb.startup)).toEqual([]);
  });

  it('is the unsupported answer off Windows and the same answer without APPDATA, and touches nothing', async () => {
    const sb = sandbox();
    expect((await disableAutostart(sb.ctx, fakeShell('linux').deps)).supported).toBe(false);
    const status = await disableAutostart({ ...sb.ctx, env: {} }, fakeShell().deps);
    expect(status).toMatchObject({ supported: true, enabled: false });
    expect(status.note).toMatch(/APPDATA/);
  });
});

describe('refreshAutostartIfEnabled (TC-LIF-autostart-refresh, A5)', () => {
  it('is absent when autostart is off or unsupported, and runs nothing', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    const o = { launcherPath: sb.launcher, nodePath: sb.nodePath };
    expect(await refreshAutostartIfEnabled(sb.ctx, o, shell.deps)).toBe('absent');
    expect(await refreshAutostartIfEnabled({ ...sb.ctx, env: {} }, o, shell.deps)).toBe('absent');
    expect(await refreshAutostartIfEnabled(sb.ctx, o, fakeShell('linux').deps)).toBe('absent');
    expect(shell.calls).toEqual([]);
  });

  it('is current when the shortcut names this node and this launcher: it is not rewritten', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    const o = { launcherPath: sb.launcher, nodePath: sb.nodePath };
    await enableAutostart(sb.ctx, o, shell.deps);
    const before = shell.calls.length;
    expect(await refreshAutostartIfEnabled(sb.ctx, o, shell.deps)).toBe('current');
    // one read, no create
    expect(shell.calls.slice(before).map((spec) => decodeScript(spec.args))).toEqual([READ_SHORTCUT_SCRIPT]);
    expect(sb.warnings).toEqual([]);
  });

  it('rewrites a shortcut whose node is another one (Node was upgraded), same launcher', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    await enableAutostart(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps);
    const newNode = path.join(sb.dir, 'node-new', 'node.exe');
    mkdirSync(path.dirname(newNode), { recursive: true });
    writeFileSync(newNode, 'x');
    expect(await refreshAutostartIfEnabled(sb.ctx, { launcherPath: sb.launcher, nodePath: newNode }, shell.deps)).toBe(
      'refreshed',
    );
    expect(shell.store.get(sb.lnk)?.target).toBe(newNode);
  });

  it('rewrites a shortcut whose launcher file is gone (the plugin version moved)', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    const oldLauncher = path.join(sb.dir, 'old-version', 'scripts', 'caw.mjs');
    shell.store.set(sb.lnk, { target: sb.nodePath, args: expectedArgs(oldLauncher) });
    mkdirSync(sb.startup, { recursive: true });
    writeFileSync(sb.lnk, 'placeholder');
    const outcome = await refreshAutostartIfEnabled(
      sb.ctx,
      { launcherPath: sb.launcher, nodePath: sb.nodePath },
      shell.deps,
    );
    expect(outcome).toBe('refreshed');
    expect(shell.store.get(sb.lnk)).toEqual({ target: sb.nodePath, args: expectedArgs(sb.launcher) });
    expect(sb.warnings).toEqual([]);
  });

  it('rewrites a shortcut of an older version of the same plugin cache family while that version still exists', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    const older = path.join(
      sb.dir,
      'plugins',
      'cache',
      'market',
      'caw',
      '0.9.0',
      'skills',
      'caw',
      'scripts',
      'caw.mjs',
    );
    mkdirSync(path.dirname(older), { recursive: true });
    writeFileSync(older, 'x');
    mkdirSync(sb.startup, { recursive: true });
    writeFileSync(sb.lnk, 'placeholder');
    shell.store.set(sb.lnk, { target: sb.nodePath, args: expectedArgs(older) });
    expect(
      await refreshAutostartIfEnabled(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps),
    ).toBe('refreshed');
    expect(shell.store.get(sb.lnk)?.args).toBe(expectedArgs(sb.launcher));
  });

  it('rewrites a shortcut of the installed skill folder when the new launcher is in the same folder family', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    const skills = path.join(sb.dir, '.claude', 'skills', 'caw');
    const first = path.join(skills, 'scripts', 'caw.mjs');
    const second = path.join(skills, 'skills', 'caw', 'scripts', 'caw.mjs');
    for (const file of [first, second]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'x');
    }
    mkdirSync(sb.startup, { recursive: true });
    writeFileSync(sb.lnk, 'placeholder');
    shell.store.set(sb.lnk, { target: sb.nodePath, args: expectedArgs(first) });
    expect(await refreshAutostartIfEnabled(sb.ctx, { launcherPath: second, nodePath: sb.nodePath }, shell.deps)).toBe(
      'refreshed',
    );
  });

  it('leaves alone, and warns about, a launcher outside the install that still exists (a checkout, a QA stack)', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    const checkout = path.join(sb.dir, 'checkout', 'skills', 'caw', 'scripts', 'caw.mjs');
    mkdirSync(path.dirname(checkout), { recursive: true });
    writeFileSync(checkout, 'x');
    mkdirSync(sb.startup, { recursive: true });
    writeFileSync(sb.lnk, 'placeholder');
    shell.store.set(sb.lnk, { target: sb.nodePath, args: expectedArgs(checkout) });
    const before = shell.calls.length;
    expect(
      await refreshAutostartIfEnabled(sb.ctx, { launcherPath: sb.launcher, nodePath: sb.nodePath }, shell.deps),
    ).toBe('foreign-target');
    expect(shell.store.get(sb.lnk)?.args).toBe(expectedArgs(checkout));
    expect(shell.calls.slice(before).map((spec) => decodeScript(spec.args))).toEqual([READ_SHORTCUT_SCRIPT]);
    expect(sb.warnings).toEqual(['autostart.foreign_target']);
  });

  it('leaves alone a shortcut that is not ours (other arguments) and one that cannot be read', async () => {
    const sb = sandbox();
    const shell = fakeShell();
    mkdirSync(sb.startup, { recursive: true });
    writeFileSync(sb.lnk, 'placeholder');
    shell.store.set(sb.lnk, { target: sb.nodePath, args: '--version' });
    const o = { launcherPath: sb.launcher, nodePath: sb.nodePath };
    expect(await refreshAutostartIfEnabled(sb.ctx, o, shell.deps)).toBe('foreign-target');
    shell.failRead = true;
    expect(await refreshAutostartIfEnabled(sb.ctx, o, shell.deps)).toBe('foreign-target');
    expect(shell.store.get(sb.lnk)?.args).toBe('--version');
    expect(sb.warnings).toEqual(['autostart.foreign_target', 'autostart.foreign_target']);
  });
});

describe('the real Windows PowerShell (TC-LIF-autostart-real)', () => {
  const onWindows = hostPlatform === 'win32';

  it.skipIf(!onWindows)(
    'makes, reads, refreshes and removes a real shortcut in a temp Startup folder, non-ASCII path included',
    async () => {
      const sb = sandbox();
      const odd = path.join(sb.dir, 'Łukasz Żółć', 'scripts', 'caw.mjs');
      mkdirSync(path.dirname(odd), { recursive: true });
      writeFileSync(odd, 'x');
      const nodePath = process.execPath;
      const real: AutostartDeps = { platform: 'win32', execFileText, resolveExecutable };
      const status = await enableAutostart(sb.ctx, { launcherPath: odd, nodePath }, real);
      expect(status).toMatchObject({
        supported: true,
        enabled: true,
        shortcut: sb.lnk,
        arguments: expectedArgs(odd),
        targetExists: true,
        matchesLauncher: true,
        note: null,
      });
      expect(status.target?.toLowerCase()).toBe(nodePath.toLowerCase());
      expect(readFileSync(sb.lnk).length).toBeGreaterThan(0);
      expect(await refreshAutostartIfEnabled(sb.ctx, { launcherPath: odd, nodePath }, real)).toBe('current');
      expect(await disableAutostart(sb.ctx, real)).toMatchObject({ enabled: false });
      expect(existsSync(sb.lnk)).toBe(false);
    },
    60_000,
  );
});
