import { join } from 'node:path';

import { CHECKPOINT_EVERY_ENTRIES } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { DbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { CheckpointsRepo, type CheckpointInput } from './checkpoints.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX: RepoContext = { instanceId: INSTANCE_ID };
const FOREIGN: RepoContext = { instanceId: '22222222-2222-4222-8222-222222222222' };
const T0 = FIXTURE_EPOCH_MS;

const opened: InstanceDb[] = [];
// registered after useTempDirs(): Vitest runs `afterEach` hooks in reverse order, so the files close before they are removed
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

interface Fixture {
  readonly db: InstanceDb;
  readonly repo: CheckpointsRepo;
  readonly fileA: number;
  readonly fileB: number;
}

function fixture(): Fixture {
  const db = openInstanceDb({
    path: join(tempDir('checkpoints').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  opened.push(db);
  const file = (n: number): number =>
    db.driver
      .prepare(
        "INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at) VALUES (?, ?, 'session', 'aaaaaaaa-0000-4000-8000-000000000001', ?, ?)",
      )
      .run([`f${String(n)}`, `f${String(n)}`, T0, T0]).lastInsertRowid;
  return { db, repo: new CheckpointsRepo(db), fileA: file(1), fileB: file(2) };
}

/** `n` checkpoints one per `CHECKPOINT_EVERY_ENTRIES` entries, 1000 bytes apart, with block times 10 s apart. */
function ladder(n: number): CheckpointInput[] {
  return Array.from({ length: n }, (_, i) => ({
    entryIndex: i * CHECKPOINT_EVERY_ENTRIES,
    byteOffset: i * 1000,
    minTs: T0 + i * 10_000,
    maxTs: T0 + i * 10_000 + 9_000,
  }));
}

function dbErrorOf(run: () => unknown): DbError {
  try {
    run();
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error('expected a DbError');
}

function store(f: Fixture, fileId: number, rows: readonly CheckpointInput[]): number {
  return withWriteTx(f.db, CTX, (tx) => f.repo.upsertMany(CTX, tx, fileId, rows));
}

describe('CheckpointsRepo.upsertMany', () => {
  it('stores the rows of one file and returns how many were written; no change row is written', () => {
    const f = fixture();
    expect(store(f, f.fileA, ladder(4))).toBe(4);
    expect(f.repo.count(CTX, f.fileA)).toBe(4);
    expect(f.repo.count(CTX, f.fileB)).toBe(0);
    expect(f.repo.list(CTX, f.fileA, -1, 10)).toEqual([
      { fileId: f.fileA, entryIndex: 0, byteOffset: 0, minTs: T0, maxTs: T0 + 9_000 },
      { fileId: f.fileA, entryIndex: 256, byteOffset: 1000, minTs: T0 + 10_000, maxTs: T0 + 19_000 },
      { fileId: f.fileA, entryIndex: 512, byteOffset: 2000, minTs: T0 + 20_000, maxTs: T0 + 29_000 },
      { fileId: f.fileA, entryIndex: 768, byteOffset: 3000, minTs: T0 + 30_000, maxTs: T0 + 39_000 },
    ]);
    expect(f.db.headSeq()).toBe(0);
  });

  it('is idempotent and replaces the values of an existing checkpoint', () => {
    const f = fixture();
    store(f, f.fileA, ladder(3));
    expect(store(f, f.fileA, ladder(3))).toBe(3);
    expect(f.repo.count(CTX, f.fileA)).toBe(3);
    store(f, f.fileA, [{ entryIndex: 256, byteOffset: 1234, minTs: null, maxTs: null }]);
    expect(f.repo.seekByEntry(CTX, f.fileA, 256)).toEqual({
      fileId: f.fileA,
      entryIndex: 256,
      byteOffset: 1234,
      minTs: null,
      maxTs: null,
    });
    expect(f.repo.count(CTX, f.fileA)).toBe(3);
  });

  it('accepts an empty list, many rows in one transaction, and writes nothing when one row is refused', () => {
    const f = fixture();
    expect(store(f, f.fileA, [])).toBe(0);
    expect(store(f, f.fileA, ladder(2000))).toBe(2000);
    expect(f.repo.count(CTX, f.fileA)).toBe(2000);
    expect(
      dbErrorOf(() => store(f, f.fileB, [...ladder(3), { entryIndex: -1, byteOffset: 0, minTs: null, maxTs: null }])),
    ).toMatchObject({ code: 'db_constraint', constraint: 'check' });
    expect(f.repo.count(CTX, f.fileB)).toBe(0);
    expect(
      dbErrorOf(() => store(f, f.fileB, [{ entryIndex: 0, byteOffset: -5, minTs: null, maxTs: null }])),
    ).toMatchObject({
      code: 'db_constraint',
      constraint: 'check',
    });
  });

  it('refuses a file that does not exist (soft reference validated by the repository)', () => {
    const f = fixture();
    expect(dbErrorOf(() => store(f, 999, ladder(1)))).toMatchObject({
      code: 'db_constraint',
      constraint: 'foreignkey',
    });
    expect(f.repo.count(CTX, 999)).toBe(0);
  });
});

describe('CheckpointsRepo seeks (03 7.2, 7.3)', () => {
  it('seekByEntry returns the last checkpoint at or before the entry index', () => {
    const f = fixture();
    store(f, f.fileA, ladder(4));
    store(f, f.fileB, [{ entryIndex: 0, byteOffset: 77, minTs: null, maxTs: null }]);
    expect(f.repo.seekByEntry(CTX, f.fileA, 0)?.entryIndex).toBe(0);
    expect(f.repo.seekByEntry(CTX, f.fileA, 255)?.entryIndex).toBe(0);
    expect(f.repo.seekByEntry(CTX, f.fileA, 256)?.entryIndex).toBe(256);
    expect(f.repo.seekByEntry(CTX, f.fileA, 700)?.entryIndex).toBe(512);
    expect(f.repo.seekByEntry(CTX, f.fileA, 9_999_999)?.entryIndex).toBe(768);
    expect(f.repo.seekByEntry(CTX, f.fileA, -1)).toBeUndefined();
    expect(f.repo.seekByEntry(CTX, f.fileB, 5)?.byteOffset).toBe(77);
    expect(f.repo.seekByEntry(CTX, 999, 5)).toBeUndefined();
  });

  it('seekByOffset returns the last checkpoint that starts at or before the byte offset', () => {
    const f = fixture();
    store(f, f.fileA, ladder(4));
    expect(f.repo.seekByOffset(CTX, f.fileA, 0)?.entryIndex).toBe(0);
    expect(f.repo.seekByOffset(CTX, f.fileA, 999)?.entryIndex).toBe(0);
    expect(f.repo.seekByOffset(CTX, f.fileA, 1000)?.entryIndex).toBe(256);
    expect(f.repo.seekByOffset(CTX, f.fileA, 2500)?.entryIndex).toBe(512);
    expect(f.repo.seekByOffset(CTX, f.fileA, 99_999_999)?.entryIndex).toBe(768);
    expect(f.repo.seekByOffset(CTX, f.fileA, -1)).toBeUndefined();
  });

  it('firstReachingTs returns the first block whose latest time reaches the timestamp, skipping blocks without times', () => {
    const f = fixture();
    store(f, f.fileA, [
      { entryIndex: 0, byteOffset: 0, minTs: T0, maxTs: T0 + 100 },
      { entryIndex: 256, byteOffset: 1000, minTs: null, maxTs: null },
      { entryIndex: 512, byteOffset: 2000, minTs: T0 + 50, maxTs: T0 + 900 },
      { entryIndex: 768, byteOffset: 3000, minTs: T0 + 800, maxTs: T0 + 1500 },
    ]);
    expect(f.repo.firstReachingTs(CTX, f.fileA, T0 - 5)?.entryIndex).toBe(0);
    expect(f.repo.firstReachingTs(CTX, f.fileA, T0 + 100)?.entryIndex).toBe(0);
    expect(f.repo.firstReachingTs(CTX, f.fileA, T0 + 101)?.entryIndex).toBe(512);
    expect(f.repo.firstReachingTs(CTX, f.fileA, T0 + 901)?.entryIndex).toBe(768);
    expect(f.repo.firstReachingTs(CTX, f.fileA, T0 + 1501)).toBeUndefined();
    expect(f.repo.firstReachingTs(CTX, f.fileB, T0)).toBeUndefined();
  });

  it('list pages by keyset in entry order and last returns the final checkpoint', () => {
    const f = fixture();
    store(f, f.fileA, ladder(10));
    const first = f.repo.list(CTX, f.fileA, -1, 4);
    expect(first.map((c) => c.entryIndex)).toEqual([0, 256, 512, 768]);
    const second = f.repo.list(CTX, f.fileA, 768, 4);
    expect(second.map((c) => c.entryIndex)).toEqual([1024, 1280, 1536, 1792]);
    expect(f.repo.list(CTX, f.fileA, 2048, 4).map((c) => c.entryIndex)).toEqual([2304]);
    expect(f.repo.list(CTX, f.fileA, 2304, 4)).toEqual([]);
    expect(f.repo.list(CTX, f.fileA, -1, 0)).toEqual([]);
    expect(f.repo.last(CTX, f.fileA)?.entryIndex).toBe(2304);
    expect(f.repo.last(CTX, f.fileB)).toBeUndefined();
  });

  it('every seek is answered from the primary key of the file (03 3.7: no scan of the table)', () => {
    const f = fixture();
    const plan = (sql: string): string =>
      f.db.driver
        .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => row.detail)
        .join(' | ');
    const byEntry = plan(
      'SELECT entry_index FROM transcript_checkpoints WHERE file_id = 1 AND entry_index <= 700 ORDER BY entry_index DESC LIMIT 1',
    );
    expect(byEntry).toContain('USING PRIMARY KEY');
    expect(byEntry).not.toMatch(/SCAN/);
    const keyset = plan(
      'SELECT entry_index FROM transcript_checkpoints WHERE file_id = 1 AND entry_index > 700 ORDER BY entry_index LIMIT 4',
    );
    expect(keyset).toContain('USING PRIMARY KEY');
    expect(keyset).not.toMatch(/SCAN/);
  });
});

describe('CheckpointsRepo.deleteForFile', () => {
  it('removes the checkpoints of one file only and returns how many', () => {
    const f = fixture();
    store(f, f.fileA, ladder(5));
    store(f, f.fileB, ladder(2));
    expect(withWriteTx(f.db, CTX, (tx) => f.repo.deleteForFile(CTX, tx, f.fileA))).toBe(5);
    expect(f.repo.count(CTX, f.fileA)).toBe(0);
    expect(f.repo.count(CTX, f.fileB)).toBe(2);
    expect(withWriteTx(f.db, CTX, (tx) => f.repo.deleteForFile(CTX, tx, f.fileA))).toBe(0);
  });

  it('a rolled-back delete keeps the rows', () => {
    const f = fixture();
    store(f, f.fileA, ladder(3));
    expect(() =>
      withWriteTx(f.db, CTX, (tx) => {
        f.repo.deleteForFile(CTX, tx, f.fileA);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(f.repo.count(CTX, f.fileA)).toBe(3);
  });
});

describe('CheckpointsRepo scope', () => {
  it('every public method asserts the scope first', () => {
    const f = fixture();
    store(f, f.fileA, ladder(2));
    const calls: (() => unknown)[] = [
      () => withWriteTx(f.db, CTX, (tx) => f.repo.upsertMany(FOREIGN, tx, f.fileA, ladder(1))),
      () => withWriteTx(f.db, CTX, (tx) => f.repo.deleteForFile(FOREIGN, tx, f.fileA)),
      () => f.repo.seekByEntry(FOREIGN, f.fileA, 0),
      () => f.repo.seekByOffset(FOREIGN, f.fileA, 0),
      () => f.repo.firstReachingTs(FOREIGN, f.fileA, 0),
      () => f.repo.list(FOREIGN, f.fileA, -1, 1),
      () => f.repo.last(FOREIGN, f.fileA),
      () => f.repo.count(FOREIGN, f.fileA),
    ];
    for (const run of calls) expect(dbErrorOf(run).code).toBe('scope_mismatch');
    expect(f.repo.count(CTX, f.fileA)).toBe(2);
  });
});
