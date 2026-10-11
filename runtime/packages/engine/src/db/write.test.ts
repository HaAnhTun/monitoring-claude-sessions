import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { openSqlite, pragmaValue } from './driver.ts';
import { DbError } from './errors.ts';
import { openInstanceDb, type InstanceDb } from './open.ts';
import { onCommitted, withWriteTx } from './write.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: INSTANCE_ID };
const SESSION_UID = 'aaaaaaaa-0000-4000-8000-000000000001';

function writer(clock = new FakeClock(FIXTURE_EPOCH_MS)): InstanceDb {
  return openInstanceDb({
    path: join(tempDir('write').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
}

function changeRows(db: InstanceDb): { seq: number; at: number; kind: string; op: string; payload: string }[] {
  return db.driver
    .prepare<{ seq: number; at: number; kind: string; op: string; payload: string }>(
      'SELECT seq, at, kind, op, payload FROM changes ORDER BY seq',
    )
    .all();
}

describe('withWriteTx (03 4.5, DA-T-DB-17)', () => {
  it('runs the callback in one transaction, returns its value and commits', () => {
    const db = writer();
    const result = withWriteTx(db, CTX, (tx) => {
      db.driver.exec("INSERT INTO meta (key, value) VALUES ('probe', 'one')");
      tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null });
      return 'done';
    });
    expect(result).toBe('done');
    expect(db.driver.prepare("SELECT value FROM meta WHERE key = 'probe'").get()).toEqual({ value: 'one' });
    expect(db.headSeq()).toBe(1);
    db.close();
  });

  it('starts BEGIN IMMEDIATE: a second connection cannot write while the callback runs', () => {
    const db = writer();
    const other = openSqlite(db.driver.path, { readonly: false, fileMustExist: true, timeoutMs: 1 });
    withWriteTx(db, CTX, () => {
      let code: string | undefined;
      try {
        other.exec('BEGIN IMMEDIATE');
      } catch (error) {
        code = error instanceof DbError ? error.code : undefined;
      }
      expect(code).toBe('db_busy');
    });
    other.close();
    db.close();
  });

  it('gives the callback the clock time of the start of the transaction and stamps the changes with it', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const db = writer(clock);
    clock.advance(1234);
    withWriteTx(db, CTX, (tx) => {
      expect(tx.now).toBe(FIXTURE_EPOCH_MS + 1234);
      tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null });
    });
    expect(changeRows(db)[0]?.at).toBe(FIXTURE_EPOCH_MS + 1234);
    db.close();
  });

  it('writes the final change payloads (flush) before COMMIT', () => {
    const db = writer();
    withWriteTx(db, CTX, (tx) => {
      const seq = tx.changes.reserve('event', 'append', { entityId: 1, sessionUid: SESSION_UID });
      tx.changes.noteId(seq, 10);
      tx.changes.noteId(seq, 12);
    });
    expect(changeRows(db)[0]?.payload).toBe('{"from":10,"to":12,"count":2}');
    db.close();
  });

  it('rolls back everything when the callback throws, rethrows the original error and publishes nothing', () => {
    const db = writer();
    const listener = vi.fn();
    onCommitted(db, listener);
    const boom = new Error('boom');
    expect(() =>
      withWriteTx(db, CTX, (tx) => {
        db.driver.exec("INSERT INTO meta (key, value) VALUES ('probe', 'lost')");
        tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null });
        throw boom;
      }),
    ).toThrow(boom);
    expect(listener).not.toHaveBeenCalled();
    expect(db.driver.prepare("SELECT count(*) AS n FROM meta WHERE key = 'probe'").get()).toEqual({ n: 0 });
    expect(changeRows(db)).toEqual([]);
    expect(db.headSeq()).toBe(0);
    // the sequence is gap-free after the rollback (DA-I8)
    withWriteTx(db, CTX, (tx) => tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null }));
    expect(changeRows(db).map((row) => row.seq)).toEqual([1]);
    db.close();
  });

  it('rolls back when a statement inside the callback fails and keeps the DbError', () => {
    const db = writer();
    let error: unknown;
    try {
      withWriteTx(db, CTX, () => {
        db.driver.exec("INSERT INTO meta (key, value) VALUES ('probe', 'a')");
        db.driver.exec("INSERT INTO meta (key, value) VALUES ('probe', 'b')");
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('db_constraint');
    expect(db.driver.prepare("SELECT count(*) AS n FROM meta WHERE key = 'probe'").get()).toEqual({ n: 0 });
    db.close();
  });

  it('refuses a callback that returns a promise (DA-I12): nothing is committed and nothing is published', async () => {
    const db = writer();
    const listener = vi.fn();
    onCommitted(db, listener);
    expect(() =>
      withWriteTx(db, CTX, async (tx) => {
        tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null });
        await Promise.resolve();
      }),
    ).toThrow(TypeError);
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(changeRows(db)).toEqual([]);
    db.close();
  });

  it('is not re-entrant: a nested call fails and the outer transaction rolls back with it', () => {
    const db = writer();
    expect(() => {
      withWriteTx(db, CTX, () => {
        db.driver.exec("INSERT INTO meta (key, value) VALUES ('probe', 'outer')");
        withWriteTx(db, CTX, () => undefined);
      });
    }).toThrow(/not re-entrant/);
    expect(db.driver.prepare("SELECT count(*) AS n FROM meta WHERE key = 'probe'").get()).toEqual({ n: 0 });
    // the guard is released: the next transaction works
    expect(withWriteTx(db, CTX, () => 'again')).toBe('again');
    db.close();
  });

  it('refuses a foreign instance context with scope_mismatch before it starts anything', () => {
    const db = writer();
    const callback = vi.fn<() => void>();
    expect(() => {
      withWriteTx(db, { instanceId: '22222222-2222-4222-8222-222222222222' }, callback);
    }).toThrow(DbError);
    expect(callback).not.toHaveBeenCalled();
    db.close();
  });

  it('refuses a read-only database with db_readonly before it starts anything', () => {
    const primary = writer();
    const reader = openInstanceDb({
      path: primary.driver.path,
      expectedInstanceId: INSTANCE_ID,
      mode: 'readonly',
      runtimeVersion: '3.0.0',
    });
    const callback = vi.fn();
    let code: string | undefined;
    try {
      withWriteTx(reader, CTX, callback);
    } catch (error) {
      code = error instanceof DbError ? error.code : undefined;
    }
    expect(code).toBe('db_readonly');
    expect(callback).not.toHaveBeenCalled();
    reader.close();
    primary.close();
  });
});

describe('onCommitted (03 4.5, 9.2, T-PL-05)', () => {
  it('calls every listener once per commit with the head seq, after COMMIT: a second connection already sees the data', () => {
    const db = writer();
    const seen: { head: number; visible: unknown; seqVisible: unknown }[] = [];
    const second = openSqlite(db.driver.path, { readonly: true, fileMustExist: true, timeoutMs: 1000 });
    onCommitted(db, (head) => {
      seen.push({
        head,
        visible: second.prepare("SELECT value FROM meta WHERE key = 'probe'").get(),
        seqVisible: second.prepare('SELECT max(seq) AS seq FROM changes').get(),
      });
    });
    withWriteTx(db, CTX, (tx) => {
      db.driver.exec("INSERT INTO meta (key, value) VALUES ('probe', 'x')");
      tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null });
    });
    expect(seen).toEqual([{ head: 1, visible: { value: 'x' }, seqVisible: { seq: 1 } }]);
    second.close();
    db.close();
  });

  it('reports the head after each commit and also after a commit that wrote no change', () => {
    const db = writer();
    const heads: number[] = [];
    onCommitted(db, (head) => heads.push(head));
    withWriteTx(db, CTX, (tx) => tx.changes.reserve('health', 'upsert', { entityId: null, sessionUid: null }));
    withWriteTx(db, CTX, () => undefined);
    withWriteTx(db, CTX, (tx) => tx.changes.reserve('attempt', 'upsert', { entityId: null, sessionUid: null }));
    expect(heads).toEqual([1, 1, 2]);
    db.close();
  });

  it('returns an unsubscribe function; unsubscribing twice is harmless', () => {
    const db = writer();
    const listener = vi.fn();
    const off = onCommitted(db, listener);
    withWriteTx(db, CTX, () => undefined);
    off();
    off();
    withWriteTx(db, CTX, () => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('keeps listeners of one database apart from those of another', () => {
    const first = writer();
    const second = writer();
    const listener = vi.fn();
    onCommitted(first, listener);
    withWriteTx(second, CTX, () => undefined);
    expect(listener).not.toHaveBeenCalled();
    first.close();
    second.close();
  });

  it('isolates a throwing listener: later listeners still run and the committed result is returned', () => {
    const db = writer();
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const later = vi.fn();
    onCommitted(db, () => {
      throw new Error('listener failure with SECRET-VALUE');
    });
    onCommitted(db, later);
    expect(withWriteTx(db, CTX, () => 'committed')).toBe('committed');
    expect(later).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('SECRET-VALUE');
    db.close();
  });

  it('tolerates a listener that unsubscribes itself while being notified', () => {
    const db = writer();
    const calls: string[] = [];
    const off = onCommitted(db, () => {
      calls.push('first');
      off();
    });
    onCommitted(db, () => calls.push('second'));
    withWriteTx(db, CTX, () => undefined);
    withWriteTx(db, CTX, () => undefined);
    expect(calls).toEqual(['first', 'second', 'second']);
    db.close();
  });
});

describe('write discipline: no await inside a withWriteTx callback (DA-I12, DA-T-DB-17)', () => {
  /** Reports every `withWriteTx(...)` call whose function argument is async or contains an `await`. */
  function asyncWriteTx(source: string, fileName = 'probe.ts'): string[] {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const isWriteTxCall = (node: ts.CallExpression): boolean =>
      (ts.isIdentifier(node.expression) && node.expression.text === 'withWriteTx') ||
      (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'withWriteTx');
    const containsAwait = (node: ts.Node): boolean => {
      if (ts.isAwaitExpression(node)) return true;
      if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) return true;
      return ts.forEachChild(node, (child) => (containsAwait(child) ? true : undefined)) === true;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isWriteTxCall(node)) {
        for (const argument of node.arguments) {
          if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) continue;
          const isAsync = argument.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
          if (isAsync || containsAwait(argument.body)) {
            const { line } = file.getLineAndCharacterOfPosition(argument.getStart());
            found.push(`${fileName}:${String(line + 1)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
  }

  it('the probe finds an async callback and an await in the callback', () => {
    expect(asyncWriteTx('withWriteTx(db, ctx, async (tx) => { tx.now; });')).toEqual(['probe.ts:1']);
    expect(asyncWriteTx('withWriteTx(db, ctx, async function (tx) { await x(); });')).toEqual(['probe.ts:1']);
    expect(asyncWriteTx('async function f() {\n  await withWriteTx(db, ctx, async (tx) => 1);\n}')).toEqual([
      'probe.ts:2',
    ]);
    expect(asyncWriteTx('engine.withWriteTx(db, ctx, async () => { for await (const x of y) x; });')).toEqual([
      'probe.ts:1',
    ]);
  });

  it('the probe accepts synchronous callbacks and awaits outside the callback', () => {
    expect(asyncWriteTx('withWriteTx(db, ctx, (tx) => { tx.changes.flush(); return 1; });')).toEqual([]);
    expect(
      asyncWriteTx(
        'async function f() {\n  await prepare();\n  withWriteTx(db, ctx, (tx) => tx.now);\n  await publish();\n}',
      ),
    ).toEqual([]);
    expect(asyncWriteTx('withWriteTx(db, ctx, work);')).toEqual([]);
  });

  it('no production source awaits inside a withWriteTx callback', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url)); // runtime/packages
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) sources.push(full);
      }
    };
    for (const pkg of ['shared', 'engine', 'server', 'cli']) walk(join(root, pkg, 'src'));
    expect(sources.length).toBeGreaterThan(10);
    const offenders = sources.flatMap((file) =>
      asyncWriteTx(readFileSync(file, 'utf8'), relative(root, file).replaceAll('\\', '/')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the write transaction keeps the database settings of the writer', () => {
  it('leaves foreign keys on and the journal in WAL mode after a transaction', () => {
    const db = writer();
    withWriteTx(db, CTX, () => undefined);
    expect(pragmaValue(db.driver, 'foreign_keys')).toBe(1);
    expect(pragmaValue(db.driver, 'journal_mode')).toBe('wal');
    db.close();
  });
});
