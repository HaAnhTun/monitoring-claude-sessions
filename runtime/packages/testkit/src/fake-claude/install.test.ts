// The install helper of the fake claude (design 08, sections 2.1 and 2.2): TC-FAKE-20 launcher flavours and the PATHEXT order,
// TC-FAKE-21 the claude-free PATH and `assertClaudeFree`, TC-FAKE-22 a folder with spaces and non-ASCII characters.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hermeticEnv } from '../isolation.ts';
import { runProcess } from '../processes.ts';
import { useTempDirs } from '../temp.ts';
import {
  assertClaudeFree,
  claudeFreePath,
  fakeClaudeInvocation,
  fakeClaudeLauncher,
  fakeClaudeScriptPath,
  installFakeClaude,
  terminalEnv,
  writeFakeClaudeShim,
  type FakeClaudeInstall,
} from './install.ts';
import { TAG, parseReady } from './protocol.ts';

const tempDir = useTempDirs();
const WIN = process.platform === 'win32';
const ASSET = fileURLToPath(new URL('../../assets/fake-claude.mjs', import.meta.url));
const CMD = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe');
const LAUNCHER_NAMES = ['claude', 'claude.exe', 'claude.cmd', 'claude.bat', 'claude.ps1'];

const names = (dir: string): string[] => readdirSync(dir).sort();

/** A function that runs `assertClaudeFree`, for `expect(...).toThrow()`. */
const free =
  (path: string, allowed: string): (() => void) =>
  () => {
    assertClaudeFree(path, allowed);
  };

/** Runs `claude` the way a resolver would: through `cmd.exe` on Windows (the `.cmd` of the PATH), directly elsewhere. */
async function runClaude(
  install: FakeClaudeInstall,
  root: string,
  args: readonly string[],
  input: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = terminalEnv(root, install);
  const [file, argv] = WIN ? [CMD, ['/d', '/s', '/c', 'claude', ...args]] : [install.shim, [...args]];
  const { code, stdout, stderr } = await runProcess(file, argv, { cwd: root, env, stdin: input });
  return { code, stdout, stderr };
}

function argsLine(stdout: string): string[] {
  const line = stdout.split('\r\n').find((candidate) => candidate.startsWith(TAG.args));
  if (line === undefined) throw new Error('no ARGS line');
  const parsed: unknown = JSON.parse(line.slice(TAG.args.length));
  if (!Array.isArray(parsed)) throw new Error('ARGS is not an array');
  return parsed.map(String);
}

describe('installFakeClaude', () => {
  it('TC-FAKE-20 npm-shim writes the script and the three launchers of an npm global package', () => {
    const dir = join(tempDir('fake-install').path, 'bin');
    const install = installFakeClaude(dir, { flavour: 'npm-shim' });
    expect(names(dir)).toEqual(['claude', 'claude.cmd', 'claude.ps1', 'fake-claude.mjs']);
    expect(install.binDir).toBe(dir);
    expect(install.script).toBe(join(dir, 'fake-claude.mjs'));
    expect(readFileSync(install.script, 'utf8')).toBe(readFileSync(ASSET, 'utf8'));
    expect(install.shim).toBe(join(dir, WIN ? 'claude.cmd' : 'claude'));
    expect(install.direct).toEqual({ file: process.execPath, args: [install.script] });
    expect(readFileSync(join(dir, 'claude.cmd'), 'utf8')).toBe(fakeClaudeLauncher('cmd'));
    expect(readFileSync(join(dir, 'claude.ps1'), 'utf8')).toBe(fakeClaudeLauncher('ps1'));
    expect(readFileSync(join(dir, 'claude'), 'utf8')).toBe(fakeClaudeLauncher('sh'));
    if (!WIN) expect(statSync(join(dir, 'claude')).mode & 0o111).not.toBe(0);
  });

  it('TC-FAKE-20 the launchers run the script of their own folder with the arguments they get', () => {
    const cmd = fakeClaudeLauncher('cmd', 'C:\\tools\\node.exe');
    expect(cmd.startsWith('@ECHO off\r\n')).toBe(true);
    expect(cmd).toContain('"C:\\tools\\node.exe" "%~dp0fake-claude.mjs" %*');
    expect(cmd.endsWith('\r\n')).toBe(true);
    const sh = fakeClaudeLauncher('sh', 'C:\\tools\\node.exe');
    expect(sh.startsWith('#!/bin/sh\n')).toBe(true);
    expect(sh).toContain('exec "C:/tools/node.exe" "$(dirname "$0")/fake-claude.mjs" "$@"');
    const ps1 = fakeClaudeLauncher('ps1', "C:\\it's\\node.exe");
    expect(ps1).toContain("& 'C:\\it''s\\node.exe' (Join-Path $PSScriptRoot 'fake-claude.mjs') @args");
    expect(ps1).toContain('exit $LASTEXITCODE');
    // A node path that a .cmd file cannot hold (it is read in the OEM code page) is looked up on the PATH instead.
    expect(fakeClaudeLauncher('cmd', 'C:\\Users\\caf\u00e9\\node.exe')).toContain('node "%~dp0fake-claude.mjs" %*');
  });

  it('TC-FAKE-20 cmd-only writes one launcher and sh writes the extensionless one', () => {
    const root = tempDir('fake-flavours').path;
    const cmdOnly = installFakeClaude(join(root, 'cmd'), { flavour: 'cmd-only' });
    expect(names(cmdOnly.binDir)).toEqual(['claude.cmd', 'fake-claude.mjs']);
    expect(cmdOnly.shim).toBe(join(root, 'cmd', 'claude.cmd'));
    const sh = installFakeClaude(join(root, 'sh'), { flavour: 'sh' });
    expect(names(sh.binDir)).toEqual(['claude', 'fake-claude.mjs']);
    expect(sh.shim).toBe(join(root, 'sh', 'claude'));
    const fallback = installFakeClaude(join(root, 'default'));
    expect(names(fallback.binDir)).toEqual(
      WIN ? ['claude', 'claude.cmd', 'claude.ps1', 'fake-claude.mjs'] : ['claude', 'fake-claude.mjs'],
    );
  });

  it('TC-FAKE-20 an install is repeatable, and the helper functions keep the names of the pty design', () => {
    const root = tempDir('fake-names').path;
    const dir = join(root, 'again');
    installFakeClaude(dir, { flavour: 'cmd-only' });
    installFakeClaude(dir, { flavour: 'cmd-only' });
    expect(names(dir)).toEqual(['claude.cmd', 'fake-claude.mjs']);
    const invocation = fakeClaudeInvocation();
    expect(invocation).toEqual({ file: process.execPath, args: [fakeClaudeScriptPath()] });
    expect(resolve(fakeClaudeScriptPath())).toBe(resolve(ASSET));
    expect(existsSync(fakeClaudeScriptPath())).toBe(true);
    const shim = writeFakeClaudeShim(join(root, 'shim dir'));
    expect(shim).toBe(join(root, 'shim dir', 'claude.cmd'));
    expect(names(dirname(shim))).toEqual(['claude.cmd', 'fake-claude.mjs']);
  });

  it('TC-FAKE-20 the PATH of an install puts the launcher folder before the claude-free path', () => {
    const dir = join(tempDir('fake-pathvalue').path, 'bin');
    const install = installFakeClaude(dir, { flavour: 'cmd-only' });
    expect(install.pathValue()).toBe(`${dir}${delimiter}${claudeFreePath()}`);
  });

  it('TC-FAKE-20 the .cmd launcher is the one a PATHEXT search finds, and it passes the arguments through', async () => {
    const root = tempDir('fake-run').path;
    const install = installFakeClaude(join(root, 'bin'), { flavour: 'npm-shim' });
    const args = ['--flag', 'a b', '--resume', 'abc'];
    const run = await runClaude(install, root, args, '/exit 7\n');
    expect(run.code).toBe(7);
    expect(parseReady(run.stdout)?.args).toEqual(args);
    expect(run.stdout).toContain('BYE:7');
    const more = await runClaude(install, root, args, '/args\n/exit\n');
    expect(argsLine(more.stdout)).toEqual(args);
  });

  it('TC-FAKE-20 an extensionless launcher alone is not found by a Windows search', async () => {
    const root = tempDir('fake-bare').path;
    const install = installFakeClaude(join(root, 'bin'), { flavour: 'sh' });
    if (!WIN) {
      const run = await runClaude(install, root, [], '/exit 3\n');
      expect(run.code).toBe(3);
      return;
    }
    const { code, stdout, stderr } = await runProcess(CMD, ['/d', '/s', '/c', 'claude'], {
      cwd: root,
      env: terminalEnv(root, install),
      stdin: '/exit 3\n',
    });
    expect(code).not.toBe(3);
    expect(stdout).not.toContain(TAG.ready);
    expect(`${stdout}${stderr}`.length).toBeGreaterThan(0);
  });

  it('TC-FAKE-20 --install of the script writes the same launchers as the helper', async () => {
    const root = tempDir('fake-cli-install').path;
    const viaScript = join(root, 'script');
    const result = await runProcess(process.execPath, [ASSET, '--install', viaScript], {
      cwd: root,
      env: hermeticEnv(root),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(viaScript);
    const viaHelper = installFakeClaude(join(root, 'helper'));
    expect(names(viaScript)).toEqual(names(viaHelper.binDir));
    for (const name of names(viaScript)) {
      expect(readFileSync(join(viaScript, name), 'utf8'), name).toBe(
        readFileSync(join(viaHelper.binDir, name), 'utf8'),
      );
    }
  });
});

describe('claude-free PATH', () => {
  it('TC-FAKE-21 claudeFreePath holds the system folder (Windows), the folder of node and what the caller adds', () => {
    const extra = join(tempDir('fake-extra').path, 'tools');
    const entries = claudeFreePath([extra]).split(delimiter);
    expect(entries).toContain(dirname(process.execPath));
    expect(entries.at(-1)).toBe(extra);
    if (WIN)
      expect(entries.map((entry) => entry.toLowerCase())).toContain(
        join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32').toLowerCase(),
      );
    else expect(entries).toEqual(expect.arrayContaining(['/usr/bin', '/bin']));
    expect(new Set(entries.map((entry) => entry.toLowerCase())).size).toBe(entries.length);
    expect(claudeFreePath()).not.toContain(extra);
  });

  it('TC-FAKE-21 the default claude-free PATH reaches no launcher called claude', () => {
    expect(free(claudeFreePath(), '')).not.toThrow();
  });

  it('TC-FAKE-21 assertClaudeFree throws on a folder that holds any launcher named claude and names it', () => {
    const root = tempDir('fake-guard').path;
    for (const name of LAUNCHER_NAMES) {
      const dir = join(root, `holds ${name}`);
      mkdirSync(dir);
      writeFileSync(join(dir, name), 'not the real thing\n');
      const path = `${claudeFreePath()}${delimiter}${dir}`;
      expect(free(path, ''), name).toThrow(new RegExp(name.replaceAll('.', '\\.')));
      expect(free(path, dir), `${name} in the allowed folder`).not.toThrow();
    }
  });

  it('TC-FAKE-21 assertClaudeFree compares folders the way the platform does and skips empty entries', () => {
    const root = tempDir('fake-guard-case').path;
    const dir = join(root, 'Allowed');
    mkdirSync(dir);
    writeFileSync(join(dir, 'claude.cmd'), '\n');
    if (WIN) expect(free(dir.toUpperCase(), dir.toLowerCase())).not.toThrow();
    expect(free(`${delimiter}${delimiter}${claudeFreePath()}`, '')).not.toThrow();
    expect(free(`${join(root, 'missing')}${delimiter}${claudeFreePath()}`, '')).not.toThrow();
    const relativeRoot = tempDir('fake-guard-relative').path;
    mkdirSync(join(relativeRoot, 'rel'));
    writeFileSync(join(relativeRoot, 'rel', 'claude'), '\n');
    const previous = process.cwd();
    process.chdir(relativeRoot);
    try {
      expect(free('rel', '')).toThrow(/claude/);
    } finally {
      process.chdir(previous);
    }
  });

  it('TC-FAKE-21 terminalEnv is hermetic, points the PATH at the install and logs into the root', () => {
    const root = tempDir('fake-env').path;
    const install = installFakeClaude(join(root, 'bin'), { flavour: 'cmd-only' });
    const env = terminalEnv(root, install, { FAKE_CLAUDE_SEED: 'seed-x' });
    const base = hermeticEnv(root);
    for (const key of ['HOME', 'USERPROFILE', 'MCS_HOME', 'CLAUDE_CONFIG_DIR', 'MCS_HOOK_DISABLE', 'MCS_TEST', 'TZ']) {
      expect(env[key], key).toBe(base[key]);
    }
    expect(env['PATH']).toBe(install.pathValue());
    expect(env['FAKE_CLAUDE_LOG']).toBe(join(root, 'fake-claude.log'));
    expect(env['FAKE_CLAUDE_SEED']).toBe('seed-x');
    const override = terminalEnv(root, install, { FAKE_CLAUDE_LOG: join(root, 'other.log') });
    expect(override['FAKE_CLAUDE_LOG']).toBe(join(root, 'other.log'));
  });

  it('TC-FAKE-21 terminalEnv without an install is the claude-missing state', () => {
    const root = tempDir('fake-missing').path;
    const env = terminalEnv(root, null);
    expect(env['PATH']).toBe(claudeFreePath());
    expect(env['FAKE_CLAUDE_LOG']).toBe(join(root, 'fake-claude.log'));
    expect(free(env['PATH'] ?? '', '')).not.toThrow();
  });

  it('TC-FAKE-21 terminalEnv refuses a PATH that can reach a claude launcher', () => {
    const root = tempDir('fake-refuse').path;
    const install = installFakeClaude(join(root, 'bin'), { flavour: 'cmd-only' });
    const foreign = join(root, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'claude.cmd'), '\n');
    expect(() => terminalEnv(root, install, { PATH: `${install.pathValue()}${delimiter}${foreign}` })).toThrow(
      /claude\.cmd/,
    );
    expect(() => terminalEnv(root, null, { PATH: foreign })).toThrow(/claude\.cmd/);
  });
});

describe('a folder with spaces and non-ASCII characters', () => {
  it('TC-FAKE-22 the shim and the direct route both start the fake from "fake bin \u00e9"', async () => {
    const root = tempDir('fake-unicode').path;
    const dir = join(root, 'fake bin \u00e9');
    const install = installFakeClaude(dir);
    expect(install.binDir).toBe(dir);
    expect(install.pathValue().startsWith(dir)).toBe(true);
    const args = ['--name', 'two words', '--flag=\u00e9'];
    const viaShim = await runClaude(install, root, args, '/args\n/exit 4\n');
    expect(viaShim.code).toBe(4);
    expect(argsLine(viaShim.stdout)).toEqual(args);
    const direct = await runProcess(install.direct.file, [...install.direct.args, ...args], {
      cwd: root,
      env: terminalEnv(root, install),
      stdin: '/args\n/exit 5\n',
    });
    expect(direct.code).toBe(5);
    expect(argsLine(direct.stdout)).toEqual(args);
  });

  it('TC-FAKE-22 the fake runs in a working folder with spaces and non-ASCII characters', async () => {
    const root = tempDir('fake-unicode-cwd').path;
    const install = installFakeClaude(join(root, 'bin'));
    const cwd = join(root, 'work dir \u00e9');
    mkdirSync(cwd);
    const { code, stdout } = await runProcess(install.direct.file, [...install.direct.args], {
      cwd,
      env: terminalEnv(root, install),
      stdin: '/cwd\n/exit 0\n',
    });
    expect(code).toBe(0);
    const line = stdout.split('\r\n').find((candidate) => candidate.startsWith(TAG.cwd));
    expect(line?.endsWith('work dir \u00e9')).toBe(true);
  });
});
