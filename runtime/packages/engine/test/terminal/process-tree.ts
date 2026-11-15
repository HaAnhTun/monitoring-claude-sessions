// A read-only look at the process table, for the real-terminal suites (CAW-56): which console hosts (`conhost.exe` of the inbox
// ConPTY, `OpenConsole.exe` of the bundled conpty.dll) a process owns, and from which file they run. One constant CIM query per
// call, no command line is returned (a command line may hold a path), no process is started but the query itself.
//
// A pseudo console host is a child of the process that created the console (measured: the host process of the terminal service),
// so `consoleHostsOf(rows, owner)` takes the rows whose parent IS the owner. That also keeps the console host of the PowerShell
// query itself (a child of the PowerShell, not of the owner) out of every answer.
import { waitFor } from '@mcs/testkit';

import { execFileText, powershellEncodedArgs, resolveExecutable } from '../../src/platform/exec.ts';

/** The names (lower case) of a program that hosts a pseudo console. */
export const CONSOLE_HOST_NAMES: readonly string[] = ['conhost.exe', 'openconsole.exe'];

export interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  /** The file the process runs from; null when the system does not tell (a protected process). */
  readonly path: string | null;
}

const LIST_SCRIPT =
  "$ErrorActionPreference='SilentlyContinue'; " +
  '$rows = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object { ' +
  '[pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; ' +
  'name = [string]$_.Name; path = [string]$_.ExecutablePath } }); ' +
  'ConvertTo-Json -InputObject $rows -Compress';

const LIST_TIMEOUT_MS = 60_000;
const LIST_MAX_BYTES = 8 * 1024 * 1024;

function rowOf(value: unknown): ProcessRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const pid: unknown = Reflect.get(value, 'pid');
  const parentPid: unknown = Reflect.get(value, 'parentPid');
  const name: unknown = Reflect.get(value, 'name');
  const file: unknown = Reflect.get(value, 'path');
  if (typeof pid !== 'number' || typeof parentPid !== 'number' || typeof name !== 'string') return null;
  return { pid, parentPid, name, path: typeof file === 'string' && file !== '' ? file : null };
}

/** Every process of the machine: pid, parent, name and program file. Throws when the listing cannot be read. */
export async function listProcesses(): Promise<ProcessRow[]> {
  const powershell = await resolveExecutable('powershell');
  if (powershell === null) throw new Error('listProcesses: PowerShell was not found');
  const result = await execFileText({
    kind: 'powershell.cmdline',
    file: powershell,
    args: powershellEncodedArgs(LIST_SCRIPT),
    timeoutMs: LIST_TIMEOUT_MS,
    maxOutputBytes: LIST_MAX_BYTES,
    encoding: 'utf8',
  });
  if (!result.ok || result.truncated) {
    throw new Error(`listProcesses: the process listing failed (${result.error ?? 'unknown'})`);
  }
  const text = result.stdout.trim();
  if (text === '') return [];
  const parsed: unknown = JSON.parse(text);
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ProcessRow[] = [];
  for (const item of items) {
    const row = rowOf(item);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** The console hosts that are direct children of `owner`, ordered by pid. */
export function consoleHostsOf(rows: readonly ProcessRow[], owner: number): ProcessRow[] {
  return rows
    .filter((row) => row.parentPid === owner && CONSOLE_HOST_NAMES.includes(row.name.toLowerCase()))
    .sort((a, b) => a.pid - b.pid);
}

/** The console hosts below `owner` (default: this process) right now. */
export async function consoleHosts(owner: number = process.pid): Promise<ProcessRow[]> {
  return consoleHostsOf(await listProcesses(), owner);
}

/** The rows of `after` that are not in `before` (a new console host: the one of a session that was opened in between). */
export function addedHosts(before: readonly ProcessRow[], after: readonly ProcessRow[]): ProcessRow[] {
  const known = new Set(before.map((row) => row.pid));
  return after.filter((row) => !known.has(row.pid));
}

/**
 * True when no row of `hosts` is still a console host of the same name and pid in `rows`: a pid the system gave to another
 * program after the host ended does not count.
 */
export function noneOfThemRuns(rows: readonly ProcessRow[], hosts: readonly ProcessRow[]): boolean {
  return !hosts.some((host) => rows.some((row) => row.pid === host.pid && row.name === host.name));
}

/**
 * The files of the modules of process `pid` whose file name is `moduleName` (for example `conpty.dll`, which `conpty.node` loads into
 * the host from the folder it sits in). One constant script over an integer pid and a plain module name; empty when none is loaded.
 */
export async function loadedModulePaths(pid: number, moduleName: string): Promise<string[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('loadedModulePaths: not a pid');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(moduleName)) throw new RangeError('loadedModulePaths: not a module name');
  const powershell = await resolveExecutable('powershell');
  if (powershell === null) throw new Error('loadedModulePaths: PowerShell was not found');
  const script =
    `$ErrorActionPreference='SilentlyContinue'; ` +
    `$p = Get-Process -Id ${String(pid)}; ` +
    `if ($p) { $p.Modules | Where-Object { $_.ModuleName -eq '${moduleName}' } | ForEach-Object { $_.FileName } }`;
  const result = await execFileText({
    kind: 'powershell.cmdline',
    file: powershell,
    args: powershellEncodedArgs(script),
    timeoutMs: LIST_TIMEOUT_MS,
    maxOutputBytes: 65_536,
    encoding: 'utf8',
  });
  if (!result.ok) throw new Error(`loadedModulePaths: the module listing failed (${result.error ?? 'unknown'})`);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Waits until none of the console hosts of `added` runs any more and no host is left beyond `baseline` (a host of the same pid and name counts). */
export async function waitUntilHostsGone(
  baseline: readonly ProcessRow[],
  added: readonly ProcessRow[],
  timeoutMs: number,
  what = 'the console hosts of the ended sessions to end',
): Promise<void> {
  await waitFor(
    async () => {
      if (!noneOfThemRuns(await listProcesses(), added)) return false;
      return addedHosts(baseline, await consoleHosts()).length === 0;
    },
    { timeoutMs, intervalMs: 300, what },
  );
}
