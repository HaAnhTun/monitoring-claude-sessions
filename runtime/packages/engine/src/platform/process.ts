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
/** One start-time query asks about at most this many pids (the registry holds at most 64 children). */
const START_QUERY_MAX_PIDS = 256;
/** The listing of the process tree is one row per process of the machine: a few KB, capped at 1 MiB. */
const TREE_OUTPUT_BYTES = 1_048_576;
/** Descendants returned at most: a bound against a corrupt listing. */
const TREE_MAX_DESCENDANTS = 4096;
/** The last line of a start-time or tree listing. A listing without it did not run to the end. */
const START_TIMES_END = 'MCS-START-END';
const TREE_END = 'MCS-TREE-END';
/** `<pid><TAB><ISO 8601 UTC with up to seven fraction digits, Z>` (the `o` format of .NET). */
const START_RECORD_RE = /^([1-9][0-9]{0,9})\t(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/;
/** `<pid><TAB><parent pid>`; the parent of the System Idle Process is 0. */
const TREE_RECORD_RE = /^([1-9][0-9]{0,9})\t([0-9]{1,10})$/;

/**
 * The start time of the processes `pids` as `<pid><TAB><ISO UTC>` lines, then the end marker. Only validated integers are
 * interpolated. A pid that does not exist is skipped (`SilentlyContinue`), so it has no row.
 */
function startTimesScript(pids: readonly number[]): string {
  return (
    "$ErrorActionPreference='SilentlyContinue'; " +
    `Get-Process -Id ${pids.join(',')} | ForEach-Object { '' + $_.Id + [char]9 + $_.StartTime.ToUniversalTime().ToString('o') }; ` +
    `'${START_TIMES_END}'`
  );
}

/** Every process as `<pid><TAB><parent pid>`, then the end marker; `Stop` makes a failing query a non-zero exit. Constant. */
const TREE_SCRIPT =
  "$ErrorActionPreference='Stop'; " +
  "Get-CimInstance Win32_Process | ForEach-Object { '' + $_.ProcessId + [char]9 + $_.ParentProcessId }; " +
  `'${TREE_END}'`;

/** The rows of a listing up to its end marker, or null when the marker never came (a failed query, a cut output). */
function rowsUntil(result: ChildResult, marker: string): string[] | null {
  if (!result.ok || result.truncated) return null;
  const rows: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line === marker) return rows;
    rows.push(line);
  }
  return null;
}

/** Epoch milliseconds of `2026-11-14T10:20:30` plus fraction digits; more than three digits are cut, never rounded. */
function startTimeMs(seconds: string, fraction: string | undefined): number {
  return Date.parse(`${seconds}.${(fraction ?? '').padEnd(3, '0').slice(0, 3)}Z`);
}

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
  /** `forceKill` for the process and everything it started (`taskkill /T`). The one tree kill of the engine. */
  forceKillTree(pid: number): Promise<void>;
  /**
   * The start time (epoch ms) of each live pid of `pids`; a pid that is gone, or whose start time cannot be read, has no
   * entry. Null when the question could not be answered (not Windows, query failed, listing cut, more than 256 pids). Never throws.
   */
  processStartTimes(pids: readonly number[]): Promise<Map<number, number> | null>;
  /** Every descendant of `root` (not `root` itself), ascending; null when the process table could not be listed. Never throws. */
  listDescendantPids(root: number): Promise<number[] | null>;
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

  async function terminate(pid: number, tree: boolean): Promise<void> {
    const name = tree ? 'forceKillTree' : 'forceKill';
    if (!isValidPid(pid)) throw new RangeError(`${name}: ${String(pid)} is not a valid pid`);
    cache.delete(pid);
    if (deps.platform === 'win32') {
      const file = await deps.resolve('taskkill');
      if (file === null) throw stopFailed(pid, 'taskkill.exe was not found');
      const result = await deps.exec({
        kind: 'taskkill',
        file,
        args: tree ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/F'],
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

  function forceKill(pid: number): Promise<void> {
    return terminate(pid, false);
  }

  /** POSIX: SIGKILL of the pid only; a process-group kill belongs with POSIX terminal support (design 01 section 6). */
  function forceKillTree(pid: number): Promise<void> {
    return terminate(pid, true);
  }

  async function processStartTimes(pids: readonly number[]): Promise<Map<number, number> | null> {
    const wanted = [...new Set(pids.filter((pid) => isValidPid(pid)))];
    if (wanted.length === 0) return new Map();
    if (wanted.length > START_QUERY_MAX_PIDS || deps.platform !== 'win32') return null;
    try {
      const file = await deps.resolve('powershell');
      if (file === null) return null;
      const result = await deps.exec({
        kind: 'powershell.processes',
        file,
        args: powershellEncodedArgs(startTimesScript(wanted)),
        timeoutMs: CMDLINE_TIMEOUT_MS,
        maxOutputBytes: SMALL_OUTPUT_BYTES,
        encoding: 'utf8',
      });
      const rows = rowsUntil(result, START_TIMES_END);
      if (rows === null) return null;
      const asked = new Set(wanted);
      const times = new Map<number, number>();
      for (const row of rows) {
        const match = START_RECORD_RE.exec(row);
        const pidText = match?.[1];
        const seconds = match?.[2];
        if (pidText === undefined || seconds === undefined) continue;
        const pid = Number(pidText);
        const at = startTimeMs(seconds, match?.[3]);
        if (asked.has(pid) && Number.isFinite(at)) times.set(pid, at);
      }
      return times;
    } catch {
      return null;
    }
  }

  async function listDescendantPids(root: number): Promise<number[] | null> {
    if (!isValidPid(root) || deps.platform !== 'win32') return null;
    try {
      const file = await deps.resolve('powershell');
      if (file === null) return null;
      const result = await deps.exec({
        kind: 'powershell.processes',
        file,
        args: powershellEncodedArgs(TREE_SCRIPT),
        timeoutMs: CMDLINE_TIMEOUT_MS,
        maxOutputBytes: TREE_OUTPUT_BYTES,
        encoding: 'utf8',
      });
      const rows = rowsUntil(result, TREE_END);
      if (rows === null) return null;
      const childrenOf = new Map<number, number[]>();
      for (const row of rows) {
        const match = TREE_RECORD_RE.exec(row);
        const pidText = match?.[1];
        const parentText = match?.[2];
        if (pidText === undefined || parentText === undefined) continue;
        const parent = Number(parentText);
        const siblings = childrenOf.get(parent);
        if (siblings === undefined) childrenOf.set(parent, [Number(pidText)]);
        else siblings.push(Number(pidText));
      }
      // Breadth first with a visited set: a parent id reused by the system can make the listing cyclic.
      const seen = new Set<number>([root]);
      const queue = [root];
      for (let at = 0; at < queue.length && seen.size <= TREE_MAX_DESCENDANTS; at += 1) {
        for (const child of childrenOf.get(queue[at] ?? 0) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          queue.push(child);
        }
      }
      return queue.slice(1).sort((a, b) => a - b);
    } catch {
      return null;
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

  return { pidAlive, commandLineOf, forceKill, forceKillTree, processStartTimes, listDescendantPids, waitForExit };
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

/**
 * `forceKill` for the whole tree: `taskkill.exe /PID <pid> /T /F` through `execFileText` (exit code 128, "not found", counts as
 * success), `SIGKILL` of the pid elsewhere. The one tree kill of the engine: the terminal sessions and the lifecycle
 * operations use it. Errors as `forceKill`; check the identity of the process first when the pid came from a file.
 */
export function forceKillTree(pid: number): Promise<void> {
  return real.forceKillTree(pid);
}

/**
 * The start time (epoch ms) of each live pid of `pids`, from one constant PowerShell query that is spawned only when at least
 * one valid pid is asked about. A pid that is gone has no entry. Null: the answer is unknown (not Windows, failed or cut query,
 * more than 256 pids). Never throws. The sweep of orphaned terminal children compares it with the recorded spawn time (pid reuse).
 */
export function processStartTimes(pids: readonly number[]): Promise<Map<number, number> | null> {
  return real.processStartTimes(pids);
}

/**
 * Every descendant of `root` (not `root`), ascending, computed in Node from one constant CIM listing of the machine; null when
 * the listing failed or the platform is not Windows. Never throws. A parent id reused by the system can add a stray row.
 */
export function listDescendantPids(root: number): Promise<number[] | null> {
  return real.listDescendantPids(root);
}

/** Polls `pidAlive` every `pollMs` (default 100) until the process is gone (true) or `timeoutMs` has passed (false). */
export function waitForExit(pid: number, timeoutMs: number, pollMs?: number): Promise<boolean> {
  return real.waitForExit(pid, timeoutMs, pollMs);
}
