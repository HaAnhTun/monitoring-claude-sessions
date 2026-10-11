// The transcript routes (03 6.1, 7.3): the window and the locate over a real database, the real query layer and real files. Real
// Express and sockets; every transcript is synthetic.
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  createQueries,
  defaultSkillDir,
  openInstanceDb,
  resolveConfig,
  type InstanceDb,
  type ResolvedConfig,
  type RuntimeProcessInfo,
} from '@mcs/engine';
import {
  RUNTIME_VERSION,
  TranscriptLocateResponseSchema,
  TranscriptWindowResponseSchema,
  type InstanceFile,
} from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, allocatePort, assertPortClosed, httpRequest, useTempDirs } from '@mcs/testkit';
import express, { type Express } from 'express';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { bindRouteServices, type AppContext } from '../route-adapter.ts';
import { transcriptRoutes } from './transcript.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111';
const SESSION = '55555555-5555-4555-8555-555555555555';
const T0 = FIXTURE_EPOCH_MS;
const LF = String.fromCharCode(10);

let config: ResolvedConfig;
beforeAll(async () => {
  config = await resolveConfig({ workspace: null, env: {}, cli: {}, skillDir: defaultSkillDir() });
});

const servers: { readonly server: Server; readonly port: number }[] = [];
const dbs: InstanceDb[] = [];
afterEach(async () => {
  const started = servers.splice(0);
  await Promise.all(
    started.map(
      ({ server }) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  for (const { port } of started) await assertPortClosed(port);
  for (const db of dbs.splice(0)) db.close();
});

const INSTANCE: InstanceFile = {
  schema_version: 1,
  instanceId: ID,
  slug: 'demo',
  createdAt: '2026-10-11T14:00:00Z',
  createdBy: `mcs ${RUNTIME_VERSION}`,
  runtimeVersion: RUNTIME_VERSION,
  dbSchemaVersion: 1,
  engine: 'node',
  hooks: { enabled: false },
  upgradedAt: null,
};

function fakeProcess(): RuntimeProcessInfo {
  return {
    pid: 4242,
    startedAtMs: T0,
    runtimeVersion: RUNTIME_VERSION,
    bootCodeStamp: 'abcdef0123',
    previousRunUnclean: false,
    phase: () => 'ready',
    outdated: () => ({ outdated: false, reason: null }),
    ownershipConflict: () => false,
  };
}

const stamp = (n: number): string => new Date(T0 + n * 1000).toISOString();
const userLine = (n: number, text = `FIXTURE prompt ${String(n)}`): string =>
  JSON.stringify({ type: 'user', timestamp: stamp(n), message: { content: text } });
const assistantLine = (n: number): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: stamp(n),
    message: {
      content: [
        { type: 'thinking', thinking: `FIXTURE thought ${String(n)}` },
        { type: 'text', text: `FIXTURE answer ${String(n)}` },
        { type: 'tool_use', id: `toolu_${String(n)}`, name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
const LINES = [userLine(0), assistantLine(1), userLine(2), assistantLine(3), userLine(4)];
// entries: 0 prompt, 1 think, 2 say, 3 tool, 4 prompt, 5 think, 6 say, 7 tool, 8 prompt

interface Served {
  readonly port: number;
  readonly transcript: string;
  readonly db: InstanceDb;
}

/** A real database with one session and its transcript file, the real query layer and the two routes. */
async function serve(
  opts: { session?: boolean; file?: 'present' | 'absent' | 'untracked'; lines?: readonly string[] } = {},
): Promise<Served> {
  const dir = makeTemp('transcript-routes').path;
  const clock = new FakeClock(T0);
  const db = openInstanceDb({
    path: path.join(dir, 'monitor.db'),
    expectedInstanceId: ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  dbs.push(db);
  const transcript = path.join(dir, 'projects', `${SESSION}.jsonl`);
  mkdirSync(path.dirname(transcript), { recursive: true });
  if (opts.session !== false) {
    db.driver
      .prepare(
        'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run([SESSION, T0, T0, T0, T0]);
  }
  if (opts.file !== 'untracked') {
    db.driver
      .prepare(
        "INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at) VALUES (?, ?, 'session', ?, ?, ?)",
      )
      .run([transcript, transcript, SESSION, T0, T0]);
  }
  if (opts.file !== 'absent') {
    writeFileSync(transcript, (opts.lines ?? LINES).map((line) => `${line}${LF}`).join(''));
  }
  const errors: AppContext['errors'] = { push: () => undefined, list: () => [] };
  const logger: AppContext['logger'] = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
  const ctx: AppContext = {
    instanceId: ID,
    slug: 'demo',
    clock,
    scope: { instanceId: ID },
    queries: createQueries(db, {
      config,
      now: () => clock.now(),
      audit: { entriesBetween: () => Promise.resolve([]) },
    }),
    errors,
    logger,
    process: fakeProcess(),
    config,
    instance: INSTANCE,
  };
  const app: Express = express();
  bindRouteServices(app, { errors, logger, validateResponses: true });
  transcriptRoutes(app, { ctx, nudge: () => undefined, task: null });
  const port = await allocatePort();
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(port, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  servers.push({ server, port });
  return { port, transcript, db };
}

const url = (suffix: string, session = SESSION): string => `/api/v3/sessions/${session}/transcript${suffix}`;

async function get(served: Served, suffix: string, session = SESSION): Promise<{ status: number; body: unknown }> {
  const reply = await httpRequest(served.port, url(suffix, session));
  return { status: reply.status, body: JSON.parse(reply.body) as unknown };
}

function errorCode(body: unknown): unknown {
  return (body as { error?: { code?: unknown } }).error?.code;
}

describe('transcriptWindow', () => {
  it('answers the tail of the main transcript in the contract shape, without thinking by default', async () => {
    const served = await serve();
    const { status, body } = await get(served, '');
    expect(status).toBe(200);
    const window = TranscriptWindowResponseSchema.parse(body);
    expect(window).toMatchObject({
      sessionId: SESSION,
      agentId: 'main',
      total: 9,
      base: 0,
      from: 0,
      next: 9,
      partial: false,
      skippedBytes: 0,
      pendingBytes: 0,
      fileState: 'active',
    });
    expect(window.events.map((e) => [e.i, e.k])).toEqual([
      [0, 'prompt'],
      [2, 'say'],
      [3, 'tool'],
      [4, 'prompt'],
      [6, 'say'],
      [7, 'tool'],
      [8, 'prompt'],
    ]);
    expect(window.events[2]).toMatchObject({ name: 'Bash', summary: 'ls', input: '{"command": "ls"}', id: 'toolu_1' });
  });

  it('takes `after`, `limit`, `thinking` and `textChars` from the query', async () => {
    const served = await serve({ lines: [userLine(0, 'x'.repeat(300)), assistantLine(1), userLine(2)] });
    const window = TranscriptWindowResponseSchema.parse(
      (await get(served, '?after=0&limit=2&thinking=1&textChars=200')).body,
    );
    expect(window).toMatchObject({ total: 5, from: 0, next: 2 });
    expect(window.events.map((e) => e.k)).toEqual(['prompt', 'think']);
    expect(window.events[0]?.text).toBe(`${'x'.repeat(200)} ... [truncated 100 chars]`);
  });

  it('refuses a query the schema does not accept', async () => {
    const served = await serve();
    for (const suffix of [
      '?limit=0',
      '?limit=5000',
      '?textChars=10',
      '?after=-2',
      '?thinking=0',
      '?bogus=1',
      '?limit=1&limit=2',
    ]) {
      const { status, body } = await get(served, suffix);
      expect(status, suffix).toBe(400);
      expect(['validation_failed', 'param_repeated']).toContain(errorCode(body));
    }
    expect((await get(served, '', 'not-a-session')).status).toBe(400);
  });

  it('answers 404 for a session and an agent the monitor does not know', async () => {
    const served = await serve();
    const other = '66666666-6666-4666-8666-666666666666';
    expect(await get(served, '', other)).toMatchObject({ status: 404, body: { error: { code: 'session_not_found' } } });
    expect(await get(served, '?agent=a9f8e7d6c5b4a3921')).toMatchObject({
      status: 404,
      body: { error: { code: 'agent_not_found' } },
    });
  });

  it('answers 404 agent_not_found for a session without any transcript file', async () => {
    const served = await serve({ file: 'untracked' });
    expect(await get(served, '')).toMatchObject({ status: 404, body: { error: { code: 'agent_not_found' } } });
  });

  it('answers 410 transcript_gone when the file is gone', async () => {
    const served = await serve({ file: 'absent' });
    expect(await get(served, '')).toMatchObject({ status: 410, body: { error: { code: 'transcript_gone' } } });
  });

  it('answers total 0 after the file was replaced by another one', async () => {
    const served = await serve();
    await get(served, '');
    writeFileSync(served.transcript, [userLine(500), userLine(501)].map((line) => `${line}${LF}`).join(''));
    const window = TranscriptWindowResponseSchema.parse((await get(served, '')).body);
    expect(window).toMatchObject({ total: 0, next: 0, events: [] });
    expect(TranscriptWindowResponseSchema.parse((await get(served, '')).body).total).toBe(2);
  });

  it('keeps the error envelope free of the file path', async () => {
    const served = await serve({ file: 'absent' });
    const reply = await httpRequest(served.port, url(''));
    expect(reply.body).not.toContain(path.basename(served.transcript));
    expect(reply.body).not.toContain('projects');
  });
});

describe('transcriptLocate', () => {
  it('finds an entry by index, time and byte offset', async () => {
    const served = await serve();
    const second = Buffer.byteLength(LINES[0] ?? '') + 1;
    const byIndex = TranscriptLocateResponseSchema.parse((await get(served, '/locate?i=3')).body);
    expect(byIndex).toEqual({ i: 3, t: stamp(1), base: 0, total: 9 });
    const byTime = TranscriptLocateResponseSchema.parse(
      (await get(served, `/locate?ts=${encodeURIComponent(stamp(2))}`)).body,
    );
    expect(byTime).toEqual({ i: 4, t: stamp(2), base: 0, total: 9 });
    const byOffset = TranscriptLocateResponseSchema.parse((await get(served, `/locate?offset=${String(second)}`)).body);
    expect(byOffset).toEqual({ i: 1, t: stamp(1), base: 0, total: 9 });
  });

  it('clamps an index past the end to the last entry', async () => {
    const served = await serve();
    expect(TranscriptLocateResponseSchema.parse((await get(served, '/locate?i=999')).body).i).toBe(8);
    expect(TranscriptLocateResponseSchema.parse((await get(served, '/locate?i=-5')).body).i).toBe(0);
  });

  it('wants exactly one of i, ts and offset', async () => {
    const served = await serve();
    for (const suffix of ['/locate', '/locate?i=1&offset=2', `/locate?i=1&ts=${encodeURIComponent(stamp(1))}`]) {
      const { status, body } = await get(served, suffix);
      expect(status, suffix).toBe(400);
      expect(errorCode(body)).toBe('validation_failed');
    }
  });

  it('answers 404 event_not_found for a transcript without entries and the other refusals like the window', async () => {
    const empty = await serve({ lines: [JSON.stringify({ type: 'system', timestamp: stamp(0) })] });
    expect(await get(empty, '/locate?i=0')).toMatchObject({
      status: 404,
      body: { error: { code: 'event_not_found' } },
    });
    const gone = await serve({ file: 'absent' });
    expect(await get(gone, '/locate?i=0')).toMatchObject({ status: 410, body: { error: { code: 'transcript_gone' } } });
    const served = await serve();
    expect(await get(served, '/locate?i=0&agent=a9f8e7d6c5b4a3921')).toMatchObject({
      status: 404,
      body: { error: { code: 'agent_not_found' } },
    });
  });
});
