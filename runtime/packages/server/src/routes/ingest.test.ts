// The ingest routes (03 6.1, 02 2.8): the hook nudge (204 at once, a drain is scheduled, nothing else) and the probe
// lookup (I-37). Fake instance context, real Express and sockets; the full guard matrix is in test/ingest.int.test.ts.
import type { Server } from 'node:http';

import {
  defaultSkillDir,
  resolveConfig,
  type AuditQueries,
  type EngineQueries,
  type ResolvedConfig,
  type RuntimeProcessInfo,
} from '@mcs/engine';
import { ErrorEnvelopeSchema, HookProbeResultSchema, RUNTIME_VERSION, type InstanceFile } from '@mcs/shared';
import { allocatePort, assertPortClosed, FakeClock, httpRequest } from '@mcs/testkit';
import express, { type Express } from 'express';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { bindRouteServices, type AppContext } from '../route-adapter.ts';
import { ingestRoutes } from './ingest.ts';

/** What the routes under test call: the meta part of the query layer (03 12.1), nothing else is built. */
type MetaQueriesDouble = Pick<EngineQueries, 'instanceInfo' | 'health' | 'ingestHealth' | 'hookProbe'> & AuditQueries;

/** The one place that widens the double to the layer; a member a route would call beyond the meta part is `undefined` and fails loudly. */
function asQueries(double: MetaQueriesDouble): AppContext['queries'] {
  return double as AppContext['queries'];
}

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const PROBE = '00000000-0000-4000-8000-0000000000a1';
const NOW = Date.UTC(2026, 9, 11, 14, 0, 12);

// the route modules read only the queries, the errors and the logger; the configuration and the instance file are real values
let config: ResolvedConfig;
beforeAll(async () => {
  config = await resolveConfig({ workspace: null, env: {}, cli: {}, skillDir: defaultSkillDir() });
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

const servers: { readonly server: Server; readonly port: number }[] = [];
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
});

interface Harness {
  readonly port: number;
  readonly nudges: number[];
  readonly probes: string[];
  readonly ring: { source: string; code: string; where: string | null; message: string }[];
}

interface Options {
  readonly nudge?: () => void;
  readonly probe?: (id: string) => { receivedAt: string; committedAt: string } | null;
}

async function start(o: Options = {}): Promise<Harness> {
  const nudges: number[] = [];
  const probes: string[] = [];
  const ring: Harness['ring'] = [];
  const process: RuntimeProcessInfo = {
    pid: 1,
    startedAtMs: NOW - 1000,
    runtimeVersion: RUNTIME_VERSION,
    bootCodeStamp: 'abcdef0123',
    previousRunUnclean: false,
    phase: () => 'ready',
    outdated: () => ({ outdated: false, reason: null }),
    ownershipConflict: () => false,
  };
  const ctx: Pick<AppContext, 'instanceId' | 'scope' | 'queries' | 'errors' | 'logger' | 'clock'> = {
    instanceId: ID,
    scope: { instanceId: ID },
    clock: new FakeClock(NOW),
    queries: asQueries({
      instanceInfo: () => {
        throw new Error('not used');
      },
      health: () => {
        throw new Error('not used');
      },
      ingestHealth: () => {
        throw new Error('not used');
      },
      sessionAuditRefs: () => Promise.resolve([]),
      hookProbe: (_scope, id) => {
        probes.push(id);
        return (o.probe ?? (() => null))(id);
      },
    }),
    errors: {
      push: (entry) => {
        ring.push({ source: entry.source, code: entry.code, where: entry.where, message: entry.message });
      },
      list: () => [],
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
      close: () => Promise.resolve(),
    },
  };
  const app: Express = express();
  bindRouteServices(app, { errors: ctx.errors, logger: ctx.logger, validateResponses: true });
  ingestRoutes(app, {
    ctx: { ...ctx, slug: 'demo', process, config, instance: INSTANCE },
    nudge:
      o.nudge ??
      ((): void => {
        nudges.push(1);
      }),
    task: null,
  });
  const port = await allocatePort();
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(port, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  servers.push({ server, port });
  return { port, nudges, probes, ring };
}

const NUDGE_HEADERS = { 'Content-Type': 'application/json' };
const validNudge = JSON.stringify({ instanceId: ID });

describe('ingestNudge (02 2.8)', () => {
  it('answers 204 and schedules one drain for a valid nudge', async () => {
    const h = await start();
    const reply = await httpRequest(h.port, '/api/v3/ingest/nudge', {
      method: 'POST',
      headers: NUDGE_HEADERS,
      body: validNudge,
    });
    expect(reply.status).toBe(204);
    expect(reply.body).toBe('');
    expect(h.nudges).toHaveLength(1);
  });

  it('does not schedule a drain for a request the guard refuses', async () => {
    const h = await start();
    const refused = [
      await httpRequest(h.port, '/api/v3/ingest/nudge', {
        method: 'POST',
        headers: NUDGE_HEADERS,
        body: '{"instanceId":"x"}',
      }),
      await httpRequest(h.port, '/api/v3/ingest/nudge', {
        method: 'POST',
        headers: NUDGE_HEADERS,
        body: JSON.stringify({ instanceId: OTHER_ID }),
      }),
      await httpRequest(h.port, '/api/v3/ingest/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: validNudge,
      }),
      await httpRequest(h.port, '/api/v3/ingest/nudge', {
        method: 'POST',
        origin: `http://127.0.0.1:${String(h.port)}`,
        headers: NUDGE_HEADERS,
        body: validNudge,
      }),
    ];
    expect(refused.map((reply) => reply.status)).toEqual([400, 409, 415, 403]);
    expect(h.nudges).toEqual([]);
  });

  it('answers 204 even when scheduling the drain fails, and records that in the error ring', async () => {
    const h = await start({
      nudge: () => {
        throw new Error('the scheduler is gone');
      },
    });
    const reply = await httpRequest(h.port, '/api/v3/ingest/nudge', {
      method: 'POST',
      headers: NUDGE_HEADERS,
      body: validNudge,
    });
    expect(reply.status).toBe(204);
    expect(h.ring).toEqual([
      { source: 'server', code: 'INTERNAL', where: 'ingestNudge', message: 'the drain could not be scheduled' },
    ]);
  });

  it('does not accept a query string', async () => {
    const h = await start();
    const reply = await httpRequest(h.port, '/api/v3/ingest/nudge?x=1', {
      method: 'POST',
      headers: NUDGE_HEADERS,
      body: validNudge,
    });
    expect(reply.status).toBe(400);
    expect(h.nudges).toEqual([]);
  });
});

describe('ingestProbe (DA-T-API-14, I-37)', () => {
  it('answers receivedAt and committedAt of a committed probe', async () => {
    const result = { receivedAt: new Date(NOW - 20).toISOString(), committedAt: new Date(NOW).toISOString() };
    const h = await start({ probe: () => result });
    const reply = await httpRequest(h.port, `/api/v3/ingest/probes/${PROBE}`);
    expect(reply.status).toBe(200);
    expect(HookProbeResultSchema.parse(JSON.parse(reply.body))).toEqual(result);
    expect(h.probes).toEqual([PROBE]);
  });

  it('answers 404 probe_not_found for a probe that is not committed (yet)', async () => {
    const h = await start();
    const reply = await httpRequest(h.port, `/api/v3/ingest/probes/${PROBE}`);
    expect(reply.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(JSON.parse(reply.body)).error.code).toBe('probe_not_found');
  });

  it('answers 400 validation_failed, before any lookup, for an id that is not a probe id', async () => {
    const h = await start();
    for (const id of [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', // a session id, not a probe
      '00000000-0000-4000-8000-0000000000A1', // upper case
      '00000000-0000-4000-8000-0000000000a', // too short
      '00000000-0000-4000-8000-0000000000a12', // too long
      '..%2f..%2fetc',
      'x',
    ]) {
      const reply = await httpRequest(h.port, `/api/v3/ingest/probes/${id}`);
      expect(reply.status, id).toBe(400);
      expect(ErrorEnvelopeSchema.parse(JSON.parse(reply.body)).error.code, id).toBe('validation_failed');
    }
    expect(h.probes).toEqual([]);
  });
});
