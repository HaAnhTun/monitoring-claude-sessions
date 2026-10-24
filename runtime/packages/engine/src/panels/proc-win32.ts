// The process list on Windows (06 3.7.3, ADR 0050): one hidden, one-shot PowerShell per refresh that prints
// `name<TAB>pid<TAB>WorkingSet64` for every process. The script is a constant passed with `-EncodedCommand`: no configuration
// value, no transcript text and no path ever enters it; the watched list is applied in Node afterwards. The .NET script is
// tried first; in Constrained Language Mode (static .NET calls and `[Console]` are blocked) the `Get-Process` script is used
// instead, for the life of the lister once it has listed processes where the .NET script listed none.
import { powershellEncodedArgs, type ChildResult } from '../platform/exec.ts';
import type { MachineExec, ProcessEntry } from './machine.ts';
import { listFailure, PROC_LIST_MAX_BYTES } from './proc-posix.ts';
import type { SourceResult } from './source-cache.ts';

/** `Process.GetProcesses()` printed as UTF-8 (the console encoding is switched first). */
export const PROC_SCRIPT_NET = [
  "$ErrorActionPreference = 'SilentlyContinue';",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
  'foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {',
  '[Console]::Out.Write($p.ProcessName + "`t" + $p.Id + "`t" + $p.WorkingSet64 + "`n")',
  '}',
].join(' ');

/** The fallback for Constrained Language Mode; its output is in the OEM code page and read as latin1 (names are ASCII). */
export const PROC_SCRIPT_CLM =
  'Get-Process | ForEach-Object { $_.ProcessName + "`t" + $_.Id + "`t" + $_.WorkingSet64 }';

const UNAVAILABLE = 'PowerShell is not available; per-process memory is disabled';
const EMPTY_LIST: SourceResult<never> = { status: 'error', message: 'process list was empty' };

/**
 * Parses the three tab separated columns: a line needs exactly three fields, a non-empty name and decimal digits for the
 * pid and the working set, otherwise it is ignored (a stray warning, a header, CLIXML).
 */
export function parseProcLines(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const fields = line.split('\t');
    if (fields.length !== 3) continue;
    const [name, pid, workingSet] = fields;
    if (name === undefined || name === '' || pid === undefined || workingSet === undefined) continue;
    if (!/^\d{1,10}$/.test(pid) || !/^\d{1,15}$/.test(workingSet)) continue;
    entries.push({ name, workingSetBytes: Number(workingSet) });
  }
  return entries;
}

export interface Win32ListerDeps {
  exec: MachineExec;
  timeoutMs: number;
}

export interface Win32Lister {
  load(signal: AbortSignal): Promise<SourceResult<ProcessEntry[]>>;
  /** The script in use: `clm` once PowerShell reported Constrained Language Mode. */
  mode(): 'net' | 'clm';
}

export function createWin32Lister(deps: Win32ListerDeps): Win32Lister {
  let mode: 'net' | 'clm' = 'net';

  function run(file: string, which: 'net' | 'clm', signal: AbortSignal): Promise<ChildResult> {
    return deps.exec.execFileText(
      {
        kind: 'powershell.processes',
        file,
        args: ['-NoLogo', ...powershellEncodedArgs(which === 'net' ? PROC_SCRIPT_NET : PROC_SCRIPT_CLM)],
        timeoutMs: deps.timeoutMs,
        maxOutputBytes: PROC_LIST_MAX_BYTES,
        encoding: which === 'net' ? 'utf8' : 'latin1',
      },
      signal,
    );
  }

  return {
    mode: () => mode,

    async load(signal) {
      const file = await deps.exec.resolveExecutable('powershell');
      if (file === null) return { status: 'unavailable', message: UNAVAILABLE };

      const first = await run(file, mode, signal);
      const entries = first.ok ? parseProcLines(first.stdout) : [];
      if (entries.length > 0) return { status: 'ok', value: entries };
      // PowerShell missing or blocked, a timeout, the output cap: the other script would fail the same way.
      if (first.error !== null && first.error !== 'NONZERO_EXIT') return listFailure(first, UNAVAILABLE);

      // Real PowerShell in Constrained Language Mode prints nothing to stderr for the .NET script (it sets
      // SilentlyContinue) and exits 1, so a run that listed nothing is the signal, with or without a stderr hint.
      // The Get-Process script is tried once and is latched only when it yields rows.
      if (mode === 'net') {
        const second = await run(file, 'clm', signal);
        const fallback = second.ok ? parseProcLines(second.stdout) : [];
        if (fallback.length > 0) {
          mode = 'clm';
          return { status: 'ok', value: fallback };
        }
        if (!second.ok) return listFailure(second, UNAVAILABLE);
        return EMPTY_LIST;
      }
      return first.ok ? EMPTY_LIST : listFailure(first, UNAVAILABLE);
    },
  };
}
