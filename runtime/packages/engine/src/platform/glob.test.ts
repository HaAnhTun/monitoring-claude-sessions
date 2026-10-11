import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { globFiles } from './glob.ts';
import { pathsCaseInsensitive } from './host.ts';

const makeTemp = useTempDirs();

/** A fresh empty folder: the temp root itself holds the testkit's FIXTURE.md marker. */
function freshRoot(): string {
  const dir = path.join(makeTemp('glob').path, 'tree');
  mkdirSync(dir);
  return dir;
}

/** Creates the files (and their folders) under `root`; returns `root`. */
function tree(root: string, files: readonly string[]): string {
  for (const file of files) {
    const full = path.join(root, ...file.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, file);
  }
  return root;
}

/** Matches relative to `root`, as sorted `/` separated names. */
async function rel(pattern: string, root: string, opts?: { maxMatches?: number; maxDepth?: number }) {
  const result = await globFiles(pattern, root, opts);
  return {
    names: result.files.map((file) => path.relative(root, file).split(path.sep).join('/')).sort(),
    truncated: result.truncated,
  };
}

describe('globFiles segment syntax', () => {
  it('matches * as any run of characters without a separator', async () => {
    const root = tree(freshRoot(), ['a.log', 'b.log', 'c.txt', 'sub/d.log', 'abc.log']);
    expect((await rel('*.log', root)).names).toEqual(['a.log', 'abc.log', 'b.log']);
    expect((await rel('*', root)).names).toEqual(['a.log', 'abc.log', 'b.log', 'c.txt']);
    expect((await rel('sub/*.log', root)).names).toEqual(['sub/d.log']);
  });

  it('matches ? as exactly one character', async () => {
    const root = tree(freshRoot(), ['a1.log', 'a22.log', 'b1.log', 'a.log']);
    expect((await rel('a?.log', root)).names).toEqual(['a1.log']);
    expect((await rel('?1.log', root)).names).toEqual(['a1.log', 'b1.log']);
  });

  it('supports [abc], [a-z] and [!abc]', async () => {
    const root = tree(freshRoot(), ['a.log', 'b.log', 'c.log', 'd.log', '1.log']);
    expect((await rel('[ab].log', root)).names).toEqual(['a.log', 'b.log']);
    expect((await rel('[a-c].log', root)).names).toEqual(['a.log', 'b.log', 'c.log']);
    expect((await rel('[!ab].log', root)).names).toEqual(['1.log', 'c.log', 'd.log']);
    expect((await rel('[0-9].log', root)).names).toEqual(['1.log']);
  });

  it('treats an unclosed [ as a literal character', async () => {
    const root = tree(freshRoot(), ['[x.log', 'x.log']);
    expect((await rel('[x.log', root)).names).toEqual(['[x.log']);
  });

  it('escapes regular expression characters in literal text', async () => {
    const root = tree(freshRoot(), ['a+b(1).log', 'aab1.log', 'a.b.log', 'axb.log']);
    expect((await rel('a+b(1).log', root)).names).toEqual(['a+b(1).log']);
    expect((await rel('a.b.log', root)).names).toEqual(['a.b.log']);
  });

  it('accepts both / and \\ as separators in the pattern', async () => {
    const root = tree(freshRoot(), ['logs/a.log', 'logs/deep/b.log']);
    expect((await rel('logs\\*.log', root)).names).toEqual(['logs/a.log']);
    expect((await rel('logs/*.log', root)).names).toEqual(['logs/a.log']);
  });

  it('returns only files, never folders, and nothing for a literal folder name', async () => {
    const root = tree(freshRoot(), ['logs/a.log']);
    expect((await rel('logs', root)).names).toEqual([]);
    expect((await rel('*', root)).names).toEqual([]);
    expect((await rel('logs/a.log', root)).names).toEqual(['logs/a.log']);
  });
});

describe('globFiles matcher details', () => {
  it('treats [a-], [-a] and a reversed range like Python fnmatch: edges are literal, reversed ranges match nothing', async () => {
    const root = tree(freshRoot(), ['a.x', '-.x', 'b.x']);
    expect((await rel('[a-].x', root)).names).toEqual(['-.x', 'a.x']);
    expect((await rel('[-a].x', root)).names).toEqual(['-.x', 'a.x']);
    expect((await rel('[z-a].x', root)).names).toEqual([]);
    expect((await rel('[]a].x', root)).names).toEqual(['a.x']);
  });

  it('collapses runs of * and lets * match the empty string', async () => {
    const root = tree(freshRoot(), ['ab', 'a-b', 'a--b', 'b']);
    expect((await rel('a**b', root)).names).toEqual(['a--b', 'a-b', 'ab']);
    expect((await rel('*b', root)).names).toEqual(['a--b', 'a-b', 'ab', 'b']);
  });

  it('matches whole code points: ? is one emoji and a character class can hold one', async () => {
    const root = tree(freshRoot(), ['x\u{1f600}y.log', 'xy.log', 'x\u{1f600}\u{1f600}y.log']);
    expect((await rel('x?y.log', root)).names).toEqual(['x\u{1f600}y.log']);
    expect((await rel('x[\u{1f600}]y.log', root)).names).toEqual(['x\u{1f600}y.log']);
  });

  it('is not slowed down by a pattern that makes a backtracking matcher explode', async () => {
    const root = tree(freshRoot(), [`${'a'.repeat(200)}.log`]);
    const started = performance.now();
    const result = await rel(`${'*a'.repeat(40)}b`, root);
    expect(result.names).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('globFiles ** (zero or more directories)', () => {
  it('recurses into every folder and also matches the base folder itself', async () => {
    const root = tree(freshRoot(), ['a.log', 'x/b.log', 'x/y/c.log', 'x/y/z/d.log', 'x/y/z/e.txt']);
    expect((await rel('**/*.log', root)).names).toEqual(['a.log', 'x/b.log', 'x/y/c.log', 'x/y/z/d.log']);
    expect((await rel('x/**/*.log', root)).names).toEqual(['x/b.log', 'x/y/c.log', 'x/y/z/d.log']);
    expect((await rel('x/**/c.log', root)).names).toEqual(['x/y/c.log']);
  });

  it('never matches or enters a dot folder with **, and * skips dot files', async () => {
    const root = tree(freshRoot(), ['a.log', '.hidden/b.log', '.dot.log', 'x/.y/c.log', 'x/d.log']);
    expect((await rel('**/*.log', root)).names).toEqual(['a.log', 'x/d.log']);
    expect((await rel('*.log', root)).names).toEqual(['a.log']);
  });

  it('matches dot entries when the segment itself starts with a dot', async () => {
    const root = tree(freshRoot(), ['.dot.log', '.hidden/b.log', 'a.log']);
    expect((await rel('.*.log', root)).names).toEqual(['.dot.log']);
    expect((await rel('.hidden/*.log', root)).names).toEqual(['.hidden/b.log']);
  });

  it('does not descend into symbolic links or junctions to folders', async () => {
    const root = tree(freshRoot(), ['real/inside.log', 'top.log']);
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'junction');
    expect((await rel('**/*.log', root)).names).toEqual(['real/inside.log', 'top.log']);
  });

  it('stops descending after maxDepth folders below the first wildcard segment', async () => {
    const root = tree(freshRoot(), ['a.log', 'l1/b.log', 'l1/l2/c.log', 'l1/l2/l3/d.log']);
    expect((await rel('**/*.log', root, { maxDepth: 1 })).names).toEqual(['a.log', 'l1/b.log']);
    expect((await rel('**/*.log', root, { maxDepth: 2 })).names).toEqual(['a.log', 'l1/b.log', 'l1/l2/c.log']);
    expect((await rel('**/*.log', root)).names).toHaveLength(4);
  });

  it('counts the depth from the first wildcard segment, not from the base', async () => {
    const root = tree(freshRoot(), ['p/q/a.log', 'p/q/r/b.log', 'p/q/r/s/c.log']);
    expect((await rel('p/q/**/*.log', root, { maxDepth: 1 })).names).toEqual(['p/q/a.log', 'p/q/r/b.log']);
  });

  it('returns each file once even when ** appears twice', async () => {
    const root = tree(freshRoot(), ['a/b/c.log']);
    expect((await rel('**/**/c.log', root)).names).toEqual(['a/b/c.log']);
  });
});

describe('globFiles limits', () => {
  it('stops after maxMatches files and reports truncation only when more would match', async () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}.log`);
    const root = tree(freshRoot(), files);
    const capped = await rel('*.log', root, { maxMatches: 10 });
    expect(capped.names).toHaveLength(10);
    expect(capped.truncated).toBe(true);
    const exact = await rel('*.log', root, { maxMatches: 12 });
    expect(exact.names).toHaveLength(12);
    expect(exact.truncated).toBe(false);
  });

  it('defaults to 500 matches: 501 files give 500 and truncated', async () => {
    const files = Array.from({ length: 501 }, (_, i) => `f${String(i).padStart(3, '0')}.log`);
    const root = tree(freshRoot(), files);
    const result = await globFiles('*.log', root);
    expect(result.files).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it('returns the files of one folder in a stable order', async () => {
    const root = tree(freshRoot(), ['c.log', 'a.log', 'b.log']);
    const first = (await globFiles('*.log', root)).files.map((file) => path.basename(file));
    const second = (await globFiles('*.log', root)).files.map((file) => path.basename(file));
    expect(first).toEqual(['a.log', 'b.log', 'c.log']);
    expect(second).toEqual(first);
  });
});

describe('globFiles roots', () => {
  it('resolves a relative pattern against the base folder', async () => {
    const root = tree(freshRoot(), ['logs/a.log']);
    const result = await globFiles('logs/*.log', root);
    expect(result.files).toEqual([path.join(root, 'logs', 'a.log')]);
  });

  it('accepts an absolute pattern and ignores the base', async () => {
    const root = tree(freshRoot(), ['logs/a.log', 'logs/b.log']);
    const elsewhere = freshRoot();
    const absolute = path.join(root, 'logs', '*.log');
    const result = await globFiles(absolute, elsewhere);
    expect(result.files.map((file) => path.basename(file))).toEqual(['a.log', 'b.log']);
    const forward = await globFiles(absolute.split(path.sep).join('/'), elsewhere);
    expect(forward.files).toEqual(result.files);
  });

  it.runIf(process.platform === 'win32')('accepts a drive-letter pattern with forward slashes on Windows', async () => {
    const root = tree(freshRoot(), ['x/a.log']);
    const pattern = path.join(root, 'x', '*.log').split(path.sep).join('/');
    expect(/^[A-Za-z]:\//.test(pattern)).toBe(true);
    expect((await globFiles(pattern, process.cwd())).files).toHaveLength(1);
  });

  it('returns an empty result for a missing base folder or a pattern without matches', async () => {
    const root = freshRoot();
    expect(await globFiles('*.log', path.join(root, 'absent'))).toEqual({ files: [], truncated: false });
    expect(await globFiles('nothing/*.log', root)).toEqual({ files: [], truncated: false });
    expect(await globFiles('', root)).toEqual({ files: [], truncated: false });
  });
});

describe('globFiles case rules', () => {
  it('is case-insensitive on win32 and darwin and case-sensitive elsewhere', async () => {
    const root = tree(freshRoot(), ['Readme.LOG', 'Sub/Item.Log']);
    const star = await rel('*.log', root);
    const literal = await rel('sub/item.log', root);
    if (pathsCaseInsensitive) {
      expect(star.names).toEqual(['Readme.LOG']);
      expect(literal.names).toHaveLength(1);
      expect(literal.names[0]?.toLowerCase()).toBe('sub/item.log');
    } else {
      expect(star.names).toEqual([]);
      expect(literal.names).toEqual([]);
    }
    expect((await rel('*.LOG', root)).names).toEqual(['Readme.LOG']);
  });
});
