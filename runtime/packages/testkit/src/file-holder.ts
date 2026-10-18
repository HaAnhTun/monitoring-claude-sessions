// A real foreign holder of a file (06 4.3, E10, E23). On Windows a program that opens a file without FILE_SHARE_DELETE
// makes every rename of that file, and every rename onto it, fail with EPERM or EBUSY until it lets go. A Node holder is
// not enough for the rename of the file itself: Node opens with FILE_SHARE_DELETE, so the rename goes through. The holder
// is a PowerShell child (part of every Windows install) that opens the file with `FileShare.ReadWrite` and without `Delete`,
// the sharing a Python `open()` used: other programs may still read and append, but nobody may rename or delete it.
import { spawn } from 'node:child_process';

import { baseEnv } from './processes.ts';

export interface FileHolder {
  /** Closes the file by ending the holder, and resolves when the holder is gone. Safe to call twice. */
  stop(): Promise<void>;
}

/** Why `holdFileOpen` answers `null` on this platform, or `null` when it holds files here. */
export const FILE_HOLDER_SKIP_REASON: string | null =
  process.platform === 'win32' ? null : 'needs Windows: only its sharing modes make a held file refuse a rename';

// The arguments travel in HOLD_FILE and HOLD_MS, so no path is ever quoted into the script.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$f = [System.IO.File]::Open($env:HOLD_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)',
  "[Console]::Out.WriteLine('held')",
  '[Console]::Out.Flush()',
  'Start-Sleep -Milliseconds ([int]$env:HOLD_MS)',
  '$f.Close()',
].join('\n');

const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

/**
 * Opens `file` in another process with read sharing only, keeps it open for `holdMs` (or until `stop()`), and resolves once
 * the file is held. Answers `null` where the platform has no such sharing modes (`FILE_HOLDER_SKIP_REASON`).
 */
export async function holdFileOpen(file: string, holdMs: number): Promise<FileHolder | null> {
  if (FILE_HOLDER_SKIP_REASON !== null) return null;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED], {
    env: { ...baseEnv(), HOLD_FILE: file, HOLD_MS: String(Math.max(0, Math.round(holdMs))) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    child.once('error', () => {
      resolve();
    });
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  await new Promise<void>((resolve, reject) => {
    let seen = '';
    child.stdout.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8');
      if (seen.includes('held')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(
        new Error(`holdFileOpen: the holder exited (code ${String(code)}) before it held the file: ${stderr.trim()}`),
      );
    });
  });
  return {
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}
