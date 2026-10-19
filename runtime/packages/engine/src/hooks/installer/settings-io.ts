// The file side of the hooks installer (02 3.2, 3.5; ADR 0014, ADR 0070): where a scope's settings file is, the guard that keeps
// every test away from real settings, the seams for reading, writing, renaming and sleeping (so a test can inject a crash, a
// sharing violation or a concurrent change), and the backups of the files the installer replaces.
//
// Nothing here decides what a settings file should contain (that is `plan.ts`) or in which order the steps run (`apply.ts`).
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import { McsError } from '@mcs/shared';
import type { HooksScope } from '@mcs/shared';
import { normalizePath, routeKey, type EnvLike } from '@mcs/shared/protocol';

import { claudeHomeOf } from '../../ingest/transcripts/discovery.ts';
import { SmallFileError, atomicWriteFile, readSmallFile, unlinkWithRetry } from '../../platform/fsx.ts';
import { pathsCaseInsensitive } from '../../platform/host.ts';
import { pathKey } from '../../platform/paths.ts';
import { hooksFailed, type HooksOp } from './plan.ts';

/** A settings file larger than this is refused (real ones are a few KiB). */
export const SETTINGS_MAX_BYTES = 8 * 1024 * 1024;

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

// ---- text <-> bytes -------------------------------------------------------------------------------------------------------

/** The text of a settings file with the byte order mark kept as `U+FEFF`; a file that is not UTF-8 is refused. */
export function decodeSettings(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw hooksFailed('SETTINGS_INVALID_JSON', 'the settings file is not valid UTF-8 text; nothing was written', {
      cause: error,
    });
  }
}

export function encodeSettings(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

// ---- which file ---------------------------------------------------------------------------------------------------------

export interface SettingsPathInput {
  /** The directory that holds `.claude/` for the project-local scope. */
  readonly repoRoot?: string;
  readonly env: EnvLike;
}

/**
 * The settings file of a scope (02 3.2): `<repoRoot>/.claude/settings.local.json` for `project-local`,
 * `${CLAUDE_CONFIG_DIR or ~/.claude}/settings.json` for `user`. The shared `project` file is refused. The path is returned,
 * never opened.
 */
export function settingsPathFor(scope: string, input: SettingsPathInput): string {
  switch (scope) {
    case 'project-local': {
      if (input.repoRoot === undefined || input.repoRoot === '') {
        throw new McsError('USAGE', 'the project-local scope needs a repository folder', {
          hint: 'pass --repo <folder>, or use --settings-file <file>',
        });
      }
      return path.join(path.resolve(input.repoRoot), '.claude', 'settings.local.json');
    }
    case 'user':
      return path.join(claudeHomeOf(input.env), 'settings.json');
    case 'project':
      throw hooksFailed(
        'SCOPE_NOT_ALLOWED',
        'the project scope (.claude/settings.json) is a shared, committed file: hooks are never installed there',
        { hint: 'use the project-local scope (the default) or the user scope' },
      );
    default:
      throw hooksFailed('SCOPE_NOT_ALLOWED', `'${scope.slice(0, 40)}' is not a hooks scope`, {
        hint: 'use project-local or user, or pass --settings-file <file>',
      });
  }
}

/** The absolute spelling of a path, folded to lower case where the file system ignores case. No file is touched. */
function lexicalKey(file: string): string {
  const resolved = path.resolve(file);
  return pathsCaseInsensitive ? resolved.toLowerCase() : resolved;
}

function isBelow(key: string, root: string): boolean {
  return key.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * `scope: 'file'` names the file itself (`--settings-file`). The shared project file `<folder>/.claude/settings.json` is
 * refused there as well, unless it is the user's own settings file (the same file as the user scope).
 */
export function assertScopeAllowed(scope: HooksScope, settingsPath: string, env: EnvLike): void {
  if (scope !== 'file') return;
  const parent = path.basename(path.dirname(settingsPath));
  if (path.basename(settingsPath).toLowerCase() !== 'settings.json' || parent.toLowerCase() !== '.claude') return;
  if (lexicalKey(settingsPath) === lexicalKey(path.join(claudeHomeOf(env), 'settings.json'))) return;
  throw hooksFailed(
    'SCOPE_NOT_ALLOWED',
    'the file is a shared project settings file (.claude/settings.json): hooks are never installed there',
    { hint: 'use settings.local.json, or the user scope' },
  );
}

/** `~/<path>` when the file is inside the home folder, else the absolute path with forward slashes (02 3.5 step 12). */
export function displayPath(file: string, homeDir: string): string {
  const rel = path.relative(path.resolve(homeDir), path.resolve(file));
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  return inside ? `~/${normalizePath(rel)}` : normalizePath(path.resolve(file));
}

// ---- the test guard -------------------------------------------------------------------------------------------------------

/** Test mode: `MCS_TEST` is exactly `1`, or the process runs under Vitest (`VITEST` is set). */
export function isTestMode(env: EnvLike): boolean {
  const vitest = env['VITEST'];
  return env['MCS_TEST'] === '1' || (vitest !== undefined && vitest !== '');
}

export interface GuardTarget {
  /** Names the path in the message. */
  readonly label: string;
  readonly path: string;
}

export interface GuardInput {
  readonly env: EnvLike;
  readonly targets: readonly GuardTarget[];
  /** The folder every target must lie in (default `os.tmpdir()`). */
  readonly tmpdir?: () => string;
}

/**
 * ADR 0070 item 6: in test mode every settings target and the `MCS_HOME` folder must lie below the temporary folder, compared
 * as real paths on both sides (links followed, long names, case where the file system ignores it). Otherwise
 * `HOOKS_FAILED` `REAL_SETTINGS_IN_TEST`. A path that is outside the temporary folder by its spelling is refused without
 * touching the file system at all (a real settings file is never even looked at); only a path that is inside by its spelling is
 * resolved, to catch a link that leads out.
 */
export function assertNotRealInTest(input: GuardInput): void {
  if (!isTestMode(input.env)) return;
  const tmp = (input.tmpdir ?? (() => os.tmpdir()))();
  const realRoot = pathKey(tmp);
  // The spelling of the temporary folder as the system gives it (Windows may give a short 8.3 name) and its real path.
  const roots = [lexicalKey(tmp), realRoot];
  for (const target of input.targets) {
    if (!roots.some((root) => isBelow(lexicalKey(target.path), root)) || !isBelow(pathKey(target.path), realRoot)) {
      throw hooksFailed(
        'REAL_SETTINGS_IN_TEST',
        `refusing to use the ${target.label} ${normalizePath(target.path)} in test mode: it is outside the temporary folder`,
        { details: { settingsPath: normalizePath(target.path) } },
      );
    }
  }
}

// ---- reading and writing --------------------------------------------------------------------------------------------------

/** What the installer saw in the settings file at one moment. */
export interface SettingsSnapshot {
  /** The file that is read and replaced: the path itself, or the real file behind a link. */
  readonly target: string;
  /** `null` when the file does not exist. */
  readonly bytes: Buffer | null;
  readonly sha256: string | null;
  /** Permission bits of the file; `null` when it does not exist. */
  readonly mode: number | null;
}

/** The operations of an apply that touch the file system or the clock, one place for a test to inject a fault. */
export interface SettingsIo {
  read(file: string): Promise<SettingsSnapshot>;
  ensureDir(dir: string): Promise<void>;
  /** Creates `file` exclusively, writes all bytes, flushes them to disk and closes it. */
  writeTemp(file: string, bytes: Uint8Array, mode: number): Promise<void>;
  /** The bytes of a file, `null` when it is gone. */
  readBack(file: string): Promise<Buffer | null>;
  rename(from: string, to: string): Promise<void>;
  /** Best effort; a file that is not there is not an error. */
  remove(file: string): Promise<void>;
  /** Throws `SETTINGS_NOT_WRITABLE` when an existing file cannot be written. */
  checkWritable(file: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

function unreadable(file: string, why: string, cause?: unknown): McsError {
  return hooksFailed('SETTINGS_UNREADABLE', `cannot read the settings file: ${why}; nothing was written`, {
    details: { settingsPath: normalizePath(file) },
    ...(cause === undefined ? {} : { cause }),
  });
}

async function readSnapshot(file: string): Promise<SettingsSnapshot> {
  const absent: SettingsSnapshot = { target: file, bytes: null, sha256: null, mode: null };
  let target = file;
  try {
    let info = await lstat(file);
    if (info.isSymbolicLink()) {
      // The file behind a link is the one that is read and replaced; the link stays (a dotfile manager may own it).
      try {
        target = await realpath(file);
        info = await stat(target);
      } catch (error) {
        throw unreadable(file, 'the link does not lead to a file', error);
      }
    }
    if (!info.isFile()) throw unreadable(file, 'it is not a regular file');
    const bytes = await readSmallFile(target, SETTINGS_MAX_BYTES);
    return { target, bytes, sha256: sha256Hex(bytes), mode: info.mode & 0o777 };
  } catch (error) {
    if (error instanceof McsError) throw error;
    if (errorCode(error) === 'ENOENT') return absent;
    if (error instanceof SmallFileError && error.code === 'E_FILE_TOO_LARGE') {
      throw unreadable(file, 'it is larger than 8 MiB', error);
    }
    throw unreadable(file, errorCode(error) ?? 'the file could not be read', error);
  }
}

export const realSettingsIo: SettingsIo = {
  read: readSnapshot,
  ensureDir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeTemp: async (file, bytes, mode) => {
    const handle = await open(file, 'wx', mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  readBack: async (file) => {
    try {
      return await readSmallFile(file, SETTINGS_MAX_BYTES);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  },
  rename: (from, to) => rename(from, to),
  remove: async (file) => {
    try {
      await unlinkWithRetry(file, 1000);
    } catch {
      // A temporary file that cannot be removed now is a harmless dot file next to the settings.
    }
  },
  checkWritable: async (file) => {
    try {
      await access(file, constants.W_OK);
    } catch (error) {
      throw hooksFailed('SETTINGS_NOT_WRITABLE', 'the settings file is read-only; nothing was written', {
        details: { settingsPath: normalizePath(file) },
        hint: 'make the file writable, or pass another --settings-file',
        cause: error,
      });
    }
  },
  sleep: (ms) => sleepMs(ms),
};

/** `.<name>.mcs-<pid>-<random>.tmp` next to the target (02 3.5 step 6). */
export function tempPathFor(target: string): string {
  const suffix = `${String(process.pid)}-${randomBytes(3).toString('hex')}`;
  return path.join(path.dirname(target), `.${path.basename(target)}.mcs-${suffix}.tmp`);
}

/** Sharing violations of Windows while another program has the target open (02 3.5 step 9). */
const RENAME_BUSY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const RENAME_RETRIES = 10;
export const RENAME_RETRY_DELAY_MS = 50;

/** Renames `from` over `to`; a sharing violation is retried 10 times, 50 ms apart; any other failure, or the last one, is `RENAME_FAILED`. */
export async function renameWithRetry(io: SettingsIo, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await io.rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !RENAME_BUSY_CODES.has(code) || attempt >= RENAME_RETRIES) {
        throw hooksFailed(
          'RENAME_FAILED',
          `could not replace the settings file${code === undefined ? '' : ` (${code})`}`,
          {
            details: { settingsPath: normalizePath(to) },
            hint: 'another program holds the file open; close it and run the command again',
            cause: error,
          },
        );
      }
      await io.sleep(RENAME_RETRY_DELAY_MS);
    }
  }
}

// ---- backups --------------------------------------------------------------------------------------------------------------

/** Backups kept per settings file. */
export const BACKUPS_KEPT = 20;
const BACKUP_NAME = /^(\d{8}T\d{6}Z)-(?:install|uninstall)(?:-(\d+))?\.json$/;
const INDEX_FILE = 'index.jsonl';
const INDEX_MAX_BYTES = 1024 * 1024;

/** `$MCS_HOME/backups/settings/<first 8 hex of sha256 of the path>`. */
export function backupFolder(mcsHome: string, settingsPath: string): string {
  const key = routeKey(path.resolve(settingsPath));
  return path.join(mcsHome, 'backups', 'settings', sha256Hex(key).slice(0, 8));
}

/** `20261011T140507Z` */
function compactUtc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll('-', '')
    .replaceAll(':', '');
}

function backupOrder(name: string): [string, number] | null {
  const match = BACKUP_NAME.exec(name);
  return match?.[1] === undefined ? null : [match[1], match[2] === undefined ? 1 : Number(match[2])];
}

function byAge(a: string, b: string): number {
  const x = backupOrder(a);
  const y = backupOrder(b);
  if (x === null || y === null) return a < b ? -1 : a > b ? 1 : 0;
  return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1];
}

export interface BackupInput {
  readonly mcsHome: string;
  readonly settingsPath: string;
  readonly op: HooksOp;
  /** The bytes about to be replaced. */
  readonly bytes: Uint8Array;
  readonly nowMs: number;
  /** How many backups of this file to keep (default 20). */
  readonly keep?: number;
}

function backupFailed(settingsPath: string, cause: unknown): McsError {
  return hooksFailed('BACKUP_FAILED', 'could not write the backup of the settings file; nothing was changed', {
    details: { settingsPath: normalizePath(settingsPath) },
    cause,
  });
}

async function readIndexLines(file: string): Promise<string[]> {
  try {
    return (await readSmallFile(file, INDEX_MAX_BYTES))
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

function indexedBackup(line: string): string | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && 'backup' in parsed && typeof parsed.backup === 'string') {
      return parsed.backup;
    }
  } catch {
    // A damaged line is dropped at the next rewrite.
  }
  return null;
}

/**
 * Writes the original bytes of a settings file to `<MCS_HOME>/backups/settings/<sha8(path)>/<UTC time>-<op>.json` (mode 0600:
 * a settings file may hold tokens), records it in `index.jsonl` and keeps the newest `keep` backups of that file (02 3.5 step
 * 5). Two backups in one second get a number, so the order stays that of time. Returns the path of the new backup.
 */
export async function writeBackup(input: BackupInput): Promise<string> {
  const keep = input.keep ?? BACKUPS_KEPT;
  const dir = backupFolder(input.mcsHome, input.settingsPath);
  const stamp = compactUtc(input.nowMs);
  let created: string | null = null;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (let round = 0; round < 100 && created === null; round += 1) {
      const sameSecond = (await readdir(dir)).filter((name) => name.startsWith(`${stamp}-`)).length;
      const n = sameSecond + 1 + round;
      const name = n === 1 ? `${stamp}-${input.op}.json` : `${stamp}-${input.op}-${String(n)}.json`;
      try {
        const handle = await open(path.join(dir, name), 'wx', 0o600);
        try {
          await handle.writeFile(input.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        created = name;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
    }
  } catch (error) {
    throw backupFailed(input.settingsPath, error);
  }
  if (created === null) throw backupFailed(input.settingsPath, new Error('no free backup name'));

  // The bookkeeping (prune and index) is best effort: the backup itself is written.
  try {
    const names = (await readdir(dir)).filter((name) => BACKUP_NAME.test(name)).sort(byAge);
    for (const old of names.slice(0, Math.max(0, names.length - keep))) {
      await unlinkWithRetry(path.join(dir, old), 1000).catch(() => undefined);
    }
    const alive = new Set(names.slice(-keep));
    const line = JSON.stringify({
      path: normalizePath(path.resolve(input.settingsPath)),
      at: input.nowMs,
      op: input.op,
      sha256: sha256Hex(input.bytes),
      backup: created,
    });
    const lines = [...(await readIndexLines(path.join(dir, INDEX_FILE))), line].filter((entry) => {
      const backup = indexedBackup(entry);
      return backup !== null && alive.has(backup);
    });
    await atomicWriteFile(path.join(dir, INDEX_FILE), `${lines.slice(-keep).join('\n')}\n`, { mode: 0o600 });
  } catch {
    // see above
  }
  return path.join(dir, created);
}
