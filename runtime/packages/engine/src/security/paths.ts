// Path containment (05 5.3 S-FS, registry C35): the one place that decides whether a path stays inside a root.
//   - ids are validated by the regexes of `@mcs/shared/protocol` (re-exported here, never a second literal) before any
//     path work; paths are found by listing a known folder, never by joining client text (S-FS-1);
//   - containment is judged on real paths: the deepest part of the candidate that exists is resolved with the native
//     realpath (links and junctions followed), the part that does not exist yet is appended, and `path.relative`
//     must not start with `..` nor be absolute (S-FS-3); win32 compares without case (the path module does);
//   - a link that cannot be resolved (it dangles, a loop, no access) fails closed: the answer is "not contained";
//   - on win32 a name the OS would normalise into something else (a trailing dot or space, `:` for a stream or a
//     drive, a device name) is refused for the part of a path that does not exist yet.
// The checks and the use of the path are separate steps: callers use the path returned by `resolveContained`, never the
// text they joined themselves.
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { RESERVED_SLUGS } from '@mcs/shared';

import { hostPlatform } from '../platform/host.ts';
import { stripExtendedPrefix, upperDriveLetter } from '../platform/paths.ts';

export { AGENT_RE, RUN_ID_RE, SID_RE } from '@mcs/shared/protocol';

const WIN32 = hostPlatform === 'win32';

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

/** The spelling every path takes before it is compared: no extended prefix and an upper-case drive letter on win32. */
function normalizeReal(real: string): string {
  return WIN32 ? upperDriveLetter(stripExtendedPrefix(real)) : real;
}

/** The real path of an existing folder, or null when `root` is empty, missing, not a folder or cannot be resolved. */
function realRootOf(root: string): string | null {
  if (root === '' || root.includes('\0')) return null;
  try {
    const real = normalizeReal(realpathSync.native(path.resolve(root)));
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** True for a name that win32 would turn into something else when the file is created or opened. */
function isUnsafeWindowsName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (name.includes(':')) return true;
  if (name.endsWith('.') || name.endsWith(' ')) return true;
  return RESERVED_SLUGS.has((name.split('.')[0] ?? '').trim().toLowerCase());
}

/** Outcome of resolving one candidate: a real path, "does not exist here", or a refusal. */
type Probe = { kind: 'real'; path: string } | { kind: 'missing' } | { kind: 'refused' };

function probe(candidate: string): Probe {
  try {
    return { kind: 'real', path: normalizeReal(realpathSync.native(candidate)) };
  } catch (error) {
    const code = errnoCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return { kind: 'refused' };
  }
  // realpath failed as "not there": it really is absent only when lstat agrees. A link that dangles still has an entry.
  try {
    lstatSync(candidate);
    return { kind: 'refused' };
  } catch (error) {
    const code = errnoCode(error);
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'refused' };
  }
}

/**
 * Real path of `absolute`: the deepest existing ancestor resolved, the names below it appended. Null when a link on the
 * way cannot be resolved or a name that does not exist yet is unsafe on win32.
 */
function canonicalize(absolute: string): string | null {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    const found = probe(current);
    if (found.kind === 'refused') return null;
    if (found.kind === 'real') return tail.length === 0 ? found.path : path.join(found.path, ...tail);
    const name = path.basename(current);
    if (WIN32 && isUnsafeWindowsName(name)) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    tail.unshift(name);
    current = parent;
  }
}

function isInside(realRoot: string, real: string): boolean {
  const relative = path.relative(realRoot, real);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** A segment is a relative name or sub-path: absolute text, NUL and (on win32) names the OS would rewrite are refused. */
function isSafeSegment(segment: string): boolean {
  if (segment.includes('\0') || path.isAbsolute(segment)) return false;
  if (!WIN32) return true;
  if (segment.includes(':')) return false;
  return !segment.split(/[\\/]/).some(isUnsafeWindowsName);
}

/**
 * The real path of `root` joined with `segments`, or null when the result would leave the root, the root is not an
 * existing folder, a segment is absolute or unsafe, or a link on the way cannot be resolved. `..` segments are
 * normalised first, so `('a', '..', 'b')` is `<root>/b`. The result need not exist.
 */
export function resolveContained(root: string, ...segments: string[]): string | null {
  const realRoot = realRootOf(root);
  if (realRoot === null) return null;
  if (!segments.every(isSafeSegment)) return null;
  const real = canonicalize(path.resolve(realRoot, ...segments));
  return real !== null && isInside(realRoot, real) ? real : null;
}

/**
 * True when the absolute path `candidate` (after links are resolved) is `root` or below it. A relative candidate, an
 * empty one, a NUL byte, a root that is not an existing folder and an unresolvable link all give false. The path does
 * not have to exist (a file about to be created is judged by its parent).
 */
export function isContained(root: string, candidate: string): boolean {
  if (candidate === '' || candidate.includes('\0') || !path.isAbsolute(candidate)) return false;
  const realRoot = realRootOf(root);
  if (realRoot === null) return false;
  const real = canonicalize(path.resolve(candidate));
  return real !== null && isInside(realRoot, real);
}

export interface WalkOptions {
  /** Folders below `dir` that are entered: 0 lists `dir` itself only. */
  readonly maxDepth: number;
  /** Directory entries examined, of every kind, before the walk stops. */
  readonly maxEntries: number;
}

export interface WalkSummary {
  /** Directory entries examined (links included). */
  readonly entries: number;
  /** True when the walk did not cover everything: the entry limit was hit or a folder below `maxDepth` was not entered. */
  readonly truncated: boolean;
}

function checkLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`walkNoLinks: ${name} must be a non-negative integer, got ${String(value)}`);
  }
}

interface WalkState {
  entries: number;
  truncated: boolean;
}

function* walkLevel(dir: string, depth: number, opts: WalkOptions, state: WalkState): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    // A folder that cannot be listed (gone, no access, not a folder) holds nothing the walk can report.
    return;
  }
  for (const name of names) {
    if (state.entries >= opts.maxEntries) {
      state.truncated = true;
      return;
    }
    state.entries += 1;
    const full = path.join(dir, name);
    let kind: 'link' | 'dir' | 'file' | 'other';
    try {
      const stats = lstatSync(full);
      kind = stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other';
    } catch {
      continue;
    }
    if (kind === 'file') {
      yield full;
    } else if (kind === 'dir') {
      if (depth < opts.maxDepth) {
        yield* walkLevel(full, depth + 1, opts, state);
        if (state.truncated && state.entries >= opts.maxEntries) return;
      } else {
        state.truncated = true;
      }
    }
  }
}

/**
 * Yields the absolute path of every regular file below `dir`, folders in name order, never entering or reporting a
 * symbolic link or junction (lstat). `dir` itself may be reached through a link: it is the caller's known folder. The
 * returned summary says whether the walk was cut short by `maxDepth` or `maxEntries`.
 */
export function* walkNoLinks(dir: string, opts: WalkOptions): Generator<string, WalkSummary> {
  checkLimit('maxDepth', opts.maxDepth);
  checkLimit('maxEntries', opts.maxEntries);
  const state: WalkState = { entries: 0, truncated: false };
  yield* walkLevel(path.resolve(dir), 0, opts, state);
  return { entries: state.entries, truncated: state.truncated };
}
