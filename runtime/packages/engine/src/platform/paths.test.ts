import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { pathsCaseInsensitive } from './host.ts';
import {
  canonicalPath,
  isMsysPath,
  pathKey,
  samePath,
  stripExtendedPrefix,
  toPosixRel,
  upperDriveLetter,
} from './paths.ts';

const isWin = process.platform === 'win32';
const makeTemp = useTempDirs();

/** The on-disk spelling of a temp folder: what `canonicalPath` must return for it. */
function onDisk(dir: string): string {
  const real = realpathSync.native(dir);
  return isWin ? upperDriveLetter(real) : real;
}

describe('stripExtendedPrefix (string level)', () => {
  it('turns the UNC extended prefix into a plain UNC path', () => {
    expect(stripExtendedPrefix('\\\\?\\UNC\\server\\share\\dir')).toBe('\\\\server\\share\\dir');
  });

  it('removes the local extended prefix', () => {
    expect(stripExtendedPrefix('\\\\?\\C:\\Users\\x')).toBe('C:\\Users\\x');
  });

  it('leaves ordinary paths alone', () => {
    expect(stripExtendedPrefix('C:\\Users\\x')).toBe('C:\\Users\\x');
    expect(stripExtendedPrefix('\\\\server\\share')).toBe('\\\\server\\share');
    expect(stripExtendedPrefix('/usr/lib')).toBe('/usr/lib');
  });
});

describe('upperDriveLetter (string level)', () => {
  it('upper-cases a lower-case drive letter only', () => {
    expect(upperDriveLetter('c:\\x')).toBe('C:\\x');
    expect(upperDriveLetter('c:/x')).toBe('C:/x');
    expect(upperDriveLetter('C:\\x')).toBe('C:\\x');
    expect(upperDriveLetter('cc:\\x')).toBe('cc:\\x');
    expect(upperDriveLetter('/c:/x')).toBe('/c:/x');
    expect(upperDriveLetter('')).toBe('');
  });
});

describe('isMsysPath', () => {
  it('flags /<letter>/... on win32 and nothing else', () => {
    expect(isMsysPath('/c/Users/x', 'win32')).toBe(true);
    expect(isMsysPath('/D/mvp', 'win32')).toBe(true);
    expect(isMsysPath('/c', 'win32')).toBe(true);
    expect(isMsysPath('C:/Users/x', 'win32')).toBe(false);
    expect(isMsysPath('//server/share', 'win32')).toBe(false);
    expect(isMsysPath('/cc/x', 'win32')).toBe(false);
    expect(isMsysPath('c/x', 'win32')).toBe(false);
    expect(isMsysPath('/c/Users/x', 'linux')).toBe(false);
    expect(isMsysPath('/c/Users/x', 'darwin')).toBe(false);
  });
});

describe('canonicalPath', () => {
  it('returns an absolute path with the on-disk case and the 8.3 short name expanded', () => {
    const dir = makeTemp('paths').path;
    expect(canonicalPath(dir)).toBe(onDisk(dir));
    // `os.tmpdir()` may be an 8.3 short path on Windows (E22): both spellings are one identity.
    expect(canonicalPath(tmpdir())).toBe(onDisk(tmpdir()));
    expect(samePath(dir, onDisk(dir))).toBe(true);
  });

  it('accepts / and \\ and resolves relative input against the working directory', () => {
    const dir = makeTemp('paths').path;
    expect(canonicalPath(dir.split(path.sep).join('/'))).toBe(canonicalPath(dir));
    expect(canonicalPath(path.relative(process.cwd(), dir))).toBe(canonicalPath(dir));
  });

  it.runIf(isWin)('upper-cases the drive letter on Windows', () => {
    const dir = makeTemp('paths').path;
    const lower = dir.charAt(0).toLowerCase() + dir.slice(1);
    expect(canonicalPath(lower)).toBe(onDisk(dir));
    expect(canonicalPath(lower).charAt(0)).toBe(canonicalPath(lower).charAt(0).toUpperCase());
  });

  it('restores the on-disk case of existing folders and keeps a non-existing tail unchanged', () => {
    const dir = makeTemp('paths').path;
    mkdirSync(path.join(dir, 'RealName'));
    const query = path.join(dir, pathsCaseInsensitive ? 'realname' : 'RealName', 'New', 'File.TXT');
    expect(canonicalPath(query)).toBe(path.join(onDisk(dir), 'RealName', 'New', 'File.TXT'));
  });

  it('resolves a junction or symlink to its target and keeps a non-existing tail', () => {
    const dir = makeTemp('paths').path;
    const target = path.join(dir, 'target');
    const link = path.join(dir, 'link');
    mkdirSync(target);
    writeFileSync(path.join(target, 'a.txt'), 'x');
    symlinkSync(target, link, 'junction');
    expect(canonicalPath(link)).toBe(canonicalPath(target));
    expect(canonicalPath(path.join(link, 'a.txt'))).toBe(canonicalPath(path.join(target, 'a.txt')));
    expect(canonicalPath(path.join(link, 'missing', 'b.txt'))).toBe(
      path.join(canonicalPath(target), 'missing', 'b.txt'),
    );
    expect(samePath(link, target)).toBe(true);
  });

  it('copes with a path whose every ancestor is missing up to the root', () => {
    const root = path.parse(process.cwd()).root;
    const ghost = path.join(root, 'mcs-no-such-folder-7f3a', 'x', 'y');
    expect(canonicalPath(ghost)).toBe(
      path.join(isWin ? upperDriveLetter(root) : root, 'mcs-no-such-folder-7f3a', 'x', 'y'),
    );
  });

  it('handles a 300 character path (long path support of Node fs, E11)', () => {
    const dir = makeTemp('paths').path;
    const deep = path.join(dir, ...Array.from({ length: 10 }, (_, i) => `segment-${String(i)}-${'x'.repeat(24)}`));
    mkdirSync(deep, { recursive: true });
    expect(deep.length).toBeGreaterThan(250);
    expect(canonicalPath(deep)).toBe(path.join(onDisk(dir), ...deep.slice(dir.length + 1).split(path.sep)));
  });
});

describe('samePath and pathKey', () => {
  it('compares canonical paths, case-insensitively where the file system is', () => {
    const dir = makeTemp('paths').path;
    const upper = path.join(dir, 'ABC');
    const lower = path.join(dir, 'abc');
    expect(samePath(upper, lower)).toBe(pathsCaseInsensitive);
    expect(samePath(dir, path.join(dir, 'other'))).toBe(false);
    expect(samePath(dir, dir + path.sep)).toBe(true);
  });

  it('pathKey is equal exactly when samePath is true', () => {
    const dir = makeTemp('paths').path;
    const a = path.join(dir, 'Mixed', 'Case.log');
    const b = path.join(dir, 'mixed', 'case.LOG');
    expect(pathKey(a) === pathKey(b)).toBe(samePath(a, b));
    expect(pathKey(a)).toBe(pathKey(a));
    expect(pathKey(path.join(dir, 'one'))).not.toBe(pathKey(path.join(dir, 'two')));
    expect(pathKey(a).length).toBeGreaterThan(0);
    expect(pathKey(a).length).toBeLessThanOrEqual(1024);
  });
});

describe('toPosixRel', () => {
  it('returns a / separated path relative to the base when the path is under it', () => {
    const dir = makeTemp('paths').path;
    mkdirSync(path.join(dir, 'logs'));
    expect(toPosixRel(path.join(dir, 'logs', 'a.log'), dir)).toBe('logs/a.log');
    expect(toPosixRel(path.join(dir, 'logs', 'deeper', 'b.log'), dir)).toBe('logs/deeper/b.log');
  });

  it('returns the canonical absolute path with / when the path is outside the base', () => {
    const base = makeTemp('paths').path;
    const other = makeTemp('paths').path;
    const result = toPosixRel(path.join(other, 'x.log'), base);
    expect(result).toBe(path.join(canonicalPath(other), 'x.log').split(path.sep).join('/'));
    expect(result).not.toContain('\\');
  });

  it('does not treat a sibling with a common prefix as a child', () => {
    const dir = makeTemp('paths').path;
    mkdirSync(path.join(dir, 'repo'));
    mkdirSync(path.join(dir, 'repo2'));
    const result = toPosixRel(path.join(dir, 'repo2', 'f.txt'), path.join(dir, 'repo'));
    expect(result.startsWith('..')).toBe(false);
    expect(result.endsWith('repo2/f.txt')).toBe(true);
  });

  it('returns . for the base itself', () => {
    const dir = makeTemp('paths').path;
    expect(toPosixRel(dir, dir)).toBe('.');
  });
});
