// The project key (CAW design 03 2.5, 4.1). Claude Code keeps the transcripts of a working directory in one folder under
// `<claude home>/projects`, named after the directory with every character outside `[A-Za-z0-9]` turned into a dash. That
// folder name, lower-cased, is the key of the project (`projects.project_key`, `SessionSummary.projectId`): a path that a
// person wrote (DA memory, a folder added by hand) joins a Claude folder by this key, with no reverse decoding.
import { clipCodePoints } from '../platform/fsx.ts';
import { projectFolderName } from '../ingest/transcripts/discovery.ts';

/** The names a project folder may have (`projects.dir_name` holds up to 255 characters); anything else is no project. */
export const PROJECT_DIR_NAME_RE = /^[A-Za-z0-9-]{1,255}$/;

/** The longest root path the `projects` table stores. */
const ROOT_PATH_MAX = 1024;

/** The key a working directory gives. `prefix` is true when Claude cut the name at 200 characters (the hash after it is unknown). */
export interface FolderKey {
  readonly key: string;
  readonly prefix: boolean;
}

/** What a `session.seen` says about the project of a session. */
export interface SeenProject {
  /** Lower-cased folder name. */
  readonly key: string;
  /** The folder name as Claude wrote it. */
  readonly dirName: string;
  /** The first working directory the session reported, or null. */
  readonly root: string | null;
}

/** The key of a Claude folder name: lower case, or null when the name cannot be a project folder. */
export function keyOfDirName(dirName: string): string | null {
  return PROJECT_DIR_NAME_RE.test(dirName) ? dirName.toLowerCase() : null;
}

/** The key of a working directory, built on the one folder-name rule of `discovery.ts`. */
export function folderKeyOfPath(directory: string): FolderKey {
  const { name, truncated } = projectFolderName(directory);
  return { key: name.toLowerCase(), prefix: truncated };
}

/**
 * True when the Claude folder `dirName` is the folder of `folder`: the same lower-cased name, or, for a cut name, a name that
 * starts with the cut key and a dash (the rest is the hash Claude appended).
 */
export function dirMatchesKey(dirName: string, folder: FolderKey): boolean {
  const key = keyOfDirName(dirName);
  if (key === null) return false;
  return folder.prefix ? key.startsWith(`${folder.key}-`) : key === folder.key;
}

/** The name of the folder that holds a transcript file, whichever separator the path uses (a hook reports the path of its own OS). */
export function dirNameOfTranscript(transcriptPath: string): string | null {
  const parts = transcriptPath.split(/[\\/]/);
  if (parts.length < 2) return null;
  const name = parts[parts.length - 2];
  return name === undefined || name === '' ? null : name;
}

/**
 * The project of a session from the path of its main transcript file and the working directory it reported. None when there
 * is no path or the folder name is not a project name. The root is the working directory, clipped to the column.
 */
export function projectOfSeen(transcriptPath: string | undefined, cwd: string | undefined): SeenProject | null {
  if (transcriptPath === undefined) return null;
  const dirName = dirNameOfTranscript(transcriptPath);
  if (dirName === null) return null;
  const key = keyOfDirName(dirName);
  if (key === null) return null;
  return { key, dirName, root: cwd === undefined || cwd === '' ? null : clipCodePoints(cwd, ROOT_PATH_MAX) };
}
