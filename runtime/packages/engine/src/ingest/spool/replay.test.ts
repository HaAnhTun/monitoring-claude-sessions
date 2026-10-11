import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../../db/open.ts';
import { SpoolCursorsRepo, type NewSpoolCursor } from '../../db/repos/spool-cursors.ts';
import { onCommitted, withWriteTx } from '../../db/write.ts';
import { SpoolSegmentNotFoundError } from '../errors.ts';
import { applySpoolReplay, planSpoolReplay } from './replay.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const SEG_1 = 'hooks-20260101T00Z.ndjson';
const SEG_2 = 'hooks-20260101T01Z.ndjson';
const SEG_3 = 'hooks-20260101T02Z.ndjson';

const open: InstanceDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function setup(): { db: InstanceDb; repo: SpoolCursorsRepo; spool: string } {
  const root = tempDir('replay').path;
  const db = openInstanceDb({
    path: join(root, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(FIXTURE_EPOCH_MS),
  });
  open.push(db);
  const spool = join(root, 'spool');
  mkdirSync(spool);
  for (const [name, text] of [
    [SEG_1, 'one\n'],
    [SEG_2, 'two-two\n'],
    [SEG_3, 'three\n'],
  ] as const) {
    writeFileSync(join(spool, name), text);
  }
  return { db, repo: new SpoolCursorsRepo(db), spool };
}

function cursor(segment: string, offsetBytes: number, sealed: boolean): NewSpoolCursor {
  return {
    segment,
    offsetBytes,
    sizeSeen: offsetBytes,
    ino: null,
    headHash: null,
    lines: 3,
    partialBytes: 0,
    sealed,
    errors: 0,
    oldestReceivedAt: null,
    newestReceivedAt: null,
    drainedAt: null,
  };
}

describe('planSpoolReplay (02 2.7 steps 1-3)', () => {
  it('plans every segment on disk when `from` is null, with its cursor', async () => {
    const { db, repo, spool } = setup();
    withWriteTx(db, CTX, (tx) => {
      repo.save(CTX, tx, cursor(SEG_1, 4, true));
    });
    const plan = await planSpoolReplay(CTX, { spoolCursors: repo }, spool, null);
    expect(plan.segments).toEqual([
      { segment: SEG_1, bytes: 4, offset: 4, sealed: true },
      { segment: SEG_2, bytes: 8, offset: 0, sealed: false },
      { segment: SEG_3, bytes: 6, offset: 0, sealed: false },
    ]);
    expect(plan.totalBytes).toBe(18);
  });

  it('plans only the segments that sort at or after `from`', async () => {
    const { repo, spool } = setup();
    const plan = await planSpoolReplay(CTX, { spoolCursors: repo }, spool, SEG_2);
    expect(plan.segments.map((s) => s.segment)).toEqual([SEG_2, SEG_3]);
  });

  it('refuses a `from` that is not a segment name or not on disk with SPOOL_SEGMENT_NOT_FOUND', async () => {
    const { repo, spool } = setup();
    await expect(planSpoolReplay(CTX, { spoolCursors: repo }, spool, 'hooks-20260101T09Z.ndjson')).rejects.toThrow(
      SpoolSegmentNotFoundError,
    );
    await expect(planSpoolReplay(CTX, { spoolCursors: repo }, spool, '../x.ndjson')).rejects.toMatchObject({
      code: 'SPOOL_SEGMENT_NOT_FOUND',
    });
  });

  it('changes nothing in the database (dry run)', async () => {
    const { db, repo, spool } = setup();
    await planSpoolReplay(CTX, { spoolCursors: repo }, spool, null);
    expect(repo.list(CTX)).toEqual([]);
    expect(db.headSeq()).toBe(0);
  });
});

describe('applySpoolReplay (02 2.7 step 4)', () => {
  it('resets the cursors of the plan in one transaction and creates rows for segments without one', async () => {
    const { db, repo, spool } = setup();
    withWriteTx(db, CTX, (tx) => {
      repo.save(CTX, tx, cursor(SEG_1, 4, true));
      repo.save(CTX, tx, cursor(SEG_2, 8, true));
    });
    const plan = await planSpoolReplay(CTX, { spoolCursors: repo }, spool, SEG_2);
    const published: number[] = [];
    // one `withWriteTx` means one commit: the listener of the transaction runs once
    const off = onCommitted(db, (head) => published.push(head));
    const result = applySpoolReplay(db, CTX, plan);
    off();
    expect(result).toEqual({ segmentsReset: 2 });
    expect(published).toHaveLength(1);
    const rows = repo.list(CTX).map((row) => [row.segment, row.offsetBytes, row.sealed, row.lines]);
    expect(rows).toEqual([
      [SEG_1, 4, true, 3], // before `from`: untouched
      [SEG_2, 0, false, 0],
      [SEG_3, 0, false, 0],
    ]);
  });

  it('an empty plan resets nothing', () => {
    const { db } = setup();
    expect(applySpoolReplay(db, CTX, { segments: [], totalBytes: 0 })).toEqual({ segmentsReset: 0 });
  });
});
