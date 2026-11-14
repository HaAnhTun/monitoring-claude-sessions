import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import { layoutOfModule } from '../platform/layout.ts';
import { TerminalError } from './errors.ts';
import { errorCodeOf, loadNodePty, realLoaderDeps, safeCause, type LoaderDeps } from './node-pty-loader.ts';

// FIXTURE: invented paths. Nothing here touches the disk: layout, file probes and require are scripted.
const BUNDLE_DIR = 'C:\\caw\\skill\\bundle';
const BUNDLE_URL = 'file:///C:/caw/skill/bundle/mcs-server.mjs';
const CHECKOUT_DIR = 'C:\\caw\\repo\\runtime';
const CHECKOUT_URL = 'file:///C:/caw/repo/runtime/packages/engine/src/terminal/node-pty-loader.ts';
const X64_ENTRY = `${BUNDLE_DIR}\\native\\win32-x64\\lib\\index.js`;
const ARM64_ENTRY = `${BUNDLE_DIR}\\native\\win32-arm64\\lib\\index.js`;

/** A path that a message could leak. */
const SECRET = 'C:\\caw\\secret-folder\\conpty.node';

const FAKE_MODULE = { spawn: () => undefined };

interface RigOptions {
  readonly layout: 'bundle' | 'source';
  readonly platform?: HostPlatform;
  readonly arch?: string;
  /** Files that exist next to the layout markers (the native entry of the bundle). */
  readonly files?: readonly string[];
  readonly load?: (id: string) => unknown;
}

interface Rig {
  readonly deps: LoaderDeps;
  /** Every id the loader handed to require. */
  readonly required: string[];
  /** Every path the loader asked `exists` about. */
  readonly probed: string[];
}

function rig(o: RigOptions): Rig {
  const marker =
    o.layout === 'bundle' ? `${BUNDLE_DIR}\\mcs-server.mjs` : `${CHECKOUT_DIR}\\packages\\engine\\package.json`;
  const layoutFiles = new Set([marker]);
  const files = new Set(o.files ?? []);
  const required: string[] = [];
  const probed: string[] = [];
  const deps: LoaderDeps = {
    moduleUrl: o.layout === 'bundle' ? BUNDLE_URL : CHECKOUT_URL,
    platform: o.platform ?? 'win32',
    arch: o.arch ?? 'x64',
    layoutOf: (url) => layoutOfModule(url, { platform: 'win32', exists: (file) => layoutFiles.has(file) }),
    exists: (file) => {
      probed.push(file);
      return files.has(file);
    },
    require: (id) => {
      required.push(id);
      return (o.load ?? (() => FAKE_MODULE))(id);
    },
  };
  return { deps, required, probed };
}

function failure(load: () => unknown): TerminalError {
  try {
    load();
  } catch (error) {
    if (error instanceof TerminalError) return error;
    throw error;
  }
  throw new Error('expected the call to throw a TerminalError');
}

/**
 * node-pty and the module loader can throw any value, and `only-throw-error` rightly asks for an Error. This is the one place
 * that scripts a throw of something else: the type is a lie on purpose, the runtime value is what the code under test must survive.
 */
function asThrowable(value: unknown): Error {
  return value as Error;
}

function codeError(code: string, message = 'boom'): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

describe('loadNodePty: bundle layout', () => {
  it('requires native/<platform>-<arch>/lib/index.js by path and reports the bundle branch', () => {
    const r = rig({ layout: 'bundle', files: [X64_ENTRY] });
    const loaded = loadNodePty(r.deps);
    expect(loaded.module).toBe(FAKE_MODULE);
    expect(loaded.via).toBe('bundle');
    expect(loaded.dir).toBe(`${BUNDLE_DIR}\\native\\win32-x64`);
    expect(r.required).toEqual([X64_ENTRY]);
    expect(r.probed).toEqual([X64_ENTRY]);
  });

  it('picks the arm64 folder on an arm64 host', () => {
    const r = rig({ layout: 'bundle', arch: 'arm64', files: [ARM64_ENTRY] });
    const loaded = loadNodePty(r.deps);
    expect(loaded.dir).toBe(`${BUNDLE_DIR}\\native\\win32-arm64`);
    expect(r.required).toEqual([ARM64_ENTRY]);
  });

  it('never falls back to node_modules: a missing native folder is NATIVE_MISSING and nothing is required', () => {
    const r = rig({ layout: 'bundle', files: [] });
    const error = failure(() => loadNodePty(r.deps));
    expect(error.code).toBe('NATIVE_MISSING');
    expect(r.required).toEqual([]);
  });

  it('a folder for the other architecture does not count', () => {
    const r = rig({ layout: 'bundle', arch: 'x64', files: [ARM64_ENTRY] });
    expect(failure(() => loadNodePty(r.deps)).code).toBe('NATIVE_MISSING');
    expect(r.required).toEqual([]);
  });

  it('a host that has no shipped target is UNSUPPORTED_OS, without a probe or a require', () => {
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['darwin', 'arm64'],
      ['win32', 'ia32'],
    ] as const) {
      const r = rig({ layout: 'bundle', platform, arch, files: [X64_ENTRY, ARM64_ENTRY] });
      expect(failure(() => loadNodePty(r.deps)).code).toBe('UNSUPPORTED_OS');
      expect(r.required).toEqual([]);
      expect(r.probed).toEqual([]);
    }
  });
});

describe('loadNodePty: source layout (a checkout)', () => {
  it("requires '@lydell/node-pty' from node_modules and reports that branch", () => {
    const r = rig({ layout: 'source' });
    const loaded = loadNodePty(r.deps);
    expect(loaded.module).toBe(FAKE_MODULE);
    expect(loaded.via).toBe('node_modules');
    expect(loaded.dir).toBeNull();
    expect(r.required).toEqual(['@lydell/node-pty']);
  });

  it('never looks at a bundle/native folder', () => {
    const r = rig({ layout: 'source', files: [X64_ENTRY] });
    loadNodePty(r.deps);
    expect(r.probed).toEqual([]);
  });

  it('asks the package wrapper for the platform, so it also works for a target that a bundle does not ship', () => {
    const r = rig({ layout: 'source', platform: 'linux', arch: 'x64' });
    expect(loadNodePty(r.deps).via).toBe('node_modules');
    expect(r.required).toEqual(['@lydell/node-pty']);
  });
});

describe('loadNodePty: failures carry the error code only', () => {
  it('maps a throw of require to NATIVE_LOAD_FAILED and never repeats its message', () => {
    for (const layout of ['bundle', 'source'] as const) {
      const original = codeError('ERR_DLOPEN_FAILED', `The specified module could not be found: ${SECRET}`);
      const r = rig({
        layout,
        files: [X64_ENTRY],
        load: () => {
          throw original;
        },
      });
      const error = failure(() => loadNodePty(r.deps));
      expect(error.code).toBe('NATIVE_LOAD_FAILED');
      expect(error.message).toBe('The terminal component could not be loaded.');
      expect(error.cause).toEqual({ code: 'ERR_DLOPEN_FAILED' });
      expect(error.cause).not.toBe(original);
      for (const text of [error.message, String(error.stack), inspect(error, { depth: 6 }), JSON.stringify(error)]) {
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('secret-folder');
      }
    }
  });

  it('keeps no message when the thrown value has no code or is not an Error at all', () => {
    for (const thrown of [new Error(SECRET), SECRET, 42, null, undefined, { message: SECRET }]) {
      const r = rig({
        layout: 'source',
        load: () => {
          throw asThrowable(thrown);
        },
      });
      const error = failure(() => loadNodePty(r.deps));
      expect(error.code).toBe('NATIVE_LOAD_FAILED');
      expect(error.cause).toEqual({ code: null });
      expect(inspect(error, { depth: 6 })).not.toContain('secret-folder');
    }
  });

  it('drops a code that is not a plain token (it could carry a path)', () => {
    const r = rig({
      layout: 'source',
      load: () => {
        throw codeError(SECRET);
      },
    });
    expect(failure(() => loadNodePty(r.deps)).cause).toEqual({ code: null });
  });

  it('a package or file that cannot be found by require is NATIVE_MISSING', () => {
    for (const layout of ['bundle', 'source'] as const) {
      const r = rig({
        layout,
        files: [X64_ENTRY],
        load: () => {
          throw codeError('MODULE_NOT_FOUND', `Cannot find module '${SECRET}'`);
        },
      });
      const error = failure(() => loadNodePty(r.deps));
      expect(error.code).toBe('NATIVE_MISSING');
      expect(error.cause).toEqual({ code: 'MODULE_NOT_FOUND' });
      expect(inspect(error, { depth: 6 })).not.toContain('secret-folder');
    }
  });

  it('reads the code of the cause when the wrapper rethrows without one (the platform package is absent)', () => {
    const wrapper = new Error(`@lydell/node-pty could not find the platform-specific package ${SECRET}`, {
      cause: codeError('MODULE_NOT_FOUND'),
    });
    const r = rig({
      layout: 'source',
      load: () => {
        throw wrapper;
      },
    });
    const error = failure(() => loadNodePty(r.deps));
    expect(error.code).toBe('NATIVE_MISSING');
    expect(error.cause).toEqual({ code: 'MODULE_NOT_FOUND' });
  });

  it('a module without a spawn function is NATIVE_LOAD_FAILED', () => {
    for (const odd of [{}, { spawn: 'no' }, null, undefined, 'text', 7, () => undefined]) {
      const r = rig({ layout: 'source', load: () => odd });
      const error = failure(() => loadNodePty(r.deps));
      expect(error.code).toBe('NATIVE_LOAD_FAILED');
      expect(error.cause).toEqual({ code: null });
    }
  });

  it('a layout that cannot be found is NATIVE_LOAD_FAILED, and the message of the layout error stays out', () => {
    const r = rig({ layout: 'source' });
    const error = failure(() =>
      loadNodePty({
        ...r.deps,
        layoutOf: () => {
          throw codeError('INTERNAL', `no runtime layout found at ${SECRET}`);
        },
      }),
    );
    expect(error.code).toBe('NATIVE_LOAD_FAILED');
    expect(error.cause).toEqual({ code: 'INTERNAL' });
    expect(inspect(error, { depth: 6 })).not.toContain('secret-folder');
    expect(r.required).toEqual([]);
  });

  it('a throwing file probe is NATIVE_LOAD_FAILED too', () => {
    const r = rig({ layout: 'bundle', files: [X64_ENTRY] });
    const error = failure(() =>
      loadNodePty({
        ...r.deps,
        exists: () => {
          throw codeError('EPERM', SECRET);
        },
      }),
    );
    expect(error.code).toBe('NATIVE_LOAD_FAILED');
    expect(error.cause).toEqual({ code: 'EPERM' });
  });
});

describe('errorCodeOf and safeCause', () => {
  it('reads a plain code of the value, then of its cause', () => {
    expect(errorCodeOf(codeError('EACCES'))).toBe('EACCES');
    expect(errorCodeOf(new Error('x', { cause: codeError('ENOENT') }))).toBe('ENOENT');
    expect(errorCodeOf({ code: 'ERR_X.Y-Z_1' })).toBe('ERR_X.Y-Z_1');
  });

  it('prefers the code of the value over the code of its cause', () => {
    const error = Object.assign(new Error('x', { cause: codeError('INNER') }), { code: 'OUTER' });
    expect(errorCodeOf(error)).toBe('OUTER');
  });

  it.each([
    ['a number code', { code: 5 }],
    ['an empty code', { code: '' }],
    ['a code with a space', { code: 'has space' }],
    ['a code with a path', { code: 'C:\\x' }],
    ['a very long code', { code: 'A'.repeat(65) }],
    ['a string', 'ENOENT'],
    ['null', null],
    ['undefined', undefined],
  ])('returns null for %s', (_title, value) => {
    expect(errorCodeOf(value)).toBeNull();
  });

  it('safeCause holds the code and nothing else', () => {
    expect(safeCause(new Error(SECRET))).toEqual({ code: null });
    expect(Object.keys(safeCause(codeError('EIO', SECRET)))).toEqual(['code']);
  });
});

describe('realLoaderDeps', () => {
  it('describes this host, this module and the real file system', () => {
    const deps = realLoaderDeps();
    expect(deps.platform).toBe(hostPlatform);
    expect(deps.arch).toBe(process.arch);
    expect(deps.moduleUrl.startsWith('file:')).toBe(true);
    expect(deps.moduleUrl).toMatch(/node-pty-loader\.(?:ts|js|mjs)$/);
    expect(deps.exists(fileURLToPath(deps.moduleUrl))).toBe(true);
    expect(deps.exists('this-file-does-not-exist.node')).toBe(false);
    expect(deps.layoutOf(deps.moduleUrl).mode).toBe('source');
  });

  it('can require a built-in module through the loader module', () => {
    const deps = realLoaderDeps();
    expect(typeof deps.require('node:path')).toBe('object');
  });

  // Loading is not spawning: no console and no child process is created. The real sessions are tested in REAL-PTY.
  it.runIf(hostPlatform === 'win32' && (process.arch === 'x64' || process.arch === 'arm64'))(
    'loads the installed addon of a checkout from node_modules',
    () => {
      const loaded = loadNodePty(realLoaderDeps());
      expect(loaded.via).toBe('node_modules');
      expect(loaded.dir).toBeNull();
      expect(typeof loaded.module.spawn).toBe('function');
    },
  );
});
