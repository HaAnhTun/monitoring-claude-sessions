// The root folder of a Claude project folder (CAW design 03 section 4.2): the working directory from the first lines of the three
// newest main transcripts, and, when a folder has none, a decode of its name that the file system guides. Real temp folders for
// the transcript sniff; an in-memory file system for the decode, so that Windows and POSIX trees run on every host.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { nodeDiscoveryFs, type DiscoveryFs, type EntryStat } from '../ingest/transcripts/discovery.ts';
import { readProjectRoot, reverseProjectName } from './project-root.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const MIN = 60_000;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const S4 = '44444444-4444-4444-8444-444444444444';
const BS = String.fromCharCode(92);

const other = JSON.stringify({ type: 'user', message: 'FIXTURE line without a working directory' });
const withCwd = (cwd: string): string => JSON.stringify({ type: 'user', cwd, message: 'FIXTURE' });

function projectDir(): string {
  const dir = path.join(makeTemp('root').path, 'projects', 'D--FIXTURE-work-app');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A main transcript with these lines, modified `ageMin` minutes before NOW. */
function transcript(dir: string, id: string, lines: readonly string[], ageMin: number): string {
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  const at = new Date(NOW - ageMin * MIN);
  utimesSync(file, at, at);
  return file;
}

describe('readProjectRoot', () => {
  it('finds a cwd on line 61 and not on line 62', async () => {
    const dir = projectDir();
    const filler = Array.from({ length: 60 }, () => other);
    transcript(dir, S1, [...filler, withCwd('D:\\FIXTURE-work\\app')], 1);
    expect(await readProjectRoot(nodeDiscoveryFs, dir, { win32: true })).toEqual({
      root: 'D:\\FIXTURE-work\\app',
      source: 'transcript',
    });
    transcript(dir, S1, [...filler, other, withCwd('D:\\FIXTURE-work\\app')], 1);
    expect(await readProjectRoot(nodeDiscoveryFs, dir, { win32: true })).toBeNull();
  });

  it('looks at the three newest main files only, newest first', async () => {
    const dir = projectDir();
    transcript(dir, S1, [other], 1);
    transcript(dir, S2, [other], 2);
    transcript(dir, S3, [other], 3);
    transcript(dir, S4, [withCwd('D:\\FIXTURE-work\\old')], 4);
    expect(await readProjectRoot(nodeDiscoveryFs, dir, { win32: true })).toBeNull();
    transcript(dir, S3, [withCwd('D:\\FIXTURE-work\\third')], 3);
    expect(await readProjectRoot(nodeDiscoveryFs, dir, { win32: true })).toEqual({
      root: 'D:\\FIXTURE-work\\third',
      source: 'transcript',
    });
    transcript(dir, S1, [withCwd('D:\\FIXTURE-work\\newest')], 1);
    expect((await readProjectRoot(nodeDiscoveryFs, dir, { win32: true }))?.root).toBe('D:\\FIXTURE-work\\newest');
  });

  it('writes the root in the Windows form, and skips a cwd that cannot be a folder', async () => {
    const dir = projectDir();
    transcript(dir, S1, [withCwd('\\\\FIXTURE-host\\share\\dir')], 1);
    transcript(dir, S2, [withCwd('d:/FIXTURE-work/app/')], 2);
    expect(await readProjectRoot(nodeDiscoveryFs, dir, { win32: true })).toEqual({
      root: 'D:\\FIXTURE-work\\app',
      source: 'transcript',
    });
  });

  it('keeps a POSIX cwd on a POSIX host and refuses it on Windows', async () => {
    const dir = projectDir();
    transcript(dir, S1, [withCwd('/home/FIXTURE/app')], 1);
    expect((await readProjectRoot(nodeDiscoveryFs, dir, { win32: false }))?.root).toBe('/home/FIXTURE/app');
    expect(await readProjectRoot(nodeDiscoveryFs, dir, { win32: true })).toBeNull();
  });

  it('ignores agent files, folders and names that are no session id', async () => {
    const dir = projectDir();
    writeFileSync(path.join(dir, 'agent-a1b2c3d4e5f6a7b8c.jsonl'), `${withCwd('D:\\FIXTURE-work\\agent')}\n`);
    writeFileSync(path.join(dir, 'notes.jsonl'), `${withCwd('D:\\FIXTURE-work\\notes')}\n`);
    mkdirSync(path.join(dir, S1, 'subagents'), { recursive: true });
    writeFileSync(path.join(dir, S1, 'subagents', `${S2}.jsonl`), `${withCwd('D:\\FIXTURE-work\\sub')}\n`);
    expect(await readProjectRoot(nodeDiscoveryFs, dir, { win32: true })).toBeNull();
  });

  it('is null for an empty folder and for a folder that is gone', async () => {
    const dir = projectDir();
    expect(await readProjectRoot(nodeDiscoveryFs, dir, { win32: true })).toBeNull();
    expect(await readProjectRoot(nodeDiscoveryFs, path.join(dir, 'gone'), { win32: true })).toBeNull();
  });
});

// ---- the decode --------------------------------------------------------------------------------------------------------------

/** An in-memory tree: `dirs` and `files` are full paths in the spelling of the host that is simulated. */
function treeFs(sep: string, dirs: readonly string[], files: readonly string[] = [], links: readonly string[] = []) {
  const kinds = new Map<string, EntryStat['kind']>();
  for (const dir of dirs) kinds.set(dir, 'dir');
  for (const file of files) kinds.set(file, 'file');
  for (const link of links) kinds.set(link, 'link');
  const calls = { readdir: 0, lstat: 0 };
  const children = (dir: string): string[] => {
    const prefix = dir.endsWith(sep) ? dir : dir + sep;
    const names: string[] = [];
    for (const entry of kinds.keys()) {
      if (entry.startsWith(prefix) && entry.length > prefix.length && !entry.slice(prefix.length).includes(sep)) {
        names.push(entry.slice(prefix.length));
      }
    }
    return names;
  };
  const fs: DiscoveryFs = {
    readdir(dir) {
      calls.readdir += 1;
      return kinds.get(dir) === 'dir' ? Promise.resolve(children(dir)) : Promise.reject(new Error('ENOENT'));
    },
    lstat(file) {
      calls.lstat += 1;
      const kind = kinds.get(file);
      return Promise.resolve(kind === undefined ? null : { kind, size: 0, mtimeMs: 0, birthMs: null });
    },
    readText: () => Promise.resolve(null),
    readHead: () => Promise.resolve(null),
  };
  return { fs, calls };
}

/** A Windows path; one part alone is a drive root (`D:` becomes `D:\`). */
const win = (...parts: string[]): string => parts.join(BS) + (parts.length === 1 ? BS : '');

describe('reverseProjectName on Windows', () => {
  it('decodes D--FIXTURE-work-app through the folders that exist', async () => {
    const { fs } = treeFs(BS, [win('D:'), win('D:', 'FIXTURE-work'), win('D:', 'FIXTURE-work', 'app')]);
    expect(await reverseProjectName('D--FIXTURE-work-app', fs, { win32: true })).toBe(win('D:', 'FIXTURE-work', 'app'));
  });

  it('decodes D--work-app (the README example) and a drive root alone', async () => {
    const { fs } = treeFs(BS, [win('D:'), win('D:', 'work'), win('D:', 'work', 'app')]);
    expect(await reverseProjectName('D--work-app', fs, { win32: true })).toBe(win('D:', 'work', 'app'));
    expect(await reverseProjectName('D--work', fs, { win32: true })).toBe(win('D:', 'work'));
  });

  it('finds a dot folder: D--work--claude is D:\\work\\.claude', async () => {
    const { fs } = treeFs(BS, [win('D:'), win('D:', 'work'), win('D:', 'work', '.claude')]);
    expect(await reverseProjectName('D--work--claude', fs, { win32: true })).toBe(win('D:', 'work', '.claude'));
  });

  it('treats a space like any other separator character', async () => {
    const { fs } = treeFs(BS, [win('D:'), win('D:', 'my work'), win('D:', 'my work', 'app')]);
    expect(await reverseProjectName('D--my-work-app', fs, { win32: true })).toBe(win('D:', 'my work', 'app'));
  });

  describe('mcs-v4 against mcs and v4', () => {
    const name = 'D--mcs-v4';
    it('is D:\\mcs\\v4 when only that exists', async () => {
      const { fs } = treeFs(BS, [win('D:'), win('D:', 'mcs'), win('D:', 'mcs', 'v4')]);
      expect(await reverseProjectName(name, fs, { win32: true })).toBe(win('D:', 'mcs', 'v4'));
    });

    it('is D:\\mcs-v4 when only that exists', async () => {
      const { fs } = treeFs(BS, [win('D:'), win('D:', 'mcs-v4')]);
      expect(await reverseProjectName(name, fs, { win32: true })).toBe(win('D:', 'mcs-v4'));
    });

    it('prefers the longest entry when both exist, then backs out of a dead end', async () => {
      const both = treeFs(BS, [win('D:'), win('D:', 'mcs-v4'), win('D:', 'mcs'), win('D:', 'mcs', 'v4')]);
      expect(await reverseProjectName(name, both.fs, { win32: true })).toBe(win('D:', 'mcs-v4'));
      const fileFirst = treeFs(BS, [win('D:'), win('D:', 'mcs'), win('D:', 'mcs', 'v4')], [win('D:', 'mcs-v4')]);
      expect(await reverseProjectName(name, fileFirst.fs, { win32: true })).toBe(win('D:', 'mcs', 'v4'));
    });
  });

  it('ignores case, and answers with the spelling of the file system', async () => {
    const { fs } = treeFs(BS, [win('D:'), win('D:', 'Work'), win('D:', 'Work', 'App')]);
    expect(await reverseProjectName('d--work-app', fs, { win32: true })).toBe(win('D:', 'Work', 'App'));
  });

  it('is null when the folder is gone, the drive is missing or a link is in the way', async () => {
    const { fs } = treeFs(BS, [win('D:'), win('D:', 'work')]);
    expect(await reverseProjectName('D--work-app', fs, { win32: true })).toBeNull();
    expect(await reverseProjectName('E--work', fs, { win32: true })).toBeNull();
    const linked = treeFs(BS, [win('D:')], [], [win('D:', 'work')]);
    expect(await reverseProjectName('D--work', linked.fs, { win32: true })).toBeNull();
  });

  it('is null for a name that is no project folder name, or has no drive on Windows', async () => {
    const { fs, calls } = treeFs(BS, [win('D:')]);
    expect(await reverseProjectName('D--a b', fs, { win32: true })).toBeNull();
    expect(await reverseProjectName('-home-dev', fs, { win32: true })).toBeNull();
    expect(await reverseProjectName('', fs, { win32: true })).toBeNull();
    expect(calls.readdir).toBe(0);
  });

  it('spends at most 64 readdir calls by default, and honours a smaller budget', async () => {
    const dirs = [win('D:')];
    let at = 'D:';
    for (let i = 0; i < 80; i += 1) {
      at = win(at, 'a');
      dirs.push(at);
    }
    const name = `D--${'a-'.repeat(79)}b`;
    const deep = treeFs(BS, dirs);
    expect(await reverseProjectName(name, deep.fs, { win32: true })).toBeNull();
    expect(deep.calls.readdir).toBe(64);
    const small = treeFs(BS, [win('D:'), win('D:', 'work'), win('D:', 'work', 'app')]);
    expect(await reverseProjectName('D--work-app', small.fs, { win32: true, maxReaddirs: 1 })).toBeNull();
    expect(small.calls.readdir).toBe(1);
  });

  it('looks at no more than 5,000 entries of one folder', async () => {
    const dirs = [win('D:')];
    for (let i = 0; i < 5000; i += 1) dirs.push(win('D:', `x${String(i).padStart(5, '0')}`));
    dirs.push(win('D:', 'ab'));
    const { fs } = treeFs(BS, dirs);
    // the file system lists `ab` as the 5,001st name: it is not considered
    expect(await reverseProjectName('D--ab', fs, { win32: true })).toBeNull();
    const early = treeFs(BS, [win('D:'), win('D:', 'ab'), ...dirs.slice(1, 5000)]);
    expect(await reverseProjectName('D--ab', early.fs, { win32: true })).toBe(win('D:', 'ab'));
  });
});

describe('reverseProjectName on POSIX', () => {
  it('decodes -home-dev-app from the root', async () => {
    const { fs } = treeFs('/', ['/', '/home', '/home/dev', '/home/dev/app']);
    expect(await reverseProjectName('-home-dev-app', fs, { win32: false })).toBe('/home/dev/app');
  });

  it('is case sensitive and has no drives', async () => {
    const { fs } = treeFs('/', ['/', '/home', '/home/dev', '/home/dev/App']);
    expect(await reverseProjectName('-home-dev-app', fs, { win32: false })).toBeNull();
    expect(await reverseProjectName('D--home', fs, { win32: false })).toBeNull();
    expect(await reverseProjectName('-home-dev-App', fs, { win32: false })).toBe('/home/dev/App');
  });

  it('finds a dot folder below a home folder', async () => {
    const { fs } = treeFs('/', ['/', '/home', '/home/dev', '/home/dev/.config']);
    expect(await reverseProjectName('-home-dev--config', fs, { win32: false })).toBe('/home/dev/.config');
  });
});
