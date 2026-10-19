// Lifecycle evidence of the attempts (06 3.10.7): which events a tick publishes, with which stamp, and when they go to the
// writer. The plan and the publication are tested on their own; the rest runs whole ticks over a real database with a stub writer.
import { describe, expect, it } from 'vitest';

import { withWriteTx } from '../../db/write.ts';
import { pathKey } from '../../platform/paths.ts';
import {
  BASE_MS,
  END_PATTERN,
  MINUTE,
  SCOPE,
  endLine,
  evidenceOf,
  startLine,
  stubWriter,
  uid,
  useAttemptsHarness,
  type AttemptsHarness,
} from '../../../test/fixtures/attempts-harness.ts';
import type { AttemptsState } from './ingest.ts';
import {
  closeEvidenceState,
  createEvidenceState,
  planEvidence,
  publishEvidence,
  stampEvents,
  type EvidencePlan,
  type EvidenceState,
} from './evidence.ts';
import { closeAttemptsState, createAttemptsState, tickAttempts } from './ingest.ts';

const harness = useAttemptsHarness();

// ---- runs seeded straight into the tables --------------------------------------------------------------------------------------

interface SeedRun {
  part?: string;
  startedAt: number;
  /** `undefined`: the run stays open. */
  end?: { at: number; exit: string; status: string; state: 'COMPLETED' | 'FAILED' | 'UNKNOWN' };
  session?: number;
  superseded?: boolean;
}

let offset = 0;

/** Inserts a run (and ends, supersedes or matches it as asked); returns its id. */
function seed(h: AttemptsHarness, sourceId: number, run: SeedRun): number {
  offset += 100;
  return withWriteTx(h.db, SCOPE, (tx) => {
    const id = h.store.insertRun(tx, {
      sourceId,
      generation: 1,
      startOffset: offset,
      part: run.part ?? 'A',
      nRaw: '1',
      model: null,
      effort: null,
      startedAt: run.startedAt,
      evidence: 'chain log: started, no END yet',
    });
    if (id === undefined) throw new Error('the seeded run already exists');
    if (run.end !== undefined) {
      h.store.endRun(tx, id, {
        endOffset: offset + 50,
        endedAt: run.end.at,
        exitRaw: run.end.exit,
        statusRaw: run.end.status,
        state: run.end.state,
        evidence: `chain log: exit=${run.end.exit} status=${run.end.status}`,
      });
    }
    if (run.superseded === true)
      h.store.supersedeRun(tx, id, 'chain log: a later START for part A superseded this attempt');
    if (run.session !== undefined) h.store.setMatch(tx, id, run.session, 1000);
    return id;
  });
}

function sourceOf(h: AttemptsHarness): number {
  return withWriteTx(h.db, SCOPE, (tx) =>
    h.store.saveSource(tx, {
      path: 'C:/x/chain.log',
      pathKey: 'c:/x/chain.log',
      generation: 1,
      ino: null,
      headLen: 0,
      headHash: 'h'.repeat(64),
      readOffset: 0,
      configSha256: 'c'.repeat(64),
    }),
  );
}

const PASS = { exit: '0', status: 'PASS', state: 'COMPLETED' } as const;
const FAIL = { exit: '1', status: 'FAIL', state: 'FAILED' } as const;

function plan(
  h: AttemptsHarness,
  input: { touched?: number[]; cleared?: number[]; published?: [number, number][] },
): EvidencePlan {
  return planEvidence(h.store, {
    touched: input.touched ?? [],
    cleared: input.cleared ?? [],
    uids: new Map(),
    published: new Map(input.published ?? []),
  });
}

describe('planEvidence', () => {
  it('names the ended run of a session, with the provider id and the end time of the run', () => {
    const h = harness();
    const source = sourceOf(h);
    const session = h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS });
    const run = seed(h, source, { startedAt: BASE_MS, end: { at: BASE_MS + 5 * MINUTE, ...PASS }, session });
    expect(plan(h, { touched: [session] })).toEqual({
      attempts: [
        {
          sessionUid: uid(1),
          sessionRowId: session,
          runId: run,
          state: 'COMPLETED',
          evidence: 'chain log: exit=0 status=PASS',
          endedAt: BASE_MS + 5 * MINUTE,
        },
      ],
      clears: [],
      published: new Map([[session, run]]),
    });
  });

  it('publishes nothing for an open run and nothing for a superseded one', () => {
    const h = harness();
    const source = sourceOf(h);
    const session = h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS });
    seed(h, source, { startedAt: BASE_MS, session });
    seed(h, source, { startedAt: BASE_MS + 1000, session, superseded: true });
    expect(plan(h, { touched: [session] })).toMatchObject({ attempts: [], clears: [] });
  });

  it('takes the run with the later START when the earlier START ended later', () => {
    const h = harness();
    const source = sourceOf(h);
    const session = h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS + 20_000 });
    seed(h, source, { startedAt: BASE_MS, end: { at: BASE_MS + 9 * MINUTE, ...PASS }, session });
    const later = seed(h, source, { startedAt: BASE_MS + 30_000, end: { at: BASE_MS + MINUTE, ...FAIL }, session });
    const got = plan(h, { touched: [session] });
    expect(got.attempts).toHaveLength(1);
    expect(got.attempts[0]).toMatchObject({ runId: later, state: 'FAILED', endedAt: BASE_MS + MINUTE });
  });

  it('does not publish the run again that this process published before, and publishes a new one', () => {
    const h = harness();
    const source = sourceOf(h);
    const session = h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS });
    const first = seed(h, source, { startedAt: BASE_MS, end: { at: BASE_MS + MINUTE, ...PASS }, session });
    expect(plan(h, { touched: [session], published: [[session, first]] })).toMatchObject({ attempts: [], clears: [] });
    const second = seed(h, source, {
      startedAt: BASE_MS + 10_000,
      end: { at: BASE_MS + 2 * MINUTE, ...FAIL },
      session,
    });
    const got = plan(h, { touched: [session], published: [[session, first]] });
    expect(got.attempts.map((a) => a.runId)).toEqual([second]);
  });

  it('retracts the evidence of a session of a rebuild that has none left, and publishes anew for one that has', () => {
    const h = harness();
    const source = sourceOf(h);
    const bare = h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS });
    const kept = h.addSession(uid(2), { label: 'step B', firstMs: BASE_MS });
    const run = seed(h, source, {
      part: 'B',
      startedAt: BASE_MS,
      end: { at: BASE_MS + MINUTE, ...PASS },
      session: kept,
    });
    // the memory still names run ids from before the rebuild: it is not trusted for a cleared session
    const got = plan(h, { cleared: [bare, kept], published: [[kept, run]] });
    expect(got.clears).toEqual([uid(1)]);
    expect(got.attempts.map((a) => a.sessionUid)).toEqual([uid(2)]);
    expect(got.published).toEqual(
      new Map<number, number | null>([
        [bare, null],
        [kept, run],
      ]),
    );
  });

  it('does not retract the evidence of a session that is only touched', () => {
    const h = harness();
    const session = h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS });
    expect(plan(h, { touched: [session] })).toMatchObject({ attempts: [], clears: [] });
  });

  it('leaves out a session that does not exist any more', () => {
    const h = harness();
    const source = sourceOf(h);
    const session = h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS });
    seed(h, source, { startedAt: BASE_MS, end: { at: BASE_MS + MINUTE, ...PASS }, session });
    expect(plan(h, { touched: [session + 1000], cleared: [session + 2000] })).toMatchObject({
      attempts: [],
      clears: [],
    });
  });

  it('uses the provider ids that the matching already knows', () => {
    const h = harness();
    const source = sourceOf(h);
    const session = h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS });
    seed(h, source, { startedAt: BASE_MS, end: { at: BASE_MS + MINUTE, ...PASS }, session });
    const got = planEvidence(
      {
        evidenceRun: (id) => h.store.evidenceRun(id),
        uidsByRowIds: () => {
          throw new Error('not needed');
        },
      },
      { touched: [session], cleared: [], uids: new Map([[session, uid(1)]]), published: new Map() },
    );
    expect(got.attempts).toHaveLength(1);
  });
});

// ---- the stamp and the batch ----------------------------------------------------------------------------------------------------

function attemptPlan(sessions: readonly [string, number][]): EvidencePlan {
  return {
    attempts: sessions.map(([sessionUid, runId]) => ({
      sessionUid,
      sessionRowId: runId,
      runId,
      state: 'COMPLETED' as const,
      evidence: 'chain log: exit=0 status=PASS',
      endedAt: BASE_MS + runId,
    })),
    clears: [],
    published: new Map(sessions.map(([, runId]) => [runId, runId])),
  };
}

function publishDeps(h: AttemptsHarness, state: EvidenceState, w = stubWriter()) {
  return { deps: { clock: h.clock, writer: w, state }, w };
}

describe('publishEvidence: the batch', () => {
  it('submits one batch of the source external with the events of the plan', () => {
    const h = harness();
    const { deps, w } = publishDeps(h, createEvidenceState());
    const taken = publishEvidence(
      deps,
      attemptPlan([
        [uid(2), 7],
        [uid(1), 3],
      ]),
      0,
    );
    expect(taken).toBe(2);
    expect(w.calls).toHaveLength(1);
    const batch = w.calls[0]?.batch;
    expect(batch).toMatchObject({ source: 'external', bytes: 0 });
    expect(batch?.items).toHaveLength(1);
    expect(batch?.items[0]).toMatchObject({ kind: 'external', rows: [] });
    // sorted by the provider id, one stamp for the whole batch
    expect(batch?.items[0]?.events).toEqual([
      {
        k: 'external.attempt',
        sessionId: uid(1),
        state: 'COMPLETED',
        evidence: 'chain log: exit=0 status=PASS',
        rowKey: 'attempt:3',
        endedAt: BASE_MS + 3,
        observedAt: BASE_MS + 1,
      },
      {
        k: 'external.attempt',
        sessionId: uid(2),
        state: 'COMPLETED',
        evidence: 'chain log: exit=0 status=PASS',
        rowKey: 'attempt:7',
        endedAt: BASE_MS + 7,
        observedAt: BASE_MS + 1,
      },
    ]);
  });

  it('puts the retractions before the evidence, each group in order of the provider id', () => {
    const events = stampEvents(
      {
        attempts: attemptPlan([[uid(1), 1]]).attempts,
        clears: [uid(5), uid(3)],
        published: new Map(),
      },
      99,
    );
    expect(evidenceOf(events).map((e) => [e.k, e.sessionId])).toEqual([
      ['external.attempt_cleared', uid(3)],
      ['external.attempt_cleared', uid(5)],
      ['external.attempt', uid(1)],
    ]);
    expect(events.every((e) => 'observedAt' in e && e.observedAt === 99)).toBe(true);
  });

  it('submits nothing and takes no stamp for an empty plan', () => {
    const h = harness();
    const state = createEvidenceState();
    const { deps, w } = publishDeps(h, state);
    expect(publishEvidence(deps, { attempts: [], clears: [], published: new Map() }, 0)).toBe(0);
    expect(w.calls).toEqual([]);
    expect(state.lastPublishAt).toBeNull();
  });

  it('remembers what it published, and forgets what it retracted', () => {
    const h = harness();
    const state = createEvidenceState();
    const { deps } = publishDeps(h, state);
    publishEvidence(deps, attemptPlan([[uid(1), 4]]), 0);
    expect(state.published).toEqual(new Map([[4, 4]]));
    publishEvidence(deps, { attempts: [], clears: [uid(1)], published: new Map([[4, null]]) }, 0);
    expect(state.published.size).toBe(0);
  });
});

describe('publishEvidence: the stamp', () => {
  function stampsOf(w: ReturnType<typeof stubWriter>): number[] {
    return evidenceOf(w.acceptedEvents()).map((e) => e.observedAt);
  }

  it('is strictly increasing, also while the clock stands still', () => {
    const h = harness();
    const { deps, w } = publishDeps(h, createEvidenceState());
    for (let i = 1; i <= 4; i += 1) publishEvidence(deps, attemptPlan([[uid(1), i]]), 0);
    expect(stampsOf(w)).toEqual([BASE_MS + 1, BASE_MS + 2, BASE_MS + 3, BASE_MS + 4]);
  });

  it('follows the clock when it moves forward', () => {
    const h = harness();
    const { deps, w } = publishDeps(h, createEvidenceState());
    publishEvidence(deps, attemptPlan([[uid(1), 1]]), 0);
    h.clock.advance(10_000);
    publishEvidence(deps, attemptPlan([[uid(1), 2]]), 0);
    expect(stampsOf(w)).toEqual([BASE_MS + 1, BASE_MS + 10_000]);
  });

  it('stays above the last stamp when the clock steps back by 5 s', () => {
    const h = harness();
    const { deps, w } = publishDeps(h, createEvidenceState());
    h.clock.advance(60_000);
    publishEvidence(deps, attemptPlan([[uid(1), 1]]), 0);
    h.clock.set(h.clock.now() - 5000);
    publishEvidence(deps, attemptPlan([[uid(1), 2]]), 0);
    h.clock.set(h.clock.now() - 5000);
    publishEvidence(deps, attemptPlan([[uid(1), 3]]), 0);
    const stamps = stampsOf(w);
    expect(stamps[1]).toBeGreaterThan(stamps[0] ?? 0);
    expect(stamps[2]).toBeGreaterThan(stamps[1] ?? 0);
  });

  it('stays above the stamps of an earlier process: the first stamp is above the update time of the source', () => {
    const h = harness();
    const first = publishDeps(h, createEvidenceState());
    publishEvidence(first.deps, attemptPlan([[uid(1), 1]]), 0);
    const before = stampsOf(first.w)[0] ?? 0;
    // the restart: a new process state, a clock that went back by 5 s, and the update time the last tick wrote
    const updatedAt = h.clock.now();
    h.clock.set(updatedAt - 5000);
    const second = publishDeps(h, createEvidenceState());
    publishEvidence(second.deps, attemptPlan([[uid(1), 2]]), updatedAt);
    expect(stampsOf(second.w)[0]).toBeGreaterThan(before);
  });
});

describe('publishEvidence: a writer that refuses', () => {
  it('keeps the batch, offers it again before a later one, and registers for the drain once', () => {
    const h = harness();
    const state = createEvidenceState();
    const { deps, w } = publishDeps(h, state);
    w.accept = false;
    expect(publishEvidence(deps, attemptPlan([[uid(1), 1]]), 0)).toBe(0);
    expect(publishEvidence(deps, attemptPlan([[uid(2), 2]]), 0)).toBe(0);
    expect(state.pending).toHaveLength(2);
    expect(w.drainListeners).toBe(1);
    // the queue has room again: the first batch goes first
    w.accept = true;
    w.calls.length = 0;
    w.fireDrain();
    expect(state.pending).toHaveLength(0);
    expect(evidenceOf(w.acceptedEvents()).map((e) => e.sessionId)).toEqual([uid(1), uid(2)]);
    const stamps = evidenceOf(w.acceptedEvents()).map((e) => e.observedAt);
    expect(stamps[1]).toBeGreaterThan(stamps[0] ?? 0);
  });

  it('offers the kept batch before the batch of the next tick', () => {
    const h = harness();
    const { deps, w } = publishDeps(h, createEvidenceState());
    w.accept = false;
    publishEvidence(deps, attemptPlan([[uid(1), 1]]), 0);
    w.accept = true;
    w.calls.length = 0;
    expect(publishEvidence(deps, attemptPlan([[uid(2), 2]]), 0)).toBe(2);
    expect(evidenceOf(w.acceptedEvents()).map((e) => e.sessionId)).toEqual([uid(1), uid(2)]);
  });

  it('stops at the first batch the writer refuses and keeps the rest in order', () => {
    const h = harness();
    const state = createEvidenceState();
    const { deps, w } = publishDeps(h, state);
    w.accept = false;
    publishEvidence(deps, attemptPlan([[uid(1), 1]]), 0);
    publishEvidence(deps, attemptPlan([[uid(2), 2]]), 0);
    publishEvidence(deps, attemptPlan([[uid(3), 3]]), 0);
    expect(state.pending).toHaveLength(3);
    w.fireDrain();
    expect(state.pending).toHaveLength(3);
  });

  it('merges many kept batches into one that keeps the latest event of each session', () => {
    const h = harness();
    const state = createEvidenceState();
    const { deps, w } = publishDeps(h, state);
    w.accept = false;
    for (let i = 1; i <= 12; i += 1) publishEvidence(deps, attemptPlan([[uid(i % 2 === 0 ? 2 : 1), i]]), 0);
    expect(state.pending.length).toBeLessThanOrEqual(8);
    w.accept = true;
    w.calls.length = 0;
    w.fireDrain();
    const events = evidenceOf(w.acceptedEvents());
    const latest = (sessionUid: string): string | undefined =>
      events.filter((e) => e.sessionId === sessionUid).at(-1)?.rowKey;
    expect(latest(uid(1))).toBe('attempt:11');
    expect(latest(uid(2))).toBe('attempt:12');
  });

  it('drops the batches, without throwing, when the writer is closed', () => {
    const h = harness();
    const state = createEvidenceState();
    const { deps, w } = publishDeps(h, state);
    w.accept = false;
    publishEvidence(deps, attemptPlan([[uid(1), 1]]), 0);
    w.closed = true;
    expect(publishEvidence(deps, attemptPlan([[uid(2), 2]]), 0)).toBe(0);
    expect(state.closed).toBe(true);
    expect(state.pending).toEqual([]);
    w.closed = false;
    w.calls.length = 0;
    expect(publishEvidence(deps, attemptPlan([[uid(3), 3]]), 0)).toBe(0);
    expect(w.calls).toEqual([]);
  });

  it('drops the kept batches at shutdown and takes no new one', () => {
    const h = harness();
    const state = createEvidenceState();
    const { deps, w } = publishDeps(h, state);
    w.accept = false;
    publishEvidence(deps, attemptPlan([[uid(1), 1]]), 0);
    closeEvidenceState(state);
    w.accept = true;
    w.calls.length = 0;
    w.fireDrain();
    expect(publishEvidence(deps, attemptPlan([[uid(2), 2]]), 0)).toBe(0);
    expect(w.calls).toEqual([]);
  });
});

// ---- whole ticks ----------------------------------------------------------------------------------------------------------------

async function tickWith(h: AttemptsHarness, state: AttemptsState, w: ReturnType<typeof stubWriter>) {
  return tickAttempts(h.context(), { writer: w, state });
}

/** A session `S1` (label `step A`) and a chain log whose part A started 5 s before it and ended after 5 minutes. */
function finishedPart(h: AttemptsHarness, exit = 0, status = 'PASS'): number {
  const session = h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS + 5000 });
  h.writeLog(`${startLine(BASE_MS, 'A')}\n${endLine(BASE_MS + 5 * MINUTE, 'A', exit, status)}\n`);
  return session;
}

describe('the tick: persist before publish', () => {
  it('submits strictly after the COMMIT of the attempts transaction', async () => {
    const h = harness();
    finishedPart(h);
    const w = stubWriter();
    const seen: { committed: number; reentrant: string }[] = [];
    w.onSubmit = () => {
      seen.push({
        // another connection sees the rows only once they are committed
        committed: h.committedRuns(),
        // no write transaction is open any more: a new one starts at once
        reentrant: withWriteTx(h.db, SCOPE, () => 'free'),
      });
    };
    const result = await tickWith(h, createAttemptsState(), w);
    expect(result).toMatchObject({ state: 'ok', rowsChanged: 3, eventsSubmitted: 1 });
    expect(seen).toEqual([{ committed: 1, reentrant: 'free' }]);
    expect(w.calls).toHaveLength(1);
  });

  it('submits nothing when the transaction throws, and the next tick reads the same bytes', async () => {
    const h = harness();
    finishedPart(h);
    const w = stubWriter();
    h.sql('ALTER TABLE attempt_runs RENAME TO attempt_runs_hidden');
    await expect(tickWith(h, createAttemptsState(), w)).rejects.toThrow();
    expect(w.calls).toEqual([]);
    // the rows, the source and its offset were rolled back together
    expect(h.store.getSource(pathKey(h.logFile))).toBeUndefined();
    h.sql('ALTER TABLE attempt_runs_hidden RENAME TO attempt_runs');
    const again = await tickWith(h, createAttemptsState(), w);
    expect(again).toMatchObject({ state: 'ok', rowsChanged: 3, eventsSubmitted: 1 });
    expect(evidenceOf(w.acceptedEvents())).toMatchObject([
      { k: 'external.attempt', sessionId: uid(1), state: 'COMPLETED' },
    ]);
  });
});

describe('the tick: which run is the evidence', () => {
  it('publishes the run with the later START when the earlier START ended later', async () => {
    const h = harness();
    h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS + 20_000 });
    h.writeLog(
      [
        startLine(BASE_MS, 'A'),
        endLine(BASE_MS + 9 * MINUTE, 'A', 0, 'PASS'),
        startLine(BASE_MS + 30_000, 'A'),
        endLine(BASE_MS + MINUTE, 'A', 1, 'FAIL'),
        '',
      ].join('\n'),
    );
    const w = stubWriter();
    await tickWith(h, createAttemptsState(), w);
    const events = w.acceptedEvents();
    expect(events).toHaveLength(1);
    const runs = h.store.latestRuns(10);
    const later = runs.find((r) => r.startedAt === BASE_MS + 30_000);
    expect(events[0]).toMatchObject({
      k: 'external.attempt',
      sessionId: uid(1),
      state: 'FAILED',
      rowKey: `attempt:${String(later?.id)}`,
      endedAt: BASE_MS + MINUTE,
    });
  });

  it('publishes nothing for a run that is still open, and the END that follows publishes once', async () => {
    const h = harness();
    h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS + 5000 });
    h.writeLog(`${startLine(BASE_MS, 'A')}\n`);
    const w = stubWriter();
    const state = createAttemptsState();
    await tickWith(h, state, w);
    expect(w.calls).toEqual([]);
    h.appendLog(`${endLine(BASE_MS + 2 * MINUTE, 'A', 0, 'PASS')}\n`);
    await tickWith(h, state, w);
    expect(evidenceOf(w.acceptedEvents())).toMatchObject([
      { k: 'external.attempt', sessionId: uid(1), state: 'COMPLETED' },
    ]);
    // a tick with nothing new publishes nothing more
    await tickWith(h, state, w);
    expect(w.acceptedEvents()).toHaveLength(1);
  });

  it('does not publish again when a new run starts for a session that already has evidence', async () => {
    const h = harness();
    finishedPart(h);
    const w = stubWriter();
    const state = createAttemptsState();
    await tickWith(h, state, w);
    expect(w.acceptedEvents()).toHaveLength(1);
    h.appendLog(`${startLine(BASE_MS + 10 * MINUTE, 'A', 2)}\n`);
    h.clock.advance(MINUTE);
    await tickWith(h, state, w);
    expect(w.acceptedEvents()).toHaveLength(1);
  });

  it('matches an END that came before its session existed, and publishes then', async () => {
    const h = harness();
    h.writeLog(`${startLine(BASE_MS, 'A')}\n${endLine(BASE_MS + MINUTE, 'A', 0, 'PASS')}\n`);
    const w = stubWriter();
    const state = createAttemptsState();
    await tickWith(h, state, w);
    expect(w.calls).toEqual([]);
    h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS + 4000 });
    h.clock.advance(2000);
    await tickWith(h, state, w);
    expect(evidenceOf(w.acceptedEvents())).toMatchObject([{ k: 'external.attempt', sessionId: uid(1) }]);
  });
});

describe('the tick: the stamp across ticks, restarts and clock steps', () => {
  it('is strictly increasing across a restart and a backward step of the clock of 5 s', async () => {
    const h = harness();
    h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS + 5000 });
    h.addSession(uid(2), { label: 'step B', firstMs: BASE_MS + 5000 });
    h.writeLog(`${startLine(BASE_MS, 'A')}\n${endLine(BASE_MS + MINUTE, 'A', 0, 'PASS')}\n`);
    const w = stubWriter();
    await tickWith(h, createAttemptsState(), w);
    h.appendLog(`${startLine(BASE_MS, 'B')}\n${endLine(BASE_MS + MINUTE, 'B', 0, 'PASS')}\n`);
    h.clock.set(h.clock.now() - 5000);
    // a new state is a new process
    await tickWith(h, createAttemptsState(), w);
    const stamps = evidenceOf(w.acceptedEvents()).map((e) => [e.sessionId, e.observedAt] as const);
    expect(stamps.map(([id]) => id)).toEqual([uid(1), uid(2)]);
    expect(stamps[1]?.[1]).toBeGreaterThan(stamps[0]?.[1] ?? 0);
  });

  it('is strictly increasing in one process when the clock steps back', async () => {
    const h = harness();
    h.addSession(uid(1), { label: 'step A', firstMs: BASE_MS + 5000 });
    h.addSession(uid(2), { label: 'step B', firstMs: BASE_MS + 5000 });
    h.writeLog(`${startLine(BASE_MS, 'A')}\n${endLine(BASE_MS + MINUTE, 'A', 0, 'PASS')}\n`);
    const w = stubWriter();
    const state = createAttemptsState();
    h.clock.advance(60_000);
    await tickWith(h, state, w);
    h.appendLog(`${startLine(BASE_MS, 'B')}\n${endLine(BASE_MS + MINUTE, 'B', 0, 'PASS')}\n`);
    h.clock.set(h.clock.now() - 5000);
    await tickWith(h, state, w);
    const stamps = evidenceOf(w.acceptedEvents()).map((e) => e.observedAt);
    expect(stamps).toHaveLength(2);
    expect(stamps[1]).toBeGreaterThan(stamps[0] ?? 0);
  });
});

describe('the tick: a changed configuration', () => {
  it('gives a session that is cleared and evidenced again in the same tick only the new evidence', async () => {
    const h = harness();
    finishedPart(h);
    const w = stubWriter();
    const state = createAttemptsState();
    await tickWith(h, state, w);
    const first = evidenceOf(w.acceptedEvents());
    expect(first).toHaveLength(1);
    // the same lines under an equivalent pattern: the rows are rebuilt and matched again
    h.config.end = `${END_PATTERN}.*`;
    h.clock.advance(MINUTE);
    const result = await tickWith(h, state, w);
    const all = evidenceOf(w.acceptedEvents());
    expect(all.map((e) => e.k)).toEqual(['external.attempt', 'external.attempt']);
    expect(result.eventsSubmitted).toBe(1);
    expect(all[1]?.observedAt).toBeGreaterThan(all[0]?.observedAt ?? 0);
  });

  it('retracts the evidence of a session that the new configuration no longer matches, and a later tick evidences it with a later stamp', async () => {
    const h = harness();
    finishedPart(h);
    const w = stubWriter();
    const state = createAttemptsState();
    await tickWith(h, state, w);
    // another prefix: the same runs exist but belong to no session
    h.config.labelPrefix = 'other ';
    h.clock.advance(MINUTE);
    await tickWith(h, state, w);
    const afterClear = evidenceOf(w.acceptedEvents());
    expect(afterClear.map((e) => e.k)).toEqual(['external.attempt', 'external.attempt_cleared']);
    expect(afterClear[1]).toMatchObject({ sessionId: uid(1) });
    expect(h.store.latestRuns(10).every((r) => r.sessionRowId === null)).toBe(true);
    // back to the first configuration: the rows are rebuilt once more and matched again
    h.config.labelPrefix = 'step ';
    h.clock.advance(MINUTE);
    await tickWith(h, state, w);
    const all = evidenceOf(w.acceptedEvents());
    expect(all.map((e) => e.k)).toEqual(['external.attempt', 'external.attempt_cleared', 'external.attempt']);
    expect(all[2]?.observedAt).toBeGreaterThan(all[1]?.observedAt ?? 0);
  });

  it('closing the state drops the batches that the writer did not take', async () => {
    const h = harness();
    finishedPart(h);
    const w = stubWriter();
    w.accept = false;
    const state = createAttemptsState();
    await tickWith(h, state, w);
    expect(state.evidence.pending).toHaveLength(1);
    closeAttemptsState(state);
    w.accept = true;
    w.calls.length = 0;
    const result = await tickWith(h, state, w);
    expect(w.calls).toEqual([]);
    expect(result.eventsSubmitted).toBe(0);
  });
});
