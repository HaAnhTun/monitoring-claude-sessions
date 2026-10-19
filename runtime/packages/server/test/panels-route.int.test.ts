// `GET /api/v3/panels/:key` on a real instance (06 3.4, 3.11; WP-41): a real workspace, database and runtime (the real panel
// service), the real guards and error mapper, and a real HTTP server. Every enabled panel answers a body that parses with
// `PanelResponseSchema`; a disabled panel is 404 `panel_disabled`; a bad key or query is 400; the headers are the API's; an app
// without a runtime answers `internal_error` for this route and still mounts; a programming error reaches the error ring with
// `where: panel.<key>`; a stopped instance answers `shutting_down`; 50 parallel requests cost one refresh per stale source.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  createInstanceRuntime,
  defaultSkillDir,
  initWorkspace,
  type InstanceContext,
  type InstanceRuntime,
} from '@mcs/engine';
import {
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  PANEL_KEYS,
  PanelResponseSchema,
  RUNTIME_VERSION,
  type ErrorCode,
  type PanelKey,
} from '@mcs/shared';
import { allocatePort, assertPortClosed, buildDemo, httpRequest, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { createApp, createHttpServer } from '../src/app.ts';
import { ERROR_MESSAGES } from '../src/errors.ts';
import { readLegacyTask } from '../src/routes/meta.ts';

type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

const makeTemp = useTempDirs();
const ALL_ON = { machine: true, git: true, logs: true, ledger: true, chain_log: true, attempts: true };

interface Running {
  readonly ctx: InstanceContext;
  readonly runtime: InstanceRuntime;
  readonly port: number;
  phase: 'starting' | 'ready' | 'stopping';
  get(path: string): Promise<HttpReply>;
}

interface StartOptions {
  readonly panels?: Record<string, boolean>;
  /** `none`: an app that was given no runtime. A stub replaces the panel service of the real runtime. */
  readonly runtime?: 'real' | 'none';
  readonly panelServiceGet?: InstanceRuntime['panels']['get'];
}

const live: { server: Server; ctx: InstanceContext; runtime: InstanceRuntime; port: number }[] = [];

afterEach(async () => {
  for (const { server, ctx, runtime, port } of live.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    await runtime.stop(Date.now() + 5000).catch(() => undefined);
    ctx.db.close();
    await ctx.logger.close();
    await assertPortClosed(port);
  }
});

async function start(options: StartOptions = {}): Promise<Running> {
  const root = makeTemp('panels-route').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');

  const demo = await buildDemo({ root: path.join(root, 'demo'), nowMs: Date.now(), letters: ['A', 'B', 'C'] });
  // no child process: nothing to watch, no Docker; the demo config narrows the event window below what the runtime accepts
  const seed = {
    ...Object.fromEntries(Object.entries(demo.configJson).filter(([key]) => key !== 'limits')),
    panels: { ...ALL_ON, ...options.panels },
    watched_processes: [],
    docker: false,
  };
  const seedFile = path.join(root, 'seed.config.json');
  writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`);
  const { ws } = await initWorkspace({ repo: demo.repo, name: 'Demo', slug: 'demo', seedConfig: seedFile });

  const run: { phase: Running['phase'] } = { phase: 'ready' };
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: demo.claudeHome },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    processInfo: { phase: () => run.phase },
  });
  const real = createInstanceRuntime(ctx);
  await real.start();
  await real.ingestUntilIdle({ timeoutMs: 30_000 });
  const runtime: InstanceRuntime =
    options.panelServiceGet === undefined
      ? real
      : ({ ...real, panels: { ...real.panels, get: options.panelServiceGet } } satisfies InstanceRuntime);

  const port = await allocatePort();
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => undefined,
    task: await readLegacyTask(ws.dir),
    ...(options.runtime === 'none' ? {} : { runtime }),
  });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  live.push({ server, ctx, runtime: real, port });
  return {
    ctx,
    runtime: real,
    port,
    get phase() {
      return run.phase;
    },
    set phase(value) {
      run.phase = value;
    },
    get: (urlPath) => httpRequest(port, urlPath),
  };
}

function envelopeOf(reply: HttpReply): z.infer<typeof ErrorEnvelopeSchema>['error'] {
  return ErrorEnvelopeSchema.parse(JSON.parse(reply.body)).error;
}

function expectError(reply: HttpReply, code: ErrorCode, label: string): void {
  expect(reply.status, label).toBe(ERROR_HTTP_STATUS[code]);
  const error = envelopeOf(reply);
  expect(error.code, label).toBe(code);
  expect(error.message, label).toBe(ERROR_MESSAGES[code]);
}

describe('GET /api/v3/panels/:key', () => {
  it('answers every enabled panel with a body that parses with PanelResponseSchema', async () => {
    const r = await start();
    for (const key of PANEL_KEYS) {
      const reply = await r.get(`/api/v3/panels/${key}`);
      expect(reply.status, key).toBe(200);
      const body = PanelResponseSchema.parse(JSON.parse(reply.body));
      expect(body.key).toBe(key);
      expect(body.data, key).not.toBeNull();
      expect(body.sources.length, key).toBeGreaterThan(0);
    }
  });

  it('sets the API headers on the answer', async () => {
    const r = await start();
    const reply = await r.get('/api/v3/panels/ledger');
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(reply.headers['x-request-id']).toBeDefined();
  });

  it('shows the attempts rows of the chain log', async () => {
    const r = await start();
    const reply = await r.get('/api/v3/panels/attempts');
    const body = PanelResponseSchema.parse(JSON.parse(reply.body));
    if (body.key !== 'attempts') throw new Error('not the attempts panel');
    expect(body.data?.rows.map((row) => row.part)).toEqual(['A', 'B', 'C']);
    expect(body.data?.sourceState).toBe('ok');
  });

  it('applies limit to the attempts only and refuses it for the other keys', async () => {
    const r = await start();
    const one = PanelResponseSchema.parse(JSON.parse((await r.get('/api/v3/panels/attempts?limit=1')).body));
    if (one.key !== 'attempts') throw new Error('not the attempts panel');
    expect(one.data?.rows).toHaveLength(1);
    expect(one.data?.rows[0]?.part).toBe('C');
    for (const key of PANEL_KEYS.filter((k): k is Exclude<PanelKey, 'attempts'> => k !== 'attempts')) {
      expectError(await r.get(`/api/v3/panels/${key}?limit=5`), 'validation_failed', `limit on ${key}`);
    }
  });

  it('answers 400 for a key that is not a panel and for a limit outside 1..200', async () => {
    const r = await start();
    expectError(await r.get('/api/v3/panels/nope'), 'validation_failed', 'unknown key');
    expectError(await r.get('/api/v3/panels/Git'), 'validation_failed', 'wrong case');
    for (const limit of ['0', '201', '-1', '1.5', 'abc', '']) {
      expectError(await r.get(`/api/v3/panels/attempts?limit=${limit}`), 'validation_failed', `limit=${limit}`);
    }
    expectError(await r.get('/api/v3/panels/attempts?limit=2&limit=3'), 'param_repeated', 'repeated limit');
    expectError(await r.get('/api/v3/panels/attempts?other=1'), 'validation_failed', 'unknown parameter');
    expect((await r.get('/api/v3/panels/attempts?limit=200')).status).toBe(200);
    expect((await r.get('/api/v3/panels/attempts?limit=1')).status).toBe(200);
  });

  it('answers 404 panel_disabled for a panel that the configuration turns off, and no other', async () => {
    const r = await start({ panels: { git: false, chain_log: false } });
    expectError(await r.get('/api/v3/panels/git'), 'panel_disabled', 'git');
    expectError(await r.get('/api/v3/panels/chainLog'), 'panel_disabled', 'chainLog');
    expect((await r.get('/api/v3/panels/ledger')).status).toBe(200);
    expect((await r.get('/api/v3/panels/attempts')).status).toBe(200);
  });

  it('gates the route, not the tick: the attempts keep being ingested when panels.attempts is off', async () => {
    const r = await start({ panels: { attempts: false } });
    expectError(await r.get('/api/v3/panels/attempts'), 'panel_disabled', 'attempts');
    // the rows are in the table, so the tick ran: the service reads them although the route refuses
    const rows = await r.runtime.panels.get('attempts');
    expect(rows.data?.rows.map((row) => row.part)).toEqual(['A', 'B', 'C']);
  });

  it('costs one refresh per stale source for 50 parallel requests', async () => {
    const r = await start();
    const replies = await Promise.all(Array.from({ length: 50 }, () => r.get('/api/v3/panels/ledger')));
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    expect(r.runtime.health().panels.ledger).toMatchObject({ refreshes: 1, failures: 0, lastStatus: 'ok' });
  });

  it('answers shutting_down once the instance is stopping and once the service is closed', async () => {
    const r = await start();
    r.phase = 'stopping';
    expectError(await r.get('/api/v3/panels/ledger'), 'shutting_down', 'phase stopping');
    r.phase = 'ready';
    r.runtime.panels.close();
    expectError(await r.get('/api/v3/panels/ledger'), 'shutting_down', 'service closed');
  });

  it('turns a programming error into internal_error, with a ring entry for the panel and without its text in the body', async () => {
    const r = await start({
      panelServiceGet: () => Promise.reject(new Error('boom with a SECRET-DETAIL')),
    });
    const reply = await r.get('/api/v3/panels/logs');
    expectError(reply, 'internal_error', 'thrown error');
    expect(reply.body).not.toContain('SECRET-DETAIL');
    const entry = r.ctx.errors.list().find((item) => item.where === 'panel.logs');
    expect(entry).toMatchObject({ source: 'panels', code: 'INTERNAL' });
  });

  it('answers internal_error for the route of an app that was built without a runtime, and mounting does not throw', async () => {
    const r = await start({ runtime: 'none' });
    expectError(await r.get('/api/v3/panels/git'), 'internal_error', 'no runtime');
    // the other routes of the same app work
    expect((await r.get('/api/v3/health')).status).toBe(200);
  });
});
