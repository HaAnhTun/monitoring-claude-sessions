// The linker (CAW design 03 5.3 to 5.5, ADR 0090) over fakes: a registry that a test edits, a process table that counts its questions,
// the clock of the testkit and `tick()` for every pass, so nothing here waits. What is proved: a terminal goes from pending to linked
// on the evidence of the registry, `/clear` rewrites the id, two terminals of one folder are told apart, a claude the person started
// by hand is dropped, a missing process table weakens the link and says so, the database fallback after the fast window, `forget`, the
// one question to the process table per decision, the shared flag and the polling timer (with fake timers, not sleeps).
import { TerminalLinkSchema, type TerminalLink } from '@mcs/shared';
import { FakeClock } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RegistryEntry, RegistryListing, RegistrySnapshot } from '../external/registry.ts';
import {
  PROCESS_TREE_FAILURE_MEMO_MS,
  PROCESS_TREE_MEMO_MS,
  REALPATH_MEMO_MS,
  createTerminalLinker,
} from './linker.ts';
import type { ProcessTreePort, TerminalLinker, TerminalProbe } from './types.ts';

const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);
const FAST = 30_000;
const SLOW = 2000;
const POLL = 250;
const TOLERANCE = 2000;
const FOLDER = 'D:\\work\\app';
const FOLDER_KEY = 'd--work-app';
const uid = (n: number): string => `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const iso = (ms: number): string => new Date(ms).toISOString();

afterEach(() => {
  vi.useRealTimers();
});

function entry(pid: number, over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid,
    sessionId: uid(pid),
    status: 'idle',
    waitingFor: null,
    cwd: FOLDER,
    startedAtMs: NOW + 500,
    updatedAtMs: NOW + 500,
    kind: 'interactive',
    entrypoint: 'cli',
    alive: true,
    ...over,
  };
}

class FakeRegistry implements RegistrySnapshot {
  entries: RegistryEntry[] = [];
  reads = 0;
  failure: Error | null = null;
  /** When set, a read waits for it. */
  gate: Promise<void> | null = null;

  async read(): Promise<RegistryListing> {
    this.reads += 1;
    if (this.gate !== null) await this.gate;
    if (this.failure !== null) throw this.failure;
    return { entries: [...this.entries], readFailures: 0 };
  }

  put(next: RegistryEntry): void {
    this.entries = [...this.entries.filter((e) => e.pid !== next.pid), next];
  }

  patch(pid: number, over: Partial<RegistryEntry>): void {
    const current = this.entries.find((e) => e.pid === pid);
    if (current === undefined) throw new Error(`no entry ${String(pid)}`);
    this.put({ ...current, ...over });
  }

  drop(pid: number): void {
    this.entries = this.entries.filter((e) => e.pid !== pid);
  }
}

class FakeTree implements ProcessTreePort {
  rows: Record<number, readonly number[] | null> = {};
  asked: number[] = [];
  throws = false;

  descendants(root: number): Promise<ReadonlySet<number> | null> {
    this.asked.push(root);
    if (this.throws) return Promise.reject(new Error('the table failed'));
    const row = this.rows[root];
    return Promise.resolve(row === undefined ? new Set<number>() : row === null ? null : new Set(row));
  }
}

interface Harness {
  readonly linker: TerminalLinker;
  readonly clock: FakeClock;
  readonly registry: FakeRegistry;
  readonly tree: FakeTree;
  readonly known: Set<string>;
  readonly hints: string[];
  readonly since: { key: string; sinceMs: number }[];
  readonly sessionRows: { value: string[] };
  readonly changes: { name: string; link: TerminalLink }[];
  readonly logs: unknown[][];
  readonly realpaths: Map<string, string | null>;
  readonly realpathCalls: string[];
}

function build(): Harness {
  const clock = new FakeClock(NOW);
  const registry = new FakeRegistry();
  const tree = new FakeTree();
  const known = new Set<string>();
  const hints: string[] = [];
  const since: { key: string; sinceMs: number }[] = [];
  const sessionRows = { value: [] as string[] };
  const logs: unknown[][] = [];
  const realpaths = new Map<string, string | null>();
  const realpathCalls: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logs.push([level, ...args]);
    };
  const linker = createTerminalLinker({
    registry,
    tree,
    clock,
    config: {
      linkPollMs: POLL,
      linkSlowPollMs: SLOW,
      linkFastWindowMs: FAST,
      linkStartToleranceMs: TOLERANCE,
    },
    sessionKnown: (id) => known.has(id),
    sessionsSince: (key, sinceMs) => {
      since.push({ key, sinceMs });
      return sessionRows.value;
    },
    hintSession: (id) => {
      hints.push(id);
    },
    logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
    // the paths of these tests are Windows paths whatever the host is
    win32: true,
    // the real file system is never asked: a test names the real path of a folder, or none
    realpath: (path: string) => {
      realpathCalls.push(path);
      return Promise.resolve(realpaths.get(path) ?? null);
    },
  });
  const changes: { name: string; link: TerminalLink }[] = [];
  linker.onChange((name, link) => {
    changes.push({ name, link });
  });
  return { linker, clock, registry, tree, known, hints, since, sessionRows, changes, logs, realpaths, realpathCalls };
}

function probe(name: string, pid: number, over: Partial<TerminalProbe> = {}): TerminalProbe {
  return {
    name,
    pid,
    cwd: FOLDER,
    spawnedAtMs: NOW,
    resumeSessionId: null,
    fork: false,
    nameToken: null,
    ...over,
  };
}

function linkOf(h: Harness, name: string): TerminalLink {
  const link = h.linker.link(name);
  if (link === null) throw new Error(`no link for ${name}`);
  expect(TerminalLinkSchema.safeParse(link).success).toBe(true);
  return link;
}

const PENDING: TerminalLink = {
  status: 'pending',
  sessionId: null,
  previousSessionIds: [],
  basis: null,
  confidence: null,
  since: null,
  claudePid: null,
  transcript: 'none',
  registryStatus: null,
  waitingFor: null,
  reason: null,
  shared: false,
};

describe('track and the first look', () => {
  it('a tracked terminal is pending, with nothing known, and the host is not told about that state', () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    expect(h.linker.link('app-1')).toEqual(PENDING);
    expect(h.linker.links().get('app-1')).toEqual(PENDING);
    expect(h.linker.link('unknown')).toBeNull();
    expect(h.linker.sessionOwner(uid(1))).toBeNull();
    expect(h.linker.ownedPids().size).toBe(0);
    expect(h.changes).toEqual([]);
  });

  it('a tick with nothing tracked does not read the registry', async () => {
    const h = build();
    await h.linker.tick();
    expect(h.registry.reads).toBe(0);
  });

  it('pending to linked: the entry appears at the third look, the link is made on the pid and announced once', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    await h.linker.tick();
    h.clock.advance(POLL);
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toEqual(PENDING);
    expect(h.changes).toEqual([]);

    h.clock.advance(POLL);
    h.registry.put(entry(100, { status: 'busy' }));
    await h.linker.tick();
    const link = linkOf(h, 'app-1');
    expect(link).toEqual({
      status: 'linked',
      sessionId: uid(100),
      previousSessionIds: [],
      basis: 'registry-pid',
      confidence: 'high',
      since: iso(NOW + 2 * POLL),
      claudePid: 100,
      transcript: 'none',
      registryStatus: 'busy',
      waitingFor: null,
      reason: null,
      shared: false,
    });
    expect(h.changes).toEqual([{ name: 'app-1', link }]);
    expect(h.linker.sessionOwner(uid(100))).toBe('app-1');
    expect(h.linker.ownedPids()).toEqual(new Set([100]));
    expect(h.tree.asked).toEqual([]);

    // nothing changes, nothing is announced
    await h.linker.tick();
    expect(h.changes).toHaveLength(1);
  });

  it('on the shim route the claude below the cmd.exe is found in the process table', async () => {
    const h = build();
    h.tree.rows[100] = [101];
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(101));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({
      status: 'linked',
      sessionId: uid(101),
      basis: 'registry-tree',
      confidence: 'high',
      claudePid: 101,
    });
    expect(h.tree.asked).toEqual([100]);
  });

  it('track of a name that is tracked starts again from pending', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100));
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('linked');
    h.linker.track(probe('app-1', 200));
    expect(linkOf(h, 'app-1')).toEqual(PENDING);
    expect(h.linker.sessionOwner(uid(100))).toBeNull();
  });

  it('an entry from before the spawn is a stale file, not the new claude', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100, { startedAtMs: NOW - 3_600_000 }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('pending');
  });
});

describe('what the link shows once it is made', () => {
  async function linked(h: Harness, over: Partial<RegistryEntry> = {}): Promise<void> {
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100, over));
    await h.linker.tick();
  }

  it('the status and what the process waits for follow the registry; both are gone when the entry is', async () => {
    const h = build();
    await linked(h);
    expect(linkOf(h, 'app-1').registryStatus).toBe('idle');
    h.registry.patch(100, { status: 'waiting', waitingFor: 'a permission prompt' });
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ registryStatus: 'waiting', waitingFor: 'a permission prompt' });
    h.registry.patch(100, { status: null, waitingFor: null });
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ registryStatus: null, waitingFor: null, status: 'linked' });
    h.registry.drop(100);
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({
      registryStatus: null,
      waitingFor: null,
      status: 'linked',
      claudePid: 100,
    });
  });

  it('a pid that is gone shows no status although its file is still there', async () => {
    const h = build();
    await linked(h);
    h.registry.patch(100, { alive: false, status: 'busy' });
    await h.linker.tick();
    expect(linkOf(h, 'app-1').registryStatus).toBeNull();
  });

  it('the transcript is none until the monitor has a row for the session, then tracked', async () => {
    const h = build();
    await linked(h);
    expect(linkOf(h, 'app-1').transcript).toBe('none');
    h.known.add(uid(100));
    await h.linker.tick();
    expect(linkOf(h, 'app-1').transcript).toBe('tracked');
    expect(h.changes.map((c) => c.link.transcript)).toEqual(['none', 'tracked']);
  });

  it('the monitor is asked for the transcript at once, and again once per slow tick while there is none', async () => {
    const h = build();
    await linked(h);
    expect(h.hints).toEqual([uid(100)]);
    h.clock.advance(SLOW - 1);
    await h.linker.tick();
    expect(h.hints).toHaveLength(1);
    h.clock.advance(1);
    await h.linker.tick();
    expect(h.hints).toHaveLength(2);
    h.known.add(uid(100));
    h.clock.advance(SLOW);
    await h.linker.tick();
    expect(h.hints).toHaveLength(2);
  });

  it('a transcript that is known at the moment of the link is not asked for', async () => {
    const h = build();
    h.known.add(uid(100));
    await linked(h);
    expect(linkOf(h, 'app-1').transcript).toBe('tracked');
    expect(h.hints).toEqual([]);
  });

  it('a hint or a lookup that throws does not stop the pass', async () => {
    const clock = new FakeClock(NOW);
    const registry = new FakeRegistry();
    const linker = createTerminalLinker({
      registry,
      tree: new FakeTree(),
      clock,
      config: { linkPollMs: POLL, linkSlowPollMs: SLOW, linkFastWindowMs: FAST, linkStartToleranceMs: TOLERANCE },
      sessionKnown: () => {
        throw new Error('the database is busy');
      },
      sessionsSince: () => [],
      hintSession: () => {
        throw new Error('the importer is stopped');
      },
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      realpath: () => Promise.resolve(null),
    });
    linker.track(probe('app-1', 100));
    registry.put(entry(100));
    await linker.tick();
    expect(linker.link('app-1')).toMatchObject({ status: 'linked', transcript: 'none' });
  });
});

describe('/clear and /resume inside the process', () => {
  async function linkedPid(h: Harness): Promise<void> {
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100));
    await h.linker.tick();
  }

  it('the entry of the same pid gets a new session id: the link follows and the old id is remembered', async () => {
    const h = build();
    await linkedPid(h);
    h.known.add(uid(100));
    await h.linker.tick();
    h.clock.advance(5000);
    h.registry.patch(100, { sessionId: uid(900) });
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({
      status: 'linked',
      sessionId: uid(900),
      previousSessionIds: [uid(100)],
      since: iso(NOW + 5000),
      claudePid: 100,
      basis: 'registry-pid',
      transcript: 'none',
    });
    expect(h.linker.sessionOwner(uid(900))).toBe('app-1');
    expect(h.linker.sessionOwner(uid(100))).toBeNull();
    // the new session is asked for at once
    expect(h.hints.at(-1)).toBe(uid(900));
  });

  it('keeps the last eight old ids, oldest dropped, and an id the process returns to is the current one again', async () => {
    const h = build();
    await linkedPid(h);
    for (let n = 1; n <= 10; n += 1) {
      h.registry.patch(100, { sessionId: uid(1000 + n) });
      await h.linker.tick();
    }
    const link = linkOf(h, 'app-1');
    expect(link.sessionId).toBe(uid(1010));
    expect(link.previousSessionIds).toHaveLength(8);
    expect(link.previousSessionIds[0]).toBe(uid(1002));
    expect(link.previousSessionIds.at(-1)).toBe(uid(1009));

    h.registry.patch(100, { sessionId: uid(1005) });
    await h.linker.tick();
    const back = linkOf(h, 'app-1');
    expect(back.sessionId).toBe(uid(1005));
    expect(back.previousSessionIds).not.toContain(uid(1005));
    expect(back.previousSessionIds.at(-1)).toBe(uid(1010));
  });

  it('every change is announced once', async () => {
    const h = build();
    await linkedPid(h);
    h.registry.patch(100, { sessionId: uid(901) });
    await h.linker.tick();
    await h.linker.tick();
    expect(h.changes.map((c) => c.link.sessionId)).toEqual([uid(100), uid(901)]);
  });
});

describe('two terminals, one folder', () => {
  it('are told apart by their process trees, whichever entry is older', async () => {
    const h = build();
    h.tree.rows[100] = [101];
    h.tree.rows[200] = [201];
    h.linker.track(probe('app-1', 100));
    h.linker.track(probe('app-2', 200, { spawnedAtMs: NOW + 1000 }));
    h.registry.put(entry(201, { startedAtMs: NOW + 1600 }));
    h.registry.put(entry(101, { startedAtMs: NOW + 700 }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ sessionId: uid(101), basis: 'registry-tree', claudePid: 101 });
    expect(linkOf(h, 'app-2')).toMatchObject({ sessionId: uid(201), basis: 'registry-tree', claudePid: 201 });
    expect(h.linker.ownedPids()).toEqual(new Set([101, 201]));
    expect(h.linker.sessionOwner(uid(201))).toBe('app-2');
  });

  it('the second terminal links later without taking the pid of the first', async () => {
    const h = build();
    h.tree.rows[100] = [101];
    h.tree.rows[200] = [201];
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(101));
    await h.linker.tick();
    h.clock.advance(3000);
    h.linker.track(probe('app-2', 200, { spawnedAtMs: h.clock.now() }));
    h.registry.put(entry(201, { startedAtMs: h.clock.now() + 400 }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1').claudePid).toBe(101);
    expect(linkOf(h, 'app-2').claudePid).toBe(201);
  });
});

describe('a claude that is not ours', () => {
  it('one the person started by hand in the same folder is dropped; the terminal links to its own when that appears', async () => {
    const h = build();
    h.tree.rows[100] = [101];
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(900, { startedAtMs: NOW + 100 }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('pending');
    expect(h.linker.ownedPids().size).toBe(0);
    h.clock.advance(POLL * 8);
    h.registry.put(entry(101, { startedAtMs: NOW + 900 }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'linked', claudePid: 101, basis: 'registry-tree' });
    expect(h.linker.ownedPids()).toEqual(new Set([101]));
  });

  it('is never linked, and the terminal stays pending, with the reason shown after the fast window', async () => {
    const h = build();
    h.tree.rows[100] = [];
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(900));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'pending', reason: null });
    h.clock.advance(FAST);
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'pending', reason: 'no_registry', claudePid: null });
  });

  it('a claude of a background session, or of another folder, is not a candidate and the table is not asked', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(901, { kind: 'bg' }));
    h.registry.put(entry(902, { cwd: 'D:\\work\\other' }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('pending');
    expect(h.tree.asked).toEqual([]);
  });
});

describe('the process table is unavailable', () => {
  it('one terminal, one candidate: linked on the folder with medium confidence', async () => {
    const h = build();
    h.tree.rows[100] = null;
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(101));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({
      status: 'linked',
      basis: 'registry-cwd',
      confidence: 'medium',
      claudePid: 101,
    });
  });

  it('a table that fails (rejects) is read as unavailable', async () => {
    const h = build();
    h.tree.throws = true;
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(101));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ basis: 'registry-cwd', confidence: 'medium' });
  });

  it('a resume of a session is linked on its id', async () => {
    const h = build();
    h.tree.rows[100] = null;
    h.linker.track(probe('app-1', 100, { resumeSessionId: uid(101) }));
    h.registry.put(entry(101, { startedAtMs: NOW - 86_400_000 }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ basis: 'resume-id', confidence: 'medium', sessionId: uid(101) });
  });

  it('as many candidates as terminals: paired by order with low confidence', async () => {
    const h = build();
    h.tree.rows[100] = null;
    h.tree.rows[200] = null;
    h.linker.track(probe('app-1', 100));
    h.linker.track(probe('app-2', 200, { spawnedAtMs: NOW + 3000 }));
    h.registry.put(entry(301, { startedAtMs: NOW + 3400 }));
    h.registry.put(entry(302, { startedAtMs: NOW + 400 }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ claudePid: 302, basis: 'registry-order', confidence: 'low' });
    expect(linkOf(h, 'app-2')).toMatchObject({ claudePid: 301, basis: 'registry-order', confidence: 'low' });
  });

  it('different counts: ambiguous, nothing linked, and the pass that finds the counts equal resolves it', async () => {
    const h = build();
    h.tree.rows[100] = null;
    h.tree.rows[200] = null;
    h.linker.track(probe('app-1', 100));
    h.linker.track(probe('app-2', 200, { spawnedAtMs: NOW + 1000 }));
    h.registry.put(entry(101, { startedAtMs: NOW + 500 }));
    await h.linker.tick();
    for (const name of ['app-1', 'app-2']) {
      expect(linkOf(h, name)).toMatchObject({
        status: 'ambiguous',
        reason: 'ambiguous',
        sessionId: null,
        basis: null,
        confidence: null,
        claudePid: null,
      });
    }
    expect(h.linker.ownedPids().size).toBe(0);

    h.clock.advance(1000);
    h.registry.put(entry(201, { startedAtMs: NOW + 1500 }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'linked', claudePid: 101, basis: 'registry-order' });
    expect(linkOf(h, 'app-2')).toMatchObject({ status: 'linked', claudePid: 201, basis: 'registry-order' });
  });

  it('an ambiguous terminal whose candidates leave goes back to pending', async () => {
    const h = build();
    h.tree.rows[100] = null;
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(101));
    h.registry.put(entry(102));
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('ambiguous');
    h.registry.drop(101);
    h.registry.drop(102);
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'pending', reason: null });
  });
});

describe('one question to the process table per decision', () => {
  it('is asked once for a terminal however many looks the poll makes inside the memo window', async () => {
    const h = build();
    h.tree.rows[100] = [];
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(900));
    for (let look = 0; look < 5; look += 1) {
      await h.linker.tick();
      h.clock.advance(POLL);
    }
    expect(h.tree.asked).toEqual([100]);
  });

  it('is asked again when the answer is older than the memo, so a claude that started since is seen', async () => {
    const h = build();
    h.tree.rows[100] = [];
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(101));
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('pending');
    h.tree.rows[100] = [101];
    h.clock.advance(PROCESS_TREE_MEMO_MS - 1);
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('pending');
    h.clock.advance(1);
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'linked', basis: 'registry-tree' });
    expect(h.tree.asked).toEqual([100, 100]);
  });

  it('an unavailable table is remembered longer, so a machine that cannot list processes is not asked every second', async () => {
    const h = build();
    h.tree.rows[100] = null;
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(101));
    h.registry.put(entry(102));
    await h.linker.tick();
    h.clock.advance(PROCESS_TREE_MEMO_MS + 1);
    await h.linker.tick();
    expect(h.tree.asked).toEqual([100]);
    h.clock.advance(PROCESS_TREE_FAILURE_MEMO_MS);
    await h.linker.tick();
    expect(h.tree.asked).toEqual([100, 100]);
  });

  it('passes that overlap share one look at the registry and one question to the table', async () => {
    const h = build();
    h.tree.rows[100] = [];
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(900));
    let release: () => void = () => undefined;
    h.registry.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = h.linker.tick();
    const second = h.linker.tick();
    release();
    await Promise.all([first, second]);
    expect(h.registry.reads).toBe(1);
    expect(h.tree.asked).toEqual([100]);
  });

  it('the table is asked for no terminal that already linked', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100));
    await h.linker.tick();
    h.registry.put(entry(900));
    h.clock.advance(PROCESS_TREE_MEMO_MS * 2);
    await h.linker.tick();
    expect(h.tree.asked).toEqual([]);
  });
});

describe('the registry cannot be read, or has nothing', () => {
  it('a registry that fails to read says registry_unreadable at once, and the next good look clears it', async () => {
    const h = build();
    h.registry.failure = new Error('EACCES');
    h.linker.track(probe('app-1', 100));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'pending', reason: 'registry_unreadable' });
    h.registry.failure = null;
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'pending', reason: null });
  });

  it('a linked terminal stays linked while the registry cannot be read', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100, { status: 'busy' }));
    await h.linker.tick();
    h.registry.failure = new Error('EBUSY');
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'linked', registryStatus: 'busy', reason: null });
  });

  it('an empty registry after the fast window is no_registry, and polling goes on', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    h.clock.advance(FAST - 1);
    await h.linker.tick();
    expect(linkOf(h, 'app-1').reason).toBeNull();
    h.clock.advance(1);
    await h.linker.tick();
    expect(linkOf(h, 'app-1').reason).toBe('no_registry');
    h.clock.advance(SLOW);
    h.registry.put(entry(100));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'linked', reason: null });
  });

  it('the log never holds a terminal name, a folder or a session id, and does say that a link was made', async () => {
    const h = build();
    h.registry.failure = new Error(`EACCES ${FOLDER}`);
    h.linker.track(probe('secret-name-1', 100));
    await h.linker.tick();
    h.registry.failure = null;
    h.registry.put(entry(100));
    await h.linker.tick();
    h.registry.patch(100, { sessionId: uid(900) });
    await h.linker.tick();
    const text = JSON.stringify(h.logs);
    expect(text).toContain('link.linked');
    expect(text).toContain('link.session_changed');
    expect(text).not.toContain('secret-name-1');
    expect(text).not.toContain(uid(100));
    expect(text).not.toContain(uid(900));
    expect(text).not.toContain('work');
    expect(text).not.toContain('EACCES');
  });
});

describe('the fallback on the database after the fast window', () => {
  it('is not asked inside the fast window', async () => {
    const h = build();
    h.sessionRows.value = [uid(500)];
    h.linker.track(probe('app-1', 100));
    h.clock.advance(FAST - 1);
    await h.linker.tick();
    expect(h.since).toEqual([]);
    expect(linkOf(h, 'app-1').status).toBe('pending');
  });

  it('exactly one new session of the project links with low confidence on the time', async () => {
    const h = build();
    h.known.add(uid(500));
    h.sessionRows.value = [uid(500)];
    h.linker.track(probe('app-1', 100));
    h.clock.advance(FAST);
    await h.linker.tick();
    expect(h.since).toEqual([{ key: FOLDER_KEY, sinceMs: NOW - TOLERANCE }]);
    expect(linkOf(h, 'app-1')).toEqual({
      status: 'linked',
      sessionId: uid(500),
      previousSessionIds: [],
      basis: 'transcript-time',
      confidence: 'low',
      since: iso(NOW + FAST),
      claudePid: null,
      transcript: 'tracked',
      registryStatus: null,
      waitingFor: null,
      reason: null,
      shared: false,
    });
    expect(h.linker.sessionOwner(uid(500))).toBe('app-1');
    expect(h.linker.ownedPids().size).toBe(0);
  });

  it.each([
    ['no session', [] as string[]],
    ['two sessions', [uid(500), uid(501)]],
  ])('%s: the terminal stays pending with no_registry', async (_why, rows) => {
    const h = build();
    h.sessionRows.value = rows;
    h.linker.track(probe('app-1', 100));
    h.clock.advance(FAST);
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'pending', reason: 'no_registry' });
  });

  it('a session that a terminal owns already is not a candidate', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100));
    h.linker.track(probe('app-2', 200, { spawnedAtMs: NOW + 10 }));
    await h.linker.tick();
    h.sessionRows.value = [uid(100)];
    h.clock.advance(FAST + 100);
    await h.linker.tick();
    expect(linkOf(h, 'app-2').status).toBe('pending');
  });

  it("a session that a live registry entry holds is somebody else's, so it is no candidate", async () => {
    const h = build();
    h.tree.rows[100] = [];
    h.registry.put(entry(900, { sessionId: uid(500) }));
    h.sessionRows.value = [uid(500)];
    h.linker.track(probe('app-1', 100));
    h.clock.advance(FAST);
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'pending', reason: 'no_registry' });
  });

  it('two terminals of the folder cannot share one new session: neither links', async () => {
    const h = build();
    h.sessionRows.value = [uid(500)];
    h.linker.track(probe('app-1', 100));
    h.linker.track(probe('app-2', 200));
    h.clock.advance(FAST);
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('pending');
    expect(linkOf(h, 'app-2').status).toBe('pending');
  });

  it('a folder whose key Claude cut (a very long path) has no key to ask the database for', async () => {
    const h = build();
    h.sessionRows.value = [uid(500)];
    h.linker.track(probe('app-1', 100, { cwd: `D:\\${'a'.repeat(250)}` }));
    h.clock.advance(FAST);
    await h.linker.tick();
    expect(h.since).toEqual([]);
    expect(linkOf(h, 'app-1').status).toBe('pending');
  });

  it('the registry entry that shows up later replaces the guess', async () => {
    const h = build();
    h.sessionRows.value = [uid(500)];
    h.linker.track(probe('app-1', 100));
    h.clock.advance(FAST);
    await h.linker.tick();
    expect(linkOf(h, 'app-1').basis).toBe('transcript-time');

    h.clock.advance(SLOW);
    h.registry.put(entry(100, { startedAtMs: NOW + FAST }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({
      status: 'linked',
      basis: 'registry-pid',
      confidence: 'high',
      sessionId: uid(100),
      previousSessionIds: [uid(500)],
      claudePid: 100,
    });
  });

  it('a guess that the registry confirms keeps its session and gains the pid', async () => {
    const h = build();
    h.sessionRows.value = [uid(100)];
    h.linker.track(probe('app-1', 100));
    h.clock.advance(FAST);
    await h.linker.tick();
    h.clock.advance(SLOW);
    h.registry.put(entry(100, { startedAtMs: NOW + FAST }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({
      basis: 'registry-pid',
      sessionId: uid(100),
      previousSessionIds: [],
      claudePid: 100,
    });
  });
});

describe('the relaxed pass after the fast window', () => {
  it('an entry whose folder no comparison reads links through the tree, once a slow tick is due', async () => {
    const h = build();
    h.tree.rows[100] = [101];
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(101, { cwd: 'C:\\spelled\\otherwise' }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('pending');
    expect(h.tree.asked).toEqual([]);

    h.clock.advance(FAST);
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'linked', basis: 'registry-tree', claudePid: 101 });
  });

  it('the relaxed pass runs at most once per slow tick', async () => {
    const h = build();
    h.tree.rows[100] = [101];
    h.linker.track(probe('app-1', 100));
    h.clock.advance(FAST);
    await h.linker.tick();
    h.registry.put(entry(101, { cwd: 'C:\\spelled\\otherwise' }));
    h.clock.advance(POLL);
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('pending');
    h.clock.advance(SLOW);
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('linked');
  });
});

describe('real paths', () => {
  it('a folder the key misses is the same folder when both real paths agree; the answers are remembered', async () => {
    const h = build();
    h.realpaths.set('C:\\junction\\app', 'D:\\Real\\App');
    h.realpaths.set('D:\\real\\app', 'D:\\real\\app');
    h.tree.rows[100] = [101];
    h.linker.track(probe('app-1', 100, { cwd: 'C:\\junction\\app' }));
    h.registry.put(entry(101, { cwd: 'D:\\real\\app' }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1')).toMatchObject({ status: 'linked', claudePid: 101 });

    h.linker.track(probe('app-2', 200, { cwd: 'C:\\junction\\app' }));
    await h.linker.tick();
    const asked = h.realpathCalls.filter((path) => path === 'D:\\real\\app');
    expect(asked.length).toBeLessThanOrEqual(1);
  });

  it('a path that cannot be resolved is just not equal', async () => {
    const h = build();
    h.tree.rows[100] = [101];
    h.linker.track(probe('app-1', 100, { cwd: 'C:\\junction\\app' }));
    h.registry.put(entry(101, { cwd: 'D:\\real\\app' }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1').status).toBe('pending');
  });

  // A registry `cwd` is data from a file under the Claude home that any process of the person may write: it is never a reason to touch
  // another machine (a UNC path makes Windows contact it, with the credentials of the person) or a device namespace.
  describe('a folder that cannot be a local folder never reaches the file system', () => {
    const refused = [
      '\\\\server\\share\\app',
      '//server/share/app',
      '\\\\?\\C:\\x',
      '\\\\.\\pipe\\x',
      '\\??\\C:\\x',
      'relative\\dir',
      'D:\\a\\b:stream',
      'D:\\a\\con',
      'D:\\a\u202ee',
      'D:\\a\u0007b',
    ];

    it('a registry entry with such a cwd is not asked about; the pass still links the terminal', async () => {
      const h = build();
      h.tree.rows[100] = [101];
      h.linker.track(probe('app-1', 100));
      refused.forEach((cwd, i) => {
        h.registry.put(entry(300 + i, { cwd }));
      });
      h.registry.put(entry(101));
      await h.linker.tick();
      expect(h.realpathCalls.filter((path) => refused.includes(path))).toEqual([]);
      expect(h.realpathCalls).toEqual([FOLDER]);
      expect(linkOf(h, 'app-1')).toMatchObject({ status: 'linked', basis: 'registry-tree', claudePid: 101 });
    });

    it('is not asked about on any later pass either', async () => {
      const h = build();
      h.linker.track(probe('app-1', 100));
      refused.forEach((cwd, i) => {
        h.registry.put(entry(300 + i, { cwd }));
      });
      for (let i = 0; i < 3; i += 1) {
        h.clock.advance(REALPATH_MEMO_MS + 1);
        await h.linker.tick();
      }
      expect(h.realpathCalls.filter((path) => refused.includes(path))).toEqual([]);
    });

    it('a terminal folder of that kind is not asked about either', async () => {
      const h = build();
      h.linker.track(probe('app-1', 100, { cwd: '\\\\server\\share\\app' }));
      h.registry.put(entry(101, { cwd: 'D:\\real\\app' }));
      await h.linker.tick();
      expect(h.realpathCalls).not.toContain('\\\\server\\share\\app');
      expect(linkOf(h, 'app-1').status).toBe('pending');
    });

    it('a local folder spelled with quotes or slashes is asked about once, in its normalised spelling', async () => {
      const h = build();
      h.linker.track(probe('app-1', 100));
      h.registry.put(entry(101, { cwd: '"d:/other/dir/"' }));
      await h.linker.tick();
      h.clock.advance(POLL);
      await h.linker.tick();
      expect(h.realpathCalls.filter((path) => path !== FOLDER)).toEqual(['D:\\other\\dir']);
    });
  });
});

describe('owner, shared and forget', () => {
  it('a terminal that resumes a session owns it before it is linked; a fork owns nothing', () => {
    const h = build();
    h.linker.track(probe('app-1', 100, { resumeSessionId: uid(7) }));
    h.linker.track(probe('app-2', 200, { resumeSessionId: uid(8), fork: true }));
    expect(h.linker.sessionOwner(uid(7))).toBe('app-1');
    expect(h.linker.sessionOwner(uid(8))).toBeNull();
  });

  it('the first terminal to link a session is its owner; both show shared when another one lands on it', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100));
    await h.linker.tick();
    h.clock.advance(5000);
    h.linker.track(probe('app-2', 200, { spawnedAtMs: h.clock.now() }));
    h.registry.put(entry(200, { startedAtMs: h.clock.now() + 100 }));
    await h.linker.tick();
    expect(linkOf(h, 'app-1').shared).toBe(false);
    expect(linkOf(h, 'app-2').shared).toBe(false);

    // the second process resumes the session of the first from inside
    h.registry.patch(200, { sessionId: uid(100) });
    await h.linker.tick();
    expect(linkOf(h, 'app-1').shared).toBe(true);
    expect(linkOf(h, 'app-2').shared).toBe(true);
    expect(h.linker.sessionOwner(uid(100))).toBe('app-1');
    expect(h.changes.filter((c) => c.name === 'app-1').at(-1)?.link.shared).toBe(true);
  });

  it('forget removes the terminal and its claim, and tells the other terminal that the session is its alone', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100));
    h.linker.track(probe('app-2', 200, { spawnedAtMs: NOW + 100 }));
    h.registry.put(entry(200, { startedAtMs: NOW + 300, sessionId: uid(100) }));
    h.tree.rows[100] = [];
    h.tree.rows[200] = [];
    await h.linker.tick();
    expect(linkOf(h, 'app-1').shared).toBe(true);
    h.changes.length = 0;

    h.linker.forget('app-1');
    expect(h.linker.link('app-1')).toBeNull();
    expect(h.linker.links().has('app-1')).toBe(false);
    expect(h.linker.ownedPids()).toEqual(new Set([200]));
    expect(h.linker.sessionOwner(uid(100))).toBe('app-2');
    expect(linkOf(h, 'app-2').shared).toBe(false);
    expect(h.changes).toEqual([{ name: 'app-2', link: linkOf(h, 'app-2') }]);
    // forgetting what is not tracked is harmless
    h.linker.forget('app-1');
    h.linker.forget('nobody');
  });

  it('a pid that a forgotten terminal held can be linked to another terminal', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100));
    await h.linker.tick();
    h.linker.forget('app-1');
    h.linker.track(probe('app-2', 100, { spawnedAtMs: NOW + 1 }));
    await h.linker.tick();
    expect(linkOf(h, 'app-2')).toMatchObject({ status: 'linked', claudePid: 100 });
  });

  it('a terminal forgotten while a pass runs is not brought back by it', async () => {
    const h = build();
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100));
    let release: () => void = () => undefined;
    h.registry.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pass = h.linker.tick();
    h.linker.forget('app-1');
    release();
    await pass;
    expect(h.linker.link('app-1')).toBeNull();
    expect(h.linker.links().size).toBe(0);
    expect(h.changes).toEqual([]);
  });
});

describe('onChange', () => {
  it('a listener is removed by the function it returned; one that throws does not stop the others', async () => {
    const h = build();
    const seen: string[] = [];
    h.linker.onChange(() => {
      throw new Error('a listener that fails');
    });
    const stop = h.linker.onChange((name) => {
      seen.push(name);
    });
    h.linker.track(probe('app-1', 100));
    h.registry.put(entry(100));
    await h.linker.tick();
    expect(seen).toEqual(['app-1']);
    stop();
    h.registry.patch(100, { status: 'busy' });
    await h.linker.tick();
    expect(seen).toEqual(['app-1']);
    expect(h.changes).toHaveLength(2);
  });
});

describe('the polling timer', () => {
  /** Moves the clock the linker reads and the timers together, one poll at a time so that a look sees the time it happens at. */
  async function advance(h: Harness, ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= Math.min(left, POLL)) {
      const step = Math.min(left, POLL);
      h.clock.advance(step);
      await vi.advanceTimersByTimeAsync(step);
    }
  }

  it('looks every linkPollMs while a terminal is young and starts nothing before there is one', async () => {
    vi.useFakeTimers();
    const h = build();
    h.linker.start();
    h.linker.start();
    await advance(h, 10_000);
    expect(h.registry.reads).toBe(0);

    h.linker.track(probe('app-1', 100));
    await advance(h, POLL * 4);
    expect(h.registry.reads).toBe(4);
    await h.linker.stop();
  });

  it('keeps the fast pace until the fast window is over, then the slow one, also for a terminal that is linked', async () => {
    vi.useFakeTimers();
    const h = build();
    h.linker.start();
    h.linker.track(probe('app-1', 100));
    await advance(h, FAST);
    const fast = h.registry.reads;
    expect(fast).toBe(FAST / POLL);

    await advance(h, SLOW * 5);
    expect(h.registry.reads - fast).toBe(5);

    h.registry.put(entry(100));
    await advance(h, SLOW);
    expect(linkOf(h, 'app-1').status).toBe('linked');
    const linkedReads = h.registry.reads;
    await advance(h, SLOW * 3);
    expect(h.registry.reads - linkedReads).toBe(3);
    await h.linker.stop();
  });

  it('a terminal tracked while the timer sleeps slowly is looked at within linkPollMs', async () => {
    vi.useFakeTimers();
    const h = build();
    h.linker.start();
    h.linker.track(probe('app-1', 100));
    await advance(h, FAST + SLOW * 3);
    const before = h.registry.reads;
    h.linker.track(probe('app-2', 200, { spawnedAtMs: h.clock.now() }));
    await advance(h, POLL);
    expect(h.registry.reads).toBe(before + 1);
    await h.linker.stop();
  });

  it('stop ends the polling and waits for a pass that is running; a stopped linker can start again', async () => {
    vi.useFakeTimers();
    const h = build();
    h.linker.start();
    h.linker.track(probe('app-1', 100));
    let release: () => void = () => undefined;
    h.registry.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await advance(h, POLL);
    expect(h.registry.reads).toBe(1);
    let stopped = false;
    const stopping = h.linker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    const reads = h.registry.reads;
    await advance(h, 10_000);
    expect(h.registry.reads).toBe(reads);

    h.registry.gate = null;
    h.linker.start();
    h.linker.track(probe('app-2', 200, { spawnedAtMs: h.clock.now() }));
    await advance(h, POLL);
    expect(h.registry.reads).toBe(reads + 1);
    await h.linker.stop();
  });

  it('a pass that throws is logged by code only, never rejects, and the timer goes on', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock(NOW);
    const registry = new FakeRegistry();
    const logs: unknown[][] = [];
    let explode = true;
    const note =
      (level: string) =>
      (...args: unknown[]): void => {
        logs.push([level, ...args]);
      };
    const linker = createTerminalLinker({
      registry,
      tree: new FakeTree(),
      clock,
      config: { linkPollMs: POLL, linkSlowPollMs: SLOW, linkFastWindowMs: FAST, linkStartToleranceMs: TOLERANCE },
      sessionKnown: () => false,
      sessionsSince: () => [],
      hintSession: () => undefined,
      // a check of the platform that breaks once, in the middle of a pass
      pidAlive: () => {
        if (explode) {
          explode = false;
          throw new Error('boom');
        }
        return true;
      },
      realpath: () => Promise.resolve(null),
      logger: { debug: note('debug'), info: note('info'), warn: note('warn'), error: note('error') },
    });
    linker.start();
    linker.track(probe('app-1', 100));
    registry.put(entry(100));
    clock.advance(POLL);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(explode).toBe(false);
    expect(logs.some((line) => line[1] === 'link.pass_failed')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('boom');

    clock.advance(POLL);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(registry.reads).toBe(2);
    expect(linker.link('app-1')?.status).toBe('linked');
    await linker.stop();
    await expect(linker.tick()).resolves.toBeUndefined();
  });
});
