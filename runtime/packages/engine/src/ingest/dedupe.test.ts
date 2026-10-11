// Dedupe rules D-1 to D-4 (02 4.4) over a real database: the verdict of `judgeHookRow` and the silent outcomes of the insert.
import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { EventsRepo } from '../db/repos/events.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { withWriteTx } from '../db/write.ts';
import {
  CONTENT_WINDOW_MS,
  emptyDuplicateCounts,
  judgeHookRow,
  layerOfSilentInsert,
  totalDuplicates,
} from './dedupe.ts';
import { INGEST_ERROR_CODES, ingestError, isIngestErrorCode } from './errors.ts';
import { eventRow, toolCallKey, toolEndKey, type EventRowWrite } from './event-row.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const SESSION = '22222222-2222-4222-8222-222222222222';
const T0 = FIXTURE_EPOCH_MS;
const HASH = '0123456789abcdef0123456789abcdef';

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function setup(): { db: InstanceDb; events: EventsRepo } {
  const db = openInstanceDb({
    path: join(tempDir('dedupe').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  withWriteTx(db, CTX, (tx) =>
    new SessionsRepo(db).ensure(CTX, tx, { sessionUid: SESSION, projectId: null, startedAt: T0 }),
  );
  return { db, events: new EventsRepo(db) };
}

function hookRow(over: Partial<Parameters<typeof eventRow>[0]> = {}): EventRowWrite {
  return eventRow({
    sessionUid: SESSION,
    agentUid: 'main',
    kind: 'tool.call',
    sources: 1,
    stamp: { at: T0, rank: 20, tie: 'uid-1' },
    tsSource: 'hook_received',
    receivedAt: T0,
    eventUid: '33333333-3333-4333-8333-333333333331',
    hookEvent: 'PreToolUse',
    contentHash: HASH,
    ...over,
  });
}

function insert(db: InstanceDb, events: EventsRepo, row: EventRowWrite) {
  return withWriteTx(db, CTX, (tx) => events.insert(CTX, tx, row));
}

describe('D-1 event_uid (a spool line read twice)', () => {
  it('writes nothing for a second insert of the same envelope', () => {
    const { db, events } = setup();
    const row = hookRow({ kind: 'notification.sent', hookEvent: 'Notification' });
    expect(insert(db, events, row).outcome).toBe('inserted');
    expect(insert(db, events, row)).toEqual({ outcome: 'duplicate', occurrence: false });
    expect(layerOfSilentInsert(row)).toBe('D-1');
  });
});

describe('D-2 natural key (the same hook registered twice)', () => {
  it('judges a second hook delivery of a tool call a duplicate, however far apart', () => {
    const { db, events } = setup();
    const first = hookRow({ naturalKey: toolCallKey('toolu_1'), toolUseId: 'toolu_1' });
    expect(judgeHookRow(events, CTX, first)).toEqual({ verdict: 'insert' });
    insert(db, events, first);
    const second = hookRow({
      naturalKey: toolCallKey('toolu_1'),
      toolUseId: 'toolu_1',
      eventUid: '33333333-3333-4333-8333-333333333332',
      receivedAt: T0 + 3_600_000,
    });
    const verdict = judgeHookRow(events, CTX, second);
    expect(verdict).toMatchObject({ verdict: 'duplicate', layer: 'D-2' });
  });

  it('lets a hook row merge into a transcript-only row of the same natural key', () => {
    const { db, events } = setup();
    insert(
      db,
      events,
      eventRow({
        sessionUid: SESSION,
        agentUid: 'main',
        kind: 'tool.result',
        sources: 2,
        stamp: { at: T0, rank: 30, tie: 'rec' },
        tsSource: 'record',
        receivedAt: T0,
        naturalKey: toolEndKey('toolu_2'),
        recordUuid: 'rec-2',
      }),
    );
    const hook = hookRow({
      kind: 'tool.result',
      hookEvent: 'PostToolUse',
      naturalKey: toolEndKey('toolu_2'),
      eventUid: '33333333-3333-4333-8333-333333333333',
    });
    expect(judgeHookRow(events, CTX, hook)).toEqual({ verdict: 'insert' });
    expect(insert(db, events, hook).outcome).toBe('merged');
  });
});

describe('D-3 content window (duplicate registration of an event without ids)', () => {
  it('judges a delivery 30 ms later with the same hash a duplicate, 3 s later not', () => {
    const { db, events } = setup();
    const base = { kind: 'notification.sent' as const, hookEvent: 'Notification' };
    insert(db, events, hookRow(base));
    const near = hookRow({ ...base, eventUid: '33333333-3333-4333-8333-333333333334', receivedAt: T0 + 30 });
    expect(judgeHookRow(events, CTX, near)).toMatchObject({ verdict: 'duplicate', layer: 'D-3' });
    const far = hookRow({
      ...base,
      eventUid: '33333333-3333-4333-8333-333333333335',
      receivedAt: T0 + CONTENT_WINDOW_MS + 1000,
    });
    expect(judgeHookRow(events, CTX, far)).toEqual({ verdict: 'insert' });
  });

  it('is keyed by the hook event and the hash: another event or another hash is no duplicate', () => {
    const { db, events } = setup();
    insert(db, events, hookRow({ kind: 'notification.sent', hookEvent: 'Notification' }));
    const otherEvent = hookRow({
      hookEvent: 'Stop',
      kind: 'turn.stop',
      eventUid: '33333333-3333-4333-8333-333333333336',
    });
    expect(judgeHookRow(events, CTX, otherEvent)).toEqual({ verdict: 'insert' });
    const otherHash = hookRow({
      kind: 'notification.sent',
      hookEvent: 'Notification',
      contentHash: 'f'.repeat(32),
      eventUid: '33333333-3333-4333-8333-333333333337',
    });
    expect(judgeHookRow(events, CTX, otherHash)).toEqual({ verdict: 'insert' });
  });

  it('never judges a transcript row', () => {
    const { db, events } = setup();
    insert(db, events, hookRow({ kind: 'notification.sent', hookEvent: 'Notification' }));
    const record = hookRow({ sources: 2, kind: 'notification.sent', hookEvent: 'Notification', eventUid: null });
    expect(judgeHookRow(events, CTX, record)).toEqual({ verdict: 'insert' });
  });
});

describe('D-4 record uuid (a transcript record read twice)', () => {
  it('writes nothing for a second insert of the same record and names the layer', () => {
    const { db, events } = setup();
    const row = eventRow({
      sessionUid: SESSION,
      agentUid: 'main',
      kind: 'prompt.submit',
      sources: 2,
      stamp: { at: T0, rank: 10, tie: 'r' },
      tsSource: 'record',
      receivedAt: T0,
      recordUuid: 'rec-uuid-1',
    });
    expect(insert(db, events, row).outcome).toBe('inserted');
    expect(insert(db, events, row)).toEqual({ outcome: 'duplicate', occurrence: false });
    expect(layerOfSilentInsert(row)).toBe('D-4');
  });
});

describe('duplicate counters', () => {
  it('adds the layers', () => {
    const counts = emptyDuplicateCounts();
    counts['D-2'] += 2;
    counts['D-1'] += 1;
    expect(totalDuplicates(counts)).toBe(3);
  });
});

describe('ingest error codes (98 7.5)', () => {
  it('knows the 17 codes of 02 4.8 plus SPOOL_SEGMENT_NOT_FOUND', () => {
    expect(INGEST_ERROR_CODES).toHaveLength(18);
    expect(isIngestErrorCode('ENVELOPE_SCHEMA')).toBe(true);
    expect(isIngestErrorCode('envelope_schema')).toBe(false);
    expect(isIngestErrorCode('ROUTE_INVALID')).toBe(false);
  });

  it('cuts the detail to the 200 code points of the column', () => {
    const record = ingestError('ENVELOPE_SCHEMA', 'spool', {
      segment: 'hooks-20260101T00Z.ndjson',
      detail: 'x'.repeat(500),
    });
    expect(Array.from(record.detail ?? '')).toHaveLength(200);
    expect(record).toMatchObject({ code: 'ENVELOPE_SCHEMA', source: 'spool' });
  });
});
