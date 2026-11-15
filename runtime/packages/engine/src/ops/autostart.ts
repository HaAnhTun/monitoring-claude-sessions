// Autostart (06 2.7): an optional shortcut in the Startup folder that runs `node "<launcher>" start --no-open` at sign-in,
// minimized. Windows only, off by default, no browser and no access code at logon. The shortcut is made and read by Windows
// PowerShell 5.1 through the `WScript.Shell` object with two CONSTANT scripts: every value (paths, arguments, description)
// travels in a `CAW_LNK_*` variable of the child, never in the script text, so no path can change what runs. What the read
// script prints is base64 of UTF-8, so non-ASCII profile paths survive the OEM code page of the pipe. Removing the shortcut
// is a plain file removal. `refreshAutostartIfEnabled` heals a shortcut whose Node or launcher moved with an install update,
// but never one that points at a launcher outside this install (a checkout, a QA stack): that is left alone and warned about.
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { McsError, type AutostartStatus } from '@mcs/shared';

import { execFileText, powershellEncodedArgs, resolveExecutable } from '../platform/exec.ts';
import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import type { OpContext } from './workspace.ts';

export type { AutostartStatus } from '@mcs/shared';

/** The file name of the shortcut in the Startup folder. */
export const AUTOSTART_SHORTCUT_NAME = 'Claude Agent Workspace.lnk';

const DESCRIPTION = 'Claude Agent Workspace: starts the app in the background at sign-in';
const STARTUP_PARTS = ['Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'] as const;
const SCRIPT_TIMEOUT_MS = 20_000;
const SCRIPT_MAX_OUTPUT_BYTES = 8192;

/**
 * Creates the shortcut. `WindowStyle` 7 is "minimized, not activated". The five values come from the environment of the
 * child: `CAW_LNK_PATH` (the `.lnk`), `CAW_LNK_TARGET` (`node.exe`), `CAW_LNK_ARGS`, `CAW_LNK_WORKDIR`, `CAW_LNK_DESC`.
 */
export const CREATE_SHORTCUT_SCRIPT =
  "$ErrorActionPreference='Stop'; " +
  '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:CAW_LNK_PATH); ' +
  '$s.TargetPath=$env:CAW_LNK_TARGET; ' +
  '$s.Arguments=$env:CAW_LNK_ARGS; ' +
  '$s.WorkingDirectory=$env:CAW_LNK_WORKDIR; ' +
  '$s.WindowStyle=7; ' +
  '$s.Description=$env:CAW_LNK_DESC; ' +
  '$s.Save()';

/** Reads the shortcut named by `CAW_LNK_PATH`: the base64 of the target, a tab, the base64 of the arguments (UTF-8 each). */
export const READ_SHORTCUT_SCRIPT =
  "$ErrorActionPreference='Stop'; " +
  '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:CAW_LNK_PATH); ' +
  '$e=[System.Text.Encoding]::UTF8; ' +
  '[Console]::Out.Write([Convert]::ToBase64String($e.GetBytes($s.TargetPath)) + [string][char]9 + ' +
  '[Convert]::ToBase64String($e.GetBytes($s.Arguments)))';

/** Everything that touches the machine, replaceable in tests. */
export interface AutostartDeps {
  readonly platform?: HostPlatform;
  readonly execFileText?: typeof execFileText;
  readonly resolveExecutable?: typeof resolveExecutable;
}

export interface AutostartTarget {
  /** The launcher that runs `caw` (absolute): it goes into the arguments of the shortcut. */
  readonly launcherPath: string;
  /** The `node.exe` that runs it (absolute, `.exe`): the target of the shortcut. */
  readonly nodePath: string;
}

export type AutostartRefresh = 'absent' | 'current' | 'refreshed' | 'foreign-target';

// ---- places and values -------------------------------------------------------------------------------------------------

/** `<APPDATA>\Microsoft\Windows\Start Menu\Programs\Startup`, or `null` without an absolute `APPDATA`. */
function startupDirOf(env: OpContext['env']): string | null {
  const appData = env['APPDATA'];
  if (appData === undefined || appData === '' || !path.isAbsolute(appData)) return null;
  return path.join(appData, ...STARTUP_PARTS);
}

function argumentsOf(launcherPath: string): string {
  return `"${launcherPath}" start --no-open`;
}

function sameText(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

const UNSUPPORTED: AutostartStatus = {
  supported: false,
  enabled: false,
  shortcut: null,
  target: null,
  arguments: null,
  targetExists: null,
  matchesLauncher: null,
  note: null,
};

function off(note: string | null): AutostartStatus {
  return { ...UNSUPPORTED, supported: true, note };
}

const NO_APPDATA_NOTE = 'the Startup folder is unknown: APPDATA is not set to an absolute path';

// ---- the shortcut program ----------------------------------------------------------------------------------------------

interface Shortcut {
  readonly target: string;
  readonly arguments: string;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(text: string): string | null {
  if (!BASE64.test(text)) return null;
  return Buffer.from(text, 'base64').toString('utf8');
}

async function readShortcut(lnk: string, deps: AutostartDeps): Promise<Shortcut | null> {
  const powershell = await (deps.resolveExecutable ?? resolveExecutable)('powershell');
  if (powershell === null) return null;
  const result = await (deps.execFileText ?? execFileText)({
    kind: 'powershell.shortcut',
    file: powershell,
    args: powershellEncodedArgs(READ_SHORTCUT_SCRIPT),
    timeoutMs: SCRIPT_TIMEOUT_MS,
    maxOutputBytes: SCRIPT_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    extraEnv: { CAW_LNK_PATH: lnk },
  });
  if (!result.ok) return null;
  const parts = result.stdout.trim().split('\t');
  if (parts.length !== 2) return null;
  const target = decodeBase64(parts[0] ?? '');
  const args = decodeBase64(parts[1] ?? '');
  return target === null || args === null ? null : { target, arguments: args };
}

function failure(startup: string, o: AutostartTarget, reason: string): McsError {
  const how =
    `Create it by hand in ${startup}: a shortcut to "${o.nodePath}" with the arguments ${argumentsOf(o.launcherPath)}, ` +
    'run minimized.';
  return new McsError('INTERNAL', `could not create the autostart shortcut: ${reason}.`, { hint: how });
}

async function createShortcut(ctx: OpContext, startup: string, o: AutostartTarget, deps: AutostartDeps): Promise<void> {
  const lnk = path.join(startup, AUTOSTART_SHORTCUT_NAME);
  const powershell = await (deps.resolveExecutable ?? resolveExecutable)('powershell');
  if (powershell === null) throw failure(startup, o, 'Windows PowerShell was not found');
  await mkdir(startup, { recursive: true });
  const workDir = ctx.env['USERPROFILE'] ?? ctx.env['HOME'] ?? path.dirname(o.launcherPath);
  const result = await (deps.execFileText ?? execFileText)({
    kind: 'powershell.shortcut',
    file: powershell,
    args: powershellEncodedArgs(CREATE_SHORTCUT_SCRIPT),
    timeoutMs: SCRIPT_TIMEOUT_MS,
    maxOutputBytes: SCRIPT_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    extraEnv: {
      CAW_LNK_PATH: lnk,
      CAW_LNK_TARGET: o.nodePath,
      CAW_LNK_ARGS: argumentsOf(o.launcherPath),
      CAW_LNK_WORKDIR: workDir,
      CAW_LNK_DESC: DESCRIPTION,
    },
  });
  // The text the script wrote is not repeated: it can name paths of the person's profile.
  if (!result.ok) {
    throw failure(startup, o, 'Windows refused the shortcut object (WScript.Shell may be disabled by a policy)');
  }
  if (!(await isFile(lnk))) throw failure(startup, o, 'the shortcut is not there after the script ran');
}

/** True when the text holds a quote, a line break or any other control character: none may reach a shortcut. */
function hasUnsafeCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === '"') return true;
  }
  return false;
}

function validateTarget(o: AutostartTarget): void {
  let problem: string | null = null;
  if (!path.isAbsolute(o.nodePath) || path.extname(o.nodePath).toLowerCase() !== '.exe') {
    problem = 'nodePath must be an absolute path of an .exe';
  } else if (!path.isAbsolute(o.launcherPath)) {
    problem = 'launcherPath must be an absolute path';
  } else if (hasUnsafeCharacter(o.nodePath) || hasUnsafeCharacter(o.launcherPath)) {
    problem = 'a path holds a quote or a control character';
  }
  if (problem !== null) throw new McsError('USAGE', `cannot make the autostart shortcut: ${problem}`);
}

// ---- operations --------------------------------------------------------------------------------------------------------

/**
 * The state of the autostart shortcut. `supported: false` off Windows. A shortcut is `enabled` when its file exists; its
 * target and arguments are read back, `matchesLauncher` says that the arguments name `launcherPath` (case-insensitive) and
 * `note` explains a stale target or another launcher. A shortcut that cannot be read is still `enabled`, with a note.
 */
export async function autostartStatus(
  ctx: OpContext,
  o: Pick<AutostartTarget, 'launcherPath'>,
  deps: AutostartDeps = {},
): Promise<AutostartStatus> {
  if ((deps.platform ?? hostPlatform) !== 'win32') return UNSUPPORTED;
  const startup = startupDirOf(ctx.env);
  if (startup === null) return off(NO_APPDATA_NOTE);
  const lnk = path.join(startup, AUTOSTART_SHORTCUT_NAME);
  if (!(await isFile(lnk))) return off(null);
  const shortcut = await readShortcut(lnk, deps);
  if (shortcut === null) {
    return {
      ...off('the shortcut exists but could not be read'),
      enabled: true,
      shortcut: lnk,
    };
  }
  const targetExists = shortcut.target !== '' && (await isFile(shortcut.target));
  const matchesLauncher = sameText(shortcut.arguments, argumentsOf(o.launcherPath));
  let note: string | null = null;
  if (!targetExists) {
    note = 'the shortcut points to a program that does not exist; run `caw autostart enable` to refresh it';
  } else if (!matchesLauncher) {
    note = 'the shortcut points to another launcher; run `caw autostart enable` to refresh it';
  }
  return {
    supported: true,
    enabled: true,
    shortcut: lnk,
    target: shortcut.target,
    arguments: shortcut.arguments,
    targetExists,
    matchesLauncher,
    note,
  };
}

/**
 * Makes the shortcut, replacing an earlier one. `UNSUPPORTED_PLATFORM` off Windows, `CONFIG_INVALID` without an `APPDATA`,
 * `USAGE` for a node or launcher path that could change what the shortcut runs, `INTERNAL` with the manual instruction when
 * Windows does not make the shortcut.
 */
export async function enableAutostart(
  ctx: OpContext,
  o: AutostartTarget,
  deps: AutostartDeps = {},
): Promise<AutostartStatus> {
  if ((deps.platform ?? hostPlatform) !== 'win32') {
    throw new McsError('UNSUPPORTED_PLATFORM', 'autostart is available on Windows only');
  }
  const startup = startupDirOf(ctx.env);
  if (startup === null) throw new McsError('CONFIG_INVALID', NO_APPDATA_NOTE);
  validateTarget(o);
  await createShortcut(ctx, startup, o, deps);
  return autostartStatus(ctx, o, deps);
}

/** Removes the shortcut (a plain file removal) and answers the status without one; the same when there was none. */
export async function disableAutostart(ctx: OpContext, deps: AutostartDeps = {}): Promise<AutostartStatus> {
  if ((deps.platform ?? hostPlatform) !== 'win32') return UNSUPPORTED;
  const startup = startupDirOf(ctx.env);
  if (startup === null) return off(NO_APPDATA_NOTE);
  await rm(path.join(startup, AUTOSTART_SHORTCUT_NAME), { force: true });
  return off(null);
}

// ---- healing -----------------------------------------------------------------------------------------------------------

const RECORDED_LAUNCHER = /^"([^"]+)" start --no-open$/;

/**
 * The folder family of an install, or `null` for a place that is no install (a checkout, a worktree, a QA stack): the
 * plugin cache `plugins/cache/<marketplace>/<plugin>` (every version of one plugin shares it) and the installed skill
 * folder `.claude/skills/<name>`.
 */
function installFamilyOf(file: string): string | null {
  const parts = path.normalize(file).split(path.sep);
  const lower = parts.map((part) => part.toLowerCase());
  for (let i = 0; i < parts.length; i += 1) {
    if (lower[i] === 'plugins' && lower[i + 1] === 'cache' && i + 4 < parts.length) {
      return lower.slice(0, i + 4).join(path.sep);
    }
    if (lower[i] === '.claude' && lower[i + 1] === 'skills' && i + 3 < parts.length) {
      return lower.slice(0, i + 3).join(path.sep);
    }
  }
  return null;
}

function sameInstall(a: string, b: string): boolean {
  const family = installFamilyOf(a);
  return family !== null && family === installFamilyOf(b);
}

/**
 * Heals the shortcut when autostart is on (06 2.7, amendment A5): `absent` when it is off or unsupported; `current` when it
 * already names this Node and this launcher; `refreshed` when it was rewritten, which happens when the Node differs, when
 * the recorded launcher no longer exists, or when it lies in the same install family as this launcher (a newer plugin
 * version). Anything else is `foreign-target` and is neither read as ours nor rewritten: another launcher that still
 * exists, arguments of another shape, a shortcut that cannot be read. That outcome is logged as a warning (no value), and
 * the caller tells the person to run `caw autostart enable`.
 */
export async function refreshAutostartIfEnabled(
  ctx: OpContext,
  o: AutostartTarget,
  deps: AutostartDeps = {},
): Promise<AutostartRefresh> {
  if ((deps.platform ?? hostPlatform) !== 'win32') return 'absent';
  const startup = startupDirOf(ctx.env);
  if (startup === null) return 'absent';
  const lnk = path.join(startup, AUTOSTART_SHORTCUT_NAME);
  if (!(await isFile(lnk))) return 'absent';

  const foreign = (): AutostartRefresh => {
    ctx.log.warn('autostart.foreign_target');
    return 'foreign-target';
  };
  const shortcut = await readShortcut(lnk, deps);
  if (shortcut === null) return foreign();
  const recorded = RECORDED_LAUNCHER.exec(shortcut.arguments)?.[1];
  if (recorded === undefined) return foreign();

  const sameLauncher = sameText(recorded, o.launcherPath);
  if (sameLauncher && sameText(shortcut.target, o.nodePath)) return 'current';
  if (!sameLauncher && (await isFile(recorded)) && !sameInstall(recorded, o.launcherPath)) return foreign();

  validateTarget(o);
  await createShortcut(ctx, startup, o, deps);
  return 'refreshed';
}
