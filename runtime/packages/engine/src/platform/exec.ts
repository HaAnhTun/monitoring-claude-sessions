// The only place that starts child processes (06 3.6, ADR 0051; security rules S-PROC of design 05):
//   - `execFileText(spec)`: short-lived children with a timeout, an output cap, a minimal environment, a 2-slot
//     semaphore with a queue of 8, and per-kind statistics. It never throws and never rejects.
//   - `spawnDetached` / `spawnForeground`: long-lived children (the server, legacy delegation), not counted in the statistics.
// Every spawn passes `shell: false` and `windowsHide: true`; a `.cmd` or `.bat` (which would need a shell) is refused.
// `node:child_process` is imported here and nowhere else in the engine (lint rule and the T-LC-16 test).
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import { ChildKindSchema, type ChildKind, type ChildKindStats } from '@mcs/shared';

import { hostPlatform, type HostPlatform } from './host.ts';

export type { ChildKind, ChildKindStats } from '@mcs/shared';

export type ChildErrorCode =
  'ENOENT' | 'EACCES' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'NONZERO_EXIT' | 'SPAWN_FAILED' | 'QUEUE_FULL' | 'ABORTED';

export interface ChildSpec {
  kind: ChildKind;
  /** Absolute path from `resolveExecutable()`; never a bare name, never `.cmd` or `.bat`. */
  file: string;
  /** Each element is passed verbatim; no shell parsing anywhere. */
  args: readonly string[];
  /** Absolute, must exist. */
  cwd?: string;
  /** Hard kill after this many ms. */
  timeoutMs: number;
  /** Cap for stdout and stderr together; exceeded: the child is killed and `truncated` is set. */
  maxOutputBytes: number;
  encoding: 'utf8' | 'latin1';
  extraEnv?: Readonly<Record<string, string>>;
  /**
   * Kind `node` only (`hooks verify` V6 probe payload, registry C60): written once to the child's stdin, then the stream is
   * closed. At most 4096 bytes of UTF-8; more is refused with `SPAWN_FAILED` and nothing is spawned. Never logged.
   */
  stdin?: string;
}

export interface ChildResult {
  /** Exit code 0 and no error. */
  ok: boolean;
  /** The exit code; null when the child was killed (timeout, output cap, abort) or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  error: ChildErrorCode | null;
  truncated: boolean;
  durationMs: number;
}

/** What the debug log line of rule 9 contains: no arguments, no output. */
export interface ChildLogEntry {
  kind: ChildKind;
  durationMs: number;
  code: number | null;
  error: ChildErrorCode | null;
}

export type ChildLogSink = (entry: ChildLogEntry) => void;

export const MAX_STDIN_BYTES = 4096;

const MAX_RUNNING = 2;
const MAX_QUEUED = 8;
/** After `exit`, how long to wait for the pipes to close (a grandchild may keep them open) before settling. */
const EXIT_GRACE_MS = 300;
/** `setTimeout` treats a delay above 2^31-1 ms as 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
const ENV_ALLOW_LIST = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'] as const;
const DOCKER_PASSTHROUGH = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'] as const;

// ---------------------------------------------------------------------------------------------------------------------
// refusals and error mapping

/** Why `file` may not be spawned, or null. Windows needs an absolute `.exe` or `.com`; elsewhere an absolute path. */
export function spawnRefusal(file: string, platform: HostPlatform = hostPlatform): string | null {
  if (file === '') return 'file is empty';
  if (file.includes('\u0000')) return 'file contains a NUL character';
  if (platform === 'win32') {
    if (!path.win32.isAbsolute(file)) return 'file must be an absolute path';
    const extension = path.win32.extname(file).toLowerCase();
    if (extension !== '.exe' && extension !== '.com') {
      return 'file must be an .exe or .com: a .cmd or .bat would need a shell';
    }
    return null;
  }
  return path.posix.isAbsolute(file) ? null : 'file must be an absolute path';
}

/** Maps a Node spawn error code to the closed set of `ChildErrorCode`. */
export function spawnErrorCode(code: string | undefined): ChildErrorCode {
  if (code === 'ENOENT') return 'ENOENT';
  if (code === 'EACCES' || code === 'EPERM') return 'EACCES';
  return 'SPAWN_FAILED';
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

function specRefusal(spec: ChildSpec): string | null {
  const fileProblem = spawnRefusal(spec.file);
  if (fileProblem !== null) return fileProblem;
  if (spec.cwd !== undefined && !path.isAbsolute(spec.cwd)) return 'cwd must be an absolute path';
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) return 'timeoutMs must be a positive number';
  if (!Number.isFinite(spec.maxOutputBytes) || spec.maxOutputBytes <= 0)
    return 'maxOutputBytes must be a positive number';
  if (spec.args.some((arg) => arg.includes('\u0000'))) return 'an argument contains a NUL character';
  if (spec.stdin !== undefined) {
    if (spec.kind !== 'node') return 'stdin is allowed for kind node only';
    if (Buffer.byteLength(spec.stdin, 'utf8') > MAX_STDIN_BYTES)
      return `stdin is longer than ${String(MAX_STDIN_BYTES)} bytes`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// environment

type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * The environment of a child (security rule 3): the allow-list, `MCS_HOOK_DISABLE=1` (recursion guard), the extras of the
 * kind (git: no prompts, no optional locks; docker: the engine selectors), `LC_ALL=C` off Windows, then `extraEnv`.
 * Nothing else of the parent leaks: not `GIT_DIR`, not tokens, not `MCS_*`.
 */
export function buildChildEnv(
  kind: ChildKind,
  extraEnv?: Readonly<Record<string, string>>,
  source: EnvSource = process.env,
  platform: HostPlatform = hostPlatform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOW_LIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env['MCS_HOOK_DISABLE'] = '1';
  if (kind === 'git') {
    env['GIT_TERMINAL_PROMPT'] = '0';
    env['GIT_OPTIONAL_LOCKS'] = '0';
  }
  if (kind === 'docker') {
    for (const name of DOCKER_PASSTHROUGH) {
      const value = source[name];
      if (value !== undefined) env[name] = value;
    }
  }
  if (platform !== 'win32') env['LC_ALL'] = 'C';
  if (extraEnv !== undefined) {
    for (const [name, value] of Object.entries(extraEnv)) env[name] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------------------------------------------------
// statistics and log sink

function mapKinds<T>(make: (kind: ChildKind) => T): Record<ChildKind, T> {
  return {
    'powershell.processes': make('powershell.processes'),
    'powershell.cmdline': make('powershell.cmdline'),
    git: make('git'),
    docker: make('docker'),
    ps: make('ps'),
    taskkill: make('taskkill'),
    node: make('node'),
    icacls: make('icacls'),
    opener: make('opener'),
  };
}

const counters: Record<ChildKind, ChildKindStats> = mapKinds(() => ({
  spawned: 0,
  failed: 0,
  timedOut: 0,
  totalMs: 0,
}));

/**
 * Counters per kind since the process started; every kind is present. `spawned` counts children that were started,
 * `failed` every non-ok answer (refusals and `QUEUE_FULL` included, a caller's abort excluded), `timedOut` the timeouts,
 * `totalMs` the run time of started children. Served as `HealthReport.children` (03 6.2).
 */
export function childStats(): Record<ChildKind, ChildKindStats> {
  return mapKinds((kind) => ({ ...counters[kind] }));
}

let logSink: ChildLogSink | null = null;

/** Where the one debug line per spawned child goes (rule 9). The composition root wires the instance logger here. */
export function setChildLogSink(sink: ChildLogSink | null): void {
  logSink = sink;
}

function report(entry: ChildLogEntry): void {
  if (logSink === null) return;
  try {
    logSink(entry);
  } catch {
    // A logging failure must never change the result of a child.
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// semaphore: 2 running, FIFO queue of 8, the 11th request is answered QUEUE_FULL at once

interface Waiter {
  start(): void;
}

let running = 0;
const queue: Waiter[] = [];

function releaseSlot(): void {
  running -= 1;
  const next = queue.shift();
  if (next !== undefined) {
    running += 1;
    next.start();
  }
}

function answer(kind: ChildKind, error: ChildErrorCode, stderr = ''): ChildResult {
  if (error !== 'ABORTED') counters[kind].failed += 1;
  return { ok: false, code: null, stdout: '', stderr, error, truncated: false, durationMs: 0 };
}

/** A refusal of a request whose kind is not even known: nothing to count it under. */
function unattributed(error: ChildErrorCode, stderr: string): ChildResult {
  return { ok: false, code: null, stdout: '', stderr, error, truncated: false, durationMs: 0 };
}

/** Never throws, never rejects: every failure is a `ChildResult` with `ok: false`. */
export function execFileText(request: ChildSpec, signal?: AbortSignal): Promise<ChildResult> {
  try {
    if (!ChildKindSchema.safeParse(request.kind).success) {
      return Promise.resolve(unattributed('SPAWN_FAILED', 'unknown child kind'));
    }
    // A request that waits in the queue must not change when the caller reuses or edits its objects meanwhile.
    const spec: ChildSpec = {
      ...request,
      args: [...request.args],
      ...(request.extraEnv === undefined ? {} : { extraEnv: { ...request.extraEnv } }),
    };
    const refusal = specRefusal(spec);
    if (refusal !== null) return Promise.resolve(answer(spec.kind, 'SPAWN_FAILED', refusal));
    if (signal?.aborted === true) return Promise.resolve(answer(spec.kind, 'ABORTED'));
    if (running < MAX_RUNNING) {
      running += 1;
      return runChild(spec, signal);
    }
    if (queue.length >= MAX_QUEUED) return Promise.resolve(answer(spec.kind, 'QUEUE_FULL'));
    return new Promise<ChildResult>((resolve) => {
      const onAbort = (): void => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        resolve(answer(spec.kind, 'ABORTED'));
      };
      const waiter: Waiter = {
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          void runChild(spec, signal).then(resolve);
        },
      };
      queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  } catch (error) {
    return Promise.resolve(unattributed('SPAWN_FAILED', errnoCode(error) ?? 'unexpected failure'));
  }
}

/** Runs one child; the slot it occupies is released exactly once, when the result is final. */
function runChild(spec: ChildSpec, signal: AbortSignal | undefined): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve) => {
    const startedAt = performance.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let error: ChildErrorCode | null = null;
    let killedByUs = false;
    let settled = false;
    let child: ChildProcess | null = null;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      releaseSlot();
      const durationMs = performance.now() - startedAt;
      const finalError = error ?? (exitCode === 0 ? null : 'NONZERO_EXIT');
      const code = killedByUs || child === null ? null : exitCode;
      const stats = counters[spec.kind];
      stats.totalMs += durationMs;
      if (finalError === 'TIMEOUT') stats.timedOut += 1;
      if (finalError !== null && finalError !== 'ABORTED') stats.failed += 1;
      report({ kind: spec.kind, durationMs, code, error: finalError });
      resolve({
        ok: finalError === null,
        code,
        stdout: Buffer.concat(stdoutChunks).toString(spec.encoding),
        stderr: Buffer.concat(stderrChunks).toString(spec.encoding),
        error: finalError,
        truncated,
        durationMs,
      });
    };

    const stop = (reason: ChildErrorCode): void => {
      error ??= reason;
      killedByUs = true;
      try {
        child?.kill();
      } catch {
        // The child is already gone.
      }
    };

    const onAbort = (): void => {
      stop('ABORTED');
    };

    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (settled || truncated) return;
      const room = spec.maxOutputBytes - bytes;
      if (chunk.length <= room) {
        chunks.push(chunk);
        bytes += chunk.length;
        return;
      }
      if (room > 0) {
        chunks.push(chunk.subarray(0, room));
        bytes += room;
      }
      truncated = true;
      stop('OUTPUT_LIMIT');
    };

    try {
      counters[spec.kind].spawned += 1;
      child = spawn(spec.file, [...spec.args], {
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: buildChildEnv(spec.kind, spec.extraEnv),
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      });
    } catch (thrown) {
      error = spawnErrorCode(errnoCode(thrown));
      finish(null);
      return;
    }

    try {
      child.stdout?.on('data', collect(stdoutChunks));
      child.stderr?.on('data', collect(stderrChunks));
      child.once('error', (failure) => {
        error ??= spawnErrorCode(errnoCode(failure));
        finish(null);
      });
      child.once('close', (code) => {
        finish(code);
      });
      child.once('exit', (code) => {
        if (settled) return;
        graceTimer = setTimeout(() => {
          finish(code);
        }, EXIT_GRACE_MS);
      });

      if (spec.stdin !== undefined && child.stdin !== null) {
        // The child may exit before it reads its input: EPIPE is its answer, not an error of ours.
        child.stdin.on('error', () => undefined);
        child.stdin.end(spec.stdin);
      }

      timer = setTimeout(
        () => {
          stop('TIMEOUT');
        },
        Math.min(spec.timeoutMs, MAX_TIMER_MS),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    } catch {
      // Wiring the child failed after it started (practically unreachable): end it and report a failed spawn.
      stop('SPAWN_FAILED');
      finish(null);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// long-lived children (01 4.2): not counted, not queued

function assertSpawnable(file: string): void {
  const problem = spawnRefusal(file);
  if (problem !== null) throw new TypeError(`cannot spawn ${JSON.stringify(file)}: ${problem}`);
}

/**
 * Starts `file` detached (it survives this process), hidden, with stdout and stderr on the given descriptors and no
 * stdin, then `unref()`s it. The caller owns the descriptors and closes its copies.
 *
 * A file that is well formed but missing or not executable does not throw here: the child has no `pid` and Node emits
 * `error` (`ENOENT`, `EACCES`) on the next tick. The caller must attach `child.on('error', ...)` in the same tick, before
 * it awaits anything, and treat `pid === undefined` as a failed start. An unhandled `error` event ends the calling process.
 */
export function spawnDetached(
  file: string,
  args: readonly string[],
  o: { cwd: string; env: Record<string, string>; stdoutFd: number; stderrFd: number },
): ChildProcess {
  assertSpawnable(file);
  const child = spawn(file, [...args], {
    shell: false,
    windowsHide: true,
    detached: true,
    cwd: o.cwd,
    env: o.env,
    stdio: ['ignore', o.stdoutFd, o.stderrFd],
  });
  child.unref();
  return child;
}

/**
 * Starts `file` attached, with the stdio of this process (an interactive `serve`, legacy delegation). As for
 * `spawnDetached`, a missing or non-executable file gives a child without `pid` and an `error` event: the caller must
 * attach `child.on('error', ...)` in the same tick.
 */
export function spawnForeground(
  file: string,
  args: readonly string[],
  o: { cwd: string; env: Record<string, string> },
): ChildProcess {
  assertSpawnable(file);
  return spawn(file, [...args], { shell: false, windowsHide: true, cwd: o.cwd, env: o.env, stdio: 'inherit' });
}

// ---------------------------------------------------------------------------------------------------------------------
// helpers shared with process.ts and markers.ts

/** The argument list of a constant PowerShell script (never built from config or transcript text): `-EncodedCommand`. */
export function powershellEncodedArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

/** First non-empty line of `text`, trimmed and clipped to `maxChars` code points (rule 9 for stderr in messages). */
export function firstLine(text: string, maxChars = 200): string {
  const line = text
    .split(/\r\n|\n|\r/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '');
  return Array.from(line ?? '')
    .slice(0, maxChars)
    .join('');
}

// ---------------------------------------------------------------------------------------------------------------------
// executable resolution (rule 3)

type Resolvable = 'git' | 'docker' | 'powershell' | 'ps' | 'taskkill' | 'icacls' | 'node' | 'opener';

export interface ResolverDeps {
  platform: HostPlatform;
  env(name: string): string | undefined;
  execPath: string;
  /** True when the file exists (Windows branches). */
  exists(file: string): Promise<boolean>;
  /** True when the file is executable (POSIX branches). */
  isExecutable(file: string): Promise<boolean>;
  /** A monotonic clock in ms. */
  now(): number;
}

const RESOLVE_TTL_MS = 10 * 60_000;
const RESOLVE_MISS_TTL_MS = 5 * 60_000;

/** Builds `resolveExecutable` over `deps`; results are cached for 10 minutes, misses for 5. */
export function createResolver(
  deps: ResolverDeps,
): (
  name: 'git' | 'docker' | 'powershell' | 'ps' | 'taskkill' | 'icacls' | 'node' | 'opener',
) => Promise<string | null> {
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  const exists = (file: string): Promise<boolean> => deps.exists(file);
  const isExecutable = (file: string): Promise<boolean> => deps.isExecutable(file);
  const cache = new Map<Resolvable, { value: string | null; at: number }>();

  const searchPath = async (file: string, test: (candidate: string) => Promise<boolean>): Promise<string | null> => {
    const raw = deps.env('PATH');
    if (raw === undefined) return null;
    for (const entry of raw.split(p.delimiter)) {
      const dir = entry
        .trim()
        .replace(/^"+|"+$/g, '')
        .trim();
      if (dir === '' || !p.isAbsolute(dir)) continue;
      const candidate = p.join(dir, file);
      if (await test(candidate)) return candidate;
    }
    return null;
  };

  const systemFile = async (...parts: string[]): Promise<string | null> => {
    const root = deps.env('SystemRoot') ?? deps.env('windir');
    if (root === undefined || root === '') return null;
    const file = p.join(root, ...parts);
    return (await exists(file)) ? file : null;
  };

  const findOnWindows = async (name: Resolvable): Promise<string | null> => {
    switch (name) {
      case 'powershell':
        return systemFile('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      case 'taskkill':
        return systemFile('System32', 'taskkill.exe');
      case 'icacls':
        return systemFile('System32', 'icacls.exe');
      case 'opener':
        return systemFile('explorer.exe');
      case 'git': {
        const found = await searchPath('git.exe', exists);
        if (found === null) return null;
        // The Git for Windows `cmd\git.exe` shim hides the real program (its CPU is not attributed, E16): use the real one.
        const shim = /^(.*)\\cmd\\git\.exe$/i.exec(found);
        if (shim?.[1] !== undefined) {
          const real = p.join(shim[1], 'mingw64', 'bin', 'git.exe');
          if (await exists(real)) return real;
        }
        return found;
      }
      case 'docker':
        return searchPath('docker.exe', exists);
      case 'ps':
      case 'node':
        return null;
    }
  };

  const findOnPosix = async (name: Resolvable): Promise<string | null> => {
    switch (name) {
      case 'git':
      case 'docker':
      case 'ps':
        return searchPath(name, isExecutable);
      case 'opener':
        if (deps.platform === 'darwin') return (await isExecutable('/usr/bin/open')) ? '/usr/bin/open' : null;
        return searchPath('xdg-open', isExecutable);
      case 'powershell':
      case 'taskkill':
      case 'icacls':
      case 'node':
        return null;
    }
  };

  return async (name) => {
    if (name === 'node') return deps.execPath;
    const now = deps.now();
    const hit = cache.get(name);
    if (hit !== undefined && now - hit.at < (hit.value === null ? RESOLVE_MISS_TTL_MS : RESOLVE_TTL_MS))
      return hit.value;
    const value = deps.platform === 'win32' ? await findOnWindows(name) : await findOnPosix(name);
    cache.set(name, { value, at: now });
    return value;
  };
}

const realResolver = createResolver({
  platform: hostPlatform,
  env: (name) => process.env[name],
  execPath: process.execPath,
  exists: (file) =>
    access(file).then(
      () => true,
      () => false,
    ),
  isExecutable: (file) =>
    access(file, fsConstants.X_OK).then(
      () => true,
      () => false,
    ),
  now: () => performance.now(),
});

/**
 * Absolute path of a program, or null. Windows: fixed `%SystemRoot%` paths for `powershell` (Windows PowerShell 5.1, never
 * pwsh 7), `taskkill`, `icacls`, `explorer.exe` as `opener`; `git` and `docker` from `PATH` (`.exe` only, relative entries
 * ignored, the Git shim swapped for `mingw64\bin\git.exe`). POSIX: the first executable on `PATH`; `opener` is
 * `/usr/bin/open` on macOS and `xdg-open` elsewhere. `node` is always `process.execPath`, never a `PATH` lookup.
 */
export function resolveExecutable(
  name: 'git' | 'docker' | 'powershell' | 'ps' | 'taskkill' | 'icacls' | 'node' | 'opener',
): Promise<string | null> {
  return realResolver(name);
}
