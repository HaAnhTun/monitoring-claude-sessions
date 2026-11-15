// The root folder of a Claude project folder (CAW design 03 section 4.2). Claude Code names a project folder after the working
// directory, every character outside `[A-Za-z0-9]` turned into a dash, so the name alone cannot tell `D:\mcs\v4` from
// `D:\mcs-v4`. Two sources, in this order:
//
// 1. `readProjectRoot`: the `cwd` of the first record that has one among the first 61 lines of the three newest main
//    transcripts (`firstCwd`, the function `detectTranscriptsDir` uses), passed through `windowsFolderPath`.
// 2. `reverseProjectName`: for a folder without a main transcript, a depth-first walk of the file system that is guided by the
//    name. It is exact where the folder exists and `null` where it does not: never a guess.
import path from 'node:path';

import { windowsFolderPath } from '@mcs/shared';
import { SID_RE } from '@mcs/shared/protocol';

import { PROJECT_FOLDER_NAME_RE } from '../ingest/transcripts/discover-projects.ts';
import { firstCwd, mapLimit, sanitizeProjectName, type DiscoveryFs } from '../ingest/transcripts/discovery.ts';

/** Main transcripts whose first lines are looked at. */
const NEWEST_MAIN_FILES = 3;
/** Names of one folder that are looked at (a project folder holds a file per session). */
const MAX_NAMES = 5000;
const STAT_PARALLEL = 16;
/** `readdir` calls of one decode. */
export const REVERSE_MAX_READDIRS = 64;
/** Entries of one directory that a decode considers. */
export const REVERSE_MAX_ENTRIES = 5000;

const MAIN_SUFFIX = '.jsonl';

export interface ProjectRootOptions {
  readonly win32: boolean;
}

/**
 * The working directory of a project folder from its newest transcripts. One `readdir` and a batched `lstat` find the three
 * newest main files (`<session id>.jsonl`; agent files, folders and every other name are left alone); the first of them that
 * names a `cwd` which is a usable folder on this host wins. Null when no file does.
 */
export async function readProjectRoot(
  fs: DiscoveryFs,
  dir: string,
  options: ProjectRootOptions,
): Promise<{ root: string; source: 'transcript' } | null> {
  let names: readonly string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const mains = names
    .filter((name) => name.endsWith(MAIN_SUFFIX) && SID_RE.test(name.slice(0, -MAIN_SUFFIX.length)))
    .slice(0, MAX_NAMES);
  const looked = await mapLimit(mains, STAT_PARALLEL, async (name) => ({
    name,
    stat: await fs.lstat(path.join(dir, name)),
  }));
  const newest = looked
    .filter((entry) => entry.stat?.kind === 'file')
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, NEWEST_MAIN_FILES);
  for (const { name } of newest) {
    const cwd = await firstCwd(fs, path.join(dir, name));
    if (cwd === '') continue;
    const root = windowsFolderPath(cwd, options.win32);
    if (root !== null) return { root, source: 'transcript' };
  }
  return null;
}

// ---- the decode ------------------------------------------------------------------------------------------------------------------

export interface ReverseOptions {
  readonly win32: boolean;
  /** `readdir` calls allowed (default 64). */
  readonly maxReaddirs?: number;
}

interface Candidate {
  readonly name: string;
  readonly text: string;
}

/**
 * The folder that `dirName` was made from, found by walking the file system. The name `D--work-app` starts at `D:\` (a name that
 * starts with a dash starts at `/`); in each directory the entries are tried by the length of their sanitized name, longest
 * first, and an entry is entered when the rest of the name equals it (the answer: it must be a real folder) or starts with it and
 * a dash (the dash is the separator). A dot folder sanitizes to `-name`, which is the `--` in `D--work--claude`. Case is ignored
 * on Windows, not elsewhere. At most `maxReaddirs` calls (64) and 5,000 entries of a directory; links are never entered.
 */
export async function reverseProjectName(
  dirName: string,
  fs: DiscoveryFs,
  options: ReverseOptions,
): Promise<string | null> {
  if (!PROJECT_FOLDER_NAME_RE.test(dirName)) return null;
  const { win32 } = options;
  const sep = win32 ? String.fromCharCode(92) : '/';
  let start: string;
  let rest: string;
  const drive = /^([A-Za-z])--(.+)$/.exec(dirName);
  if (win32 && drive !== null) {
    start = `${(drive[1] ?? '').toUpperCase()}:${sep}`;
    rest = drive[2] ?? '';
  } else if (!win32 && dirName.startsWith('-') && dirName.length > 1) {
    start = '/';
    rest = dirName.slice(1);
  } else {
    return null;
  }
  let readdirs = 0;
  const budget = options.maxReaddirs ?? REVERSE_MAX_READDIRS;
  const fold = (text: string): string => (win32 ? text.toLowerCase() : text);

  async function walk(dir: string, remaining: string): Promise<string | null> {
    if (readdirs >= budget) return null;
    readdirs += 1;
    let names: readonly string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return null;
    }
    const candidates: Candidate[] = names
      .filter((name) => name !== '' && name !== '.' && name !== '..')
      .slice(0, REVERSE_MAX_ENTRIES)
      .map((name) => ({ name, text: fold(sanitizeProjectName(name)) }))
      .sort((a, b) => b.text.length - a.text.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const wanted = fold(remaining);
    for (const { name, text } of candidates) {
      const child = dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
      if (text === wanted) {
        if ((await fs.lstat(child))?.kind === 'dir') return child;
      } else if (wanted.length > text.length + 1 && wanted.startsWith(`${text}-`)) {
        if ((await fs.lstat(child))?.kind !== 'dir') continue;
        const found = await walk(child, remaining.slice(text.length + 1));
        if (found !== null) return found;
        if (readdirs >= budget) return null;
      }
    }
    return null;
  }

  return walk(start, rest);
}
