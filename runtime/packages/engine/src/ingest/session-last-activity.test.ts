// The last activity of a session over a real database (CAW-147; UI review R-36, N-4): `sessions.last_activity_at` is the newest
// activity of the session and of its agents and never earlier than a stored record or hook event of the session, whatever the
// order in which the files arrive. The time of the ingest itself and the notes of the monitor never count. The same rule over
// the real service and a synthetic Claude home is in `test/session-last-activity.int.test.ts`.
import { join } from 'node:path';

import type { EventKind } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import {
  FIXTURE_INSTANCE_ID,
  FIXTURE_SESSION_ID,
  SEQUENCE_START,
  labSequence,
} from '../../test/fixtures/hook-sequences.ts';
import { eventRow, type LogicalEvent } from './event-row.ts';
import { createIngestWriter, envelopeItem, type IngestItem, type IngestWriterHandle } from './writer.ts';

const tempDir = useTempDirs();
const CTX = { instanceId: FIXTURE_INSTANCE_ID };
const T = SEQUENCE_START;
/** The clock of the writer: every record of these tests is at least nine minutes older, so an ingest time is easy to tell. */
const NOW = T + 10 * 60_000;
const HELPER = 'a0123456789abcdef';
const SECOND_HELPER = 'b0123456789abcdef';
const NESTED_HELPER = 'c0123456789abcdef';

interface Rig {
  readonly db: InstanceDb;
  readonly clock: FakeClock;
  readonly writer: IngestWriterHandle;
}

const dbs: InstanceDb[] = [];
const writers: IngestWriterHandle[] = [];
afterEach(async () => {
  for (const writer of writers.splice(0)) await writer.close();
  for (const db of dbs.splice(0)) db.close();
});

function rig(): Rig {
  const clock = new FakeClock(NOW);
  const db = openInstanceDb({
    path: join(tempDir('last-activity').path, 'monitor.db'),
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  dbs.push(db);
  const writer = createIngestWriter({ db, scope: CTX, retryBaseMs: 1, retryMaxMs: 2, sleep: () => Promise.resolve() });
  writers.push(writer);
  return { db, clock, writer };
}

/** One transaction: the items of one transcript batch, in the given order. */
async function transcript(r: Rig, ...items: IngestItem[]): Promise<void> {
  expect(r.writer.submit({ source: 'transcript', items, bytes: 10 })).toBe(true);
  await r.writer.flushNow();
}

/** A conversational record of the main agent (`agentUid` null) or of a subagent: its timeline row and its activity event. */
function record(agentUid: string | null, kind: EventKind, key: string, at: number): IngestItem {
  const stamp = { at, rank: 20, tie: key };
  return {
    kind: 'record',
    events: [{ k: 'activity', sessionId: FIXTURE_SESSION_ID, agentId: agentUid, stamp, via: 'assistant' }],
    rows: [
      {
        t: 'event',
        row: eventRow({
          sessionUid: FIXTURE_SESSION_ID,
          agentUid,
          kind,
          sources: 2,
          stamp,
          tsSource: 'record',
          receivedAt: at,
          recordUuid: key,
        }),
      },
    ],
  };
}

/** The `system/turn_duration` record that closes a turn: a timeline row and a turn end, but no activity event. */
function turnDuration(agentUid: string | null, key: string, at: number): IngestItem {
  const stamp = { at, rank: 61, tie: key };
  const end: LogicalEvent = {
    k: 'turn.end',
    sessionId: FIXTURE_SESSION_ID,
    agentId: agentUid,
    promptId: null,
    stamp,
    kind: 'turn_duration',
  };
  return {
    kind: 'record',
    events: [end],
    rows: [
      {
        t: 'event',
        row: eventRow({
          sessionUid: FIXTURE_SESSION_ID,
          agentUid,
          kind: 'turn.duration',
          sources: 2,
          stamp,
          tsSource: 'record',
          receivedAt: at,
          recordUuid: key,
        }),
      },
    ],
  };
}

/** What the importer sends ahead of the first records of an agent file: it carries no time of its own. */
function meta(agentUid: string): IngestItem {
  return { kind: 'record', events: [{ k: 'agent.meta', sessionId: FIXTURE_SESSION_ID, agentId: agentUid }], rows: [] };
}

/** The parent file: two records, the last one at `T + 2 s`. */
const parentFile = (): IngestItem[] => [
  record(null, 'prompt.submit', 'u-main-1', T + 1000),
  record(null, 'assistant.message', 'a-main-1', T + 2000),
];

/** The file of a subagent that is still writing a minute after the last record of its parent: its last record at `T + 61 s`. */
const helperFile = (): IngestItem[] => [
  meta(HELPER),
  record(HELPER, 'prompt.submit', 'u-sub-1', T + 60_000),
  record(HELPER, 'assistant.message', 'a-sub-1', T + 61_000),
];

interface Times {
  readonly started: number;
  readonly last: number;
  readonly mainLast: number;
  /** The newest record or hook event of the session (the notes of the monitor are not activity). */
  readonly newestEvent: number;
}

function timesOf(db: InstanceDb): Times {
  const row = db.driver
    .prepare<Times>(
      `SELECT s.started_at AS started, s.last_activity_at AS last,
              (SELECT a.last_activity_at FROM agents a WHERE a.session_id = s.id AND a.agent_uid = 'main') AS mainLast,
              coalesce((SELECT max(e.ts) FROM events e WHERE e.session_id = s.id AND (e.sources & 3) != 0), 0) AS newestEvent
         FROM sessions s WHERE s.session_uid = ?`,
    )
    .get([FIXTURE_SESSION_ID]);
  if (row === undefined) throw new Error('the session of the test has no row');
  return row;
}

function setLastActivity(db: InstanceDb, at: number): void {
  db.driver.prepare('UPDATE sessions SET last_activity_at = :at WHERE session_uid = :uid').run({
    at,
    uid: FIXTURE_SESSION_ID,
  });
}

/** What the sweeper submits for a session that is due: no event, only a new derivation. */
async function sweep(r: Rig): Promise<void> {
  expect(
    r.writer.submit({
      source: 'sweeper',
      items: [{ kind: 'derive', events: [], rows: [], derive: { sessionId: FIXTURE_SESSION_ID } }],
      bytes: 1,
    }),
  ).toBe(true);
  await r.writer.flushNow();
}

describe('the last activity of a session includes its subagents, in every order of arrival (CAW-147, R-36)', () => {
  const orders: readonly (readonly [string, () => IngestItem[][]])[] = [
    ['the parent file first, the subagent file in a later transaction', () => [parentFile(), helperFile()]],
    ['the subagent file first, the parent file in a later transaction', () => [helperFile(), parentFile()]],
    ['both files in one transaction, the parent first', () => [[...parentFile(), ...helperFile()]]],
    ['both files in one transaction, the subagent first', () => [[...helperFile(), ...parentFile()]]],
    [
      'the meta of the subagent alone, then its records, then the parent',
      () => [[meta(HELPER)], helperFile(), parentFile()],
    ],
    [
      'record by record, the newest record of the subagent before everything else',
      () => [
        [meta(HELPER), record(HELPER, 'assistant.message', 'a-sub-1', T + 61_000)],
        [record(null, 'assistant.message', 'a-main-1', T + 2000)],
        [record(HELPER, 'prompt.submit', 'u-sub-1', T + 60_000)],
        [record(null, 'prompt.submit', 'u-main-1', T + 1000)],
      ],
    ],
  ];

  it.each(orders)('is the newest record of the subagent: %s', async (_name, batches) => {
    const r = rig();
    for (const batch of batches()) await transcript(r, ...batch);
    const times = timesOf(r.db);
    // neither the last record of the parent (T + 2 s) nor the time of the ingest (T + 10 min)
    expect(times.last - T).toBe(61_000);
    expect(times.last).toBe(times.newestEvent);
    expect(times.mainLast).toBe(times.last);
    expect(times.started - T).toBe(1000);
  });

  it('stays at the last record of the parent when every subagent is older', async () => {
    const r = rig();
    await transcript(
      r,
      meta(HELPER),
      record(HELPER, 'prompt.submit', 'u-sub-1', T + 1500),
      record(HELPER, 'assistant.message', 'a-sub-1', T + 1800),
    );
    await transcript(r, ...parentFile());
    expect(timesOf(r.db).last - T).toBe(2000);
  });

  it('takes the newest of two subagents and of a subagent of a subagent', async () => {
    const r = rig();
    await transcript(r, ...parentFile());
    await transcript(r, meta(SECOND_HELPER), record(SECOND_HELPER, 'assistant.message', 'a-second-1', T + 90_000));
    expect(timesOf(r.db).last - T).toBe(90_000);
    await transcript(r, ...helperFile());
    expect(timesOf(r.db).last - T).toBe(90_000);
    await transcript(r, meta(NESTED_HELPER), record(NESTED_HELPER, 'tool.call', 'a-nested-1', T + 120_000));
    const times = timesOf(r.db);
    expect(times.last - T).toBe(120_000);
    expect(times.last).toBe(times.newestEvent);
  });
});

describe('the last activity of a session is never earlier than one of its stored records (CAW-147, R-36)', () => {
  it('includes the record that closes the turn of the main agent', async () => {
    const r = rig();
    await transcript(r, ...parentFile(), turnDuration(null, 's-main-1', T + 3000));
    const times = timesOf(r.db);
    expect(times.last - T).toBe(3000);
    expect(times.last).toBe(times.newestEvent);
  });

  it('includes the record that closes the turn of a subagent', async () => {
    const r = rig();
    await transcript(r, ...parentFile());
    await transcript(r, ...helperFile(), turnDuration(HELPER, 's-sub-1', T + 62_000));
    const times = timesOf(r.db);
    expect(times.last - T).toBe(62_000);
    expect(times.last).toBe(times.newestEvent);
  });

  it('includes the activity of a subagent that left no timeline row, also after a restart', async () => {
    const r = rig();
    await transcript(r, ...parentFile());
    const stamp = { at: T + 70_000, rank: 10, tie: 'u-sub-meta' };
    // a record that is activity but has no row of its own (a meta record of the user side)
    await transcript(r, meta(HELPER), {
      kind: 'record',
      events: [{ k: 'activity', sessionId: FIXTURE_SESSION_ID, agentId: HELPER, stamp, via: 'user' }],
      rows: [],
    });
    expect(timesOf(r.db).newestEvent - T).toBe(2000);
    expect(timesOf(r.db).last - T).toBe(70_000);
    // a writer without cached facts derives the same value from the stored facts of the agent
    await r.writer.close();
    const writer = createIngestWriter({
      db: r.db,
      scope: CTX,
      retryBaseMs: 1,
      retryMaxMs: 2,
      sleep: () => Promise.resolve(),
    });
    writers.push(writer);
    await sweep({ ...r, writer });
    expect(timesOf(r.db).last - T).toBe(70_000);
  });

  it('includes a hook event that is the only late thing of the session, also the hook of a subagent', async () => {
    const r = rig();
    await transcript(r, ...parentFile());
    const hooks = labSequence({ startAt: T + 30_000 });
    expect(
      r.writer.submit({
        source: 'spool',
        items: hooks.map((env, i) => envelopeItem(env, { segment: 'seg', offset: i })),
        bytes: 10,
      }),
    ).toBe(true);
    await r.writer.flushNow();
    const times = timesOf(r.db);
    expect(times.last - T).toBe(30_000 + (hooks.length - 1) * 1000);
    expect(times.last).toBe(times.newestEvent);
  });
});

describe('what never counts as the last activity of a session (CAW-147)', () => {
  it('a note of the monitor with a later time does not move it', async () => {
    const r = rig();
    await transcript(r, ...parentFile());
    await transcript(r, {
      kind: 'record',
      events: [],
      rows: [
        {
          t: 'reconciliation',
          sessionUid: FIXTURE_SESSION_ID,
          kind: 'copied_records',
          at: T + 5 * 60_000,
          detail: { reason: 'FIXTURE' },
        },
      ],
    });
    const noted = r.db.driver
      .prepare<{ n: number }>('SELECT count(*) AS n FROM events WHERE sources = 4 AND ts = ?')
      .get([T + 5 * 60_000]);
    expect(noted?.n).toBe(1);
    expect(timesOf(r.db).last - T).toBe(2000);
  });

  it('the time of the ingest does not stay when the first thing known of a session carries no time', async () => {
    const r = rig();
    // the meta file of a subagent is all there is: the row needs a time, and the only one is the clock
    await transcript(r, meta(HELPER));
    expect(timesOf(r.db).last).toBe(NOW);
    // the first record replaces it: the session is as old as its records say
    await transcript(r, record(HELPER, 'prompt.submit', 'u-sub-1', T + 60_000));
    const times = timesOf(r.db);
    expect(times.last - T).toBe(60_000);
    expect(times.started - T).toBe(60_000);
    expect(times.mainLast).toBe(times.last);
  });

  it('a new derivation moves nothing when the row is right', async () => {
    const r = rig();
    await transcript(r, ...parentFile());
    await transcript(r, ...helperFile());
    const before = timesOf(r.db);
    r.clock.advance(60 * 60_000);
    await sweep(r);
    expect(timesOf(r.db)).toEqual(before);
  });
});

describe('a row that an earlier version stored heals at the next derivation of its session (CAW-147)', () => {
  it('a last activity that ignored the subagent is raised by a sweep, with the facts in the cache', async () => {
    const r = rig();
    await transcript(r, ...parentFile());
    await transcript(r, ...helperFile());
    setLastActivity(r.db, T + 2000);
    await sweep(r);
    expect(timesOf(r.db).last - T).toBe(61_000);
    expect(timesOf(r.db).mainLast - T).toBe(61_000);
  });

  it('a last activity that ignored the subagent is raised by the next record, after a restart', async () => {
    const first = rig();
    await transcript(first, ...parentFile());
    await transcript(first, ...helperFile(), turnDuration(HELPER, 's-sub-1', T + 62_000));
    setLastActivity(first.db, T + 2000);
    // a second writer over the same database has no cached facts: it reads them from the rows
    await first.writer.close();
    const writer = createIngestWriter({
      db: first.db,
      scope: CTX,
      retryBaseMs: 1,
      retryMaxMs: 2,
      sleep: () => Promise.resolve(),
    });
    writers.push(writer);
    await transcript({ ...first, writer }, record(null, 'assistant.message', 'a-main-0', T + 1500));
    expect(timesOf(first.db).last - T).toBe(62_000);
  });

  it('a last activity that is the time of an old ingest comes down to the newest record', async () => {
    const r = rig();
    await transcript(r, ...parentFile());
    await transcript(r, ...helperFile());
    setLastActivity(r.db, NOW);
    await sweep(r);
    expect(timesOf(r.db).last - T).toBe(61_000);
  });
});
