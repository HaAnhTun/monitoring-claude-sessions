import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { SessionsRepo } from './sessions.ts';
import {
  cutOrNull,
  parseEvidence,
  patchRow,
  requireRef,
  requireTranscriptFile,
  rowLimit,
  viewFromRow,
  viewKeyChanged,
  type ViewDbRow,
  type ViewKeyRow,
} from './shared.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const T0 = FIXTURE_EPOCH_MS;
const UID = 'aaaaaaaa-0000-4000-8000-000000000001';
/** One astral character: two UTF-16 code units, one code point. */
const ASTRAL = String.fromCodePoint(0x1f600);

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('repo-shared').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  return db;
}

function addSession(db: InstanceDb): number {
  return withWriteTx(db, CTX, (tx) =>
    new SessionsRepo(db).ensure(CTX, tx, { sessionUid: UID, projectId: null, startedAt: T0 }),
  ).id;
}

function selectLabel(db: InstanceDb, id: number): { label: string; updatedSeq: number; updatedAt: number } | undefined {
  return db.driver
    .prepare<{ label: string; updatedSeq: number; updatedAt: number }>(
      'SELECT label, updated_seq AS updatedSeq, updated_at AS updatedAt FROM sessions WHERE id = ?',
    )
    .get([id]);
}

describe('rowLimit (03 3.7 rule 3)', () => {
  it('returns a non-negative integer unchanged', () => {
    expect(rowLimit(0)).toBe(0);
    expect(rowLimit(25)).toBe(25);
    expect(rowLimit(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['huge', Number.MAX_SAFE_INTEGER + 2],
    ['infinite', Number.POSITIVE_INFINITY],
    ['not a number', Number.NaN],
  ])('refuses a %s limit, because SQLite reads a negative LIMIT as unbounded', (_name, value) => {
    expect(() => rowLimit(value)).toThrow(RangeError);
  });
});

describe('parseEvidence', () => {
  it('reads a stored list', () => {
    const list = [
      { source: 'hook', fact: 'prompt', at: 5 },
      { source: 'transcript', fact: 'tool', at: null, count: 2, value: 'x' },
    ];
    expect(parseEvidence(JSON.stringify(list))).toEqual(list);
    expect(parseEvidence('[]')).toEqual([]);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['an object', '{"source":"hook"}'],
    ['a wrong item', '[{"source":1}]'],
    ['an empty string', ''],
  ])('reads %s as an empty list instead of blocking the lookup', (_name, text) => {
    expect(parseEvidence(text)).toEqual([]);
  });
});

describe('requireRef and requireTranscriptFile (03 3.4 soft references)', () => {
  it('passes when the row exists and throws the foreign key error when it does not', () => {
    const db = database();
    const id = addSession(db);
    expect(() => {
      requireRef(db, 'session', 'SELECT 1 FROM sessions WHERE id = ?', [id]);
    }).not.toThrow();
    let caught: unknown;
    try {
      requireRef(db, 'session', 'SELECT 1 FROM sessions WHERE id = ?', [id + 1000]);
    } catch (error) {
      caught = error;
    }
    expect(isDbError(caught, 'db_constraint')).toBe(true);
    expect(caught).toMatchObject({ constraint: 'foreignkey', message: 'the session does not exist' });
  });

  it('treats a null or absent transcript file id as no reference and a missing file as an error', () => {
    const db = database();
    expect(() => {
      requireTranscriptFile(db, null);
      requireTranscriptFile(db, undefined);
    }).not.toThrow();
    expect(() => {
      requireTranscriptFile(db, 987654);
    }).toThrow(expect.objectContaining({ code: 'db_constraint' }));
  });
});

describe('patchRow', () => {
  it('updates only the given columns, stamps updated_at and updated_seq, and reports the change', () => {
    const db = database();
    const id = addSession(db);
    const changed = withWriteTx(db, CTX, () => patchRow(db, 'sessions', id, [['label', 'alpha']], 7, T0 + 99));
    expect(changed).toBe(true);
    expect(selectLabel(db, id)).toEqual({ label: 'alpha', updatedSeq: 7, updatedAt: T0 + 99 });
  });

  it('skips undefined values, keeps updated_seq without a reserved seq and maps booleans to 0 and 1', () => {
    const db = database();
    const id = addSession(db);
    withWriteTx(db, CTX, () => patchRow(db, 'sessions', id, [['label', 'beta']], 3, T0 + 1));
    const changed = withWriteTx(db, CTX, () =>
      patchRow(
        db,
        'sessions',
        id,
        [
          ['label', undefined],
          ['pinned', true],
        ],
        null,
        T0 + 2,
      ),
    );
    expect(changed).toBe(true);
    expect(selectLabel(db, id)).toEqual({ label: 'beta', updatedSeq: 3, updatedAt: T0 + 2 });
    const pinned = db.driver.prepare<{ pinned: number }>('SELECT pinned FROM sessions WHERE id = ?').get([id]);
    expect(pinned?.pinned).toBe(1);
  });

  it('writes nothing when every value is undefined, and reports false for a missing row', () => {
    const db = database();
    const id = addSession(db);
    const before = selectLabel(db, id);
    expect(withWriteTx(db, CTX, () => patchRow(db, 'sessions', id, [['label', undefined]], 9, T0 + 50))).toBe(false);
    expect(selectLabel(db, id)).toEqual(before);
    expect(withWriteTx(db, CTX, () => patchRow(db, 'sessions', id + 1000, [['label', 'x']], null, T0 + 50))).toBe(
      false,
    );
  });
});

describe('viewKeyChanged and viewFromRow', () => {
  const KEY: ViewKeyRow = {
    state: 'working',
    presence: 'open',
    waitReason: null,
    staleKind: null,
    endReason: null,
    turnOutcome: null,
    basis: 'observed',
    confidence: 'high',
    ruleId: 'S-7c',
  };

  it('compares the nine key fields and nothing else', () => {
    expect(viewKeyChanged(KEY, { ...KEY })).toBe(false);
    const changes: readonly Partial<ViewKeyRow>[] = [
      { state: 'completed' },
      { presence: 'ended' },
      { waitReason: 'user' },
      { staleKind: 'silent' },
      { endReason: 'exit' },
      { turnOutcome: 'ok' },
      { basis: 'inferred' },
      { confidence: 'low' },
      { ruleId: 'S-1' },
    ];
    for (const change of changes) expect(viewKeyChanged(KEY, { ...KEY, ...change }), JSON.stringify(change)).toBe(true);
    // time passing and evidence wording are not part of the key
    expect(viewKeyChanged({ ...KEY, evidence: 'a' } as ViewKeyRow, { ...KEY, evidence: 'b' } as ViewKeyRow)).toBe(
      false,
    );
  });

  it('parses the evidence column of a stored row', () => {
    const row: ViewDbRow = {
      ...KEY,
      evidence: JSON.stringify([{ source: 'hook', fact: 'prompt', at: 1 }]),
      since: 1,
      evaluatedAt: 2,
      nextCheckAt: null,
    };
    expect(viewFromRow(row)).toEqual({ ...row, evidence: [{ source: 'hook', fact: 'prompt', at: 1 }] });
    expect(viewFromRow({ ...row, evidence: 'garbage' }).evidence).toEqual([]);
  });
});

describe('cutOrNull', () => {
  it('cuts to a number of code points and never splits a surrogate pair', () => {
    expect(cutOrNull('abcdef', 3)).toBe('abc');
    expect(cutOrNull(`ab${ASTRAL}cd`, 3)).toBe(`ab${ASTRAL}`);
    expect(cutOrNull('short', 100)).toBe('short');
    expect(cutOrNull('anything', 0)).toBe('');
  });

  it('passes null and undefined through as null', () => {
    expect(cutOrNull(null, 5)).toBeNull();
    expect(cutOrNull(undefined, 5)).toBeNull();
  });
});
