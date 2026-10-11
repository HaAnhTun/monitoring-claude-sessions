import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { isDbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { IngestErrorsRepo, type NewIngestError } from './ingest-errors.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const T0 = FIXTURE_EPOCH_MS;
const UID_A = 'aaaaaaaa-0000-4000-8000-000000000001';

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): InstanceDb {
  const db = openInstanceDb({
    path: join(tempDir('ingest-errors-repo').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  open.push(db);
  return db;
}

function error(over: Partial<NewIngestError> = {}): NewIngestError {
  return { at: T0 + 1, source: 'transcript', code: 'TRANSCRIPT_READ_FAILED', ...over };
}

/**
 * DA-T-DB-7, DA-I3 (03 4.5): every public method of the repository, called with a foreign context and valid arguments,
 * fails with `scope_mismatch` before any statement. The table is checked against the prototype, so a new method
 * cannot be forgotten.
 */
function expectEveryMethodScoped(
  repo: object,
  calls: Readonly<Record<string, () => unknown>>,
  internal: readonly string[] = [],
): void {
  const proto = Reflect.getPrototypeOf(repo);
  if (proto === null) throw new Error('a repository has a prototype');
  const methods = Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && !internal.includes(name))
    .sort();
  expect(Object.keys(calls).sort()).toEqual(methods);
  for (const [name, call] of Object.entries(calls)) {
    expect(call, name).toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
  }
}

describe('IngestErrorsRepo.insert (02 4.8)', () => {
  it('stores references and numbers only and reads them back newest first', () => {
    const db = database();
    const repo = new IngestErrorsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.insert(CTX, tx, error({ at: T0 + 1 }));
      repo.insert(
        CTX,
        tx,
        error({
          at: T0 + 2,
          source: 'spool',
          code: 'ENVELOPE_SCHEMA',
          fileId: 7,
          segment: 'hooks-20260101T00Z.ndjson',
          byteOffset: 120,
          sessionUid: UID_A,
          detail: 'path /x/y',
        }),
      );
    });
    const rows = repo.recent(CTX, 10, null);
    expect(rows.map((r) => r.code)).toEqual(['ENVELOPE_SCHEMA', 'TRANSCRIPT_READ_FAILED']);
    expect(rows[0]).toMatchObject({
      at: T0 + 2,
      source: 'spool',
      fileId: 7,
      segment: 'hooks-20260101T00Z.ndjson',
      byteOffset: 120,
      sessionUid: UID_A,
      detail: 'path /x/y',
    });
    expect(rows[1]).toMatchObject({ fileId: null, segment: null, byteOffset: null, sessionUid: null, detail: null });
  });

  it('clips the detail to its column cap by code points and never fails on a long text', () => {
    const db = database();
    const repo = new IngestErrorsRepo(db);
    const long = String.fromCodePoint(0x1f600).repeat(300);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, error({ detail: long })));
    const stored = repo.recent(CTX, 1, null)[0]?.detail;
    expect(stored === null ? -1 : Array.from(stored ?? '').length).toBe(200);
  });

  it('rejects a code that is not upper case and a source outside the closed set', () => {
    const db = database();
    const repo = new IngestErrorsRepo(db);
    let code: string | undefined;
    try {
      withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, error({ code: 'lower_case' })));
    } catch (e) {
      code = isDbError(e) ? e.code : undefined;
    }
    expect(code).toBe('db_constraint');
  });

  it('pages with a keyset cursor', () => {
    const db = database();
    const repo = new IngestErrorsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      for (let i = 0; i < 5; i += 1) repo.insert(CTX, tx, error({ at: T0 + i }));
    });
    const page1 = repo.recent(CTX, 2, null);
    const page2 = repo.recent(CTX, 2, page1[1]?.id ?? null);
    const page3 = repo.recent(CTX, 2, page2[1]?.id ?? null);
    expect([page1, page2, page3].map((p) => p.map((r) => r.at - T0))).toEqual([[4, 3], [2, 1], [0]]);
  });
});

describe('IngestErrorsRepo counts and retention', () => {
  it('counts one code in a window and groups all codes', () => {
    const db = database();
    const repo = new IngestErrorsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.insert(CTX, tx, error({ at: T0 + 1, code: 'A_CODE' }));
      repo.insert(CTX, tx, error({ at: T0 + 5, code: 'A_CODE' }));
      repo.insert(CTX, tx, error({ at: T0 + 6, code: 'B_CODE' }));
    });
    expect(repo.countByCodeSince(CTX, 'A_CODE', T0 + 2)).toBe(1);
    expect(repo.countByCodeSince(CTX, 'A_CODE', T0)).toBe(2);
    expect(repo.countByCodeSince(CTX, 'NONE', T0)).toBe(0);
    expect(repo.codeCountsSince(CTX, T0 + 2)).toEqual([
      { code: 'A_CODE', count: 1 },
      { code: 'B_CODE', count: 1 },
    ]);
  });

  it('keeps the newest rows when trimming to a maximum', () => {
    const db = database();
    const repo = new IngestErrorsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      for (let i = 0; i < 8; i += 1) repo.insert(CTX, tx, error({ at: T0 + i }));
    });
    expect(withWriteTx(db, CTX, (tx) => repo.trimToNewest(CTX, tx, 3))).toBe(5);
    expect(repo.recent(CTX, 10, null).map((r) => r.at - T0)).toEqual([7, 6, 5]);
    expect(withWriteTx(db, CTX, (tx) => repo.trimToNewest(CTX, tx, 3))).toBe(0);
  });

  it('counts the occurrences at or after the boundary, inclusive', () => {
    const db = database();
    const repo = new IngestErrorsRepo(db);
    withWriteTx(db, CTX, (tx) => {
      repo.insert(CTX, tx, error({ at: T0 + 10 }));
      repo.insert(CTX, tx, error({ at: T0 + 20 }));
    });
    expect(repo.countByCodeSince(CTX, 'TRANSCRIPT_READ_FAILED', T0 + 10)).toBe(2);
    expect(repo.countByCodeSince(CTX, 'TRANSCRIPT_READ_FAILED', T0 + 11)).toBe(1);
    expect(repo.codeCountsSince(CTX, T0 + 20)).toEqual([{ code: 'TRANSCRIPT_READ_FAILED', count: 1 }]);
    expect(repo.codeCountsSince(CTX, T0 + 21)).toEqual([]);
  });

  it('refuses a negative limit or size instead of reading it as no limit', () => {
    const db = database();
    const repo = new IngestErrorsRepo(db);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, error()));
    expect(() => repo.recent(CTX, -1, null)).toThrow(RangeError);
    expect(() => withWriteTx(db, CTX, (tx) => repo.trimToNewest(CTX, tx, -1))).toThrow(RangeError);
    expect(repo.recent(CTX, 10, null)).toHaveLength(1);
  });

  it('refuses a foreign context on every public method (DA-T-DB-7)', () => {
    const db = database();
    const repo = new IngestErrorsRepo(db);
    withWriteTx(db, CTX, (tx) => repo.insert(CTX, tx, error({ at: T0 + 1 })));
    expectEveryMethodScoped(repo, {
      insert: () => withWriteTx(db, CTX, (tx) => repo.insert(FOREIGN, tx, error())),
      recent: () => repo.recent(FOREIGN, 1, null),
      countByCodeSince: () => repo.countByCodeSince(FOREIGN, 'TRANSCRIPT_READ_FAILED', 0),
      codeCountsSince: () => repo.codeCountsSince(FOREIGN, 0),
      trimToNewest: () => withWriteTx(db, CTX, (tx) => repo.trimToNewest(FOREIGN, tx, 0)),
    });
    expect(repo.recent(CTX, 10, null)).toHaveLength(1);
  });
});
