// Finding `claude` and building its launch (design 01 section 3.5 and amendment A1). Pure: the platform, the environment and
// the file system are arguments, so every Windows rule is tested on any host. The one place that knows how a `.cmd` shim has
// to be started: cmd.exe re-parses its command line, so a shim path and every argument on that route are checked first.
import path from 'node:path';

import type { HostPlatform } from '../platform/host.ts';
import { envValue, type EnvSource } from './env.ts';
import { TerminalError } from './errors.ts';
import { RESUME_ID_RE } from './limits.ts';

/** What the resolution asks the file system. `isExecutable` is the POSIX execute test; without it `isFile` decides. */
export interface CommandFs {
  isFile(path: string): boolean;
  isExecutable?(path: string): boolean;
}

/** The program that was found: an absolute path and its lower-case extension (empty on a POSIX host). */
export interface ResolvedCommand {
  readonly path: string;
  readonly ext: string;
}

export type ClaudeLaunch =
  | { readonly kind: 'exe'; readonly file: string; readonly args: readonly string[]; readonly display: string }
  | {
      readonly kind: 'shim';
      /** The absolute cmd.exe. */
      readonly file: string;
      /** The command line tail, a string: node-pty must not quote it again. */
      readonly args: string;
      readonly display: string;
    };

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
/** One PATHEXT entry: a dot and a plain extension. Anything else (a path, a quote, a space) would build a strange candidate. */
const PATHEXT_ENTRY = /^\.[^\\/:*?"<>|\s\p{Cc}]+$/u;
/** A drive-absolute path or a UNC path. A rooted path without a drive and `D:x` are relative to something and are refused. */
const FULLY_QUALIFIED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/u;
/** A command that names a place (a separator or a drive) is a path; any other is looked up on PATH. */
const PATH_FORM = /[\\/]|^[A-Za-z]:/u;
const NOT_A_COMMAND = /["<>|?*\p{Cc}]/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
/** A shim path that cmd.exe would expand (`%VAR%` works even inside quotes) or misread. */
const UNSAFE_SHIM_PATH = /["%\p{Cc}]/u;
const DOUBLE_QUOTE = 0x22;

/** Arguments that may travel through cmd.exe: letters, digits and a short list of punctuation. See `isCmdSafeArg`. */
const CMD_SAFE_ARG = /^[\p{L}\p{N} _.,:=@+/\\-]*$/u;

function stripSurroundingQuotes(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === DOUBLE_QUOTE) start += 1;
  while (end > start && text.charCodeAt(end - 1) === DOUBLE_QUOTE) end -= 1;
  return text.slice(start, end);
}

function windowsExtensions(env: EnvSource): string[] {
  const source = envValue(env, 'PATHEXT', 'win32');
  const own = (source ?? '').split(';').filter((entry) => PATHEXT_ENTRY.test(entry));
  return own.length > 0 ? own : DEFAULT_PATHEXT.split(';');
}

function resolveOnWindows(o: { command: string; env: EnvSource; fs: CommandFs }): ResolvedCommand | null {
  const { command } = o;
  if (command.trim() === '' || NOT_A_COMMAND.test(command)) return null;
  // The only ":" a command may hold is the one after a drive letter.
  const afterDrive = /^[A-Za-z]:/u.test(command) ? command.slice(2) : command;
  if (afterDrive.includes(':')) return null;
  const extensions = windowsExtensions(o.env);
  const lower = command.toLowerCase();
  // shutil.which: a command that already ends in a PATHEXT extension is tried as it is, then every extension is appended.
  // A file without an extension is never a candidate: `claude` next to `claude.cmd` is an sh script that Windows cannot run.
  const withExtension = extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
  const names = withExtension
    ? [command, ...extensions.map((ext) => command + ext)]
    : extensions.map((ext) => command + ext);
  const found = (candidate: string): ResolvedCommand | null =>
    o.fs.isFile(candidate) ? { path: candidate, ext: path.win32.extname(candidate).toLowerCase() } : null;

  if (PATH_FORM.test(command)) {
    // Never relative to the folder of the server.
    if (!FULLY_QUALIFIED.test(command)) return null;
    for (const name of names) {
      const hit = found(path.win32.normalize(name));
      if (hit !== null) return hit;
    }
    return null;
  }

  const searchPath = envValue(o.env, 'PATH', 'win32');
  if (searchPath === undefined) return null;
  for (const entry of searchPath.split(';')) {
    const dir = stripSurroundingQuotes(entry.trim()).trim();
    // The current directory is not searched, and a relative entry would mean the folder of the server.
    if (dir === '' || !FULLY_QUALIFIED.test(dir)) continue;
    for (const name of names) {
      const hit = found(path.win32.join(dir, name));
      if (hit !== null) return hit;
    }
  }
  return null;
}

function resolveOnPosix(o: {
  command: string;
  env: EnvSource;
  platform: HostPlatform;
  fs: CommandFs;
}): ResolvedCommand | null {
  const { command } = o;
  if (command === '' || command.includes('\u0000')) return null;
  const usable = (candidate: string): boolean => o.fs.isExecutable?.(candidate) ?? o.fs.isFile(candidate);
  if (command.includes('/'))
    return path.posix.isAbsolute(command) && usable(command) ? { path: command, ext: '' } : null;
  const searchPath = envValue(o.env, 'PATH', o.platform);
  if (searchPath === undefined) return null;
  for (const entry of searchPath.split(':')) {
    if (!entry.startsWith('/')) continue;
    const candidate = path.posix.join(entry, command);
    if (usable(candidate)) return { path: candidate, ext: '' };
  }
  return null;
}

/**
 * Finds `claude` the way Python `shutil.which` does (what MTOP used). Windows: the PATH of the server (`Path` or `PATH`, any
 * case), PATHEXT in order (default `.COM;.EXE;.BAT;.CMD`), the first existing file wins; relative PATH entries and a relative
 * command path are ignored. A POSIX host: the first executable file on PATH, or the absolute path itself. `null` when there is
 * no such file (the service reports CLAUDE_NOT_FOUND).
 */
export function resolveClaudeCommand(o: {
  command: string;
  env: EnvSource;
  platform: HostPlatform;
  fs: CommandFs;
}): ResolvedCommand | null {
  return o.platform === 'win32' ? resolveOnWindows(o) : resolveOnPosix(o);
}

/**
 * The argument rules of CommandLineToArgvW (and of the MSVC runtime, which `claude.exe` and node use): quote when the text is
 * empty or holds a space, a tab, a line break or a quote; inside the quotes a quote becomes `\"`, and the backslashes that
 * precede a quote, or the closing quote, are doubled.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[ \t\n\v"]/u.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
    } else if (ch === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
    } else {
      out += '\\'.repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

/**
 * True when cmd.exe cannot read anything into the text. cmd expands `%VAR%` and `!VAR!` even inside quotes and gives `^ & | < > ( )`
 * a meaning outside them, so the shim route allows letters and digits of any script, a space and `_ . , : = @ + / \ -` only.
 */
export function isCmdSafeArg(arg: string): boolean {
  return CMD_SAFE_ARG.test(arg);
}

function cmdExeOf(env: EnvSource, fs: CommandFs): string {
  const root = [envValue(env, 'SystemRoot', 'win32'), envValue(env, 'windir', 'win32')].find(
    (value) => value !== undefined && value !== '',
  );
  if (root === undefined || !FULLY_QUALIFIED.test(root)) throw new TerminalError('COMMAND_UNSUPPORTED');
  const cmd = path.win32.join(root, 'System32', 'cmd.exe');
  if (!fs.isFile(cmd)) throw new TerminalError('COMMAND_UNSUPPORTED');
  return cmd;
}

/**
 * How to start the resolved program. `args` are the configured arguments; `resume` is a Claude session id that becomes
 * `--resume <id>` after them. Windows: `.exe` and `.com` run directly with an argv array. `.cmd` and `.bat` run as the string
 * `cmd.exe /d /s /c ""<shim>" <quoted args>"` (the array form fails: node-pty wraps the first element in escaped quotes and
 * cmd answers "not recognized"; `/s` strips only the outer pair). The kind is read from the path itself, never from `ext`.
 * Refused with COMMAND_UNSUPPORTED: any other extension, a shim path with `%`, a quote or a control character, no cmd.exe.
 * Refused with ARGS_UNSAFE: an argument with a control character, on the shim route one outside `isCmdSafeArg`, a resume id
 * that does not match RESUME_ID_RE. No error message names a path or an argument. `display` is the program as resolved.
 */
export function buildLaunch(
  resolved: ResolvedCommand,
  args: readonly string[],
  o: { env: EnvSource; platform: HostPlatform; fs: CommandFs; resume?: string },
): ClaudeLaunch {
  const all = [...args];
  if (o.resume !== undefined) {
    if (!RESUME_ID_RE.test(o.resume)) throw new TerminalError('ARGS_UNSAFE');
    all.push('--resume', o.resume);
  }
  if (all.some((arg) => CONTROL_CHARACTER.test(arg))) throw new TerminalError('ARGS_UNSAFE');

  const direct = (): ClaudeLaunch => ({ kind: 'exe', file: resolved.path, args: all, display: resolved.path });
  if (o.platform !== 'win32') return direct();

  const ext = path.win32.extname(resolved.path).toLowerCase();
  if (ext === '.exe' || ext === '.com') return direct();
  if (ext !== '.cmd' && ext !== '.bat') throw new TerminalError('COMMAND_UNSUPPORTED');

  if (UNSAFE_SHIM_PATH.test(resolved.path)) throw new TerminalError('COMMAND_UNSUPPORTED');
  const file = cmdExeOf(o.env, o.fs);
  if (!all.every(isCmdSafeArg)) throw new TerminalError('ARGS_UNSAFE');
  const tail = all.map((arg) => ` ${quoteWindowsArg(arg)}`).join('');
  return { kind: 'shim', file, args: `/d /s /c ""${resolved.path}"${tail}"`, display: resolved.path };
}
