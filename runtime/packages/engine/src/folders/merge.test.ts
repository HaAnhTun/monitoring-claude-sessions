// The folder merge (CAW design 03 section 4.3): the DA memory, the Claude home catalog, the folders a person added and the
// project statistics become one list of rows, joined by the project key, with the path of the most human source, the newest
// evidence of activity, the two groups in their order, a fallback row for an empty list and a cap of 500 rows. Pure: every
// input is a literal here and the clock is an argument.
import { folderKeyOfPath } from '../projects/folder-key.ts';
import { FolderListResponseSchema, FolderSchema } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { ProjectStat } from '../query/projects.ts';
import type { CatalogEntry } from './catalog.ts';
import type { DaFolder } from './da-memory.ts';
import { FOLDER_LIST_MAX, mergeFolders, type MergeInput } from './merge.ts';
import type { UserFolder } from './user-folders.ts';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HOME = 'C:\\Users\\fixture-home';

const keyOf = (path: string): string => folderKeyOfPath(path).key;

function da(path: string, o: Partial<DaFolder> = {}): DaFolder {
  return {
    slug: path.replace(/[^A-Za-z0-9]+/g, '-'),
    rawPath: path,
    path,
    lastUpdatedMs: NOW - 5 * MIN,
    summary: 'FIXTURE summary',
    brain: 2,
    action: 1,
    merged: 0,
    ...o,
  };
}

function entry(path: string, o: Partial<CatalogEntry> = {}): CatalogEntry {
  const dirName = path.replace(/[^A-Za-z0-9]/g, '-');
  return {
    dirName,
    key: dirName.toLowerCase(),
    dirMtimeMs: NOW - 3 * DAY,
    root: path,
    rootSource: 'transcript',
    exists: true,
    ...o,
  };
}

function user(path: string, addedAtMs = NOW - DAY): UserFolder {
  return { path, key: keyOf(path), addedAt: new Date(addedAtMs).toISOString(), addedAtMs };
}

function stat(path: string, o: Partial<ProjectStat> = {}): ProjectStat {
  const dirName = path.replace(/[^A-Za-z0-9]/g, '-');
  return {
    key: dirName.toLowerCase(),
    dirName,
    rootPath: path,
    sessionsInWindow: 1,
    activeSessions: 0,
    lastActivityAt: NOW - 2 * DAY,
    totalSessions: 4,
    ...o,
  };
}

function merge(o: Partial<MergeInput> = {}): ReturnType<typeof mergeFolders> {
  return mergeFolders({
    da: [],
    catalog: [],
    user: [],
    stats: [],
    nowMs: NOW,
    homeDir: HOME,
    win32: true,
    ...o,
  });
}

describe('the join by project key', () => {
  it('one row for a folder that the DA memory, the Claude home and a person all name', () => {
    const path = 'D:\\work\\app';
    const rows = merge({
      da: [da(path)],
      catalog: [entry('D:\\work\\app')],
      user: [user(path)],
      stats: [stat(path, { sessionsInWindow: 3, activeSessions: 1, totalSessions: 9, lastActivityAt: NOW - HOUR })],
    });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.key).toBe(keyOf(path));
    expect(row?.name).toBe('app');
    expect(row?.path).toBe(path);
    expect(row?.pathSource).toBe('da');
    expect(row?.origins).toEqual(['da', 'user', 'claude']);
    expect(row?.group).toBe('da');
    expect(row?.userAdded).toBe(true);
    expect(row?.da).toEqual({
      lastUpdatedAt: new Date(NOW - 5 * MIN).toISOString(),
      activity: 'full',
      summary: 'FIXTURE summary',
      brain: 2,
      action: 1,
    });
    expect(row?.claude).toEqual({
      dirName: 'D--work-app',
      sessionsInWindow: 3,
      activeSessions: 1,
      totalSessions: 9,
      lastSessionAt: new Date(NOW - HOUR).toISOString(),
    });
  });

  it('joins a DA path that spells the folder differently (case, separators, a trailing slash) to the Claude folder', () => {
    const rows = merge({
      da: [da('d:/Work/App/')],
      catalog: [entry('D:\\work\\app')],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origins).toEqual(['da', 'claude']);
    expect(rows[0]?.claude?.dirName).toBe('D--work-app');
  });

  it('a cut key (a path over 200 characters) joins the unique Claude folder that starts with it and a dash', () => {
    const long = `D:\\${'a'.repeat(230)}`;
    const cut = folderKeyOfPath(long);
    expect(cut.prefix).toBe(true);
    const dirName = `${cut.key}-hash9`;
    const rows = merge({
      da: [da(long)],
      catalog: [entry(long, { dirName, key: dirName })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe(dirName);
    expect(rows[0]?.origins).toEqual(['da', 'claude']);
  });

  it('a cut key that two Claude folders match joins neither: the DA row stands on its own', () => {
    const long = `D:\\${'a'.repeat(230)}`;
    const cut = folderKeyOfPath(long);
    const one = `${cut.key}-hash1`;
    const two = `${cut.key}-hash2`;
    const rows = merge({
      da: [da(long)],
      catalog: [entry(long, { dirName: one, key: one }), entry(long, { dirName: two, key: two })],
    });
    expect(rows.map((row) => row.key).sort()).toEqual([cut.key, one, two].sort());
  });

  it('a project that only the database knows (the catalog was cut) is a row of its own', () => {
    const rows = merge({ stats: [stat('D:\\work\\gone', { rootPath: null })] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origins).toEqual(['claude']);
    expect(rows[0]?.path).toBeNull();
    expect(rows[0]?.pathSource).toBe('none');
    expect(rows[0]?.canStart).toBe(false);
    expect(rows[0]?.name).toBe('D--work-gone');
  });

  it('two DA entries that give one key become one row: the newest wins, the counts add up', () => {
    const rows = merge({
      da: [
        da('D:\\work\\a-b', { lastUpdatedMs: NOW - HOUR, summary: 'FIXTURE newest', brain: 3, action: 1 }),
        da('D:\\work\\a b', { lastUpdatedMs: NOW - 2 * HOUR, summary: 'FIXTURE older', brain: 1, action: 4 }),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe('D:\\work\\a-b');
    expect(rows[0]?.da).toMatchObject({ summary: 'FIXTURE newest', brain: 4, action: 5 });
  });

  it('a DA entry that is no folder on this host (no path) adds no row', () => {
    const rows = merge({ da: [da('\\\\host\\share', { path: null })], catalog: [] });
    expect(rows[0]?.origins).toEqual(['fallback']);
  });
});

describe('the path of a row: DA, then a person, then the project root, then the catalog', () => {
  const key = 'd--work-app';
  const catalog = entry('D:\\work\\app', { root: 'D:\\WORK\\APP', rootSource: 'reverse' });

  it('DA first', () => {
    const rows = merge({
      da: [da('D:\\work\\app')],
      user: [user('D:\\work\\App')],
      stats: [stat('D:\\Work\\app')],
      catalog: [catalog],
    });
    expect(rows[0]).toMatchObject({ path: 'D:\\work\\app', pathSource: 'da' });
  });

  it('then the folder a person added', () => {
    const rows = merge({ user: [user('D:\\work\\App')], stats: [stat('D:\\Work\\app')], catalog: [catalog] });
    expect(rows[0]).toMatchObject({ key, path: 'D:\\work\\App', pathSource: 'user' });
  });

  it('then the root the project reported', () => {
    const rows = merge({ stats: [stat('D:\\Work\\app')], catalog: [catalog] });
    expect(rows[0]).toMatchObject({ path: 'D:\\Work\\app', pathSource: 'project' });
  });

  it('then the root of the catalog, with the way it was found', () => {
    expect(merge({ catalog: [catalog] })[0]).toMatchObject({ path: 'D:\\WORK\\APP', pathSource: 'reverse' });
    const sniffed = entry('D:\\work\\app', { root: 'D:\\work\\app', rootSource: 'transcript' });
    expect(merge({ catalog: [sniffed] })[0]).toMatchObject({ pathSource: 'transcript' });
  });

  it('a root that cannot be a folder here (a UNC path) is skipped, never shown', () => {
    const rows = merge({
      stats: [stat('\\\\host\\share\\app', { key, dirName: 'D--work-app' })],
      catalog: [entry('D:\\work\\app', { root: null, rootSource: null, exists: null })],
    });
    expect(rows[0]).toMatchObject({ path: null, pathSource: 'none', canStart: false });
  });
});

describe('exists and canStart', () => {
  it('a catalog root brings its own check; a DA or user path takes the one the caller made', () => {
    const rows = merge({
      da: [da('D:\\work\\gone-da')],
      user: [user('D:\\work\\there-user')],
      catalog: [entry('D:\\work\\gone-claude', { exists: false })],
      exists: new Map([
        ['d:\\work\\gone-da', false],
        ['d:\\work\\there-user', true],
      ]),
    });
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get('gone-da')).toMatchObject({ exists: false, canStart: false });
    expect(byName.get('there-user')).toMatchObject({ exists: true, canStart: true });
    expect(byName.get('gone-claude')).toMatchObject({ exists: false, canStart: false });
  });

  it('an unchecked path is not known to be missing: it can start', () => {
    const rows = merge({ da: [da('D:\\work\\unchecked')] });
    expect(rows[0]).toMatchObject({ exists: null, canStart: true });
  });
});

describe('activity', () => {
  it('is the newest of the DA time, the project time and the folder time, and the mark follows it', () => {
    const path = 'D:\\work\\app';
    const rows = merge({
      da: [da(path, { lastUpdatedMs: NOW - 5 * DAY })],
      catalog: [entry(path, { dirMtimeMs: NOW - 4 * DAY })],
      stats: [stat(path, { lastActivityAt: NOW - HOUR })],
    });
    expect(rows[0]?.lastActivityAt).toBe(new Date(NOW - HOUR).toISOString());
    expect(rows[0]?.activity).toBe('full');
    // the DA block keeps the pure DA mark
    expect(rows[0]?.da?.activity).toBe('none');
  });

  it('a row with no time at all is none with a null time', () => {
    const rows = merge({ user: [user('D:\\work\\app')] });
    expect(rows[0]).toMatchObject({ lastActivityAt: null, activity: 'none' });
  });

  it('the claude block has no last session when the project holds none', () => {
    const rows = merge({
      stats: [stat('D:\\work\\app', { totalSessions: 0, sessionsInWindow: 0, lastActivityAt: NOW })],
    });
    expect(rows[0]?.claude?.lastSessionAt).toBeNull();
  });
});

describe('groups and order', () => {
  it('folders outside the DA memory come first, newest first; the DA folders follow in the DA order', () => {
    const rows = merge({
      da: [
        da('D:\\work\\da-new', { lastUpdatedMs: NOW - HOUR }),
        da('D:\\work\\da-old', { lastUpdatedMs: NOW - 9 * DAY }),
      ],
      catalog: [
        entry('D:\\work\\out-old', { dirMtimeMs: NOW - 8 * DAY }),
        entry('D:\\work\\out-new', { dirMtimeMs: NOW - 2 * DAY }),
        entry('D:\\work\\da-new'),
      ],
    });
    expect(rows.map((row) => `${row.group}:${row.name}`)).toEqual([
      'outside-da:out-new',
      'outside-da:out-old',
      'da:da-new',
      'da:da-old',
    ]);
  });

  it('a folder a person just added is on top of the outside group, whatever its activity', () => {
    const rows = merge({
      catalog: [entry('D:\\work\\busy', { dirMtimeMs: NOW - HOUR })],
      user: [user('D:\\work\\fresh', NOW - MIN)],
    });
    expect(rows.map((row) => row.name)).toEqual(['fresh', 'busy']);
  });

  it('ties are broken by name, then by key', () => {
    const rows = merge({
      catalog: [
        entry('D:\\work\\b-two', { dirMtimeMs: NOW - DAY }),
        entry('D:\\work\\a-one', { dirMtimeMs: NOW - DAY }),
        entry('E:\\work\\a-one', { dirMtimeMs: NOW - DAY }),
      ],
    });
    expect(rows.map((row) => row.key)).toEqual(['d--work-a-one', 'e--work-a-one', 'd--work-b-two']);
  });

  it('the order does not depend on the order of the inputs', () => {
    const catalog = [
      entry('D:\\work\\x', { dirMtimeMs: NOW - DAY }),
      entry('D:\\work\\y', { dirMtimeMs: NOW - 2 * DAY }),
    ];
    const forward = merge({ catalog });
    const backward = merge({ catalog: [...catalog].reverse() });
    expect(backward).toEqual(forward);
  });
});

describe('the fallback row', () => {
  it('an empty list gets one row for the home directory, so the column is never empty', () => {
    const rows = merge();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'fixture-home',
      path: HOME,
      origins: ['fallback'],
      group: 'outside-da',
      activity: 'none',
      lastActivityAt: null,
      da: null,
      claude: null,
      userAdded: false,
      canStart: true,
    });
    expect(FolderSchema.safeParse(rows[0]).success).toBe(true);
  });

  it('there is none when something is listed, and none without a home directory', () => {
    expect(merge({ user: [user('D:\\work\\app')] }).map((row) => row.origins)).toEqual([['user']]);
    expect(merge({ homeDir: null })).toEqual([]);
  });

  it('a home directory that cannot be a folder here gives no row', () => {
    expect(merge({ homeDir: '\\\\host\\share' })).toEqual([]);
  });
});

describe('the cap', () => {
  it('keeps at most 500 rows and drops the oldest folders outside the DA memory first', () => {
    const catalog: CatalogEntry[] = [];
    for (let i = 0; i < 520; i += 1) {
      catalog.push(entry(`D:\\work\\p${String(i).padStart(4, '0')}`, { dirMtimeMs: NOW - (i + 1) * MIN }));
    }
    const rows = merge({ catalog, da: [da('D:\\work\\keeper', { lastUpdatedMs: NOW - 400 * DAY })] });
    expect(rows).toHaveLength(FOLDER_LIST_MAX);
    expect(rows[rows.length - 1]?.name).toBe('keeper');
    expect(rows[0]?.name).toBe('p0000');
    expect(rows.some((row) => row.name === 'p0519')).toBe(false);
    expect(rows.some((row) => row.name === 'p0498')).toBe(true);
  });

  it('a DA list as long as the cap leaves no room for the others', () => {
    const many = Array.from({ length: 500 }, (_, i) => da(`D:\\da\\d${String(i)}`, { lastUpdatedMs: NOW - i * MIN }));
    const rows = merge({ da: many, catalog: [entry('D:\\work\\other')] });
    expect(rows).toHaveLength(500);
    expect(rows.every((row) => row.group === 'da')).toBe(true);
  });

  it('every row of a full list fits the wire schema', () => {
    const rows = merge({
      da: [da('D:\\work\\app')],
      catalog: [entry('D:\\work\\app'), entry('D:\\work\\other')],
      user: [user('D:\\work\\mine')],
      stats: [stat('D:\\work\\app')],
    });
    const list = {
      folders: rows,
      sources: {
        daMemory: { status: 'ok', folders: 1, readAt: null },
        claudeHome: { status: 'ok', folders: 2, scannedAt: null, truncated: false },
        userFolders: { status: 'ok', count: 1 },
      },
      asOf: new Date(NOW).toISOString(),
    };
    expect(FolderListResponseSchema.safeParse(list).success).toBe(true);
  });
});
