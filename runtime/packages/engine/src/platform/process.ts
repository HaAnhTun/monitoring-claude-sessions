// Process liveness, command line and termination (06 4.2, ADR 0006, ADR 0051). Design 01 imports these functions; the
// marker check before a kill (`hasRuntimeMarker`) and `listRuntimeProcesses` are in markers.ts.
import { McsError } from '@mcs/shared';
import { setTimeout as sleepMs } from 'node:timers/promises';

import { execFileText, firstLine, powershellEncodedArgs, resolveExecutable } from './exec.ts';
import type { ChildResult, ChildSpec } from './exec.ts';
import { hostPlatform, type HostPlatform } from './host.ts';
import { readSmallFile } from './fsx.ts';

const PID_RE = /^[1-9][0-9]{0,9}$/;
const CMDLINE_TTL_MS = 5000;
const CMDLINE_CACHE_MAX = 64;
const CMDLINE_TIMEOUT_MS = 20_000;
const KILL_TIMEOUT_MS = 10_000;
const SMALL_OUTPUT_BYTES = 65_536;
/** `taskkill` exit code for "the process was not found": already gone, which is what the caller wanted. */
const TASKKILL_NOT_FOUND = 128;

/** A pid is a positive integer of at most ten digits: nothing else is ever passed to an operating system call. */
export function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && PID_RE.test(String(pid));
}

/** Everything the functions need from the outside world; tests pass scripted versions. */
export interface ProcessDeps {
  platform: HostPlatform;
  exec(spec: ChildSpec): Promise<ChildResult>;
  resolve(name: 'powershell' | 'taskkill' | 'ps'): Promise<string | null>;
  /** A monotonic clock in ms. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** `process.kill`: signal 0 probes, `SIGKILL` ends the process. */
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  /** The raw `/proc/<pid>/cmdline` text (NUL separated), or null when it cannot be read. */
  readCmdline(pid: number): Promise<string | null>;
}

export interface ProcessHelpers {
  pidAlive(pid: number): boolean;
  commandLineOf(pid: number): Promise<string | null>;
  forceKill(pid: number): Promise<void>;
  waitForExit(pid: number, timeoutMs: number, pollMs?: number): Promise<boolean>;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

function stopFailed(pid: number, why: string): McsError {
  return new McsError('STOP_FAILED', `could not terminate pid ${String(pid)}: ${why}`);
}

/** Builds the helpers over `deps`. The exports of this module are the instance over the real operating system. */
export function createProcessHelpers(deps: ProcessDeps): ProcessHelpers {
  const cache = new Map<number, { at: number; value: string }>();

  function pidAlive(pid: number): boolean {
    if (!isValidPid(pid)) return false;
    try {
      deps.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists but belongs to someone else. ESRCH and anything else: not there.
      return errorCode(error) === 'EPERM';
    }
  }

  function remember(pid: number, value: string): void {
    cache.delete(pid);
    cache.set(pid, { at: deps.now(), value });
    while (cache.size > CMDLINE_CACHE_MAX) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  }

  async function queryWindows(pid: number): Promise<string | null> {
    const file = await deps.resolve('powershell');
    if (file === null) return null;
    // A constant script around a validated integer: no string from config or transcripts is ever part of it.
    const script =
      "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}').CommandLine`;
    const result = await deps.exec({
      kind: 'powershell.cmdline',
      file,
      args: powershellEncodedArgs(script),
      timeoutMs: CMDLINE_TIMEOUT_MS,
      maxOutputBytes: SMALL_OUTPUT_BYTES,
      encoding: 'utf8',
    });
    if (!result.ok) return null;
    return result.stdout.replace(/\r?\n$/, '');
  }

  async function queryMac(pid: number): Promise<string | null> {
    const file = await deps.resolve('ps');
    if (file === null) return null;
    const result = await deps.exec({
      kind: 'ps',
      file,
      args: ['-o', 'command=', '-p', String(pid)],
      timeoutMs: CMDLINE_TIMEOUT_MS,
      maxOutputBytes: SMALL_OUTPUT_BYTES,
      encoding: 'utf8',
    });
    if (!result.ok) return null;
    return result.stdout.replace(/\r?\n$/, '');
  }

  async function commandLineOf(pid: number): Promise<string | null> {
    if (!isValidPid(pid)) return null;
    const hit = cache.get(pid);
    if (hit !== undefined && deps.now() - hit.at < CMDLINE_TTL_MS) return hit.value;
    let line: string | null;
    if (deps.platform === 'win32') {
      line = await queryWindows(pid);
    } else if (deps.platform === 'linux') {
      const raw = await deps.readCmdline(pid);
      line = raw === null ? null : raw.replaceAll('\u0000', ' ').trimEnd();
    } else {
      line = await queryMac(pid);
    }
    if (line === null || line === '') return null;
    remember(pid, line);
    return line;
  }

  async function forceKill(pid: number): Promise<void> {
    if (!isValidPid(pid)) throw new RangeError(`forceKill: ${String(pid)} is not a valid pid`);
    cache.delete(pid);
    if (deps.platform === 'win32') {
      const file = await deps.resolve('taskkill');
      if (file === null) throw stopFailed(pid, 'taskkill.exe was not found');
      const result = await deps.exec({
        kind: 'taskkill',
        file,
        args: ['/PID', String(pid), '/F'],
        timeoutMs: KILL_TIMEOUT_MS,
        maxOutputBytes: SMALL_OUTPUT_BYTES,
        encoding: 'utf8',
      });
      if (result.ok || result.code === TASKKILL_NOT_FOUND) return;
      const line = firstLine(result.stderr);
      throw stopFailed(pid, line !== '' ? line : (result.error ?? 'unknown error'));
    }
    try {
      deps.kill(pid, 'SIGKILL');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ESRCH') return;
      throw stopFailed(pid, code ?? 'unknown error');
    }
  }

  async function waitForExit(pid: number, timeoutMs: number, pollMs = 100): Promise<boolean> {
    const started = deps.now();
    for (;;) {
      if (!pidAlive(pid)) return true;
      const elapsed = deps.now() - started;
      if (elapsed >= timeoutMs) return false;
      await deps.sleep(Math.max(1, Math.min(pollMs, timeoutMs - elapsed)));
    }
  }

  return { pidAlive, commandLineOf, forceKill, waitForExit };
}

const real = createProcessHelpers({
  platform: hostPlatform,
  exec: (spec) => execFileText(spec),
  resolve: (name) => resolveExecutable(name),
  now: () => performance.now(),
  sleep: (ms) => sleepMs(ms),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  readCmdline: async (pid) => {
    try {
      return (await readSmallFile(`/proc/${String(pid)}/cmdline`, 1_048_576)).toString('utf8');
    } catch {
      return null;
    }
  },
});

/** True when the pid is alive. It never signals a live process (signal 0 is a probe); EPERM counts as alive. */
export function pidAlive(pid: number): boolean {
  return real.pidAlive(pid);
}

/** The command line of a process, or null when unknown (gone, access denied, lookup failed). Cached 5 s per pid. */
export function commandLineOf(pid: number): Promise<string | null> {
  return real.commandLineOf(pid);
}

/**
 * Ends a process at once: `taskkill.exe /PID <pid> /F` through `execFileText` on Windows (exit code 128, "not found", counts
 * as success), `SIGKILL` elsewhere (`ESRCH` ignored). Never throws for a pid that is already dead; other failures are an
 * `McsError` `STOP_FAILED`. Call `commandLineOf` and check the marker first (01 4.9).
 */
export function forceKill(pid: number): Promise<void> {
  return real.forceKill(pid);
}

/** Polls `pidAlive` every `pollMs` (default 100) until the process is gone (true) or `timeoutMs` has passed (false). */
export function waitForExit(pid: number, timeoutMs: number, pollMs?: number): Promise<boolean> {
  return real.waitForExit(pid, timeoutMs, pollMs);
}
