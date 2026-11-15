// The meta routes (03 6.1, 6.2): `legacyHealth` with exactly the 13 keys (I-30), `health` with the server error ring,
// `healthIngest`, `instance` and `config`; and the reader of `task.json`. Fake instance context, real Express and sockets.
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  defaultSkillDir,
  resolveConfig,
  type AuditQueries,
  type EngineQueries,
  type ResolvedConfig,
  type RuntimeProcessInfo,
} from '@mcs/engine';
import {
  CHILD_KINDS,
  ConfigInspectionSchema,
  HealthReportSchema,
  IngestHealthSchema,
  InstanceInfoSchema,
  LEGACY_HEALTH_KEYS,
  LegacyHealthSchema,
  RUNTIME_VERSION,
  toConfigInspection,
  type HealthReport,
  type InstanceFile,
} from '@mcs/shared';
import { allocatePort, assertPortClosed, FakeClock, httpRequest, useTempDirs } from '@mcs/testkit';
import express, { type Express } from 'express';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { bindRouteServices, type AppContext, type LegacyTask } from '../route-adapter.ts';
import { metaRoutes, readLegacyTask } from './meta.ts';

/** What the routes under test call: the meta part of the query layer (03 12.1), nothing else is built. */
type MetaQueriesDouble = Pick<EngineQueries, 'instanceInfo' | 'health' | 'ingestHealth' | 'hookProbe'> & AuditQueries;

/** The one place that widens the double to the layer; a member a route would call beyond the meta part is `undefined` and fails loudly. */
function asQueries(double: MetaQueriesDouble): AppContext['queries'] {
  return double as AppContext['queries'];
}

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111';
const STARTED = Date.UTC(2026, 9, 11, 14, 0, 0);
const NOW = STARTED + 12_345;
const TASK: LegacyTask = { id: 'demo', name: 'Demo task', description: 'A synthetic task.' };

let config: ResolvedConfig;
beforeAll(async () => {
  config = await resolveConfig({ workspace: null, env: {}, cli: {}, skillDir: defaultSkillDir() });
});

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

function fakeProcess(): RuntimeProcessInfo {
  return {
    pid: 4242,
    startedAtMs: STARTED,
    runtimeVersion: RUNTIME_VERSION,
    bootCodeStamp: 'abcdef0123',
    previousRunUnclean: false,
    phase: () => 'ready',
    outdated: () => ({ outdated: false, reason: null }),
    ownershipConflict: () => false,
  };
}

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

interface Stubs {
  readonly calls: string[];
  /** Merged into `runtime` of the health report the stubbed query layer answers. */
  runtime: Partial<HealthReport['runtime']>;
  readonly ring: { source: string; code: string; where: string | null; message: string }[];
}

function context(over: Partial<Pick<AppContext, 'instance'>> = {}): { ctx: AppContext; stubs: Stubs } {
  const stubs: Stubs = { calls: [], ring: [], runtime: {} };
  const clock = new FakeClock(NOW);
  const errors: AppContext['errors'] = {
    push: (entry) => {
      stubs.ring.push({ source: entry.source, code: entry.code, where: entry.where, message: entry.message });
    },
    list: (limit) =>
      stubs.ring
        .map((entry, index) => ({
          at: new Date(NOW - index).toISOString(),
          source: entry.source,
          code: entry.code,
          where: entry.where,
          message: entry.message,
          sessionId: null,
        }))
        .reverse()
        .slice(0, limit ?? 20),
  };
  const baseHealth = HealthReportSchema.parse({
    checkedAt: new Date(NOW).toISOString(),
    status: 'ok',
    instanceId: ID,
    asOfSeq: 0,
    epoch: 'deadbeef',
    runtime: {
      version: RUNTIME_VERSION,
      codeStamp: 'abcdef0123',
      outdated: false,
      pid: 4242,
      startedAt: new Date(STARTED).toISOString(),
      uptimeMs: 12_345,
      eventLoopDelayP99Ms: 1,
      rssBytes: 1,
      heapUsedBytes: 1,
      cpuUserMicros: 1,
      cpuSystemMicros: 1,
      sseClients: 0,
      previousRunUnclean: false,
      ownershipConflict: false,
      search: { total: 0, byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 } },
    },
    db: { ok: true, sizeBytes: 1, walBytes: 0, freeDiskBytes: null, schemaVersion: 1, lastError: null },
    ingestion: {
      status: 'unknown',
      reasons: ['NOT_EVALUATED'],
      hooks: {
        enabled: false,
        installed: null,
        lastReceivedAt: null,
        lastEventAt: null,
        spoolPendingBytes: 0,
        spoolLagMs: null,
        errorsLastHour: 0,
        lastError: null,
      },
      transcripts: {
        dirFound: false,
        filesTracked: 0,
        lastScanAt: null,
        lastImportedAt: null,
        importLagMs: null,
        pendingBytes: 0,
        invalidLines: 0,
        errorsLastHour: 0,
        lastError: null,
      },
    },
    children: Object.fromEntries(CHILD_KINDS.map((kind) => [kind, { spawned: 0, failed: 0, timedOut: 0, totalMs: 0 }])),
    panels: {},
    alerts: [],
    errors: [],
  });
  const ingest = IngestHealthSchema.parse({
    evaluatedAt: NOW,
    provider: { lastActivityAt: null, source: null, status: 'none' },
    receiving: {
      hooks: {
        installed: [],
        lastEnvelopeAt: null,
        envelopes1h: 0,
        duplicates1h: 0,
        invalid1h: 0,
        handlerErrors: [],
        transcriptHookFailures: 0,
        coverage: { full: 0, partial: 0, none: 0 },
        status: 'not_installed',
      },
      spool: {
        segments: 0,
        bytes: 0,
        bytesBehind: 0,
        oldestPendingReceivedAt: null,
        lastNudgeAt: null,
        lastDrainAt: null,
        foreignFiles: 0,
      },
      transcripts: {
        dir: null,
        dirFound: false,
        filesTracked: 0,
        filesMissing: 0,
        filesUnreadable: 0,
        bytesBehind: 0,
        maxLagMs: 0,
        backfillRemainingBytes: 0,
        lastScanAt: null,
        lastSyncAt: null,
        errors: {},
        status: 'not_found',
      },
    },
    persisted: {
      lastCommitAt: null,
      queueItems: 0,
      queueBytes: 0,
      commitP95Ms: 0,
      failures1h: 0,
      lastError: null,
      status: 'ok',
    },
    display: { headSeq: 0, serverTime: NOW },
    runtime: { startedAt: STARTED, eventLoopDelayP99Ms: 0 },
    status: 'ok',
    reasons: [],
  });
  const info = InstanceInfoSchema.parse({
    instanceId: ID,
    slug: 'demo',
    title: 'Demo',
    description: null,
    runtimeVersion: RUNTIME_VERSION,
    codeStamp: 'abcdef0123',
    dbSchemaVersion: 1,
    headSeq: 0,
    epoch: 'deadbeef',
    staleAfterMs: 15_000,
    heartbeatMs: 15_000,
    windowHours: 8,
    ui: {
      theme: 'auto',
      density: 'comfortable',
      newestFirst: true,
      showTools: true,
      showThinking: false,
      showPrompts: false,
    },
    panels: { git: true, machine: true, attempts: false, ledger: false, chainLog: false, logs: true },
    poll: {
      healthMs: 5000,
      sessionsMs: 6000,
      overviewMs: 5000,
      transcriptMs: 1500,
      machineMs: 2000,
      logsMs: 3000,
      attemptsMs: 6000,
    },
    features: { transcriptSearch: 'session', costEstimates: false, usageTrend: false, hooks: false },
    retention: { summary: 'kept' },
    commands: { status: 's', restart: 'r', inspect: 'i', export: 'e', backup: 'b', cleanupDryRun: 'c' },
    limits: { pageMax: 200, eventsQueryWindowDays: 7, searchBudgetMsMax: 10_000, textChars: 6000 },
  });
  const ctx: AppContext = {
    instanceId: ID,
    slug: 'demo',
    clock,
    scope: { instanceId: ID },
    // these routes never reach the database; a call on it fails loudly
    db: {} as never,
    queries: asQueries({
      instanceInfo: () => {
        stubs.calls.push('instanceInfo');
        return info;
      },
      health: () => {
        stubs.calls.push('health');
        return { ...baseHealth, runtime: { ...baseHealth.runtime, ...stubs.runtime } };
      },
      ingestHealth: () => {
        stubs.calls.push('ingestHealth');
        return { ...ingest, asOfSeq: 5 };
      },
      hookProbe: () => null,
      sessionAuditRefs: () => Promise.resolve([]),
    }),
    errors,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
      close: () => Promise.resolve(),
    },
    process: fakeProcess(),
    config,
    instance: over.instance ?? INSTANCE,
  };
  return { ctx, stubs };
}

async function serveMeta(ctx: AppContext, task: LegacyTask | null): Promise<number> {
  const app: Express = express();
  bindRouteServices(app, { errors: ctx.errors, logger: ctx.logger, validateResponses: true });
  metaRoutes(app, { ctx, nudge: () => undefined, task });
  const port = await allocatePort();
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(port, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  servers.push({ server, port });
  return port;
}

describe('legacyHealth (I-30)', () => {
  it('has exactly the 13 keys of the legacy health body, in a body that parses', async () => {
    const { ctx } = context();
    const port = await serveMeta(ctx, TASK);
    const reply = await httpRequest(port, '/api/health');
    expect(reply.status).toBe(200);
    const body: unknown = JSON.parse(reply.body);
    expect(LegacyHealthSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([...LEGACY_HEALTH_KEYS].sort());
  });

  it('fills the values from the process: epoch seconds, uptime with one decimal, the pid the legacy reader compares', async () => {
    const { ctx } = context();
    const port = await serveMeta(ctx, TASK);
    const body = LegacyHealthSchema.parse(JSON.parse((await httpRequest(port, '/api/health')).body));
    expect(body).toEqual({
      ok: true,
      version: RUNTIME_VERSION,
      pid: 4242,
      started: STARTED / 1000,
      uptime: 12.3,
      now: NOW / 1000,
      code_stamp: 'abcdef0123',
      engine: 'node',
      instanceId: ID,
      task: TASK,
      config_source: 'task',
      errors: [],
      reader: {},
    });
  });

  it('has task null without a task.json, and never a negative uptime', async () => {
    const { ctx } = context();
    const clock = ctx.clock;
    if (!(clock instanceof FakeClock)) throw new Error('fake clock expected');
    clock.set(STARTED - 5000);
    const port = await serveMeta(ctx, null);
    const body = LegacyHealthSchema.parse(JSON.parse((await httpRequest(port, '/api/health')).body));
    expect(body.task).toBeNull();
    expect(body.uptime).toBe(0);
  });
});

describe('health, healthIngest, instance, config', () => {
  it('answers the query layer for this instance, and adds the server error ring (newest first, at most 20) to health', async () => {
    const { ctx, stubs } = context();
    for (let i = 0; i < 25; i += 1) {
      ctx.errors.push({
        source: 'server',
        code: 'INTERNAL',
        where: `route${String(i)}`,
        message: `failure ${String(i)}`,
      });
    }
    const port = await serveMeta(ctx, TASK);
    const report = HealthReportSchema.parse(JSON.parse((await httpRequest(port, '/api/v3/health')).body));
    expect(report.errors).toHaveLength(20);
    expect(report.errors[0]?.where).toBe('route24');
    expect(report.errors[19]?.where).toBe('route5');
    expect(stubs.calls).toEqual(['health']);
    expect(report.instanceId).toBe(ID);
  });

  it('serves the stream count and the crash and ownership flags that the query layer reports (CR-WP-17-3, CR-WP-18-5)', async () => {
    const { ctx, stubs } = context();
    const port = await serveMeta(ctx, TASK);
    const quiet = HealthReportSchema.parse(JSON.parse((await httpRequest(port, '/api/v3/health')).body));
    expect(quiet.runtime).toMatchObject({ sseClients: 0, previousRunUnclean: false, ownershipConflict: false });
    stubs.runtime = { sseClients: 3, previousRunUnclean: true, ownershipConflict: true };
    const report = HealthReportSchema.parse(JSON.parse((await httpRequest(port, '/api/v3/health')).body));
    expect(report.runtime).toMatchObject({ sseClients: 3, previousRunUnclean: true, ownershipConflict: true });
  });

  it('serves the ingest health with asOfSeq, and the instance info', async () => {
    const { ctx } = context();
    const port = await serveMeta(ctx, TASK);
    const ingest = JSON.parse((await httpRequest(port, '/api/v3/health/ingest')).body) as Record<string, unknown>;
    expect(ingest['asOfSeq']).toBe(5);
    expect(IngestHealthSchema.safeParse({ ...ingest, asOfSeq: undefined }).success).toBe(false); // strict: asOfSeq is its own key
    const report = Object.fromEntries(Object.entries(ingest).filter(([key]) => key !== 'asOfSeq'));
    expect(IngestHealthSchema.safeParse(report).success).toBe(true);
    const info = InstanceInfoSchema.parse(JSON.parse((await httpRequest(port, '/api/v3/instance')).body));
    expect(info.slug).toBe('demo');
    expect(info.kind).toBe('task');
    expect(info.app).toBeNull();
  });

  it('serves kind and app of the user instance, and reads an instance info without them as a task (06 1.7)', async () => {
    const { ctx } = context();
    const userCtx: AppContext = {
      ...ctx,
      queries: asQueries({
        ...ctx.queries,
        instanceInfo: (scope) => ({
          ...ctx.queries.instanceInfo(scope),
          kind: 'user',
          app: { name: 'Team Workspace' },
        }),
      }),
    };
    const userPort = await serveMeta(userCtx, null);
    const user = InstanceInfoSchema.parse(JSON.parse((await httpRequest(userPort, '/api/v3/instance')).body));
    expect(user.kind).toBe('user');
    expect(user.app).toEqual({ name: 'Team Workspace' });

    // the reply of a server that predates the two keys still parses, as a task without an app
    const taskPort = await serveMeta(ctx, TASK);
    const body = JSON.parse((await httpRequest(taskPort, '/api/v3/instance')).body) as Record<string, unknown>;
    const older = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'kind' && key !== 'app'));
    expect(older).not.toHaveProperty('kind');
    expect(older).not.toHaveProperty('app');
    expect(InstanceInfoSchema.parse(older)).toMatchObject({ kind: 'task', app: null });
  });

  it('serves the configuration inspection with the engine of instance.json', async () => {
    const node = context();
    const nodePort = await serveMeta(node.ctx, TASK);
    const nodeBody = ConfigInspectionSchema.parse(JSON.parse((await httpRequest(nodePort, '/api/v3/config')).body));
    expect(nodeBody).toEqual(JSON.parse(JSON.stringify(toConfigInspection(config, 'node'))));
    expect(nodeBody.engine).toBe('node');
    expect(nodeBody.entries.length).toBeGreaterThan(10);

    // one engine (ADR 0066): the contract has no other engine value
    expect(ConfigInspectionSchema.safeParse({ ...nodeBody, engine: 'legacy' }).success).toBe(false);
  });
});

describe('readLegacyTask', () => {
  function workspace(taskJson: string | null): string {
    const dir = makeTemp('legacy-task').path;
    mkdirSync(dir, { recursive: true });
    if (taskJson !== null) writeFileSync(path.join(dir, 'task.json'), taskJson);
    return dir;
  }

  it('reads id, name and description', async () => {
    const dir = workspace(
      JSON.stringify({ schema_version: 1, id: 'demo', name: 'Demo', description: 'Text.', links: [] }),
    );
    expect(await readLegacyTask(dir)).toEqual({ id: 'demo', name: 'Demo', description: 'Text.' });
  });

  it('defaults the description to the empty string and the name to the id', async () => {
    expect(await readLegacyTask(workspace(JSON.stringify({ id: 'demo' })))).toEqual({
      id: 'demo',
      name: 'demo',
      description: '',
    });
  });

  it('is null for a missing file, text that is not JSON, a JSON value that is not an object, or no id', async () => {
    expect(await readLegacyTask(workspace(null))).toBeNull();
    expect(await readLegacyTask(workspace('{ not json'))).toBeNull();
    expect(await readLegacyTask(workspace('[1, 2]'))).toBeNull();
    expect(await readLegacyTask(workspace(JSON.stringify({ name: 'no id' })))).toBeNull();
    expect(await readLegacyTask(workspace(JSON.stringify({ id: 7 })))).toBeNull();
  });
});
