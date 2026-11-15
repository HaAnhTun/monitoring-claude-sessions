// The folder service (CAW design 03 section 4.5) over fakes: the DA reader, the catalog, the statistics query and the file system
// are replaced, the user folder state is the real module over an in-memory file. What is proved: the list is the merge of the
// sources with the status of each, the caches (one existence check per path in its window, a stale catalog refreshes behind the
// answer, never in front of it), add and remove with the errors of the state file, and that start and stop own the catalog timer.
import { FolderListResponseSchema } from '@mcs/shared';
import { FakeClock } from '@mcs/testkit';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectStat } from '../query/projects.ts';
import type { CatalogEntry, CatalogStatus, ProjectCatalog } from './catalog.ts';
import type { DaFolder, DaMemoryReader, DaMemoryResult } from './da-memory.ts';
import { createFolderService, type FolderServiceContext, type FolderServiceDeps } from './service.ts';
import { FolderError, createUserFolders, type UserFolders, type UserFoldersFs } from './user-folders.ts';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CATALOG_INTERVAL = 30_000;
const HOME = 'C:\\Users\\fixture-home';

function daFolder(path: string, o: Partial<DaFolder> = {}): DaFolder {
  return {
    slug: path.replace(/[^A-Za-z0-9]+/g, '-'),
    rawPath: path,
    path,
    lastUpdatedMs: NOW - 5 * MIN,
    summary: 'FIXTURE summary',
    brain: 1,
    action: 1,
    merged: 0,
    ...o,
  };
}

function catalogEntry(path: string, o: Partial<CatalogEntry> = {}): CatalogEntry {
  const dirName = path.replace(/[^A-Za-z0-9]/g, '-');
  return {
    dirName,
    key: dirName.toLowerCase(),
    dirMtimeMs: NOW - 3 * DAY,
    root: path,
    rootSource: 'transcript',
    exists: true,
    ...o,
  };
}

function projectStat(path: string, o: Partial<ProjectStat> = {}): ProjectStat {
  const dirName = path.replace(/[^A-Za-z0-9]/g, '-');
  return {
    key: dirName.toLowerCase(),
    dirName,
    rootPath: path,
    sessionsInWindow: 1,
    activeSessions: 0,
    lastActivityAt: NOW - 2 * DAY,
    totalSessions: 3,
    ...o,
  };
}

class FakeDa implements DaMemoryReader {
  reads = 0;
  folders: DaFolder[] = [];
  status: DaMemoryResult['status'] = 'ok';
  read(nowMs: number): Promise<DaMemoryResult> {
    this.reads += 1;
    return Promise.resolve({ status: this.status, folders: this.folders, skipped: 0, readAtMs: nowMs });
  }
}

class FakeCatalog implements ProjectCatalog {
  entriesNow: CatalogEntry[] = [];
  state: CatalogStatus = { state: 'ok', scannedAt: null, truncated: false };
  refreshes = 0;
  started = 0;
  stopped = 0;
  /** When set, `refresh` waits for it (a scan that takes long). */
  gate: Promise<void> | null = null;
  private readonly clock: FakeClock;
  constructor(clock: FakeClock) {
    this.clock = clock;
  }
  start(): void {
    this.started += 1;
    void this.refresh();
  }
  stop(): Promise<void> {
    this.stopped += 1;
    return Promise.resolve();
  }
  async refresh(): Promise<void> {
    this.refreshes += 1;
    if (this.gate !== null) await this.gate;
    this.state = { ...this.state, scannedAt: this.clock.now() };
  }
  entries(): readonly CatalogEntry[] {
    return this.entriesNow;
  }
  status(): CatalogStatus {
    return this.state;
  }
}

/** The state file in memory. */
function memoryFile(initial: string | null = null): { fs: UserFoldersFs; text: () => string | null } {
  let text = initial;
  const fs: UserFoldersFs = {
    readText: () => Promise.resolve(text === null ? { kind: 'absent' } : { kind: 'text', text }),
    isDirectory: () => Promise.resolve(true),
    writeAtomic: (_file, data) => {
      text = data;
      return Promise.resolve();
    },
    keepCopy: () => Promise.resolve(),
  };
  return { fs, text: () => text };
}

interface Harness {
  readonly service: ReturnType<typeof createFolderService>;
  readonly clock: FakeClock;
  readonly da: FakeDa;
  readonly catalog: FakeCatalog;
  readonly userFolders: UserFolders;
  readonly file: ReturnType<typeof memoryFile>;
  readonly stats: { rows: ProjectStat[]; calls: { windowFromMs: number | null }[] };
  readonly checks: string[];
  readonly missing: Set<string>;
}

function build(o: { max?: number; deps?: Partial<FolderServiceDeps> } = {}): Harness {
  const clock = new FakeClock(NOW);
  const da = new FakeDa();
  const catalog = new FakeCatalog(clock);
  const file = memoryFile();
  const userFolders = createUserFolders({
    file: 'folders.json',
    fs: file.fs,
    now: () => clock.now(),
    win32: true,
    ...(o.max === undefined ? {} : { max: o.max }),
  });
  const stats = { rows: [] as ProjectStat[], calls: [] as { windowFromMs: number | null }[] };
  const checks: string[] = [];
  const missing = new Set<string>();
  const ctx: FolderServiceContext = {
    claudeHome: 'claude-home',
    instanceDir: 'instance-dir',
    clock,
    scope: { instanceId: 'fixture' },
    queries: {
      projectStats: (_scope, q) => {
        stats.calls.push(q);
        return stats.rows;
      },
    },
    config: {
      monitor: { window_hours: 24 },
      runtime: {
        projects: { daMemoryDir: null, daCacheMs: 3000, catalogIntervalMs: CATALOG_INTERVAL, userFoldersMax: 200 },
      },
    },
  };
  const service = createFolderService(ctx, {
    daMemory: da,
    catalog,
    userFolders,
    isDirectory: (path) => {
      checks.push(path);
      return Promise.resolve(missing.has(path.toLowerCase()) ? false : true);
    },
    homeDir: HOME,
    win32: true,
    ...o.deps,
  });
  return { service, clock, da, catalog, userFolders, file, stats, checks, missing };
}

describe('list: the merge of the sources and what each one said', () => {
  it('rows from the DA memory, the catalog, the statistics and the added folders, with the status block and the clock', async () => {
    const h = build();
    h.da.folders = [daFolder('D:\\work\\app')];
    h.catalog.entriesNow = [catalogEntry('D:\\work\\app'), catalogEntry('D:\\work\\other')];
    h.catalog.state = { state: 'ok', scannedAt: NOW - 10_000, truncated: true };
    h.stats.rows = [projectStat('D:\\work\\app', { sessionsInWindow: 2 })];
    await h.userFolders.add('D:\\extra\\mine');

    const list = await h.service.list();
    expect(FolderListResponseSchema.safeParse(list).success).toBe(true);
    expect(list.asOf).toBe(new Date(NOW).toISOString());
    expect(list.folders.map((row) => `${row.group}:${row.name}`)).toEqual([
      'outside-da:mine',
      'outside-da:other',
      'da:app',
    ]);
    const app = list.folders.find((row) => row.name === 'app');
    expect(app?.origins).toEqual(['da', 'claude']);
    expect(app?.claude?.sessionsInWindow).toBe(2);
    expect(list.sources).toEqual({
      daMemory: { status: 'ok', folders: 1, readAt: new Date(NOW).toISOString() },
      claudeHome: { status: 'ok', folders: 2, scannedAt: new Date(NOW - 10_000).toISOString(), truncated: true },
      userFolders: { status: 'ok', count: 1 },
    });
  });

  it('asks the statistics for the configured window', async () => {
    const h = build();
    await h.service.list();
    expect(h.stats.calls).toEqual([{ windowFromMs: NOW - DAY }]);
  });

  it('an absent DA memory and an absent Claude home still give the home row, and say so', async () => {
    const h = build();
    h.da.status = 'absent';
    h.catalog.state = { state: 'absent', scannedAt: NOW, truncated: false };
    const list = await h.service.list();
    expect(list.folders).toHaveLength(1);
    expect(list.folders[0]).toMatchObject({ path: HOME, origins: ['fallback'], canStart: true });
    expect(list.sources.daMemory.status).toBe('absent');
    expect(list.sources.claudeHome.status).toBe('absent');
    expect(list.sources.userFolders.status).toBe('absent');
  });

  it('a path that is no directory now cannot start a terminal', async () => {
    const h = build();
    h.da.folders = [daFolder('D:\\work\\app'), daFolder('D:\\work\\gone')];
    h.missing.add('d:\\work\\gone');
    const list = await h.service.list();
    expect(list.folders.find((row) => row.name === 'gone')).toMatchObject({ exists: false, canStart: false });
    expect(list.folders.find((row) => row.name === 'app')).toMatchObject({ exists: true, canStart: true });
  });
});

describe('the caches', () => {
  it('checks a path once inside its window, however often the list is read', async () => {
    const h = build();
    h.da.folders = [daFolder('D:\\work\\app')];
    await h.service.list();
    await h.service.list();
    await h.service.list();
    expect(h.checks).toEqual(['D:\\work\\app']);
  });

  it('a stale check answers with the old value and renews itself behind the answer', async () => {
    const h = build({ deps: { existsRecheckMs: 10 * MIN } });
    h.da.folders = [daFolder('D:\\work\\app')];
    expect((await h.service.list()).folders[0]?.exists).toBe(true);

    h.missing.add('d:\\work\\app');
    h.clock.advance(11 * MIN);
    const stale = await h.service.list();
    expect(stale.folders[0]?.exists).toBe(true);
    await vi.waitFor(() => {
      expect(h.checks).toHaveLength(2);
    });
    await vi.waitFor(async () => {
      expect((await h.service.list()).folders[0]?.exists).toBe(false);
    });
  });

  it('the first list scans the catalog when nobody started it, later lists do not', async () => {
    const h = build();
    await h.service.list();
    await h.service.list();
    expect(h.catalog.refreshes).toBe(1);
  });

  it('a catalog scan that is overdue starts behind the answer, which does not wait for it', async () => {
    const h = build();
    h.catalog.state = { state: 'ok', scannedAt: NOW - 3 * CATALOG_INTERVAL, truncated: false };
    let release: () => void = () => undefined;
    h.catalog.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = await h.service.list();
    expect(list.sources.claudeHome.scannedAt).toBe(new Date(NOW - 3 * CATALOG_INTERVAL).toISOString());
    expect(h.catalog.refreshes).toBe(1);
    release();
  });

  it('a catalog scan that is not overdue is left alone', async () => {
    const h = build();
    h.catalog.state = { state: 'ok', scannedAt: NOW - CATALOG_INTERVAL, truncated: false };
    await h.service.list();
    expect(h.catalog.refreshes).toBe(0);
  });
});

describe('add and remove', () => {
  it('add persists the folder and answers with its row; the next list has it on top', async () => {
    const h = build();
    h.catalog.entriesNow = [catalogEntry('D:\\work\\busy', { dirMtimeMs: NOW - HOUR })];
    h.catalog.state = { state: 'ok', scannedAt: NOW, truncated: false };
    const row = await h.service.add('d:/extra/Mine/');
    expect(row).toMatchObject({ name: 'Mine', path: 'D:\\extra\\Mine', pathSource: 'user', userAdded: true });
    expect(h.file.text()).toContain('D:\\\\extra\\\\Mine');
    const list = await h.service.list();
    expect(list.folders.map((entry) => entry.name)).toEqual(['Mine', 'busy']);
  });

  it('add is idempotent', async () => {
    const h = build();
    const first = await h.service.add('D:\\extra\\mine');
    const second = await h.service.add('D:\\extra\\mine');
    expect(second).toEqual(first);
    expect(h.userFolders.list()).toHaveLength(1);
  });

  it('add of the folder of a DA entry answers with the merged row', async () => {
    const h = build();
    h.da.folders = [daFolder('D:\\work\\app')];
    const row = await h.service.add('D:\\work\\app');
    expect(row).toMatchObject({ group: 'da', origins: ['da', 'user'], userAdded: true });
  });

  it('refuses a relative, a UNC and a device path with folder_invalid and the reason', async () => {
    const h = build();
    for (const [raw, issue] of [
      ['work\\app', 'relative'],
      ['\\\\host\\share\\app', 'unc'],
      ['\\\\.\\C:\\x', 'device'],
    ] as const) {
      const error = await h.service.add(raw).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FolderError);
      expect(error).toMatchObject({ code: 'folder_invalid', issue });
    }
    expect(h.file.text()).toBeNull();
  });

  it('refuses over the limit with folder_limit', async () => {
    const h = build({ max: 1 });
    await h.service.add('D:\\one');
    await expect(h.service.add('D:\\two')).rejects.toMatchObject({ code: 'folder_limit' });
  });

  it('remove drops the user origin and the row stays while the DA memory still names the folder', async () => {
    const h = build();
    h.da.folders = [daFolder('D:\\work\\app')];
    const added = await h.service.add('D:\\work\\app');
    await h.service.remove(added.key);
    const list = await h.service.list();
    expect(list.folders).toHaveLength(1);
    expect(list.folders[0]).toMatchObject({ origins: ['da'], userAdded: false });
  });

  it('remove of a folder only a person added removes the row', async () => {
    const h = build();
    const added = await h.service.add('D:\\extra\\mine');
    await h.service.remove(added.key);
    const list = await h.service.list();
    expect(list.folders.map((row) => row.origins)).toEqual([['fallback']]);
  });

  it('remove of a key nobody added is folder_not_found', async () => {
    const h = build();
    h.da.folders = [daFolder('D:\\work\\app')];
    await expect(h.service.remove('d--work-app')).rejects.toMatchObject({ code: 'folder_not_found' });
  });

  it('a state file that cannot be written is state_unwritable, never a path in the message', async () => {
    const h = build();
    const failing: UserFoldersFs = {
      ...h.file.fs,
      writeAtomic: () => Promise.reject(new Error('EACCES C:\\secret\\place')),
    };
    const userFolders = createUserFolders({ file: 'f.json', fs: failing, now: () => NOW, win32: true });
    const service = createFolderService(
      {
        claudeHome: 'c',
        instanceDir: 'i',
        clock: h.clock,
        scope: { instanceId: 'x' },
        queries: { projectStats: () => [] },
        config: {
          monitor: { window_hours: 24 },
          runtime: { projects: { daMemoryDir: null, daCacheMs: 3000, catalogIntervalMs: 30_000, userFoldersMax: 200 } },
        },
      },
      { daMemory: h.da, catalog: h.catalog, userFolders, isDirectory: () => Promise.resolve(true), win32: true },
    );
    const error = await service.add('D:\\extra\\mine').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'state_unwritable' });
    expect((error as Error).message).not.toContain('secret');
  });
});

describe('start, stop and refresh', () => {
  it('start loads the state, starts the catalog once and waits for the first scan; stop stops it', async () => {
    const h = build();
    const seed = memoryFile(
      JSON.stringify({
        schema_version: 1,
        updatedAt: 'x',
        folders: [{ path: 'D:\\extra\\old', addedAt: new Date(NOW).toISOString() }],
      }),
    );
    const userFolders = createUserFolders({ file: 'f.json', fs: seed.fs, now: () => NOW, win32: true });
    const service = createFolderService(
      {
        claudeHome: 'c',
        instanceDir: 'i',
        clock: h.clock,
        scope: { instanceId: 'x' },
        queries: { projectStats: () => [] },
        config: {
          monitor: { window_hours: 24 },
          runtime: { projects: { daMemoryDir: null, daCacheMs: 3000, catalogIntervalMs: 30_000, userFoldersMax: 200 } },
        },
      },
      { daMemory: h.da, catalog: h.catalog, userFolders, isDirectory: () => Promise.resolve(true), win32: true },
    );
    await service.start();
    await service.start();
    expect(h.catalog.started).toBe(1);
    expect(h.catalog.state.scannedAt).toBe(NOW);
    expect((await service.list()).folders.map((row) => row.name)).toEqual(['old']);
    await service.stop();
    expect(h.catalog.stopped).toBe(1);
  });

  it('refresh reloads the state file, scans the catalog again and forgets the existence checks', async () => {
    const h = build();
    h.da.folders = [daFolder('D:\\work\\app')];
    await h.service.list();
    expect(h.checks).toHaveLength(1);
    await h.service.refresh();
    expect(h.catalog.refreshes).toBe(2);
    await h.service.list();
    expect(h.checks).toHaveLength(2);
  });

  it('a list never rejects because a check of the file system failed', async () => {
    const h = build({ deps: { isDirectory: () => Promise.reject(new Error('EBUSY')) } });
    h.da.folders = [daFolder('D:\\work\\app')];
    const list = await h.service.list();
    expect(list.folders[0]).toMatchObject({ exists: null, canStart: true });
  });
});
