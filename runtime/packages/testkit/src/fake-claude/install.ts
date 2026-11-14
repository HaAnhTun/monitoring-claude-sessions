// Putting the fake claude where the production command resolution finds it (design 08, sections 2.1 and 2.2): launchers written the
// way npm writes them for a global package, a PATH that cannot reach the real claude, and the environment of a terminal test.
// The tests never spawn the fake directly (except its own pipe-mode self-tests): the server resolves `claude` with its own code.
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hermeticEnv } from '../isolation.ts';

/** Name of the script copied next to the launchers. */
export const FAKE_CLAUDE_FILE = 'fake-claude.mjs';

/** `npm-shim`: the extensionless `sh` script, `claude.cmd` and `claude.ps1` (so the `PATHEXT` precedence is exercised); `cmd-only`: `claude.cmd`; `sh`: the extensionless script. */
export type FakeClaudeFlavour = 'npm-shim' | 'cmd-only' | 'sh';

export interface InstallFakeClaudeOptions {
  /** Default: `npm-shim` on Windows, `sh` elsewhere. */
  flavour?: FakeClaudeFlavour;
}

export interface FakeClaudeInstall {
  readonly binDir: string;
  /** The copy of the script inside `binDir`. */
  readonly script: string;
  /** The launcher a search of the PATH finds first: `claude.cmd` on Windows (or with `cmd-only`), `claude` otherwise. */
  readonly shim: string;
  /** What `terminal.command` and `terminal.args` take to start the script without a shim. */
  readonly direct: { readonly file: string; readonly args: readonly string[] };
  /** `binDir` before the claude-free path. */
  pathValue(): string;
}

const WIN = process.platform === 'win32';

/** The script in `assets/`: the same relative path from `src/fake-claude/` and from `dist/fake-claude/` (tsc does not copy `.mjs`). */
export function fakeClaudeScriptPath(): string {
  return fileURLToPath(new URL('../../assets/fake-claude.mjs', import.meta.url));
}

/** `{ file, args }` that start the script from the testkit with this process's Node: the direct route (the names of the pty design). */
export function fakeClaudeInvocation(): { file: string; args: string[] } {
  return { file: process.execPath, args: [fakeClaudeScriptPath()] };
}

function isAscii(text: string): boolean {
  for (const char of text) if ((char.codePointAt(0) ?? 0) > 0x7f) return false;
  return true;
}

/**
 * The text of a launcher. A `.cmd` file is read in the console code page, so it holds no path of the script (`%~dp0` is the folder of
 * the file, spelled by the file system) and, when the path of Node is not ASCII, finds `node` on the PATH instead. `assets/fake-claude.mjs`
 * writes the same text for `--install`; a test compares the two.
 */
export function fakeClaudeLauncher(kind: 'cmd' | 'ps1' | 'sh', nodePath: string = process.execPath): string {
  if (kind === 'cmd') {
    const node = isAscii(nodePath) && !nodePath.includes('"') ? `"${nodePath}"` : 'node';
    return `@ECHO off\r\n${node} "%~dp0${FAKE_CLAUDE_FILE}" %*\r\n`;
  }
  if (kind === 'ps1') {
    return `#!/usr/bin/env pwsh\r\n& '${nodePath.replaceAll("'", "''")}' (Join-Path $PSScriptRoot '${FAKE_CLAUDE_FILE}') @args\r\nexit $LASTEXITCODE\r\n`;
  }
  const node = nodePath.replaceAll('\\', '/');
  return `#!/bin/sh\nexec "${node}" "$(dirname "$0")/${FAKE_CLAUDE_FILE}" "$@"\n`;
}

/** Copies the script into `dir` (made when missing) and writes the launchers of the flavour. */
export function installFakeClaude(dir: string, opts: InstallFakeClaudeOptions = {}): FakeClaudeInstall {
  const flavour: FakeClaudeFlavour = opts.flavour ?? (WIN ? 'npm-shim' : 'sh');
  const binDir = dir;
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, FAKE_CLAUDE_FILE);
  copyFileSync(fakeClaudeScriptPath(), script);
  const cmd = join(binDir, 'claude.cmd');
  const sh = join(binDir, 'claude');
  if (flavour === 'npm-shim' || flavour === 'cmd-only') writeFileSync(cmd, fakeClaudeLauncher('cmd'));
  if (flavour === 'npm-shim') writeFileSync(join(binDir, 'claude.ps1'), fakeClaudeLauncher('ps1'));
  if (flavour === 'npm-shim' || flavour === 'sh') {
    writeFileSync(sh, fakeClaudeLauncher('sh'));
    chmodSync(sh, 0o755);
  }
  const shim = flavour === 'sh' || (flavour === 'npm-shim' && !WIN) ? sh : cmd;
  return {
    binDir,
    script,
    shim,
    direct: { file: process.execPath, args: [script] },
    pathValue: () => `${binDir}${delimiter}${claudeFreePath()}`,
  };
}

/** `fakeClaudeLauncher('cmd')` in `dir`: the shim route alone, in a folder the caller names (with a space, for the PATH tests). */
export function writeFakeClaudeShim(dir: string): string {
  return installFakeClaude(dir, { flavour: 'cmd-only' }).shim;
}

/**
 * A PATH that cannot resolve the real claude: the system folder (Windows: `<SystemRoot>\System32`, for `cmd.exe`) or `/usr/bin:/bin`,
 * the folder of the running Node, and `extra`. The real claude lives in the user profile or in the npm global folder, neither of which is here.
 */
export function claudeFreePath(extra: readonly string[] = []): string {
  const system = WIN
    ? [join(process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows', 'System32')]
    : ['/usr/bin', '/bin'];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of [...system, dirname(process.execPath), ...extra]) {
    const key = WIN ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries.join(delimiter);
}

const CLAUDE_LAUNCHERS = ['claude', 'claude.exe', 'claude.cmd', 'claude.bat', 'claude.ps1'];

function sameFolder(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return WIN ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Throws when a folder of `pathValue` other than `allowedDir` holds a launcher named `claude` (`claude`, `.exe`, `.cmd`, `.bat`, `.ps1`):
 * a test must never be able to start the real thing. Empty entries are skipped; a relative entry counts from the working folder.
 */
export function assertClaudeFree(pathValue: string, allowedDir: string): void {
  for (const entry of pathValue.split(delimiter)) {
    if (entry === '') continue;
    if (allowedDir !== '' && sameFolder(entry, allowedDir)) continue;
    for (const name of CLAUDE_LAUNCHERS) {
      if (existsSync(join(resolve(entry), name))) {
        throw new Error(
          `assertClaudeFree: ${resolve(entry)} holds ${name}; a terminal test must not be able to reach a claude that is not the fake`,
        );
      }
    }
  }
}

/**
 * The environment of a terminal test: `hermeticEnv(root)`, the PATH of the install (or the claude-free path alone when `install` is
 * null: the "claude missing" state), and `FAKE_CLAUDE_LOG=<root>/fake-claude.log`; `extra` is applied last. Throws when the final PATH
 * can reach a claude launcher of another folder.
 */
export function terminalEnv(
  root: string,
  install: FakeClaudeInstall | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    ...hermeticEnv(root),
    PATH: install === null ? claudeFreePath() : install.pathValue(),
    FAKE_CLAUDE_LOG: join(root, 'fake-claude.log'),
    ...extra,
  };
  assertClaudeFree(env['PATH'] ?? '', install?.binDir ?? '');
  return env;
}
