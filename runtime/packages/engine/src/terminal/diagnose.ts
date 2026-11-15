// What `caw check` and `doctor` show about the terminal (design 01 section 3.12): whether this host can run it, where the addon came
// from, whether `claude` is found and how it would be launched, and whether the ConPTY files sit next to the addon. It starts nothing
// and reads only the file system: it loads the addon (the same load the backend does) and looks at paths.
//
// The report holds plain facts. The text of a load error is never read (it holds file paths); the one path in it is the program,
// with the home folder shortened to `~`.
import { findPackageJSON } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type { TerminalSection } from '@mcs/shared';

import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import type { CommandFs } from './command.ts';
import { realTerminalFs } from './default.ts';
import type { EnvSource } from './env.ts';
import { TerminalError } from './errors.ts';
import { claudeFacts } from './manager.ts';
import { NODE_PTY_PACKAGE, targetOf, windowsBuildOk, type NativeTarget } from './native-targets.ts';
import { loadNodePty, realLoaderDeps, type LoadedNodePty } from './node-pty-loader.ts';
import type { TerminalStatus, UnsupportedReason } from './types.ts';
import { unsupportedReasonOf } from './unsupported-backend.ts';

export interface TerminalDiagnosis {
  /** True when a session could be started on this host (`reason` is then null). */
  readonly supported: boolean;
  readonly reason: UnsupportedReason | null;
  /** `via` is where the addon came from (`bundle` or `node_modules`); null when it was not loaded. */
  readonly nodePty: { readonly via: LoadedNodePty['via'] | null; readonly loaded: boolean };
  readonly claude: TerminalStatus['claude'];
  /**
   * Whether `conpty.dll` and `OpenConsole.exe` sit next to the addon (`terminal.conptyDll` needs them); null when it cannot be
   * told: no addon was loaded, the platform package could not be located, or the host is not Windows.
   */
  readonly conptyDll: { readonly filesPresent: boolean | null };
  /** The Windows build and whether ConPTY exists there (build 17763 or newer); null off Windows. `build` is null for a release that cannot be read. */
  readonly windowsBuild: { readonly build: number | null; readonly ok: boolean } | null;
}

export interface DiagnoseDeps {
  readonly config: Pick<TerminalSection, 'command' | 'conptyDll'>;
  /** Default: the host. */
  readonly platform?: HostPlatform;
  readonly arch?: string;
  /** `os.release()`. */
  readonly release?: string;
  /** Default: `process.env`. */
  readonly env?: EnvSource;
  /** Only to shorten the program shown. Default: `os.homedir()`. */
  readonly home?: string;
  /** Default: the real file system. */
  readonly fs?: CommandFs;
  /** Loads the addon. Default: the real loader for the platform and architecture above. */
  readonly load?: () => LoadedNodePty;
  /** The folder of the installed platform package, for the node_modules branch. Default: {@link installedPackageDir}. */
  readonly packageDirOf?: (target: NativeTarget) => string | null;
}

const RELEASE_BUILD_RE = /^\d+\.\d+\.(\d{1,9})(?!\d)/;

function buildOf(release: string): number | null {
  const match = RELEASE_BUILD_RE.exec(release);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * `<install>/node_modules/@lydell/node-pty-<target>` as seen from the module `from` (a file URL; default: this module), or null
 * when it is not installed. The package's `exports` is a plain string (`./lib/index.js`), so `require.resolve` of its
 * `package.json` fails with ERR_PACKAGE_PATH_NOT_EXPORTED; `findPackageJSON` reads the folder without going through `exports`.
 */
export function installedPackageDir(target: NativeTarget, from: string = import.meta.url): string | null {
  try {
    const manifest = findPackageJSON(`${NODE_PTY_PACKAGE}-${target}`, from);
    return manifest === undefined ? null : path.dirname(manifest);
  } catch {
    // ERR_MODULE_NOT_FOUND: the platform package of another host is not installed.
    return null;
  }
}

function conptyFilesPresent(
  loaded: LoadedNodePty,
  target: NativeTarget,
  fs: CommandFs,
  packageDirOf: (target: NativeTarget) => string | null,
): boolean | null {
  const dir = loaded.via === 'bundle' ? loaded.dir : packageDirOf(target);
  if (dir === null) return null;
  const conpty = path.win32.join(dir, 'prebuilds', target, 'conpty');
  return fs.isFile(path.win32.join(conpty, 'conpty.dll')) && fs.isFile(path.win32.join(conpty, 'OpenConsole.exe'));
}

/**
 * The state of the terminal on this host, in the order the backend decides it: no shipped target (`unsupported-os`), a Windows build
 * below 17763 (`os-too-old`), then the addon is loaded (`native-missing`, `native-load-failed`). Never throws and starts nothing.
 */
export function diagnoseTerminal(deps: DiagnoseDeps): TerminalDiagnosis {
  const platform = deps.platform ?? hostPlatform;
  const arch = deps.arch ?? process.arch;
  const release = deps.release ?? os.release();
  const fs = deps.fs ?? realTerminalFs;
  const target = targetOf(platform, arch);
  const windowsBuild = platform === 'win32' ? { build: buildOf(release), ok: windowsBuildOk(release) } : null;
  const claude = claudeFacts({
    command: deps.config.command,
    env: deps.env ?? process.env,
    platform,
    fs,
    home: deps.home ?? os.homedir(),
  });

  let reason: UnsupportedReason | null = null;
  let loaded: LoadedNodePty | null = null;
  if (target === null) {
    reason = 'unsupported-os';
  } else if (windowsBuild !== null && !windowsBuild.ok) {
    reason = 'os-too-old';
  } else {
    try {
      loaded = (deps.load ?? ((): LoadedNodePty => loadNodePty({ ...realLoaderDeps(), platform, arch })))();
    } catch (error) {
      // Only the code of a TerminalError is used; anything else is a load failure whose message is not read.
      reason = (error instanceof TerminalError ? unsupportedReasonOf(error.code) : null) ?? 'native-load-failed';
    }
  }

  const filesPresent =
    loaded !== null && target !== null && platform === 'win32'
      ? conptyFilesPresent(loaded, target, fs, deps.packageDirOf ?? installedPackageDir)
      : null;
  return {
    supported: reason === null,
    reason,
    nodePty: { via: loaded?.via ?? null, loaded: loaded !== null },
    claude,
    conptyDll: { filesPresent },
    windowsBuild,
  };
}
