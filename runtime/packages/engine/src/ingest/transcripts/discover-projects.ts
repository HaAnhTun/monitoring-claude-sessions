// Discovery over every project folder of the Claude home (CAW design 03 2.2): the user instance reads the transcripts of all
// projects, not of one repository. `discovery.ts` stays the engine for one folder; this file decides which folders exist, which of
// them are worth a look on a tick, and where a session id lives when a registry entry names one this instance has not seen.
//
// Listing the folders costs one `readdir` and one `lstat` per folder. Looking into a folder costs a `readdir` and a batched `lstat`
// of its files, so a tick looks only into the folders that are hot (they hold a tracked file that is still active), whose
// modification time changed (a new session file appeared) or that were hinted; a full sweep over every folder runs once per
// interval, because an old file that grew leaves the modification time of its folder alone.
import { SID_RE } from '@mcs/shared/protocol';
import path from 'node:path';

import { discoverSession, mapLimit, nodeDiscoveryFs, type DiscoveredSession, type DiscoveryFs } from './discovery.ts';

export { mapLimit };

/** The name of a folder below `<claude home>/projects`: what Claude Code makes of a path, which is `[A-Za-z0-9-]` only. */
export const PROJECT_FOLDER_NAME_RE = /^[A-Za-z0-9-]{1,255}$/;
/** Folders looked at together (the `lstat` of a listing, the main-file probe of a session search). */
export const FOLDER_PARALLEL = 32;

export interface ProjectFolder {
  readonly name: string;
  readonly dir: string;
  readonly mtimeMs: number;
}

export interface ProjectFolderList {
  readonly folders: ProjectFolder[];
  /** The projects folder itself could not be listed. */
  readonly missing: boolean;
  /** Links and junctions that were seen and not entered. */
  readonly linksSkipped: number;
  /** Entries that are no project folder: an odd name, a file, an entry that vanished. */
  readonly ignored: number;
}

/**
 * One level of `<home>/projects`: real folders only (a link or junction is counted, never entered), names of the form
 * `PROJECT_FOLDER_NAME_RE`, newest modification time first and ties by name. An odd name (a dot file, a `.key`, a space) is
 * counted as ignored without being looked at.
 */
export async function listProjectFolders(root: string, fs: DiscoveryFs = nodeDiscoveryFs): Promise<ProjectFolderList> {
  let names: readonly string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return { folders: [], missing: true, linksSkipped: 0, ignored: 0 };
  }
  const candidates = names.filter((name) => PROJECT_FOLDER_NAME_RE.test(name));
  let ignored = names.length - candidates.length;
  let linksSkipped = 0;
  const looked = await mapLimit(candidates, FOLDER_PARALLEL, async (name) => ({
    name,
    stat: await fs.lstat(path.join(root, name)),
  }));
  const folders: ProjectFolder[] = [];
  for (const { name, stat } of looked) {
    if (stat?.kind === 'link') linksSkipped += 1;
    else if (stat?.kind === 'dir') folders.push({ name, dir: path.join(root, name), mtimeMs: stat.mtimeMs });
    else ignored += 1;
  }
  folders.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { folders, missing: false, linksSkipped, ignored };
}

/** What the importer remembers between two ticks. `selectFolders` only reads it. */
export interface SweepState {
  /** When the last full sweep started; null before the first. */
  readonly lastFullAt: number | null;
  /** The modification time of each folder at the last look into it. */
  readonly mtimes: ReadonlyMap<string, number>;
}

export interface SelectOptions {
  readonly fullSweepIntervalMs: number;
  /** Folders that hold a tracked file that is still active. */
  readonly hot: ReadonlySet<string>;
  /** Folders a registry entry or the linker pointed at. */
  readonly hinted: ReadonlySet<string>;
}

/**
 * Pure: which folders to look into this tick, in the order of `list` (newest first). `full` when the first sweep or the
 * interval is due: then every folder. Otherwise the folders that are hot, hinted, new, or whose modification time differs from
 * the last look; a quiet tick chooses none.
 */
export function selectFolders(
  list: readonly ProjectFolder[],
  state: SweepState,
  nowMs: number,
  options: SelectOptions,
): { chosen: ProjectFolder[]; full: boolean } {
  const full = state.lastFullAt === null || nowMs - state.lastFullAt >= options.fullSweepIntervalMs;
  if (full) return { chosen: [...list], full };
  const chosen = list.filter(
    (folder) =>
      options.hot.has(folder.name) ||
      options.hinted.has(folder.name) ||
      state.mtimes.get(folder.name) !== folder.mtimeMs,
  );
  return { chosen, full };
}

/**
 * The folder that holds a session id which a registry entry or the linker names: `firstFolder` (the folder name derived from
 * the working directory) first, then one `lstat` of `<folder>/<id>.jsonl` in every project folder, newest folder first; then
 * `discoverSession` in the folder that has it, whatever the age policy says. The id is validated before any path is built;
 * `firstFolder` must look like a project folder name or it is not used. Null when no folder has the session.
 */
export async function discoverSessionAnywhere(
  root: string,
  sessionId: string,
  fs: DiscoveryFs = nodeDiscoveryFs,
  firstFolder?: string,
): Promise<{ dir: string; session: DiscoveredSession } | null> {
  if (!SID_RE.test(sessionId)) return null;
  let tried: string | null = null;
  if (firstFolder !== undefined && PROJECT_FOLDER_NAME_RE.test(firstFolder)) {
    tried = firstFolder;
    const dir = path.join(root, firstFolder);
    const session = await discoverSession(dir, sessionId, fs);
    if (session !== null) return { dir, session };
  }
  const list = await listProjectFolders(root, fs);
  const others = list.folders.filter((folder) => folder.name !== tried);
  const hasMain = await mapLimit(others, FOLDER_PARALLEL, async (folder) => {
    const stat = await fs.lstat(path.join(folder.dir, `${sessionId}.jsonl`));
    return stat?.kind === 'file';
  });
  const hit = others.find((_, at) => hasMain[at] === true);
  if (hit === undefined) return null;
  const session = await discoverSession(hit.dir, sessionId, fs);
  return session === null ? null : { dir: hit.dir, session };
}
