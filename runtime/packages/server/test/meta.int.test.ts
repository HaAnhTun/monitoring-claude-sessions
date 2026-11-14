// The meta routes on a real instance: a real workspace, a real database, the real query layer and a real HTTP server
// (03 19.3). DA-T-API-10 (headers), DA-T-API-11 (legacy health parity, I-30), DA-T-API-13 (ingest health), DA-T-API-16
// (health resources), and the instance and config routes. Response validation is on, as it is outside production (N3).
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  bindPanelStats,
  buildInstanceContext,
  defaultSkillDir,
  initWorkspace,
  withWriteTx,
  type InstanceContext,
  type Logger,
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
  isoMsZ,
  toConfigInspection,
  type IngestHealth,
  type PanelStats,
} from '@mcs/shared';
import { allocatePort, assertPortClosed, FakeClock, httpRequest, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp, createHttpServer } from '../src/app.ts';
import { readLegacyTask } from '../src/routes/meta.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';
const META_PATHS = [
  '/api/health',
  '/api/v3/health',
  '/api/v3/health/ingest',
  '/api/v3/instance',
  '/api/v3/config',
] as const;

interface Running {
  readonly ctx: InstanceContext;
  readonly port: number;
  readonly clock: FakeClock;
  readonly root: string;
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

async function startInstance(): Promise<Running> {
  const root = makeTemp('meta-int').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({
    repo,
    name: 'Demo',
    slug: 'demo',
    description: 'A synthetic task.',
    clock,
    newId: () => ID,
  });
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
  });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  live.push({ server, ctx, port });
  return { ctx, port, clock, root, instanceDir: ws.dir };
}

async function getJson(port: number, route: string): Promise<unknown> {
  const reply = await httpRequest(port, route);
  expect(reply.status, route).toBe(200);
  return JSON.parse(reply.body);
}

function storeReport(ctx: InstanceContext, report: IngestHealth): void {
  withWriteTx(ctx.db, ctx.scope, (tx) => {
    ctx.db.driver
      .prepare(
        `INSERT INTO ingest_health (id, evaluated_at, status, counters_json, report_json, updated_at)
         VALUES (1, :at, :status, '{}', :report, :now)
         ON CONFLICT(id) DO UPDATE SET evaluated_at = excluded.evaluated_at, status = excluded.status,
                                       report_json = excluded.report_json, updated_at = excluded.updated_at`,
      )
      .run({ at: report.evaluatedAt, status: report.status, report: JSON.stringify(report), now: tx.now });
  });
}

function healthyReport(ctx: InstanceContext): IngestHealth {
  return {
    evaluatedAt: NOW - 1000,
    provider: { lastActivityAt: NOW - 2000, source: 'hook', status: 'active' },
    receiving: {
      hooks: {
        installed: [],
        lastEnvelopeAt: NOW - 2000,
        envelopes1h: 12,
        duplicates1h: 0,
        invalid1h: 1,
        handlerErrors: [],
        transcriptHookFailures: 0,
        coverage: { full: 1, partial: 0, none: 0 },
        status: 'ok',
      },
      spool: {
        segments: 1,
        bytes: 100,
        bytesBehind: 0,
        oldestPendingReceivedAt: null,
        lastNudgeAt: null,
        lastDrainAt: NOW - 3000,
        foreignFiles: 0,
      },
      transcripts: {
        dir: 'transcripts',
        dirFound: true,
        filesTracked: 2,
        filesMissing: 0,
        filesUnreadable: 0,
        bytesBehind: 0,
        maxLagMs: 50,
        backfillRemainingBytes: 0,
        lastScanAt: NOW - 4000,
        lastSyncAt: NOW - 3500,
        errors: {},
        status: 'ok',
      },
    },
    persisted: {
      lastCommitAt: NOW - 2500,
      queueItems: 0,
      queueBytes: 0,
      commitP95Ms: 2,
      failures1h: 0,
      lastError: null,
      status: 'ok',
    },
    display: { headSeq: ctx.db.headSeq(), serverTime: NOW - 1000 },
    runtime: { startedAt: NOW, eventLoopDelayP99Ms: 1 },
    status: 'ok',
    reasons: [],
  };
}

describe('DA-T-API-10: headers of every API response', () => {
  it('has no-store, nosniff, the instance stamp and a request id on every meta route and on a 404', async () => {
    const run = await startInstance();
    for (const route of [...META_PATHS, '/api/v3/nope']) {
      const reply = await httpRequest(run.port, route);
      expect(reply.headers['cache-control'], route).toBe('no-store');
      expect(reply.headers['x-content-type-options'], route).toBe('nosniff');
      expect(reply.headers['x-mcs-instance'], route).toBe(ID);
      expect(reply.headers['x-mcs-runtime'], route).toBe(`${RUNTIME_VERSION}+abcdef0123`);
      expect(reply.headers['x-request-id'], route).toMatch(/^r-[0-9a-z]{12}$/);
      expect(reply.headers['content-type'], route).toBe('application/json; charset=utf-8');
      expect(
        Object.keys(reply.headers).filter((name) => name.startsWith('access-control-')),
        route,
      ).toEqual([]);
    }
  });
});

describe('DA-T-API-11: legacy health parity (I-30)', () => {
  it('parses with LegacyHealthSchema and has exactly the 13 keys of the design', async () => {
    const run = await startInstance();
    const body = await getJson(run.port, '/api/health');
    const parsed = LegacyHealthSchema.parse(body);
    expect(Object.keys(parsed).sort()).toEqual([...LEGACY_HEALTH_KEYS].sort());
    expect(parsed).toMatchObject({
      ok: true,
      version: RUNTIME_VERSION,
      pid: process.pid,
      engine: 'node',
      instanceId: ID,
      config_source: 'task',
      errors: [],
      reader: {},
      task: { id: 'demo', name: 'Demo', description: 'A synthetic task.' },
      code_stamp: 'abcdef0123',
    });
    expect(parsed.started).toBe(NOW / 1000);
    expect(parsed.now).toBe(NOW / 1000);
    expect(parsed.uptime).toBe(0);
  });
});

describe('health (DA-T-API-16, 03 6.2)', () => {
  it('parses, with the resources of the process, the database and a child count for every kind', async () => {
    const run = await startInstance();
    const report = HealthReportSchema.parse(await getJson(run.port, '/api/v3/health'));
    expect(report.instanceId).toBe(ID);
    expect(report.epoch).toBe(run.ctx.db.epoch);
    expect(report.runtime.pid).toBe(process.pid);
    expect(report.runtime.rssBytes).toBeGreaterThan(0);
    expect(report.runtime.heapUsedBytes).toBeGreaterThan(0);
    expect(report.runtime.version).toBe(RUNTIME_VERSION);
    expect(report.db.ok).toBe(true);
    expect(report.db.sizeBytes).toBeGreaterThan(0);
    expect(Object.keys(report.children).sort()).toEqual([...CHILD_KINDS].sort());
    expect(report.errors).toEqual([]);
  });

  it('does not let cpuUserMicros decrease between two calls, and shows the panel statistics that were bound', async () => {
    const run = await startInstance();
    const stats: PanelStats = { 'git.status': { refreshes: 2, failures: 0, lastDurationMs: 3, lastStatus: 'ok' } };
    bindPanelStats(run.ctx, () => stats);
    const first = HealthReportSchema.parse(await getJson(run.port, '/api/v3/health'));
    const second = HealthReportSchema.parse(await getJson(run.port, '/api/v3/health'));
    expect(second.runtime.cpuUserMicros).toBeGreaterThanOrEqual(first.runtime.cpuUserMicros);
    expect(second.panels).toEqual(stats);
  });

  it('reports no open stream and no crash or ownership flag on a quiet instance (the stream route binds the gauge)', async () => {
    const run = await startInstance();
    const report = HealthReportSchema.parse(await getJson(run.port, '/api/v3/health'));
    expect(report.runtime.sseClients).toBe(0);
    expect(report.runtime.previousRunUnclean).toBe(false);
    expect(report.runtime.ownershipConflict).toBe(false);
  });

  it('lists the server error ring, newest first', async () => {
    const run = await startInstance();
    run.ctx.errors.push({ source: 'server', code: 'INTERNAL', where: 'one', message: 'first failure' });
    run.clock.advance(5);
    run.ctx.errors.push({ source: 'server', code: 'INTERNAL', where: 'two', message: 'second failure' });
    const report = HealthReportSchema.parse(await getJson(run.port, '/api/v3/health'));
    expect(report.errors.map((e) => e.where)).toEqual(['two', 'one']);
    expect(report.errors[0]?.at).toBe(isoMsZ(NOW + 5));
  });
});

describe('DA-T-API-13: ingest health', () => {
  it('says that it was not evaluated before the ingest service stored a report', async () => {
    const run = await startInstance();
    const raw = (await getJson(run.port, '/api/v3/health/ingest')) as Record<string, unknown>;
    const { asOfSeq, ...report } = raw;
    expect(IngestHealthSchema.safeParse(report).success).toBe(true);
    expect(asOfSeq).toBe(run.ctx.db.headSeq());
    expect(report['status']).toBe('degraded');
    expect(report['reasons']).toEqual([{ code: 'NOT_EVALUATED', severity: 'warn', since: NOW }]);
    const health = HealthReportSchema.parse(await getJson(run.port, '/api/v3/health'));
    expect(health.ingestion.status).toBe('unknown');
    expect(health.status).toBe('degraded');
  });

  it('serves the last stored report with asOfSeq, and projects it onto HealthReport.ingestion', async () => {
    const run = await startInstance();
    const stored = healthyReport(run.ctx);
    storeReport(run.ctx, stored);
    const raw = (await getJson(run.port, '/api/v3/health/ingest')) as Record<string, unknown>;
    const { asOfSeq, ...report } = raw;
    expect(report).toEqual(JSON.parse(JSON.stringify(stored)));
    expect(asOfSeq).toBe(run.ctx.db.headSeq());
    const health = HealthReportSchema.parse(await getJson(run.port, '/api/v3/health'));
    expect(health.status).toBe('ok');
    expect(health.ingestion.status).toBe('ok');
    expect(health.ingestion.hooks).toMatchObject({
      enabled: false,
      lastReceivedAt: isoMsZ(NOW - 2000),
      errorsLastHour: 1,
      spoolPendingBytes: 0,
    });
    expect(health.ingestion.transcripts).toMatchObject({ dirFound: true, filesTracked: 2, importLagMs: 50 });
  });
});

describe('instance and config', () => {
  it('describes the instance, with the six commands of 01 6.6', async () => {
    const run = await startInstance();
    const info = InstanceInfoSchema.parse(await getJson(run.port, '/api/v3/instance'));
    expect(info).toMatchObject({
      instanceId: ID,
      slug: 'demo',
      title: 'Demo',
      description: 'A synthetic task.',
      runtimeVersion: RUNTIME_VERSION,
      codeStamp: 'abcdef0123',
      dbSchemaVersion: 1,
      epoch: run.ctx.db.epoch,
    });
    expect(Object.keys(info.commands).sort()).toEqual([
      'backup',
      'cleanupDryRun',
      'export',
      'inspect',
      'restart',
      'status',
    ]);
    expect(info.commands.status).toContain('scripts/caw.mjs status --task demo');
    expect(info.commands.cleanupDryRun).toContain('cleanup --task demo --scope logs');
    expect(info.commands.export).toContain('/logs/export.ndjson');
    expect(info.commands.export).not.toContain('.jsonl');
  });

  it('serves the configuration inspection of the resolved configuration', async () => {
    const run = await startInstance();
    const inspection = ConfigInspectionSchema.parse(await getJson(run.port, '/api/v3/config'));
    expect(inspection).toEqual(JSON.parse(JSON.stringify(toConfigInspection(run.ctx.config, 'node'))));
    expect(inspection.effectivePort).toBe(run.ctx.config.effectivePort);
  });
});
