// `alert/upsert` frames over a real stream (03 9.1, 9.3, 10.3; WP-59, CR-WP-36-2): an alert written by the alert service reaches a
// client as a frame that carries the exact item (`AlertItem`) of that alert, also when the alert is older than the newest 200 of the
// list. The hydration reads it with `alertById`, one lookup by id, instead of looking through a page of the list.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest, type Server } from 'node:http';
import path from 'node:path';

import {
  alertContextOf,
  buildInstanceContext,
  createAlertService,
  defaultSkillDir,
  initWorkspace,
  type AlertResult,
  type InstanceContext,
  type Logger,
} from '@mcs/engine';
import {
  AlertItemSchema,
  AlertListQuerySchema,
  RUNTIME_VERSION,
  StreamChangeSchema,
  type AlertItem,
} from '@mcs/shared';
import { FakeClock, allocatePort, assertPortClosed, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp, createHttpServer } from '../src/app.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60_000;
const ID = '11111111-1111-4111-8111-111111111111';

interface Running {
  readonly ctx: InstanceContext;
  readonly clock: FakeClock;
  readonly port: number;
}

const openServers: { server: Server; port: number }[] = [];
const openContexts: InstanceContext[] = [];
const openClients: StreamClient[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close();
  for (const { server, port } of openServers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    await assertPortClosed(port);
  }
  for (const ctx of openContexts.splice(0)) ctx.db.close();
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

/** A real instance behind a real HTTP server on a FakeClock (the service and the stream share it). */
async function start(): Promise<Running> {
  const root = makeTemp('alert-stream').path;
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
  openContexts.push(ctx);
  const port = await allocatePort();
  const app = createApp({ ctx, port: () => port, nudge: () => undefined, task: null, validateResponses: true });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  openServers.push({ server, port });
  return { ctx, clock, port };
}

interface Frame {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: unknown;
}

/** A raw event stream client that keeps every frame it has seen. */
class StreamClient {
  readonly frames: Frame[] = [];
  private pending = '';
  private readonly req: ClientRequest;

  constructor(port: number) {
    this.req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v3/stream',
        method: 'GET',
        headers: { Host: `127.0.0.1:${String(port)}`, Accept: 'text/event-stream' },
        agent: false,
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (text: string) => {
          this.pending += text;
          for (let end = this.pending.indexOf('\n\n'); end >= 0; end = this.pending.indexOf('\n\n')) {
            const block = this.pending.slice(0, end);
            this.pending = this.pending.slice(end + 2);
            this.take(block);
          }
        });
        res.on('error', () => undefined);
      },
    );
    this.req.on('error', () => undefined);
    this.req.end();
  }

  private take(block: string): void {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      const colon = line.indexOf(': ');
      if (colon < 0) continue;
      const name = line.slice(0, colon);
      const value = line.slice(colon + 2);
      if (name === 'id') id = value;
      else if (name === 'event') event = value;
      else if (name === 'data') data.push(value);
    }
    if (data.length > 0) this.frames.push({ id, event, data: JSON.parse(data.join('\n')) as unknown });
  }

  hello(): boolean {
    return this.frames.some((frame) => frame.event === 'hello');
  }

  /** The `alert/upsert` frames that name `alertId`, in order. */
  alertFrames(alertId: number): { seq: number; data: AlertItem | null }[] {
    const out: { seq: number; data: AlertItem | null }[] = [];
    for (const frame of this.frames) {
      if (frame.event !== 'change') continue;
      const change = StreamChangeSchema.parse(frame.data);
      if (change.kind !== 'alert') continue;
      if (change.data?.id === alertId) out.push({ seq: change.seq, data: change.data });
    }
    return out;
  }

  close(): void {
    this.req.destroy();
  }
}

async function connected(run: Running): Promise<StreamClient> {
  const client = new StreamClient(run.port);
  openClients.push(client);
  await waitFor(() => client.hello(), { what: 'the hello frame', timeoutMs: 10_000 });
  return client;
}

function holds(title: string, over: Partial<AlertResult> = {}): AlertResult {
  return {
    holds: true,
    severity: 'warning',
    value: 1,
    title,
    detail: { n: 1 },
    sessionId: null,
    sessionUid: null,
    ...over,
  };
}

function listed(ctx: InstanceContext, limit: number): AlertItem[] {
  return ctx.queries.listAlerts(
    ctx.scope,
    AlertListQuerySchema.parse({ status: 'open,resolved', limit: String(limit) }),
  ).items;
}

describe('alert/upsert frames of a service-written alert', () => {
  it('carry the exact item of the alert when it opens, changes its severity and resolves', async () => {
    const run = await start();
    const service = createAlertService(alertContextOf(run.ctx));
    const client = await connected(run);

    expect(service.apply('hook_failing', 'instance', holds('Hook handler failing'), NOW)).toBe('opened');
    const id = run.ctx.queries.listAlerts(run.ctx.scope, AlertListQuerySchema.parse({})).items[0]?.id ?? 0;
    expect(id).toBeGreaterThan(0);
    await waitFor(() => client.alertFrames(id).length === 1, { what: 'the frame of the new alert' });

    // the same severity: no change row, no frame
    service.apply('hook_failing', 'instance', holds('Hook handler failing'), NOW + MIN);
    // a new severity: one more frame
    service.apply('hook_failing', 'instance', holds('Hook handler failing', { severity: 'critical' }), NOW + 2 * MIN);
    await waitFor(() => client.alertFrames(id).length === 2, { what: 'the frame of the severity change' });
    service.apply('hook_failing', 'instance', { ...holds(''), holds: false }, NOW + 3 * MIN);
    await waitFor(() => client.alertFrames(id).length === 3, { what: 'the frame of the resolution' });

    const frames = client.alertFrames(id);
    const exact = run.ctx.queries.alertById(run.ctx.scope, id);
    expect(exact).not.toBeNull();
    // a frame carries the state of the alert when it was sent: the item of the lookup at that moment, newest last
    const items = frames.map((frame) => AlertItemSchema.parse(frame.data));
    expect(items.map((item) => [item.status, item.severity, item.seq])).toEqual([
      ['open', 'warning', frames[0]?.seq],
      ['open', 'critical', frames[1]?.seq],
      ['resolved', 'critical', frames[2]?.seq],
    ]);
    expect(items[2]).toEqual(exact);
    expect(exact).toMatchObject({
      status: 'resolved',
      resolvedReason: 'condition_cleared',
      severity: 'critical',
      fireCount: 3,
    });
    // and the same item as the list route gives
    expect(listed(run.ctx, 10).find((item) => item.id === id)).toEqual(exact);
  });

  it('carry the session of a session scoped alert in the frame and in the item', async () => {
    const run = await start();
    const uid = 'dddddddd-0000-4000-8000-000000000001';
    const sessionId = run.ctx.db.driver
      .prepare(
        `INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at)
         VALUES (:uid, :t, :t, :t, :t)`,
      )
      .run({ uid, t: NOW - MIN }).lastInsertRowid;
    const service = createAlertService(alertContextOf(run.ctx));
    const client = await connected(run);
    service.apply(
      'hook_gap',
      uid,
      holds('Hooks missed 2 tool calls in this session', { sessionId, sessionUid: uid }),
      NOW,
    );
    const id = listed(run.ctx, 10)[0]?.id ?? 0;
    await waitFor(() => client.alertFrames(id).length === 1, { what: 'the frame of the session alert' });
    const frame = client.alertFrames(id)[0];
    expect(frame?.data).toMatchObject({ id, sessionId: uid, scope: { kind: 'session', key: uid } });
    const change = client.frames.find((f) => f.event === 'change' && StreamChangeSchema.parse(f.data).kind === 'alert');
    expect(StreamChangeSchema.parse(change?.data).sessionId).toBe(uid);
  });

  it('carry the exact item also for an alert older than the newest 200', async () => {
    const run = await start();
    const service = createAlertService(alertContextOf(run.ctx));
    // 260 alerts, one per error code, fired one second apart: the first one is the oldest by far
    for (let n = 0; n < 260; n += 1) {
      service.apply(
        'ingest_errors',
        `CODE_${String(n)}`,
        holds(`${String(n + 10)} CODE_${String(n)} errors in 10 min`),
        NOW + n * 1000,
      );
    }
    const first =
      run.ctx.db.driver.prepare<{ id: number }>("SELECT id FROM alerts WHERE scope_key = 'CODE_0'").get()?.id ?? 0;
    expect(first).toBeGreaterThan(0);
    // the old way of hydrating (look through the newest 200 of the list) cannot find it
    expect(listed(run.ctx, 200).map((item) => item.id)).not.toContain(first);

    const client = await connected(run);
    // the oldest alert clears: its resolution is announced after 259 newer alerts were written
    service.apply('ingest_errors', 'CODE_0', { ...holds(''), holds: false }, NOW + 400_000);
    await waitFor(() => client.alertFrames(first).length === 1, { what: 'the frame of the old alert' });
    const frame = client.alertFrames(first)[0];
    expect(frame?.data).not.toBeNull();
    expect(AlertItemSchema.parse(frame?.data)).toEqual(run.ctx.queries.alertById(run.ctx.scope, first));
    expect(frame?.data).toMatchObject({
      id: first,
      status: 'resolved',
      resolvedReason: 'condition_cleared',
      scope: { kind: 'code', key: 'CODE_0' },
      title: '10 CODE_0 errors in 10 min',
    });
  });
});
