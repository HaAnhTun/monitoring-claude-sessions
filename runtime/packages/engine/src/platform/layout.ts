// The runtime layouts (ADR 0062 items 2 and 3). This module is the only code that knows where the server entry, the hook
// handler, the web assets, the migrations and the build stamp sit in the two layouts:
// - bundle: `<skillDir>/bundle` holds `mcs-server.mjs`, `mcs-cli.mjs`, `mcs-hook.mjs`, `migrations/`, `web/`;
// - source: `<repo>/runtime` holds the npm workspace (`packages/<pkg>/dist`), the skill folder is `<repo>/skills/<name>`.
// It reads only the file system (through a seam) and never `process.platform`: the path module follows `host.ts` data.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McsError } from '@mcs/shared';

import { hostPlatform, type HostPlatform } from './host.ts';

/** The name of the skill folder (and of the skill in its `SKILL.md` frontmatter). */
export const SKILL_FOLDER_NAME = 'monitoring-claude-sessions';

/** The canonical launcher in `<skillDir>/scripts` (CAW-04) and the legacy alias that calls it; both ship in every layout. */
export const LAUNCHER_FILE = 'caw.mjs';
export const LEGACY_LAUNCHER_FILE = 'mcs.mjs';

/** The file names of the bundle layout (directly in `<skillDir>/bundle`). */
export const BUNDLE_SERVER_FILE = 'mcs-server.mjs';
export const BUNDLE_CLI_FILE = 'mcs-cli.mjs';
export const BUNDLE_HOOK_FILE = 'mcs-hook.mjs';
/** The build stamp of both layouts. */
export const BUILD_STAMP_FILE = '.mcs-build.json';

export type RuntimeLayoutMode = 'bundle' | 'source';

export interface RuntimeLayout {
  readonly mode: RuntimeLayoutMode;
  /** The skill folder (`SKILL.md`, `config/defaults.json`, `runtime/defaults.json`, `scripts/`). */
  readonly skillDir: string;
  /** The folder that holds the server entry and `.mcs-build.json`. */
  readonly runtimeDir: string;
  /** `<skillDir>/scripts/caw.mjs` (`LAUNCHER_FILE`): the canonical launcher, never the legacy alias. */
  readonly launcherPath: string;
  readonly serverEntry: string;
  /** The hook handler: the one locator of the hooks installer and the testkit. */
  readonly hookEntry: string;
  readonly webDir: string;
  readonly migrationsDir: string;
  readonly stampFile: string;
}

/** The file-system seam of the resolver (tests pass a scripted set of paths and a platform). */
export interface LayoutFs {
  exists?: (file: string) => boolean;
  /** Selects the path module (`win32` or POSIX); default: the host. */
  platform?: HostPlatform;
}

interface Resolved {
  readonly exists: (file: string) => boolean;
  readonly p: path.PlatformPath;
  readonly windows: boolean;
}

function resolved(fs: LayoutFs | undefined): Resolved {
  const platform = fs?.platform ?? hostPlatform;
  return {
    exists: fs?.exists ?? existsSync,
    p: platform === 'win32' ? path.win32 : path.posix,
    windows: platform === 'win32',
  };
}

function unknownTree(where: string): McsError {
  return new McsError('INTERNAL', `no runtime layout found at ${where}`, {
    hint: 'reinstall the skill, or run `npm ci && npm run build` in the runtime folder of a checkout',
  });
}

function bundleLayout(r: Resolved, runtimeDir: string): RuntimeLayout {
  const { p } = r;
  const skillDir = p.dirname(runtimeDir);
  return {
    mode: 'bundle',
    skillDir,
    runtimeDir,
    launcherPath: p.join(skillDir, 'scripts', LAUNCHER_FILE),
    serverEntry: p.join(runtimeDir, BUNDLE_SERVER_FILE),
    hookEntry: p.join(runtimeDir, BUNDLE_HOOK_FILE),
    webDir: p.join(runtimeDir, 'web'),
    migrationsDir: p.join(runtimeDir, 'migrations'),
    stampFile: p.join(runtimeDir, BUILD_STAMP_FILE),
  };
}

function sourceLayout(r: Resolved, runtimeDir: string): RuntimeLayout {
  const { p } = r;
  const parent = p.dirname(runtimeDir);
  const checkout = p.join(parent, 'skills', SKILL_FOLDER_NAME);
  // A checkout has the skill folder next to `runtime/`; a test fixture laid out as `<skill>/runtime` uses the parent.
  const skillDir = r.exists(p.join(checkout, 'SKILL.md')) ? checkout : parent;
  return {
    mode: 'source',
    skillDir,
    runtimeDir,
    launcherPath: p.join(skillDir, 'scripts', LAUNCHER_FILE),
    serverEntry: p.join(runtimeDir, 'packages', 'server', 'dist', 'main.js'),
    hookEntry: p.join(runtimeDir, 'packages', 'cli', 'dist', 'hook.js'),
    webDir: p.join(runtimeDir, 'packages', 'web', 'dist'),
    migrationsDir: p.join(runtimeDir, 'packages', 'engine', 'migrations'),
    stampFile: p.join(runtimeDir, BUILD_STAMP_FILE),
  };
}

function isBundleDir(r: Resolved, dir: string): boolean {
  return r.exists(r.p.join(dir, BUNDLE_SERVER_FILE));
}

function isSourceDir(r: Resolved, dir: string): boolean {
  return r.exists(r.p.join(dir, 'packages', 'engine', 'package.json')) || r.exists(r.p.join(dir, 'packages', 'server'));
}

/** A bundle folder that lost its server entry (an incomplete copy): still the bundle layout, so the error says "reinstall". */
function isIncompleteBundleDir(r: Resolved, dir: string): boolean {
  return r.exists(r.p.join(dir, BUNDLE_CLI_FILE)) || r.exists(r.p.join(dir, BUNDLE_HOOK_FILE));
}

/**
 * The layout of a runtime folder: bundle when `<dir>/mcs-server.mjs` exists, source when the folder holds the npm workspace
 * (`packages/engine/package.json` or `packages/server/`), bundle again for a bundle folder without its server entry.
 * Anything else is `INTERNAL` with a hint.
 */
export function layoutOfRuntimeDir(dir: string, fs?: LayoutFs): RuntimeLayout {
  const r = resolved(fs);
  const runtimeDir = r.p.resolve(dir);
  if (isBundleDir(r, runtimeDir)) return bundleLayout(r, runtimeDir);
  if (isSourceDir(r, runtimeDir)) return sourceLayout(r, runtimeDir);
  if (isIncompleteBundleDir(r, runtimeDir)) return bundleLayout(r, runtimeDir);
  throw unknownTree(runtimeDir);
}

/**
 * The layout of a running module (`import.meta.url`): a bundle entry sits directly in the bundle folder (next to
 * `mcs-server.mjs`); a source or `dist` module has an ancestor that holds `packages/engine/package.json`.
 */
export function layoutOfModule(moduleUrl: string | URL, fs?: LayoutFs): RuntimeLayout {
  const r = resolved(fs);
  let file: string;
  try {
    file = fileURLToPath(moduleUrl, { windows: r.windows });
  } catch (error) {
    throw new McsError('INTERNAL', `not a file module: ${String(moduleUrl)}`, {
      hint: 'run the monitor from an installed skill or a built checkout',
      cause: error,
    });
  }
  const own = r.p.dirname(file);
  if (isBundleDir(r, own)) return bundleLayout(r, own);
  for (let dir = own; ;) {
    if (r.exists(r.p.join(dir, 'packages', 'engine', 'package.json'))) return sourceLayout(r, dir);
    const up = r.p.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw unknownTree(file);
}
