// The pid evidence (02 7.10, E7): one `external.pid` event per probed session, a dead pid is reported as dead.
import { killAllTracked, spawnTracked } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { pidAlive } from '../platform/process.ts';
import { pidEvents } from './pid.ts';

const SESSION = '00000000-0000-4000-8000-0000000000c1';
const NOW = Date.UTC(2026, 9, 12, 8, 0, 0);

afterEach(killAllTracked);

describe('pidEvents', () => {
  it('reports the probe result of every valid pid with the time of the check', () => {
    const events = pidEvents(
      [
        { sessionUid: SESSION, pid: 100 },
        { sessionUid: '00000000-0000-4000-8000-0000000000c2', pid: 200 },
      ],
      NOW,
      (pid) => pid === 100,
    );
    expect(events).toEqual([
      { k: 'external.pid', sessionId: SESSION, pid: 100, alive: true, checkedAt: NOW },
      { k: 'external.pid', sessionId: '00000000-0000-4000-8000-0000000000c2', pid: 200, alive: false, checkedAt: NOW },
    ]);
  });

  it('never probes an invalid pid', () => {
    const probed: number[] = [];
    const events = pidEvents(
      [
        { sessionUid: SESSION, pid: 0 },
        { sessionUid: SESSION, pid: -4 },
        { sessionUid: SESSION, pid: 1.5 },
        { sessionUid: SESSION, pid: 12_345_678_901 },
      ],
      NOW,
      (pid) => {
        probed.push(pid);
        return true;
      },
    );
    expect(events).toEqual([]);
    expect(probed).toEqual([]);
  });

  it('sees a live process as alive and a process that exited as dead (real probe)', async () => {
    const child = spawnTracked(process.execPath, ['-e', 'setTimeout(() => undefined, 30000)']);
    const [whileRunning] = pidEvents([{ sessionUid: SESSION, pid: child.pid }], NOW, pidAlive);
    expect(whileRunning?.alive).toBe(true);
    child.kill();
    await child.exited;
    const [afterExit] = pidEvents([{ sessionUid: SESSION, pid: child.pid }], NOW, pidAlive);
    expect(afterExit?.alive).toBe(false);
  });
});
