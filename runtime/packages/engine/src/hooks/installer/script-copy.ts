// The stable copy of the hook script (ADR 0070). A settings entry runs `$MCS_HOME/hooks/mcs-hook.mjs`, never a file inside the
// skill folder or the plugin cache, whose path changes with every plugin update. This module copies the bundled single-file
// handler (`mcs-hook.mjs` of the bundle layout) there, atomically, and reports whether the copy is current.
//
// Only the bundle layout has a hook file that is safe to copy: the checkout's `packages/cli/dist/hook.js` imports sibling
// modules and would break once copied. `readHookSource` refuses anything that is not one self-contained `mcs-hook.mjs`.
// Nothing here runs by itself: the installer calls it, and only for `hooks install --yes` (dry runs use `planHookScript`).
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { HooksScriptResult } from '@mcs/shared';
import { normalizePath, type EnvLike } from '@mcs/shared/protocol';

import { SmallFileError, atomicWriteFile, readSmallFile, unlinkWithRetry } from '../../platform/fsx.ts';
import { hooksFolder } from './manifest.ts';
import { hooksFailed } from './plan.ts';
import { assertNotRealInTest, sha256Hex } from './settings-io.ts';

/** The file name of the bundled handler and of its stable copy. */
export const HOOK_SCRIPT_NAME = 'mcs-hook.mjs';
/** The bundled handler is about 60 KiB; a file above this is not it. */
export const HOOK_SCRIPT_MAX_BYTES = 4 * 1024 * 1024;

/** `<MCS_HOME>/hooks/mcs-hook.mjs` with forward slashes: the path that settings entries carry. */
export function stableScriptPath(mcsHome: string): string {
  return normalizePath(path.join(hooksFolder(mcsHome), HOOK_SCRIPT_NAME));
}

function nativeCopyPath(mcsHome: string): string {
  return path.join(hooksFolder(mcsHome), HOOK_SCRIPT_NAME);
}

function bundleMissing(message: string, details: Readonly<Record<string, unknown>> = {}): Error {
  return hooksFailed('HOOK_BUNDLE_MISSING', message, {
    hint: 'run the bundled build (npm run bundle in runtime/) or install the skill, whose bundle holds mcs-hook.mjs',
    details,
  });
}

// Static `import ... from 'x'` and `export ... from 'x'` statements (rolldown ends them with `;`), side-effect imports, and
// dynamic imports with a string argument. A scan, not a parser: it exists to stop a half-built or wrong file, not an attacker.
const STATIC_IMPORT = /^(?:import|export)\b[^;]*?\bfrom\s*(['"])([^'"\n]+)\1/gm;
const BARE_IMPORT = /^import\s*(['"])([^'"\n]+)\1/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

/** The module specifiers in `text` that are not Node built-ins (`node:*`): a copy of the file would not find them. */
export function foreignImports(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of [STATIC_IMPORT, BARE_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier !== undefined && !specifier.startsWith('node:')) found.add(specifier);
    }
  }
  return [...found];
}

export interface HookScriptSource {
  readonly bytes: Buffer;
  readonly sha256: string;
}

/**
 * Reads the bundled handler that is to be copied. `HOOKS_FAILED` `HOOK_BUNDLE_MISSING` when `source` is not a file called
 * `mcs-hook.mjs` (the source layout's `dist/hook.js` is not), does not exist, is too large, or imports anything but `node:*`.
 */
export async function readHookSource(source: string): Promise<HookScriptSource> {
  if (path.basename(source) !== HOOK_SCRIPT_NAME) {
    throw bundleMissing(
      `${HOOK_SCRIPT_NAME} of the bundle is needed, not ${path.basename(source)}: the source layout has no hook file that is safe to copy`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readSmallFile(source, HOOK_SCRIPT_MAX_BYTES);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const why =
      code === 'ENOENT'
        ? 'it does not exist'
        : error instanceof SmallFileError
          ? 'it is too large'
          : 'it cannot be read';
    throw bundleMissing(`the bundled hook script ${normalizePath(source)} cannot be used: ${why}`);
  }
  const foreign = foreignImports(bytes.toString('utf8'));
  if (foreign.length > 0) {
    throw bundleMissing(
      `the bundled hook script imports other modules (${foreign.slice(0, 3).join(', ')}), so a copy of it would not run`,
    );
  }
  return { bytes, sha256: sha256Hex(bytes) };
}

export type HookScriptCopy =
  { readonly kind: 'missing' } | { readonly kind: 'link' } | { readonly kind: 'file'; readonly sha256: string | null };

async function inspectCopy(file: string): Promise<HookScriptCopy> {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return { kind: 'missing' };
    throw hooksFailed('SCRIPT_COPY_FAILED', 'cannot look at the stable copy of the hook script', {
      details: { path: normalizePath(file) },
      cause: error,
    });
  }
  if (info.isSymbolicLink()) return { kind: 'link' };
  if (!info.isFile()) {
    throw hooksFailed(
      'SCRIPT_COPY_FAILED',
      'something that is not a file is where the stable copy of the hook script goes',
      {
        details: { path: normalizePath(file) },
        hint: 'remove it, or point MCS_HOME elsewhere',
      },
    );
  }
  try {
    return { kind: 'file', sha256: sha256Hex(await readSmallFile(file, HOOK_SCRIPT_MAX_BYTES)) };
  } catch {
    return { kind: 'file', sha256: null };
  }
}

/** What is at `$MCS_HOME/hooks/mcs-hook.mjs` now: nothing, a link, or a file (with its hash; `null` when it cannot be read). */
export async function inspectHookScript(mcsHome: string): Promise<HookScriptCopy> {
  return inspectCopy(nativeCopyPath(mcsHome));
}

export interface HookScriptInput {
  /** The bundled handler (`layoutOfRuntimeDir(dir).hookEntry` in the bundle layout). */
  readonly source: string;
  readonly mcsHome: string;
  /** When given, the test guard runs first: in test mode `mcsHome` must lie in the temporary folder. */
  readonly env?: EnvLike;
  readonly tmpdir?: () => string;
}

export type HookScriptPlan = HooksScriptResult & {
  readonly action: 'created' | 'refreshed' | 'current';
  readonly sha256: string;
};

function guard(
  input: HookScriptInput | { readonly mcsHome: string; readonly env?: EnvLike; readonly tmpdir?: () => string },
): void {
  if (input.env === undefined) return;
  assertNotRealInTest({
    env: input.env,
    targets: [{ label: 'MCS_HOME', path: input.mcsHome }],
    ...(input.tmpdir === undefined ? {} : { tmpdir: input.tmpdir }),
  });
}

/** What `installHookScript` would do, with nothing written (the dry run of `hooks install`). */
export async function planHookScript(input: HookScriptInput): Promise<HookScriptPlan> {
  guard(input);
  const source = await readHookSource(input.source);
  const copy = await inspectCopy(nativeCopyPath(input.mcsHome));
  const action =
    copy.kind === 'missing'
      ? 'created'
      : copy.kind === 'file' && copy.sha256 === source.sha256
        ? 'current'
        : 'refreshed';
  return { action, path: stableScriptPath(input.mcsHome), sha256: source.sha256 };
}

/**
 * Copies the bundled handler to `$MCS_HOME/hooks/mcs-hook.mjs`: `created` when there was none, `refreshed` when the bytes
 * differed (or the destination was a link, which is removed and not followed), `current` when it is already the same (then
 * nothing is written). The write is a temporary file in the same folder renamed over the destination, so a concurrent reader
 * sees the old file or the new one, never half of it.
 */
export async function installHookScript(input: HookScriptInput): Promise<HookScriptPlan> {
  const plan = await planHookScript(input);
  if (plan.action === 'current') return plan;
  const source = await readHookSource(input.source);
  const file = nativeCopyPath(input.mcsHome);
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    if ((await inspectCopy(file)).kind === 'link') await unlinkWithRetry(file);
    await atomicWriteFile(file, source.bytes, { mode: 0o644 });
    const written = await readSmallFile(file, HOOK_SCRIPT_MAX_BYTES);
    if (sha256Hex(written) !== source.sha256) throw new Error('the copy differs from the source after the write');
  } catch (error) {
    throw hooksFailed('SCRIPT_COPY_FAILED', 'could not write the stable copy of the hook script', {
      details: { path: normalizePath(file) },
      cause: error,
    });
  }
  return { ...plan, sha256: source.sha256 };
}

/** Deletes the stable copy (a link is removed, not followed). `absent` when there was none. */
export async function removeHookScript(input: {
  readonly mcsHome: string;
  readonly env?: EnvLike;
  readonly tmpdir?: () => string;
}): Promise<'removed' | 'absent'> {
  guard(input);
  const file = nativeCopyPath(input.mcsHome);
  try {
    return (await unlinkWithRetry(file)) === 'deleted' ? 'removed' : 'absent';
  } catch (error) {
    throw hooksFailed('SCRIPT_COPY_FAILED', 'could not remove the stable copy of the hook script', {
      details: { path: normalizePath(file) },
      cause: error,
    });
  }
}

/** `current`, `stale` (another version, or a link), `missing`, or `unknown` when the bundled source cannot be read. */
export async function hookScriptState(input: HookScriptInput): Promise<'current' | 'stale' | 'missing' | 'unknown'> {
  guard(input);
  let source: HookScriptSource;
  try {
    source = await readHookSource(input.source);
  } catch {
    return 'unknown';
  }
  try {
    const copy = await inspectCopy(nativeCopyPath(input.mcsHome));
    if (copy.kind === 'missing') return 'missing';
    return copy.kind === 'file' && copy.sha256 === source.sha256 ? 'current' : 'stale';
  } catch {
    return 'unknown';
  }
}
