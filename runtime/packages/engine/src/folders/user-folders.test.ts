// The folders a person added by hand (CAW design 03 section 4.4): `data/folders.json`, format v1, at most 200, written
// atomically behind a mutex. A corrupt file is kept once as `.bad`, a file of a newer format is never overwritten. Real temp
// folders; the folder test of `add` is a seam so that invented drive paths work on every host.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import {
  FolderError,
  USER_FOLDERS_MAX,
  createUserFolders,
  nodeUserFoldersFs,
  type UserFoldersFs,
} from './user-folders.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const APP = 'D:\\FIXTURE-work\\app';
const LIB = 'D:\\FIXTURE-work\\lib';

function stateFile(): string {
  return path.join(makeTemp('folders').path, 'data', 'folders.json');
}

/** The real file system, except that the folders named in `dirs` (and nothing else) are folders. */
function fsWithDirs(dirs: readonly string[], extra: Partial<UserFoldersFs> = {}): UserFoldersFs {
  const known = new Set(dirs.map((d) => d.toLowerCase()));
  return {
    ...nodeUserFoldersFs,
    isDirectory: (p) => Promise.resolve(known.has(p.toLowerCase())),
    ...extra,
  };
}

function make(
  file: string,
  o: { max?: number; dirs?: readonly string[]; fs?: UserFoldersFs; now?: () => number } = {},
) {
  return createUserFolders({
    file,
    max: o.max ?? USER_FOLDERS_MAX,
    now: o.now ?? (() => NOW),
    win32: true,
    fs: o.fs ?? fsWithDirs(o.dirs ?? [APP, LIB]),
  });
}

function readState(file: string): {
  schema_version: number;
  updatedAt: string;
  folders: { path: string; addedAt: string }[];
} {
  return JSON.parse(readFileSync(file, 'utf8')) as ReturnType<typeof readState>;
}

async function failure(promise: Promise<unknown>): Promise<FolderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FolderError);
    return error as FolderError;
  }
  throw new Error('expected a FolderError');
}

describe('a file that is not there', () => {
  it('is empty and absent, and loading writes nothing', async () => {
    const file = stateFile();
    const folders = make(file);
    await folders.load();
    expect(folders.list()).toEqual([]);
    expect(folders.status()).toEqual({ state: 'absent', count: 0 });
    expect(() => statSync(path.dirname(file))).toThrow();
  });
});

describe('add', () => {
  it('persists the folder in format v1, creating the data folder', async () => {
    const file = stateFile();
    const folders = make(file);
    const added = await folders.add(APP);
    expect(added).toEqual({
      path: APP,
      key: 'd--fixture-work-app',
      addedAt: '2026-11-14T12:00:00.000Z',
      addedAtMs: NOW,
    });
    expect(readState(file)).toEqual({
      schema_version: 1,
      updatedAt: '2026-11-14T12:00:00.000Z',
      folders: [{ path: APP, addedAt: '2026-11-14T12:00:00.000Z' }],
    });
    expect(folders.status()).toEqual({ state: 'ok', count: 1 });
  });

  it('normalizes the spelling: quotes, slashes, a trailing separator and a WSL path', async () => {
    const file = stateFile();
    const folders = make(file);
    await folders.add('"d:/FIXTURE-work/app/"');
    await folders.add('/mnt/d/FIXTURE-work/lib');
    expect(folders.list().map((f) => f.path)).toEqual([APP, LIB]);
  });

  it('is idempotent: another spelling of a listed folder returns the entry and writes nothing', async () => {
    const file = stateFile();
    const folders = make(file);
    const first = await folders.add(APP);
    const before = readFileSync(file, 'utf8');
    const again = await make(file, { now: () => NOW + 5000 }).add('d:/fixture-work/APP/');
    expect(again).toEqual(first);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(folders.list()).toHaveLength(1);
  });

  it.each([
    ['a relative path', 'work\\app', 'relative'],
    ['a UNC path', '\\\\FIXTURE-host\\share\\dir', 'unc'],
    ['a device path', '\\\\?\\C:\\dir', 'device'],
    ['a control character', `${APP}${String.fromCharCode(7)}`, 'control'],
    ['an empty path', '   ', 'relative'],
  ])('refuses %s as folder_invalid', async (_name, raw, issue) => {
    const file = stateFile();
    const error = await failure(make(file).add(raw));
    expect(error.code).toBe('folder_invalid');
    expect(error.issue).toBe(issue);
    expect(() => statSync(file)).toThrow();
  });

  it('refuses a path that is not a folder', async () => {
    const error = await failure(make(stateFile(), { dirs: [] }).add(APP));
    expect(error.code).toBe('folder_invalid');
    expect(error.issue).toBe('not_directory');
  });

  it('refuses an existing file that is no folder (real file system)', async () => {
    const root = makeTemp('folders').path;
    const target = path.join(root, 'a-file.txt');
    writeFileSync(target, 'x');
    const folders = createUserFolders({
      file: path.join(root, 'data', 'folders.json'),
      max: 10,
      now: () => NOW,
      win32: path.sep === '\\',
    });
    expect((await failure(folders.add(target))).issue).toBe('not_directory');
    const added = await folders.add(root);
    expect(added.path).toBe(root.replace(/[\\/]+$/, ''));
  });

  it('refuses over the limit with folder_limit, and keeps the entries it has', async () => {
    const file = stateFile();
    const folders = make(file, { max: 2, dirs: [APP, LIB, 'D:\\FIXTURE-work\\third'] });
    await folders.add(APP);
    await folders.add(LIB);
    const error = await failure(folders.add('D:\\FIXTURE-work\\third'));
    expect(error.code).toBe('folder_limit');
    expect(readState(file).folders).toHaveLength(2);
    // an existing folder is still answered when the list is full
    expect((await folders.add(APP)).path).toBe(APP);
  });

  it('serializes concurrent adds: no add is lost, and no two writes overlap', async () => {
    const file = stateFile();
    const dirs = Array.from({ length: 8 }, (_, i) => `D:\\FIXTURE-work\\p${String(i)}`);
    let running = 0;
    let overlapped = false;
    const fs = fsWithDirs(dirs, {
      async writeAtomic(target, data) {
        running += 1;
        if (running > 1) overlapped = true;
        await nextTurn();
        await nodeUserFoldersFs.writeAtomic(target, data);
        running -= 1;
      },
    });
    const folders = make(file, { fs });
    await Promise.all(dirs.map((dir) => folders.add(dir)));
    expect(overlapped).toBe(false);
    expect(readState(file).folders.map((f) => f.path)).toEqual(dirs);
    expect(folders.list()).toHaveLength(8);
  });

  it('keeps a failed write out of the list and answers state_unwritable', async () => {
    const file = stateFile();
    const fs = fsWithDirs([APP], {
      writeAtomic: () => Promise.reject(new Error('disk full: D:\\secret-location')),
    });
    const folders = make(file, { fs });
    const error = await failure(folders.add(APP));
    expect(error.code).toBe('state_unwritable');
    expect(error.message).not.toContain('secret-location');
    expect(folders.list()).toEqual([]);
  });

  it('picks up what another process wrote since the last load', async () => {
    const file = stateFile();
    const a = make(file);
    const b = make(file);
    await a.add(APP);
    await b.add(LIB);
    expect(readState(file).folders.map((f) => f.path)).toEqual([APP, LIB]);
  });
});

describe('remove', () => {
  it('drops the entry with that key and persists it', async () => {
    const file = stateFile();
    const folders = make(file);
    await folders.add(APP);
    await folders.add(LIB);
    await folders.remove('d--fixture-work-app');
    expect(folders.list().map((f) => f.path)).toEqual([LIB]);
    expect(readState(file).folders.map((f) => f.path)).toEqual([LIB]);
  });

  it('answers folder_not_found for a key no user folder has, and writes nothing', async () => {
    const file = stateFile();
    const folders = make(file);
    await folders.add(APP);
    const before = readFileSync(file, 'utf8');
    expect((await failure(folders.remove('d--nope'))).code).toBe('folder_not_found');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('a file that cannot be used', () => {
  it('reads invalid JSON as empty and corrupt, keeps it once as .bad before the next write, then writes', async () => {
    const file = stateFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"schema_version": 1, "folders": [');
    const folders = make(file);
    await folders.load();
    expect(folders.list()).toEqual([]);
    expect(folders.status()).toEqual({ state: 'corrupt', count: 0 });
    expect(readFileSync(file, 'utf8')).toBe('{"schema_version": 1, "folders": [');
    await folders.add(APP);
    expect(readFileSync(`${file}.bad`, 'utf8')).toBe('{"schema_version": 1, "folders": [');
    expect(readState(file).folders.map((f) => f.path)).toEqual([APP]);
    expect(folders.status().state).toBe('ok');
    // corrupt again later: the first .bad stays
    writeFileSync(file, 'second corruption');
    await make(file).add(LIB);
    expect(readFileSync(`${file}.bad`, 'utf8')).toBe('{"schema_version": 1, "folders": [');
    expect(readdirSync(path.dirname(file)).sort()).toEqual(['folders.json', 'folders.json.bad']);
  });

  it.each([
    ['an array', '[1, 2]'],
    ['no schema_version', '{"folders": []}'],
    ['a schema_version that is not 1', '{"schema_version": 0, "folders": []}'],
    ['folders that are no array', '{"schema_version": 1, "folders": {}}'],
  ])('treats %s as corrupt', async (_name, text) => {
    const file = stateFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    const folders = make(file);
    await folders.load();
    expect(folders.status().state).toBe('corrupt');
  });

  it('treats a file over 256 KiB as corrupt without parsing it', async () => {
    const file = stateFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `{"schema_version": 1, "folders": [], "pad": "${'x'.repeat(256 * 1024)}"}`);
    const folders = make(file);
    await folders.load();
    expect(folders.status().state).toBe('corrupt');
  });

  it('refuses every write for a file of a newer format, and leaves it as it is', async () => {
    const file = stateFile();
    mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify({ schema_version: 2, folders: [{ path: APP, somethingNew: true }] });
    writeFileSync(file, text);
    const folders = make(file);
    await folders.load();
    expect(folders.list()).toEqual([]);
    expect(folders.status()).toEqual({ state: 'newer_version', count: 0 });
    expect((await failure(folders.add(APP))).code).toBe('state_unwritable');
    expect((await failure(folders.remove('d--fixture-work-app'))).code).toBe('state_unwritable');
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(readdirSync(path.dirname(file))).toEqual(['folders.json']);
  });

  it('refuses to overwrite a file it could not read', async () => {
    const file = stateFile();
    const fs = fsWithDirs([APP], { readText: () => Promise.resolve({ kind: 'unreadable' }) });
    const folders = make(file, { fs });
    expect((await failure(folders.add(APP))).code).toBe('state_unwritable');
  });

  it('refuses the write when the corrupt file cannot be kept', async () => {
    const file = stateFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'garbage');
    const fs = fsWithDirs([APP], { keepCopy: () => Promise.reject(new Error('no space')) });
    const folders = make(file, { fs });
    expect((await failure(folders.add(APP))).code).toBe('state_unwritable');
    expect(readFileSync(file, 'utf8')).toBe('garbage');
  });
});

describe('what is taken from a valid file', () => {
  it('drops entries that are not usable folders and duplicates, and stops at the limit', async () => {
    const file = stateFile();
    mkdirSync(path.dirname(file), { recursive: true });
    const addedAt = '2026-11-01T08:00:00.000Z';
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        updatedAt: addedAt,
        folders: [
          { path: APP, addedAt },
          { path: 'd:/fixture-work/app/', addedAt },
          { path: '\\\\FIXTURE-host\\share\\dir', addedAt },
          { path: 'relative\\dir', addedAt },
          { path: 42, addedAt },
          'not an object',
          { path: LIB, addedAt: 'not a time' },
          { path: 'D:\\FIXTURE-work\\third', addedAt },
        ],
      }),
    );
    const folders = make(file, { max: 2 });
    await folders.load();
    expect(folders.list().map((f) => f.path)).toEqual([APP, LIB]);
    expect(folders.list()[0]?.addedAtMs).toBe(Date.parse(addedAt));
    expect(folders.list()[1]?.addedAtMs).toBe(0);
    expect(folders.status()).toEqual({ state: 'ok', count: 2 });
  });
});
