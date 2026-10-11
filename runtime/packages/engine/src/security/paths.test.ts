// Path containment (05 5.3 S-FS, 5.7): id regex tables, `resolveContained`, `isContained` and `walkNoLinks`, including a
// real junction (win32) or symlink (posix) escape in a temp folder.
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as protocol from '@mcs/shared/protocol';
import { makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { upperDriveLetter } from '../platform/paths.ts';
import { AGENT_RE, RUN_ID_RE, SID_RE, isContained, resolveContained, walkNoLinks, type WalkSummary } from './paths.ts';

const isWin = process.platform === 'win32';
const makeTemp = useTempDirs();

/** The spelling `resolveContained` returns for an existing path: native realpath, upper-case drive letter on win32. */
function onDisk(p: string): string {
  const real = realpathSync.native(p);
  return isWin ? upperDriveLetter(real) : real;
}

interface Layout {
  /** Real folder of the test (the parent of `root` and `outside`). */
  readonly base: string;
  readonly root: string;
  readonly outside: string;
}

/**
 * base/
 *   root/a/b.txt, root/a/deeper/c.txt, root/empty/
 *   outside/secret.txt
 */
function layout(): Layout {
  const base = onDisk(makeTemp('paths').path);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'a', 'deeper'), { recursive: true });
  mkdirSync(path.join(root, 'empty'));
  mkdirSync(outside);
  writeFileSync(path.join(root, 'a', 'b.txt'), 'b');
  writeFileSync(path.join(root, 'a', 'deeper', 'c.txt'), 'c');
  writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  return { base, root, outside };
}

const UUID = '0b6f0f4e-6c1e-4a46-9d0a-0a5b3f7c9e11';

describe('id regexes (re-exported from @mcs/shared/protocol, registry C35)', () => {
  it('are the very objects of @mcs/shared/protocol, not a second literal', () => {
    expect(SID_RE).toBe(protocol.SID_RE);
    expect(AGENT_RE).toBe(protocol.AGENT_RE);
    expect(RUN_ID_RE).toBe(protocol.RUN_ID_RE);
  });

  const accepts = (re: RegExp, values: readonly string[]) => {
    for (const value of values) expect(re.test(value), `should accept ${JSON.stringify(value)}`).toBe(true);
  };
  const rejects = (re: RegExp, values: readonly string[]) => {
    for (const value of values) expect(re.test(value), `should reject ${JSON.stringify(value)}`).toBe(false);
  };

  it('SID_RE accepts lower-case uuids only', () => {
    accepts(SID_RE, [UUID, '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff']);
    rejects(SID_RE, [
      UUID.toUpperCase(),
      '',
      `${UUID}\n`,
      ` ${UUID}`,
      `${UUID} `,
      `${UUID}x`,
      `../${UUID}`,
      `${UUID}/..`,
      `${UUID}\\..`,
      `${UUID}:stream`,
      `${UUID}\0`,
      UUID.replaceAll('-', ''),
      UUID.slice(0, 35),
      'g0000000-0000-0000-0000-000000000000',
      '..',
      '/',
      '\\',
    ]);
  });

  it('AGENT_RE accepts 3 to 64 letters, digits, underscore and hyphen', () => {
    accepts(AGENT_RE, ['abc', 'a1b2c3d', 'agent_1-2', 'A'.repeat(64), 'main']);
    rejects(AGENT_RE, [
      '',
      'ab',
      'A'.repeat(65),
      '..',
      '...',
      'a/b',
      'a\\b',
      'a:b',
      'a.b',
      'a b',
      'abc\n',
      'abc\0',
      '../abc',
    ]);
  });

  it('RUN_ID_RE accepts wf_ plus 1 to 64 id characters', () => {
    accepts(RUN_ID_RE, ['wf_a', 'wf_Abc_123-x', `wf_${'a'.repeat(64)}`]);
    rejects(RUN_ID_RE, ['', 'wf_', `wf_${'a'.repeat(65)}`, 'WF_abc', 'wf-abc', 'wf_a/b', 'wf_a\\b', 'wf_..', 'wf_a\n']);
  });
});

describe('resolveContained', () => {
  it('returns the real path of an existing child and of the root itself', () => {
    const { root } = layout();
    expect(resolveContained(root, 'a', 'b.txt')).toBe(path.join(root, 'a', 'b.txt'));
    expect(resolveContained(root)).toBe(root);
    expect(resolveContained(root, '')).toBe(root);
    expect(resolveContained(root, '.')).toBe(root);
  });

  it('accepts a multi-component segment and a missing child (a file about to be created)', () => {
    const { root } = layout();
    expect(resolveContained(root, `a${path.sep}deeper`, 'c.txt')).toBe(path.join(root, 'a', 'deeper', 'c.txt'));
    expect(resolveContained(root, 'a', 'new', 'file.txt')).toBe(path.join(root, 'a', 'new', 'file.txt'));
  });

  it('keeps a `..` that stays inside the root and rejects one that leaves it', () => {
    const { root } = layout();
    expect(resolveContained(root, 'a', '..', 'a', 'b.txt')).toBe(path.join(root, 'a', 'b.txt'));
    expect(resolveContained(root, 'a', '..')).toBe(root);
    expect(resolveContained(root, '..')).toBeNull();
    expect(resolveContained(root, '..', 'outside', 'secret.txt')).toBeNull();
    expect(resolveContained(root, 'a', '..', '..', 'outside')).toBeNull();
    expect(resolveContained(root, `a${path.sep}..${path.sep}..${path.sep}outside`)).toBeNull();
    expect(resolveContained(root, `..${path.sep}outside`)).toBeNull();
  });

  it('keeps a name that merely starts with two dots (it is not the parent folder)', () => {
    const { root } = layout();
    mkdirSync(path.join(root, '..data'));
    writeFileSync(path.join(root, '..data', 'f.txt'), 'f');
    expect(resolveContained(root, '..data', 'f.txt')).toBe(path.join(root, '..data', 'f.txt'));
    expect(isContained(root, path.join(root, '..data', 'f.txt'))).toBe(true);
    expect(resolveContained(root, '..data')).toBe(path.join(root, '..data'));
  });

  it('rejects a sibling folder whose name starts with the name of the root', () => {
    const { base, root } = layout();
    mkdirSync(path.join(base, 'root-evil'));
    expect(resolveContained(root, '..', 'root-evil', 'f')).toBeNull();
    expect(isContained(root, path.join(base, 'root-evil', 'f'))).toBe(false);
  });

  it('rejects absolute segments, even when they point inside the root', () => {
    const { root, outside } = layout();
    expect(resolveContained(root, outside)).toBeNull();
    expect(resolveContained(root, path.join(root, 'a'))).toBeNull();
    expect(resolveContained(root, 'a', path.join(outside, 'secret.txt'))).toBeNull();
    expect(resolveContained(root, path.sep)).toBeNull();
    expect(resolveContained(root, `${path.sep}a`)).toBeNull();
  });

  it('rejects a NUL byte in any segment', () => {
    const { root } = layout();
    expect(resolveContained(root, 'a\0b')).toBeNull();
    expect(resolveContained(root, 'a', 'b.txt\0')).toBeNull();
  });

  it('returns null when the root does not exist, is a file, or is empty text', () => {
    const { base, root } = layout();
    expect(resolveContained(path.join(base, 'missing'), 'a')).toBeNull();
    expect(resolveContained(path.join(root, 'a', 'b.txt'), 'x')).toBeNull();
    expect(resolveContained('', 'a')).toBeNull();
  });

  it('follows a link that stays inside the root and reports the real path', () => {
    const { root } = layout();
    makeJunction(path.join(root, 'inside-link'), path.join(root, 'a'));
    expect(resolveContained(root, 'inside-link', 'b.txt')).toBe(path.join(root, 'a', 'b.txt'));
  });

  it('rejects a junction (win32) or symlink (posix) that leaves the root', () => {
    const { root, outside } = layout();
    makeJunction(path.join(root, 'out-link'), outside);
    expect(resolveContained(root, 'out-link')).toBeNull();
    expect(resolveContained(root, 'out-link', 'secret.txt')).toBeNull();
    expect(resolveContained(root, 'out-link', 'missing', 'x')).toBeNull();
    expect(resolveContained(root, 'a', '..', 'out-link', 'secret.txt')).toBeNull();
    expect(isContained(root, path.join(root, 'out-link', 'secret.txt'))).toBe(false);
  });

  it('rejects a link whose target no longer exists (it could be recreated elsewhere)', () => {
    const { base, root } = layout();
    const target = path.join(base, 'gone');
    mkdirSync(target);
    makeJunction(path.join(root, 'dangling'), target);
    rmSync(target, { recursive: true });
    expect(resolveContained(root, 'dangling')).toBeNull();
    expect(resolveContained(root, 'dangling', 'x.txt')).toBeNull();
  });

  it('uses the real path of a root that is itself a link', () => {
    const { base, root } = layout();
    const alias = path.join(base, 'alias');
    makeJunction(alias, root);
    expect(resolveContained(alias, 'a', 'b.txt')).toBe(path.join(root, 'a', 'b.txt'));
    expect(resolveContained(alias, '..', 'outside')).toBeNull();
  });

  it.runIf(isWin)('win32: the comparison ignores case and the result has the on-disk spelling', () => {
    const { root } = layout();
    const shouted = root.toUpperCase();
    expect(resolveContained(shouted, 'A', 'B.TXT')).toBe(path.join(root, 'a', 'b.txt'));
    expect(resolveContained(root.toLowerCase(), 'a')).toBe(path.join(root, 'a'));
  });

  it.runIf(isWin)('win32: rejects drive-relative names, other drives, streams, device names and trailing dots', () => {
    const { root } = layout();
    const drive = root.slice(0, 1).toUpperCase();
    const other = drive === 'D' ? 'C' : 'D';
    expect(resolveContained(root, `${other}:\\x`)).toBeNull();
    expect(resolveContained(root, `${other}:x`)).toBeNull();
    expect(resolveContained(root, `${drive}:x`)).toBeNull();
    expect(resolveContained(root, 'a', 'b.txt:stream')).toBeNull();
    expect(resolveContained(root, 'a', 'b.txt::$DATA')).toBeNull();
    for (const device of ['NUL', 'nul', 'CON', 'con.txt', 'Aux', 'COM1', 'lpt9.log', 'prn .txt']) {
      expect(resolveContained(root, 'a', device), device).toBeNull();
    }
    for (const name of ['a.', 'a ', '.. ', '...', '. .']) {
      expect(resolveContained(root, name), JSON.stringify(name)).toBeNull();
      expect(resolveContained(root, `a${path.sep}${name}${path.sep}x`), JSON.stringify(name)).toBeNull();
    }
    expect(resolveContained(root, 'a', 'nullable.txt')).toBe(path.join(root, 'a', 'nullable.txt'));
  });

  it.runIf(isWin)('win32: a UNC or extended-length spelling of the root resolves to the same place', () => {
    const { root } = layout();
    expect(resolveContained(`\\\\?\\${root}`, 'a', 'b.txt')).toBe(path.join(root, 'a', 'b.txt'));
  });

  it.runIf(!isWin)('posix: names differing only in case are different names', () => {
    const { root } = layout();
    expect(resolveContained(root, 'A', 'b.txt')).toBe(path.join(root, 'A', 'b.txt'));
    expect(resolveContained(root, 'a', 'B.txt')).toBe(path.join(root, 'a', 'B.txt'));
  });
});

describe('isContained', () => {
  it('is true for the root, its descendants and paths that do not exist yet', () => {
    const { root } = layout();
    expect(isContained(root, root)).toBe(true);
    expect(isContained(root, path.join(root, 'a'))).toBe(true);
    expect(isContained(root, path.join(root, 'a', 'b.txt'))).toBe(true);
    expect(isContained(root, path.join(root, 'a', 'not', 'yet', 'there.txt'))).toBe(true);
    expect(isContained(root, `${root}${path.sep}`)).toBe(true);
  });

  it('is false for the parent, siblings and unrelated absolute paths', () => {
    const { base, root, outside } = layout();
    expect(isContained(root, base)).toBe(false);
    expect(isContained(root, outside)).toBe(false);
    expect(isContained(root, path.join(outside, 'secret.txt'))).toBe(false);
    expect(isContained(root, path.parse(root).root)).toBe(false);
  });

  it('judges the resolved path of a candidate with `..` segments', () => {
    const { root, outside } = layout();
    expect(isContained(root, path.join(root, 'a', '..', 'a', 'b.txt'))).toBe(true);
    expect(isContained(root, `${root}${path.sep}a${path.sep}..${path.sep}..${path.sep}outside`)).toBe(false);
    expect(isContained(root, `${root}${path.sep}..${path.sep}outside${path.sep}secret.txt`)).toBe(false);
    expect(isContained(outside, `${root}${path.sep}..${path.sep}outside`)).toBe(true);
  });

  it('is false for a relative candidate, an empty candidate and a NUL byte', () => {
    const { root } = layout();
    expect(isContained(root, 'a')).toBe(false);
    expect(isContained(root, path.join('a', 'b.txt'))).toBe(false);
    expect(isContained(root, '')).toBe(false);
    expect(isContained(root, `${path.join(root, 'a')}\0`)).toBe(false);
  });

  it('is false when the root cannot be resolved or is not a folder', () => {
    const { base, root } = layout();
    expect(isContained(path.join(base, 'missing'), path.join(base, 'missing', 'x'))).toBe(false);
    expect(isContained(path.join(root, 'a', 'b.txt'), path.join(root, 'a', 'b.txt'))).toBe(false);
    expect(isContained('', root)).toBe(false);
  });

  it('is false for a candidate behind a link that leaves the root, and true behind one that stays', () => {
    const { root, outside } = layout();
    makeJunction(path.join(root, 'out-link'), outside);
    makeJunction(path.join(root, 'in-link'), path.join(root, 'a'));
    expect(isContained(root, path.join(root, 'out-link'))).toBe(false);
    expect(isContained(root, path.join(root, 'out-link', 'secret.txt'))).toBe(false);
    expect(isContained(root, path.join(root, 'out-link', 'new', 'file.txt'))).toBe(false);
    expect(isContained(root, path.join(root, 'in-link', 'b.txt'))).toBe(true);
  });

  it.runIf(isWin)('win32: case variants and other drives', () => {
    const { root } = layout();
    expect(isContained(root.toUpperCase(), path.join(root, 'A', 'B.TXT').toLowerCase())).toBe(true);
    const drive = root.slice(0, 1).toUpperCase();
    const other = drive === 'D' ? 'C' : 'D';
    expect(isContained(root, `${other}:\\${root.slice(3)}\\a`)).toBe(false);
  });

  it.runIf(isWin)('win32: trailing dots and spaces cannot step out of the root', () => {
    const { root } = layout();
    expect(isContained(root, `${root}\\.. \\outside\\secret.txt`)).toBe(false);
    expect(isContained(root, `${root}\\..\\outside\\secret.txt`)).toBe(false);
    expect(isContained(root, `${root}\\a\\..\\..\\outside`)).toBe(false);
  });
});

describe('walkNoLinks', () => {
  /** Runs the generator to its end and returns the yielded paths plus the summary it returned. */
  function walk(
    dir: string,
    opts: { maxDepth: number; maxEntries: number },
  ): { files: string[]; summary: WalkSummary } {
    const files: string[] = [];
    const iterator = walkNoLinks(dir, opts);
    for (;;) {
      const step = iterator.next();
      if (step.done === true) return { files, summary: step.value };
      files.push(step.value);
    }
  }

  const rel = (root: string, files: readonly string[]) =>
    files.map((f) => path.relative(root, f).split(path.sep).join('/'));

  it('yields the regular files below a folder, sorted within each folder', () => {
    const { root } = layout();
    writeFileSync(path.join(root, 'z.txt'), 'z');
    writeFileSync(path.join(root, 'a', 'a2.txt'), 'x');
    const { files, summary } = walk(root, { maxDepth: 8, maxEntries: 1000 });
    expect(rel(root, files)).toEqual(['a/a2.txt', 'a/b.txt', 'a/deeper/c.txt', 'z.txt']);
    expect(summary).toEqual({ entries: 7, truncated: false });
  });

  it('does not enter or yield links, whatever they point to', () => {
    const { root, outside } = layout();
    makeJunction(path.join(root, 'out-link'), outside);
    makeJunction(path.join(root, 'in-link'), path.join(root, 'a'));
    const { files } = walk(root, { maxDepth: 8, maxEntries: 1000 });
    expect(rel(root, files)).toEqual(['a/b.txt', 'a/deeper/c.txt']);
  });

  it('stops descending after maxDepth folders and says so', () => {
    const { root } = layout();
    writeFileSync(path.join(root, 'top.txt'), 't');
    const shallow = walk(root, { maxDepth: 0, maxEntries: 1000 });
    expect(rel(root, shallow.files)).toEqual(['top.txt']);
    expect(shallow.summary.truncated).toBe(true);
    const one = walk(root, { maxDepth: 1, maxEntries: 1000 });
    expect(rel(root, one.files)).toEqual(['a/b.txt', 'top.txt']);
    expect(one.summary.truncated).toBe(true);
    const two = walk(root, { maxDepth: 2, maxEntries: 1000 });
    expect(rel(root, two.files)).toEqual(['a/b.txt', 'a/deeper/c.txt', 'top.txt']);
    expect(two.summary.truncated).toBe(false);
  });

  it('stops after maxEntries directory entries and says so', () => {
    const { base } = layout();
    const flat = path.join(base, 'flat');
    mkdirSync(flat);
    for (let i = 0; i < 20; i += 1) writeFileSync(path.join(flat, `f${String(i).padStart(2, '0')}.txt`), 'x');
    const all = walk(flat, { maxDepth: 8, maxEntries: 20 });
    expect(all.files).toHaveLength(20);
    expect(all.summary).toEqual({ entries: 20, truncated: false });
    const capped = walk(flat, { maxDepth: 8, maxEntries: 19 });
    expect(capped.files).toHaveLength(19);
    expect(capped.summary).toEqual({ entries: 19, truncated: true });
    expect(rel(flat, capped.files)[0]).toBe('f00.txt');
    expect(walk(flat, { maxDepth: 8, maxEntries: 0 })).toEqual({ files: [], summary: { entries: 0, truncated: true } });
    const empty = path.join(base, 'root', 'empty');
    expect(walk(empty, { maxDepth: 8, maxEntries: 0 })).toEqual({
      files: [],
      summary: { entries: 0, truncated: false },
    });
  });

  it('counts a skipped link as an entry', () => {
    const { root, outside } = layout();
    makeJunction(path.join(root, 'out-link'), outside);
    expect(walk(root, { maxDepth: 0, maxEntries: 1000 }).summary.entries).toBe(3);
  });

  it('yields nothing for a folder that does not exist or is a file', () => {
    const { base, root } = layout();
    expect(walk(path.join(base, 'missing'), { maxDepth: 3, maxEntries: 10 }).files).toEqual([]);
    expect(walk(path.join(root, 'a', 'b.txt'), { maxDepth: 3, maxEntries: 10 }).files).toEqual([]);
  });

  it('rejects limits that are not non-negative integers', () => {
    const { root } = layout();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => walkNoLinks(root, { maxDepth: bad, maxEntries: 10 }).next()).toThrow(RangeError);
      expect(() => walkNoLinks(root, { maxDepth: 1, maxEntries: bad }).next()).toThrow(RangeError);
    }
  });

  it('may start inside a folder that is itself reached through a link', () => {
    const { root } = layout();
    const alias = path.join(path.dirname(root), 'alias');
    makeJunction(alias, root);
    const { files } = walk(alias, { maxDepth: 8, maxEntries: 1000 });
    expect(rel(alias, files)).toEqual(['a/b.txt', 'a/deeper/c.txt']);
  });
});
