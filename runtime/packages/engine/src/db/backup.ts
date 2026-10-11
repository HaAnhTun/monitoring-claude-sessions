// The one DB-level backup function (03 4.4, 11.2): folders, manifests, pruning and restore belong to design 01.
// The source is the server's writer connection or a read-only connection opened with the identity check only (an older
// schema must be backed up before `upgrade`). The copy is made with the SQLite online backup API and verified before the
// caller is told it exists.
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { BUSY_TIMEOUT_MS, openSqlite, pragmaNumber, pragmaValue, type SqlDriver } from './driver.ts';
import { DbError, isDbError } from './errors.ts';
import { assertIdentity } from './migrations.ts';
import type { InstanceDb } from './open.ts';

export interface BackupSourcePath {
  path: string;
  expectedInstanceId: string;
}

export interface BackupOptions {
  onProgress?: (p: { totalPages: number; remainingPages: number }) => void;
}

function failed(reason: string, cause?: unknown): DbError {
  const underlying = isDbError(cause) ? ` (${cause.code})` : '';
  return new DbError('backup_failed', `backup failed: ${reason}${underlying}`);
}

function isInstanceDb(src: InstanceDb | BackupSourcePath): src is InstanceDb {
  return 'driver' in src;
}

/** The copy, and the `-wal`, `-shm` and `-journal` files a connection to it may have left. */
function removeCopy(destPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${destPath}${suffix}`, { force: true });
}

/** Opens the copy read-only and checks it is a whole, identical-instance database; returns its `user_version`. */
function verifyCopy(destPath: string, expectedInstanceId: string): number {
  const copy = openSqlite(destPath, { readonly: true, fileMustExist: true, timeoutMs: BUSY_TIMEOUT_MS });
  try {
    if (pragmaValue(copy, 'quick_check') !== 'ok') throw failed('the copy did not pass quick_check');
    assertIdentity(copy, expectedInstanceId);
    return pragmaNumber(copy, 'user_version');
  } finally {
    copy.close();
  }
}

/**
 * Copies the database to `destPath` (which must not exist; its folder must) and verifies the copy: `quick_check` is `ok`,
 * `application_id` and `meta.instance_id` are the expected ones. Any failure after the copy started deletes it and
 * answers `backup_failed`. Identity failures of the source are `db_not_mcs` / `db_identity_mismatch`, before anything is
 * created.
 */
export async function backupDb(
  src: InstanceDb | BackupSourcePath,
  destPath: string,
  opts: BackupOptions = {},
): Promise<{ bytes: number; dbSchemaVersion: number }> {
  if (existsSync(destPath)) throw failed('the destination already exists');
  const folder = dirname(destPath);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw failed('the destination folder does not exist');

  let source: SqlDriver;
  let expectedInstanceId: string;
  let owned = false;
  if (isInstanceDb(src)) {
    source = src.driver;
    expectedInstanceId = src.instanceId;
    // fold what is already in the WAL into the main file before the pages are copied (the writer connection only)
    if (src.mode !== 'readonly') source.pragma('wal_checkpoint(PASSIVE)');
  } else {
    source = openSqlite(src.path, { readonly: true, fileMustExist: true, timeoutMs: BUSY_TIMEOUT_MS });
    expectedInstanceId = src.expectedInstanceId;
    owned = true;
  }
  try {
    if (owned) assertIdentity(source, expectedInstanceId);
    try {
      await source.backupTo(destPath, opts.onProgress);
    } catch (error) {
      removeCopy(destPath);
      throw failed('the online backup stopped', error);
    }
    let dbSchemaVersion: number;
    try {
      dbSchemaVersion = verifyCopy(destPath, expectedInstanceId);
    } catch (error) {
      removeCopy(destPath);
      throw isDbError(error, 'backup_failed') ? error : failed('the copy could not be verified', error);
    }
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${destPath}${suffix}`, { force: true });
    return { bytes: statSync(destPath).size, dbSchemaVersion };
  } finally {
    if (owned) source.close();
  }
}
