// `errors` (03 6.1, 6.3, 12.1): the rows of `ingest_errors` as `ErrorItem`s, newest first, with the `since`, `source` and
// `limit` filters; `mergeServerErrors` adds the server error ring (source `server`) for a running server. Rows are written
// with plain SQL: the query reads whatever the ingestion wrote.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  ErrorsQuerySchema,
  ErrorsResponseSchema,
  RUNTIME_VERSION,
  type ErrorItem,
  type ErrorsQuery,
} from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { SqlValue } from '../db/driver.ts';
import { isDbError } from '../db/errors.ts';
import type { Logger } from '../log/logger.ts';
import { buildInstanceContext, type InstanceContext } from '../runtime/context.ts';
import { initWorkspace } from '../workspace/init.ts';
import { mergeServerErrors } from './errors.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const MINUTE = 60_000;
const ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const opened: InstanceContext[] = [];
afterEach(() => {
  for (const ctx of opened.splice(0)) ctx.db.close();
});

function silentLogger(): Logger {
  const none = (): void => undefined;
  return {
    debug: none,
    info: none,
    warn: none,
    error: none,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

/** A real instance (workspace, database, query layer) in a temp folder; the clock is fixed at `NOW`. */
async function instance(): Promise<InstanceContext> {
  const root = makeTemp('q-errors').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => ID });
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: silentLogger(),
  });
  opened.push(ctx);
  return ctx;
}

function put(ctx: InstanceContext, row: Record<string, SqlValue>): number {
  const columns = Object.keys(row);
  return ctx.db.driver
    .prepare(`INSERT INTO ingest_errors (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
    .run(row).lastInsertRowid;
}

const SESSION = 'cccccccc-0000-4000-8000-000000000001';

function query(params: Record<string, string> = {}): ErrorsQuery {
  return ErrorsQuerySchema.parse(params);
}

function ringItem(minutesAgo: number, over: Partial<ErrorItem> = {}): ErrorItem {
  return {
    at: new Date(NOW - minutesAgo * MINUTE).toISOString(),
    source: 'server',
    code: 'INTERNAL',
    where: 'listSessions',
    message: 'unexpected error in the HTTP layer',
    sessionId: null,
    ...over,
  };
}

describe('errors', () => {
  it('answers an empty list with the change-log head', async () => {
    const ctx = await instance();
    const reply = ctx.queries.errors(ctx.scope, query());
    expect(ErrorsResponseSchema.parse(reply)).toEqual({ asOfSeq: ctx.db.headSeq(), items: [] });
  });

  it('lists the rows newest first as ErrorItems', async () => {
    const ctx = await instance();
    put(ctx, { at: NOW - 3 * MINUTE, source: 'transcript', code: 'TRANSCRIPT_READ_FAILED', detail: 'read failed' });
    put(ctx, {
      at: NOW - MINUTE,
      source: 'spool',
      code: 'SPOOL_LINE_INVALID',
      segment: '0001.ndjson',
      session_uid: SESSION,
      detail: 'line 4 is not JSON',
    });
    put(ctx, { at: NOW - 2 * MINUTE, source: 'writer', code: 'DB_BUSY' });
    const reply = ErrorsResponseSchema.parse(ctx.queries.errors(ctx.scope, query()));
    expect(reply.items.map((item) => item.code)).toEqual(['SPOOL_LINE_INVALID', 'DB_BUSY', 'TRANSCRIPT_READ_FAILED']);
    expect(reply.items[0]).toEqual({
      at: new Date(NOW - MINUTE).toISOString(),
      source: 'spool',
      code: 'SPOOL_LINE_INVALID',
      where: '0001.ndjson',
      message: 'line 4 is not JSON',
      sessionId: SESSION,
    });
    // a row without a detail still has a message (its code) and no place
    expect(reply.items[1]).toMatchObject({ where: null, message: 'DB_BUSY', sessionId: null });
  });

  it('breaks a tie of the time by the newer row', async () => {
    const ctx = await instance();
    const first = put(ctx, { at: NOW, source: 'db', code: 'FIRST' });
    const second = put(ctx, { at: NOW, source: 'db', code: 'SECOND' });
    expect(second).toBeGreaterThan(first);
    const codes = ctx.queries.errors(ctx.scope, query()).items.map((item) => item.code);
    expect(codes).toEqual(['SECOND', 'FIRST']);
  });

  it('filters by since, source and limit', async () => {
    const ctx = await instance();
    put(ctx, { at: NOW - 30 * MINUTE, source: 'spool', code: 'OLD' });
    put(ctx, { at: NOW - 20 * MINUTE, source: 'spool', code: 'A' });
    put(ctx, { at: NOW - 10 * MINUTE, source: 'transcript', code: 'B' });
    put(ctx, { at: NOW - 5 * MINUTE, source: 'spool', code: 'C' });
    const since = new Date(NOW - 25 * MINUTE).toISOString();
    const codes = (params: Record<string, string>): string[] =>
      ctx.queries.errors(ctx.scope, query(params)).items.map((item) => item.code);
    expect(codes({ since })).toEqual(['C', 'B', 'A']);
    expect(codes({ since, source: 'spool' })).toEqual(['C', 'A']);
    expect(codes({ source: 'transcript,db' })).toEqual(['B']);
    expect(codes({ limit: '2' })).toEqual(['C', 'B']);
  });

  it('has no server rows in the database: source server alone is empty', async () => {
    const ctx = await instance();
    put(ctx, { at: NOW, source: 'spool', code: 'A' });
    expect(ctx.queries.errors(ctx.scope, query({ source: 'server' })).items).toEqual([]);
  });

  it('refuses a caller of another instance', async () => {
    const ctx = await instance();
    let code: string | undefined;
    try {
      ctx.queries.errors(FOREIGN, query());
    } catch (error) {
      code = isDbError(error) ? error.code : 'other';
    }
    expect(code).toBe('scope_mismatch');
  });

  it('never writes', async () => {
    const ctx = await instance();
    put(ctx, { at: NOW, source: 'spool', code: 'A' });
    ctx.db.driver.pragma('wal_checkpoint(TRUNCATE)');
    const before = readFileSync(ctx.db.driver.path);
    ctx.queries.errors(ctx.scope, query());
    ctx.db.driver.pragma('wal_checkpoint(TRUNCATE)');
    expect(readFileSync(ctx.db.driver.path).equals(before)).toBe(true);
  });
});

describe('mergeServerErrors', () => {
  const stored: ErrorItem[] = [
    ringItem(1, { source: 'spool', code: 'S1', where: null }),
    ringItem(4, { source: 'transcript', code: 'T1', where: null }),
  ];

  it('interleaves the ring with the stored rows, newest first', () => {
    const ring = [ringItem(0, { code: 'INTERNAL' }), ringItem(2, { code: 'INTERNAL' })];
    const merged = mergeServerErrors(ring, stored, query());
    expect(merged.map((item) => `${item.source}:${item.code}`)).toEqual([
      'server:INTERNAL',
      'spool:S1',
      'server:INTERNAL',
      'transcript:T1',
    ]);
  });

  it('applies since, source and limit to the ring as well', () => {
    const ring = [ringItem(0), ringItem(2), ringItem(30)];
    const since = new Date(NOW - 10 * MINUTE).toISOString();
    expect(mergeServerErrors(ring, stored, query({ since })).map((item) => item.at)).toEqual([
      ring[0]?.at,
      stored[0]?.at,
      ring[1]?.at,
      stored[1]?.at,
    ]);
    expect(mergeServerErrors(ring, stored, query({ source: 'spool' }))).toEqual([stored[0]]);
    expect(mergeServerErrors(ring, stored, query({ source: 'server', limit: '2' }))).toEqual([ring[0], ring[1]]);
    expect(mergeServerErrors(ring, stored, query({ limit: '1' }))).toEqual([ring[0]]);
  });

  it('puts the server entry first when the times are equal and does not change its inputs', () => {
    const ring = [ringItem(1)];
    const same = [ringItem(1, { source: 'spool', code: 'S1' })];
    const before = JSON.stringify([ring, same]);
    expect(mergeServerErrors(ring, same, query()).map((item) => item.source)).toEqual(['server', 'spool']);
    expect(JSON.stringify([ring, same])).toBe(before);
  });
});
