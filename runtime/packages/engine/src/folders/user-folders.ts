// The folders a person added by hand (CAW design 03 section 4.4, D7): `<instanceDir>/data/folders.json`, format v1,
// `{"schema_version":1,"updatedAt":"<iso>","folders":[{"path":"D:\\work\\app","addedAt":"<iso>"}]}`. Paths only: no name, no
// content. The file is per-user state and never part of a repository.
//
// Writes are atomic (`atomicWriteFile`, ADR 0058 retry) and go through one promise chain, and every change reads the file again
// first, so an add never drops what another writer put there. A missing file is empty. A file that cannot be used (invalid JSON,
// a wrong shape, over 256 KiB) is empty too, and is kept once as `folders.json.bad` before the next write replaces it. A file
// of a NEWER format is never overwritten: writes fail with `state_unwritable`. Paths go through `windowsFolderPath` (absolute,
// no UNC or device path, no control character), so a folder that could send credentials to another machine is never stored.
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { folderPathIssue, windowsFolderPath, type FolderPathIssue } from '@mcs/shared';

import { errorCodeOf, classifyFsError } from '../ingest/tail/file-identity.ts';
import { dirMatchesKey, folderKeyOfPath, type FolderKey } from '../projects/folder-key.ts';
import { atomicWriteFile } from '../platform/fsx.ts';
import { hostPlatform } from '../platform/host.ts';

/** The file of the user folders. */
export const USER_FOLDERS_SCHEMA_VERSION = 1;
/** Folders kept at most (`userFoldersMax` of the runtime configuration). */
export const USER_FOLDERS_MAX = 200;
/** The state file is read up to this size; a larger file is corrupt. */
export const USER_FOLDERS_READ_MAX_BYTES = 256 * 1024;
/** A stored path has at most this many characters. */
export const USER_FOLDER_PATH_MAX = 1024;

export type FolderErrorCode = 'folder_invalid' | 'folder_limit' | 'folder_not_found' | 'state_unwritable';
export type FolderErrorIssue = FolderPathIssue | 'not_directory';

/** What the folder service answers with. The message names the code only: a path never enters an error message. */
export class FolderError extends Error {
  readonly code: FolderErrorCode;
  /** For `folder_invalid`: the first reason the path was refused. */
  readonly issue: FolderErrorIssue | null;

  constructor(code: FolderErrorCode, issue: FolderErrorIssue | null = null, cause?: unknown) {
    super(`folder error: ${code}`, cause === undefined ? undefined : { cause });
    this.name = 'FolderError';
    this.code = code;
    this.issue = issue;
  }
}

export type UserFoldersState = 'ok' | 'absent' | 'corrupt' | 'newer_version';

export interface UserFolder {
  /** Normalized by `windowsFolderPath`. */
  readonly path: string;
  /** The project key of the path (`folderKeyOfPath`), the identity of the folder. */
  readonly key: string;
  readonly addedAt: string;
  /** 0 when the file held no usable time. */
  readonly addedAtMs: number;
}

export type ReadResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'unreadable' };

/** The file system seam; a test replaces single members. */
export interface UserFoldersFs {
  readText(file: string, maxBytes: number): Promise<ReadResult>;
  isDirectory(target: string): Promise<boolean>;
  /** Creates the folder of `file` when needed and replaces `file` atomically. */
  writeAtomic(file: string, data: string): Promise<void>;
  /** Copies `file` to `copy` unless `copy` exists already. */
  keepCopy(file: string, copy: string): Promise<void>;
}

export const nodeUserFoldersFs: UserFoldersFs = {
  async readText(file, maxBytes) {
    try {
      const info = await stat(file);
      if (!info.isFile()) return { kind: 'unreadable' };
      if (info.size > maxBytes) return { kind: 'too_large' };
      const bytes = await readFile(file);
      return bytes.length > maxBytes ? { kind: 'too_large' } : { kind: 'text', text: bytes.toString('utf8') };
    } catch (error) {
      return classifyFsError(errorCodeOf(error)) === 'missing' ? { kind: 'absent' } : { kind: 'unreadable' };
    }
  },
  async isDirectory(target) {
    try {
      return (await stat(target)).isDirectory();
    } catch {
      return false;
    }
  },
  async writeAtomic(file, data) {
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, data, { mode: 0o600 });
  },
  async keepCopy(file, copy) {
    // exclusive: the first corrupt file is the one worth keeping
    try {
      await copyFile(file, copy, constants.COPYFILE_EXCL);
    } catch (error) {
      if (errorCodeOf(error) !== 'EEXIST') throw error;
    }
  },
};

export interface UserFoldersOptions {
  readonly file: string;
  /** At most this many folders (default 200). */
  readonly max?: number;
  readonly now: () => number;
  readonly fs?: UserFoldersFs;
  /** Which spelling of a path is valid (default: the host). */
  readonly win32?: boolean;
}

export interface UserFolders {
  /** Reads the file again; never throws and never writes. */
  load(): Promise<void>;
  /** The folders of the last load or change, in file order. */
  list(): readonly UserFolder[];
  status(): { readonly state: UserFoldersState; readonly count: number };
  /** Idempotent: a folder that is listed already is returned as it is. Throws `FolderError`. */
  add(rawPath: string): Promise<UserFolder>;
  /** Drops the folder with this project key. Throws `FolderError('folder_not_found' | 'state_unwritable')`. */
  remove(key: string): Promise<void>;
}

interface Loaded {
  readonly state: UserFoldersState;
  readonly folders: UserFolder[];
  /** The file exists and could not be used: the next write keeps it as `.bad`. */
  readonly keepBad: boolean;
  /** The file exists and could not be read at all: a write could destroy data. */
  readonly unreadable: boolean;
}

function isPlain(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The identity of a stored folder: its key, and the whole path too when the key is only the cut prefix of a long name. */
function identityOf(path_: string, key: FolderKey): string {
  return key.prefix ? `${key.key}|${path_.toLowerCase()}` : key.key;
}

function sameKey(entryPath: string, key: string): boolean {
  const entryKey = folderKeyOfPath(entryPath);
  return entryKey.key === key || (entryKey.prefix && dirMatchesKey(key, entryKey));
}

function toFolder(rawPath: string, addedAt: unknown, win32: boolean): UserFolder | null {
  if (rawPath.length > USER_FOLDER_PATH_MAX) return null;
  const normalized = windowsFolderPath(rawPath, win32);
  if (normalized === null) return null;
  const parsed = typeof addedAt === 'string' ? Date.parse(addedAt) : Number.NaN;
  const addedAtMs = Number.isFinite(parsed) ? parsed : 0;
  return {
    path: normalized,
    key: folderKeyOfPath(normalized).key,
    addedAt: new Date(addedAtMs).toISOString(),
    addedAtMs,
  };
}

function parseState(text: string, max: number, win32: boolean): Loaded {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'corrupt', folders: [], keepBad: true, unreadable: false };
  }
  if (!isPlain(parsed)) return { state: 'corrupt', folders: [], keepBad: true, unreadable: false };
  const version = parsed['schema_version'];
  if (typeof version === 'number' && Number.isInteger(version) && version > USER_FOLDERS_SCHEMA_VERSION) {
    return { state: 'newer_version', folders: [], keepBad: false, unreadable: false };
  }
  const entries = parsed['folders'];
  if (version !== USER_FOLDERS_SCHEMA_VERSION || !Array.isArray(entries)) {
    return { state: 'corrupt', folders: [], keepBad: true, unreadable: false };
  }
  const folders: UserFolder[] = [];
  const seen = new Set<string>();
  const candidates: unknown[] = entries;
  for (const entry of candidates) {
    if (folders.length >= max) break;
    if (!isPlain(entry) || typeof entry['path'] !== 'string') continue;
    const folder = toFolder(entry['path'], entry['addedAt'], win32);
    if (folder === null) continue;
    const id = identityOf(folder.path, folderKeyOfPath(folder.path));
    if (seen.has(id)) continue;
    seen.add(id);
    folders.push(folder);
  }
  return { state: 'ok', folders, keepBad: false, unreadable: false };
}

export function createUserFolders(options: UserFoldersOptions): UserFolders {
  const fs = options.fs ?? nodeUserFoldersFs;
  const max = options.max ?? USER_FOLDERS_MAX;
  const win32 = options.win32 ?? hostPlatform === 'win32';
  const badFile = `${options.file}.bad`;
  let current: Loaded = { state: 'absent', folders: [], keepBad: false, unreadable: false };
  let chain: Promise<unknown> = Promise.resolve();

  async function readFileState(): Promise<Loaded> {
    const read = await fs.readText(options.file, USER_FOLDERS_READ_MAX_BYTES);
    switch (read.kind) {
      case 'absent':
        return { state: 'absent', folders: [], keepBad: false, unreadable: false };
      case 'too_large':
        return { state: 'corrupt', folders: [], keepBad: true, unreadable: false };
      case 'unreadable':
        return { state: 'corrupt', folders: [], keepBad: false, unreadable: true };
      case 'text':
        return parseState(read.text, max, win32);
    }
  }

  async function reload(): Promise<void> {
    current = await readFileState();
  }

  /** One change at a time, in call order; a failed change does not stop the next one. */
  function serialized<T>(job: () => Promise<T>): Promise<T> {
    const run = chain.then(job, job);
    chain = run.catch(() => undefined);
    return run;
  }

  async function persist(folders: UserFolder[]): Promise<void> {
    if (current.state === 'newer_version' || current.unreadable) throw new FolderError('state_unwritable');
    try {
      if (current.keepBad) await fs.keepCopy(options.file, badFile);
      const at = new Date(options.now()).toISOString();
      const body = {
        schema_version: USER_FOLDERS_SCHEMA_VERSION,
        updatedAt: at,
        folders: folders.map((folder) => ({ path: folder.path, addedAt: folder.addedAt })),
      };
      await fs.writeAtomic(options.file, `${JSON.stringify(body, null, 2)}\n`);
    } catch (error) {
      throw new FolderError('state_unwritable', null, error);
    }
    current = { state: 'ok', folders, keepBad: false, unreadable: false };
  }

  return {
    async load() {
      await serialized(async () => {
        try {
          await reload();
        } catch {
          current = { state: 'corrupt', folders: [], keepBad: false, unreadable: true };
        }
      });
    },
    list: () => current.folders,
    status: () => ({ state: current.state, count: current.folders.length }),
    async add(rawPath) {
      const issue = rawPath.length > USER_FOLDER_PATH_MAX ? 'too_long' : folderPathIssue(rawPath, win32);
      const normalized = issue === null ? windowsFolderPath(rawPath, win32) : null;
      if (issue !== null || normalized === null) throw new FolderError('folder_invalid', issue ?? 'relative');
      return serialized(async () => {
        await reload();
        const key = folderKeyOfPath(normalized);
        const id = identityOf(normalized, key);
        const existing = current.folders.find((folder) => identityOf(folder.path, folderKeyOfPath(folder.path)) === id);
        if (existing !== undefined) return existing;
        if (current.state === 'newer_version' || current.unreadable) throw new FolderError('state_unwritable');
        if (!(await fs.isDirectory(normalized))) throw new FolderError('folder_invalid', 'not_directory');
        if (current.folders.length >= max) throw new FolderError('folder_limit');
        const addedAtMs = options.now();
        const added: UserFolder = {
          path: normalized,
          key: key.key,
          addedAt: new Date(addedAtMs).toISOString(),
          addedAtMs,
        };
        await persist([...current.folders, added]);
        return added;
      });
    },
    async remove(key) {
      await serialized(async () => {
        await reload();
        if (current.state === 'newer_version' || current.unreadable) throw new FolderError('state_unwritable');
        const kept = current.folders.filter((folder) => !sameKey(folder.path, key));
        if (kept.length === current.folders.length) throw new FolderError('folder_not_found');
        await persist(kept);
      });
    },
  };
}
