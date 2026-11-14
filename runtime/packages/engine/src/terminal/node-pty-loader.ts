// The one module that loads the terminal addon (design 01 section 2.5, ADR 0080 and 0082; the ESLint rule and the boundary test
// of the terminal keep it that way). The package is loaded by path, never imported: a bundle holds its files in
// `native/<platform>-<arch>/` next to the entry and has no node_modules, a checkout loads it from node_modules. Nothing is
// loaded when this module is imported, so the engine barrel (and the CLI that imports it) stays free of the addon.
//
// A failure never carries what the platform said: the messages of node-pty and of the module loader hold file paths. The
// TerminalError gets a fixed sentence and a cause that is only `{ code }`, and only when the code is a plain token.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type * as NodePty from '@lydell/node-pty';

import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import { layoutOfModule, type RuntimeLayout } from '../platform/layout.ts';
import { TerminalError } from './errors.ts';
import { NODE_PTY_PACKAGE, nativeDirOf, nativeEntryOf, targetOf } from './native-targets.ts';

/** The part of the addon that the terminal uses. */
export type NodePtyModule = Pick<typeof NodePty, 'spawn'>;
/** What `spawn` returns (node-pty `IPty`); named here so that no other file has to name the package. */
export type NodePtyTerm = ReturnType<NodePtyModule['spawn']>;
/** The third argument of `spawn`. */
export type NodePtySpawnOptions = Parameters<NodePtyModule['spawn']>[2];

/** The seams of the loader: tests pass a scripted layout, file probe and `require`. */
export interface LoaderDeps {
  /** `import.meta.url` of a module of this runtime: it decides the layout and is the base of `require`. */
  readonly moduleUrl: string;
  readonly platform: HostPlatform;
  readonly arch: string;
  readonly layoutOf: (moduleUrl: string) => RuntimeLayout;
  readonly exists: (file: string) => boolean;
  readonly require: (id: string) => unknown;
}

export interface LoadedNodePty {
  readonly module: NodePtyModule;
  /** `bundle`: loaded by path from `native/<target>`; `node_modules`: the package of a checkout. */
  readonly via: 'bundle' | 'node_modules';
  /** The `native/<target>` folder of the bundle branch, null for node_modules. */
  readonly dir: string | null;
}

/** The loader seams of this process: the host, this module, the real file system and a `require` based at this module. */
export function realLoaderDeps(): LoaderDeps {
  const moduleUrl = import.meta.url;
  const nodeRequire = createRequire(moduleUrl);
  return {
    moduleUrl,
    platform: hostPlatform,
    arch: process.arch,
    layoutOf: (url) => layoutOfModule(url),
    exists: (file) => existsSync(file),
    require: (id): unknown => nodeRequire(id),
  };
}

// ---- errors without messages -------------------------------------------------------------------------------------

/** What an error code may look like to be kept: a plain token (`ERR_DLOPEN_FAILED`, `MODULE_NOT_FOUND`, `EPERM`). */
const SAFE_CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function codeOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('code' in value)) return null;
  const { code } = value;
  return typeof code === 'string' && SAFE_CODE_RE.test(code) ? code : null;
}

/**
 * The `code` of a thrown value, or of its `cause` when it has none of its own (the package wrapper of node-pty rethrows the
 * `MODULE_NOT_FOUND` of a missing platform package as a plain Error). A value that is not a plain token gives null.
 */
export function errorCodeOf(error: unknown): string | null {
  const own = codeOf(error);
  if (own !== null) return own;
  return typeof error === 'object' && error !== null && 'cause' in error ? codeOf(error.cause) : null;
}

/** The only thing of a native error that may travel in a TerminalError: its code. */
export function safeCause(error: unknown): { readonly code: string | null } {
  return { code: errorCodeOf(error) };
}

// ---- loading -----------------------------------------------------------------------------------------------------

function isNodePtyModule(value: unknown): value is NodePtyModule {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'spawn' in value &&
    typeof value.spawn === 'function'
  );
}

function checked(value: unknown): NodePtyModule {
  if (!isNodePtyModule(value)) throw new TerminalError('NATIVE_LOAD_FAILED', { cause: { code: null } });
  return value;
}

function fromBundle(deps: LoaderDeps, layout: RuntimeLayout): LoadedNodePty {
  const target = targetOf(deps.platform, deps.arch);
  if (target === null) throw new TerminalError('UNSUPPORTED_OS');
  const entry = nativeEntryOf(layout, target);
  // A bundle has no node_modules to fall back to: a missing folder is a missing component.
  if (!deps.exists(entry)) throw new TerminalError('NATIVE_MISSING');
  return { module: checked(deps.require(entry)), via: 'bundle', dir: nativeDirOf(layout, target) };
}

function fromNodeModules(deps: LoaderDeps): LoadedNodePty {
  // The package picks `@lydell/node-pty-<platform>-<arch>` from node_modules itself; a checkout never looks at `bundle/native`.
  return { module: checked(deps.require(NODE_PTY_PACKAGE)), via: 'node_modules', dir: null };
}

/**
 * Loads the addon. Throws a TerminalError and nothing else: UNSUPPORTED_OS (a bundle with no folder for this host),
 * NATIVE_MISSING (no folder, no package, a file that `require` cannot find) or NATIVE_LOAD_FAILED (anything else).
 */
export function loadNodePty(deps: LoaderDeps): LoadedNodePty {
  try {
    const layout = deps.layoutOf(deps.moduleUrl);
    return layout.mode === 'bundle' ? fromBundle(deps, layout) : fromNodeModules(deps);
  } catch (error) {
    if (error instanceof TerminalError) throw error;
    const cause = safeCause(error);
    throw new TerminalError(cause.code === 'MODULE_NOT_FOUND' ? 'NATIVE_MISSING' : 'NATIVE_LOAD_FAILED', { cause });
  }
}
