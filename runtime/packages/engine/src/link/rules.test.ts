// The rules that tie a terminal to a registry entry (CAW design 03 5.2, ADR 0090): the pre-filter, the confidence ladder with the
// process table (rungs A, B and B-) and without it (rungs C, D and E), and the resume id exception. The functions are pure: the
// process table is a stub that counts its questions, no file and no clock is touched.
import { describe, expect, it } from 'vitest';

import type { RegistryEntry } from '../external/registry.ts';
import { cwdMatches, decideLinks, isNewSince, preFilter } from './rules.ts';
import type { LadderResult, RuleOptions, RuleTerminal, TreeLookup } from './types.ts';

const SPAWN = Date.UTC(2026, 10, 15, 9, 0, 0);
const TOLERANCE = 2000;
const FOLDER = 'D:\\work\\app';
const uid = (n: number): string => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function entry(pid: number, over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid,
    sessionId: uid(pid),
    status: 'idle',
    waitingFor: null,
    cwd: FOLDER,
    startedAtMs: SPAWN + 500,
    updatedAtMs: SPAWN + 500,
    kind: 'interactive',
    entrypoint: 'cli',
    alive: true,
    ...over,
  };
}

function terminal(name: string, pid: number, over: Partial<RuleTerminal> = {}): RuleTerminal {
  return {
    name,
    pid,
    cwd: FOLDER,
    spawnedAtMs: SPAWN,
    resumeSessionId: null,
    fork: false,
    ignoreCwd: false,
    ...over,
  };
}

function options(over: Partial<RuleOptions> = {}): RuleOptions {
  return { startToleranceMs: TOLERANCE, claimedPids: new Set(), realpathOf: () => null, ...over };
}

/** A process table that answers from a map (`null`: the table is unavailable) and records every root it was asked about. */
function table(rows: Readonly<Record<number, readonly number[] | null>>): { lookup: TreeLookup; asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    lookup: (root) => {
      asked.push(root);
      const row = rows[root];
      return Promise.resolve(row === undefined ? new Set<number>() : row === null ? null : new Set(row));
    },
  };
}

async function decide(
  terminals: readonly RuleTerminal[],
  entries: readonly RegistryEntry[],
  rows: Readonly<Record<number, readonly number[] | null>> = {},
  over: Partial<RuleOptions> = {},
): Promise<{ result: LadderResult; asked: number[] }> {
  const t = table(rows);
  const result = await decideLinks(terminals, entries, options(over), t.lookup);
  return { result, asked: t.asked };
}

function linked(result: LadderResult, name: string): { pid: number; basis: string; confidence: string } | null {
  const verdict = result.verdicts.get(name);
  if (verdict?.kind !== 'linked') return null;
  return { pid: verdict.entry.pid, basis: verdict.basis, confidence: verdict.confidence };
}

describe('cwdMatches', () => {
  it('compares folders by the key of the folder helpers: separators, case, a trailing separator and the /mnt form', () => {
    for (const spelling of ['d:/work/APP/', 'D:\\Work\\App\\', '/mnt/d/work/app', '"D:\\work\\app"']) {
      expect(
        cwdMatches(spelling, FOLDER, () => null),
        spelling,
      ).toBe(true);
    }
    expect(cwdMatches('D:\\work\\app2', FOLDER, () => null)).toBe(false);
    expect(cwdMatches('D:\\work', FOLDER, () => null)).toBe(false);
  });

  it('an entry without a folder matches nothing', () => {
    expect(cwdMatches(null, FOLDER, () => null)).toBe(false);
  });

  it('when the keys differ, the real paths decide, and only when both are known', () => {
    const real = (path: string): string | null =>
      ({ 'C:\\links\\app': 'D:\\Work\\App', [FOLDER]: 'D:\\work\\app', 'C:\\other': 'D:\\work\\other' })[path] ?? null;
    expect(cwdMatches('C:\\links\\app', FOLDER, real)).toBe(true);
    expect(cwdMatches('C:\\other', FOLDER, real)).toBe(false);
    expect(cwdMatches('C:\\unknown', FOLDER, real)).toBe(false);
    expect(cwdMatches('C:\\links\\app', FOLDER, (path) => (path === FOLDER ? null : real(path)))).toBe(false);
  });
});

describe('isNewSince', () => {
  it('an entry that started at the spawn time, or up to the tolerance before it, is new', () => {
    const t = terminal('a', 100);
    expect(isNewSince(entry(1, { startedAtMs: SPAWN }), t, TOLERANCE)).toBe(true);
    expect(isNewSince(entry(1, { startedAtMs: SPAWN - TOLERANCE }), t, TOLERANCE)).toBe(true);
    expect(isNewSince(entry(1, { startedAtMs: SPAWN - TOLERANCE - 1 }), t, TOLERANCE)).toBe(false);
  });

  it('an entry with no start time is not proved old', () => {
    expect(isNewSince(entry(1, { startedAtMs: null }), terminal('a', 100), TOLERANCE)).toBe(true);
  });

  it('the resume id exception: the session a terminal resumes is accepted whatever the start time says', () => {
    const old = entry(1, { startedAtMs: SPAWN - 3_600_000 });
    expect(isNewSince(old, terminal('a', 100, { resumeSessionId: old.sessionId }), TOLERANCE)).toBe(true);
    // another id, or a fork (a new session id is expected), gets no exception
    expect(isNewSince(old, terminal('a', 100, { resumeSessionId: uid(99) }), TOLERANCE)).toBe(false);
    expect(isNewSince(old, terminal('a', 100, { resumeSessionId: old.sessionId, fork: true }), TOLERANCE)).toBe(false);
  });
});

describe('preFilter', () => {
  const t = terminal('a', 100);

  it('takes a live interactive entry of the same folder that started after the spawn', () => {
    expect(preFilter(entry(7), t, options())).toBe(true);
    expect(preFilter(entry(7, { kind: null, status: null }), t, options())).toBe(true);
  });

  const refused: readonly (readonly [string, Partial<RegistryEntry>])[] = [
    ['a process that is gone', { alive: false }],
    ['a background session', { kind: 'bg' }],
    ['an id that is no session id', { sessionId: 'not-a-session-id' }],
    ['an entry without a folder', { cwd: null }],
    ['another folder', { cwd: 'D:\\work\\other' }],
    ['an entry that is older than the spawn', { startedAtMs: SPAWN - 60_000 }],
  ];
  it.each(refused)('refuses %s', (_why, over) => {
    expect(preFilter(entry(7, over), t, options())).toBe(false);
  });

  it('refuses a pid that belongs to another linked terminal', () => {
    expect(preFilter(entry(7), t, options({ claimedPids: new Set([7]) }))).toBe(false);
    expect(preFilter(entry(8), t, options({ claimedPids: new Set([7]) }))).toBe(true);
  });

  it('accepts a folder the key misses when the real paths agree', () => {
    const aliased = entry(7, { cwd: 'C:\\short~1\\app' });
    expect(preFilter(aliased, t, options())).toBe(false);
    const realpathOf = (path: string): string | null =>
      path === FOLDER || path === aliased.cwd ? 'D:\\real\\app' : null;
    expect(preFilter(aliased, t, options({ realpathOf }))).toBe(true);
  });

  it('drops the folder test, and only that one, when the terminal says so', () => {
    const away = entry(7, { cwd: 'C:\\somewhere\\else' });
    const relaxed = terminal('a', 100, { ignoreCwd: true });
    expect(preFilter(away, relaxed, options())).toBe(true);
    expect(preFilter({ ...away, alive: false }, relaxed, options())).toBe(false);
    expect(preFilter({ ...away, kind: 'bg' }, relaxed, options())).toBe(false);
    expect(preFilter({ ...away, startedAtMs: SPAWN - 60_000 }, relaxed, options())).toBe(false);
    expect(preFilter(away, relaxed, options({ claimedPids: new Set([7]) }))).toBe(false);
  });

  it('a resumed session passes although its start time is old', () => {
    const resumed = entry(7, { startedAtMs: SPAWN - 86_400_000 });
    expect(preFilter(resumed, t, options())).toBe(false);
    expect(preFilter(resumed, terminal('a', 100, { resumeSessionId: resumed.sessionId }), options())).toBe(true);
  });
});

describe('rung A: the pid of the entry is the root pid', () => {
  it('links at once with high confidence and never asks the process table', async () => {
    const { result, asked } = await decide([terminal('a', 100)], [entry(100)]);
    expect(linked(result, 'a')).toEqual({ pid: 100, basis: 'registry-pid', confidence: 'high' });
    expect(asked).toEqual([]);
    expect(result.foreign.size).toBe(0);
  });

  it('does not need the folder to match: a root pid is ours by construction', async () => {
    const { result } = await decide([terminal('a', 100)], [entry(100, { cwd: 'C:\\spelled\\otherwise' })]);
    expect(linked(result, 'a')?.basis).toBe('registry-pid');
  });

  it('still refuses a stale file whose pid the system reused: a dead process, a background entry, an old start time', async () => {
    const stale: readonly Partial<RegistryEntry>[] = [
      { alive: false },
      { kind: 'bg' },
      { startedAtMs: SPAWN - 3_600_000 },
    ];
    for (const over of stale) {
      const { result } = await decide([terminal('a', 100)], [entry(100, over)]);
      expect(result.verdicts.size, JSON.stringify(over)).toBe(0);
    }
  });

  it('wins over a descendant in the same pass, and the descendant is not asked about', async () => {
    const { result, asked } = await decide([terminal('a', 100)], [entry(100), entry(101)], { 100: [101] });
    expect(linked(result, 'a')?.pid).toBe(100);
    expect(asked).toEqual([]);
  });

  it('a pid that another terminal holds is not given again', async () => {
    const { result } = await decide([terminal('a', 100)], [entry(100)], {}, { claimedPids: new Set([100]) });
    expect(result.verdicts.size).toBe(0);
  });
});

describe('rung B: the entry is a descendant of the root', () => {
  it('links the claude below a cmd.exe shim with high confidence', async () => {
    const { result, asked } = await decide([terminal('a', 100)], [entry(101)], { 100: [101, 102] });
    expect(linked(result, 'a')).toEqual({ pid: 101, basis: 'registry-tree', confidence: 'high' });
    expect(asked).toEqual([100]);
  });

  it('two terminals in one folder are told apart by their trees, whatever the order of the entries', async () => {
    const { result } = await decide(
      [terminal('first', 100), terminal('second', 200, { spawnedAtMs: SPAWN + 1000 })],
      [entry(201, { startedAtMs: SPAWN + 1500 }), entry(101, { startedAtMs: SPAWN + 600 })],
      { 100: [101], 200: [201] },
    );
    expect(linked(result, 'first')?.pid).toBe(101);
    expect(linked(result, 'second')?.pid).toBe(201);
    expect(result.foreign.size).toBe(0);
  });

  it('asks the process table once per terminal, however many candidates there are', async () => {
    const { asked } = await decide([terminal('a', 100)], [entry(101), entry(102), entry(103)], {
      100: [101, 102, 103],
    });
    expect(asked).toEqual([100]);
  });

  it('takes the earliest of several descendants (a claude run by the claude), then the lowest pid', async () => {
    const early = await decide(
      [terminal('a', 100)],
      [entry(102, { startedAtMs: SPAWN + 9000 }), entry(101, { startedAtMs: SPAWN + 500 })],
      { 100: [101, 102] },
    );
    expect(linked(early.result, 'a')?.pid).toBe(101);
    const tie = await decide([terminal('a', 100)], [entry(103), entry(102)], { 100: [102, 103] });
    expect(linked(tie.result, 'a')?.pid).toBe(102);
  });

  it('a descendant that is older than the spawn is a stale file, not the new claude', async () => {
    const { result } = await decide([terminal('a', 100)], [entry(101, { startedAtMs: SPAWN - 60_000 })], {
      100: [101],
    });
    expect(result.verdicts.size).toBe(0);
  });

  it('the resume id exception reaches this rung too', async () => {
    const resumed = entry(101, { startedAtMs: SPAWN - 3_600_000 });
    const { result } = await decide([terminal('a', 100, { resumeSessionId: resumed.sessionId })], [resumed], {
      100: [101],
    });
    expect(linked(result, 'a')).toEqual({ pid: 101, basis: 'registry-tree', confidence: 'high' });
  });

  it('terminals of different folders are separate decisions: only their own roots are asked about', async () => {
    const other = 'D:\\work\\other';
    const { result, asked } = await decide(
      [terminal('a', 100), terminal('b', 200, { cwd: other, spawnedAtMs: SPAWN + 10 })],
      [entry(101), entry(201, { cwd: other })],
      { 100: [101], 200: [201] },
    );
    expect(linked(result, 'a')?.pid).toBe(101);
    expect(linked(result, 'b')?.pid).toBe(201);
    expect(asked.sort()).toEqual([100, 200]);
  });

  it('asks nothing when no entry passes the pre-filter', async () => {
    const { result, asked } = await decide([terminal('a', 100)], [entry(101, { cwd: 'D:\\work\\other' })], {
      100: [101],
    });
    expect(result.verdicts.size).toBe(0);
    expect(asked).toEqual([]);
  });
});

describe('rung B-: a candidate that is no descendant of any pending terminal is not ours', () => {
  it('drops a claude the person started by hand in the same folder and links the one below the terminal', async () => {
    const { result } = await decide([terminal('a', 100)], [entry(900), entry(101)], { 100: [101] });
    expect(linked(result, 'a')?.pid).toBe(101);
    expect(result.foreign).toEqual(new Set([900]));
  });

  it('leaves the terminal pending when the only candidate is foreign', async () => {
    const { result } = await decide([terminal('a', 100)], [entry(900)], { 100: [] });
    expect(result.verdicts.size).toBe(0);
    expect(result.foreign).toEqual(new Set([900]));
  });

  it("a candidate below another pending terminal of the folder is that terminal's, not foreign", async () => {
    const { result } = await decide(
      [terminal('first', 100), terminal('second', 200, { spawnedAtMs: SPAWN + 10 })],
      [entry(201)],
      { 100: [], 200: [201] },
    );
    expect(linked(result, 'second')?.pid).toBe(201);
    expect(result.verdicts.has('first')).toBe(false);
    expect(result.foreign.size).toBe(0);
  });
});

describe('the relaxed pass after the fast window', () => {
  const away = entry(101, { cwd: 'C:\\spelled\\otherwise' });

  it('with the folder test on, an entry in a folder the comparison cannot read is no candidate (and the table is not asked)', async () => {
    const { result, asked } = await decide([terminal('a', 100)], [away], { 100: [101] });
    expect(result.verdicts.size).toBe(0);
    expect(asked).toEqual([]);
  });

  it('with the folder test dropped, the tree alone links it', async () => {
    const { result } = await decide([terminal('a', 100, { ignoreCwd: true })], [away], { 100: [101] });
    expect(linked(result, 'a')).toEqual({ pid: 101, basis: 'registry-tree', confidence: 'high' });
  });

  it('never links a weak rung without the folder: with no table, the relaxed terminal still needs the folder', async () => {
    const { result } = await decide([terminal('a', 100, { ignoreCwd: true })], [away], { 100: null });
    expect(result.verdicts.size).toBe(0);
    const same = await decide([terminal('a', 100, { ignoreCwd: true })], [entry(101)], { 100: null });
    expect(linked(same.result, 'a')?.basis).toBe('registry-cwd');
  });
});

describe('rungs C, D and E: the process table is unavailable', () => {
  const unavailable = (...roots: number[]): Record<number, null> =>
    Object.fromEntries(roots.map((root) => [root, null]));

  it('C: one terminal and one candidate in the folder link with medium confidence on the folder', async () => {
    const { result } = await decide([terminal('a', 100)], [entry(101)], unavailable(100));
    expect(linked(result, 'a')).toEqual({ pid: 101, basis: 'registry-cwd', confidence: 'medium' });
  });

  it('C: a resumed session is linked on the resume id', async () => {
    const resumed = entry(101);
    const { result } = await decide(
      [terminal('a', 100, { resumeSessionId: resumed.sessionId })],
      [resumed],
      unavailable(100),
    );
    expect(linked(result, 'a')).toEqual({ pid: 101, basis: 'resume-id', confidence: 'medium' });
  });

  it('C: a fork is linked on the folder, because its id is a new one', async () => {
    const { result } = await decide(
      [terminal('a', 100, { resumeSessionId: uid(5), fork: true })],
      [entry(101)],
      unavailable(100),
    );
    expect(linked(result, 'a')?.basis).toBe('registry-cwd');
  });

  it('D: as many candidates as terminals are paired by order, the oldest spawn with the oldest start, with low confidence', async () => {
    const { result } = await decide(
      [terminal('late', 200, { spawnedAtMs: SPAWN + 3000 }), terminal('early', 100)],
      [entry(301, { startedAtMs: SPAWN + 3500 }), entry(302, { startedAtMs: SPAWN + 400 })],
      unavailable(100, 200),
    );
    expect(linked(result, 'early')).toEqual({ pid: 302, basis: 'registry-order', confidence: 'low' });
    expect(linked(result, 'late')).toEqual({ pid: 301, basis: 'registry-order', confidence: 'low' });
  });

  it('D: equal start times pair by pid, so the answer does not depend on the order of the input', async () => {
    const a = await decide([terminal('x', 100), terminal('y', 200)], [entry(302), entry(301)], unavailable(100, 200));
    const b = await decide([terminal('y', 200), terminal('x', 100)], [entry(301), entry(302)], unavailable(100, 200));
    expect(linked(a.result, 'x')?.pid).toBe(301);
    expect(linked(b.result, 'x')?.pid).toBe(301);
  });

  it('E: more candidates than terminals is ambiguous, and nothing is linked', async () => {
    const { result } = await decide([terminal('a', 100)], [entry(101), entry(102)], unavailable(100));
    expect(result.verdicts.get('a')).toEqual({ kind: 'ambiguous' });
  });

  it('E: fewer candidates than terminals is ambiguous for every terminal of the folder', async () => {
    const { result } = await decide(
      [terminal('a', 100), terminal('b', 200, { spawnedAtMs: SPAWN + 5 })],
      [entry(101)],
      unavailable(100, 200),
    );
    expect(result.verdicts.get('a')).toEqual({ kind: 'ambiguous' });
    expect(result.verdicts.get('b')).toEqual({ kind: 'ambiguous' });
  });

  it('no candidate, no verdict: the terminal just stays pending', async () => {
    const { result, asked } = await decide([terminal('a', 100)], [], unavailable(100));
    expect(result.verdicts.size).toBe(0);
    expect(asked).toEqual([]);
  });

  it('a table that fails for one root of the folder makes the whole folder weak', async () => {
    const { result } = await decide(
      [terminal('a', 100), terminal('b', 200, { spawnedAtMs: SPAWN + 5 })],
      [entry(101), entry(201)],
      { 100: [101], 200: null },
    );
    expect(linked(result, 'a')?.basis).toBe('registry-order');
    expect(linked(result, 'b')?.basis).toBe('registry-order');
  });

  it('candidates that other terminals hold are not counted', async () => {
    const { result } = await decide([terminal('a', 100)], [entry(101), entry(102)], unavailable(100), {
      claimedPids: new Set([102]),
    });
    expect(linked(result, 'a')).toEqual({ pid: 101, basis: 'registry-cwd', confidence: 'medium' });
  });

  it('folders are counted one by one', async () => {
    const other = 'D:\\work\\other';
    const { result } = await decide(
      [terminal('a', 100), terminal('b', 200, { cwd: other })],
      [entry(101), entry(201, { cwd: other }), entry(202, { cwd: other })],
      unavailable(100, 200),
    );
    expect(linked(result, 'a')?.basis).toBe('registry-cwd');
    expect(result.verdicts.get('b')).toEqual({ kind: 'ambiguous' });
  });
});

describe('determinism', () => {
  it('the same facts give the same answer, whatever the order terminals and entries come in', async () => {
    const terminals = [terminal('b', 200, { spawnedAtMs: SPAWN + 1000 }), terminal('a', 100)];
    const entries = [entry(201, { startedAtMs: SPAWN + 1500 }), entry(101)];
    const rows = { 100: [101], 200: [201] };
    const one = await decide(terminals, entries, rows);
    const two = await decide([...terminals].reverse(), [...entries].reverse(), rows);
    expect([...one.result.verdicts.keys()].sort()).toEqual([...two.result.verdicts.keys()].sort());
    expect(linked(one.result, 'a')).toEqual(linked(two.result, 'a'));
    expect(linked(one.result, 'b')).toEqual(linked(two.result, 'b'));
  });
});
