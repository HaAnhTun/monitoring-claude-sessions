// The Claude registry as a fixture: `<claude home>/sessions/<pid>.json`, one small file per live Claude Code process, written,
// rewritten and removed while a test runs (the way a client does when it starts, changes its state, gets a new session id after
// `/clear` and exits). `buildClaudeHome` can also write entries, once, when it builds a home; this helper is for the tests that
// move the registry over time. The shape follows the survey of real entries (design 03, section 1); every default is invented.
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { CANARY } from './canary.ts';
import { FIXTURE_EPOCH_MS } from './clock.ts';

export interface RegistryEntryFixture {
  /** Process id: the file is named after it. */
  readonly pid: number;
  readonly sessionId: string;
  /** `busy`, `idle` or `waiting` for a client of today; any text is accepted so that a reader's loose status can be tested. Default `idle`. */
  readonly status?: string;
  readonly waitingFor?: string;
  /** Default `<claude home>/FIXTURE-cwd`. */
  readonly cwd?: string;
  /** Milliseconds since the epoch. Default `FIXTURE_EPOCH_MS`. */
  readonly startedAt?: number;
  /** Default `startedAt`. */
  readonly updatedAt?: number;
  /** Default `interactive`. */
  readonly kind?: string;
  /** Default `cli`. */
  readonly entrypoint?: string;
  /** Default `0.0.0-fixture`. */
  readonly version?: string;
  /** Further top-level fields of the file (`name`, `nameSource`, `procStart`, `pidDomain`, ...), written last. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface WriteRegistryOptions {
  /** Also write `<pid>.key` with the key canary: a reader must never open it. */
  readonly keyDecoy?: boolean;
  /** Modification time of the files written. Default: the time of the write. */
  readonly mtimeMs?: number;
}

export type RegistryPatch = Partial<Omit<RegistryEntryFixture, 'pid'>> & {
  /** Names of top-level fields to remove from the file. */
  readonly drop?: readonly string[];
};

function checkPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffff_ffff) {
    throw new RangeError(`registry fixture: pid must be a positive integer, got ${String(pid)}`);
  }
}

function touch(path: string, mtimeMs: number | undefined): void {
  if (mtimeMs === undefined) return;
  const at = new Date(mtimeMs);
  utimesSync(path, at, at);
}

/** `<claude home>/sessions`. */
export function registryDir(claudeHome: string): string {
  return join(claudeHome, 'sessions');
}

/** `<claude home>/sessions/<pid>.json`. */
export function registryFile(claudeHome: string, pid: number): string {
  checkPid(pid);
  return join(registryDir(claudeHome), `${String(pid)}.json`);
}

/** The object `writeRegistryEntry` writes: the defaults applied, the extra fields last. */
export function registryEntryJson(claudeHome: string, entry: RegistryEntryFixture): Record<string, unknown> {
  checkPid(entry.pid);
  const startedAt = entry.startedAt ?? FIXTURE_EPOCH_MS;
  return {
    pid: entry.pid,
    sessionId: entry.sessionId,
    cwd: entry.cwd ?? join(claudeHome, 'FIXTURE-cwd'),
    startedAt,
    version: entry.version ?? '0.0.0-fixture',
    kind: entry.kind ?? 'interactive',
    entrypoint: entry.entrypoint ?? 'cli',
    status: entry.status ?? 'idle',
    ...(entry.waitingFor === undefined ? {} : { waitingFor: entry.waitingFor }),
    updatedAt: entry.updatedAt ?? startedAt,
    ...entry.extra,
  };
}

function writeEntryFile(path: string, value: Record<string, unknown>, mtimeMs: number | undefined): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  touch(path, mtimeMs);
}

function writeDecoy(claudeHome: string, pid: number, mtimeMs: number | undefined): void {
  const file = join(registryDir(claudeHome), `${String(pid)}.key`);
  writeFileSync(file, CANARY.key);
  touch(file, mtimeMs);
}

/** Writes (or replaces) the entry of a process and returns the path of the file. */
export function writeRegistryEntry(
  claudeHome: string,
  entry: RegistryEntryFixture,
  options: WriteRegistryOptions = {},
): string {
  const value = registryEntryJson(claudeHome, entry);
  const path = registryFile(claudeHome, entry.pid);
  writeEntryFile(path, value, options.mtimeMs);
  if (options.keyDecoy === true) writeDecoy(claudeHome, entry.pid, options.mtimeMs);
  return path;
}

/**
 * Merges `patch` into the entry of `pid` and keeps every other field: a client rewrites its file when its state or its session id
 * changes. Throws when there is no entry or the file is not a JSON object.
 */
export function rewriteRegistryEntry(
  claudeHome: string,
  pid: number,
  patch: RegistryPatch,
  options: Pick<WriteRegistryOptions, 'mtimeMs'> = {},
): string {
  const path = registryFile(claudeHome, pid);
  if (!existsSync(path)) throw new Error(`rewriteRegistryEntry: no registry entry for pid ${String(pid)}`);
  const current: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    throw new Error(`rewriteRegistryEntry: the entry of pid ${String(pid)} is not a JSON object`);
  }
  const { drop, extra, ...fields } = patch;
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(fields)) merged[key] = value;
  Object.assign(merged, extra);
  for (const key of drop ?? []) Reflect.deleteProperty(merged, key);
  writeEntryFile(path, merged, options.mtimeMs);
  return path;
}

/** Removes the entry of `pid` and its key decoy; true when there was an entry. */
export function removeRegistryEntry(claudeHome: string, pid: number): boolean {
  const path = registryFile(claudeHome, pid);
  const existed = existsSync(path);
  rmSync(path, { force: true });
  rmSync(join(registryDir(claudeHome), `${String(pid)}.key`), { force: true });
  return existed;
}

/** Writes any bytes under any plain file name of the registry folder: a corrupt, an oversize or an oddly named file. */
export function writeRegistryFile(
  claudeHome: string,
  fileName: string,
  content: string | Uint8Array,
  options: Pick<WriteRegistryOptions, 'mtimeMs'> = {},
): string {
  if (
    fileName === '' ||
    fileName === '.' ||
    fileName === '..' ||
    basename(fileName) !== fileName ||
    /[\\/]/.test(fileName)
  ) {
    throw new RangeError(`writeRegistryFile: '${fileName}' is not a plain file name`);
  }
  const dir = registryDir(claudeHome);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, content);
  touch(path, options.mtimeMs);
  return path;
}
