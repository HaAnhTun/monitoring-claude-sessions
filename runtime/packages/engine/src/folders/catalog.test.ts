// The catalog of the Claude home folders (CAW design 03 section 4.2): one entry per folder of `<home>/projects`, its key, its
// root folder (from a transcript, else decoded from the name), whether the root exists, cached by the modification time of the
// folder so that an unchanged one costs a single `lstat`. An in-memory file system counts every call; one test uses real folders.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { FakeClock, makeJunction, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nodeDiscoveryFs, type DiscoveryFs, type EntryStat } from '../ingest/transcripts/discovery.ts';
import { createProjectCatalog, type CatalogOptions } from './catalog.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const MIN = 60_000;
const BS = String.fromCharCode(92);
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const ROOT = path.join('projects-root', 'projects');

afterEach(() => {
  vi.useRealTimers();
});

interface Node {
  kind: EntryStat['kind'];
  mtimeMs: number;
  head?: string;
}

/** An in-memory file system that records `<op> <path>` for every call. */
function memFs(nodes: Map<string, Node>, o: { unreadable?: ReadonlySet<string> } = {}) {
  const calls: string[] = [];
  const children = (dir: string): string[] => {
    const names: string[] = [];
    for (const key of nodes.keys()) {
      for (const sep of [BS, '/']) {
        const prefix = dir.endsWith(sep) ? dir : dir + sep;
        if (key.startsWith(prefix) && key.length > prefix.length) {
          const rest = key.slice(prefix.length);
          if (!rest.includes(BS) && !rest.includes('/')) names.push(rest);
        }
      }
    }
    return names;
  };
  const fs: DiscoveryFs = {
    readdir(dir) {
      calls.push(`readdir ${dir}`);
      if (o.unreadable?.has(dir) === true) return Promise.reject(new Error('EACCES'));
      return nodes.get(dir)?.kind === 'dir' ? Promise.resolve(children(dir)) : Promise.reject(new Error('ENOENT'));
    },
    lstat(file) {
      calls.push(`lstat ${file}`);
      const node = nodes.get(file);
      return Promise.resolve(
        node === undefined ? null : { kind: node.kind, size: 0, mtimeMs: node.mtimeMs, birthMs: null },
      );
    },
    readText: () => Promise.resolve(null),
    readHead(file) {
      calls.push(`readHead ${file}`);
      const head = nodes.get(file)?.head;
      return Promise.resolve(head === undefined ? null : Buffer.from(head));
    },
  };
  return { fs, calls, nodes };
}

const dir = (mtimeMs = NOW): Node => ({ kind: 'dir', mtimeMs });
const file = (head: string, mtimeMs = NOW): Node => ({ kind: 'file', mtimeMs, head });
const cwdLine = (cwd: string): string => `${JSON.stringify({ type: 'user', cwd })}\n`;
const win = (...parts: string[]): string => parts.join(BS);

/** A home with a projects folder and the given project folders (name -> its nodes). */
function home(): Map<string, Node> {
  return new Map<string, Node>([[ROOT, dir()]]);
}

function catalogOver(nodes: Map<string, Node>, o: Partial<CatalogOptions> & { unreadable?: ReadonlySet<string> } = {}) {
  const mem = memFs(nodes, o.unreadable === undefined ? {} : { unreadable: o.unreadable });
  const clock = new FakeClock(NOW);
  const catalog = createProjectCatalog({
    projectsRoot: ROOT,
    fs: mem.fs,
    intervalMs: 30_000,
    now: () => clock.now(),
    win32: true,
    ...o,
  });
  return { catalog, clock, ...mem };
}

describe('the entries', () => {
  it('describes each folder: key, mtime, root from the newest transcript, and whether the root exists', async () => {
    const nodes = home();
    const app = path.join(ROOT, 'D--FIXTURE-cat-App');
    nodes.set(app, dir(NOW - MIN));
    nodes.set(path.join(app, `${S1}.jsonl`), file(cwdLine('D:\\FIXTURE-cat\\App'), NOW - MIN));
    nodes.set(win('D:', 'FIXTURE-cat', 'App'), dir());
    const { catalog } = catalogOver(nodes);
    await catalog.refresh();
    expect(catalog.entries()).toEqual([
      {
        dirName: 'D--FIXTURE-cat-App',
        key: 'd--fixture-cat-app',
        dirMtimeMs: NOW - MIN,
        root: 'D:\\FIXTURE-cat\\App',
        rootSource: 'transcript',
        exists: true,
      },
    ]);
  });

  it('says exists false for a root that is gone, and null when no root is known', async () => {
    const nodes = home();
    const gone = path.join(ROOT, 'D--FIXTURE-cat-gone');
    nodes.set(gone, dir(NOW - MIN));
    nodes.set(path.join(gone, `${S1}.jsonl`), file(cwdLine('D:\\FIXTURE-cat\\gone')));
    nodes.set(path.join(ROOT, 'D--FIXTURE-cat-nothing'), dir(NOW - 2 * MIN));
    const { catalog } = catalogOver(nodes);
    await catalog.refresh();
    const byName = Object.fromEntries(catalog.entries().map((e) => [e.dirName, e]));
    expect(byName['D--FIXTURE-cat-gone']).toMatchObject({ root: 'D:\\FIXTURE-cat\\gone', exists: false });
    expect(byName['D--FIXTURE-cat-nothing']).toMatchObject({ root: null, rootSource: null, exists: null });
  });

  it('decodes the name when a folder has no main transcript', async () => {
    const nodes = home();
    nodes.set(path.join(ROOT, 'D--FIXTURE-cat-rev'), dir(NOW - MIN));
    nodes.set(win('D:', ''), dir());
    nodes.set(win('D:', 'FIXTURE-cat'), dir());
    nodes.set(win('D:', 'FIXTURE-cat', 'rev'), dir());
    const { catalog } = catalogOver(nodes);
    await catalog.refresh();
    expect(catalog.entries()[0]).toMatchObject({
      root: win('D:', 'FIXTURE-cat', 'rev'),
      rootSource: 'reverse',
      exists: true,
    });
  });

  it('lists the newest folder first, and skips links and odd names', async () => {
    const nodes = home();
    nodes.set(path.join(ROOT, 'D--old'), dir(NOW - 9 * MIN));
    nodes.set(path.join(ROOT, 'D--new'), dir(NOW - MIN));
    nodes.set(path.join(ROOT, 'D--linked'), { kind: 'link', mtimeMs: NOW });
    nodes.set(path.join(ROOT, 'has space'), dir());
    nodes.set(path.join(ROOT, '.hidden'), dir());
    nodes.set(path.join(ROOT, 'session.key'), file('x'));
    const { catalog } = catalogOver(nodes);
    await catalog.refresh();
    expect(catalog.entries().map((e) => e.dirName)).toEqual(['D--new', 'D--old']);
  });

  it('skips a real junction too', async () => {
    const base = makeTemp('catalog').path;
    const projects = path.join(base, 'projects');
    mkdirSync(path.join(projects, 'D--real'), { recursive: true });
    mkdirSync(path.join(base, 'elsewhere'));
    makeJunction(path.join(projects, 'D--link'), path.join(base, 'elsewhere'));
    const catalog = createProjectCatalog({
      projectsRoot: projects,
      fs: nodeDiscoveryFs,
      intervalMs: 30_000,
      now: () => NOW,
      win32: true,
    });
    await catalog.refresh();
    expect(catalog.entries().map((e) => e.dirName)).toEqual(['D--real']);
  });

  it('finds the root in real transcript files', async () => {
    const base = makeTemp('catalog').path;
    const projects = path.join(base, 'projects');
    const folder = path.join(projects, 'D--FIXTURE-real');
    mkdirSync(folder, { recursive: true });
    const transcript = path.join(folder, `${S2}.jsonl`);
    writeFileSync(transcript, cwdLine('D:\\FIXTURE-real'));
    utimesSync(transcript, new Date(NOW), new Date(NOW));
    const catalog = createProjectCatalog({
      projectsRoot: projects,
      fs: nodeDiscoveryFs,
      intervalMs: 30_000,
      now: () => NOW,
      win32: true,
    });
    await catalog.refresh();
    expect(catalog.entries()[0]).toMatchObject({ root: 'D:\\FIXTURE-real', rootSource: 'transcript' });
  });
});

describe('the cache by folder modification time', () => {
  function twoFolders() {
    const nodes = home();
    for (const name of ['D--FIXTURE-one', 'D--FIXTURE-two']) {
      const folder = path.join(ROOT, name);
      nodes.set(folder, dir(NOW - MIN));
      nodes.set(path.join(folder, `${S1}.jsonl`), file(cwdLine(`D:\\${name.slice(3)}`)));
    }
    return nodes;
  }

  it('costs one lstat for a folder that did not change, and nothing else', async () => {
    const nodes = twoFolders();
    const { catalog, calls } = catalogOver(nodes);
    await catalog.refresh();
    const first = catalog.entries();
    calls.length = 0;
    await catalog.refresh();
    const touching = (name: string) => calls.filter((call) => call.includes(path.join(ROOT, name)));
    expect(touching('D--FIXTURE-one')).toEqual([`lstat ${path.join(ROOT, 'D--FIXTURE-one')}`]);
    expect(touching('D--FIXTURE-two')).toEqual([`lstat ${path.join(ROOT, 'D--FIXTURE-two')}`]);
    expect(calls.filter((c) => c.startsWith('readHead'))).toEqual([]);
    expect(catalog.entries()).toEqual(first);
  });

  it('resolves a folder again when its modification time moved', async () => {
    const nodes = twoFolders();
    const { catalog, calls } = catalogOver(nodes);
    await catalog.refresh();
    const folder = path.join(ROOT, 'D--FIXTURE-one');
    nodes.set(path.join(folder, `${S2}.jsonl`), file(cwdLine('D:\\FIXTURE-moved'), NOW + MIN));
    nodes.set(folder, dir(NOW + MIN));
    calls.length = 0;
    await catalog.refresh();
    expect(catalog.entries().find((e) => e.dirName === 'D--FIXTURE-one')).toMatchObject({
      root: 'D:\\FIXTURE-moved',
      dirMtimeMs: NOW + MIN,
    });
    expect(calls.some((c) => c === `readdir ${folder}`)).toBe(true);
    expect(calls.some((c) => c === `readdir ${path.join(ROOT, 'D--FIXTURE-two')}`)).toBe(false);
  });

  it('forgets a folder that disappeared', async () => {
    const nodes = twoFolders();
    const { catalog } = catalogOver(nodes);
    await catalog.refresh();
    nodes.delete(path.join(ROOT, 'D--FIXTURE-two'));
    await catalog.refresh();
    expect(catalog.entries().map((e) => e.dirName)).toEqual(['D--FIXTURE-one']);
  });

  it('checks again whether a root exists only after the recheck time', async () => {
    const nodes = twoFolders();
    nodes.set('D:\\FIXTURE-one', dir());
    const { catalog, clock, calls } = catalogOver(nodes, { existsRecheckMs: 120_000 });
    await catalog.refresh();
    expect(catalog.entries().find((e) => e.dirName === 'D--FIXTURE-one')?.exists).toBe(true);
    nodes.delete('D:\\FIXTURE-one');
    clock.advance(119_000);
    calls.length = 0;
    await catalog.refresh();
    expect(calls.includes('lstat D:\\FIXTURE-one')).toBe(false);
    expect(catalog.entries().find((e) => e.dirName === 'D--FIXTURE-one')?.exists).toBe(true);
    clock.advance(1000);
    await catalog.refresh();
    expect(catalog.entries().find((e) => e.dirName === 'D--FIXTURE-one')?.exists).toBe(false);
  });

  it('runs one scan for concurrent refreshes', async () => {
    const { catalog, calls } = catalogOver(twoFolders());
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
    expect(calls.filter((c) => c === `readdir ${ROOT}`)).toHaveLength(1);
  });
});

describe('the status', () => {
  it('is ok with the time of the scan', async () => {
    const { catalog } = catalogOver(twoFoldersNodes());
    expect(catalog.status()).toEqual({ state: 'ok', scannedAt: null, truncated: false });
    await catalog.refresh();
    expect(catalog.status()).toEqual({ state: 'ok', scannedAt: NOW, truncated: false });
  });

  it('is absent when there is no projects folder, and the entries are empty', async () => {
    const { catalog } = catalogOver(new Map());
    await catalog.refresh();
    expect(catalog.status()).toEqual({ state: 'absent', scannedAt: NOW, truncated: false });
    expect(catalog.entries()).toEqual([]);
  });

  it('is unreadable when the projects folder exists and cannot be listed', async () => {
    const nodes = home();
    const { catalog } = catalogOver(nodes, { unreadable: new Set([ROOT]) });
    await catalog.refresh();
    expect(catalog.status().state).toBe('unreadable');
    expect(catalog.entries()).toEqual([]);
  });

  it('marks the list truncated and keeps the newest folders', async () => {
    const nodes = home();
    for (let i = 0; i < 5; i += 1) nodes.set(path.join(ROOT, `D--p${String(i)}`), dir(NOW - i * MIN));
    const { catalog } = catalogOver(nodes, { maxFolders: 3 });
    await catalog.refresh();
    expect(catalog.status().truncated).toBe(true);
    expect(catalog.entries().map((e) => e.dirName)).toEqual(['D--p0', 'D--p1', 'D--p2']);
  });

  it('truncates at 2,000 folders by default', async () => {
    const nodes = home();
    for (let i = 0; i < 2002; i += 1) nodes.set(path.join(ROOT, `D--q${String(i)}`), dir(NOW - i));
    const { catalog } = catalogOver(nodes);
    await catalog.refresh();
    expect(catalog.entries()).toHaveLength(2000);
    expect(catalog.status().truncated).toBe(true);
  });

  function twoFoldersNodes(): Map<string, Node> {
    const nodes = home();
    nodes.set(path.join(ROOT, 'D--a'), dir(NOW - MIN));
    return nodes;
  }
});

describe('start and stop', () => {
  it('scans at start and then every interval, until stop', async () => {
    vi.useFakeTimers();
    const nodes = home();
    nodes.set(path.join(ROOT, 'D--a'), dir());
    const { catalog, calls } = catalogOver(nodes, { intervalMs: 1000 });
    const scans = (): number => calls.filter((c) => c === `readdir ${ROOT}`).length;
    catalog.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scans()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scans()).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(scans()).toBe(4);
    await catalog.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(scans()).toBe(4);
  });

  it('start twice does not start two timers, and stop is safe before start', async () => {
    vi.useFakeTimers();
    const nodes = home();
    const { catalog, calls } = catalogOver(nodes, { intervalMs: 1000 });
    await catalog.stop();
    catalog.start();
    catalog.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c === `readdir ${ROOT}`)).toHaveLength(2);
    await catalog.stop();
  });

  it('never rejects when a scan fails unexpectedly', async () => {
    const nodes = home();
    nodes.set(path.join(ROOT, 'D--a'), dir());
    const mem = memFs(nodes);
    const broken: DiscoveryFs = { ...mem.fs, lstat: () => Promise.reject(new Error('boom')) };
    const catalog = createProjectCatalog({
      projectsRoot: ROOT,
      fs: broken,
      intervalMs: 1000,
      now: () => NOW,
      win32: true,
    });
    await expect(catalog.refresh()).resolves.toBeUndefined();
    expect(catalog.status().state).toBe('unreadable');
  });
});
