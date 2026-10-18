// The backup of `mcs migrate-workspace` (ADR 0068): before the first write, the workspace files that the migration may
// change or that tell its story are copied to `data/backups/pre-migrate-<YYYYMMDDTHHMMSSZ>/` and read back. The folder has
// no manifest, so it is not a database backup set.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { McsError } from '@mcs/shared';

import { assertNotLink, isMissingFileError, writeWorkspaceFile } from '../workspace/fsio.ts';
import { workspacePath, type WorkspaceRef } from '../workspace/paths.ts';

/** The files copied when present, as paths relative to the workspace. */
export const BACKUP_FILES = [
  'task.json',
  'config.json',
  'README.md',
  'instance.json',
  'audit/changes.md',
  'audit/decisions.md',
] as const;

export interface MigrationBackup {
  /** Relative to the workspace, with `/` and a trailing slash: `data/backups/pre-migrate-20261019T101500Z/`. */
  readonly folder: string;
  /** Absolute path of the folder. */
  readonly dir: string;
  /** The relative paths copied, in `BACKUP_FILES` order. */
  readonly files: readonly string[];
}

/** `YYYYMMDDTHHMMSSZ` of an epoch time in UTC. */
export function backupStamp(nowMs: number): string {
  return new Date(nowMs)
    .toISOString()
    .replace(/\.\d{3}Z$/u, 'Z')
    .replace(/[-:]/gu, '');
}

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

/** Creates a new folder; a second migration in the same second gets `-2`, `-3`, ... */
async function newFolder(parent: string, base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${String(n)}`;
    const dir = path.join(parent, name);
    try {
      await mkdir(dir);
      return name;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  throw new McsError('INTERNAL', `cannot create a new backup folder under ${parent}`);
}

/** Copies the files of `BACKUP_FILES` that exist and verifies every copy byte for byte. */
export async function backupWorkspace(ws: WorkspaceRef, nowMs: number): Promise<MigrationBackup> {
  const backups = workspacePath(ws, 'data', 'backups');
  assertNotLink(workspacePath(ws, 'data'));
  assertNotLink(backups);
  await mkdir(backups, { recursive: true });
  const name = await newFolder(backups, `pre-migrate-${backupStamp(nowMs)}`);
  const dir = path.join(backups, name);
  const files: string[] = [];
  for (const relative of BACKUP_FILES) {
    const segments = relative.split('/');
    const original = await readOptional(workspacePath(ws, ...segments));
    if (original === null) continue;
    const copy = path.join(dir, ...segments);
    await mkdir(path.dirname(copy), { recursive: true });
    await writeWorkspaceFile(copy, original);
    const back = await readFile(copy);
    if (!back.equals(original)) {
      throw new McsError('INTERNAL', `the backup copy of ${relative} does not equal the original; nothing was changed`);
    }
    files.push(relative);
  }
  return { folder: `data/backups/${name}/`, dir, files };
}

/** Puts the backed-up `config.json` back (atomically) after a failed re-resolve. */
export async function restoreConfig(ws: WorkspaceRef, backup: MigrationBackup): Promise<void> {
  const bytes = await readFile(path.join(backup.dir, 'config.json'));
  await writeWorkspaceFile(workspacePath(ws, 'config.json'), bytes);
}
