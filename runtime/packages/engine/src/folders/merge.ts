// The folder merge (CAW design 03 section 4.3): the DA memory, the catalog of the Claude home, the folders a person added and the
// statistics of the projects in the database become one list of rows. Pure: every input is an argument, the clock included.
//
//   1. Bucket by project key. A catalog entry and a project statistic bring the exact key of the Claude folder; a DA or user path
//      brings `folderKeyOfPath`. A key that Claude cut at 200 characters (`prefix`) joins the one Claude folder that starts with it
//      and a dash; when none or several do, the path stands on its own key.
//   2. The path of a row is the most human spelling: DA, then a person's, then the root the project reported, then the root of the
//      catalog. A path that cannot be a folder on this host (a UNC or device path) is never shown.
//   3. `lastActivityAt` is the newest of the DA time, the project time and the folder time; `activity` is its mark. The DA block
//      keeps the pure DA mark.
//   4. Two groups: folders outside the DA memory first (newest first, a folder just added is on top), then the DA folders in the
//      order the DA memory gave. An empty list gets one row for the home directory.
//   5. At most 500 rows; the oldest folders outside the DA memory go first.
import {
  activityMarkOf,
  folderPathKey,
  lastSegment,
  windowsFolderPath,
  type Folder,
  type FolderOrigin,
  type FolderPathSource,
} from '@mcs/shared';

import { hostPlatform } from '../platform/host.ts';
import { folderKeyOfPath } from '../projects/folder-key.ts';
import type { ProjectStat } from '../query/projects.ts';
import type { CatalogEntry } from './catalog.ts';
import type { DaFolder } from './da-memory.ts';
import type { UserFolder } from './user-folders.ts';

/** Rows of a list at most (the wire schema says the same). */
export const FOLDER_LIST_MAX = 500;
/** The widest path and name the wire row holds. */
const PATH_MAX = 1024;
const NAME_MAX = 255;

export interface MergeInput {
  /** The folders of the DA memory, newest first (the order of the reader). */
  readonly da: readonly DaFolder[];
  readonly catalog: readonly CatalogEntry[];
  readonly user: readonly UserFolder[];
  readonly stats: readonly ProjectStat[];
  readonly nowMs: number;
  /** Whether a path is a folder now, by `folderPathKey`, as far as the caller has checked; an absent path is "not known". */
  readonly exists?: ReadonlyMap<string, boolean>;
  /** The home directory of the person: the one row of an otherwise empty list; null for no such row. */
  readonly homeDir: string | null;
  /** Which spelling of a path is valid (default: the host). */
  readonly win32?: boolean;
  /** At most this many rows (default 500). */
  readonly maxRows?: number;
}

interface DaPart {
  readonly folder: DaFolder;
  readonly order: number;
  readonly brain: number;
  readonly action: number;
}

interface Bucket {
  readonly key: string;
  catalog: CatalogEntry | undefined;
  stat: ProjectStat | undefined;
  da: DaPart | undefined;
  user: UserFolder | undefined;
  /** The newest time a person added a folder of this bucket (ordering only). */
  addedAtMs: number;
}

interface Ranked {
  readonly row: Folder;
  readonly sortMs: number;
  readonly order: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function clip(text: string, max: number): string {
  return text.length <= max ? text : Array.from(text).slice(0, max).join('').slice(0, max);
}

/** The project key a path joins: exact, or the unique Claude key that starts with a cut key. */
function joinKey(path: string, claudeKeys: readonly string[]): string {
  const folder = folderKeyOfPath(path);
  if (!folder.prefix) return folder.key;
  const matches = claudeKeys.filter((key) => key.startsWith(`${folder.key}-`));
  return matches.length === 1 && matches[0] !== undefined ? matches[0] : folder.key;
}

function newestMs(values: readonly (number | null | undefined)[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

/** A path as a row shows it: normalized for this host, within the column, or null. */
function shown(raw: string | null | undefined, win32: boolean): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const normalized = windowsFolderPath(raw, win32);
  return normalized === null || normalized.length > PATH_MAX ? null : normalized;
}

export function mergeFolders(input: MergeInput): Folder[] {
  const win32 = input.win32 ?? hostPlatform === 'win32';
  const maxRows = input.maxRows ?? FOLDER_LIST_MAX;
  const buckets = new Map<string, Bucket>();
  const bucketOf = (key: string): Bucket => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { key, catalog: undefined, stat: undefined, da: undefined, user: undefined, addedAtMs: 0 };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  // the exact keys first: a path joins them below
  for (const entry of input.catalog) bucketOf(entry.key).catalog = entry;
  for (const stat of input.stats) bucketOf(stat.key).stat = stat;
  const claudeKeys = [...buckets.keys()];

  input.da.forEach((folder, order) => {
    if (folder.path === null) return;
    const bucket = bucketOf(joinKey(folder.path, claudeKeys));
    if (bucket.da === undefined) {
      bucket.da = { folder, order, brain: folder.brain, action: folder.action };
    } else {
      bucket.da = { ...bucket.da, brain: bucket.da.brain + folder.brain, action: bucket.da.action + folder.action };
    }
  });
  for (const folder of input.user) {
    const bucket = bucketOf(joinKey(folder.path, claudeKeys));
    bucket.user ??= folder;
    bucket.addedAtMs = Math.max(bucket.addedAtMs, folder.addedAtMs);
  }

  const ranked: Ranked[] = [];
  for (const bucket of buckets.values()) ranked.push(rowOf(bucket, input.nowMs, win32, input.exists));

  const outside = ranked
    .filter((entry) => entry.row.group === 'outside-da')
    .sort((a, b) => b.sortMs - a.sortMs || compareText(a.row.name, b.row.name) || compareText(a.row.key, b.row.key));
  const inDa = ranked.filter((entry) => entry.row.group === 'da').sort((a, b) => a.order - b.order);

  let rows = [...outside, ...inDa].map((entry) => entry.row);
  if (rows.length > maxRows) {
    const drop = rows.length - maxRows;
    rows =
      drop <= outside.length
        ? [...outside.slice(0, outside.length - drop), ...inDa].map((e) => e.row)
        : rows.slice(0, maxRows);
  }
  if (rows.length === 0) {
    const home = homeRow(input.homeDir, win32, input.exists);
    if (home !== null) rows = [home];
  }
  return rows;
}

function rowOf(
  bucket: Bucket,
  nowMs: number,
  win32: boolean,
  existence: ReadonlyMap<string, boolean> | undefined,
): Ranked {
  const { catalog, stat, da, user } = bucket;
  const candidates: readonly { readonly path: string | null; readonly source: FolderPathSource }[] = [
    { path: shown(da?.folder.path, win32), source: 'da' },
    { path: shown(user?.path, win32), source: 'user' },
    { path: shown(stat?.rootPath, win32), source: 'project' },
    { path: shown(catalog?.root, win32), source: catalog?.rootSource ?? 'none' },
  ];
  const winner = candidates.find((candidate) => candidate.path !== null);
  const path = winner?.path ?? null;
  const pathSource: FolderPathSource = winner === undefined ? 'none' : winner.source;

  let exists: boolean | null = null;
  if (path !== null) {
    const pathKey = folderPathKey(path);
    const checked = existence?.get(pathKey);
    if (checked !== undefined) exists = checked;
    else if (catalog?.root !== null && catalog?.root !== undefined && folderPathKey(catalog.root) === pathKey) {
      exists = catalog.exists;
    }
  }

  const dirName = catalog?.dirName ?? stat?.dirName ?? null;
  const name = clip(path === null ? (dirName ?? bucket.key) : lastSegment(path) || (dirName ?? bucket.key), NAME_MAX);
  const lastActivityMs = newestMs([da?.folder.lastUpdatedMs, stat?.lastActivityAt, catalog?.dirMtimeMs]);

  const origins: FolderOrigin[] = [];
  if (da !== undefined) origins.push('da');
  if (user !== undefined) origins.push('user');
  if (catalog !== undefined || stat !== undefined) origins.push('claude');

  const row: Folder = {
    key: bucket.key,
    name,
    path,
    pathSource,
    exists,
    origins,
    group: da === undefined ? 'outside-da' : 'da',
    activity: activityMarkOf(lastActivityMs, nowMs),
    lastActivityAt: lastActivityMs === null ? null : iso(lastActivityMs),
    da:
      da === undefined
        ? null
        : {
            lastUpdatedAt: da.folder.lastUpdatedMs === null ? null : iso(da.folder.lastUpdatedMs),
            activity: activityMarkOf(da.folder.lastUpdatedMs, nowMs),
            summary: da.folder.summary,
            brain: da.brain,
            action: da.action,
          },
    claude:
      dirName === null
        ? null
        : {
            dirName,
            sessionsInWindow: stat?.sessionsInWindow ?? 0,
            activeSessions: stat?.activeSessions ?? 0,
            totalSessions: stat?.totalSessions ?? 0,
            lastSessionAt:
              stat === undefined || stat.totalSessions === 0 || stat.lastActivityAt <= 0
                ? null
                : iso(stat.lastActivityAt),
          },
    canStart: path !== null && exists !== false,
    userAdded: user !== undefined,
  };
  return {
    row,
    sortMs: Math.max(
      lastActivityMs ?? Number.MIN_SAFE_INTEGER,
      bucket.addedAtMs > 0 ? bucket.addedAtMs : Number.MIN_SAFE_INTEGER,
    ),
    order: da?.order ?? 0,
  };
}

/** The one row of an empty list: where a terminal can always start. */
function homeRow(
  homeDir: string | null,
  win32: boolean,
  existence: ReadonlyMap<string, boolean> | undefined,
): Folder | null {
  const path = shown(homeDir, win32);
  if (path === null) return null;
  const exists = existence?.get(folderPathKey(path)) ?? null;
  const key = folderKeyOfPath(path).key;
  return {
    key: key === '' ? 'home' : key,
    name: clip(lastSegment(path) || 'home', NAME_MAX),
    path,
    pathSource: 'none',
    exists,
    origins: ['fallback'],
    group: 'outside-da',
    activity: 'none',
    lastActivityAt: null,
    da: null,
    claude: null,
    canStart: exists !== false,
    userAdded: false,
  };
}
