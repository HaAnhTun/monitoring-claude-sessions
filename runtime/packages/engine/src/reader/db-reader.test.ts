// `DbReader` (01 6.1, 03 12.2, T-CLI-05 unit part): a fixture database opened read-only, the audit references attached to a session,
// the failures of the query layer mapped to the errors the API would have answered, and the promise that matters most: a read
// changes nothing in the workspace (the bytes of every file and the modification time of the database stay as they were), also for
// the methods that need a private copy of the database, whose temporary folder is gone after `close`. Every row is synthetic.
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

import { McsError, SessionIdSchema, type ExportQuery } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, snapshotTree, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appendChange } from '../audit/writer.ts';
import { defaultSkillDir } from '../config/defaults.ts';
import type { SqlValue } from '../db/driver.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { resolveWorkspace, type WorkspaceRef } from '../workspace/paths.ts';
import { openDbReader } from './db-reader.ts';
import type { InstanceReader, ReaderDeps } from './open.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 3_600_000;
const SESSION_NEW = 'aaaaaaaa-0000-4000-8000-000000000001';
const SESSION_OLD = 'aaaaaaaa-0000-4000-8000-000000000002';

const readers: InstanceReader[] = [];
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.close();
});

function insert(db: InstanceDb, table: string, row: Record<string, SqlValue>): number {
  const columns = Object.keys(row);
  return db.driver
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => `:${column}`).join(', ')})`,
    )
    .run(row).lastInsertRowid;
}

function addSession(db: InstanceDb, uid: string, lastActivityAt: number, label: string): void {
  const startedAt = lastActivityAt - HOUR;
  const id = insert(db, 'sessions', {
    session_uid: uid,
    label,
    label_source: 'rule',
    matched: 1,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: lastActivityAt,
    updated_at: lastActivityAt,
  });
  insert(db, 'agents', {
    session_id: id,
    agent_uid: 'main',
    kind: 'main',
    depth: 0,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: lastActivityAt,
    updated_at: lastActivityAt,
  });
}

const uidOf = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface Fixture {
  readonly ws: WorkspaceRef;
  readonly deps: ReaderDeps;
  readonly dir: string;
  readonly dbFile: string;
  /** The writer connection of `keepOpen`. */
  readonly keep?: InstanceDb;
}

interface FixtureOptions {
  readonly instanceId?: string;
  readonly bulk?: number;
  readonly noDatabase?: boolean;
  readonly newerSchema?: boolean;
  /** Keep the writer connection open, so that the committed frames stay in the -wal file. */
  readonly keepOpen?: boolean;
}

function fixture(o: FixtureOptions = {}): Fixture {
  const { repo, tasksRoot } = buildRepo(makeTemp('db-reader').path);
  const instanceId = o.instanceId ?? ID;
  const dir = buildTaskWorkspace(repo, {
    slug: 'demo',
    config: { title: 'FIXTURE demo' },
    instance: { slug: 'demo', instanceId, runtimeVersion: '4.0.0', dbSchemaVersion: 1 },
  });
  for (const sub of ['data', 'logs', 'audit']) mkdirSync(path.join(dir, sub), { recursive: true });
  const dbFile = path.join(dir, 'data', 'monitor.db');
  let keep: InstanceDb | undefined;
  if (o.noDatabase !== true) {
    const db = openInstanceDb({ path: dbFile, expectedInstanceId: instanceId, mode: 'serve', runtimeVersion: '4.0.0' });
    addSession(db, SESSION_NEW, NOW - HOUR, 'FIXTURE newer session');
    addSession(db, SESSION_OLD, NOW - 5 * HOUR, 'FIXTURE older session');
    insert(db, 'ingest_errors', {
      at: NOW - 3 * HOUR,
      source: 'spool',
      code: 'SEGMENT_TORN',
      segment: 'a.ndjson',
      detail: 'older',
    });
    insert(db, 'ingest_errors', {
      at: NOW - HOUR,
      source: 'transcript',
      code: 'LINE_INVALID',
      session_uid: SESSION_NEW,
      detail: 'newer',
    });
    if (o.bulk !== undefined) {
      db.driver.transaction(() => {
        for (let n = 1; n <= (o.bulk ?? 0); n += 1)
          addSession(db, uidOf(n), NOW - 10 * HOUR - n * 1000, `FIXTURE bulk ${String(n)}`);
      });
    }
    if (o.newerSchema === true) db.driver.exec('PRAGMA user_version = 9999');
    if (o.keepOpen === true) keep = db;
    else db.close();
  }
  const skillDir = defaultSkillDir();
  return {
    ws: resolveWorkspace(tasksRoot, 'demo'),
    dir,
    dbFile,
    ...(keep === undefined ? {} : { keep }),
    deps: { skillDir, runtimeDir: path.join(skillDir, 'runtime'), env: {}, clock: new FakeClock(NOW) },
  };
}

async function open(f: Fixture, instanceId: string = ID, stopped = false): Promise<InstanceReader> {
  const reader = await openDbReader(f.ws, instanceId, f.deps, { stopped });
  readers.push(reader);
  return reader;
}

async function failure(promise: Promise<unknown>): Promise<McsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

const reasonOf = (error: McsError): unknown => error.details?.['reason'];

describe('DbReader: the data', () => {
  it('lists the sessions newest first with the shape of the API page', async () => {
    const reader = await open(fixture());
    const page = await reader.sessions({ includeTotal: true, limit: 50, sort: 'lastActivity', range: 'all' } as never);
    expect(reader.mode).toBe('db');
    expect(page.items.map((s) => s.id)).toEqual([SESSION_NEW, SESSION_OLD]);
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]?.label).toBe('FIXTURE newer session');
  });

  it('pages through a large database with a keyset cursor, a page at a time', async () => {
    const reader = await open(fixture({ bulk: 1200 }));
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await reader.sessions({
        limit: 200,
        sort: 'lastActivity',
        range: 'all',
        ...(cursor === undefined ? {} : { cursor }),
      } as never);
      expect(page.items.length).toBeLessThanOrEqual(200);
      for (const item of page.items) seen.add(item.id);
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(1202);
    expect(pages).toBe(7);
  });

  it('returns a session with its audit references, and an empty list when there are none', async () => {
    const f = fixture();
    const reader = await open(f);
    const bare = await reader.session(SESSION_NEW);
    expect(bare?.id).toBe(SESSION_NEW);
    expect(bare?.auditRefs).toEqual([]);
    await appendChange(
      f.ws,
      {
        action: 'configure',
        summary: 'FIXTURE changed a setting',
        reason: null,
        files: [],
        validation: 'ok',
        outcome: 'ok',
      },
      NOW - (3 * HOUR) / 2,
    );
    const withRefs = await reader.session(SESSION_NEW);
    expect(withRefs?.auditRefs).toHaveLength(1);
    expect(withRefs?.auditRefs[0]).toMatchObject({ file: 'changes' });
    expect(typeof withRefs?.asOfSeq).toBe('number');
    // the older session is outside that time
    expect((await reader.session(SESSION_OLD))?.auditRefs).toEqual([]);
  });

  it('answers null for a session that does not exist and USAGE for text that is not an id', async () => {
    const reader = await open(fixture());
    expect(await reader.session('dddddddd-0000-4000-8000-000000000009')).toBeNull();
    expect((await failure(reader.session('nope'))).code).toBe('USAGE');
    expect((await failure(reader.sessionAgents('dddddddd-0000-4000-8000-000000000009', { limit: 10 }))).code).toBe(
      'NOT_FOUND',
    );
    expect(SessionIdSchema.safeParse(SESSION_NEW).success).toBe(true);
  });

  it('lists the stored errors newest first', async () => {
    const reader = await open(fixture());
    const items = await reader.errors({ limit: 50 });
    expect(items.map((e) => e.code)).toEqual(['LINE_INVALID', 'SEGMENT_TORN']);
    expect(items[0]).toMatchObject({ source: 'transcript', sessionId: SESSION_NEW });
    expect((await reader.errors({ limit: 50, source: ['spool'] })).map((e) => e.code)).toEqual(['SEGMENT_TORN']);
  });

  it('maps the refusals of the query layer to the errors of the API', async () => {
    const reader = await open(fixture());
    const range = await failure(reader.overview({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }));
    expect(range.code).toBe('USAGE');
    expect(reasonOf(range)).toBe('range_invalid');
    const cursor = await failure(reader.sessions({ limit: 10, sort: 'lastActivity', cursor: 'bogus' } as never));
    expect(cursor.code).toBe('USAGE');
    const missing = await failure(reader.explainCompletion({ sessionId: 'dddddddd-0000-4000-8000-000000000009' }));
    expect(missing.code).toBe('NOT_FOUND');
    expect(reasonOf(missing)).toBe('target_not_found');
    const invalid = await failure(reader.explainCompletion({ label: '' }));
    expect(invalid.code).toBe('USAGE');
    expect(reasonOf(invalid)).toBe('target_invalid');
    const found = await reader.explainCompletion({ sessionId: SESSION_NEW });
    expect(found.sessionId).toBe(SESSION_NEW);
    expect(found.outcome).toBe('not_terminal');
  });
});

describe('DbReader: it never writes', () => {
  /** What the folder holds besides the marker that `makeTemp` writes. */
  function leftovers(dir: string): string[] {
    return readdirSync(dir).filter((name) => name !== 'FIXTURE.md');
  }

  it('leaves every file of the workspace and the modification time of the database as they were, after every method', async () => {
    const f = fixture();
    const scratchRoot = makeTemp('db-reader-tmp').path;
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, scratchRoot);
    const sample = (): { tree: string; mtime: number; size: number } => ({
      tree: snapshotTree(f.dir),
      mtime: statSync(f.dbFile).mtimeMs,
      size: statSync(f.dbFile).size,
    });
    // taken before the reader exists: a read of a stopped instance leaves not even a -wal or -shm file behind
    const before = sample();
    const reader = await open(f, ID, true);
    const out = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const exportQuery: ExportQuery = {};
    const calls: Record<string, () => Promise<unknown>> = {
      sessions: () => reader.sessions({ limit: 50, sort: 'lastActivity', range: 'all' } as never),
      session: () => reader.session(SESSION_NEW),
      sessionAgents: () => reader.sessionAgents(SESSION_NEW, { limit: 10 }),
      sessionEvents: () => reader.sessionEvents(SESSION_NEW, { limit: 10, dir: 'desc' } as never),
      usage: () => reader.usage({ groupBy: 'model', limit: 10 } as never),
      series: () => reader.series({ bucket: 'day', tzOffsetMinutes: 0, groupBy: 'none' } as never),
      tools: () => reader.tools({ groupBy: 'tool', limit: 10 } as never),
      errors: () => reader.errors({ limit: 10 }),
      overview: () => reader.overview({}),
      alerts: () => reader.alerts({ status: ['open'], limit: 10 } as never),
      explainCompletion: () => reader.explainCompletion({ sessionId: SESSION_NEW }),
      searchTranscripts: () => reader.searchTranscripts({ q: 'zz', limit: 10, budgetMs: 500 }),
      searchTranscript: () => reader.searchTranscript({ session: SESSION_NEW, q: 'zz', limit: 10, budgetMs: 500 }),
      transcriptWindow: () => reader.transcriptWindow({ sessionId: SESSION_NEW, agent: 'main', after: -1 }),
      exportTo: () => reader.exportTo(exportQuery, out),
    };
    for (const [name, call] of Object.entries(calls)) {
      // a transcript that does not exist is an answer ("gone"), not a failure of the reader
      await call().catch((error: unknown) => {
        if (!(error instanceof McsError) || error.code !== 'NOT_FOUND') throw error;
      });
      expect(sample(), name).toEqual(before);
    }
    await reader.close();
    expect(sample()).toEqual(before);
    expect(leftovers(scratchRoot), 'the private copy is removed by close').toEqual([]);
  });

  it('makes the private copy only for the methods that need one', async () => {
    const f = fixture();
    const scratchRoot = makeTemp('db-reader-tmp').path;
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, scratchRoot);
    const reader = await open(f);
    await reader.sessions({ limit: 10, sort: 'lastActivity', range: 'all' } as never);
    await reader.exportTo(
      {},
      new Writable({
        write: (_c, _e, done) => {
          done();
        },
      }),
    );
    expect(leftovers(scratchRoot)).toEqual([]);
    await reader.searchTranscripts({ q: 'zz', limit: 10, budgetMs: 500 });
    expect(leftovers(scratchRoot)).toHaveLength(1);
    await reader.close();
    expect(leftovers(scratchRoot)).toEqual([]);
  });

  it('a second close is harmless', async () => {
    const reader = await open(fixture());
    await reader.close();
    await reader.close();
  });
});

describe('DbReader: what it refuses', () => {
  it('a database newer than the runtime is DB_NEWER_THAN_RUNTIME, and nothing is written', async () => {
    const f = fixture({ newerSchema: true });
    const before = snapshotTree(f.dir);
    const mtime = statSync(f.dbFile).mtimeMs;
    const error = await failure(openDbReader(f.ws, ID, f.deps, { stopped: true }));
    expect(error.code).toBe('DB_NEWER_THAN_RUNTIME');
    expect(snapshotTree(f.dir)).toBe(before);
    expect(statSync(f.dbFile).mtimeMs).toBe(mtime);
    // the same without the promise that nobody runs it: SQLite's own -wal and -shm files appear, nothing else changes
    expect((await failure(openDbReader(f.ws, ID, f.deps))).code).toBe('DB_NEWER_THAN_RUNTIME');
    expect(snapshotTree(f.dir, { exclude: ['data/monitor.db-wal', 'data/monitor.db-shm'] })).toBe(before);
    expect(statSync(f.dbFile).mtimeMs).toBe(mtime);
  });

  it('frames that wait in the -wal file of a database that is not closed are still read', async () => {
    const f = fixture({ keepOpen: true });
    const reader = await open(f, ID, true);
    const page = await reader.sessions({ limit: 50, sort: 'lastActivity', range: 'all' } as never);
    expect(page.items.map((item) => item.id)).toContain(SESSION_NEW);
    f.keep?.close();
  });

  it('the database of another instance is IDENTITY_MISMATCH (a reader never returns a row of another instance)', async () => {
    const f = fixture({ instanceId: OTHER });
    expect((await failure(openDbReader(f.ws, ID, f.deps))).code).toBe('IDENTITY_MISMATCH');
    const own = await open(f, OTHER);
    expect((await own.sessions({ limit: 50, sort: 'lastActivity', range: 'all' } as never)).items).toHaveLength(2);
  });

  it('a task that never ran has no database to read', async () => {
    const f = fixture({ noDatabase: true });
    const error = await failure(openDbReader(f.ws, ID, f.deps));
    expect(error.code).toBe('DB_ERROR');
    expect(reasonOf(error)).toBe('no_database');
    expect(error.hint).toContain('mcs start');
  });
});
