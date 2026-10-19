// Restarting or killing instance A never harms instance B (01 3.5 brief 4): T-ISO-16 (five restarts of A while both instances
// ingest) and T-ISO-17 (a force kill of A during ingestion, then a start). Both instances are real processes of the built
// runtime. While they run, the real hook handler appends notifications to the spool of each as fast as it can, and (T-ISO-17) a
// transcript of A grows. At the end every count is exact: the lines appended to a spool are the notification events of its
// database, no event is stored twice, the SQLite integrity check says `ok` for both files, and B keeps its process.
import { forceKill, pidAlive, waitForExit } from '@mcs/engine';
import { assertPortClosed, waitFor } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { twoWorkspaces, type RunningInstance } from './_setup.ts';
import {
  GrowingTranscript,
  countNotifications,
  enableHooks,
  forward,
  hookSource,
  inspectDatabase,
  startFeeder,
  tokenTotals,
  transcriptsFolder,
  watchTranscriptsIn,
  type HookSource,
} from './_hooks.ts';

const SESSION_A = 'a0a0a0a0-0000-4000-8000-00000000000a';
const SESSION_B = 'b0b0b0b0-0000-4000-8000-00000000000b';

interface Pair {
  readonly a: RunningInstance;
  readonly b: RunningInstance;
  readonly sourceA: HookSource;
  readonly sourceB: HookSource;
  readonly dirA: string;
}

/** Two running instances with hooks on, each watching a folder of its own, and a hook source for each. */
async function startedPair(): Promise<Pair> {
  const { a, b } = await twoWorkspaces();
  const dirA = transcriptsFolder(a.env, 'a');
  const dirB = transcriptsFolder(b.env, 'b');
  for (const [ws, dir] of [
    [a, dirA],
    [b, dirB],
  ] as const) {
    enableHooks(ws);
    await watchTranscriptsIn(ws, dir);
  }
  return {
    a: await a.start(),
    b: await b.start(),
    sourceA: hookSource(a.env, dirA, SESSION_A),
    sourceB: hookSource(b.env, dirB, SESSION_B),
    dirA,
  };
}

/** B kept its process, its port and its identity. */
async function expectBUntouched(b: RunningInstance): Promise<void> {
  expect(pidAlive(b.pid)).toBe(true);
  expect(b.readState()?.pid).toBe(b.pid);
  expect(await b.health(b.port)).toEqual({ status: 200, instanceId: b.instanceId });
}

/** Waits until the database of the workspace holds `expected` notification events (an instance may still be writing it). */
function untilNotifications(ws: { dbPath: string; slug: string }, expected: number): Promise<number> {
  return waitFor(() => countNotifications(ws.dbPath) === expected, {
    what: `${String(expected)} notification events in the database of ${ws.slug}`,
    timeoutMs: 60_000,
    intervalMs: 200,
  }).then(() => expected);
}

/** After both instances stopped: integrity ok, every appended line stored once. */
function expectExactAndIntact(ws: { dbPath: string; slug: string }, sent: number): void {
  const facts = inspectDatabase(ws.dbPath);
  expect(facts.integrity, `integrity_check of ${ws.slug}`).toBe('ok');
  expect(facts.notifications, `notification events of ${ws.slug}`).toBe(sent);
  expect(facts.hookEvents, `events with an envelope in ${ws.slug}`).toBe(sent);
  expect(facts.distinctEventUids, `distinct event uids of ${ws.slug}`).toBe(facts.hookEvents);
}

describe('restart isolation (T-ISO-16, T-ISO-17)', () => {
  it('T-ISO-16 five restarts of A while both ingest: B keeps its process and every line, and both databases are intact', async () => {
    const { a, b, sourceA, sourceB } = await startedPair();
    const feeder = startFeeder([sourceA, sourceB]);
    for (let round = 1; round <= 5; round += 1) {
      const stopped = await a.stopRaw();
      expect(stopped.code, `stop ${String(round)}: ${stopped.stderr}`).toBe(0);
      await assertPortClosed(a.port);
      await expectBUntouched(b);
      const started = await a.startRaw();
      expect(started.code, `start ${String(round)}: ${started.stderr}`).toBe(0);
      await expectBUntouched(b);
    }
    const [sentA = 0, sentB = 0] = await feeder.stop();
    expect(sentA).toBeGreaterThan(0);
    expect(sentB).toBeGreaterThan(0);
    // the lines that A received while it was down are read at its next start: nothing is lost and nothing is stored twice
    await untilNotifications(b, sentB);
    await untilNotifications(a, sentA);
    await expectBUntouched(b);

    const stoppedA = await a.stopRaw();
    expect(stoppedA.code, stoppedA.stderr).toBe(0);
    await b.handle.stop();
    expectExactAndIntact(a, sentA);
    expectExactAndIntact(b, sentB);
  }, 420_000);

  it('T-ISO-17 a force kill of A during ingestion, then a start: A is intact and keeps its token totals, B is unaffected', async () => {
    const { a, b, sourceA, sourceB, dirA } = await startedPair();
    const grown = new GrowingTranscript(dirA, SESSION_A, forward(dirA), Date.now() - 10 * 60_000);
    for (let i = 0; i < 3; i += 1) grown.turn();
    const feeder = startFeeder([sourceA, sourceB]);
    // A is ingesting a transcript and a spool at the same time
    grown.turn();
    grown.turn();
    await waitFor(async () => (await tokenTotals(a.port)).output === grown.expected().output, {
      what: 'the five turns of A in its token totals',
      timeoutMs: 60_000,
      intervalMs: 200,
    });
    expect(await tokenTotals(a.port)).toEqual(grown.expected());

    grown.turn();
    await forceKill(a.pid);
    expect(await waitForExit(a.pid, 15_000)).toBe(true);
    await assertPortClosed(a.port);
    await expectBUntouched(b);
    // activity goes on while A is dead: its transcript grows and the handler keeps appending to its spool
    grown.turn();
    grown.turn();

    const started = await a.startRaw();
    expect(started.code, started.stderr).toBe(0);
    await expectBUntouched(b);
    const [sentA = 0, sentB = 0] = await feeder.stop();
    expect(sentA).toBeGreaterThan(0);
    expect(sentB).toBeGreaterThan(0);

    // every turn is counted once: not lost with the kill, not counted again after the restart
    expect(grown.turns).toBe(8);
    await waitFor(async () => (await tokenTotals(a.port)).output === grown.expected().output, {
      what: 'the eight turns of A in its token totals after the restart',
      timeoutMs: 60_000,
      intervalMs: 200,
    });
    await untilNotifications(a, sentA);
    await untilNotifications(b, sentB);
    expect(await tokenTotals(a.port)).toEqual(grown.expected());
    await expectBUntouched(b);

    const stoppedA = await a.stopRaw();
    expect(stoppedA.code, stoppedA.stderr).toBe(0);
    await b.handle.stop();
    expect(a.readState()).toBeNull();
    expectExactAndIntact(a, sentA);
    expectExactAndIntact(b, sentB);
  }, 420_000);
});
