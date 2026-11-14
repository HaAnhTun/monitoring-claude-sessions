import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CANARY, scanForCanaries } from './canary.ts';
import {
  DA_INDEX_MAX_BYTES,
  DA_META_MAX_BYTES,
  DA_VARIANTS,
  daMemoryDir,
  daSlug,
  daTimestamp,
  daVariantFolders,
  writeDaMemory,
  type DaFolderSpec,
} from './da-memory.ts';
import { useTempDirs } from './temp.ts';

const tempDir = useTempDirs();
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function memoryDir(): string {
  return daMemoryDir(join(tempDir('da-memory').path, 'home'));
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function readJson(path: string): Record<string, unknown> {
  const value = parseJson(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return Object.fromEntries(Object.entries(value));
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return Object.fromEntries(Object.entries(value));
}

describe('DA memory names', () => {
  it('keeps the memory folder at <home>/.claude/memory, whatever CLAUDE_CONFIG_DIR says', () => {
    expect(daMemoryDir(join('x', 'home'))).toBe(join('x', 'home', '.claude', 'memory'));
  });

  it('turns a path into a slug the way the hook script does: runs of other characters become one dash', () => {
    expect(daSlug('D:\\work\\app')).toBe('D-work-app');
    expect(daSlug('/mnt/d/x')).toBe('-mnt-d-x');
    expect(daSlug('D:\\a  b\\.c\\')).toBe('D-a-b-c-');
    expect(daSlug('plain')).toBe('plain');
  });

  it('formats a naive local time of the form %Y-%m-%dT%H:%M:%S', () => {
    expect(daTimestamp(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    const local = new Date(NOW);
    const pad = (n: number): string => String(n).padStart(2, '0');
    expect(daTimestamp(NOW)).toBe(
      `${String(local.getFullYear())}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`,
    );
    expect(new Date(daTimestamp(NOW)).getTime()).toBe(NOW);
  });
});

describe('writeDaMemory', () => {
  it('writes one folder per spec with a meta.json of the fields of the hook script and an index.json', () => {
    const dir = memoryDir();
    const fixture = writeDaMemory(dir, {
      nowMs: NOW,
      folders: [
        { path: 'D:\\FIXTURE-da\\one', ageMs: 60_000, summary: 'FIXTURE summary one', counts: { brain: 3, action: 4 } },
        { path: 'D:\\FIXTURE-da\\two', ageMs: 3_600_000 },
      ],
    });
    expect(fixture.dir).toBe(dir);
    expect(fixture.slugs).toEqual(['D-FIXTURE-da-one', 'D-FIXTURE-da-two']);
    expect(fixture.indexPath).toBe(join(dir, 'index.json'));
    expect(readdirSync(dir).sort()).toEqual(['D-FIXTURE-da-one', 'D-FIXTURE-da-two', 'index.json']);
    expect(fixture.metaPath('D-FIXTURE-da-one')).toBe(join(dir, 'D-FIXTURE-da-one', 'meta.json'));
    const meta = readJson(fixture.metaPath('D-FIXTURE-da-one'));
    expect(meta).toEqual({
      path: 'D:\\FIXTURE-da\\one',
      slug: 'D-FIXTURE-da-one',
      created: daTimestamp(NOW - 60_000),
      last_updated: daTimestamp(NOW - 60_000),
      last_kind: 'brain',
      counts: { brain: 3, action: 4 },
      sessions: [],
      summary: 'FIXTURE summary one',
      status: 'active',
    });
    const second = readJson(fixture.metaPath('D-FIXTURE-da-two'));
    expect(second['last_updated']).toBe(daTimestamp(NOW - 3_600_000));
    expect(second['summary']).toBe('FIXTURE summary D-FIXTURE-da-two');
    expect(second['counts']).toEqual({ brain: 1, action: 1 });
    const index = readJson(fixture.indexPath);
    expect(index['updated']).toBe(daTimestamp(NOW));
    expect(index['folders']).toEqual([
      {
        slug: 'D-FIXTURE-da-one',
        path: 'D:\\FIXTURE-da\\one',
        last_updated: daTimestamp(NOW - 60_000),
        summary: 'FIXTURE summary one',
        status: 'active',
        counts: { brain: 3, action: 4 },
      },
      expect.objectContaining({ slug: 'D-FIXTURE-da-two' }),
    ]);
  });

  it('writes no marker or other file into the memory folder: the reader treats every entry there as a candidate', () => {
    const dir = memoryDir();
    writeDaMemory(dir, { nowMs: NOW, folders: [{ path: 'D:\\FIXTURE-da\\only' }] });
    expect(readdirSync(dir).sort()).toEqual(['D-FIXTURE-da-only', 'index.json']);
    expect(readdirSync(join(dir, 'D-FIXTURE-da-only'))).toEqual(['meta.json']);
  });

  it('sets the modification times of the files from nowMs and the age, never from the clock', () => {
    const dir = memoryDir();
    const fixture = writeDaMemory(dir, { nowMs: NOW, folders: [{ path: 'D:\\FIXTURE-da\\old', ageMs: 86_400_000 }] });
    expect(Math.abs(statSync(fixture.metaPath('D-FIXTURE-da-old')).mtimeMs - (NOW - 86_400_000))).toBeLessThan(1000);
    expect(Math.abs(statSync(fixture.indexPath).mtimeMs - NOW)).toBeLessThan(1000);
  });

  it('takes an explicit slug, a literal timestamp, a null timestamp and extra fields', () => {
    const dir = memoryDir();
    const fixture = writeDaMemory(dir, {
      nowMs: NOW,
      folders: [
        {
          path: 'D:\\FIXTURE-da\\a',
          slug: 'custom-slug',
          lastUpdated: '2026-01-01T00:00:00',
          status: 'archived',
          lastKind: 'action',
          created: '2025-12-31T23:59:59',
        },
        { path: 'D:\\FIXTURE-da\\b', lastUpdated: null },
      ],
    });
    expect(fixture.slugs).toEqual(['custom-slug', 'D-FIXTURE-da-b']);
    expect(readJson(fixture.metaPath('custom-slug'))).toMatchObject({
      last_updated: '2026-01-01T00:00:00',
      status: 'archived',
      last_kind: 'action',
      created: '2025-12-31T23:59:59',
    });
    expect(readJson(fixture.metaPath('D-FIXTURE-da-b'))['last_updated']).toBeNull();
  });

  it('refuses two folders with one slug and a slug that is not a plain file name', () => {
    const dir = memoryDir();
    expect(() =>
      writeDaMemory(dir, {
        nowMs: NOW,
        folders: [
          { path: 'D:\\x', slug: 's' },
          { path: 'D:\\y', slug: 's' },
        ],
      }),
    ).toThrow(/slug/);
    for (const slug of ['', '.', '..', 'a/b', 'a\\b']) {
      expect(() => writeDaMemory(dir, { nowMs: NOW, folders: [{ path: 'D:\\x', slug }] }), slug).toThrow(RangeError);
    }
  });

  it('writes the canary into brain.md, action.md and the sessions array, and nowhere else, when asked', () => {
    const dir = memoryDir();
    const fixture = writeDaMemory(dir, { nowMs: NOW, canary: true, folders: [{ path: 'D:\\FIXTURE-da\\c' }] });
    const folder = join(dir, 'D-FIXTURE-da-c');
    expect(readdirSync(folder).sort()).toEqual(['action.md', 'brain.md', 'meta.json']);
    expect(readFileSync(join(folder, 'brain.md'), 'utf8')).toContain(CANARY.prompt);
    expect(readFileSync(join(folder, 'action.md'), 'utf8')).toContain(CANARY.toolResult);
    const sessions = readJson(fixture.metaPath('D-FIXTURE-da-c'))['sessions'];
    expect(JSON.stringify(sessions)).toContain(CANARY.thinking);
    const meta = readFileSync(fixture.metaPath('D-FIXTURE-da-c'), 'utf8');
    expect(meta).not.toContain(CANARY.prompt);
    expect(meta).not.toContain(CANARY.toolResult);
    expect(readFileSync(fixture.indexPath, 'utf8')).not.toContain('FIXTURE-CANARY');
    const hits = scanForCanaries([dir], []).map((hit) => hit.canary);
    expect(hits.sort()).toEqual(['prompt', 'thinking', 'toolResult']);
  });

  it('writes the text of brain.md and action.md that a folder asks for, and key decoys when asked', () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      keyDecoys: true,
      folders: [{ path: 'D:\\FIXTURE-da\\d', brainText: 'FIXTURE brain text', actionText: 'FIXTURE action text' }],
    });
    const folder = join(dir, 'D-FIXTURE-da-d');
    expect(readFileSync(join(folder, 'brain.md'), 'utf8')).toBe('FIXTURE brain text');
    expect(readFileSync(join(folder, 'action.md'), 'utf8')).toBe('FIXTURE action text');
    expect(readdirSync(folder).sort()).toEqual(['action.md', 'brain.md', 'meta.json', 'session.key']);
    expect(readFileSync(join(folder, 'session.key'), 'utf8')).toBe(CANARY.key);
  });

  it('can leave the index out, make it stale, or make it unreadable', () => {
    const base: DaFolderSpec[] = [{ path: 'D:\\FIXTURE-da\\one', ageMs: 1000 }, { path: 'D:\\FIXTURE-da\\two' }];
    const none = writeDaMemory(memoryDir(), { nowMs: NOW, folders: base, index: 'missing' });
    expect(existsSync(none.indexPath)).toBe(false);
    const invalid = writeDaMemory(memoryDir(), { nowMs: NOW, folders: base, index: 'invalid' });
    expect(() => parseJson(readFileSync(invalid.indexPath, 'utf8'))).toThrow();
    const stale = writeDaMemory(memoryDir(), { nowMs: NOW, folders: base, index: 'stale' });
    const index = readJson(stale.indexPath);
    expect(Date.parse(String(index['updated']))).toBeLessThan(NOW - 3_000_000);
    const listed = (index['folders'] as unknown[]).map((entry) => record(entry)['slug']);
    expect(listed).toContain('FIXTURE-da-ghost');
    expect(listed).toHaveLength(base.length + 1);
    expect(existsSync(join(stale.dir, 'FIXTURE-da-ghost'))).toBe(false);
    const aged = (index['folders'] as unknown[]).map((entry) => record(entry)['last_updated']);
    const fresh = readJson(writeDaMemory(memoryDir(), { nowMs: NOW, folders: base }).indexPath);
    expect(aged).not.toEqual((fresh['folders'] as unknown[]).map((entry) => record(entry)['last_updated']));
  });

  it('lists a folder in the index even when its meta.json is missing, so the degraded reader has something to read', () => {
    const dir = memoryDir();
    const fixture = writeDaMemory(dir, { nowMs: NOW, folders: [{ path: 'D:\\FIXTURE-da\\m', meta: 'missing' }] });
    expect(existsSync(join(dir, 'D-FIXTURE-da-m'))).toBe(true);
    expect(existsSync(fixture.metaPath('D-FIXTURE-da-m'))).toBe(false);
    expect((readJson(fixture.indexPath)['folders'] as unknown[]).length).toBe(1);
    const hidden = writeDaMemory(memoryDir(), { nowMs: NOW, folders: [{ path: 'D:\\FIXTURE-da\\h', inIndex: false }] });
    expect(readJson(hidden.indexPath)['folders']).toEqual([]);
  });

  it('writes JSON and Markdown only, never a script', () => {
    const dir = memoryDir();
    writeDaMemory(dir, {
      nowMs: NOW,
      canary: true,
      keyDecoys: true,
      folders: Object.keys(DA_VARIANTS).flatMap((variant) => daVariantFolders(variant as keyof typeof DA_VARIANTS)),
    });
    const extensions = new Set<string>();
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(current, entry.name));
        else extensions.add(entry.name.slice(entry.name.lastIndexOf('.')));
      }
    };
    walk(dir);
    expect([...extensions].sort()).toEqual(['.json', '.key', '.md']);
  });
});

describe('DA memory variants (design 08, section 2.7)', () => {
  const write = (specs: DaFolderSpec[]): ReturnType<typeof writeDaMemory> =>
    writeDaMemory(memoryDir(), { nowMs: NOW, folders: specs });

  it('lists every variant by name', () => {
    expect(Object.keys(DA_VARIANTS).sort()).toEqual(
      [
        'big-summary',
        'bom',
        'case-duplicate',
        'hostile-summary',
        'invalid-json',
        'missing-fields',
        'no-path',
        'not-object',
        'odd-slug',
        'oversize',
        'quoted',
        'trailing-backslash',
        'unc',
        'wsl',
      ].sort(),
    );
  });

  it('wsl keeps the mapped path as written', () => {
    const fixture = write(daVariantFolders('wsl'));
    expect(readJson(fixture.metaPath(fixture.slugs[0] ?? ''))['path']).toBe('/mnt/d/FIXTURE-da/wsl');
  });

  it('quoted and trailing-backslash keep the spelling the hook script could have written', () => {
    const quoted = write(daVariantFolders('quoted'));
    expect(readJson(quoted.metaPath(quoted.slugs[0] ?? ''))['path']).toBe('"D:\\FIXTURE-da\\quoted dir"');
    const trailing = write(daVariantFolders('trailing-backslash'));
    expect(readJson(trailing.metaPath(trailing.slugs[0] ?? ''))['path']).toBe('D:\\FIXTURE-da\\trail\\');
  });

  it('case-duplicate gives two folders that differ only in case and in time', () => {
    const specs = daVariantFolders('case-duplicate');
    expect(specs).toHaveLength(2);
    const fixture = write(specs);
    const [first, second] = fixture.slugs.map((slug) => readJson(fixture.metaPath(slug)));
    const key = (value: unknown): string => String(value).toLowerCase().replaceAll('\\', '/').replace(/\/$/, '');
    expect(key(first?.['path'])).toBe(key(second?.['path']));
    expect(first?.['path']).not.toBe(second?.['path']);
    expect(first?.['last_updated']).not.toBe(second?.['last_updated']);
    expect(new Set(fixture.slugs.map((slug) => slug.toLowerCase())).size).toBe(2);
  });

  it('hostile-summary holds markup, an event handler and control characters', () => {
    const fixture = write(daVariantFolders('hostile-summary'));
    const summary = String(readJson(fixture.metaPath(fixture.slugs[0] ?? ''))['summary']);
    expect(summary).toContain('<img src=x onerror=');
    expect(summary).toContain(String.fromCharCode(7));
    expect(summary).toContain(`${String.fromCharCode(27)}[31m`);
  });

  it('big-summary is about 100 KB of words with runs of spaces', () => {
    const fixture = write(daVariantFolders('big-summary'));
    const file = fixture.metaPath(fixture.slugs[0] ?? '');
    const summary = String(readJson(file)['summary']);
    expect(summary.length).toBeGreaterThanOrEqual(100 * 1024);
    expect(summary).toContain('  ');
    expect(statSync(file).size).toBeLessThan(DA_META_MAX_BYTES);
  });

  it('missing-fields keeps the path and the slug and drops the rest', () => {
    const fixture = write(daVariantFolders('missing-fields'));
    expect(Object.keys(readJson(fixture.metaPath(fixture.slugs[0] ?? ''))).sort()).toEqual(['path', 'slug']);
  });

  it('invalid-json is cut off in the middle, bom starts with a byte order mark, not-object is an array, no-path has no path', () => {
    const invalid = write(daVariantFolders('invalid-json'));
    expect(() => parseJson(readFileSync(invalid.metaPath(invalid.slugs[0] ?? ''), 'utf8'))).toThrow();
    const bom = write(daVariantFolders('bom'));
    const bytes = readFileSync(bom.metaPath(bom.slugs[0] ?? ''));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(() => parseJson(bytes.toString('utf8'))).toThrow();
    expect(typeof record(parseJson(bytes.subarray(3).toString('utf8')))['path']).toBe('string');
    const notObject = write(daVariantFolders('not-object'));
    expect(parseJson(readFileSync(notObject.metaPath(notObject.slugs[0] ?? ''), 'utf8'))).toBeInstanceOf(Array);
    const noPath = write(daVariantFolders('no-path'));
    const meta = readJson(noPath.metaPath(noPath.slugs[0] ?? ''));
    expect('path' in meta).toBe(false);
    expect(typeof meta['summary']).toBe('string');
  });

  it('oversize is a valid meta.json larger than the reader cap, and index.json cap constants are the design values', () => {
    const fixture = write(daVariantFolders('oversize'));
    const file = fixture.metaPath(fixture.slugs[0] ?? '');
    expect(statSync(file).size).toBeGreaterThan(DA_META_MAX_BYTES);
    expect(() => parseJson(readFileSync(file, 'utf8'))).not.toThrow();
    expect(DA_META_MAX_BYTES).toBe(512 * 1024);
    expect(DA_INDEX_MAX_BYTES).toBe(1024 * 1024);
  });

  it('unc points at a share that the reader must refuse, and odd-slug has a folder name the reader must skip', () => {
    const unc = write(daVariantFolders('unc'));
    expect(String(readJson(unc.metaPath(unc.slugs[0] ?? ''))['path'])).toMatch(/^\\\\FIXTURE-host\\/);
    const odd = write(daVariantFolders('odd-slug'));
    expect(odd.slugs[0]).toContain(' ');
    expect(existsSync(odd.metaPath(odd.slugs[0] ?? ''))).toBe(true);
  });

  it('every variant is invented data: paths and text start with FIXTURE or a drive of a fixture folder', () => {
    for (const variant of Object.keys(DA_VARIANTS)) {
      for (const spec of daVariantFolders(variant as keyof typeof DA_VARIANTS)) {
        expect(spec.path.toLowerCase(), variant).toContain('fixture');
      }
    }
  });
});
