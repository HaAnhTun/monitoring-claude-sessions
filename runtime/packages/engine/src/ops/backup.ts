// `ops.backup` (01 5.5, ADR 0009, ADR 0028): the backup folders of a workspace, `data/backups/<id>/` with `manifest.json`
// (`BackupManifestSchema`), the database copy (`monitor.db`) and reference copies of `instance.json`, `runtime.json`,
// `config.json` and `task.json`. A running instance copies its own database over the control channel (the server owns the only
// writer connection, D10); a stopped one is copied by the CLI through `backupDb`. A folder is built as `<id>.partial` and renamed
// when its manifest is written, so a folder without a manifest, or still named `.partial`, is incomplete: `list`, `restore`
// and the pruning never look at it, and neither at the manifest-less `pre-migrate-<stamp>` folders of `migrate-workspace` (ADR 0068).
//
// The restore (steps 1-7 of 01 5.5) refuses a running instance, verifies the manifest, the sha256 of every file and the
// instance id, makes and verifies a `pre-restore` backup, removes the stale `-wal` and `-shm`, and swaps the database in with
// the atomic rename (retried on Windows). `config.json`, `task.json` and the audit trail are never restored (user-owned).
import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleepMs } from 'node:timers/promises';

import {
  BACKUP_REASONS,
  BackupManifestSchema,
  InstanceFileSchema,
  McsError,
  RUNTIME_VERSION,
  isoSecondsZ,
  type BackupCreateResult,
  type BackupListResult,
  type BackupManifest,
  type BackupRestoreResult,
  type BackupRow,
  type InstanceFile,
} from '@mcs/shared';
import { controlTimeoutMs, type ControlRequest } from '@mcs/shared/protocol';

import { appendChange } from '../audit/writer.ts';
import { resolveConfig } from '../config/resolve.ts';
import { backupDb } from '../db/backup.ts';
import { isDbError } from '../db/errors.ts';
import { loadMigrationFiles, type MigrationsLocation } from '../db/migrations.ts';
import { fromPlain, toPlain, type JsonDoc } from '../json/index.ts';
import { layoutOfRuntimeDir } from '../platform/layout.ts';
import { AtomicWriteError, unlinkWithRetry } from '../platform/fsx.ts';
import { backupStamp } from '../migrate/backup.ts';
import { readInstanceFile, writeInstanceFile } from '../workspace/adopt.ts';
import {
  assertNotLink,
  isMissingFileError,
  readJsonFile,
  writeJsonFile,
  writeWorkspaceFile,
} from '../workspace/fsio.ts';
import { withTaskMutex, workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import {
  controlAddressOf,
  isLiveState,
  probeInstance,
  requestControl,
  type ControlAttempt,
  type ProbeOptions,
  type ProbeResult,
} from './probe.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

export type BackupReason = (typeof BACKUP_REASONS)[number];

/** What the backup operations need from the outside world; the defaults are the real probe, control client and rename. */
export interface BackupOpDeps {
  readonly probe?: (ws: WorkspaceRef, o?: ProbeOptions) => Promise<ProbeResult>;
  readonly control?: (address: string, message: ControlRequest, o: { timeoutMs: number }) => Promise<ControlAttempt>;
  /** The migration files the runtime ships (default: the folder of `ctx.runtimeDir`). */
  readonly migrations?: MigrationsLocation;
  /** The rename that swaps a restored database in and moves database files aside (default: `rename` with the Windows retry). */
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** How long a command waits for another command of the same task (default: `TASK_MUTEX_TIMEOUT_MS`). */
  readonly mutexTimeoutMs?: number;
}

// ---- names and small helpers --------------------------------------------------------------------------------------------------

const PARTIAL_SUFFIX = '.partial';
const MANIFEST_FILE = 'manifest.json';
const DB_FILE = 'monitor.db';
const DB_WAL = 'monitor.db-wal';
const DB_SHM = 'monitor.db-shm';
const DB_FILES = [DB_FILE, DB_WAL, DB_SHM] as const;
const REFERENCE_FILES = ['instance.json', 'runtime.json', 'config.json', 'task.json'] as const;
/** The only file names a manifest may list: nothing else is ever read, verified or restored. */
const ALLOWED_PATHS: ReadonlySet<string> = new Set<string>([...DB_FILES, ...REFERENCE_FILES]);
const BACKUP_ID_RE = new RegExp(`^[0-9]{8}T[0-9]{6}Z-(?:${BACKUP_REASONS.join('|')})(?:-[0-9]{1,3})?$`);
const RENAME_BUDGET_MS = 3000;
const RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const TOKEN_RE = /^[0-9a-f]{64}$/;
/** The newest `upgrade` and `db-rebuild` backups survive the pruning: they are the rollback points (ADR 0009). */
const PROTECTED_REASONS: readonly BackupReason[] = ['upgrade', 'db-rebuild'];

type ManifestFile = BackupManifest['files'][number];

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

function backupsDirOf(ws: Pick<WorkspaceRef, 'dir'>): string {
  return workspacePath(ws, 'data', 'backups');
}

/** `data/backups/<id>/`, the folder as the results and the audit trail name it. */
export function folderName(id: string): string {
  return `data/backups/${id}/`;
}

/** `lstat`, or `null` for a path that is not there. */
async function entryOf(file: string): Promise<Stats | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw new McsError('WORKSPACE_INVALID', `cannot inspect ${path.basename(file)}: ${errorCode(error) ?? 'error'}`, {
      cause: error,
    });
  }
}

const DIGEST_CHUNK_BYTES = 256 * 1024;

/** The size and sha256 of a file, read once in chunks. */
async function digestOf(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, DIGEST_CHUNK_BYTES, bytes);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/** `rename` that waits out the sharing violations Windows reports while an indexer or scanner holds a file (01 1.2). */
export async function renameWithRetry(from: string, to: string, budgetMs: number = RENAME_BUDGET_MS): Promise<void> {
  const started = performance.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !RETRY_CODES.has(code) || performance.now() - started >= budgetMs) {
        throw new McsError('WORKSPACE_INVALID', `cannot move ${path.basename(from)}: ${code ?? 'error'}`, {
          cause: error,
        });
      }
      await sleepMs(Math.min(50 * 2 ** Math.min(attempt, 10), 250));
    }
  }
}

/** Deletes a file (retrying sharing violations); a file that is not there is fine. */
export async function removeFile(file: string): Promise<void> {
  try {
    await unlinkWithRetry(file);
  } catch (error) {
    if (error instanceof AtomicWriteError) {
      throw new McsError('WORKSPACE_INVALID', `cannot delete ${path.basename(file)}: ${error.code}`, { cause: error });
    }
    throw error;
  }
}

/** `1.2 MiB`: the size as a person reads it. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'TiB'}`;
}

/** The `migrations/` folder of the runtime folder the command runs for; the engine's own when that folder is not a runtime. */
export function migrationsOf(
  ctx: Pick<OpContext, 'runtimeDir'>,
  deps: { readonly migrations?: MigrationsLocation },
): MigrationsLocation {
  if (deps.migrations !== undefined) return deps.migrations;
  try {
    return { migrationsDir: pathToFileURL(layoutOfRuntimeDir(ctx.runtimeDir).migrationsDir + path.sep) };
  } catch {
    return {};
  }
}

/** The highest migration version the runtime ships. */
export function latestSchemaVersion(location: MigrationsLocation): number {
  try {
    return loadMigrationFiles(location.migrationsDir).at(-1)?.version ?? 0;
  } catch (error) {
    throw dbFailure(error);
  }
}

/** A database error as the command-line error the person sees; anything else is returned as it is. */
export function dbFailure(error: unknown): unknown {
  if (!isDbError(error)) return error;
  const { code } = error;
  if (code === 'db_newer_than_runtime' || code === 'migration_unknown') {
    return new McsError('DB_NEWER_THAN_RUNTIME', error.message, {
      hint: 'use a runtime that is at least as new as the one that wrote the database',
      cause: error,
    });
  }
  if (code === 'db_migration_required') {
    return new McsError('DB_UPGRADE_REQUIRED', error.message, { hint: 'run `mcs upgrade`', cause: error });
  }
  if (code === 'db_identity_mismatch') {
    return new McsError('IDENTITY_MISMATCH', error.message, { hint: 'run `mcs instances repair`', cause: error });
  }
  return new McsError('DB_ERROR', error.message, { cause: error });
}

/** `instance.json` of the workspace, or `INSTANCE_NOT_INITIALIZED` with the hint for a workspace from before 4.0. */
export async function requireInstance(ws: WorkspaceRef): Promise<InstanceFile> {
  const instance = await readInstanceFile(ws);
  if (instance === null) {
    throw new McsError('INSTANCE_NOT_INITIALIZED', `task '${ws.slug}' has no instance.json; nothing was changed`, {
      hint: `a workspace from before 4.0 is converted by \`mcs migrate-workspace --task ${ws.slug}\` (a dry run first)`,
    });
  }
  return instance;
}

// ---- a running or foreign monitor ----------------------------------------------------------------------------------------------

/** The refusal for a workspace whose monitor is alive: ours is stopped first, one this runtime did not start is left alone. */
export function liveError(
  ws: Pick<WorkspaceRef, 'slug'>,
  probe: Pick<ProbeResult, 'state' | 'pid' | 'url'>,
  canRestart = false,
): McsError {
  const details = { state: probe.state, pid: probe.pid, url: probe.url };
  if (probe.state === 'unmanaged-running') {
    return new McsError(
      'INSTANCE_RUNNING',
      `a monitor that was not started by this runtime runs '${ws.slug}'; it is left alone and nothing was changed`,
      { hint: 'stop it with the tool that started it, then run this command again', details },
    );
  }
  return new McsError('INSTANCE_RUNNING', `a monitor runs '${ws.slug}' (${probe.state}); nothing was changed`, {
    hint: `stop it first with \`mcs stop --task ${ws.slug}\`${canRestart ? ', or pass --restart' : ''}`,
    details,
  });
}

/** The probe of the instance (01 4.8) with the control timeouts of an operation that is about to change data. */
export function probeOf(
  ctx: Pick<OpContext, 'runtimeDir'>,
  ws: WorkspaceRef,
  deps: Pick<BackupOpDeps, 'probe'>,
): Promise<ProbeResult> {
  return (deps.probe ?? probeInstance)(ws, { runtimeDir: ctx.runtimeDir });
}

/** Throws `INSTANCE_RUNNING` unless the instance is stopped (or a stale or foreign state file is all that is left). */
export async function assertNotLive(
  ctx: Pick<OpContext, 'runtimeDir'>,
  ws: WorkspaceRef,
  deps: Pick<BackupOpDeps, 'probe'>,
): Promise<void> {
  const probe = await probeOf(ctx, ws, deps);
  if (isLiveState(probe.state)) throw liveError(ws, probe);
}

// ---- reading a backup ---------------------------------------------------------------------------------------------------------

type ManifestRead =
  { readonly ok: true; readonly manifest: BackupManifest } | { readonly ok: false; readonly problem: string };

/** The manifest of a backup folder: schema-valid, naming its own folder, listing only the files of `ALLOWED_PATHS` once each. */
async function readManifest(dir: string, id: string): Promise<ManifestRead> {
  let doc: JsonDoc;
  try {
    doc = (await readJsonFile(path.join(dir, MANIFEST_FILE))).value;
  } catch (error) {
    if (error instanceof McsError && isMissingFileError(error.cause)) {
      return { ok: false, problem: 'manifest.json is missing' };
    }
    return { ok: false, problem: 'manifest.json is not valid JSON' };
  }
  let plain: unknown;
  try {
    plain = toPlain(doc);
  } catch {
    return { ok: false, problem: 'manifest.json holds an integer beyond 2^53-1' };
  }
  const parsed = BackupManifestSchema.safeParse(plain);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? 'the document' : issue.path.map(String).join('.');
    return { ok: false, problem: `manifest.json is invalid (${where})` };
  }
  const manifest = parsed.data;
  if (manifest.backupId !== id) return { ok: false, problem: 'manifest.json names another backup' };
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!ALLOWED_PATHS.has(file.path)) return { ok: false, problem: 'manifest.json lists a file that is not allowed' };
    if (seen.has(file.path)) return { ok: false, problem: 'manifest.json lists a file twice' };
    seen.add(file.path);
  }
  return { ok: true, manifest };
}

export interface ListedBackup {
  readonly id: string;
  /** Absolute path of the folder. */
  readonly dir: string;
  readonly manifest: BackupManifest;
}

/**
 * The backups of a workspace, newest first: only folders that carry a final name and a valid manifest. `.partial` folders,
 * the `pre-migrate-<stamp>` folders of `migrate-workspace`, `orphaned-<stamp>` and anything else are not backups of this kind
 * and are skipped.
 */
export async function listBackups(ws: WorkspaceRef): Promise<ListedBackup[]> {
  let names: string[];
  try {
    names = await readdir(backupsDirOf(ws));
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new McsError('WORKSPACE_INVALID', 'cannot list data/backups', { cause: error });
  }
  const found: ListedBackup[] = [];
  for (const id of names) {
    if (!BACKUP_ID_RE.test(id)) continue;
    const dir = path.join(backupsDirOf(ws), id);
    if ((await entryOf(dir))?.isDirectory() !== true) continue;
    const read = await readManifest(dir, id);
    if (read.ok) found.push({ id, dir, manifest: read.manifest });
  }
  // newest first; both keys are ASCII, so code unit order is the order (never the locale's)
  return found.sort((a, b) => {
    if (a.manifest.createdAt !== b.manifest.createdAt) return a.manifest.createdAt < b.manifest.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** Re-reads every file the manifest lists: what is missing, not a regular file, of another size or of another sha256. */
export async function verifyBackup(dir: string, manifest: BackupManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const file of manifest.files) {
    const full = path.join(dir, file.path);
    const entry = await entryOf(full);
    if (entry === null) {
      problems.push(`${file.path} is missing`);
    } else if (!entry.isFile()) {
      problems.push(`${file.path} is not a regular file`);
    } else {
      const actual = await digestOf(full);
      if (actual.bytes !== file.bytes) {
        problems.push(`${file.path} has ${String(actual.bytes)} bytes, the manifest says ${String(file.bytes)}`);
      } else if (actual.sha256 !== file.sha256) {
        problems.push(`${file.path} does not match the sha256 of the manifest`);
      }
    }
  }
  return problems;
}

/** One backup by id: `BACKUP_NOT_FOUND` for a name that is no backup id or a folder that is not there, `BACKUP_INVALID` for a damaged manifest. */
async function loadBackup(ws: WorkspaceRef, id: string): Promise<ListedBackup> {
  const notFound = new McsError('BACKUP_NOT_FOUND', `there is no backup '${id}' for task '${ws.slug}'`, {
    hint: `mcs backup list --task ${ws.slug}`,
  });
  if (!BACKUP_ID_RE.test(id)) throw notFound;
  const dir = path.join(backupsDirOf(ws), id);
  assertNotLink(dir);
  if ((await entryOf(dir))?.isDirectory() !== true) throw notFound;
  const read = await readManifest(dir, id);
  if (!read.ok) {
    throw new McsError('BACKUP_INVALID', `backup ${id} cannot be used: ${read.problem}`, {
      hint: `mcs backup list --task ${ws.slug} --verify`,
    });
  }
  return { id, dir, manifest: read.manifest };
}

// ---- making a backup ----------------------------------------------------------------------------------------------------------------

interface Staging {
  readonly id: string;
  readonly partial: string;
  readonly final: string;
}

/** Creates `data/backups/<id>.partial/` with the first free id of `<UTC stamp>-<reason>[-n]`. */
async function stage(ws: WorkspaceRef, reason: BackupReason, nowMs: number): Promise<Staging> {
  assertNotLink(workspacePath(ws, 'data'));
  const backups = backupsDirOf(ws);
  assertNotLink(backups);
  await mkdir(backups, { recursive: true });
  const stamp = backupStamp(nowMs);
  for (let n = 1; n < 100; n += 1) {
    const id = `${stamp}-${reason}${n === 1 ? '' : `-${String(n)}`}`;
    const final = path.join(backups, id);
    if ((await entryOf(final)) !== null) continue;
    const partial = `${final}${PARTIAL_SUFFIX}`;
    try {
      await mkdir(partial);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue;
      throw new McsError('WORKSPACE_INVALID', `cannot create a backup folder: ${errorCode(error) ?? 'error'}`, {
        cause: error,
      });
    }
    return { id, partial, final };
  }
  throw new McsError('INTERNAL', 'cannot find a free backup id');
}

async function discard(staging: Staging): Promise<void> {
  await rm(staging.partial, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
}

/** The control token of `run/control.token` (64 hex digits), or `null`. Used for the one request to the instance's own server. */
export async function controlTokenOf(ws: WorkspaceRef): Promise<string | null> {
  const file = workspacePath(ws, 'run', 'control.token');
  try {
    assertNotLink(file);
    const text = (await readFile(file, 'utf8')).trim();
    return TOKEN_RE.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** The copy of `instance.json`, `runtime.json`, `config.json` and `task.json`, each read back from the backup and compared. */
async function copyReferenceFiles(ws: WorkspaceRef, partial: string): Promise<ManifestFile[]> {
  const out: ManifestFile[] = [];
  for (const name of REFERENCE_FILES) {
    const source = workspacePath(ws, name);
    let original: Buffer;
    try {
      assertNotLink(source);
      original = await readFile(source);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    const copy = path.join(partial, name);
    await writeWorkspaceFile(copy, original);
    const actual = await digestOf(copy);
    if (actual.bytes !== original.length || actual.sha256 !== createHash('sha256').update(original).digest('hex')) {
      throw new McsError('INTERNAL', `the backup copy of ${name} does not equal the original; nothing was changed`);
    }
    out.push({ path: name, bytes: actual.bytes, sha256: actual.sha256 });
  }
  return out;
}

/** The database files copied byte for byte (a stopped instance whose online copy could not be made, a damaged file). */
async function copyDatabaseRaw(ws: WorkspaceRef, partial: string): Promise<ManifestFile[]> {
  const out: ManifestFile[] = [];
  for (const name of DB_FILES) {
    const source = workspacePath(ws, 'data', name);
    assertNotLink(source);
    if ((await entryOf(source)) === null) continue;
    const copy = path.join(partial, name);
    await copyFile(source, copy, constants.COPYFILE_EXCL);
    out.push({ path: name, ...(await digestOf(copy)) });
  }
  return out;
}

/** The first 16 bytes of every SQLite database file: `SQLite format 3` and a NUL. */
const SQLITE_MAGIC = `SQLite format 3${String.fromCharCode(0)}`;
const SQLITE_HEADER_BYTES = 100;
const USER_VERSION_OFFSET = 60;

/**
 * The `user_version` in the header of a database file, read as bytes: no SQLite open, so it works for a damaged file and
 * creates no `-wal` or `-shm`. A file that is no database, or cannot be read, gives `fallback` (the mirror in `instance.json`).
 */
async function schemaVersionOf(file: string, fallback: number): Promise<number> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, 'r');
    const header = Buffer.alloc(SQLITE_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, SQLITE_HEADER_BYTES, 0);
    if (bytesRead < SQLITE_HEADER_BYTES || header.toString('latin1', 0, SQLITE_MAGIC.length) !== SQLITE_MAGIC) {
      return fallback;
    }
    return header.readUInt32BE(USER_VERSION_OFFSET);
  } catch {
    return fallback;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface DatabaseCopy {
  readonly files: ManifestFile[];
  readonly dbCopy: BackupManifest['dbCopy'];
  readonly dbSchemaVersion: number;
  readonly copiedBy: 'cli' | 'server' | null;
}

/** Asks the running server (the only writer) to copy its database into `<partial>/monitor.db` (01 4.3, 5.5 step 2). */
async function copyDatabaseViaServer(
  ws: WorkspaceRef,
  instance: InstanceFile,
  partial: string,
  deps: BackupOpDeps,
): Promise<DatabaseCopy> {
  const dest = path.join(partial, DB_FILE);
  const token = await controlTokenOf(ws);
  if (token === null) {
    throw new McsError('DB_ERROR', 'the running server cannot be asked for a backup: it left no control token', {
      hint: `mcs doctor --task ${ws.slug}`,
    });
  }
  const attempt = await (deps.control ?? requestControl)(
    controlAddressOf(instance.instanceId),
    { v: 1, op: 'backup', instanceId: instance.instanceId, token, dest },
    { timeoutMs: controlTimeoutMs('backup') },
  );
  let reply: { dbSchemaVersion: number } | null = null;
  if (attempt.kind === 'reply' && attempt.response.op === 'backup') reply = attempt.response;
  if (reply === null) {
    const why =
      attempt.kind === 'refusal'
        ? `it refused (${attempt.error})`
        : attempt.kind === 'silent'
          ? `it did not answer (${attempt.reason})`
          : 'its control channel is gone';
    throw new McsError('DB_ERROR', `the running server did not make the backup: ${why}`, {
      hint: `mcs doctor --task ${ws.slug}`,
    });
  }
  if ((await entryOf(dest))?.isFile() !== true) {
    throw new McsError('DB_ERROR', 'the running server reported a backup but left no file');
  }
  return {
    files: [{ path: DB_FILE, ...(await digestOf(dest)) }],
    dbCopy: 'online',
    dbSchemaVersion: reply.dbSchemaVersion,
    copiedBy: 'server',
  };
}

/** Copies a stopped instance's database with the SQLite online backup through a read-only connection (01 5.5 step 2). */
async function copyDatabaseDirect(
  ctx: Pick<OpContext, 'log'>,
  ws: WorkspaceRef,
  instance: InstanceFile,
  partial: string,
  o: MakeBackupOptions,
): Promise<DatabaseCopy> {
  const source = workspacePath(ws, 'data', DB_FILE);
  const dest = path.join(partial, DB_FILE);
  try {
    const copied = await backupDb({ path: source, expectedInstanceId: instance.instanceId }, dest);
    return {
      files: [{ path: DB_FILE, ...(await digestOf(dest)) }],
      dbCopy: 'online',
      dbSchemaVersion: copied.dbSchemaVersion,
      copiedBy: 'cli',
    };
  } catch (error) {
    if (o.rawFallback !== true) throw dbFailure(error);
    // a damaged or foreign database must still be kept before it is replaced: the files are copied as they are
    ctx.log.warn('backup_raw_fallback', { code: isDbError(error) ? error.code : 'ERROR' });
    await rm(dest, { force: true });
    const files = await copyDatabaseRaw(ws, partial);
    return {
      files,
      dbCopy: 'raw',
      dbSchemaVersion: await schemaVersionOf(source, instance.dbSchemaVersion),
      copiedBy: 'cli',
    };
  }
}

export interface MakeBackupOptions {
  readonly reason: BackupReason;
  /** Copy the reference files only and record `dbCopy: 'none'` (the backup of `config migrate`), even when a database exists. */
  readonly filesOnly?: boolean;
  /** Copy the database files as they are when the online copy fails (the `pre-restore` backup of a damaged database). */
  readonly rawFallback?: boolean;
}

export interface MadeBackup {
  readonly id: string;
  /** Absolute path of the final folder. */
  readonly dir: string;
  readonly manifest: BackupManifest;
  readonly dbCopiedBy: 'cli' | 'server' | null;
}

/** The backup writes the manifest from this object in this key order (the schema order). */
function manifestOf(
  staging: Staging,
  ws: WorkspaceRef,
  instance: InstanceFile,
  reason: BackupReason,
  nowMs: number,
  copy: Pick<DatabaseCopy, 'dbCopy' | 'dbSchemaVersion'>,
  files: ManifestFile[],
): BackupManifest {
  return BackupManifestSchema.parse({
    schema_version: 1,
    backupId: staging.id,
    instanceId: instance.instanceId,
    slug: ws.slug,
    createdAt: isoSecondsZ(nowMs),
    reason,
    runtimeVersion: RUNTIME_VERSION,
    dbSchemaVersion: copy.dbSchemaVersion,
    dbCopy: copy.dbCopy,
    files,
  });
}

/**
 * Makes one backup under the task mutex the caller holds (01 5.5 create steps 1-3): the folder is built as `.partial`, the
 * database is copied (by the server when it runs, else by this process), the reference files are copied and read back, the
 * manifest is written last and the folder gets its final name. Any failure removes the partial folder and changes nothing
 * else. Instance states between ready and stopped (`starting`, `stopping`, `unhealthy`, a monitor of another runtime) are
 * `INSTANCE_RUNNING`: the database is copied only when its owner is known.
 */
export async function make(
  ctx: OpContext,
  ws: WorkspaceRef,
  instance: InstanceFile,
  o: MakeBackupOptions,
  deps: BackupOpDeps = {},
): Promise<MadeBackup> {
  const dbFile = workspacePath(ws, 'data', DB_FILE);
  assertNotLink(dbFile);
  const hasDb = o.filesOnly !== true && (await entryOf(dbFile)) !== null;
  let viaServer = false;
  if (hasDb) {
    const probe = await probeOf(ctx, ws, deps);
    if (probe.state === 'running') {
      viaServer = true;
    } else if (isLiveState(probe.state)) {
      throw new McsError(
        'INSTANCE_RUNNING',
        `the monitor of '${ws.slug}' is ${probe.state}; its database is not copied`,
        {
          hint: 'wait until the runtime is ready or stopped, then try again',
          details: { state: probe.state },
        },
      );
    }
  }
  const nowMs = ctx.clock.now();
  const staging = await stage(ws, o.reason, nowMs);
  try {
    const copy: DatabaseCopy = !hasDb
      ? { files: [], dbCopy: 'none', dbSchemaVersion: 0, copiedBy: null }
      : viaServer
        ? await copyDatabaseViaServer(ws, instance, staging.partial, deps)
        : await copyDatabaseDirect(ctx, ws, instance, staging.partial, o);
    const files = [...copy.files, ...(await copyReferenceFiles(ws, staging.partial))];
    const manifest = manifestOf(staging, ws, instance, o.reason, nowMs, copy, files);
    await writeJsonFile(path.join(staging.partial, MANIFEST_FILE), fromPlain(manifest));
    await renameWithRetry(staging.partial, staging.final);
    return { id: staging.id, dir: staging.final, manifest, dbCopiedBy: copy.copiedBy };
  } catch (error) {
    await discard(staging);
    throw error;
  }
}

/** The database files that exist in `data/`, with their sizes (`monitor.db`, `-wal`, `-shm`). */
export async function databaseFiles(ws: WorkspaceRef): Promise<{ path: string; bytes: number }[]> {
  const out: { path: string; bytes: number }[] = [];
  for (const name of DB_FILES) {
    const file = workspacePath(ws, 'data', name);
    assertNotLink(file);
    const entry = await entryOf(file);
    if (entry?.isFile() === true) out.push({ path: `data/${name}`, bytes: entry.size });
  }
  return out;
}

/**
 * The `db-rebuild` backup (01 5.4 step 4): the database files are not copied but moved (same volume, so one rename each)
 * into `<id>.partial/`, together with copies of the reference files, and the manifest says `dbCopy: 'raw'` with a sha256 per
 * file. A move opens no SQLite file, so it works for a corrupt one. A failure puts every moved file back before the partial
 * folder is removed; if even that fails, the folder is left in place and the error names it. The instance must be stopped and
 * the task mutex held.
 */
export async function moveDatabase(
  ctx: OpContext,
  ws: WorkspaceRef,
  instance: InstanceFile,
  deps: BackupOpDeps = {},
): Promise<MadeBackup> {
  const nowMs = ctx.clock.now();
  const staging = await stage(ws, 'db-rebuild', nowMs);
  const moved: { from: string; to: string }[] = [];
  try {
    const dbSchemaVersion = await schemaVersionOf(workspacePath(ws, 'data', DB_FILE), instance.dbSchemaVersion);
    for (const name of DB_FILES) {
      const from = workspacePath(ws, 'data', name);
      assertNotLink(from);
      if ((await entryOf(from)) === null) continue;
      const to = path.join(staging.partial, name);
      await (deps.rename ?? renameWithRetry)(from, to);
      moved.push({ from, to });
    }
    const files: ManifestFile[] = [];
    for (const { to } of moved) files.push({ path: path.basename(to), ...(await digestOf(to)) });
    files.push(...(await copyReferenceFiles(ws, staging.partial)));
    const manifest = manifestOf(staging, ws, instance, 'db-rebuild', nowMs, { dbCopy: 'raw', dbSchemaVersion }, files);
    await writeJsonFile(path.join(staging.partial, MANIFEST_FILE), fromPlain(manifest));
    await renameWithRetry(staging.partial, staging.final);
    return { id: staging.id, dir: staging.final, manifest, dbCopiedBy: 'cli' };
  } catch (error) {
    let putBack = true;
    for (const { from, to } of moved.reverse()) {
      try {
        await renameWithRetry(to, from);
      } catch {
        putBack = false;
      }
    }
    if (putBack) {
      await discard(staging);
      throw error;
    }
    throw new McsError(
      'WORKSPACE_INVALID',
      `the database could not be moved back after a failure; its files are in data/backups/${staging.id}${PARTIAL_SUFFIX}/`,
      { hint: 'move the monitor.db* files from that folder back into data/ by hand', cause: error },
    );
  }
}

// ---- pruning ------------------------------------------------------------------------------------------------------------------------

/** Deletes the files the manifest lists, the manifest, and the folder if nothing else is in it. */
export async function removeBackup(listed: ListedBackup): Promise<void> {
  for (const file of listed.manifest.files) await removeFile(path.join(listed.dir, file.path));
  await removeFile(path.join(listed.dir, MANIFEST_FILE));
  await rmdir(listed.dir).catch(() => undefined);
}

/**
 * The backups beyond the `keep` newest, oldest first. The newest `upgrade` and the newest `db-rebuild` backup are never
 * listed, nor the ids in `protect`. Only folders with a valid manifest are considered. Reads only.
 */
export async function pruneCandidates(
  ws: WorkspaceRef,
  keep: number,
  protect: readonly string[] = [],
): Promise<ListedBackup[]> {
  const listed = await listBackups(ws);
  const kept = new Set<string>(listed.slice(0, keep).map((b) => b.id));
  for (const reason of PROTECTED_REASONS) {
    const newest = listed.find((b) => b.manifest.reason === reason);
    if (newest !== undefined) kept.add(newest.id);
  }
  for (const id of protect) kept.add(id);
  return listed.filter((b) => !kept.has(b.id)).reverse();
}

/**
 * Removes the backups beyond the `keep` newest, oldest first (01 5.5 create step 4), see `pruneCandidates`.
 * Returns the removed ids.
 */
export async function prune(ws: WorkspaceRef, keep: number, protect: readonly string[] = []): Promise<string[]> {
  const removed: string[] = [];
  for (const backup of await pruneCandidates(ws, keep, protect)) {
    await removeBackup(backup);
    removed.push(backup.id);
  }
  return removed;
}

/** `backup.keep` of the task's configuration, or `null` when the configuration does not resolve (then nothing is pruned). */
async function keepOf(ctx: OpContext, ws: WorkspaceRef): Promise<number | null> {
  try {
    return (await resolveConfig({ workspace: ws, env: ctx.env, cli: {}, skillDir: ctx.skillDir })).runtime.backup.keep;
  } catch {
    return null;
  }
}

/**
 * The automatic pruning after a successful operation: best effort, because the backups the operation needed exist already.
 * A failure is logged by code and the ids removed so far are returned.
 */
export async function pruneAfter(ctx: OpContext, ws: WorkspaceRef, protect: readonly string[] = []): Promise<string[]> {
  const keep = await keepOf(ctx, ws);
  if (keep === null) return [];
  try {
    return await prune(ws, keep, protect);
  } catch (error) {
    ctx.log.warn('backup_prune_failed', {
      code: error instanceof McsError ? error.code : (errorCode(error) ?? 'ERROR'),
    });
    return [];
  }
}

// ---- the database swap (restore, and the rollback of a failed upgrade) -------------------------------------------------------------------

async function copyChecked(from: string, to: string, expected: ManifestFile): Promise<void> {
  await copyFile(from, to, constants.COPYFILE_EXCL);
  const actual = await digestOf(to);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new McsError(
      'BACKUP_INVALID',
      `the copy of ${expected.path} does not equal the backup; the live file was not replaced`,
    );
  }
}

/**
 * Puts the database of a verified backup in place (01 5.5 steps 4-5): the stale `-wal` and `-shm` go first (a stale WAL must
 * never be applied to the restored file), the backup's database is copied next to `monitor.db`, checked against its sha256 and
 * renamed over it (retried on Windows); for `dbCopy: 'raw'` the backup's `-wal` is copied after the rename (it belongs to that
 * file and holds committed pages). The instance must be stopped and the task mutex held.
 */
export async function restoreDatabaseFiles(
  ws: WorkspaceRef,
  dir: string,
  manifest: BackupManifest,
  deps: Pick<BackupOpDeps, 'rename'> = {},
): Promise<void> {
  const data = workspacePath(ws, 'data');
  assertNotLink(data);
  const database = manifest.files.find((f) => f.path === DB_FILE);
  if (manifest.dbCopy === 'none' || database === undefined) {
    throw new McsError('BACKUP_INVALID', `backup ${manifest.backupId} holds no database`);
  }
  const live = path.join(data, DB_FILE);
  assertNotLink(live);
  for (const name of [DB_WAL, DB_SHM]) {
    assertNotLink(path.join(data, name));
    await removeFile(path.join(data, name));
  }
  const temp = `${live}.restore-${randomBytes(4).toString('hex')}.tmp`;
  try {
    await copyChecked(path.join(dir, DB_FILE), temp, database);
    await (deps.rename ?? renameWithRetry)(temp, live);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  const wal = manifest.files.find((f) => f.path === DB_WAL);
  if (manifest.dbCopy === 'raw' && wal !== undefined) {
    await copyChecked(path.join(dir, DB_WAL), path.join(data, DB_WAL), wal);
  }
}

// ---- backup (create) ---------------------------------------------------------------------------------------------------------------------

export interface BackupCreateInput {
  readonly task: string;
  /** `--label`: kept in the audit entry (the manifest schema has no field for it). */
  readonly label?: string;
}

/**
 * `ops.backup.create` (`mcs backup`, 01 5.5): a manual backup of the instance, running or stopped, then the automatic pruning
 * and the `backup` audit entry. Needs `instance.json` (`INSTANCE_NOT_INITIALIZED`).
 */
export async function create(
  ctx: OpContext,
  input: BackupCreateInput,
  deps: BackupOpDeps = {},
): Promise<BackupCreateResult> {
  const ws = await openWorkspace(ctx, input.task);
  return withTaskMutex(
    ws,
    async () => {
      const instance = await requireInstance(ws);
      const made = await make(ctx, ws, instance, { reason: 'manual' }, deps);
      const pruned = await pruneAfter(ctx, ws, [made.id]);
      await appendChange(
        ws,
        {
          action: 'backup',
          summary: `created backup ${made.id} (manual)`,
          reason: input.label ?? null,
          files: [folderName(made.id)],
          validation: `sha256 recorded for ${String(made.manifest.files.length)} files`,
          outcome: 'created',
        },
        ctx.clock.now(),
      );
      return {
        task: ws.slug,
        id: made.id,
        reason: made.manifest.reason,
        folder: folderName(made.id),
        dbCopy: made.manifest.dbCopy,
        dbSchemaVersion: made.manifest.dbSchemaVersion,
        files: made.manifest.files.length,
        bytes: made.manifest.files.reduce((sum, f) => sum + f.bytes, 0),
        dbCopiedBy: made.dbCopiedBy,
        pruned,
      };
    },
    deps.mutexTimeoutMs === undefined ? {} : { timeoutMs: deps.mutexTimeoutMs },
  );
}

/** The text of `backup`. */
export function createLines(result: BackupCreateResult): string[] {
  const by =
    result.dbCopiedBy === 'server'
      ? 'the database was copied by the running server'
      : result.dbCopiedBy === 'cli'
        ? 'the database was copied from the stopped instance'
        : 'the task has no database yet';
  const lines = [
    `created backup ${result.id} (${result.reason}): ${String(result.files)} files, ${humanBytes(result.bytes)}`,
    `folder: ${result.folder}`,
    by,
  ];
  if (result.pruned.length > 0)
    lines.push(`removed ${String(result.pruned.length)} older backups: ${result.pruned.join(', ')}`);
  return lines;
}

// ---- backup list -------------------------------------------------------------------------------------------------------------------------

export interface BackupListInput {
  readonly task: string;
  /** `--verify`: read every file again and compare size and sha256. */
  readonly verify?: boolean;
}

function rowOf(listed: ListedBackup, problems: string[] | null): BackupRow {
  const m = listed.manifest;
  return {
    id: listed.id,
    reason: m.reason,
    createdAt: m.createdAt,
    runtimeVersion: m.runtimeVersion,
    dbSchemaVersion: m.dbSchemaVersion,
    dbCopy: m.dbCopy,
    files: m.files.length,
    bytes: m.files.reduce((sum, f) => sum + f.bytes, 0),
    verified: problems === null ? null : problems.length === 0,
    problems: problems ?? [],
  };
}

/** `ops.backup.list` (`mcs backup list`): the backups with a valid manifest, newest first. */
export async function list(ctx: OpContext, input: BackupListInput): Promise<BackupListResult> {
  const ws = await openWorkspace(ctx, input.task);
  const verify = input.verify === true;
  const rows: BackupRow[] = [];
  for (const listed of await listBackups(ws)) {
    rows.push(rowOf(listed, verify ? await verifyBackup(listed.dir, listed.manifest) : null));
  }
  return { task: ws.slug, verify, backups: rows };
}

/** The table of `backup list`. */
export function listLines(result: BackupListResult): string[] {
  if (result.backups.length === 0) return [`no backups for task '${result.task}'`];
  const header = ['id', 'reason', 'created', 'db', 'runtime', 'files', 'size', ...(result.verify ? ['verified'] : [])];
  const rows = result.backups.map((b) => [
    b.id,
    b.reason,
    b.createdAt,
    b.dbCopy === 'none' ? '-' : `v${String(b.dbSchemaVersion)} ${b.dbCopy}`,
    b.runtimeVersion,
    String(b.files),
    humanBytes(b.bytes),
    ...(result.verify ? [b.verified === true ? 'ok' : `FAILED: ${b.problems.join('; ')}`] : []),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

// ---- backup restore ---------------------------------------------------------------------------------------------------------------------------

export interface BackupRestoreInput {
  readonly task: string;
  readonly id: string;
  /** `--yes`: apply. Without it the plan is checked and printed and nothing is changed. */
  readonly yes?: boolean;
  /** `--include-runtime-config`: also restore `runtime.json` and the `engine`/`hooks` fields of `instance.json`. */
  readonly includeRuntimeConfig?: boolean;
}

/** The live files a restore replaces, as the plan and the audit entry name them. */
function restoredFiles(includeRuntimeConfig: boolean): string[] {
  const files = ['data/monitor.db'];
  if (includeRuntimeConfig) files.push('runtime.json', 'instance.json');
  return files;
}

/** The `engine` and `hooks` fields of the `instance.json` stored in a verified backup. */
async function backedUpInstance(dir: string): Promise<Pick<InstanceFile, 'engine' | 'hooks'> | null> {
  try {
    const parsed = InstanceFileSchema.safeParse(toPlain((await readJsonFile(path.join(dir, 'instance.json'))).value));
    return parsed.success ? { engine: parsed.data.engine, hooks: parsed.data.hooks } : null;
  } catch {
    return null;
  }
}

/** `--include-runtime-config` (01 5.5 step 6): `runtime.json` comes back (or goes away when the backup had none). */
async function restoreRuntimeConfig(ws: WorkspaceRef, dir: string, manifest: BackupManifest): Promise<void> {
  const target = workspacePath(ws, 'runtime.json');
  assertNotLink(target);
  if (manifest.files.some((f) => f.path === 'runtime.json')) {
    await writeWorkspaceFile(target, await readFile(path.join(dir, 'runtime.json')));
  } else {
    await removeFile(target);
  }
}

/** The error of a restore that failed after the live files may have been touched: it names the way back. */
function restoreFailure(error: unknown, ws: WorkspaceRef, preRestoreId: string): McsError {
  const code = error instanceof McsError ? error.code : 'DB_ERROR';
  const reason = error instanceof McsError ? error.message : `restoring failed (${errorCode(error) ?? 'error'})`;
  return new McsError(code, `${reason}; the backup made before this restore is ${preRestoreId} and was kept`, {
    hint: `mcs backup restore --task ${ws.slug} --id ${preRestoreId} --yes`,
    details: { preRestoreBackup: preRestoreId },
    cause: error,
  });
}

/**
 * `ops.backup.restore` (`mcs backup restore`, 01 5.5): checks the backup (manifest, sha256 of every file, instance id, schema
 * version) and, only with `yes`, replaces the database with it after a verified `pre-restore` backup. The instance must be
 * stopped. `config.json`, `task.json`, `README.md` and the audit trail are never restored.
 */
export async function restore(
  ctx: OpContext,
  input: BackupRestoreInput,
  deps: BackupOpDeps = {},
): Promise<BackupRestoreResult> {
  const ws = await openWorkspace(ctx, input.task);
  return withTaskMutex(
    ws,
    async () => {
      const instance = await requireInstance(ws);
      const target = await loadBackup(ws, input.id);
      const manifest = target.manifest;
      if (manifest.instanceId !== instance.instanceId) {
        throw new McsError('BACKUP_INVALID', `backup ${target.id} belongs to another instance; it is not restored`, {
          hint: `mcs backup list --task ${ws.slug}`,
        });
      }
      if (manifest.dbCopy === 'none') {
        throw new McsError('BACKUP_INVALID', `backup ${target.id} holds no database`);
      }
      const latest = latestSchemaVersion(migrationsOf(ctx, deps));
      if (manifest.dbSchemaVersion > latest) {
        throw new McsError(
          'DB_NEWER_THAN_RUNTIME',
          `backup ${target.id} holds schema version ${String(manifest.dbSchemaVersion)}, newer than this runtime supports (${String(latest)})`,
          { hint: 'restore it with a runtime that is at least as new' },
        );
      }
      const problems = await verifyBackup(target.dir, manifest);
      if (problems.length > 0) {
        throw new McsError('BACKUP_INVALID', `backup ${target.id} does not verify: ${problems[0] ?? ''}`, {
          details: { problems },
        });
      }
      const includeRuntimeConfig = input.includeRuntimeConfig === true;
      const base = {
        task: ws.slug,
        id: target.id,
        dbCopy: manifest.dbCopy,
        dbSchemaVersion: manifest.dbSchemaVersion,
        runtimeVersion: manifest.runtimeVersion,
        restores: restoredFiles(includeRuntimeConfig),
        upgradeNeeded: manifest.dbSchemaVersion < latest,
      };
      if (input.yes !== true) return { ...base, applied: false, preRestoreBackup: null, pruned: [] };

      await assertNotLive(ctx, ws, deps);
      const pre = await make(ctx, ws, instance, { reason: 'pre-restore', rawFallback: true }, deps);
      const preProblems = await verifyBackup(pre.dir, pre.manifest);
      if (preProblems.length > 0) {
        throw new McsError('INTERNAL', `the pre-restore backup ${pre.id} does not verify; nothing was changed`, {
          details: { problems: preProblems },
        });
      }
      try {
        await restoreDatabaseFiles(ws, target.dir, manifest, deps);
        let next: InstanceFile = {
          ...instance,
          dbSchemaVersion: manifest.dbSchemaVersion,
        };
        if (includeRuntimeConfig) {
          await restoreRuntimeConfig(ws, target.dir, manifest);
          const stored = await backedUpInstance(target.dir);
          if (stored !== null) next = { ...next, ...stored };
        }
        await writeInstanceFile(ws, next);
      } catch (error) {
        throw restoreFailure(error, ws, pre.id);
      }
      await appendChange(
        ws,
        {
          action: 'backup-restore',
          summary: `restored backup ${target.id} (pre-restore backup ${pre.id})`,
          reason: null,
          files: base.restores,
          validation: 'manifest ok; sha256 ok; instance id ok',
          outcome: 'restored',
        },
        ctx.clock.now(),
      );
      const pruned = await pruneAfter(ctx, ws, [target.id, pre.id]);
      return { ...base, applied: true, preRestoreBackup: pre.id, pruned };
    },
    deps.mutexTimeoutMs === undefined ? {} : { timeoutMs: deps.mutexTimeoutMs },
  );
}

/** The text of `backup restore`. */
export function restoreLines(result: BackupRestoreResult): string[] {
  if (!result.applied) {
    return [
      `task '${result.task}': backup ${result.id} is valid (manifest, sha256 and instance id checked); dry run, nothing changed`,
      `would replace: ${result.restores.join(', ')}`,
      'a pre-restore backup is made first',
      'run again with --yes to restore it (the instance must be stopped)',
    ];
  }
  const lines = [
    `restored backup ${result.id} into task '${result.task}' (database schema ${String(result.dbSchemaVersion)})`,
    `replaced: ${result.restores.join(', ')}`,
    `pre-restore backup: ${result.preRestoreBackup ?? '-'} (restore it to undo this)`,
  ];
  if (result.pruned.length > 0)
    lines.push(`removed ${String(result.pruned.length)} older backups: ${result.pruned.join(', ')}`);
  if (result.upgradeNeeded) {
    lines.push(`the restored database is older than this runtime: run \`mcs upgrade --task ${result.task}\``);
  }
  return lines;
}
