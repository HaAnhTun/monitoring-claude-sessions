// The child registry and the orphan sweep (design 01 section 5). Defence in depth: measured, a hard-killed host takes its
// ConPTY children down within seconds, so the realistic leak is a detached descendant. Every owner process writes ONE file,
// `<mcsHome>/terminals/<ownerPid>-<ownerStartedAtMs>.json`, listing the pids of its pty roots with the time each was spawned;
// no two processes write the same file, so there are no write races. `sweep()` runs once at start and ends the roots that a
// dead owner left behind, but only a process that proves to be the recorded one: its creation time must fall in a window
// around the recorded spawn time (a reused pid has a later creation time and is left alone).
//
// Nothing here logs a pid, a name or a folder. The normal case (no stale file, or only dead pids) spawns no process.
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { Logger } from '../log/logger.ts';
import { SmallFileError, atomicWriteFile, readSmallFile, unlinkWithRetry } from '../platform/fsx.ts';
import { forceKillTree, isValidPid, pidAlive, processStartTimes } from '../platform/process.ts';
import type { ChildRegistry, SweepResult } from './types.ts';

/** The folder below the instance home that holds the files. */
export const REGISTRY_DIR = 'terminals';
/** A file larger than this is damaged or foreign: it is deleted unread. */
export const REGISTRY_FILE_MAX_BYTES = 65_536;
/** Children one owner may list; the service allows at most 64 sessions. */
export const REGISTRY_MAX_CHILDREN = 64;
/** A child is the recorded one when its creation time is in [spawned - 10 s, spawned + 2 s]: it is created before `started`. */
export const SPAWN_WINDOW_BEFORE_MS = 10_000;
export const SPAWN_WINDOW_AFTER_MS = 2000;
/** An owner is the recorded one when its creation time is within 5 s of the recorded start. */
export const OWNER_START_TOLERANCE_MS = 5000;

/** Only the warning of a failed write is logged, with the error code of the system and nothing else. */
export type RegistryLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

const PidSchema = z.number().int().refine(isValidPid);
const TimeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The content of a registry file. Strict: a key that is not listed makes the whole file invalid. */
export const RegistryFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  owner: z.strictObject({ pid: PidSchema, startedAtMs: TimeSchema }),
  children: z.array(z.strictObject({ pid: PidSchema, spawnedAtMs: TimeSchema })).max(REGISTRY_MAX_CHILDREN),
});
export type RegistryFile = z.infer<typeof RegistryFileSchema>;

/** `<ownerPid>-<ownerStartedAtMs>.json`. */
const FILE_NAME_RE = /^([1-9][0-9]{0,9})-([0-9]{1,16})\.json$/;

export function registryFileName(owner: { readonly pid: number; readonly startedAtMs: number }): string {
  return `${String(owner.pid)}-${String(owner.startedAtMs)}.json`;
}

/** What the registry needs from the operating system; tests pass scripted versions. */
export interface RegistryDeps {
  pidAlive(pid: number): boolean;
  /** Epoch ms of the creation of each live pid; null when it cannot be asked (`processStartTimes`). */
  processStartTimes(pids: readonly number[]): Promise<Map<number, number> | null>;
  /** `forceKillTree`: the one tree-kill implementation. */
  killTree(pid: number): Promise<void>;
  /** The atomic replace of a file (`atomicWriteFile`, mode 600: the file lists process ids). */
  writeFile(file: string, text: string): Promise<void>;
}

export interface ChildRegistryOptions {
  /** The instance home (`resolveMcsHome`). */
  readonly mcsHome: string;
  /** The process that writes: its pid and its creation time (`clock.now() - process.uptime() * 1000`). */
  readonly owner: { readonly pid: number; readonly startedAtMs: number };
  readonly logger?: RegistryLogger;
  readonly deps?: Partial<RegistryDeps>;
}

/** The registry the service holds, plus `flush()` for tests and for a caller that must know the file is current. */
export interface FlushableChildRegistry extends ChildRegistry {
  /** Resolves when every change made so far is on disk (or its write failed). Never rejects. */
  flush(): Promise<void>;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

/** The record of a file whose name and content agree, or null. */
function parseRecord(bytes: Buffer, match: RegExpExecArray): RegistryFile | null {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const parsed = RegistryFileSchema.safeParse(json);
  if (!parsed.success) return null;
  const { owner } = parsed.data;
  // The name is what the sweep trusts before it reads: a file whose content names another owner is not a file of ours.
  if (String(owner.pid) !== match[1] || String(owner.startedAtMs) !== match[2]) return null;
  return parsed.data;
}

/** What happened to one file of another owner: it is gone or removed, or it stays for the next sweep. */
interface FileOutcome {
  readonly kind: 'vanished' | 'removed' | 'kept';
  readonly killed: number;
}

/**
 * Builds the registry of one owner process. `add` and `remove` are synchronous and cheap: the file is rewritten by one writer
 * at a time, changes made meanwhile are coalesced, and a failed write is logged by its code and retried at the next change.
 * The file exists only while there is a child. `sweep()` never throws.
 */
export function createChildRegistry(options: ChildRegistryOptions): FlushableChildRegistry {
  const deps: RegistryDeps = {
    pidAlive,
    processStartTimes,
    killTree: forceKillTree,
    writeFile: (file, text) => atomicWriteFile(file, text, { mode: 0o600 }),
    ...options.deps,
  };
  const dir = path.join(options.mcsHome, REGISTRY_DIR);
  const ownName = registryFileName(options.owner);
  const ownFile = path.join(dir, ownName);
  const children = new Map<number, number>();
  let closed = false;
  let dirty = false;
  let running: Promise<void> | null = null;

  function warn(error: unknown): void {
    try {
      const code = errnoCode(error);
      options.logger?.warn('terminal.registry', { phase: 'write_failed', ...(code === undefined ? {} : { code }) });
    } catch {
      // A logging failure must not change anything.
    }
  }

  async function persist(): Promise<void> {
    if (children.size === 0) {
      await unlinkWithRetry(ownFile);
      return;
    }
    const file: RegistryFile = {
      schemaVersion: 1,
      owner: { pid: options.owner.pid, startedAtMs: options.owner.startedAtMs },
      children: [...children].map(([pid, spawnedAtMs]) => ({ pid, spawnedAtMs })),
    };
    await mkdir(dir, { recursive: true });
    await deps.writeFile(ownFile, `${JSON.stringify(file, null, 2)}\n`);
  }

  async function drain(): Promise<void> {
    try {
      while (dirty) {
        dirty = false;
        try {
          await persist();
        } catch (error) {
          warn(error);
        }
      }
    } finally {
      // No await between the last check of `dirty` and this line: a change cannot slip in and be lost.
      running = null;
    }
  }

  function schedule(): void {
    if (closed) return;
    dirty = true;
    running ??= drain();
  }

  async function flush(): Promise<void> {
    while (running !== null) await running;
  }

  function add(pid: number, spawnedAtMs: number): void {
    if (closed || !isValidPid(pid) || !Number.isSafeInteger(spawnedAtMs) || spawnedAtMs < 0) return;
    // A full file is never written over its limit: the sweep deletes a file that breaks the schema, and with it every record.
    if (!children.has(pid) && children.size >= REGISTRY_MAX_CHILDREN) return;
    children.set(pid, spawnedAtMs);
    schedule();
  }

  function remove(pid: number): void {
    if (closed || !children.delete(pid)) return;
    schedule();
  }

  async function close(): Promise<void> {
    closed = true;
    dirty = false;
    await flush();
    try {
      await unlinkWithRetry(ownFile);
    } catch (error) {
      warn(error);
    }
  }

  // ---- sweep -----------------------------------------------------------------------------------------------------------

  async function removeFile(file: string, killed: number): Promise<FileOutcome> {
    try {
      await unlinkWithRetry(file);
      return { kind: 'removed', killed };
    } catch {
      return { kind: 'kept', killed };
    }
  }

  async function startTimesOf(pids: readonly number[]): Promise<Map<number, number> | null> {
    try {
      return await deps.processStartTimes(pids);
    } catch {
      return null;
    }
  }

  async function sweepFile(file: string, match: RegExpExecArray): Promise<FileOutcome> {
    let bytes: Buffer;
    try {
      bytes = await readSmallFile(file, REGISTRY_FILE_MAX_BYTES);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return { kind: 'vanished', killed: 0 };
      if (error instanceof SmallFileError && error.code === 'E_FILE_TOO_LARGE') return removeFile(file, 0);
      return { kind: 'kept', killed: 0 };
    }
    const record = parseRecord(bytes, match);
    if (record === null) return removeFile(file, 0);

    // Another instance that is alive keeps its file. "Alive" needs proof: the pid may have been reused since.
    if (deps.pidAlive(record.owner.pid)) {
      const times = await startTimesOf([record.owner.pid]);
      if (times === null) return { kind: 'kept', killed: 0 };
      const start = times.get(record.owner.pid);
      if (start !== undefined && Math.abs(start - record.owner.startedAtMs) <= OWNER_START_TOLERANCE_MS) {
        return { kind: 'kept', killed: 0 };
      }
    }

    const living = record.children.filter((child) => deps.pidAlive(child.pid));
    if (living.length === 0) return removeFile(file, 0);
    const times = await startTimesOf(living.map((child) => child.pid));
    if (times === null) return { kind: 'kept', killed: 0 };
    let killed = 0;
    let failed = false;
    for (const child of living) {
      const created = times.get(child.pid);
      if (created === undefined) continue;
      if (created < child.spawnedAtMs - SPAWN_WINDOW_BEFORE_MS || created > child.spawnedAtMs + SPAWN_WINDOW_AFTER_MS) {
        continue;
      }
      try {
        await deps.killTree(child.pid);
        killed += 1;
      } catch {
        failed = true;
      }
    }
    // A child that could not be ended keeps the file: the next sweep tries again.
    return failed ? { kind: 'kept', killed } : removeFile(file, killed);
  }

  async function sweep(): Promise<SweepResult> {
    let files = 0;
    let killed = 0;
    let skipped = 0;
    try {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return { files, killed, skipped };
      }
      for (const name of names.sort()) {
        const match = FILE_NAME_RE.exec(name);
        if (match === null || name === ownName) continue;
        let outcome: FileOutcome;
        try {
          outcome = await sweepFile(path.join(dir, name), match);
        } catch {
          outcome = { kind: 'kept', killed: 0 };
        }
        if (outcome.kind === 'vanished') continue;
        files += 1;
        killed += outcome.killed;
        if (outcome.kind === 'kept') skipped += 1;
      }
    } catch {
      // The sweep is a safety net: whatever went wrong, the service starts.
    }
    return { files, killed, skipped };
  }

  return { add, remove, close, sweep, flush };
}
