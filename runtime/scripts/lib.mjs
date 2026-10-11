// Shared helpers for repository scripts. Zero dependencies; Node >= 22.22.0 (the one floor, 01 section 5.1).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
