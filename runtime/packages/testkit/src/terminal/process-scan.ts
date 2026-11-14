// Finding processes by a marker in their command line (design 08, principle 8 and section 4.4): how a terminal test proves that
// no fake claude, shell or helper of its own run is left. No shell: PowerShell (CIM) on Windows, `ps` elsewhere, both started
// with an argument list.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A marker shorter than this can match the processes of other tests and of the owner: a short slug was the cause of the
 * `setup-selftest` flake. Use a per-test random value (a UUID in the command line of the process under test).
 */
export const MIN_MARKER_LENGTH = 12;

export interface FoundProcess {
  pid: number;
  name: string;
  commandLine: string;
}

const SCAN_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: SCAN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else
          reject(
            new Error(`findProcesses: the process listing failed (${String(error.code ?? error.signal ?? 'error')})`),
          );
      },
    );
  });
}

function powerShellPath(): string {
  const root = process.env['SystemRoot'];
  if (root !== undefined) {
    const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(full)) return full;
  }
  return 'powershell.exe';
}

/** The marker as a PowerShell single-quoted literal: only the quote needs a second quote. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rowOf(row: unknown): FoundProcess {
  if (typeof row === 'object' && row !== null) {
    const pid: unknown = Reflect.get(row, 'pid');
    const name: unknown = Reflect.get(row, 'name');
    const commandLine: unknown = Reflect.get(row, 'commandLine');
    if (typeof pid === 'number' && typeof name === 'string' && typeof commandLine === 'string') {
      return { pid, name, commandLine };
    }
  }
  throw new Error('findProcesses: the process listing has an unexpected shape');
}

async function scanWindows(marker: string): Promise<FoundProcess[]> {
  const script = [
    `$marker = ${psLiteral(marker)};`,
    '$found = @(Get-CimInstance -ClassName Win32_Process |',
    '  Where-Object { $_.CommandLine -and $_.ProcessId -ne $PID -and $_.CommandLine.Contains($marker) } |',
    '  ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine } });',
    'ConvertTo-Json -InputObject $found -Compress',
  ].join(' ');
  const out = await run(powerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
  const text = out.trim();
  if (text === '') return [];
  const parsed: unknown = JSON.parse(text);
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map(rowOf);
}

async function scanPs(marker: string): Promise<FoundProcess[]> {
  const out = await run('ps', ['-eo', 'pid=,comm=,args=']);
  const found: FoundProcess[] = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const commandLine = match[3] ?? '';
    if (!commandLine.includes(marker)) continue;
    const pid = Number.parseInt(match[1] ?? '', 10);
    if (pid === process.pid) continue;
    found.push({ pid, name: match[2] ?? '', commandLine });
  }
  return found;
}

/**
 * The processes whose command line contains `marker` (case-sensitive, literal). A marker of fewer than 12 characters is a
 * RangeError. The scan never reports itself. Names a process by pid and name; the command line may hold paths, so a test
 * prints the pids, not the lines.
 */
export function findProcesses(marker: string): Promise<FoundProcess[]> {
  if (marker.length < MIN_MARKER_LENGTH) {
    return Promise.reject(
      new RangeError(
        `findProcesses: the marker must be at least ${String(MIN_MARKER_LENGTH)} characters, got ${String(marker.length)}`,
      ),
    );
  }
  return process.platform === 'win32' ? scanWindows(marker) : scanPs(marker);
}
