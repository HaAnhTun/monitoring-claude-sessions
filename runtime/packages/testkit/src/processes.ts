// Tracked child processes and the real CLI runner (05 4.4). Every child starts from a minimal environment (4.5, C3).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TrackedProcess {
  readonly pid: number;
  /** Exit code, or `null` when the process was killed by a signal. */
  readonly exited: Promise<number | null>;
  kill(): void;
}

/** `<skill>/runtime`: this file sits in `packages/testkit/{src,dist}`, three levels below it. */
export function runtimeRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
}

/** The skill folder (`<skill>/`), parent of `runtime/`. */
export function skillRoot(): string {
  return dirname(runtimeRoot());
}

/** `runtime/packages/cli/dist/main.js`. */
export function cliEntryPath(): string {
  return join(runtimeRoot(), 'packages', 'cli', 'dist', 'main.js');
}

/**
 * The only variables a test child inherits from the parent: PATH, the Windows system variables a process needs to start,
 * and `TZ=UTC`. Nothing named `MCS_*` or `CLAUDE_*` is ever inherited.
 */
export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = { TZ: 'UTC' };
  const keys = process.platform === 'win32' ? ['PATH', 'SystemRoot', 'TEMP', 'TMP'] : ['PATH'];
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const live = new Set<ChildProcess>();
const cleanups = new Set<() => Promise<void>>();

/** Registers an async cleanup that `killAllTracked` runs once (used by `startInstance`). */
export function onKillAll(cleanup: () => Promise<void>): void {
  cleanups.add(cleanup);
}

function killTree(pid: number, child: ChildProcess): void {
  if (process.platform === 'win32') {
    // taskkill /F semantics: also the children of the process (a launcher may have started a server).
    spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

/**
 * Ends the process tree of `pid` at once: the fallback of a cleanup whose polite stop failed or ran out of time on a loaded
 * machine. Never throws; a process that is already gone is the goal.
 */
export function killPidTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export interface SpawnTrackedOptions {
  cwd?: string;
  /** Added over `baseEnv()` plus `MCS_HOOK_DISABLE=1`. */
  env?: Record<string, string>;
}

/** Starts a process without a shell, without a console window and without inheriting stdio. */
export function spawnTracked(file: string, args: readonly string[], opts: SpawnTrackedOptions = {}): TrackedProcess {
  const env = { ...baseEnv(), MCS_HOOK_DISABLE: '1', ...opts.env };
  const child = spawn(file, [...args], {
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  let failure: Error | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  const pid = child.pid;
  if (pid === undefined) {
    // `spawn` reports a missing program through the `error` event on the next tick; the pid is already undefined.
    throw new Error(`spawnTracked: cannot start ${file}${failure === undefined ? '' : `: ${failure.message}`}`);
  }
  live.add(child);
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      live.delete(child);
      resolve(code);
    });
    child.once('error', () => {
      live.delete(child);
      resolve(null);
    });
  });
  return {
    pid,
    exited,
    kill: () => {
      killTree(pid, child);
    },
  };
}

/**
 * Runs the registered cleanups, kills every tracked process and waits until they are gone. Safe to call twice. A cleanup that
 * fails never stops the others and never spares a live child: the failures are rethrown only after every child is dead.
 */
export async function killAllTracked(): Promise<void> {
  const todo = [...cleanups];
  cleanups.clear();
  const failures: unknown[] = [];
  for (const cleanup of todo) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  const children = [...live];
  const waits = children.map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => {
          resolve();
        });
      }),
  );
  for (const child of children) if (child.pid !== undefined) killTree(child.pid, child);
  await Promise.all(waits);
  const [first] = failures;
  if (failures.length === 1) throw first;
  if (failures.length > 1) {
    const reasons = failures.map((failure) => (failure instanceof Error ? failure.message : String(failure)));
    throw new AggregateError(
      failures,
      `killAllTracked: ${String(failures.length)} cleanups failed: ${reasons.join('; ')}`,
    );
  }
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  cwd: string;
  env: Record<string, string>;
  /** Written to stdin, then stdin is closed; without it stdin is closed at once. */
  stdin?: string;
  /** Hard limit in ms (default 60 000); the process tree is killed and the call rejects. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Runs a program to its end without a shell and collects its output. The environment is used exactly as given. */
export function runProcess(
  file: string,
  args: readonly string[],
  opts: RunProcessOptions,
): Promise<CliResult & { durationMs: number }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(file, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    live.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    // The process may exit before it reads stdin (EPIPE): that is its answer, not a harness error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.stdin);
    const timer = setTimeout(() => {
      if (child.pid !== undefined) killTree(child.pid, child);
      reject(new Error(`${basename(file)} ${args.join(' ')} did not finish within ${String(timeoutMs)} ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      live.delete(child);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      live.delete(child);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        durationMs: performance.now() - started,
      });
    });
  });
}

export interface RunCliOptions {
  /** Temp per-user state folder (`MCS_HOME`). */
  mcsHome: string;
  /** Working directory; default `mcsHome` (never a folder of the real repository). */
  cwd?: string;
  /** Merged over the minimal environment; `MCS_HOOK_DISABLE=1` is applied last, always. */
  env?: Record<string, string>;
}

/** Runs `node <entry> <args>` with the environment contract of `runCli`; used for the CLI and by tests of this kit. */
export async function runNodeEntry(entry: string, args: readonly string[], opts: RunCliOptions): Promise<CliResult> {
  mkdirSync(opts.mcsHome, { recursive: true });
  const env: Record<string, string> = {
    ...baseEnv(),
    MCS_HOME: opts.mcsHome,
    CLAUDE_CONFIG_DIR: join(opts.mcsHome, 'claude-home'),
    HOME: join(opts.mcsHome, 'home'),
    USERPROFILE: join(opts.mcsHome, 'home'),
    ...opts.env,
    MCS_HOOK_DISABLE: '1',
  };
  const { code, stdout, stderr } = await runProcess(process.execPath, [entry, ...args], {
    cwd: opts.cwd ?? opts.mcsHome,
    env,
  });
  return { code, stdout, stderr };
}

/** `node packages/cli/dist/main.js <args>` with `MCS_HOME=<mcsHome>` and hooks disabled. Needs a built runtime. */
export function runCli(args: readonly string[], opts: RunCliOptions): Promise<CliResult> {
  const entry = cliEntryPath();
  if (!existsSync(entry)) {
    return Promise.reject(new Error(`runCli: ${entry} is missing; build the runtime first (npm run build)`));
  }
  return runNodeEntry(entry, args, opts);
}
