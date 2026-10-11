// Shared helpers for repository scripts. Zero dependencies; Node >= 22.22.0 (the one floor, 01 section 5.1).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGES = ['shared', 'engine', 'server', 'cli', 'web', 'testkit'];

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Absolute path of a tool's JS entry, read from its package.json "bin" (never a .cmd shim). */
export function binPath(pkg, bin = pkg) {
  const dir = join(RUNTIME_ROOT, 'node_modules', pkg);
  const manifest = readJson(join(dir, 'package.json'));
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[bin];
  return join(dir, rel);
}

/** Runs `node <script> ...args` with inherited stdio, no shell. Resolves to the exit code. */
export function runNode(script, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd ?? RUNTIME_ROOT,
      stdio: options.stdio ?? 'inherit',
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...options.env },
    });
    child.on('error', () => resolvePromise(127));
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

/** What `npm run build` produces and the tests that spawn `dist/` need (relative to the runtime root). */
export const BUILD_OUTPUTS = [
  '.mcs-build.json',
  'packages/cli/dist/main.js',
  'packages/cli/dist/hook.js',
  'packages/server/dist/boot.js',
];

/** The build outputs that are missing under `root` (empty when the runtime is built). */
export function missingBuildOutputs(root = RUNTIME_ROOT) {
  return BUILD_OUTPUTS.filter((rel) => !existsSync(join(root, rel)));
}

/**
 * `node scripts/lib.mjs require-build`: exits 1 with a clear message when `npm run build` has not run. For the standalone test
 * scripts (`test:int`, `test:isolation`, `test:resilience`) as a pre-script; `scripts/ci.mjs` builds before it tests and needs no guard.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv[2] === 'require-build') {
  const missing = missingBuildOutputs();
  if (missing.length > 0) {
    console.error(
      `build required: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. ` +
        'These tests spawn dist/ and need the build stamp: run `npm run build` first (no hidden auto-build).',
    );
    process.exitCode = 1;
  }
}
