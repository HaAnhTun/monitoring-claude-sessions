// Hook routing between instances (02 2.6, T-HK-05 spawn part; 01 3.5 brief 4): the real handler is started with the `MCS_HOME`
// of two real instances and routes by the route files that the instances wrote themselves.
//   - two routes that match one transcript folder give two spool lines with one event_uid and two instance ids;
//   - with two live instances, an event of the transcript folder of A reaches A only, and an event of B reaches B only;
//   - an instance whose hooks are off, and an event of a folder nobody watches, receive nothing.
// Reception is proved twice: by the spool file of the workspace (what the handler wrote) and by the ingest health of the
// instance (what its drainer and writer committed).
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { readRouteFile } from '@mcs/engine';
import { routeKey } from '@mcs/shared/protocol';
import { waitFor } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { twoWorkspaces, type RunningInstance } from './_setup.ts';
import {
  enableHooks,
  forward,
  hookSource,
  spoolEnvelopes,
  timelineEvents,
  transcriptsFolder,
  watchTranscriptsIn,
} from './_hooks.ts';

const SESSION_A = 'a0a0a0a0-0000-4000-8000-00000000000a';
const SESSION_B = 'b0b0b0b0-0000-4000-8000-00000000000b';

function expectRoute(mcsHome: string, running: RunningInstance, dir: string): void {
  const route = readRouteFile(mcsHome, running.instanceId);
  expect(route, `the route file of ${running.slug}`).not.toBeNull();
  expect(route).toMatchObject({ enabled: true, stoppedAt: null });
  expect(route?.match.transcriptsDirs).toContain(routeKey(forward(dir)));
  // the instance names its workspace by its real path (registry C07), which expands a short Windows name
  expect(route?.spoolDir).toBe(`${forward(realpathSync.native(running.dir))}/data/spool`);
}

describe('hook routing isolation (T-HK-05 spawn part)', () => {
  it('two instances that watch one folder both get the event: two lines, one event_uid, two instance ids', async () => {
    const { a, b } = await twoWorkspaces({ sameRepo: true });
    const dir = transcriptsFolder(a.env, 'shared');
    for (const ws of [a, b]) {
      enableHooks(ws);
      await watchTranscriptsIn(ws, dir);
    }
    const runningA = await a.start();
    const runningB = await b.start();
    const mcsHome = a.env['MCS_HOME'] ?? '';
    expectRoute(mcsHome, runningA, dir);
    expectRoute(mcsHome, runningB, dir);

    await hookSource(a.env, dir, SESSION_A).fire('SessionStart');

    const [lineA] = spoolEnvelopes(a);
    const [lineB] = spoolEnvelopes(b);
    expect(spoolEnvelopes(a)).toHaveLength(1);
    expect(spoolEnvelopes(b)).toHaveLength(1);
    expect(lineA?.instance_id).toBe(a.instanceId);
    expect(lineB?.instance_id).toBe(b.instanceId);
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(lineA?.event_uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(lineA?.event_uid).toBe(lineB?.event_uid);

    // each instance committed its own copy
    await waitFor(async () => (await timelineEvents(runningA.port, SESSION_A)) === 1, {
      what: 'instance A to commit its line',
      timeoutMs: 30_000,
    });
    await waitFor(async () => (await timelineEvents(runningB.port, SESSION_A)) === 1, {
      what: 'instance B to commit its line',
      timeoutMs: 30_000,
    });
  }, 180_000);

  it('with two live instances an event of the folder of A reaches A only, and one of the folder of B reaches B only', async () => {
    const { a, b } = await twoWorkspaces();
    const dirA = transcriptsFolder(a.env, 'a');
    const dirB = transcriptsFolder(b.env, 'b');
    enableHooks(a);
    enableHooks(b);
    await watchTranscriptsIn(a, dirA);
    await watchTranscriptsIn(b, dirB);
    const runningA = await a.start();
    const runningB = await b.start();
    const mcsHome = a.env['MCS_HOME'] ?? '';
    expectRoute(mcsHome, runningA, dirA);
    expectRoute(mcsHome, runningB, dirB);
    const sourceA = hookSource(a.env, dirA, SESSION_A);
    const sourceB = hookSource(b.env, dirB, SESSION_B);

    await sourceA.fire('SessionStart');
    expect(spoolEnvelopes(a).map((e) => e.instance_id)).toEqual([a.instanceId]);
    expect(spoolEnvelopes(b)).toEqual([]);
    expect(existsSync(join(b.dir, 'data', 'spool'))).toBe(false);
    await waitFor(async () => (await timelineEvents(runningA.port, SESSION_A)) === 1, {
      what: 'instance A to commit the event of its folder',
      timeoutMs: 30_000,
    });
    expect(await timelineEvents(runningB.port, SESSION_A)).toBe(0);

    await sourceB.fire('SessionStart');
    expect(spoolEnvelopes(b).map((e) => e.instance_id)).toEqual([b.instanceId]);
    expect(spoolEnvelopes(a)).toHaveLength(1);
    await waitFor(async () => (await timelineEvents(runningB.port, SESSION_B)) === 1, {
      what: 'instance B to commit the event of its folder',
      timeoutMs: 30_000,
    });
    expect(await timelineEvents(runningA.port, SESSION_A)).toBe(1);
    // a second event of A still stays with A, and the two lines of A are two events
    await sourceA.fire('UserPromptSubmit');
    await waitFor(async () => (await timelineEvents(runningA.port, SESSION_A)) === 2, {
      what: 'instance A to commit its second line',
      timeoutMs: 30_000,
    });
    expect(spoolEnvelopes(b)).toHaveLength(1);
    expect(await timelineEvents(runningB.port, SESSION_B)).toBe(1);
  }, 180_000);

  it('an event of a folder that nobody watches, and an event for an instance whose hooks are off, are written nowhere', async () => {
    const { a, b } = await twoWorkspaces();
    const dirA = transcriptsFolder(a.env, 'a');
    const dirB = transcriptsFolder(b.env, 'b');
    enableHooks(a);
    // B keeps hooks.enabled = false, the creation default
    await watchTranscriptsIn(a, dirA);
    await watchTranscriptsIn(b, dirB);
    const runningA = await a.start();
    const runningB = await b.start();
    const mcsHome = a.env['MCS_HOME'] ?? '';
    expectRoute(mcsHome, runningA, dirA);
    expect(readRouteFile(mcsHome, runningB.instanceId)).toMatchObject({ enabled: false });

    await hookSource(b.env, dirB, SESSION_B).fire('SessionStart');
    await hookSource(a.env, transcriptsFolder(a.env, 'elsewhere'), SESSION_A).fire('SessionStart');
    expect(spoolEnvelopes(a)).toEqual([]);
    expect(spoolEnvelopes(b)).toEqual([]);
    expect(existsSync(join(a.dir, 'data', 'spool'))).toBe(false);
    expect(existsSync(join(b.dir, 'data', 'spool'))).toBe(false);
    expect(await timelineEvents(runningA.port, SESSION_A)).toBe(0);
    expect(await timelineEvents(runningB.port, SESSION_B)).toBe(0);
  }, 180_000);
});
