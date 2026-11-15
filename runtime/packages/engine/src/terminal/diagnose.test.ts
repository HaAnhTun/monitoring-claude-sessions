import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it, vi } from 'vitest';

import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import { diagnoseTerminal, installedPackageDir, type DiagnoseDeps, type TerminalDiagnosis } from './diagnose.ts';
import { TerminalError } from './errors.ts';
import type { LoadedNodePty } from './node-pty-loader.ts';

// FIXTURE: invented paths. The loader and the file system are scripted; only the tests named "real" read the disk and load the addon.
const HOME = 'C:\\Users\\fixture';
const TOOLS = 'C:\\tools';
const BUNDLE_X64 = 'C:\\caw\\skill\\bundle\\native\\win32-x64';
const BUNDLE_ARM64 = 'C:\\caw\\skill\\bundle\\native\\win32-arm64';
const MODULE_X64 = 'C:\\caw\\repo\\runtime\\node_modules\\@lydell\\node-pty-win32-x64';
const SECRET = 'C:\\secret-folder\\conpty.node';

const tempDir = useTempDirs();

const conptyFiles = (dir: string, target: string): string[] => [
  `${dir}\\prebuilds\\${target}\\conpty\\conpty.dll`,
  `${dir}\\prebuilds\\${target}\\conpty\\OpenConsole.exe`,
];

const addon = (via: LoadedNodePty['via'], dir: string | null): LoadedNodePty => ({
  module: { spawn: vi.fn() },
  via,
  dir,
});

interface RigOptions {
  readonly platform?: HostPlatform;
  readonly arch?: string;
  readonly release?: string;
  readonly files?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly load?: () => LoadedNodePty;
  readonly packageDir?: string | null;
  readonly command?: string;
}

function diagnose(o: RigOptions = {}): {
  result: TerminalDiagnosis;
  load: ReturnType<typeof vi.fn<() => LoadedNodePty>>;
} {
  const files = new Set(o.files ?? [`${TOOLS}\\claude.exe`, ...conptyFiles(BUNDLE_X64, 'win32-x64')]);
  const load = vi.fn(o.load ?? ((): LoadedNodePty => addon('bundle', BUNDLE_X64)));
  const deps: DiagnoseDeps = {
    config: { command: o.command ?? 'claude', conptyDll: false },
    platform: o.platform ?? 'win32',
    arch: o.arch ?? 'x64',
    release: o.release ?? '10.0.26200',
    env: o.env ?? { PATH: TOOLS, PATHEXT: '.exe;.cmd', SystemRoot: 'C:\\Windows' },
    home: HOME,
    fs: { isFile: (p) => files.has(p) },
    load,
    packageDirOf: () => (o.packageDir === undefined ? null : o.packageDir),
  };
  return { result: diagnoseTerminal(deps), load };
}

describe('diagnoseTerminal (design 01 section 3.12): what `check` and `doctor` show, without starting anything', () => {
  it('a supported Windows host: the addon from the bundle, claude found, the conpty files next to the addon', () => {
    const { result, load } = diagnose();
    expect(result).toEqual({
      supported: true,
      reason: null,
      nodePty: { via: 'bundle', loaded: true },
      claude: { found: true, kind: 'exe', display: `${TOOLS}\\claude.exe` },
      conptyDll: { filesPresent: true },
      windowsBuild: { build: 26_200, ok: true },
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('finds the conpty files of the arm64 bundle folder', () => {
    const { result } = diagnose({
      arch: 'arm64',
      files: [`${TOOLS}\\claude.exe`, ...conptyFiles(BUNDLE_ARM64, 'win32-arm64')],
      load: () => addon('bundle', BUNDLE_ARM64),
    });
    expect(result.conptyDll).toEqual({ filesPresent: true });
  });

  it('says the conpty files are missing when either one is', () => {
    const [dll] = conptyFiles(BUNDLE_X64, 'win32-x64');
    const withDll = diagnose({ files: [`${TOOLS}\\claude.exe`, ...(dll === undefined ? [] : [dll])] });
    expect(withDll.result.conptyDll).toEqual({ filesPresent: false });
    expect(withDll.result.supported).toBe(true);
    const none = diagnose({ files: [`${TOOLS}\\claude.exe`] });
    expect(none.result.conptyDll).toEqual({ filesPresent: false });
  });

  it('a checkout loads the addon from node_modules and looks for the conpty files in the platform package', () => {
    const { result } = diagnose({
      load: () => addon('node_modules', null),
      packageDir: MODULE_X64,
      files: [`${TOOLS}\\claude.exe`, ...conptyFiles(MODULE_X64, 'win32-x64')],
    });
    expect(result.nodePty).toEqual({ via: 'node_modules', loaded: true });
    expect(result.conptyDll).toEqual({ filesPresent: true });
  });

  it('does not know whether the conpty files are there when the platform package cannot be located', () => {
    const { result } = diagnose({ load: () => addon('node_modules', null), packageDir: null });
    expect(result.nodePty).toEqual({ via: 'node_modules', loaded: true });
    expect(result.conptyDll).toEqual({ filesPresent: null });
  });

  describe('a host that cannot run the terminal never loads the addon', () => {
    const cases: readonly (readonly [string, RigOptions, string])[] = [
      ['Linux', { platform: 'linux', arch: 'x64', release: '6.8.0' }, 'unsupported-os'],
      ['macOS', { platform: 'darwin', arch: 'arm64', release: '24.1.0' }, 'unsupported-os'],
      ['Windows on ia32', { arch: 'ia32' }, 'unsupported-os'],
      ['Windows 10 before 1809', { release: '10.0.17134' }, 'os-too-old'],
      ['an unreadable Windows release', { release: 'garbage' }, 'os-too-old'],
    ];
    for (const [label, rigOptions, reason] of cases) {
      it(`${label}: ${reason}`, () => {
        const { result, load } = diagnose(rigOptions);
        expect(result.supported).toBe(false);
        expect(result.reason).toBe(reason);
        expect(result.nodePty).toEqual({ via: null, loaded: false });
        expect(result.conptyDll).toEqual({ filesPresent: null });
        expect(load).not.toHaveBeenCalled();
      });
    }

    it('still reports the Windows build, so the check can say what is too old', () => {
      expect(diagnose({ release: '10.0.17134' }).result.windowsBuild).toEqual({ build: 17_134, ok: false });
      expect(diagnose({ release: 'garbage' }).result.windowsBuild).toEqual({ build: null, ok: false });
      expect(diagnose({ arch: 'ia32' }).result.windowsBuild).toEqual({ build: 26_200, ok: true });
    });

    it('has no Windows build off Windows', () => {
      expect(diagnose({ platform: 'linux', arch: 'x64', release: '6.8.0' }).result.windowsBuild).toBeNull();
    });
  });

  describe('the addon that does not load', () => {
    it('native-missing for a TerminalError NATIVE_MISSING', () => {
      const { result } = diagnose({
        load: () => {
          throw new TerminalError('NATIVE_MISSING');
        },
      });
      expect(result.supported).toBe(false);
      expect(result.reason).toBe('native-missing');
      expect(result.nodePty).toEqual({ via: null, loaded: false });
      expect(result.conptyDll).toEqual({ filesPresent: null });
    });

    it('native-load-failed for NATIVE_LOAD_FAILED and for any other error, and the message goes nowhere', () => {
      for (const error of [new TerminalError('NATIVE_LOAD_FAILED'), new Error(`dlopen failed: ${SECRET}`)]) {
        const { result } = diagnose({
          load: () => {
            throw error;
          },
        });
        expect(result.reason).toBe('native-load-failed');
        expect(JSON.stringify(result)).not.toContain('secret-folder');
        expect(JSON.stringify(result)).not.toContain('dlopen');
      }
    });

    it('maps UNSUPPORTED_OS from a bundle without a folder for this host to unsupported-os', () => {
      const { result } = diagnose({
        load: () => {
          throw new TerminalError('UNSUPPORTED_OS');
        },
      });
      expect(result.reason).toBe('unsupported-os');
    });
  });

  describe('claude', () => {
    it('not found: nothing to show, and the rest of the report is unaffected', () => {
      const { result } = diagnose({ files: conptyFiles(BUNDLE_X64, 'win32-x64') });
      expect(result.claude).toEqual({ found: false, kind: null, display: null });
      expect(result.supported).toBe(true);
    });

    it('an npm shim is a shim, and the home folder is shown as ~', () => {
      const shim = `${HOME}\\AppData\\Roaming\\npm\\claude.cmd`;
      const { result } = diagnose({
        files: [shim],
        env: { PATH: `${HOME}\\AppData\\Roaming\\npm`, PATHEXT: '.cmd', SystemRoot: 'C:\\Windows' },
      });
      expect(result.claude).toEqual({ found: true, kind: 'shim', display: '~\\AppData\\Roaming\\npm\\claude.cmd' });
    });

    it('follows terminal.command, also an absolute path', () => {
      const { result } = diagnose({ command: 'D:\\apps\\agent.exe', files: ['D:\\apps\\agent.exe'] });
      expect(result.claude).toEqual({ found: true, kind: 'exe', display: 'D:\\apps\\agent.exe' });
    });

    it('is looked up on an unsupported host too: the check reports both facts', () => {
      const { result } = diagnose({
        platform: 'linux',
        arch: 'x64',
        release: '6.8.0',
        files: ['/usr/bin/claude'],
        env: { PATH: '/usr/bin' },
      });
      expect(result.supported).toBe(false);
      expect(result.claude).toEqual({ found: true, kind: 'exe', display: '/usr/bin/claude' });
    });
  });

  it('holds only plain facts: no path of the addon, no error text, nothing but the shortened program', () => {
    const { result } = diagnose();
    const text = JSON.stringify(result);
    expect(text).not.toContain('native');
    expect(text).not.toContain('prebuilds');
    expect(text).not.toContain('conpty.dll');
  });

  it('starts no process: the module imports neither the exec helper nor the process helpers nor child_process', () => {
    const source = readFileSync(fileURLToPath(new URL('./diagnose.ts', import.meta.url)), 'utf8');
    const imports = [...source.matchAll(/^import[^;]*?from\s+'([^']+)'/gmu)].map((m) => m[1] ?? '');
    for (const specifier of imports) {
      expect(specifier, specifier).not.toMatch(/child_process|platform\/exec|platform\/process/u);
    }
  });

  it('works with the real defaults: the host, its file system and the loader', () => {
    const result = diagnoseTerminal({ config: { command: 'claude', conptyDll: false } });
    expect(result.supported).toBe(result.reason === null);
    expect(result.supported).toBe(result.nodePty.loaded);
    expect(typeof result.claude.found).toBe('boolean');
    if (hostPlatform !== 'win32') expect(result.windowsBuild).toBeNull();
  });

  // A checkout loads the addon from node_modules, so the conpty files are looked up in the installed platform package. The real
  // resolution must find it: the package says `exports: "./lib/index.js"`, which hides its package.json from `require.resolve`.
  it.runIf(hostPlatform === 'win32' && process.arch === 'x64')(
    'finds the conpty files of the platform package installed in this checkout',
    () => {
      const result = diagnoseTerminal({ config: { command: 'claude', conptyDll: false } });
      expect(result.nodePty.via).toBe('node_modules');
      expect(result.conptyDll).toEqual({ filesPresent: true });
    },
  );
});

describe('installedPackageDir: where the platform package of the addon is installed', () => {
  /** An install whose platform package hides its package.json behind a string `exports`, as @lydell/node-pty-<target> does. */
  function install(exportsField: unknown): { root: string; from: string; packageDir: string } {
    const root = tempDir('terminal-package-dir').path;
    const packageDir = path.join(root, 'node_modules', '@lydell', 'node-pty-win32-x64');
    mkdirSync(path.join(packageDir, 'lib'), { recursive: true });
    writeFileSync(path.join(packageDir, 'lib', 'index.js'), 'module.exports = {};');
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: '@lydell/node-pty-win32-x64', version: '0.0.0', type: 'commonjs', exports: exportsField }),
    );
    mkdirSync(path.join(root, 'src'), { recursive: true });
    return { root, from: pathToFileURL(path.join(root, 'src', 'diagnose.ts')).href, packageDir };
  }

  it('finds a package whose exports field is a plain string (its package.json is not exported)', () => {
    const { from, packageDir } = install('./lib/index.js');
    expect(installedPackageDir('win32-x64', from)).toBe(packageDir);
  });

  it('finds a package that exports its package.json too', () => {
    const { from, packageDir } = install({ '.': './lib/index.js', './package.json': './package.json' });
    expect(installedPackageDir('win32-x64', from)).toBe(packageDir);
  });

  it('is null for a target whose package is not installed', () => {
    const { from } = install('./lib/index.js');
    expect(installedPackageDir('win32-arm64', from)).toBeNull();
  });

  it('is null when no node_modules is reachable', () => {
    const root = tempDir('terminal-package-dir').path;
    expect(installedPackageDir('win32-x64', pathToFileURL(path.join(root, 'diagnose.ts')).href)).toBeNull();
  });

  it('resolves the install of this checkout for the host target, when the host has one', () => {
    // Only a host whose platform package is installed (Windows x64 here) can answer; every other host answers null.
    const dir = installedPackageDir('win32-x64');
    if (hostPlatform === 'win32' && process.arch === 'x64') {
      expect(dir === null ? null : path.basename(dir)).toBe('node-pty-win32-x64');
    } else {
      expect(dir === null || path.basename(dir) === 'node-pty-win32-x64').toBe(true);
    }
  });
});
