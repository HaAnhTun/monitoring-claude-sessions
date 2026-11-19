// A window of the person's own terminal (CAW-145, design 09 section B, ADR 0136): `claude --resume <id>` of a monitored session, in
// its folder, in Windows Terminal (found with `lstat`: the Store alias cannot be `stat`ed) or else a plain console window. Windows only.
//
// The engine decides, the server only routes: the caller passes the folder and the id of a resume plan (never request data), and
// everything here validates again what the in-app start validates (`resolveClaudeCommand` and `buildLaunch`). The launch is made of
// argument arrays, never a shell string. The window is detached and no handle is kept: the application does not track, write to,
// resize or kill it (ADR 0136 extends 0079 by a start with no later control).
// Every seam is a dependency (platform, environment, file system, spawner, clock, logger), so the argv of each route, the refusals,
// the environment and the limits are tested with fakes on any host. Logging: one line after the start with the way and whether it is
// a copy (`kind` and `phase`, two names of the closed field list of the logger), a code word for a failed start; never an id, a
// folder, a program path or an argument.
import { lstatSync } from 'node:fs';
import path from 'node:path';

import type { NativeOpenVia, TerminalSection } from '@mcs/shared';

import { spawnDetachedVisible } from '../platform/exec.ts';
import type { HostPlatform } from '../platform/host.ts';
import { buildLaunch, isCmdSafeArg, resolveClaudeCommand, type CommandFs, type ResolvedCommand } from './command.ts';
import { realTerminalFs } from './default.ts';
import { buildNativeEnv, envValue, type EnvSource } from './env.ts';
import { TerminalError } from './errors.ts';
import { normalizeFolder, type FolderFs } from './folder.ts';
import type { TerminalLogger } from './manager.ts';

export type NativeVia = NativeOpenVia;

/** The start of Windows Terminal's command line: a new tab in a folder. One constant, so a change of its parser is one line. */
export const WT_PREFIX: readonly string[] = ['new-tab', '-d'];
/** Ends the options of Windows Terminal: what follows is the program and its arguments, whatever they start with. */
export const WT_SEPARATOR = '--';
/** How long the answer about `wt.exe` is kept (the capability is polled with every state of the terminal). */
export const WT_CACHE_MS = 60_000;
/** The process must report its start within this time, or the open fails. */
export const NATIVE_SPAWN_TIMEOUT_MS = 2000;
/** Least time between two opens. */
export const NATIVE_MIN_GAP_MS = 1500;
/** Most opens in a rolling minute. */
export const NATIVE_PER_MINUTE = 12;
const MINUTE_MS = 60_000;

/** What the launcher asks the file system. `hasEntry` is an `lstat`: a file or a link, readable or not. */
export interface NativeFs extends FolderFs, CommandFs {
  hasEntry(path: string): boolean;
}

/** The real file system: the answers of the terminal service, and an `lstat` for the Store alias of `wt.exe`. */
export const realNativeFs: NativeFs = {
  isFile: (target) => realTerminalFs.isFile(target),
  isDirectory: (target) => realTerminalFs.isDirectory(target),
  hasEntry: (target) => {
    try {
      const stat = lstatSync(target, { throwIfNoEntry: false });
      return stat !== undefined && (stat.isFile() || stat.isSymbolicLink());
    } catch {
      return false;
    }
  },
};

/** Starts a process and answers when it started; rejects when it could not. Nothing is returned that could control it. */
export type NativeSpawner = (
  file: string,
  args: readonly string[],
  o: { readonly cwd: string; readonly env: Record<string, string> },
) => Promise<void>;

type VisibleLaunch = typeof spawnDetachedVisible;
type Child = ReturnType<VisibleLaunch>;

/**
 * The spawner of production: `spawnDetachedVisible` (detached, no stdio, `unref`), the `error` event attached in the same tick,
 * resolved on the `spawn` event, rejected on an `error` or when nothing is heard within `NATIVE_SPAWN_TIMEOUT_MS`.
 */
export function realNativeSpawner(launch: VisibleLaunch = spawnDetachedVisible): NativeSpawner {
  return (file, args, o) =>
    new Promise<void>((resolve, reject) => {
      let child: Child;
      try {
        child = launch(file, args, { cwd: o.cwd, env: o.env });
      } catch (error) {
        reject(error instanceof Error ? error : new Error('spawn failed'));
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error('spawn timed out'));
      }, NATIVE_SPAWN_TIMEOUT_MS);
      child.once('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
    });
}

export interface NativeTerminalDeps {
  readonly platform: HostPlatform;
  /** The environment of the server, read at every call. */
  readonly env: () => EnvSource;
  readonly fs: NativeFs;
  readonly config: Pick<TerminalSection, 'command' | 'args' | 'envKeep'>;
  /** Starts the window's process; production: `realNativeSpawner()`. */
  readonly launch: NativeSpawner;
  readonly clock: { now(): number };
  readonly logger: Pick<TerminalLogger, 'info' | 'warn'>;
}

export interface NativeTerminal {
  /** Whether a window can be opened here and how. Cheap: a few `lstat` calls at most, cached for a minute. */
  capabilities(): { readonly available: boolean; readonly via: NativeVia | null };
  /** Opens the window; resolves with the way it was opened. The folder and the id come from a resume plan. */
  open(input: { readonly folder: string; readonly sessionId: string; readonly fork: boolean }): Promise<NativeVia>;
}

/** A drive-absolute directory: a relative PATH entry would mean the folder of the server. */
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;

function stripQuotes(text: string): string {
  return text.replace(/^"+|"+$/gu, '');
}

export function createNativeTerminal(deps: NativeTerminalDeps): NativeTerminal {
  const { platform, fs, config, clock, logger } = deps;
  const supported = platform === 'win32';
  let cache: { readonly at: number; readonly wt: string | null } | null = null;
  let busy = false;
  let lastAt = Number.NEGATIVE_INFINITY;
  let recent: number[] = [];

  /** `wt.exe` of an absolute PATH entry, else the one of the Store alias folder; each tested with an `lstat`. */
  function findWindowsTerminal(): string | null {
    const now = clock.now();
    if (cache !== null && now - cache.at >= 0 && now - cache.at < WT_CACHE_MS) return cache.wt;
    const env = deps.env();
    const candidates: string[] = [];
    for (const entry of (envValue(env, 'PATH', platform) ?? '').split(';')) {
      const dir = stripQuotes(entry.trim()).trim();
      if (dir !== '' && DRIVE_ABSOLUTE.test(dir)) candidates.push(path.win32.join(dir, 'wt.exe'));
    }
    const local = envValue(env, 'LOCALAPPDATA', platform);
    if (local !== undefined && DRIVE_ABSOLUTE.test(local)) {
      candidates.push(path.win32.join(local, 'Microsoft', 'WindowsApps', 'wt.exe'));
    }
    const wt = candidates.find((candidate) => fs.hasEntry(candidate)) ?? null;
    cache = { at: now, wt };
    return wt;
  }

  function checkLimits(now: number): void {
    recent = recent.filter((at) => now - at < MINUTE_MS);
    if (busy || now - lastAt < NATIVE_MIN_GAP_MS || recent.length >= NATIVE_PER_MINUTE) {
      throw new TerminalError('SESSION_LIMIT');
    }
  }

  async function open(input: { folder: string; sessionId: string; fork: boolean }): Promise<NativeVia> {
    if (!supported) throw new TerminalError('UNSUPPORTED_OS');
    checkLimits(clock.now());
    const env = deps.env();

    const resolved: ResolvedCommand | null = resolveClaudeCommand({ command: config.command, env, platform, fs });
    if (resolved === null) throw new TerminalError('CLAUDE_NOT_FOUND');
    // validation only: the shim string it builds is pre-quoted for node-pty and is not used here
    const launch = buildLaunch(resolved, config.args, {
      env,
      platform,
      fs,
      resume: input.sessionId,
      ...(input.fork ? { fork: true } : {}),
    });

    const folder = normalizeFolder(input.folder, platform);
    if (folder === null) throw new TerminalError('FOLDER_INVALID');
    if (!fs.isDirectory(folder)) throw new TerminalError('FOLDER_NOT_FOUND');

    const allArgs = [...config.args, '--resume', input.sessionId, ...(input.fork ? ['--fork-session'] : [])];
    let program: string;
    let programArgs: readonly string[];
    if (launch.kind === 'exe') {
      program = launch.file;
      programArgs = launch.args;
    } else {
      // cmd.exe keeps the quotes of its first token when the token is a plain file name; the shim path is checked for that here
      if (!isCmdSafeArg(resolved.path)) throw new TerminalError('ARGS_UNSAFE');
      program = launch.file;
      programArgs = ['/d', '/k', resolved.path, ...allArgs];
    }

    const wt = findWindowsTerminal();
    if (wt !== null && folder.includes(';')) throw new TerminalError('FOLDER_INVALID');
    const via: NativeVia = wt === null ? 'console' : 'windows-terminal';
    const file = wt ?? program;
    const args = wt === null ? programArgs : [...WT_PREFIX, folder, WT_SEPARATOR, program, ...programArgs];
    const nativeEnv = buildNativeEnv(env, { keep: config.envKeep, platform });

    const started = clock.now();
    busy = true;
    lastAt = started;
    recent.push(started);
    try {
      await deps.launch(file, args, { cwd: folder, env: nativeEnv });
    } catch (error) {
      logger.warn('terminal.native_open_failed', { code: 'SPAWN_FAILED' });
      throw new TerminalError('SPAWN_FAILED', { cause: error });
    } finally {
      busy = false;
    }
    logger.info('terminal.native_open', { kind: via, phase: input.fork ? 'fork' : 'resume' });
    return via;
  }

  return {
    capabilities: () => {
      if (!supported) return { available: false, via: null };
      return { available: true, via: findWindowsTerminal() === null ? 'console' : 'windows-terminal' };
    },
    open,
  };
}

/** The launcher of production over the real file system, the real spawner and the environment of the process. */
export function createRealNativeTerminal(o: {
  readonly config: Pick<TerminalSection, 'command' | 'args' | 'envKeep'>;
  readonly logger: Pick<TerminalLogger, 'info' | 'warn'>;
  readonly clock: { now(): number };
  readonly platform: HostPlatform;
  readonly env?: () => EnvSource;
}): NativeTerminal {
  return createNativeTerminal({
    platform: o.platform,
    env: o.env ?? (() => process.env),
    fs: realNativeFs,
    launch: realNativeSpawner(),
    config: o.config,
    clock: o.clock,
    logger: o.logger,
  });
}
