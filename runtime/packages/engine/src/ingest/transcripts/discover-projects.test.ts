// Discovery over every project folder of the Claude home (CAW design 03 2.2): which folders exist, which of them to look into on
// a tick, where one session id lives, and the bounded parallelism that makes a sweep of ten thousand files cheap. Real folders of
// temp directories; the file system is wrapped where a test must see which paths were touched.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { SID_RE } from '@mcs/shared/protocol';
import { buildClaudeHome, makeJunction, useTempDirs, type SessionSpec } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import {
  discoverSession,
  discoverTranscripts,
  nodeDiscoveryFs,
  type DiscoveryFs,
  type DiscoveryPolicy,
} from './discovery.ts';
import {
  discoverSessionAnywhere,
  listProjectFolders,
  mapLimit,
  selectFolders,
  type ProjectFolder,
  type SweepState,
} from './discover-projects.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const HOUR = 3_600_000;
const MIN = 60_000;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const AGENT = 'a1b2c3d4e5f6a7b8c';

/** A file system that records every path it is asked about. */
function recording(): { fs: DiscoveryFs; touched: string[] } {
  const touched: string[] = [];
  const fs: DiscoveryFs = {
    readdir: (dir) => {
      touched.push(dir);
      return nodeDiscoveryFs.readdir(dir);
    },
    lstat: (file) => {
      touched.push(file);
      return nodeDiscoveryFs.lstat(file);
    },
    readText: (file, max) => {
      touched.push(file);
      return nodeDiscoveryFs.readText(file, max);
    },
    readHead: (file, max) => {
      touched.push(file);
      return nodeDiscoveryFs.readHead(file, max);
    },
  };
  return { fs, touched };
}

/** `<root>/<name>/` for every name, each with the modification time `ageMs` before `NOW`. */
function projectsRootWith(folders: Readonly<Record<string, number>>): string {
  const root = path.join(makeTemp('projects').path, 'projects');
  mkdirSync(root, { recursive: true });
  for (const [name, ageMs] of Object.entries(folders)) {
    const dir = path.join(root, name);
    mkdirSync(dir);
    utimesSync(dir, new Date(NOW - ageMs), new Date(NOW - ageMs));
  }
  return root;
}

const names = (list: readonly ProjectFolder[]): string[] => list.map((f) => f.name);

describe('listProjectFolders', () => {
  it('lists the real folders, newest first, ties by name', async () => {
    const root = projectsRootWith({ 'D--old': 5 * HOUR, 'D--new': MIN, 'D--b': HOUR, 'D--a': HOUR });
    const list = await listProjectFolders(root, nodeDiscoveryFs);
    expect(names(list.folders)).toEqual(['D--new', 'D--a', 'D--b', 'D--old']);
    expect(list.folders[0]).toEqual({
      name: 'D--new',
      dir: path.join(root, 'D--new'),
      mtimeMs: NOW - MIN,
    });
    expect(list).toMatchObject({ missing: false, linksSkipped: 0, ignored: 0 });
  });

  it('counts a link or junction and never enters it', async () => {
    const root = projectsRootWith({ 'D--real': MIN });
    const elsewhere = path.join(makeTemp('elsewhere').path, 'target');
    mkdirSync(elsewhere);
    makeJunction(path.join(root, 'D--linked'), elsewhere);
    const { fs, touched } = recording();
    const list = await listProjectFolders(root, fs);
    expect(names(list.folders)).toEqual(['D--real']);
    expect(list.linksSkipped).toBe(1);
    expect(touched).not.toContain(elsewhere);
    expect(touched).not.toContain(path.join(root, 'D--linked', 'x'));
  });

  it('ignores names that are not a project folder name and entries that are not folders, without looking at the odd names', async () => {
    const root = projectsRootWith({ 'D--real': MIN, '.hidden': MIN, 'with space': MIN, under_score: MIN });
    writeFileSync(path.join(root, 'D--afile'), 'x');
    writeFileSync(path.join(root, 'secret.key'), 'FIXTURE');
    // 256 characters cannot be a folder name on Windows: the listing is told about it instead
    const spy = recording();
    const fs: DiscoveryFs = {
      ...spy.fs,
      readdir: async (dir) => [...(await spy.fs.readdir(dir)), 'x'.repeat(256)],
    };
    const { touched } = spy;
    const list = await listProjectFolders(root, fs);
    expect(names(list.folders)).toEqual(['D--real']);
    // .hidden, with space, under_score, secret.key and the 256 character name; D--afile is looked at and is no folder
    expect(list.ignored).toBe(6);
    expect(touched.filter((p) => p.endsWith('.key') || p.includes('.hidden') || p.includes('with space'))).toEqual([]);
  });

  it('accepts a POSIX style name that starts with a dash and a name of 255 characters', async () => {
    const root = projectsRootWith({ '-home-user-app': MIN, [`a${'b'.repeat(254)}`]: HOUR });
    const list = await listProjectFolders(root, nodeDiscoveryFs);
    expect(list.folders).toHaveLength(2);
    expect(list.ignored).toBe(0);
  });

  it('answers missing for a root that cannot be listed, and an empty list for an empty one', async () => {
    const base = makeTemp('missing').path;
    expect(await listProjectFolders(path.join(base, 'nope'), nodeDiscoveryFs)).toEqual({
      folders: [],
      missing: true,
      linksSkipped: 0,
      ignored: 0,
    });
    const empty = projectsRootWith({});
    expect(await listProjectFolders(empty, nodeDiscoveryFs)).toMatchObject({ folders: [], missing: false });
  });

  it('looks at the folders in batches of at most 32', async () => {
    const root = projectsRootWith(
      Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`D--p${String(i)}`, i * MIN])),
    );
    let inFlight = 0;
    let most = 0;
    const fs: DiscoveryFs = {
      ...nodeDiscoveryFs,
      lstat: async (file) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise<void>((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return nodeDiscoveryFs.lstat(file);
      },
    };
    const list = await listProjectFolders(root, fs);
    expect(list.folders).toHaveLength(70);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(32);
  });
});

describe('selectFolders', () => {
  const folder = (name: string, mtimeMs: number): ProjectFolder => ({ name, dir: `/p/${name}`, mtimeMs });
  const LIST = [folder('b', 300), folder('a', 200), folder('c', 100)];
  const FULL_EVERY = 60_000;
  const state = (over: Partial<SweepState> = {}): SweepState => ({
    lastFullAt: NOW - 1000,
    mtimes: new Map([
      ['a', 200],
      ['b', 300],
      ['c', 100],
    ]),
    ...over,
  });
  const select = (
    s: SweepState,
    over: { now?: number; hot?: string[]; hinted?: string[]; list?: readonly ProjectFolder[] } = {},
  ): { chosen: ProjectFolder[]; full: boolean } =>
    selectFolders(over.list ?? LIST, s, over.now ?? NOW, {
      fullSweepIntervalMs: FULL_EVERY,
      hot: new Set(over.hot ?? []),
      hinted: new Set(over.hinted ?? []),
    });

  it('chooses every folder on the first call', () => {
    const result = select({ lastFullAt: null, mtimes: new Map() });
    expect(result.full).toBe(true);
    expect(names(result.chosen)).toEqual(['b', 'a', 'c']);
  });

  it('chooses nothing on a quiet tick', () => {
    expect(select(state())).toEqual({ chosen: [], full: false });
  });

  it('chooses a hot folder, a hinted folder and a folder whose modification time changed, newest first', () => {
    expect(names(select(state(), { hot: ['c'] }).chosen)).toEqual(['c']);
    expect(names(select(state(), { hinted: ['a'] }).chosen)).toEqual(['a']);
    const moved = [folder('b', 300), folder('a', 250), folder('c', 100)];
    expect(names(select(state(), { list: moved }).chosen)).toEqual(['a']);
    expect(names(select(state(), { hot: ['c'], hinted: ['b'], list: moved }).chosen)).toEqual(['b', 'a', 'c']);
  });

  it('chooses a folder that is new, and ignores a hot or hinted name that is not in the list', () => {
    const grown = [folder('d', 400), ...LIST];
    expect(names(select(state(), { list: grown }).chosen)).toEqual(['d']);
    expect(select(state(), { hot: ['gone'], hinted: ['gone'] }).chosen).toEqual([]);
  });

  it('does a full sweep when the interval has passed, and not one millisecond before', () => {
    expect(select(state({ lastFullAt: NOW - FULL_EVERY + 1 })).full).toBe(false);
    const due = select(state({ lastFullAt: NOW - FULL_EVERY }));
    expect(due.full).toBe(true);
    expect(names(due.chosen)).toEqual(['b', 'a', 'c']);
  });

  it('does not change the state it is given', () => {
    const s = state();
    select(s, { hot: ['a'] });
    expect(s.lastFullAt).toBe(NOW - 1000);
    expect([...s.mtimes.entries()]).toEqual([
      ['a', 200],
      ['b', 300],
      ['c', 100],
    ]);
  });
});

describe('discoverSessionAnywhere', () => {
  function twoProjects(): { root: string; a: string; b: string } {
    const home = buildClaudeHome(makeTemp('anywhere').path, {
      nowMs: NOW,
      sessions: [
        { id: S1, project: 'D--proj-a', mtimeAgeMs: 30 * HOUR, build: (b) => b.user('one') },
        {
          id: S2,
          project: 'D--proj-b',
          mtimeAgeMs: 40 * HOUR,
          build: (b) => b.user('two'),
          subagents: [{ agentId: AGENT, meta: { agentType: 'general-purpose' }, build: (b) => b.user('go') }],
        },
      ],
    });
    return {
      root: home.projectsDir,
      a: path.join(home.projectsDir, 'D--proj-a'),
      b: path.join(home.projectsDir, 'D--proj-b'),
    };
  }

  it('finds a session of any age in the folder named first and looks in no other folder', async () => {
    const { root, b } = twoProjects();
    const { fs, touched } = recording();
    const found = await discoverSessionAnywhere(root, S2, fs, 'D--proj-b');
    expect(found?.dir).toBe(b);
    expect(found?.session.files.map((f) => f.kind).sort()).toEqual(['session', 'subagent']);
    expect(touched.filter((p) => p.startsWith(path.join(root, 'D--proj-a')))).toEqual([]);
    expect(touched).not.toContain(root);
  });

  it('looks into every folder when the first one has nothing, and when none is named', async () => {
    const { root, a } = twoProjects();
    const wrongFirst = await discoverSessionAnywhere(root, S1, nodeDiscoveryFs, 'D--proj-b');
    expect(wrongFirst?.dir).toBe(a);
    const none = await discoverSessionAnywhere(root, S1, nodeDiscoveryFs);
    expect(none?.dir).toBe(a);
    expect(none?.session.sessionId).toBe(S1);
  });

  it('asks each folder one question: does the main file exist', async () => {
    const { root } = twoProjects();
    const { fs, touched } = recording();
    await discoverSessionAnywhere(root, S3, fs);
    const asked = touched.filter((p) => p.endsWith(`${S3}.jsonl`)).map((p) => path.basename(path.dirname(p)));
    expect(asked.sort()).toEqual(['D--proj-a', 'D--proj-b']);
  });

  it('answers null for an id that is not a session id without touching the disk, and for a session nobody has', async () => {
    const { root } = twoProjects();
    const { fs, touched } = recording();
    expect(await discoverSessionAnywhere(root, 'not-a-session-id', fs, 'D--proj-a')).toBeNull();
    expect(await discoverSessionAnywhere(root, '../../etc', fs)).toBeNull();
    expect(touched).toEqual([]);
    expect(await discoverSessionAnywhere(root, S3, nodeDiscoveryFs, 'D--proj-a')).toBeNull();
    expect(await discoverSessionAnywhere(path.join(root, 'missing'), S1, nodeDiscoveryFs)).toBeNull();
  });

  it('never follows a first folder that is not a project folder name', async () => {
    const { root } = twoProjects();
    const { fs, touched } = recording();
    const found = await discoverSessionAnywhere(root, S1, fs, '..');
    expect(found?.session.sessionId).toBe(S1);
    expect(touched).not.toContain(path.join(root, '..', `${S1}.jsonl`));
  });

  it('takes the newest folder when one session id lives under two folders', async () => {
    const specs: SessionSpec[] = [
      { id: S1, project: 'D--older', mtimeAgeMs: 30 * HOUR, build: (b) => b.user('x') },
      { id: S1, project: 'D--newer', mtimeAgeMs: HOUR, build: (b) => b.user('x') },
    ];
    const home = buildClaudeHome(makeTemp('twin').path, { nowMs: NOW, sessions: specs });
    for (const [name, age] of [
      ['D--older', 30 * HOUR],
      ['D--newer', HOUR],
    ] as const) {
      const dir = path.join(home.projectsDir, name);
      utimesSync(dir, new Date(NOW - age), new Date(NOW - age));
    }
    const found = await discoverSessionAnywhere(home.projectsDir, S1, nodeDiscoveryFs);
    expect(found?.dir).toBe(path.join(home.projectsDir, 'D--newer'));
  });
});

describe('mapLimit', () => {
  it('keeps the order of the items whatever order the calls finish in', async () => {
    const gates = Array.from({ length: 4 }, () => {
      let open: () => void = () => undefined;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { opened, open };
    });
    const done = mapLimit([0, 1, 2, 3], 4, async (item, index) => {
      await gates[item]?.opened;
      return `${String(index)}:${String(item)}`;
    });
    for (const gate of [...gates].reverse()) {
      gate.open();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(await done).toEqual(['0:0', '1:1', '2:2', '3:3']);
  });

  it('runs at most `limit` calls at a time and every item once', async () => {
    let inFlight = 0;
    let most = 0;
    const seen: number[] = [];
    await mapLimit(
      Array.from({ length: 25 }, (_, i) => i),
      4,
      async (n) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        seen.push(n);
        await new Promise<void>((resolve) => setImmediate(resolve));
        inFlight -= 1;
      },
    );
    expect(most).toBe(4);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('answers an empty list for no items, and works with a limit larger than the list', async () => {
    expect(await mapLimit([], 8, () => Promise.resolve(1))).toEqual([]);
    expect(await mapLimit([1, 2], 100, (n) => Promise.resolve(n * 2))).toEqual([2, 4]);
  });

  it('rejects a limit that is not a whole number of at least 1', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(mapLimit([1], limit, (n) => Promise.resolve(n))).rejects.toThrow(RangeError);
    }
  });

  it('rejects with the first failure and starts nothing more after it', async () => {
    let started = 0;
    await expect(
      mapLimit(
        Array.from({ length: 20 }, (_, i) => i),
        2,
        async (n) => {
          started += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (n === 1) throw new Error('FIXTURE failed');
          return n;
        },
      ),
    ).rejects.toThrow('FIXTURE failed');
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toBeLessThanOrEqual(4);
  });
});

describe('discoverTranscripts with concurrency 32 against concurrency 1', () => {
  const policy = (over: Partial<DiscoveryPolicy> = {}): DiscoveryPolicy => ({
    nowMs: NOW,
    lookbackMs: 8 * HOUR,
    pinned: new Set(),
    isKnown: () => false,
    ...over,
  });

  /** Seventy sessions: recent and old, with subagents on every seventh, some pinned and some known. */
  function crowd(): { tdir: string; pinned: string; known: string } {
    const sessions: SessionSpec[] = Array.from({ length: 70 }, (_, i) => {
      const spec: SessionSpec = {
        id: `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        project: 'D--crowd',
        mtimeAgeMs: (i % 3 === 0 ? 1 : 20) * HOUR,
        build: (b) => b.user(`prompt ${String(i)}`),
      };
      if (i % 7 === 0) {
        spec.subagents = [{ agentId: AGENT, meta: { agentType: 'general-purpose' }, build: (b) => b.user('go') }];
      }
      return spec;
    });
    const home = buildClaudeHome(makeTemp('crowd').path, { nowMs: NOW, sessions });
    const tdir = path.join(home.projectsDir, 'D--crowd');
    // a recent session whose folder is a link: it is counted and not entered, with either concurrency
    const elsewhere = path.join(makeTemp('crowd-link').path, 'x');
    mkdirSync(elsewhere);
    writeFileSync(path.join(tdir, `${S3}.jsonl`), '{}\n');
    utimesSync(path.join(tdir, `${S3}.jsonl`), new Date(NOW), new Date(NOW));
    makeJunction(path.join(tdir, S3), elsewhere);
    return { tdir, pinned: sessions[5]?.id ?? '', known: sessions[8]?.id ?? '' };
  }

  it('finds the same sessions and files in the same order and counts the same', async () => {
    const { tdir, pinned, known } = crowd();
    const p = policy({ pinned: new Set([pinned]), isKnown: (id) => id === known });
    const one = await discoverTranscripts(tdir, p, nodeDiscoveryFs, { concurrency: 1 });
    const many = await discoverTranscripts(tdir, p, nodeDiscoveryFs, { concurrency: 32 });
    expect(one.sessions.length).toBeGreaterThan(20);
    expect(one.counters.symlinksSkipped).toBe(1);
    expect(many).toEqual(one);
    const defaults = await discoverTranscripts(tdir, p, nodeDiscoveryFs);
    expect(defaults).toEqual(one);
  });

  it('keeps the order of the calls of today when the concurrency is 1: the files of one session before the next main file', async () => {
    const { tdir } = crowd();
    const { fs, touched } = recording();
    await discoverTranscripts(tdir, policy(), fs, { concurrency: 1 });
    const mains = touched.filter((p) => p.endsWith('.jsonl') && path.dirname(p) === tdir);
    expect([...mains]).toEqual([...mains].sort());
    const firstSubagent = touched.findIndex((p) => p.includes(`${path.sep}subagents`));
    const afterIt = touched.slice(firstSubagent).filter((p) => p.endsWith('.jsonl') && path.dirname(p) === tdir);
    expect(afterIt.length).toBeGreaterThan(0);
  });

  it('asks about the main files in parallel, 32 at a time, and no more', async () => {
    const { tdir } = crowd();
    let inFlight = 0;
    let most = 0;
    const fs: DiscoveryFs = {
      ...nodeDiscoveryFs,
      lstat: async (file) => {
        const main = file.endsWith('.jsonl') && path.dirname(file) === tdir;
        if (main) {
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise<void>((resolve) => setImmediate(resolve));
          inFlight -= 1;
        }
        return nodeDiscoveryFs.lstat(file);
      },
    };
    await discoverTranscripts(tdir, policy(), fs, { concurrency: 32 });
    expect(most).toBeGreaterThan(8);
    expect(most).toBeLessThanOrEqual(32);
  });

  it('gives every folder its own entry budget and says when a folder used it up', async () => {
    const ids = Array.from({ length: 50_010 }, (_, i) => `${String(i).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`);
    const fake: DiscoveryFs = {
      readdir: () => Promise.resolve(ids.map((id) => `${id}.jsonl`)),
      lstat: () => Promise.resolve({ kind: 'file', size: 1, mtimeMs: NOW - 100 * HOUR, birthMs: null }),
      readText: () => Promise.resolve(null),
      readHead: () => Promise.resolve(null),
    };
    const first = await discoverTranscripts('/fixture/one', policy(), fake, { concurrency: 32 });
    const second = await discoverTranscripts('/fixture/two', policy(), fake, { concurrency: 32 });
    expect(first.counters).toMatchObject({ truncated: true, entries: 50_000 });
    expect(second.counters).toMatchObject({ truncated: true, entries: 50_000 });
  });

  it('is the same single session for discoverSession, which has no concurrency', async () => {
    const { tdir } = crowd();
    const id = `${String(0).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    expect(SID_RE.test(id)).toBe(true);
    expect((await discoverSession(tdir, id))?.files.length).toBeGreaterThan(0);
  });
});
