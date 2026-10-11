// The registry reader (02 7.10, T-LF-53): only `*.json` files are opened, never a `.key`; an unknown session id is ignored; a
// dead pid (a spawned child that has exited) is reported as not alive; an unchanged value comes again only after 60 s.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { FakeClock, killAllTracked, spawnTracked, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { registryEntry, writeRegistry } from '../../test/fixtures/external.ts';
import { pidAlive } from '../platform/process.ts';
import { nodeExternalFs, type ExternalFs } from './fs.ts';
import { createRegistryReader, REGISTRY_REPEAT_MS, type RegistryReaderOptions } from './registry.ts';

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
