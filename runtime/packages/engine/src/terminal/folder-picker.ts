// The folder picker (CAW-31, design 02 section 8, spec section 2 "+ Other folder..."): the Windows folder dialog that lets a person
// choose a working folder for a new terminal, behind `FolderPickerPort.pick(signal)`.
//   - The dialog is a PowerShell child (`-STA`, WinForms `FolderBrowserDialog`) that runs ONE constant script through
//     `-EncodedCommand`. No value is ever put into the script: not a path, a name, a title taken from a request or the environment.
//     The child is of kind `powershell.picker`, hidden, with a timeout (a dialog that nobody answers) and a small output cap.
//   - One dialog at a time: a second `pick` while one is open throws `picker_busy`; the flag is taken in the call itself, before any
//     await, so two calls of one tick cannot both pass.
//   - `signal` is the client leaving: the child runner ends the child and `pick` answers `null`.
//   - The answer is data from a child process and is checked like any other input: one line, a Windows drive path, no UNC or device
//     path, no control character, within the length of a Windows path (`windowsFolderPath`). A closed dialog (nothing printed) is
//     `null`. A refused answer is `folder_invalid` with the reason as the issue, never the text.
//   - A failed child (exit code, timeout, no PowerShell) is `terminal_unavailable`; what the child wrote is never read into a message.
//   - In test mode a hook replaces PowerShell by Node running the fake picker of the testkit (`folderPickerHook`, `test-hooks.ts`).
// Nothing here logs: a path is private to the person.
import { windowsFolderPath, folderPathIssue } from '@mcs/shared';

import { folderPickerHook } from '../runtime/test-hooks.ts';
import {
  execFileText,
  powershellEncodedArgs,
  resolveExecutable,
  type ChildResult,
  type ChildSpec,
} from '../platform/exec.ts';
import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import { TerminalApiError } from './host.ts';

/** The folder dialog as the terminal routes use it. */
export interface FolderPickerPort {
  /**
   * Waits for the person to choose a folder: its path, or `null` when the dialog was closed or `signal` aborted. A second concurrent
   * call throws a `TerminalApiError` of `picker_busy`.
   */
  pick(signal: AbortSignal): Promise<string | null>;
}

/** How long a dialog may stay open: a person chooses a folder in seconds, a dialog that stays for ten minutes is left over. */
export const PICKER_TIMEOUT_MS = 10 * 60_000;
/** The answer is one path (at most 240 characters): anything near this is not an answer. */
export const PICKER_OUTPUT_MAX_BYTES = 4096;

/**
 * The one script of the dialog. It loads the WinForms assembly (an existing one: nothing is compiled), opens the dialog in front of
 * the other windows and writes the chosen folder as UTF-8, with no byte order mark, on one line; a closed dialog writes nothing.
 * It is a constant: `pick` passes no value into it.
 */
export const PICKER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  '[System.Windows.Forms.Application]::EnableVisualStyles()',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.ShowNewFolderButton = $true',
  'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
  // the bytes go straight to the pipe: the code page of the hidden console is never consulted, and no byte order mark is written
  '  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($dialog.SelectedPath + "`n")',
  '  $stdout = [Console]::OpenStandardOutput()',
  '  $stdout.Write($bytes, 0, $bytes.Length)',
  '  $stdout.Flush()',
  '}',
  '$owner.Dispose()',
].join('\n');

// ---- the answer -----------------------------------------------------------------------------------------------------------------

export type PickedFolder =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'cancelled' }
  /** `issue` is one of `FOLDER_PATH_ISSUES` or `not_one_line`. */
  | { readonly kind: 'invalid'; readonly issue: string };

const BYTE_ORDER_MARK = '﻿';

/** Reads what the dialog printed: a normalised drive path, a cancel, or why the text is refused. Pure. */
export function parsePickedFolder(stdout: string): PickedFolder {
  const text = stdout.startsWith(BYTE_ORDER_MARK) ? stdout.slice(1) : stdout;
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim() !== '');
  const [line] = lines;
  if (line === undefined) return { kind: 'cancelled' };
  if (lines.length > 1) return { kind: 'invalid', issue: 'not_one_line' };
  // the dialog only ever answers a Windows path, so the Windows spelling is the one that is valid, on every host
  const path = windowsFolderPath(line, true);
  if (path === null) return { kind: 'invalid', issue: folderPathIssue(line, true) ?? 'relative' };
  return { kind: 'path', path };
}

// ---- the picker -----------------------------------------------------------------------------------------------------------------

export interface FolderPickerDeps {
  /** Runs the child. Default: `execFileText` (the one place that starts children). */
  readonly exec?: (spec: ChildSpec, signal?: AbortSignal) => Promise<ChildResult>;
  /** The path of Windows PowerShell, or null. Default: `resolveExecutable('powershell')`. */
  readonly resolvePowershell?: () => Promise<string | null>;
  /** Default: the host. */
  readonly platform?: HostPlatform;
  /** Only the test hook is read from it. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface Launch {
  readonly file: string;
  readonly args: readonly string[];
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * The folder picker of this host, or `null` where there is no dialog: Windows has one; elsewhere only the test hook gives one (the
 * fake picker of the testkit). A picker that cannot start its program is still a picker: `pick` then says `terminal_unavailable`.
 */
export function createFolderPicker(deps: FolderPickerDeps = {}): FolderPickerPort | null {
  const platform = deps.platform ?? hostPlatform;
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? execFileText;
  const resolvePowershell = deps.resolvePowershell ?? ((): Promise<string | null> => resolveExecutable('powershell'));
  const hook = folderPickerHook(env);
  if (hook === undefined && platform !== 'win32') return null;

  let open = false;

  async function launchOf(): Promise<Launch | null> {
    if (hook !== undefined) {
      return { file: process.execPath, args: [hook.script], extraEnv: hook.env };
    }
    const powershell = await resolvePowershell();
    return powershell === null ? null : { file: powershell, args: ['-STA', ...powershellEncodedArgs(PICKER_SCRIPT)] };
  }

  async function run(signal: AbortSignal): Promise<string | null> {
    const launch = await launchOf();
    if (launch === null) throw new TerminalApiError('terminal_unavailable');
    const result = await exec(
      {
        kind: 'powershell.picker',
        file: launch.file,
        args: launch.args,
        timeoutMs: PICKER_TIMEOUT_MS,
        maxOutputBytes: PICKER_OUTPUT_MAX_BYTES,
        encoding: 'utf8',
        ...(launch.extraEnv === undefined || Object.keys(launch.extraEnv).length === 0
          ? {}
          : { extraEnv: launch.extraEnv }),
      },
      signal,
    );
    // the client left: the child was ended and nobody waits for an answer
    if (result.error === 'ABORTED') return null;
    // an answer longer than the cap was cut: it is not a folder
    if (result.error === 'OUTPUT_LIMIT') {
      throw new TerminalApiError('folder_invalid', [{ path: 'path', issue: 'too_long' }]);
    }
    if (!result.ok) throw new TerminalApiError('terminal_unavailable');
    const picked = parsePickedFolder(result.stdout);
    if (picked.kind === 'invalid') {
      throw new TerminalApiError('folder_invalid', [{ path: 'path', issue: picked.issue }]);
    }
    return picked.kind === 'path' ? picked.path : null;
  }

  return {
    async pick(signal) {
      if (open) throw new TerminalApiError('picker_busy');
      if (signal.aborted) return null;
      open = true;
      try {
        return await run(signal);
      } finally {
        open = false;
      }
    },
  };
}
