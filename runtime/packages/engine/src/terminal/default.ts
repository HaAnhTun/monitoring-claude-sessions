// The real wiring of the terminal service (design 01 section 3.12): the addon backend of this host, the real file system and
// environment, the engine's process helpers, and the orphan registry under the instance home. The server builds it once per user
// instance, calls `sweepOrphans()` at boot, `shutdown()` in its shutdown sequence and `emergencyKillSync()` at `process.on('exit')`.
//
// Everything that decides is an option with the real thing as its default, so a test (and the user-instance host with a scripted
// backend) can replace one piece without touching the rest. Nothing is loaded or spawned by importing this module.
import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';

import { resolveMcsHome } from '@mcs/shared/protocol';
import { systemClock, type Clock, type TerminalSection } from '@mcs/shared';

import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import { forceKillTree, listDescendantPids, pidAlive } from '../platform/process.ts';
import type { CommandFs } from './command.ts';
import type { EnvSource } from './env.ts';
import type { FolderFs } from './folder.ts';
import { createTerminalService, type TerminalLogger, type TerminalService } from './manager.ts';
import { createNodePtyBackend, type CreateNodePtyBackendOptions } from './node-pty-backend.ts';
import { createChildRegistry } from './registry.ts';
import type { PtyBackend } from './types.ts';

function statOf(target: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(target, { throwIfNoEntry: false });
  } catch {
    // A path that cannot be read (access denied, a file used as a folder, too long) is not a folder or a program.
    return undefined;
  }
}

function isFile(target: string): boolean {
  return statOf(target)?.isFile() === true;
}

/** The questions the service asks the file system, answered by the real one. Synchronous: about 40 `stat` calls per create. */
export const realTerminalFs: FolderFs & Required<CommandFs> = {
  isDirectory: (target) => statOf(target)?.isDirectory() === true,
  isFile,
  // The execute bit alone is true for a folder too: a program is a file that can be executed.
  isExecutable: (target) => {
    if (!isFile(target)) return false;
    try {
      accessSync(target, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export interface BackendSelection {
  /** `terminal.conptyDll` and `terminal.startTimeoutMs` go to the backend. */
  readonly config: Pick<TerminalSection, 'conptyDll' | 'startTimeoutMs'>;
  readonly logger: Pick<TerminalLogger, 'info' | 'warn'>;
  readonly platform: HostPlatform;
  readonly arch: string;
  /** `os.release()`: on Windows `10.0.<build>`. */
  readonly release: string;
  /** Loads the addon. Default: the real loader (bundle folder or node_modules). Tests pass a script. */
  readonly load?: CreateNodePtyBackendOptions['load'];
}

/**
 * The backend of a host: the addon backend where one ships and loads, else an UnsupportedBackend that says why (`unsupported-os`,
 * `os-too-old`, `native-missing`, `native-load-failed`). Never throws; a host that cannot run the terminal never loads the addon.
 */
export function selectTerminalBackend(o: BackendSelection): PtyBackend {
  return createNodePtyBackend({
    platform: o.platform,
    arch: o.arch,
    release: o.release,
    useConptyDll: o.config.conptyDll,
    startTimeoutMs: o.config.startTimeoutMs,
    logger: o.logger,
    ...(o.load === undefined ? {} : { load: o.load }),
  });
}

export interface DefaultTerminalOptions {
  readonly config: TerminalSection;
  readonly logger: TerminalLogger;
  /** Default: the system clock. */
  readonly clock?: Clock;
  /** The instance home that holds `terminals/` (the child registry). Default: `resolveMcsHome(env())`. */
  readonly mcsHome?: string;
  /** Replaces the backend of the host (the user-instance host passes a scripted one in tests). A registry is kept for a supported one. */
  readonly backend?: PtyBackend;
  /** Default: the host. Only used to pick the backend and to resolve the program. */
  readonly platform?: HostPlatform;
  readonly arch?: string;
  readonly release?: string;
  /** The environment of the server, read at every create. Default: `process.env`. */
  readonly env?: () => EnvSource;
  /** Only to shorten the program shown by `status()`. Default: `os.homedir()`. */
  readonly home?: string;
  /** Loads the addon (see {@link BackendSelection.load}). */
  readonly load?: CreateNodePtyBackendOptions['load'];
}

export function createDefaultTerminalService(options: DefaultTerminalOptions): TerminalService {
  const platform = options.platform ?? hostPlatform;
  const clock = options.clock ?? systemClock;
  const env = options.env ?? ((): EnvSource => process.env);
  const backend =
    options.backend ??
    selectTerminalBackend({
      config: options.config,
      logger: options.logger,
      platform,
      arch: options.arch ?? process.arch,
      release: options.release ?? os.release(),
      ...(options.load === undefined ? {} : { load: options.load }),
    });
  // Only a backend that can start something has children to register; an unsupported host needs no home folder either.
  const registry = backend.support.supported
    ? createChildRegistry({
        mcsHome: options.mcsHome ?? resolveMcsHome(env()),
        owner: { pid: process.pid, startedAtMs: Math.max(0, Math.round(clock.now() - process.uptime() * 1000)) },
        logger: options.logger,
      })
    : null;
  return createTerminalService({
    backend,
    config: options.config,
    logger: options.logger,
    clock,
    platform,
    env,
    fs: realTerminalFs,
    killTree: forceKillTree,
    killSync: (pid) => {
      process.kill(pid, 'SIGKILL');
    },
    pidAlive,
    descendants: listDescendantPids,
    registry,
    home: options.home ?? os.homedir(),
  });
}
