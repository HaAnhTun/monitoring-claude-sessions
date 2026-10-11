// Isolation snapshots (01 3.5, 1.1): a sha256 over everything below a workspace except what a running instance changes by
// itself. Commands that write into one workspace take a snapshot of every other one before and after, and a difference is
// `ISOLATION_VIOLATION` (T-ISO-06). The legacy `snapshot()` hashes the database and the logs as well, so it reports a false
// violation whenever another instance is running (CHALLENGE C-2); this one leaves the runtime-mutable paths out.
//
// The hash is the one `snapshotTree` of `@mcs/testkit` computes (relative path, size and bytes of every file, folders and
// links by their own entry, links never followed, names in code unit order), so tests compare the two.
import { createHash, type Hash } from 'node:crypto';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import { McsError } from '@mcs/shared';

import { listWorkspaceSlugs } from './list.ts';

/**
 * Paths that a running instance changes on its own (01 1.1): the state file, `run/`, `data/` (database, spool, backups,
 * exports), `logs/` and temp files of atomic writes. Entries: an exact relative path, `<folder>/**` for a whole folder, or
 * `*<suffix>` for file names. Relative paths use `/`.
 */
export const RUNTIME_MUTABLE_PATHS: readonly string[] = ['state.json', 'run/**', 'data/**', 'logs/**', '*.tmp'];

/** True when `relative` (a `/` path below the workspace) matches one of `patterns` (default `RUNTIME_MUTABLE_PATHS`). */
export function isRuntimeMutable(relative: string, patterns: readonly string[] = RUNTIME_MUTABLE_PATHS): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return relative === prefix || relative.startsWith(`${prefix}/`);
    }
    if (pattern.startsWith('*')) return relative.slice(relative.lastIndexOf('/') + 1).endsWith(pattern.slice(1));
    return relative === pattern;
  });
}

export interface SnapshotOptions {
  /** Patterns of paths left out (default `RUNTIME_MUTABLE_PATHS`). */
  readonly exclude?: readonly string[];
}

const BUSY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const OPEN_RETRIES = 10;
const OPEN_RETRY_DELAY_MS = 20;
const CHUNK = 64 * 1024;

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

function invalid(message: string, cause?: unknown): McsError {
  return new McsError('WORKSPACE_INVALID', message, cause === undefined ? {} : { cause });
}

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function hashFile(hash: Hash, full: string, relative: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; handle === undefined; attempt += 1) {
    try {
      handle = await open(full, 'r');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return;
      if (code === undefined || !BUSY_CODES.has(code) || attempt >= OPEN_RETRIES) {
        throw invalid(`cannot read ${relative} for the isolation snapshot: ${code ?? 'error'}`, error);
      }
      await sleepMs(OPEN_RETRY_DELAY_MS);
    }
  }
  try {
    const { size } = await handle.stat();
    hash.update(`f\0${relative}\0${String(size)}\0`);
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (let position = 0; ;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

async function walk(hash: Hash, current: string, prefix: string, patterns: readonly string[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(current);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw invalid(`cannot list ${current} for the isolation snapshot: ${errorCode(error) ?? 'error'}`, error);
  }
  names.sort(byCodeUnits);
  for (const name of names) {
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    if (isRuntimeMutable(relative, patterns)) continue;
    const full = path.join(current, name);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(full);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw invalid(`cannot inspect ${relative} for the isolation snapshot: ${errorCode(error) ?? 'error'}`, error);
    }
    if (stats.isSymbolicLink()) {
      hash.update(`l\0${relative}\0${await readlink(full)}\0`);
    } else if (stats.isDirectory()) {
      hash.update(`d\0${relative}\0`);
      await walk(hash, full, relative, patterns);
    } else {
      await hashFile(hash, full, relative);
    }
  }
}

/** The snapshot of one workspace folder: a sha256 hex digest. A missing folder is `WORKSPACE_INVALID`. */
export async function snapshotWorkspace(dir: string, o: SnapshotOptions = {}): Promise<string> {
  const isFolder = await lstat(dir).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
  if (!isFolder) throw invalid(`cannot take a snapshot: ${dir} does not exist or is not a folder`);
  const hash = createHash('sha256');
  await walk(hash, dir, '', o.exclude ?? RUNTIME_MUTABLE_PATHS);
  return hash.digest('hex');
}

export interface SnapshotsOptions extends SnapshotOptions {
  /** A slug left out: the workspace the command writes to. */
  readonly except?: string;
}

/** Slug to snapshot of every workspace of `root` (see `listWorkspaceSlugs`), in slug order. An absent root has none. */
export async function snapshotWorkspaces(root: string, o: SnapshotsOptions = {}): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  for (const slug of await listWorkspaceSlugs(root)) {
    if (slug === o.except) continue;
    out.set(slug, await snapshotWorkspace(path.join(root, slug), o));
  }
  return out;
}

/** The slugs whose snapshot differs between `before` and `after`, or that exist in only one of them, sorted. */
export function changedWorkspaces(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const slugs = new Set([...before.keys(), ...after.keys()]);
  return [...slugs].filter((slug) => before.get(slug) !== after.get(slug)).sort(byCodeUnits);
}
