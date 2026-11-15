// The DA memory reader (CAW design 03 section 3): read-only, only `meta.json` (and `index.json` as a degraded fallback) is ever
// opened, only a redacted summary, two counts and a time leave it. Real folders from the testkit fixture; a spy wraps the file
// system where a test must see which files were opened.
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CANARY,
  DA_INDEX_MAX_BYTES,
  DA_META_MAX_BYTES,
  daVariantFolders,
  useTempDirs,
  writeDaMemory,
  type DaFolderSpec,
} from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { createDaMemoryReader, defaultDaMemoryDir, nodeDaFs, type DaFs } from './da-memory.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const MIN = 60_000;

function memoryDir(): string {
  return path.join(makeTemp('da').path, 'memory');
}

/** True when the text holds a C0 or C1 control character or a right-to-left override. */
function hasUnsafeChar(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x202e) return true;
  }
  return false;
}

/** The real file system, with every call recorded. */
function spied(): { fs: DaFs; reads: string[]; lists: string[] } {
  const reads: string[] = [];
  const lists: string[] = [];
  const fs: DaFs = {
    readdir: (dir) => {
      lists.push(dir);
      return nodeDaFs.readdir(dir);
    },
    readText: (file, max) => {
      reads.push(file);
      return nodeDaFs.readText(file, max);
    },
  };
  return { fs, reads, lists };
}

function readerOver(dir: string, extra: { fs?: DaFs; cacheMs?: number; maxFolders?: number } = {}) {
  return createDaMemoryReader({
    dir,
    win32: true,
    cacheMs: extra.cacheMs ?? 0,
    ...(extra.fs === undefined ? {} : { fs: extra.fs }),
    ...(extra.maxFolders === undefined ? {} : { maxFolders: extra.maxFolders }),
  });
}

describe('defaultDaMemoryDir', () => {
  it('is <home>/.claude/memory, whatever CLAUDE_CONFIG_DIR says', () => {
    expect(defaultDaMemoryDir()).toBe(path.join(os.homedir(), '.claude', 'memory'));
  });
});

describe('a memory folder that is not there', () => {
  it('is absent for a missing folder, and no file is created', async () => {
    const dir = memoryDir();
    const result = await readerOver(dir).read(NOW);
    expect(result).toEqual({ status: 'absent', folders: [], skipped: 0, readAtMs: NOW });
    expect(await nodeDaFs.readdir(dir)).toEqual({ code: 'ENOENT' });
  });

  it('is absent when the name is a file (ENOTDIR)', async () => {
    const file = path.join(makeTemp('da').path, 'memory');
    writeFileSync(file, 'x');
    const result = await readerOver(file).read(NOW);
    expect(result.status).toBe('absent');
  });

  it('is unreadable for any other error code, and never throws', async () => {
    const fs: DaFs = { readdir: () => Promise.resolve({ code: 'EACCES' }), readText: () => Promise.resolve(null) };
    const result = await readerOver('D:/nowhere', { fs }).read(NOW);
    expect(result.status).toBe('unreadable');
    expect(result.folders).toEqual([]);
    const throwing: DaFs = { readdir: () => Promise.reject(new Error('boom')), readText: () => Promise.resolve(null) };
    expect((await readerOver('D:/nowhere', { fs: throwing }).read(NOW)).status).toBe('unreadable');
  });
});

describe('the scan of meta.json', () => {
  it('lists folders newest first, ties by slug, with the fields of the contract', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [
        { path: 'D:\\FIXTURE-da\\old', ageMs: 60 * MIN },
        {
          path: 'D:\\FIXTURE-da\\b-tie',
          ageMs: 5 * MIN,
          counts: { brain: 4, action: 6 },
          summary: 'second  line\n here',
        },
        { path: 'D:\\FIXTURE-da\\a-tie', ageMs: 5 * MIN },
        { path: 'D:\\FIXTURE-da\\new', ageMs: MIN },
      ],
    });
    const result = await readerOver(dir).read(NOW);
    expect(result.status).toBe('ok');
    expect(result.skipped).toBe(0);
    expect(result.readAtMs).toBe(NOW);
    expect(result.folders.map((f) => f.path)).toEqual([
      'D:\\FIXTURE-da\\new',
      'D:\\FIXTURE-da\\a-tie',
      'D:\\FIXTURE-da\\b-tie',
      'D:\\FIXTURE-da\\old',
    ]);
    expect(result.folders[2]).toEqual({
      slug: 'D-FIXTURE-da-b-tie',
      rawPath: 'D:\\FIXTURE-da\\b-tie',
      path: 'D:\\FIXTURE-da\\b-tie',
      lastUpdatedMs: NOW - 5 * MIN,
      summary: 'second line here',
      brain: 4,
      action: 6,
      merged: 0,
    });
  });

  it('counts an entry without a usable meta.json as skipped, never as a folder', async () => {
    const dir = memoryDir();
    const specs: DaFolderSpec[] = [
      { path: 'D:\\FIXTURE-da\\good' },
      ...daVariantFolders('invalid-json'),
      ...daVariantFolders('not-object'),
      ...daVariantFolders('no-path'),
      ...daVariantFolders('odd-slug'),
      { path: 'D:\\FIXTURE-da\\gone', meta: 'missing' },
    ];
    writeDaMemory(dir, { nowMs: NOW, folders: specs, index: 'missing' });
    const result = await readerOver(dir).read(NOW);
    expect(result.folders.map((f) => f.path)).toEqual(['D:\\FIXTURE-da\\good']);
    // invalid-json, not-object, no-path and the missing meta.json; the odd slug has a space and is no candidate at all
    expect(result.skipped).toBe(4);
  });

  it('reads no meta.json larger than 512 KiB', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [{ path: 'D:\\FIXTURE-da\\ok' }, ...daVariantFolders('oversize')],
      index: 'missing',
    });
    const seen: number[] = [];
    const fs: DaFs = {
      readdir: (d) => nodeDaFs.readdir(d),
      readText: (file, max) => {
        seen.push(max);
        return nodeDaFs.readText(file, max);
      },
    };
    const result = await readerOver(dir, { fs }).read(NOW);
    expect(seen.length).toBe(2);
    expect(seen.every((max) => max === DA_META_MAX_BYTES)).toBe(true);
    expect(result.folders.map((f) => f.path)).toEqual(['D:\\FIXTURE-da\\ok']);
    expect(result.skipped).toBe(1);
  });

  it('reads a meta.json behind a byte order mark', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, { nowMs: NOW, folders: daVariantFolders('bom'), index: 'missing' });
    const result = await readerOver(dir).read(NOW);
    expect(result.folders.map((f) => f.path)).toEqual(['D:\\FIXTURE-da\\bom']);
  });

  it('maps a WSL path to a drive path and keeps the raw spelling', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, { nowMs: NOW, folders: daVariantFolders('wsl') });
    const [folder] = (await readerOver(dir).read(NOW)).folders;
    expect(folder?.rawPath).toBe('/mnt/d/FIXTURE-da/wsl');
    expect(folder?.path).toBe('D:\\FIXTURE-da\\wsl');
  });

  it('gives a UNC path no usable path, so it can never start a process', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, { nowMs: NOW, folders: daVariantFolders('unc') });
    const [folder] = (await readerOver(dir).read(NOW)).folders;
    expect(folder?.path).toBeNull();
    expect(folder?.rawPath).toBe('\\\\FIXTURE-host\\share\\dir');
  });

  it('unquotes a quoted path and drops a trailing separator', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [...daVariantFolders('quoted'), ...daVariantFolders('trailing-backslash')],
    });
    const paths = (await readerOver(dir).read(NOW)).folders.map((f) => f.path).sort();
    expect(paths).toEqual(['D:\\FIXTURE-da\\quoted dir', 'D:\\FIXTURE-da\\trail']);
  });

  it('reads a time that is not exactly the DA format as null, and sorts it last', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [
        { path: 'D:\\FIXTURE-da\\bad-time', lastUpdated: '2026-13-45T99:00:00' },
        { path: 'D:\\FIXTURE-da\\no-time', lastUpdated: null },
        { path: 'D:\\FIXTURE-da\\fine', ageMs: 3 * MIN },
      ],
    });
    const folders = (await readerOver(dir).read(NOW)).folders;
    expect(folders.map((f) => f.lastUpdatedMs)).toEqual([NOW - 3 * MIN, null, null]);
    expect(folders[0]?.path).toBe('D:\\FIXTURE-da\\fine');
  });

  it('accepts a count only as a non-negative safe integer, else 0', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, { nowMs: NOW, folders: [{ path: 'D:\\FIXTURE-da\\odd-counts' }], index: 'missing' });
    const meta = path.join(dir, 'D-FIXTURE-da-odd-counts', 'meta.json');
    writeFileSync(
      meta,
      JSON.stringify({ path: 'D:\\FIXTURE-da\\odd-counts', counts: { brain: -3, action: 1.5 }, last_updated: null }),
    );
    const [folder] = (await readerOver(dir).read(NOW)).folders;
    expect([folder?.brain, folder?.action]).toEqual([0, 0]);
    writeFileSync(meta, JSON.stringify({ path: 'D:\\FIXTURE-da\\odd-counts', counts: 'many' }));
    const [again] = (await readerOver(dir).read(NOW)).folders;
    expect([again?.brain, again?.action, again?.summary]).toEqual([0, 0, '']);
  });
});

describe('the summary', () => {
  it('is redacted, whitespace collapsed and at most 120 code points', async () => {
    const dir = memoryDir();
    const long = `${'word  '.repeat(60)}${String.fromCodePoint(0x1f600)}`;
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [
        { path: 'D:\\FIXTURE-da\\secret', ageMs: 0, summary: 'deploy with password=hunter2 now' },
        { path: 'D:\\FIXTURE-da\\long', ageMs: MIN, summary: long },
      ],
    });
    const [secret, clipped] = (await readerOver(dir).read(NOW)).folders;
    expect(secret?.summary).toBe('deploy with password=[redacted] now');
    expect(secret?.summary).not.toContain('hunter2');
    // the cut falls on a space of the repeated words and the trailing space is trimmed
    expect(Array.from(clipped?.summary ?? '').length).toBeGreaterThanOrEqual(119);
    expect(Array.from(clipped?.summary ?? '').length).toBeLessThanOrEqual(120);
    expect(clipped?.summary).not.toMatch(/\s{2}/);
  });

  it('carries no control character and no override, and survives a 100 KB summary', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [
        ...daVariantFolders('hostile-summary'),
        ...daVariantFolders('big-summary').map((f) => ({ ...f, ageMs: MIN })),
      ],
    });
    const folders = (await readerOver(dir).read(NOW)).folders;
    expect(folders).toHaveLength(2);
    for (const folder of folders) {
      expect(hasUnsafeChar(folder.summary)).toBe(false);
      expect(Array.from(folder.summary).length).toBeLessThanOrEqual(120);
    }
  });
});

describe('de-duplication by folder key', () => {
  it('folds two spellings of one folder into the newest, summing the counts', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, { nowMs: NOW, folders: daVariantFolders('case-duplicate') });
    const folders = (await readerOver(dir).read(NOW)).folders;
    expect(folders).toHaveLength(1);
    const [one] = folders;
    expect(one?.path).toBe('D:\\FIXTURE-da\\Case');
    expect(one?.lastUpdatedMs).toBe(NOW - MIN);
    expect([one?.brain, one?.action, one?.merged]).toEqual([7, 10, 1]);
  });

  it('breaks a time tie by the smaller slug', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [
        { path: 'D:\\FIXTURE-da\\Tie', slug: 'zz', ageMs: MIN },
        { path: 'd:/FIXTURE-da/tie', slug: 'aa', ageMs: MIN },
      ],
    });
    const [only] = (await readerOver(dir).read(NOW)).folders;
    expect(only?.slug).toBe('aa');
    expect(only?.merged).toBe(1);
  });

  it('never folds two folders that have no usable path', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [
        { path: '\\\\FIXTURE-host\\share\\one', ageMs: MIN },
        { path: '\\\\FIXTURE-host\\share\\two', ageMs: 2 * MIN },
      ],
    });
    expect((await readerOver(dir).read(NOW)).folders).toHaveLength(2);
  });
});

describe('privacy: what is opened and what leaves', () => {
  it('opens only meta.json files, lists only the memory folder, and no canary appears in the output', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [{ path: 'D:\\FIXTURE-da\\one' }, { path: 'D:\\FIXTURE-da\\two', ageMs: MIN }],
      canary: true,
      keyDecoys: true,
    });
    writeFileSync(path.join(dir, 'da-memory.py'), `# ${CANARY.envToken}\n`);
    writeFileSync(path.join(dir, 'vault.key'), CANARY.key);
    const { fs, reads, lists } = spied();
    const result = await readerOver(dir, { fs }).read(NOW);
    expect(result.folders).toHaveLength(2);
    expect(lists).toEqual([dir]);
    expect([...reads].sort()).toEqual([
      path.join(dir, 'D-FIXTURE-da-one', 'meta.json'),
      path.join(dir, 'D-FIXTURE-da-two', 'meta.json'),
    ]);
    const text = JSON.stringify(result);
    for (const canary of Object.values(CANARY)) expect(text).not.toContain(canary);
  });

  it('keeps the sessions array, created, status and last_kind out of the result', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [{ path: 'D:\\FIXTURE-da\\one', sessions: [{ first: 'SESSIONS-MARKER' }], status: 'STATUS-MARKER' }],
    });
    const result = await readerOver(dir).read(NOW);
    const text = JSON.stringify(result);
    expect(text).not.toContain('SESSIONS-MARKER');
    expect(text).not.toContain('STATUS-MARKER');
    expect(Object.keys(result.folders[0] ?? {}).sort()).toEqual(
      ['action', 'brain', 'lastUpdatedMs', 'merged', 'path', 'rawPath', 'slug', 'summary'].sort(),
    );
  });
});

describe('the index.json fallback', () => {
  it('is used only when no meta.json was readable, with the same output shape', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [
        { path: 'D:\\FIXTURE-da\\one', meta: 'missing', ageMs: MIN, summary: 'from the index' },
        { path: 'D:\\FIXTURE-da\\two', meta: 'missing', ageMs: 3 * MIN },
        { path: '/mnt/d/FIXTURE-da/three', meta: 'missing', ageMs: 2 * MIN },
      ],
    });
    const { fs, reads } = spied();
    const result = await readerOver(dir, { fs }).read(NOW);
    expect(result.status).toBe('ok');
    expect(result.folders.map((f) => f.path)).toEqual([
      'D:\\FIXTURE-da\\one',
      'D:\\FIXTURE-da\\three',
      'D:\\FIXTURE-da\\two',
    ]);
    expect(result.folders[0]?.summary).toBe('from the index');
    expect(reads.filter((file) => file.endsWith('index.json'))).toEqual([path.join(dir, 'index.json')]);
  });

  it('is never opened while a meta.json is readable', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [{ path: 'D:\\FIXTURE-da\\one' }, { path: 'D:\\FIXTURE-da\\two', meta: 'missing' }],
    });
    const { fs, reads } = spied();
    const result = await readerOver(dir, { fs }).read(NOW);
    expect(result.folders).toHaveLength(1);
    expect(reads.some((file) => file.endsWith('index.json'))).toBe(false);
  });

  it('gives no folders (and the status stays ok) when the index is not JSON or larger than 1 MiB', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [{ path: 'D:\\FIXTURE-da\\one', meta: 'missing' }],
      index: 'invalid',
    });
    expect((await readerOver(dir).read(NOW)).folders).toEqual([]);
    writeFileSync(path.join(dir, 'index.json'), `{"folders": [], "pad": "${'x'.repeat(DA_INDEX_MAX_BYTES)}"}`);
    const result = await readerOver(dir).read(NOW);
    expect(result.folders).toEqual([]);
    expect(result.status).toBe('ok');
  });
});

describe('the cap and the cache', () => {
  it('returns at most 500 folders, the newest ones', async () => {
    const dir = memoryDir();
    const folders = Array.from({ length: 520 }, (_, i) => ({
      path: `D:\\FIXTURE-da\\p${String(i)}`,
      ageMs: i * 1000,
    }));
    writeDaMemory(dir, { nowMs: NOW, folders, index: 'missing' });
    const result = await readerOver(dir).read(NOW);
    expect(result.folders).toHaveLength(500);
    expect(result.folders[0]?.path).toBe('D:\\FIXTURE-da\\p0');
    expect(result.folders[499]?.path).toBe('D:\\FIXTURE-da\\p499');
  });

  it('honours a smaller maxFolders', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      folders: [0, 1, 2, 3].map((i) => ({ path: `D:\\FIXTURE-da\\p${String(i)}`, ageMs: i * 1000 })),
    });
    expect((await readerOver(dir, { maxFolders: 2 }).read(NOW)).folders).toHaveLength(2);
  });

  it('reads the disk once per cache window and once for concurrent callers', async () => {
    const dir = memoryDir();
    writeDaMemory(dir, { nowMs: NOW, folders: [{ path: 'D:\\FIXTURE-da\\one' }] });
    const { fs, lists } = spied();
    const reader = readerOver(dir, { fs, cacheMs: 3000 });
    const [a, b] = await Promise.all([reader.read(NOW), reader.read(NOW + 10)]);
    expect(a).toBe(b);
    expect(lists).toHaveLength(1);
    await reader.read(NOW + 2999);
    expect(lists).toHaveLength(1);
    const later = await reader.read(NOW + 3000);
    expect(lists).toHaveLength(2);
    expect(later.readAtMs).toBe(NOW + 3000);
  });

  it('reads again when the clock went backwards', async () => {
    const dir = memoryDir();
    mkdirSync(dir, { recursive: true });
    const { fs, lists } = spied();
    const reader = readerOver(dir, { fs, cacheMs: 3000 });
    await reader.read(NOW);
    await reader.read(NOW - 10_000);
    expect(lists).toHaveLength(2);
  });
});
