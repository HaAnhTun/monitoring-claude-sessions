// The process list of macOS and the other POSIX systems (06 3.7.4): one `ps -A -o comm=,rss=` per refresh, parsed in Node.
// The macOS available memory comes from `vm_stat` (free + inactive + speculative pages), because `os.freemem()` counts free
// pages only and understates what is available. Both children go through `execFileText` with kind `ps`; `vm_stat` is spawned
// by its absolute path, so no executable search is involved. Linux does not use this module: it reads `/proc` (proc-linux.ts).
import path from 'node:path';

import { firstLine, type ChildResult } from '../platform/exec.ts';
import { SOURCE_MESSAGE_MAX_CHARS } from './constants.ts';
import type { MachineExec, ProcessEntry } from './machine.ts';
import type { SourceResult } from './source-cache.ts';

/** The listing is capped like the PowerShell output (06 3.7.3). */
export const PROC_LIST_MAX_BYTES = 2 * 1024 * 1024;

/** `vm_stat` is a fixed system tool of macOS. */
export const VM_STAT_PATH = '/usr/bin/vm_stat';
const VM_STAT_TIMEOUT_MS = 3000;
const VM_STAT_MAX_BYTES = 16 * 1024;
const MIN_PAGE_BYTES = 1024;
const MAX_PAGE_BYTES = 1024 * 1024;

/**
 * Turns a failed process-list child into a source result. `unavailableMessage` is used for a missing or blocked tool; the
 * other messages never carry arguments or output, only the first line of stderr (security rule 9).
 */
export function listFailure(done: ChildResult, unavailableMessage: string): SourceResult<never> {
  switch (done.error) {
    case 'ENOENT':
    case 'EACCES':
      return { status: 'unavailable', message: unavailableMessage };
    case 'TIMEOUT':
      return { status: 'error', message: 'the process list timed out' };
    case 'OUTPUT_LIMIT':
      return { status: 'error', message: 'the process list output is too large' };
    case 'QUEUE_FULL':
      return { status: 'error', message: 'too many child processes are running' };
    case 'ABORTED':
      return { status: 'error', message: 'the process list was cancelled' };
    case 'SPAWN_FAILED':
      return { status: 'error', message: 'the process list could not be started' };
    case 'NONZERO_EXIT':
    case null: {
      const line = firstLine(done.stderr, SOURCE_MESSAGE_MAX_CHARS);
      return {
        status: 'error',
        message: line === '' ? `the process list failed with exit code ${String(done.code)}` : line,
      };
    }
  }
}

/**
 * Parses `ps -A -o comm=,rss=`: the last token of a line is the resident size in KiB, everything before it is the command
 * (a path, possibly with spaces). The name is the base name of the command. A line without a numeric last token is ignored.
 * Linux cuts `comm` at 15 characters; `matchWatched` knows that.
 */
export function parsePsOutput(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const cut = Math.max(line.lastIndexOf(' '), line.lastIndexOf('\t'));
    if (cut <= 0) continue;
    const token = line.slice(cut + 1);
    if (!/^\d{1,15}$/.test(token)) continue;
    const name = path.posix.basename(line.slice(0, cut).trim());
    if (name === '') continue;
    entries.push({ name, workingSetBytes: Number(token) * 1024 });
  }
  return entries;
}

function pages(text: string, label: string): number | null {
  const match = new RegExp(`^Pages ${label}:\\s+(\\d{1,15})\\.?\\s*$`, 'mi').exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Available bytes from a `vm_stat` print: (free + inactive + speculative) pages at the page size of the header. Free and
 * inactive are required, speculative counts as zero when missing; anything else is `null`.
 */
export function parseVmStat(text: string): number | null {
  const size = /page size of (\d{1,9}) bytes/i.exec(text)?.[1];
  if (size === undefined) return null;
  const pageBytes = Number(size);
  if (pageBytes < MIN_PAGE_BYTES || pageBytes > MAX_PAGE_BYTES) return null;
  const free = pages(text, 'free');
  const inactive = pages(text, 'inactive');
  if (free === null || inactive === null) return null;
  return (free + inactive + (pages(text, 'speculative') ?? 0)) * pageBytes;
}

/** Runs `vm_stat`; `null` when it fails or prints something else (the caller falls back to `os.freemem()`). */
export async function readMacAvailableBytes(
  exec: Pick<MachineExec, 'execFileText'>,
  signal?: AbortSignal,
): Promise<number | null> {
  const done = await exec.execFileText(
    {
      kind: 'ps',
      file: VM_STAT_PATH,
      args: [],
      timeoutMs: VM_STAT_TIMEOUT_MS,
      maxOutputBytes: VM_STAT_MAX_BYTES,
      encoding: 'utf8',
    },
    signal,
  );
  return done.ok ? parseVmStat(done.stdout) : null;
}

export interface PosixListerDeps {
  exec: MachineExec;
  timeoutMs: number;
}

/** The loader of the process list on macOS and the other POSIX systems. */
export function createPosixLister(deps: PosixListerDeps): {
  load(signal: AbortSignal): Promise<SourceResult<ProcessEntry[]>>;
} {
  return {
    async load(signal) {
      const file = await deps.exec.resolveExecutable('ps');
      if (file === null)
        return { status: 'unavailable', message: 'ps is not available; per-process memory is disabled' };
      const done = await deps.exec.execFileText(
        {
          kind: 'ps',
          file,
          args: ['-A', '-o', 'comm=,rss='],
          timeoutMs: deps.timeoutMs,
          maxOutputBytes: PROC_LIST_MAX_BYTES,
          encoding: 'utf8',
        },
        signal,
      );
      if (!done.ok) return listFailure(done, 'ps is not available; per-process memory is disabled');
      const entries = parsePsOutput(done.stdout);
      return entries.length === 0
        ? { status: 'error', message: 'process list was empty' }
        : { status: 'ok', value: entries };
    },
  };
}
