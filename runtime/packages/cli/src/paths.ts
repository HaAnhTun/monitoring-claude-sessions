// The folders of a CLI process and the build information of its runtime, for both runtime layouts (ADR 0062 items 2 and 5).
// `mainPathsOf(import.meta.url)` is what the entry guard of `main.ts` passes when `dist/main.js` (or a bundle entry) runs
// directly; the launcher passes the same three folders itself. The build state is `current` in the bundle layout (a committed
// bundle is never rebuilt on a user machine) and comes from `scripts/build-stamp.mjs` in the source layout; the code stamp is
// read from `.mcs-build.json`, which both layouts have.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { layoutOfModule, layoutOfRuntimeDir, type LayoutFs, type RuntimeLayoutMode } from '@mcs/engine';
import { McsError } from '@mcs/shared';

import type { MainPaths } from './main.ts';

/** The launcher, skill and runtime folders of the running module (`import.meta.url`), through the layout resolver. */
export function mainPathsOf(moduleUrl: string | URL, fs?: LayoutFs): MainPaths {
  const layout = layoutOfModule(moduleUrl, fs);
  return { launcherPath: layout.launcherPath, skillDir: layout.skillDir, runtimeDir: layout.runtimeDir };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The layout mode of a runtime folder; a folder the resolver does not know keeps the source behaviour (and its errors). */
function modeOf(runtimeDir: string, fs?: LayoutFs): RuntimeLayoutMode {
  try {
    return layoutOfRuntimeDir(runtimeDir, fs).mode;
  } catch {
    return 'source';
  }
}

/** `current` or `stale`: always `current` for a bundle, `scripts/build-stamp.mjs` of the workspace (05 2.3) for sources. */
export async function buildState(runtimeDir: string, fs?: LayoutFs): Promise<'current' | 'stale'> {
  if (modeOf(runtimeDir, fs) === 'bundle') return 'current';
  const module: unknown = await import(pathToFileURL(path.join(runtimeDir, 'scripts', 'build-stamp.mjs')).href);
  const staleness = isRecord(module) ? module['staleness'] : undefined;
  if (typeof staleness !== 'function') throw new McsError('INTERNAL', 'build-stamp.mjs exports no staleness()');
  const state: unknown = Reflect.apply(staleness, undefined, [runtimeDir]);
  if (!isRecord(state) || typeof state['install'] !== 'boolean' || typeof state['build'] !== 'boolean') {
    throw new McsError('INTERNAL', 'build-stamp.mjs: staleness() answered an unexpected shape');
  }
  return state['install'] || state['build'] ? 'stale' : 'current';
}

/** The `codeStamp` of `<runtimeDir>/.mcs-build.json` (01 5.2) in both layouts; no stamp file is an error (shown as unknown). */
export async function codeStampOf(runtimeDir: string): Promise<string> {
  const stamp: unknown = JSON.parse(await readFile(path.join(runtimeDir, '.mcs-build.json'), 'utf8'));
  const code = isRecord(stamp) ? stamp['codeStamp'] : undefined;
  if (typeof code !== 'string' || code === '') throw new McsError('INTERNAL', '.mcs-build.json has no codeStamp');
  return code;
}

/** The build info of `version` and `status`: the code stamp and the build state. */
export async function buildInfoOf(
  runtimeDir: string,
  fs?: LayoutFs,
): Promise<{ code: string; build: 'current' | 'stale' }> {
  return { code: await codeStampOf(runtimeDir), build: await buildState(runtimeDir, fs) };
}
