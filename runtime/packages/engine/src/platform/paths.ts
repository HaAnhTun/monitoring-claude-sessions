// Path identity (06 4.1). Where identity matters (instance ownership, transcript file keys, attempts source path) only
// canonical paths are compared, with `samePath`. Containment checks (traversal, link escapes) are security/paths.ts (05).
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { hostPlatform, pathsCaseInsensitive, type HostPlatform } from './host.ts';

const EXTENDED_UNC = /^\\\\\?\\UNC\\/i;
const EXTENDED_LOCAL_PREFIX = '\\\\?\\';
const LOWER_DRIVE = /^([a-z]):/;
const MSYS_DRIVE = /^\/[A-Za-z](\/|$)/;

/** `\\?\UNC\server\share` becomes `\\server\share`, `\\?\C:\x` becomes `C:\x`; anything else is unchanged. */
export function stripExtendedPrefix(p: string): string {
  if (EXTENDED_UNC.test(p)) return '\\\\' + p.slice(8);
  if (p.startsWith(EXTENDED_LOCAL_PREFIX)) return p.slice(EXTENDED_LOCAL_PREFIX.length);
  return p;
}

/** Upper-cases a leading `c:` (Windows spells the drive letter in both cases; the canonical spelling is upper case). */
export function upperDriveLetter(p: string): string {
  return p.replace(LOWER_DRIVE, (_match, letter: string) => `${letter.toUpperCase()}:`);
}

/**
 * True for a git-bash style `/c/Users/x` path on Windows. The runtime never receives such paths (Node APIs and Claude Code
 * use the Windows form), so config validation reports them as `use C:/... instead of /c/...` (06 4.1, registry C42).
 */
export function isMsysPath(p: string, platform: HostPlatform = hostPlatform): boolean {
  return platform === 'win32' && MSYS_DRIVE.test(p);
}

/**
 * Absolute path with symlinks and junctions resolved, the on-disk case, long names (no 8.3 short names), no extended
 * prefix and an upper-case drive letter. The part of the path that does not exist yet is appended unchanged.
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let existing = abs;
  let real: string | null = null;
  for (;;) {
    try {
      real = realpathSync.native(existing);
      break;
    } catch {
      // Not resolvable (missing, not a directory, no access): resolve the parent instead and keep this name as it is.
      const parent = path.dirname(existing);
      if (parent === existing) break;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const joined = path.join(real ?? existing, ...tail);
  const plain = stripExtendedPrefix(joined);
  return hostPlatform === 'win32' ? upperDriveLetter(plain) : plain;
}

/** The comparison key of a path: `canonicalPath`, lower-cased where the file system ignores case. */
export function pathKey(p: string): string {
  const canonical = canonicalPath(p);
  return pathsCaseInsensitive ? canonical.toLowerCase() : canonical;
}

/** True when both paths name the same place: canonical, case-insensitive on win32 and darwin. */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** `logs/a.log` when `p` is under `base` (`.` for the base itself), otherwise the canonical absolute path with `/`. */
export function toPosixRel(p: string, base: string): string {
  const target = canonicalPath(p);
  const root = canonicalPath(base);
  const rel = path.relative(root, target);
  if (rel === '') return '.';
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return toPosix(outside ? target : rel);
}
