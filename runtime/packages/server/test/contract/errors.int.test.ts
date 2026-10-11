// `GET /api/v3/errors` on a real instance (03 6.3, 19.3, DA-T-API-1): the stored ingest errors merged with the entries of the
// server error ring, newest first, with the filters of the query and the envelope of the errors the route raises.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  defaultSkillDir,
  initWorkspace,
  type InstanceContext,
  type Logger,
  type SqlValue,
} from '@mcs/engine';
import { ErrorEnvelopeSchema, RUNTIME_VERSION, routes } from '@mcs/shared';
import { FakeClock, allocatePort, assertPortClosed, httpRequest, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp, createHttpServer } from '../../src/app.ts';
import { readLegacyTask } from '../../src/routes/meta.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const MINUTE = 60_000;
const ID = '11111111-1111-4111-8111-111111111111';

interface Running {
  readonly ctx: InstanceContext;
  readonly port: number;
  readonly clock: FakeClock;
  readonly instanceDir: string;
}

const live: { server: Server; ctx: InstanceContext; port: number }[] = [];
afterEach(async () => {
  for (const { server, ctx, port } of live.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    ctx.db.close();
    await assertPortClosed(port);
  }
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

/** A real instance (workspace, database, query layer) behind a real HTTP server; response validation is on (registry N3). */
async function startInstance(): Promise<Running> {
  const root = makeTemp('contract-int').path;
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
  const port = await allocatePort();
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => undefined,
    task: await readLegacyTask(ws.dir),
    validateResponses: true,
  });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  live.push({ server, ctx, port });
  return { ctx, port, clock, instanceDir: ws.dir };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown;
}

async function get(run: Running, route: string): Promise<Reply> {
  const reply = await httpRequest(run.port, route);
  return { status: reply.status, headers: reply.headers, json: JSON.parse(reply.body) };
}

/** The `error.code` of an envelope, or `undefined` for a body that is not one. */
function codeOf(reply: Reply): string | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(reply.json);
  return parsed.success ? parsed.data.error.code : undefined;
}

function put(ctx: InstanceContext, table: string, row: Record<string, SqlValue>): number {
  const columns = Object.keys(row);
  return ctx.db.driver
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
    .run(row).lastInsertRowid;
}

const uidOf = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** The headers every `/api` answer has (DA-T-API-10). */
function expectApiHeaders(reply: Reply): void {
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
  expect(reply.headers['x-mcs-instance']).toBe(ID);
  expect(reply.headers['x-request-id']).toMatch(/^r-[0-9a-z]{12}$/);
}

function addError(ctx: InstanceContext, over: Record<string, SqlValue>): number {
  return put(ctx, 'ingest_errors', { at: NOW - MINUTE, source: 'spool', code: 'SPOOL_LINE_INVALID', ...over });
}

const ERRORS = '/api/v3/errors';

function parseErrors(reply: Reply): ReturnType<typeof routes.errors.response.parse> {
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  return routes.errors.response.parse(reply.json);
}

describe('GET /api/v3/errors', () => {
  it('answers a strict empty list and the headers of every API answer', async () => {
    const run = await startInstance();
    const reply = await get(run, ERRORS);
    expectApiHeaders(reply);
    expect(parseErrors(reply)).toEqual({ asOfSeq: run.ctx.db.headSeq(), items: [] });
  });

  it('merges the server error ring with the stored ingest errors, newest first', async () => {
    const run = await startInstance();
    addError(run.ctx, {
      at: NOW - 5 * MINUTE,
      source: 'transcript',
      code: 'TRANSCRIPT_READ_FAILED',
      detail: 'read failed',
    });
    addError(run.ctx, {
      at: NOW - 2 * MINUTE,
      source: 'spool',
      code: 'SPOOL_LINE_INVALID',
      segment: '0001.ndjson',
      session_uid: uidOf(1),
      detail: 'line 4 is not JSON',
    });
    // the ring takes the time of the clock: NOW
    run.ctx.errors.push({ source: 'server', code: 'INTERNAL', where: 'listSessions', message: 'unexpected error' });
    const page = parseErrors(await get(run, ERRORS));
    expect(page.items.map((item) => `${item.source}:${item.code}`)).toEqual([
      'server:INTERNAL',
      'spool:SPOOL_LINE_INVALID',
      'transcript:TRANSCRIPT_READ_FAILED',
    ]);
    expect(page.items[0]).toEqual({
      at: new Date(NOW).toISOString(),
      source: 'server',
      code: 'INTERNAL',
      where: 'listSessions',
      message: 'unexpected error',
      sessionId: null,
    });
    expect(page.items[1]).toEqual({
      at: new Date(NOW - 2 * MINUTE).toISOString(),
      source: 'spool',
      code: 'SPOOL_LINE_INVALID',
      where: '0001.ndjson',
      message: 'line 4 is not JSON',
      sessionId: uidOf(1),
    });
  });

  it('applies since, source and limit to the ring and to the stored rows', async () => {
    const run = await startInstance();
    addError(run.ctx, { at: NOW - 30 * MINUTE, code: 'OLD' });
    addError(run.ctx, { at: NOW - 10 * MINUTE, code: 'A' });
    addError(run.ctx, { at: NOW - 5 * MINUTE, source: 'writer', code: 'B' });
    run.ctx.errors.push({ source: 'server', code: 'INTERNAL', where: null, message: 'boom' });
    const codes = async (query: string): Promise<string[]> =>
      parseErrors(await get(run, `${ERRORS}?${query}`)).items.map((item) => item.code);
    const since = encodeURIComponent(new Date(NOW - 20 * MINUTE).toISOString());
    expect(await codes('limit=50')).toEqual(['INTERNAL', 'B', 'A', 'OLD']);
    expect(await codes(`since=${since}`)).toEqual(['INTERNAL', 'B', 'A']);
    expect(await codes('source=server')).toEqual(['INTERNAL']);
    expect(await codes('source=spool,writer')).toEqual(['B', 'A', 'OLD']);
    expect(await codes('limit=2')).toEqual(['INTERNAL', 'B']);
  });

  it('answers the envelope of the right code for a bad request', async () => {
    const run = await startInstance();
    const cases: [string, number, string][] = [
      [`${ERRORS}?source=disk`, 400, 'validation_failed'],
      [`${ERRORS}?limit=201`, 400, 'validation_failed'],
      [`${ERRORS}?since=yesterday`, 400, 'validation_failed'],
      [`${ERRORS}?source=spool&source=writer`, 400, 'param_repeated'],
    ];
    for (const [url, status, code] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([status, code]);
    }
  });
});
