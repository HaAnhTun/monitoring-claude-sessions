// `globFiles(pattern, base, opts)` (06 3.9.4): the one glob of the engine, used for `live_log_globs`.
//   - the pattern is absolute (drive letter, UNC, leading separator) or relative to `base`; `/` and `\` both separate;
//   - segment syntax: `*`, `?`, `[abc]`, `[a-z]`, `[!abc]`; a whole segment `**` is zero or more directories
//     (deliberate deviation from Python, where `**` without `recursive` behaves like `*`, E17);
//   - names that start with `.` match only a segment that starts with `.`; `**` never enters a dot folder;
//   - case-insensitive on win32 and darwin; `**` and wildcard segments do not descend into symbolic links or junctions
//     to folders (a literal folder name in the pattern is followed: the pattern names it on purpose);
//   - stops after `maxMatches` files, and below the first wildcard segment after `maxDepth` folders.
// `fs.glob` is not used: it is experimental on part of the supported Node range and its `**` would bind us to a Node version.
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { pathsCaseInsensitive } from './host.ts';

export interface GlobOptions {
  /** Stop after this many files (default 500). */
  maxMatches?: number;
  /** Folders below the first wildcard segment that are entered (default 8). */
  maxDepth?: number;
}

export interface GlobResult {
  /** Matching files, in traversal order (names sorted within a folder). */
  files: string[];
  /** True when more files matched than `maxMatches` allowed. */
  truncated: boolean;
}

const DEFAULT_MAX_MATCHES = 500;
const DEFAULT_MAX_DEPTH = 8;

const DRIVE_ROOT = /^[A-Za-z]:\//;
const UNC_ROOT = /^\/\/[^/]+\/[^/]+/;
function hasMagic(segment: string): boolean {
  return /[*?[]/.test(segment);
}

/** One element of a compiled segment. Matching is done on code points, never with a regular expression. */
type Token =
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'char'; ch: string }
  | { kind: 'class'; negate: boolean; singles: ReadonlySet<string>; ranges: readonly (readonly [number, number])[] };

/** Parses the character class that starts at `segment[open]` (`[abc]`, `[a-z]`, `[!abc]`); null when it is not closed. */
function parseClass(segment: string, open: number): { token: Token; next: number } | null {
  let i = open + 1;
  let negate = false;
  if (segment.charAt(i) === '!') {
    negate = true;
    i += 1;
  }
  const first = i;
  if (segment.charAt(i) === ']') i += 1;
  const close = segment.indexOf(']', i);
  if (close < 0) return null;
  const chars = Array.from(segment.slice(first, close));
  const singles = new Set<string>();
  const ranges: (readonly [number, number])[] = [];
  for (let k = 0; k < chars.length; k += 1) {
    const ch = chars[k] ?? '';
    const hi = chars[k + 2];
    if (chars[k + 1] === '-' && hi !== undefined) {
      ranges.push([ch.codePointAt(0) ?? 0, hi.codePointAt(0) ?? 0]);
      k += 2;
    } else {
      singles.add(ch);
    }
  }
  return { token: { kind: 'class', negate, singles, ranges }, next: close + 1 };
}

function compileTokens(segment: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < segment.length;) {
    const ch = segment.charAt(i);
    if (ch === '*') {
      // A run of stars is one star: it keeps the matcher linear.
      if (tokens[tokens.length - 1]?.kind !== 'star') tokens.push({ kind: 'star' });
      i += 1;
    } else if (ch === '?') {
      tokens.push({ kind: 'any' });
      i += 1;
    } else if (ch === '[') {
      const parsed = parseClass(segment, i);
      if (parsed === null) {
        tokens.push({ kind: 'char', ch });
        i += 1;
      } else {
        tokens.push(parsed.token);
        i = parsed.next;
      }
    } else {
      const point = String.fromCodePoint(segment.codePointAt(i) ?? 0);
      tokens.push({ kind: 'char', ch: point });
      i += point.length;
    }
  }
  return tokens;
}

function inClass(token: Extract<Token, { kind: 'class' }>, ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return token.singles.has(ch) || token.ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

/** Matches one name against a compiled segment in O(name x pattern): no catastrophic backtracking on `*a*a*a*b`. */
function compileSegment(segment: string, ignoreCase: boolean): (name: string) => boolean {
  const tokens = compileTokens(segment);
  const same = (a: string, b: string): boolean => a === b || (ignoreCase && a.toLowerCase() === b.toLowerCase());
  const single = (token: Token, ch: string): boolean => {
    switch (token.kind) {
      case 'any':
        return true;
      case 'char':
        return same(token.ch, ch);
      case 'class': {
        const hit =
          inClass(token, ch) || (ignoreCase && (inClass(token, ch.toLowerCase()) || inClass(token, ch.toUpperCase())));
        return hit !== token.negate;
      }
      case 'star':
        return false;
    }
  };
  return (name) => {
    const chars = Array.from(name);
    let t = 0;
    let n = 0;
    let starAt = -1;
    let starFrom = 0;
    while (n < chars.length) {
      const token = tokens[t];
      if (token?.kind === 'star') {
        starAt = t;
        starFrom = n;
        t += 1;
      } else if (token !== undefined && single(token, chars[n] ?? '')) {
        t += 1;
        n += 1;
      } else if (starAt >= 0) {
        starFrom += 1;
        n = starFrom;
        t = starAt + 1;
      } else {
        return false;
      }
    }
    while (tokens[t]?.kind === 'star') t += 1;
    return t === tokens.length;
  };
}

function splitPattern(pattern: string, base: string): { root: string; segments: string[] } {
  const normalized = pattern.replaceAll('\\', '/');
  let root: string;
  let rest: string;
  const drive = DRIVE_ROOT.exec(normalized);
  const unc = UNC_ROOT.exec(normalized);
  if (drive !== null) {
    root = drive[0];
    rest = normalized.slice(root.length);
  } else if (unc !== null) {
    root = unc[0];
    rest = normalized.slice(root.length);
  } else if (normalized.startsWith('/')) {
    root = path.resolve('/');
    rest = normalized.slice(1);
  } else {
    root = path.resolve(base);
    rest = normalized;
  }
  const segments = rest.split('/').filter((segment) => segment !== '' && segment !== '.');
  // A trailing `**` means every file below: `**/*`.
  if (segments[segments.length - 1] === '**') segments.push('*');
  return { root, segments };
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    // Missing, not a folder, or no access: nothing to list here.
    return [];
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** Files matching `pattern`; folders are never returned. A missing base or an empty pattern gives no files. */
export async function globFiles(pattern: string, base: string, opts: GlobOptions = {}): Promise<GlobResult> {
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (pattern === '') return { files: [], truncated: false };
  const { root, segments } = splitPattern(pattern, base);
  if (segments.length === 0) return { files: [], truncated: false };

  const files: string[] = [];
  const seen = new Set<string>();
  // Mutated from the closures below: an object keeps the compiler from narrowing the flag to a constant.
  const state = { truncated: false };
  const capped = (): boolean => state.truncated;
  const compiled = new Map<string, (name: string) => boolean>();
  const matcherFor = (segment: string): ((name: string) => boolean) => {
    let matches = compiled.get(segment);
    if (matches === undefined) {
      matches = compileSegment(segment, pathsCaseInsensitive);
      compiled.set(segment, matches);
    }
    return matches;
  };

  const add = (file: string): void => {
    const key = pathsCaseInsensitive ? file.toLowerCase() : file;
    if (seen.has(key)) return;
    if (files.length >= maxMatches) {
      state.truncated = true;
      return;
    }
    seen.add(key);
    files.push(file);
  };

  const walk = async (dir: string, index: number, depth: number): Promise<void> => {
    if (capped()) return;
    const segment = segments[index];
    if (segment === undefined) return;
    const last = index === segments.length - 1;

    if (segment === '**') {
      await walk(dir, index + 1, depth);
      if (depth >= maxDepth) return;
      for (const entry of await listDir(dir)) {
        if (capped()) return;
        if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
        await walk(path.join(dir, entry.name), index, depth + 1);
      }
      return;
    }

    if (!hasMagic(segment)) {
      const child = path.join(dir, segment);
      if (last) {
        if (await isFile(child)) add(child);
      } else if (await isDirectory(child)) {
        await walk(child, index + 1, depth);
      }
      return;
    }

    const matches = matcherFor(segment);
    const mayMatchDot = segment.startsWith('.');
    for (const entry of await listDir(dir)) {
      if (capped()) return;
      if (entry.name.startsWith('.') && !mayMatchDot) continue;
      if (!matches(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (last) {
        if (entry.isFile() || (entry.isSymbolicLink() && (await isFile(child)))) add(child);
      } else if (entry.isDirectory() && depth < maxDepth) {
        await walk(child, index + 1, depth + 1);
      }
    }
  };

  await walk(root, 0, 0);
  return { files, truncated: state.truncated };
}
