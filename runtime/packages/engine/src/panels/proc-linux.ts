// The process list on Linux (06 3.7.4): `/proc/<pid>/status` read in Node, no child process at all. That works on glibc and
// musl alike and avoids the BusyBox `ps`, whose options differ. `Name` is the kernel's `comm`, cut at 15 characters; a name
// of that length is widened from the first argument of `/proc/<pid>/cmdline` when that argument extends it. A kernel thread
// has no `VmRSS` line and is skipped; a pid that vanishes or cannot be read between the listing and the read is skipped too.
// File access goes through `ProcFs`, so tests inject a fake `/proc` tree and nothing here depends on the host.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { firstLine } from '../platform/exec.ts';
import { SOURCE_MESSAGE_MAX_CHARS } from './constants.ts';
import type { ProcessEntry } from './machine.ts';
import type { SourceResult } from './source-cache.ts';

export interface ProcFs {
  /** Entry names of a directory; rejects with the errno error when it cannot be listed. */
  readdir(dir: string): Promise<string[]>;
  /** UTF-8 text of a file; rejects with the errno error when it cannot be read. */
  readFile(file: string): Promise<string>;
}

export const realProcFs: ProcFs = {
  readdir: (dir) => readdir(dir),
  readFile: (file) => readFile(file, 'utf8'),
};

/** The kernel keeps 15 characters of a command name (TASK_COMM_LEN is 16 with the terminator). */
export const COMM_MAX_CHARS = 15;
/** Files read at the same time: a busy host lists thousands of pids and must not run out of descriptors. */
const READ_CONCURRENCY = 64;

export interface ProcStatus {
  name: string;
  /** `null` when the status has no `VmRSS` line (kernel threads, zombies). */
  rssBytes: number | null;
}

/** Reads `Name` and `VmRSS` (in kB) from the text of `/proc/<pid>/status`; `null` without a name. */
export function parseProcStatus(text: string): ProcStatus | null {
  let name: string | null = null;
  let rssBytes: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (name === null && line.startsWith('Name:')) {
      const value = line.slice('Name:'.length).trim();
      if (value !== '') name = value;
    } else if (rssBytes === null && line.startsWith('VmRSS:')) {
      const match = /^VmRSS:\s*(\d{1,15})\s*kB\s*$/i.exec(line);
      if (match?.[1] !== undefined) rssBytes = Number(match[1]) * 1024;
    }
  }
  return name === null ? null : { name, rssBytes };
}

/** The first argument of a NUL separated `cmdline`, as a base name; `null` when empty. */
function argv0Name(cmdline: string): string | null {
  const first = cmdline.split('\u0000', 1)[0] ?? '';
  const base = path.posix.basename(first.trim());
  return base === '' ? null : base;
}

/**
 * Every process with a resident size, as `{ name, workingSetBytes }`. Rejects only when `/proc` itself cannot be listed or
 * the signal aborts; a single process that cannot be read is left out.
 */
export async function readLinuxProcesses(fs: ProcFs, signal?: AbortSignal): Promise<ProcessEntry[]> {
  signal?.throwIfAborted();
  const names = await fs.readdir('/proc');
  const pids = names.filter((name) => /^[1-9]\d{0,9}$/.test(name));

  async function readOne(pid: string): Promise<ProcessEntry | null> {
    let status: ProcStatus | null;
    try {
      status = parseProcStatus(await fs.readFile(`/proc/${pid}/status`));
    } catch {
      return null;
    }
    const rssBytes = status?.rssBytes ?? null;
    if (status === null || rssBytes === null) return null;
    let name = status.name;
    if (name.length >= COMM_MAX_CHARS) {
      try {
        const wide = argv0Name(await fs.readFile(`/proc/${pid}/cmdline`));
        if (wide !== null && wide.length > name.length && wide.startsWith(name)) name = wide;
      } catch {
        // keep the truncated name: matchWatched knows the 15 character cut
      }
    }
    return { name, workingSetBytes: rssBytes };
  }

  const entries: ProcessEntry[] = [];
  for (let start = 0; start < pids.length; start += READ_CONCURRENCY) {
    signal?.throwIfAborted();
    const batch = await Promise.all(pids.slice(start, start + READ_CONCURRENCY).map(readOne));
    for (const entry of batch) if (entry !== null) entries.push(entry);
  }
  return entries;
}

export interface LinuxListerDeps {
  fs?: ProcFs;
}

function codeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

/** The loader of the process list on Linux. A missing or unreadable `/proc` is an unavailable source, not an error. */
export function createLinuxLister(deps: LinuxListerDeps = {}): {
  load(signal: AbortSignal): Promise<SourceResult<ProcessEntry[]>>;
} {
  const fs = deps.fs ?? realProcFs;
  return {
    async load(signal) {
      try {
        const entries = await readLinuxProcesses(fs, signal);
        return entries.length === 0
          ? { status: 'error', message: 'process list was empty' }
          : { status: 'ok', value: entries };
      } catch (error) {
        const code = codeOf(error);
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
          return { status: 'unavailable', message: '/proc is not available; per-process memory is disabled' };
        }
        if (signal.aborted) return { status: 'error', message: 'the process list was cancelled' };
        const line = error instanceof Error ? firstLine(error.message, SOURCE_MESSAGE_MAX_CHARS) : '';
        return { status: 'error', message: line === '' ? 'the process list could not be read' : line };
      }
    },
  };
}
