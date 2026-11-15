// The registry reader (02 7.10, T-LF-53): only `*.json` files are opened, never a `.key`; an unknown session id is ignored; a
// dead pid (a spawned child that has exited) is reported as not alive; an unchanged value comes again only after 60 s.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CANARY,
  FakeClock,
  killAllTracked,
  rewriteRegistryEntry,
  spawnTracked,
  useTempDirs,
  writeRegistryEntry,
  writeRegistryFile,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { registryEntry, writeRegistry } from '../../test/fixtures/external.ts';
import { pidAlive } from '../platform/process.ts';
import { nodeExternalFs, type ExternalFs } from './fs.ts';
import {
  createRegistryReader,
  createRegistrySnapshot,
  listRegistryEntries,
  REGISTRY_FILE_MAX_BYTES,
  REGISTRY_HINT_REPEAT_MS,
  REGISTRY_REPEAT_MS,
  REGISTRY_SNAPSHOT_MEMO_MS,
  type RegistryReaderOptions,
  type RegistrySnapshot,
} from './registry.ts';

const tempDir = useTempDirs();
const KNOWN = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const START = Date.UTC(2026, 9, 12, 8, 0, 0);

afterEach(killAllTracked);

/** A file system that records every file it is asked to read. */
function spyFs(): { fs: ExternalFs; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    fs: {
      readdir: (dir) => nodeExternalFs.readdir(dir),
      readSmall: (file, max) => {
        opened.push(path.basename(file));
        return nodeExternalFs.readSmall(file, max);
      },
    },
  };
}

function reader(
  over: Partial<RegistryReaderOptions> & { claudeHome: string },
): ReturnType<typeof createRegistryReader> {
  const clock = new FakeClock(START);
  return createRegistryReader({
    now: () => clock.now(),
    isKnownSession: (uid) => uid === KNOWN,
    pidAlive: () => true,
    ...over,
  });
}

describe('createRegistryReader', () => {
  it('never opens a .key file and reports the entry of a known session', async () => {
    const home = tempDir('registry').path;
    writeRegistry(home, [registryEntry({ pid: 4242, sessionId: KNOWN, status: 'busy' })], { keyDecoys: true });
    const spy = spyFs();
    const poll = await reader({ claudeHome: home, fs: spy.fs }).poll();
    expect(spy.opened).toEqual(['4242.json']);
    expect(poll.events).toEqual([
      { k: 'external.registry', sessionId: KNOWN, status: 'busy', pid: 4242, pidAlive: true, observedAt: START },
    ]);
    expect(poll.readFailures).toBe(0);
  });

  it('ignores an entry whose session this instance does not know', async () => {
    const home = tempDir('registry').path;
    writeRegistry(home, [registryEntry({ pid: 4242, sessionId: OTHER })]);
    expect((await reader({ claudeHome: home }).poll()).events).toEqual([]);
  });

  it('clips waitingFor to 64 code points and keeps the waiting status', async () => {
    const home = tempDir('registry').path;
    writeRegistry(home, [
      registryEntry({ pid: 4242, sessionId: KNOWN, status: 'waiting', waitingFor: 'permission prompt '.repeat(10) }),
    ]);
    const [event] = (await reader({ claudeHome: home }).poll()).events;
    expect(event?.status).toBe('waiting');
    expect(event?.waitingFor).toHaveLength(64);
  });

  it('reports a pid that exited as not alive (a spawned and exited child)', async () => {
    const home = tempDir('registry').path;
    const child = spawnTracked(process.execPath, ['-e', '0']);
    await child.exited;
    writeRegistry(home, [registryEntry({ pid: child.pid, sessionId: KNOWN })]);
    const poll = await reader({ claudeHome: home, pidAlive }).poll();
    expect(poll.events.map((e) => e.pidAlive)).toEqual([false]);
  });

  it('counts a damaged file and a file of the wrong shape as read failures and skips them', async () => {
    const home = tempDir('registry').path;
    const dir = writeRegistry(home, [registryEntry({ pid: 4242, sessionId: KNOWN })]);
    writeFileSync(path.join(dir, '4243.json'), '{"pid": 4243, FIXTURE damaged');
    writeFileSync(path.join(dir, '4244.json'), JSON.stringify({ pid: 4244, sessionId: KNOWN, status: 'sleeping' }));
    const poll = await reader({ claudeHome: home }).poll();
    expect(poll.readFailures).toBe(2);
    expect(poll.events).toHaveLength(1);
  });

  it('ignores names that are not <pid>.json and a file that is too large', async () => {
    const home = tempDir('registry').path;
    const dir = writeRegistry(home, [registryEntry({ pid: 4242, sessionId: KNOWN })]);
    writeFileSync(path.join(dir, 'notes.json'), '{}');
    writeFileSync(path.join(dir, '4243.json'), ' '.repeat(70 * 1024));
    const spy = spyFs();
    const poll = await reader({ claudeHome: home, fs: spy.fs }).poll();
    expect(spy.opened).not.toContain('notes.json');
    expect(poll.readFailures).toBe(1);
    expect(poll.events).toHaveLength(1);
  });

  it('announces a change at once and an unchanged value only every 60 s, and only after commit', async () => {
    const home = tempDir('registry').path;
    const dir = writeRegistry(home, [registryEntry({ pid: 4242, sessionId: KNOWN, status: 'busy' })]);
    const clock = new FakeClock(START);
    const r = createRegistryReader({
      claudeHome: home,
      now: () => clock.now(),
      isKnownSession: () => true,
      pidAlive: () => true,
    });
    const first = await r.poll();
    expect(first.events).toHaveLength(1);
    // not committed (the writer refused the batch): the same observation comes again
    expect((await r.poll()).events).toHaveLength(1);
    first.commit();
    expect((await r.poll()).events).toEqual([]);
    clock.advance(REGISTRY_REPEAT_MS - 1);
    expect((await r.poll()).events).toEqual([]);
    clock.advance(1);
    const repeat = await r.poll();
    expect(repeat.events).toHaveLength(1);
    repeat.commit();
    // a change of status is announced immediately
    writeFileSync(
      path.join(dir, '4242.json'),
      JSON.stringify(registryEntry({ pid: 4242, sessionId: KNOWN, status: 'idle' })),
    );
    const changed = await r.poll();
    expect(changed.events.map((e) => e.status)).toEqual(['idle']);
  });

  it('prefers the live entry when two files name one session', async () => {
    const home = tempDir('registry').path;
    writeRegistry(home, [
      registryEntry({ pid: 4242, sessionId: KNOWN, status: 'busy' }),
      registryEntry({ pid: 4243, sessionId: KNOWN, status: 'idle' }),
    ]);
    const poll = await reader({ claudeHome: home, pidAlive: (pid) => pid === 4243 }).poll();
    expect(poll.events.map((e) => [e.pid, e.pidAlive])).toEqual([[4243, true]]);
  });

  it('answers an empty poll for a Claude home without a sessions folder', async () => {
    const home = tempDir('registry').path;
    const poll = await reader({ claudeHome: home }).poll();
    expect(poll).toMatchObject({ events: [], readFailures: 0 });
  });
});

// ---- the entries of the registry as the link and the resume check need them (CAW design 03 5.4) ------------------------------------

const ALIVE_PID = 4242;
const PROJECT_CWD = 'FIXTURE-cwd/project';

function entriesHome(): string {
  return tempDir('registry-entries').path;
}

describe('listRegistryEntries', () => {
  it('lists every entry with the fields of the registry, whatever the session is and whether the process lives', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, {
      pid: ALIVE_PID,
      sessionId: KNOWN,
      cwd: PROJECT_CWD,
      startedAt: 1_790_000_001_000,
      updatedAt: 1_790_000_002_000,
      status: 'waiting',
      waitingFor: 'permission prompt',
    });
    writeRegistryEntry(home, { pid: 4243, sessionId: OTHER, kind: 'bg', status: 'busy', entrypoint: 'sdk-cli' });
    const listing = await listRegistryEntries({ claudeHome: home, pidAlive: (pid) => pid === ALIVE_PID });
    expect(listing.readFailures).toBe(0);
    expect(listing.entries).toEqual([
      {
        pid: ALIVE_PID,
        sessionId: KNOWN,
        status: 'waiting',
        waitingFor: 'permission prompt',
        cwd: PROJECT_CWD,
        startedAtMs: 1_790_000_001_000,
        updatedAtMs: 1_790_000_002_000,
        kind: 'interactive',
        entrypoint: 'cli',
        alive: true,
      },
      expect.objectContaining({ pid: 4243, sessionId: OTHER, kind: 'bg', status: 'busy', alive: false }),
    ]);
  });

  it('keeps an entry whose status is a value this version does not know, as status null', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, { pid: ALIVE_PID, sessionId: KNOWN, status: 'sleeping' });
    writeRegistryEntry(home, { pid: 4243, sessionId: OTHER });
    rewriteRegistryEntry(home, 4243, { drop: ['status', 'kind', 'cwd', 'startedAt', 'updatedAt', 'entrypoint'] });
    const { entries, readFailures } = await listRegistryEntries({ claudeHome: home, pidAlive: () => true });
    expect(readFailures).toBe(0);
    expect(entries.map((e) => [e.pid, e.status])).toEqual([
      [ALIVE_PID, null],
      [4243, null],
    ]);
    expect(entries[1]).toMatchObject({
      waitingFor: null,
      cwd: null,
      startedAtMs: null,
      updatedAtMs: null,
      kind: null,
      entrypoint: null,
    });
  });

  it('never reads name or procStart: the entry has neither, and a prompt-shaped name never leaves the file', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, {
      pid: ALIVE_PID,
      sessionId: KNOWN,
      extra: { name: CANARY.prompt, nameSource: 'prompt', procStart: 'FIXTURE-proc-start' },
    });
    const { entries } = await listRegistryEntries({ claudeHome: home, pidAlive: () => true });
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(
      [
        'alive',
        'cwd',
        'entrypoint',
        'kind',
        'pid',
        'sessionId',
        'startedAtMs',
        'status',
        'updatedAtMs',
        'waitingFor',
      ].sort(),
    );
    expect(JSON.stringify(entries)).not.toContain(CANARY.prompt);
    expect(JSON.stringify(entries)).not.toContain('FIXTURE-proc-start');
  });

  it('requires a pid and a session id: an entry without one, or with a bad one, is a read failure and is left out', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, { pid: ALIVE_PID, sessionId: KNOWN });
    writeRegistryFile(home, '4243.json', JSON.stringify({ pid: 4243, status: 'idle' }));
    writeRegistryFile(home, '4244.json', JSON.stringify({ pid: 4244, sessionId: 'not-a-session-id' }));
    writeRegistryFile(home, '4245.json', JSON.stringify({ sessionId: KNOWN }));
    writeRegistryFile(home, '4246.json', '{"pid": 4246, FIXTURE damaged');
    const { entries, readFailures } = await listRegistryEntries({ claudeHome: home, pidAlive: () => true });
    expect(entries.map((e) => e.pid)).toEqual([ALIVE_PID]);
    expect(readFailures).toBe(4);
  });

  it('clips cwd to 1024 code points and waitingFor to 64, and takes a time only as epoch milliseconds', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, {
      pid: ALIVE_PID,
      sessionId: KNOWN,
      cwd: `/${'a'.repeat(3000)}`,
      status: 'waiting',
      waitingFor: 'w'.repeat(500),
      startedAt: -5,
      updatedAt: 1.5,
    });
    rewriteRegistryEntry(home, ALIVE_PID, { extra: { startedAt: 'yesterday' } });
    const [entry] = (await listRegistryEntries({ claudeHome: home, pidAlive: () => true })).entries;
    expect(Array.from(entry?.cwd ?? '')).toHaveLength(1024);
    expect(entry?.waitingFor).toHaveLength(64);
    expect(entry?.startedAtMs).toBeNull();
    expect(entry?.updatedAtMs).toBeNull();
  });

  it('never opens a .key file, a name that is not <pid>.json, or a file of more than 64 KiB', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, { pid: ALIVE_PID, sessionId: KNOWN }, { keyDecoy: true });
    writeRegistryFile(home, 'notes.json', '{}');
    writeRegistryFile(home, '4243.json', ' '.repeat(REGISTRY_FILE_MAX_BYTES + 1));
    const spy = spyFs();
    const { entries, readFailures } = await listRegistryEntries({
      claudeHome: home,
      pidAlive: () => true,
      fs: spy.fs,
    });
    expect([...spy.opened].sort()).toEqual(['4242.json', '4243.json']);
    expect(entries.map((e) => e.pid)).toEqual([ALIVE_PID]);
    expect(readFailures).toBe(1);
  });

  it('answers an empty list for a home without a sessions folder, and sorts the entries by pid', async () => {
    const home = entriesHome();
    expect(await listRegistryEntries({ claudeHome: home, pidAlive: () => true })).toEqual({
      entries: [],
      readFailures: 0,
    });
    writeRegistryEntry(home, { pid: 100, sessionId: OTHER });
    writeRegistryEntry(home, { pid: 9, sessionId: KNOWN });
    const { entries } = await listRegistryEntries({ claudeHome: home, pidAlive: () => true });
    expect(entries.map((e) => e.pid)).toEqual([9, 100]);
  });
});

describe('createRegistrySnapshot', () => {
  function snapshotOf(home: string, clock: FakeClock): { snapshot: RegistrySnapshot; reads: { count: number } } {
    const reads = { count: 0 };
    const fs: ExternalFs = {
      readdir: (dir) => {
        reads.count += 1;
        return nodeExternalFs.readdir(dir);
      },
      readSmall: (file, max) => nodeExternalFs.readSmall(file, max),
    };
    return {
      snapshot: createRegistrySnapshot({ claudeHome: home, pidAlive: () => true, now: () => clock.now(), fs }),
      reads,
    };
  }

  it('reads the folder once for a second and reads it again after that', async () => {
    const home = entriesHome();
    const clock = new FakeClock(START);
    const { snapshot, reads } = snapshotOf(home, clock);
    writeRegistryEntry(home, { pid: ALIVE_PID, sessionId: KNOWN });
    expect((await snapshot.read()).entries.map((e) => e.pid)).toEqual([ALIVE_PID]);
    writeRegistryEntry(home, { pid: 4243, sessionId: OTHER });
    clock.advance(REGISTRY_SNAPSHOT_MEMO_MS - 1);
    expect((await snapshot.read()).entries.map((e) => e.pid)).toEqual([ALIVE_PID]);
    expect(reads.count).toBe(1);
    clock.advance(1);
    expect((await snapshot.read()).entries.map((e) => e.pid)).toEqual([ALIVE_PID, 4243]);
    expect(reads.count).toBe(2);
  });

  it('is single flight: callers that ask while a read runs share it', async () => {
    const home = entriesHome();
    const clock = new FakeClock(START);
    const { snapshot, reads } = snapshotOf(home, clock);
    writeRegistryEntry(home, { pid: ALIVE_PID, sessionId: KNOWN });
    const [a, b, c] = await Promise.all([snapshot.read(), snapshot.read(), snapshot.read()]);
    expect(reads.count).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('forgets a read that failed, so the next caller reads again', async () => {
    const clock = new FakeClock(START);
    let calls = 0;
    const fs: ExternalFs = {
      readdir: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('FIXTURE disk gone')) : Promise.resolve([]);
      },
      readSmall: () => Promise.resolve(null),
    };
    const snapshot = createRegistrySnapshot({
      claudeHome: entriesHome(),
      pidAlive: () => true,
      now: () => clock.now(),
      fs,
    });
    await expect(snapshot.read()).rejects.toThrow('FIXTURE disk gone');
    expect(await snapshot.read()).toEqual({ entries: [], readFailures: 0 });
  });
});

describe('the hint for a session this instance does not know', () => {
  function hinting(over: Partial<RegistryReaderOptions> & { claudeHome: string }): {
    r: ReturnType<typeof createRegistryReader>;
    hints: [string, string | null][];
    clock: FakeClock;
  } {
    const hints: [string, string | null][] = [];
    const clock = new FakeClock(START);
    const r = createRegistryReader({
      now: () => clock.now(),
      isKnownSession: (uid) => uid === KNOWN,
      pidAlive: () => true,
      onUnknownSession: (uid, cwd) => hints.push([uid, cwd]),
      ...over,
    });
    return { r, hints, clock };
  }

  it('names the session and its working folder for a live process, and yields no event for it', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, { pid: ALIVE_PID, sessionId: OTHER, cwd: PROJECT_CWD });
    const { r, hints } = hinting({ claudeHome: home });
    const poll = await r.poll();
    expect(hints).toEqual([[OTHER, PROJECT_CWD]]);
    expect(poll.events).toEqual([]);
  });

  it('passes null for a missing or non-text cwd', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, { pid: ALIVE_PID, sessionId: OTHER });
    rewriteRegistryEntry(home, ALIVE_PID, { drop: ['cwd'] });
    writeRegistryEntry(home, { pid: 4243, sessionId: '00000000-0000-4000-8000-0000000000a3' });
    rewriteRegistryEntry(home, 4243, { extra: { cwd: 7 } });
    const { r, hints } = hinting({ claudeHome: home });
    await r.poll();
    expect(hints.map(([, cwd]) => cwd)).toEqual([null, null]);
  });

  it('stays quiet for a known session, for a process that is gone and when no callback is given', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, { pid: ALIVE_PID, sessionId: KNOWN });
    writeRegistryEntry(home, { pid: 4243, sessionId: OTHER });
    const gone = hinting({ claudeHome: home, pidAlive: () => false });
    await gone.r.poll();
    expect(gone.hints).toEqual([]);
    const live = hinting({ claudeHome: home, pidAlive: (pid) => pid === ALIVE_PID });
    await live.r.poll();
    expect(live.hints).toEqual([]);
    const silent = createRegistryReader({
      claudeHome: home,
      now: () => START,
      isKnownSession: () => false,
      pidAlive: () => true,
    });
    expect((await silent.poll()).events).toEqual([]);
  });

  it('says it again only after 30 seconds, and again for a session that came back', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, { pid: ALIVE_PID, sessionId: OTHER });
    const { r, hints, clock } = hinting({ claudeHome: home });
    await r.poll();
    clock.advance(REGISTRY_HINT_REPEAT_MS - 1);
    await r.poll();
    expect(hints).toHaveLength(1);
    clock.advance(1);
    await r.poll();
    expect(hints).toHaveLength(2);
  });

  it('hints even when the status is a value the strict reader refuses, which still counts as a read failure', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, { pid: ALIVE_PID, sessionId: OTHER, status: 'sleeping' });
    const { r, hints } = hinting({ claudeHome: home });
    const poll = await r.poll();
    expect(hints).toHaveLength(1);
    expect(poll.readFailures).toBe(1);
  });

  it('survives a callback that throws', async () => {
    const home = entriesHome();
    writeRegistryEntry(home, { pid: ALIVE_PID, sessionId: OTHER });
    writeRegistryEntry(home, { pid: 4243, sessionId: KNOWN });
    const { r } = hinting({
      claudeHome: home,
      onUnknownSession: () => {
        throw new Error('FIXTURE callback failed');
      },
    });
    const poll = await r.poll();
    expect(poll.events.map((e) => e.sessionId)).toEqual([KNOWN]);
    expect(poll.readFailures).toBe(0);
  });
});
