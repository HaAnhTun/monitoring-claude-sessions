// The ingest routes on a real instance (03 19.3): DA-T-API-5 (the nudge and every refusal of 02 2.8 and 05 5.3 S-NET-5) and
// DA-T-API-14 (the probe route, I-37). A real workspace, a real database, the real guards and a real HTTP server.
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  createInstanceRuntime,
  defaultSkillDir,
  initWorkspace,
  withWriteTx,
  type InstanceContext,
  type InstanceRuntime,
  type Logger,
} from '@mcs/engine';
import { ErrorEnvelopeSchema, HookProbeResultSchema, RUNTIME_VERSION, isoMsZ, type ErrorCode } from '@mcs/shared';
import { spoolSegmentName, type HookEnvelopeV1 } from '@mcs/shared/protocol';
import { allocatePort, assertPortClosed, FakeClock, httpRequest, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp, createHttpServer } from '../src/app.ts';
import { readLegacyTask } from '../src/routes/meta.ts';

/** The reply of the HTTP helper of the testkit (its type is not exported). */
type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const PROBE = '00000000-0000-4000-8000-0000000000a1';
const NUDGE = '/api/v3/ingest/nudge';
const JSON_TYPE = { 'Content-Type': 'application/json' };

interface Running {
  readonly ctx: InstanceContext;
  readonly port: number;
  readonly nudges: number[];
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

async function startInstance(): Promise<Running> {
  const root = makeTemp('ingest-int').path;
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
  const nudges: number[] = [];
  const port = await allocatePort();
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => {
      nudges.push(1);
    },
    task: await readLegacyTask(ws.dir),
  });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  live.push({ server, ctx, port });
  return { ctx, port, nudges };
}

function codeOf(reply: HttpReply): ErrorCode {
  return ErrorEnvelopeSchema.parse(JSON.parse(reply.body)).error.code;
}

function nudge(
  run: Running,
  body: string,
  over: { headers?: Record<string, string>; origin?: string; host?: string } = {},
): Promise<HttpReply> {
  return httpRequest(run.port, NUDGE, {
    method: 'POST',
    headers: over.headers ?? JSON_TYPE,
    body,
    ...(over.origin === undefined ? {} : { origin: over.origin }),
    ...(over.host === undefined ? {} : { host: over.host }),
  });
}

/** A valid nudge body padded with spaces (valid JSON) to exactly `bytes` bytes. */
function paddedNudge(bytes: number): string {
  const body = JSON.stringify({ instanceId: ID });
  return body + ' '.repeat(bytes - Buffer.byteLength(body));
}

describe('DA-T-API-5: the nudge (02 2.8)', () => {
  it('answers 204 with no body and schedules one drain', async () => {
    const run = await startInstance();
    const reply = await nudge(run, JSON.stringify({ instanceId: ID }));
    expect(reply.status).toBe(204);
    expect(reply.body).toBe('');
    expect(reply.headers['content-type']).toBeUndefined();
    expect(reply.headers['x-mcs-instance']).toBe(ID);
    expect(run.nudges).toHaveLength(1);
  });

  it('accepts a body of exactly 256 bytes and refuses 257 with 413 payload_too_large', async () => {
    const run = await startInstance();
    expect((await nudge(run, paddedNudge(256))).status).toBe(204);
    const large = await nudge(run, paddedNudge(257));
    expect(large.status).toBe(413);
    expect(codeOf(large)).toBe('payload_too_large');
    expect(run.nudges).toHaveLength(1);
  });

  it('refuses a very large body at once, and one that is not a JSON content type with 415', async () => {
    const run = await startInstance();
    const huge = await nudge(run, `{"instanceId":"${ID}","pad":"${'x'.repeat(100_000)}"}`);
    expect(huge.status).toBe(413);
    for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/jsonx' }, {}]) {
      const reply = await nudge(run, JSON.stringify({ instanceId: ID }), { headers });
      expect(reply.status, JSON.stringify(headers)).toBe(415);
      expect(codeOf(reply)).toBe('unsupported_media_type');
    }
    expect(run.nudges).toEqual([]);
  });

  it('refuses any Origin header, even an allowed one, with 403 origin_not_allowed', async () => {
    const run = await startInstance();
    for (const origin of [
      `http://127.0.0.1:${String(run.port)}`,
      `http://localhost:${String(run.port)}`,
      'null',
      'http://evil.example',
    ]) {
      const reply = await nudge(run, JSON.stringify({ instanceId: ID }), { origin });
      expect(reply.status, origin).toBe(403);
      expect(codeOf(reply), origin).toBe('origin_not_allowed');
    }
    expect(run.nudges).toEqual([]);
  });

  it('refuses another instance id with 409 instance_mismatch, and a body of the wrong shape or text', async () => {
    const run = await startInstance();
    const other = await nudge(run, JSON.stringify({ instanceId: OTHER_ID }));
    expect(other.status).toBe(409);
    expect(codeOf(other)).toBe('instance_mismatch');
    for (const body of ['{ not json', '', '{"instanceId":']) {
      const reply = await nudge(run, body);
      expect(reply.status, body).toBe(400);
      expect(codeOf(reply), body).toBe('body_invalid_json');
    }
    for (const body of [
      '{}',
      '[]',
      'null',
      '{"instanceId":5}',
      '{"instanceId":"nope"}',
      `{"instanceId":"${ID}","extra":1}`,
    ]) {
      const reply = await nudge(run, body);
      expect(reply.status, body).toBe(400);
      expect(codeOf(reply), body).toBe('validation_failed');
    }
    expect(run.nudges).toEqual([]);
  });

  it('applies the guards of every request: Host, fetch metadata', async () => {
    const run = await startInstance();
    const body = JSON.stringify({ instanceId: ID });
    expect(codeOf(await nudge(run, body, { host: 'evil.example' }))).toBe('host_not_allowed');
    for (const site of ['cross-site', 'same-site']) {
      const reply = await nudge(run, body, { headers: { ...JSON_TYPE, 'Sec-Fetch-Site': site } });
      expect(reply.status, site).toBe(403);
      expect(codeOf(reply), site).toBe('cross_site_request');
    }
    const sameOrigin = await nudge(run, body, { headers: { ...JSON_TYPE, 'Sec-Fetch-Site': 'none' } });
    expect(sameOrigin.status).toBe(204);
    expect(run.nudges).toHaveLength(1);
  });

  it('answers any other method on the nudge path with 405 and Allow: POST, and any other POST with 404 or 405', async () => {
    const run = await startInstance();
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const reply = await httpRequest(run.port, NUDGE, { method });
      expect(reply.status, method).toBe(405);
      expect(reply.headers['allow'], method).toBe('POST');
    }
    const known = await httpRequest(run.port, '/api/v3/health', { method: 'POST', headers: JSON_TYPE, body: '{}' });
    expect(known.status).toBe(405);
    // monotone: `/api/v3/sessions` is a registry path that a later work package mounts (then a POST answers 405)
    const unknown = await httpRequest(run.port, '/api/v3/sessions', { method: 'POST', headers: JSON_TYPE, body: '{}' });
    expect([404, 405]).toContain(unknown.status);
    expect(codeOf(unknown)).toBe(unknown.status === 404 ? 'route_not_found' : 'method_not_allowed');
    expect(run.nudges).toEqual([]);
  });

  it('writes nothing to the database: no change, no session, no event', async () => {
    const run = await startInstance();
    const head = run.ctx.db.headSeq();
    await nudge(run, JSON.stringify({ instanceId: ID }));
    expect(run.ctx.db.headSeq()).toBe(head);
    for (const table of ['sessions', 'events']) {
      const row = run.ctx.db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get();
      expect(row?.n, table).toBe(0);
    }
  });
});

describe('DA-T-API-14: the probe route (I-37)', () => {
  function insertProbe(run: Running, id: string, receivedAt: number, committedAt: number): void {
    withWriteTx(run.ctx.db, run.ctx.scope, () => {
      run.ctx.db.driver
        .prepare(
          'INSERT INTO hook_probes (probe_session_id, received_at, committed_at) VALUES (:id, :receivedAt, :committedAt)',
        )
        .run({ id, receivedAt, committedAt });
    });
  }

  it('answers receivedAt and committedAt of a committed probe, committedAt not before receivedAt', async () => {
    const run = await startInstance();
    insertProbe(run, PROBE, NOW - 40, NOW);
    const reply = await httpRequest(run.port, `/api/v3/ingest/probes/${PROBE}`);
    expect(reply.status).toBe(200);
    const body = HookProbeResultSchema.parse(JSON.parse(reply.body));
    expect(body).toEqual({ receivedAt: isoMsZ(NOW - 40), committedAt: isoMsZ(NOW) });
    expect(Date.parse(body.committedAt)).toBeGreaterThanOrEqual(Date.parse(body.receivedAt));
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('answers 404 probe_not_found for an id that was not committed, until it is', async () => {
    const run = await startInstance();
    const missing = await httpRequest(run.port, `/api/v3/ingest/probes/${PROBE}`);
    expect(missing.status).toBe(404);
    expect(codeOf(missing)).toBe('probe_not_found');
    insertProbe(run, PROBE, NOW - 10, NOW);
    expect((await httpRequest(run.port, `/api/v3/ingest/probes/${PROBE}`)).status).toBe(200);
  });

  it('answers 400 validation_failed for a session id, an upper-case probe id or any other text', async () => {
    const run = await startInstance();
    for (const id of [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '00000000-0000-4000-8000-0000000000A1',
      '00000000-0000-4000-8000-0000000000a',
      'x',
      '%20',
      '..%2F..%2Fdata',
    ]) {
      const reply = await httpRequest(run.port, `/api/v3/ingest/probes/${id}`);
      expect(reply.status, id).toBe(400);
      expect(codeOf(reply), id).toBe('validation_failed');
    }
  });

  it('changes no session, event or counter', async () => {
    const run = await startInstance();
    insertProbe(run, PROBE, NOW - 10, NOW);
    const head = run.ctx.db.headSeq();
    await httpRequest(run.port, `/api/v3/ingest/probes/${PROBE}`);
    await httpRequest(run.port, `/api/v3/ingest/probes/${PROBE.replace('a1', 'a2')}`);
    expect(run.ctx.db.headSeq()).toBe(head);
    for (const table of ['sessions', 'events', 'agents', 'tool_calls']) {
      const row = run.ctx.db.driver.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get();
      expect(row?.n, table).toBe(0);
    }
  });
});

// ---- the nudge reaches the ingest service (CR-WP-17-4, CR-WP-18-3) ----------------------------------------------------------------

/** The longest spool poll the configuration allows: nothing but the nudge can make a new line visible quickly. */
const MAX_POLL_MS = 10_000;

interface RealRun {
  readonly ctx: InstanceContext;
  readonly runtime: InstanceRuntime;
  readonly port: number;
  readonly spoolDir: string;
}

const realRuns: { server: Server; ctx: InstanceContext; runtime: InstanceRuntime; port: number }[] = [];
afterEach(async () => {
  for (const { server, ctx, runtime, port } of realRuns.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    await runtime.stop(Date.now() + 5000);
    ctx.db.close();
    await ctx.logger.close();
    await assertPortClosed(port);
  }
});

/** A real instance with the real ingest service behind `runtime.nudge()`, the way `boot.ts` wires the app. */
async function startRealInstance(): Promise<RealRun> {
  const root = makeTemp('ingest-nudge').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', newId: () => ID });
  writeFileSync(
    path.join(ws.dir, 'runtime.json'),
    JSON.stringify({ schema_version: 1, spool: { pollMs: MAX_POLL_MS } }),
  );
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    logger: silentLogger(),
  });
  const runtime = createInstanceRuntime(ctx);
  await runtime.start();
  const port = await allocatePort();
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => {
      runtime.nudge();
    },
    task: await readLegacyTask(ws.dir),
    runtime,
  });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  realRuns.push({ server, ctx, runtime, port });
  return { ctx, runtime, port, spoolDir: path.join(ctx.instanceDir, 'data', 'spool') };
}

/** One `SessionStart` line of the hook handler (02 2.4), appended to the segment of its hour. */
function appendSessionStart(run: RealRun): string {
  const sessionId = randomUUID();
  const receivedAt = Date.now();
  const envelope: HookEnvelopeV1 = {
    v: 1,
    kind: 'hook',
    instance_id: ID,
    event_uid: randomUUID(),
    received_at: receivedAt,
    event: 'SessionStart',
    argv_event: 'SessionStart',
    session_id: sessionId,
    transcript_path: null,
    cwd: null,
    prompt_id: null,
    agent_id: null,
    agent_type: null,
    tool_use_id: null,
    permission_mode: 'default',
    claude_pid: null,
    payload_bytes: 2,
    content_hash: '0123456789abcdef0123456789abcdef',
    handler: { version: RUNTIME_VERSION, pid: 100, async: false },
    flags: [],
    data: { source: 'startup', model: 'FIXTURE-model' },
  };
  mkdirSync(run.spoolDir, { recursive: true });
  appendFileSync(path.join(run.spoolDir, spoolSegmentName(receivedAt)), `${JSON.stringify(envelope)}\n`);
  return sessionId;
}

function sessionCount(run: RealRun): number {
  return run.ctx.db.driver.prepare<{ n: number }>('SELECT count(*) AS n FROM sessions').get({})?.n ?? -1;
}

describe('the nudge drains the spool at once (CR-WP-17-4, CR-WP-18-3)', () => {
  it('commits a spool line within 1 s of POST /ingest/nudge although the poll interval is 10 s', async () => {
    const run = await startRealInstance();
    expect(run.ctx.config.runtime.spool.pollMs).toBe(MAX_POLL_MS);
    expect(sessionCount(run)).toBe(0);
    appendSessionStart(run);
    // the poll is ten seconds away, so only the nudge below can explain a commit inside the budget of one second
    expect(sessionCount(run)).toBe(0);
    const startedAt = Date.now();
    const reply = await httpRequest(run.port, NUDGE, {
      method: 'POST',
      headers: JSON_TYPE,
      body: JSON.stringify({ instanceId: ID }),
    });
    expect(reply.status).toBe(204);
    await waitFor(() => sessionCount(run) === 1, { timeoutMs: 1000, intervalMs: 20, what: 'the session of the nudge' });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
