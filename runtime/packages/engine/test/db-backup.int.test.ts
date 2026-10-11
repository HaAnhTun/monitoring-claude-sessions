import { existsSync, openSync, readdirSync, writeSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { backupDb } from '../src/db/backup.ts';
import { openSqlite, pragmaValue } from '../src/db/driver.ts';
import { DbError } from '../src/db/errors.ts';
import { openInstanceDb, type InstanceDb } from '../src/db/open.ts';
import { withWriteTx } from '../src/db/write.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const BATCH = 50;
const FILLER_ROWS = 3000;
const FILLER_BYTES = 1900;

function open(root: string, mode: 'serve' | 'readonly' | 'maintenance' = 'serve'): InstanceDb {
  return openInstanceDb({
    path: join(root, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode,
    runtimeVersion: '3.0.0',
  });
}

/** About 6 MiB of filler in `changes` so that the online backup needs a dozen steps. */
function fill(db: InstanceDb): void {
  const insert = db.driver.prepare("INSERT INTO changes (at, kind, op, payload) VALUES (1, 'health', 'upsert', ?)");
  const payload = JSON.stringify({ filler: 'x'.repeat(FILLER_BYTES) });
  db.driver.transaction(() => {
    for (let i = 0; i < FILLER_ROWS; i += 1) insert.run([payload]);
  });
}

/**
 * One "ingestion tick": 50 ingest_errors rows and one change row in ONE transaction. Whatever a backup copies, the rows
 * of the two tables must stay in the ratio of one transaction (50 : 1) if the copy is a consistent point in time.
 */
function tick(db: InstanceDb): void {
  withWriteTx(db, CTX, (tx) => {
    const insert = db.driver.prepare(
      "INSERT INTO ingest_errors (at, source, code, detail) VALUES (?, 'spool', 'E_TICK', ?)",
    );
    for (let i = 0; i < BATCH; i += 1) insert.run([tx.now, `tick ${String(i)}`]);
    tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null });
  });
}

function counts(path: string): { errors: number; ticks: number } {
  const db = openSqlite(path, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
  try {
    const errors = db.prepare<{ n: number }>('SELECT count(*) AS n FROM ingest_errors').get()?.n ?? -1;
    const ticks = db.prepare<{ n: number }>("SELECT count(*) AS n FROM changes WHERE payload = '{}'").get()?.n ?? -1;
    return { errors, ticks };
  } finally {
    db.close();
  }
}

describe('DA-T-E-3: backup consistency under concurrent writes', () => {
  it('copies a consistent point in time from the writer connection while ingestion goes on between the steps', async () => {
    const root = tempDir('backup').path;
    const db = open(root);
    fill(db);
    for (let i = 0; i < 3; i += 1) tick(db);
    const startTicks = 3;
    let written = 0;
    const dest = join(root, 'copy.db');
    const result = await backupDb(db, dest, {
      onProgress: () => {
        if (written < 10) {
          tick(db);
          written += 1;
        }
      },
    });
    expect(written).toBeGreaterThanOrEqual(3); // the backup really had several steps to interleave with
    db.close();

    const copy = counts(dest);
    expect(copy.errors % BATCH).toBe(0); // no transaction is torn: a whole number of ticks
    expect(copy.errors / BATCH).toBe(copy.ticks);
    expect(copy.ticks).toBeGreaterThanOrEqual(startTicks);
    expect(copy.ticks).toBeLessThanOrEqual(startTicks + written);
    const reader = openSqlite(dest, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
    expect(pragmaValue(reader, 'quick_check')).toBe('ok');
    expect(reader.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get()).toEqual({ value: INSTANCE_ID });
    expect(pragmaValue(reader, 'user_version')).toBe(result.dbSchemaVersion);
    reader.close();
  }, 30_000);

  it('copies a consistent point in time from a read-only connection while another connection writes', async () => {
    const root = tempDir('backup').path;
    const server = open(root);
    fill(server);
    tick(server);
    let written = 0;
    const dest = join(root, 'copy.db');
    const result = await backupDb({ path: join(root, 'monitor.db'), expectedInstanceId: INSTANCE_ID }, dest, {
      onProgress: () => {
        if (written < 3) {
          tick(server); // another connection changes the source: SQLite restarts the copy, which must still end consistent
          written += 1;
        }
      },
    });
    expect(written).toBeGreaterThanOrEqual(1);
    const finalTicks = counts(join(root, 'monitor.db')).ticks;
    server.close();

    const copy = counts(dest);
    expect(copy.errors / BATCH).toBe(copy.ticks);
    expect(copy.ticks).toBeGreaterThanOrEqual(1);
    expect(copy.ticks).toBeLessThanOrEqual(finalTicks);
    expect(result.bytes).toBe(statSync(dest).size);
    const reader = openSqlite(dest, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
    expect(pragmaValue(reader, 'quick_check')).toBe('ok');
    reader.close();
  }, 30_000);

  it('produces a copy that a server can open and keep writing to (restore by copying the file back)', async () => {
    const root = tempDir('backup').path;
    const db = open(root);
    tick(db);
    const dest = join(root, 'restored');
    await backupDb(db, join(root, 'copy.db'));
    db.close();
    const restored = openInstanceDb({
      path: join(root, 'copy.db'),
      expectedInstanceId: INSTANCE_ID,
      mode: 'serve',
      runtimeVersion: '3.0.0',
    });
    expect(restored.headSeq()).toBe(1);
    tick(restored);
    expect(restored.headSeq()).toBe(2);
    restored.close();
    expect(existsSync(dest)).toBe(false);
  });
});

describe('backupDb verification and cleanup (03 4.4 step 4)', () => {
  it('deletes the copy and answers backup_failed when the copy does not pass quick_check', async () => {
    const root = tempDir('backup').path;
    const db = open(root);
    fill(db);
    const page = db.driver
      .prepare<{ pageno: number }>(
        "SELECT pageno FROM dbstat WHERE name = 'changes' AND pagetype = 'leaf' ORDER BY pageno",
      )
      .all();
    expect(page.length).toBeGreaterThan(20);
    const target = page[Math.floor(page.length / 2)]?.pageno ?? 0;
    const pageSize = Number(pragmaValue(db.driver, 'page_size'));
    db.close();
    const fd = openSync(join(root, 'monitor.db'), 'r+');
    writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, (target - 1) * pageSize);
    closeSync(fd);

    const dest = join(root, 'copy.db');
    let error: unknown;
    try {
      await backupDb({ path: join(root, 'monitor.db'), expectedInstanceId: INSTANCE_ID }, dest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('backup_failed');
    expect(readdirSync(root).filter((name) => name.startsWith('copy.db'))).toEqual([]);
  });

  it('never leaves a partial copy behind when the source goes wrong in the middle of the copy', async () => {
    const root = tempDir('backup').path;
    const db = open(root);
    fill(db);
    const dest = join(root, 'copy.db');
    let error: unknown;
    try {
      await backupDb(db, dest, {
        onProgress: () => {
          throw new Error('stop the copy');
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('backup_failed');
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith('copy.db'))).toEqual([]);
    // the writer is still usable afterwards
    tick(db);
    db.close();
  });
});
