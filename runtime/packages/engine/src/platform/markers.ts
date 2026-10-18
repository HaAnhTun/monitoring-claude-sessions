// Runtime process markers (01 4.1, 4.2, registry C13). A process may be killed only after its command line proves
// that it is the runtime of the instance (ADR 0066: there is no other engine); the control channel answers first (ADR 0006), the
// command line is the fallback. `listRuntimeProcesses` is the one listing of runtime processes of an install: it spawns only
// through `execFileText` with a constant `-EncodedCommand` script and filters in Node (06 rule 8: no path is ever part of
// PowerShell text). The launcher `scripts/mcs.mjs` carries a zero-dependency copy of the listing (01 5.1) that must use
// the same record format (base64 command lines and an end marker, CR-WP-07-11).
import { readdir } from 'node:fs/promises';

import { McsError } from '@mcs/shared';

import { execFileText, firstLine, powershellEncodedArgs, resolveExecutable } from './exec.ts';
import type { ChildResult, ChildSpec } from './exec.ts';
import { readSmallFile } from './fsx.ts';
import { hostPlatform, pathsCaseInsensitive, type HostPlatform } from './host.ts';
import { BUNDLE_SERVER_FILE } from './layout.ts';
import { pathKey } from './paths.ts';

/** The server entry below a runtime folder of the source layout, with `/` separators (01 4.1). */
export const RUNTIME_ENTRY = '/packages/server/dist/main.js';
/** The server entry below a runtime folder of the bundle layout (ADR 0062 item 3). */
export const BUNDLE_SERVER_ENTRY = `/${BUNDLE_SERVER_FILE}`;
/** The two accepted server entry suffixes (lower case, `/` separators). */
export const RUNTIME_ENTRIES: readonly string[] = [RUNTIME_ENTRY, BUNDLE_SERVER_ENTRY];

const INSTANCE_TOKEN = '--mcs-instance=';
const DIR_TOKEN = '--instance-dir=';
const PID_RE = /^[1-9][0-9]{0,9}$/;
const LIST_TIMEOUT_MS = 20_000;
const LIST_MAX_OUTPUT_BYTES = 1_048_576;
/** One record of the listing: a process id, a tab and standard base64 (possibly empty: a process without a command line). */
const RECORD_RE = /^([1-9][0-9]{0,9})\t([A-Za-z0-9+/]*={0,2})$/;

/** The last line of the listing. A listing without it did not run to the end (a failed query, a cut output). */
export const LIST_RUNTIME_END = 'MCS-LIST-END';

/**
 * Every `node.exe` as one record per line: the process id, a tab, the command line as base64 of its UTF-8 bytes; then the
 * end marker. A command line may contain line breaks and tabs, so it never travels as text: an argument that holds a fake
 * `<pid><TAB><path>` row cannot become a record. `Stop`: a failing query ends the script with a non-zero exit code instead
 * of printing nothing. Constant: nothing is interpolated.
 */
export const LIST_RUNTIME_SCRIPT =
  "$ErrorActionPreference='Stop'; " +
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { '' + $_.ProcessId + [char]9 + " +
  '[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)) }; ' +
  `'${LIST_RUNTIME_END}'`;

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u000b' || ch === '\u000c';
}

/**
 * Splits a command line into arguments: whitespace separates, double quotes group (and disappear), single quotes are
 * ordinary characters. This is how Windows writes the command line of a process whose arguments Node quoted; backslash
 * escapes of quotes are not interpreted (the markers never contain quotes).
 */
export function splitCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let has = false;
  let quoted = false;
  for (const ch of commandLine) {
    if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && isWhitespace(ch)) {
      if (has) tokens.push(current);
      current = '';
      has = false;
    } else {
      current += ch;
      has = true;
    }
  }
  if (has) tokens.push(current);
  return tokens;
}

function normalize(text: string, caseInsensitive: boolean): string {
  const slashed = text.replaceAll('\\', '/');
  return caseInsensitive ? slashed.toLowerCase() : slashed;
}

/** True when `line` contains `entry` as a whole path ending (followed by the end, a blank or a quote). */
function containsOneEntry(line: string, entry: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf(entry, from);
    if (at < 0) return false;
    const after = line.charAt(at + entry.length);
    if (after === '' || isWhitespace(after) || after === '"') return true;
    from = at + 1;
  }
}

/** True when `line` contains one of the server entries (source or bundle layout) as a whole path ending. */
function containsEntry(line: string): boolean {
  return RUNTIME_ENTRIES.some((entry) => containsOneEntry(line, entry));
}

/**
 * The runtime marker of 01 4.1: the command line, with `\` read as `/`, contains a server entry
 * (`/packages/server/dist/main.js` or `/mcs-server.mjs`, ADR 0062) as a whole path ending and has `--mcs-instance=<instanceId>` as an argument of its own. `caseInsensitive` is
 * true on Windows (and macOS), where paths and the instance token compare without case.
 */
export function matchRuntimeMarker(commandLine: string, instanceId: string, caseInsensitive: boolean): boolean {
  if (commandLine === '' || instanceId === '') return false;
  if (!containsEntry(normalize(commandLine, caseInsensitive))) return false;
  const wanted = normalize(`${INSTANCE_TOKEN}${instanceId}`, caseInsensitive);
  return splitCommandLine(commandLine).some((token) => normalize(token, caseInsensitive) === wanted);
}

/** True when `commandLine` is the runtime server of `instanceId` (host case rule). */
export function hasRuntimeMarker(commandLine: string, instanceId: string): boolean {
  return matchRuntimeMarker(commandLine, instanceId, pathsCaseInsensitive);
}

/** The instance id and the instance directory a runtime command line carries (first occurrence wins). */
export function parseRuntimeCommandLine(commandLine: string): {
  instanceId: string | null;
  instanceDir: string | null;
} {
  const tokens = splitCommandLine(commandLine);
  const valueOf = (prefix: string): string | null => {
    const token = tokens.find((candidate) => candidate.startsWith(prefix));
    const value = token?.slice(prefix.length);
    return value === undefined || value === '' ? null : value;
  };
  return { instanceId: valueOf(INSTANCE_TOKEN), instanceDir: valueOf(DIR_TOKEN) };
}

export interface RuntimeProcess {
  pid: number;
  instanceId: string | null;
  instanceDir: string | null;
}

export interface ListerDeps {
  platform: HostPlatform;
  exec(spec: ChildSpec): Promise<ChildResult>;
  resolve(name: 'powershell' | 'ps'): Promise<string | null>;
  /** Linux: every process with its argument vector (from `/proc/<pid>/cmdline`). */
  scanProc(): Promise<{ pid: number; argv: string[] }[]>;
}

interface Row {
  pid: number;
  commandLine: string;
}

function quoteIfNeeded(argument: string): string {
  return /[\s"]/.test(argument) ? `"${argument.replaceAll('"', '')}"` : argument;
}

function failure(what: string, result: ChildResult | null, reason?: string): McsError {
  const detail =
    reason ??
    (result === null ? 'the program was not found' : firstLine(result.stderr) || (result.error ?? 'unknown error'));
  return new McsError('INTERNAL', `could not list runtime processes (${what}): ${detail}`);
}

async function rowsFromPowerShell(deps: ListerDeps): Promise<Row[]> {
  const file = await deps.resolve('powershell');
  if (file === null) throw failure('powershell', null);
  const result = await deps.exec({
    kind: 'powershell.cmdline',
    file,
    args: powershellEncodedArgs(LIST_RUNTIME_SCRIPT),
    timeoutMs: LIST_TIMEOUT_MS,
    maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
  });
  if (!result.ok) throw failure('powershell', result);
  const rows: Row[] = [];
  let ended = false;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line === LIST_RUNTIME_END) {
      ended = true;
      break;
    }
    // Only a line of the exact record shape counts; anything else (a host warning, a stray row) is ignored.
    const match = RECORD_RE.exec(line);
    const pidText = match?.[1];
    const encoded = match?.[2];
    if (pidText === undefined || encoded === undefined || encoded.length % 4 !== 0) continue;
    rows.push({ pid: Number(pidText), commandLine: Buffer.from(encoded, 'base64').toString('utf8') });
  }
  if (!ended) throw failure('powershell', result, 'the listing did not reach its end marker');
  return rows;
}

/**
 * macOS: `ps -axo pid=,command=` prints one text line per process, so this branch relies on `ps` writing a line break inside
 * an argument in escaped form (BSD `ps` shows control characters through `strvis`). UNVERIFIED: no macOS host was available,
 * and `ps` has no NUL-separated output. A process whose argument held a raw line break and a fake `<pid> <path>` line could
 * add a phantom row there. Windows (base64 records) and Linux (`/proc/<pid>/cmdline`, NUL separated) do not depend on it.
 */
async function rowsFromPs(deps: ListerDeps): Promise<Row[]> {
  const file = await deps.resolve('ps');
  if (file === null) throw failure('ps', null);
  const result = await deps.exec({
    kind: 'ps',
    file,
    args: ['-axo', 'pid=,command='],
    timeoutMs: LIST_TIMEOUT_MS,
    maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
  });
  if (!result.ok) throw failure('ps', result);
  const rows: Row[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*([0-9]+)\s+(.*)$/.exec(line);
    const pidText = match?.[1];
    if (pidText === undefined || !PID_RE.test(pidText)) continue;
    rows.push({ pid: Number(pidText), commandLine: match?.[2] ?? '' });
  }
  return rows;
}

/** The directory in front of a server entry (either layout) in one argument of the command line, or null. */
export function runtimeDirOf(commandLine: string, caseInsensitive: boolean = pathsCaseInsensitive): string | null {
  for (const token of splitCommandLine(commandLine)) {
    const slashed = normalize(token, caseInsensitive);
    const entry = RUNTIME_ENTRIES.find((candidate) => slashed.endsWith(candidate));
    if (entry !== undefined) {
      const dir = token.slice(0, token.length - entry.length);
      return dir === '' ? '/' : dir;
    }
  }
  return null;
}

/**
 * Builds `listRuntimeProcesses` over `deps`: the processes whose command line runs a server entry of `runtimeDir` (either
 * layout; `null`: of any folder, such as a previous plugin version directory), with the instance id and directory they were
 * started with. Callers match by instance id, never by folder alone. A listing that cannot run is an error, never an empty list
 * (the launcher uses it to refuse `npm ci` while runtimes hold native files open).
 */
export function createRuntimeLister(deps: ListerDeps): (runtimeDir: string | null) => Promise<RuntimeProcess[]> {
  return async (runtimeDir) => {
    let rows: Row[];
    if (deps.platform === 'win32') {
      rows = await rowsFromPowerShell(deps);
    } else if (deps.platform === 'linux') {
      rows = (await deps.scanProc()).map((entry) => ({
        pid: entry.pid,
        commandLine: entry.argv.map(quoteIfNeeded).join(' '),
      }));
    } else {
      rows = await rowsFromPs(deps);
    }
    const wanted = runtimeDir === null ? null : pathKey(runtimeDir);
    const found = new Map<number, RuntimeProcess>();
    for (const row of rows) {
      if (found.has(row.pid)) continue;
      const dir = runtimeDirOf(row.commandLine);
      if (dir === null || (wanted !== null && pathKey(dir) !== wanted)) continue;
      found.set(row.pid, { pid: row.pid, ...parseRuntimeCommandLine(row.commandLine) });
    }
    return [...found.values()];
  };
}

async function scanProcFs(): Promise<{ pid: number; argv: string[] }[]> {
  let names: string[];
  try {
    names = await readdir('/proc');
  } catch {
    return [];
  }
  const entries: { pid: number; argv: string[] }[] = [];
  for (const name of names) {
    if (!PID_RE.test(name)) continue;
    try {
      const raw = (await readSmallFile(`/proc/${name}/cmdline`, LIST_MAX_OUTPUT_BYTES)).toString('utf8');
      const argv = raw.split('\u0000');
      if (argv[argv.length - 1] === '') argv.pop();
      if (argv.length > 0) entries.push({ pid: Number(name), argv });
    } catch {
      // The process ended or is not ours to read.
    }
  }
  return entries;
}

const realLister = createRuntimeLister({
  platform: hostPlatform,
  exec: (spec) => execFileText(spec),
  resolve: (name) => resolveExecutable(name),
  scanProc: scanProcFs,
});

/**
 * The node processes that run the server of the runtime in `runtimeDir`, or of any runtime folder when `null` (Windows: one
 * CIM query, 0.3-0.5 s).
 */
export function listRuntimeProcesses(runtimeDir: string | null): Promise<RuntimeProcess[]> {
  return realLister(runtimeDir);
}
