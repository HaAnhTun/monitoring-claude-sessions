// The benchmark target: the launcher of the committed bundle (ADR 0061, 0062). `resolveTarget` runs `version --json` through it and
// refuses a launcher that is missing, that does not answer, or whose build is not current. It never builds anything.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME_ROOT = resolve(BENCH_DIR, '..');
export const SKILL_ROOT = resolve(RUNTIME_ROOT, '..');
export const RESULTS_DIR = join(BENCH_DIR, 'results');
export const DEFAULT_LAUNCHER = join(SKILL_ROOT, 'skills', 'monitoring-claude-sessions', 'scripts', 'mcs.mjs');

export class TargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TargetError';
  }
}

/** Loads the built testkit through its package name (the gate builds `dist` first). */
export async function loadTestkit() {
  try {
    return await import('@mcs/testkit');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TargetError(`cannot load @mcs/testkit (run npm run build in runtime/ first): ${reason}`);
  }
}

/** `(root) => environment` of a launcher child: the hermetic environment of the testkit with the bundle mode forced. */
export async function makeEnvFor() {
  const { hermeticEnv } = await loadTestkit();
  return (root) => ({ ...hermeticEnv(root), MCS_LAUNCHER_MODE: 'bundle' });
}

/** Runs `node <script> ...args` without a shell and collects the output. Resolves `{ code, stdout, stderr }`; never rejects. */
export function runNode(script, args, { env, cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      done({ code: -1, stdout, stderr: `${stderr}timed out after ${String(timeoutMs)} ms` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', (error) => done({ code: -1, stdout, stderr: String(error) }));
    child.once('close', (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Parses the stdout of `version --json` (`mcs.cli/1`) and checks the build. Returns the `data` object; throws `TargetError` for
 * output that is not that document and for `buildCurrent: false` (a stale bundle). `buildCurrent: null` (unknown) is allowed and
 * recorded as null.
 */
export function parseVersionAnswer(stdout) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    throw new TargetError('the launcher did not answer "version --json" with a JSON document');
  }
  const data = doc?.data;
  if (doc?.ok !== true || data === null || typeof data !== 'object') {
    throw new TargetError('the launcher answered "version --json" with an error or an unknown shape');
  }
  if (data.buildCurrent === false) {
    throw new TargetError('the bundle is not current (buildCurrent is false): rebuild and regenerate the bundle first');
  }
  for (const key of ['runtimeVersion', 'codeStamp', 'node', 'platform', 'arch']) {
    if (typeof data[key] !== 'string') throw new TargetError(`"version --json" has no ${key}`);
  }
  return data;
}

/**
 * Discovers and checks the launcher. `launcher` defaults to the committed one. The bundle mode is forced
 * (`MCS_LAUNCHER_MODE=bundle`), so a run can never fall back to the checkout's `dist`.
 */
export async function resolveTarget({ launcher } = {}) {
  const path = resolve(launcher ?? DEFAULT_LAUNCHER);
  if (!existsSync(path)) throw new TargetError(`launcher not found: ${path}`);
  const { hermeticEnv } = await loadTestkit();
  const root = mkdtempSync(join(tmpdir(), 'mcs-bench-target-'));
  try {
    const env = { ...hermeticEnv(root), MCS_LAUNCHER_MODE: 'bundle' };
    const run = await runNode(path, ['version', '--json'], { env, cwd: root, timeoutMs: 30_000 });
    if (run.code !== 0) {
      const first = (run.stderr || run.stdout).trim().split('\n')[0] ?? '';
      throw new TargetError(`the launcher failed "version --json" (exit ${String(run.code)}): ${first}`);
    }
    const data = parseVersionAnswer(run.stdout);
    return { launcher: path, version: data };
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** The record every result carries: node, platform, arch, bundle stamp and CPU count. No absolute path of the machine. */
export function describeHost(target) {
  const inRepo = relative(SKILL_ROOT, target.launcher);
  return {
    runtimeVersion: target.version.runtimeVersion,
    codeStamp: target.version.codeStamp,
    buildCurrent: target.version.buildCurrent,
    node: target.version.node,
    platform: target.version.platform,
    arch: target.version.arch,
    cpus: cpus().length,
    launcher: inRepo.startsWith('..') || resolve(inRepo) === inRepo ? '<custom launcher>' : inRepo.split(sep).join('/'),
  };
}

/** `20261020T101530Z`, the UTC stamp of a result file name. */
export function utcStamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/** Writes `<dir>/<name>-<stamp>.json` (default `bench/results/`) and returns its path. */
export function writeResult(name, doc, { dir = RESULTS_DIR, stamp = utcStamp() } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}
