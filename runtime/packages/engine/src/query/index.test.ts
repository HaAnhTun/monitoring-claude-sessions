// `createQueries` and the meta part of the query layer (03 12.1, 6.2, 6.3): instanceInfo, health, ingestHealth, hookProbe and
// sessionAuditRefs over a real workspace and a real database. DA-T-API-13 (ingest health), 14 (probe), 16 (health
// resources) and 17 (audit references, unit half), registry C09 (the deps) and the extension point for later work packages.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CHILD_KINDS,
  HealthReportSchema,
  IngestHealthSchema,
  InstanceInfoSchema,
  RUNTIME_VERSION,
  isoMsZ,
  type IngestHealth,
  type PanelStats,
} from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defaultSkillDir } from '../config/defaults.ts';
import { isDbError } from '../db/errors.ts';
import { AlertsRepo } from '../db/repos/alerts.ts';
import { HookProbesRepo } from '../db/repos/hook-probes.ts';
import { IngestHealthRepo } from '../db/repos/ingest-health.ts';
import { withWriteTx } from '../db/write.ts';
import type { Logger } from '../log/logger.ts';
import { instanceCommands } from '../ops/commands.ts';
import {
  buildInstanceContext,
  type BuildContextInput,
  type InstanceContext,
  type RuntimeProcessInfo,
} from '../runtime/context.ts';
import { readInstanceFile, writeInstanceFile } from '../workspace/adopt.ts';
import { initWorkspace } from '../workspace/init.ts';
import type { WorkspaceRef } from '../workspace/paths.ts';
import { zeroChildStats } from './health.ts';
import { createQueries, registerQueryPart, type AuditReader, type QueryDeps } from './index.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN = { instanceId: '22222222-2222-4222-8222-222222222222' };
const BUILD = { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' } as const;
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');
const PROBE = '00000000-0000-4000-8000-0000000000a1';

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

interface Fixture {
  readonly root: string;
  readonly skill: string;
  readonly repo: string;
  readonly ws: WorkspaceRef;
  readonly clock: FakeClock;
  readonly input: BuildContextInput;
}

interface FixtureOptions {
  readonly description?: string;
  readonly hooks?: boolean;
  /** Keys merged into the workspace's `config.json`. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** The whole `runtime.json`. */
  readonly runtime?: Readonly<Record<string, unknown>>;
}

/** A throw-away skill, a repo with one initialised workspace `demo` (instance id `ID`) and the input that builds its context. */
async function fixture(o: FixtureOptions = {}): Promise<Fixture> {
  const root = makeTemp('queries').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({
    repo,
    name: 'Demo',
    slug: 'demo',
    clock,
    newId: () => ID,
    ...(o.description === undefined ? {} : { description: o.description }),
  });
  if (o.config !== undefined) {
    const file = path.join(ws.dir, 'config.json');
    const current = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, 'utf8')));
    writeFileSync(file, `${JSON.stringify({ ...current, ...o.config }, null, 2)}\n`);
  }
  if (o.runtime !== undefined) writeFileSync(path.join(ws.dir, 'runtime.json'), JSON.stringify(o.runtime));
  if (o.hooks === true) {
    const instance = await readInstanceFile(ws);
    if (instance === null) throw new Error('the fixture workspace has no instance.json');
    await writeInstanceFile(ws, { ...instance, hooks: { enabled: true } });
  }
  const input: BuildContextInput = {
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: BUILD,
    clock,
    logger: silentLogger(),
  };
  return { root, skill, repo, ws, clock, input };
}

async function build(fx: Fixture, over: Partial<BuildContextInput> = {}): Promise<InstanceContext> {
  const ctx = await buildInstanceContext({ ...fx.input, ...over });
  opened.push(ctx);
  return ctx;
}

const noAudit: AuditReader = { entriesBetween: () => Promise.resolve([]) };

/** Deps like the server's: the six values, with fixed process facts. */
function serverDeps(ctx: InstanceContext, over: Partial<QueryDeps> = {}): QueryDeps {
  return {
    config: ctx.config,
    now: () => ctx.clock.now(),
    audit: noAudit,
    process: ctx.process,
    childStats: zeroChildStats,
    panelStats: () => ({}),
    ...over,
  };
}

function storedReport(ctx: InstanceContext, over: Partial<IngestHealth> = {}): IngestHealth {
  return {
    evaluatedAt: NOW - 1000,
    provider: { lastActivityAt: NOW - 2000, source: 'hook', status: 'active' },
    receiving: {
      hooks: {
        installed: [],
        lastEnvelopeAt: NOW - 2000,
        envelopes1h: 12,
        duplicates1h: 0,
        invalid1h: 0,
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
    runtime: { startedAt: NOW - 60_000, eventLoopDelayP99Ms: 1 },
    status: 'ok',
    reasons: [],
    ...over,
  };
}

function storeReport(ctx: InstanceContext, report: unknown): void {
  withWriteTx(ctx.db, ctx.scope, (tx) => {
    new IngestHealthRepo(ctx.db).save(ctx.scope, tx, {
      evaluatedAt: NOW - 1000,
      status: 'ok',
      lastEnvelopeAt: null,
      lastCommitAt: null,
      lastDrainAt: null,
      lastNudgeAt: null,
      lastScanAt: null,
      lastSyncAt: null,
      countersJson: '{}',
      reportJson: typeof report === 'string' ? report : JSON.stringify(report),
    });
  });
}

describe('buildInstanceContext registers the real query layer', () => {
  it('makes ctx.queries answer with this instance (the stub of WP-16 is gone)', async () => {
    const ctx = await build(await fixture());
    const info = ctx.queries.instanceInfo(ctx.scope);
    expect(info.instanceId).toBe(ID);
    expect(ctx.queries.health(ctx.scope).instanceId).toBe(ID);
  });

  it('carries the transcript search (WP-57): both searches and the counters of the health report', async () => {
    const ctx = await build(await fixture());
    expect(typeof ctx.queries.searchSession).toBe('function');
    expect(typeof ctx.queries.searchInstance).toBe('function');
    expect(ctx.queries.searchStats()).toEqual({
      total: 0,
      byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 },
    });
    // a foreign context is refused before anything is read, as everywhere in the layer
    const foreign = new AbortController().signal;
    await expect(
      ctx.queries.searchInstance(FOREIGN, { q: 'xx', limit: 1, budgetMs: 100 }, foreign),
    ).rejects.toMatchObject({
      code: 'scope_mismatch',
    });
    await expect(
      ctx.queries.searchSession(FOREIGN, { session: PROBE, limit: 1, budgetMs: 100 }, foreign),
    ).rejects.toMatchObject({ code: 'scope_mismatch' });
  });
});

describe('instanceInfo (03 6.2)', () => {
  it('describes the instance from the configuration, the database and the process', async () => {
    const fx = await fixture({ description: 'A synthetic task for the tests.' });
    const ctx = await build(fx);
    const info = ctx.queries.instanceInfo(ctx.scope);
    expect(InstanceInfoSchema.safeParse(info).success).toBe(true);
    expect(info).toMatchObject({
      instanceId: ID,
      slug: 'demo',
      title: 'Demo',
      description: 'A synthetic task for the tests.',
      runtimeVersion: RUNTIME_VERSION,
      codeStamp: 'abcdef0123',
      dbSchemaVersion: 1,
      headSeq: 0,
      epoch: ctx.db.epoch,
      staleAfterMs: 15_000,
      heartbeatMs: 15_000,
      windowHours: 8,
      limits: { pageMax: 200, eventsQueryWindowDays: 7, searchBudgetMsMax: 10_000, textChars: 6000 },
    });
    expect(info.retention.summary.length).toBeGreaterThan(20);
  });

  it('maps ui, panels and poll (registry C26: events_ms, overview_ms, healthMs = 5000)', async () => {
    const ctx = await build(
      await fixture({
        config: {
          ui: { theme: 'dark', newest_first: false, show_thinking: true },
          panels: { git: false, chain_log: true, attempts: true },
          poll: {
            events_ms: 2500,
            sessions_ms: 7000,
            machine_ms: 2100,
            logs_ms: 3100,
            overview_ms: 5100,
            attempts_ms: 6100,
            stale_after_ms: 20_000,
          },
        },
      }),
    );
    const info = ctx.queries.instanceInfo(ctx.scope);
    expect(info.ui).toEqual({
      theme: 'dark',
      density: 'comfortable',
      newestFirst: false,
      showTools: true,
      showThinking: true,
      showPrompts: false,
    });
    expect(info.panels).toEqual({
      git: false,
      machine: true,
      attempts: true,
      ledger: false,
      chainLog: true,
      logs: true,
    });
    expect(info.poll).toEqual({
      healthMs: 5000,
      sessionsMs: 7000,
      overviewMs: 5100,
      transcriptMs: 2500,
      machineMs: 2100,
      logsMs: 3100,
      attemptsMs: 6100,
    });
    expect(info.staleAfterMs).toBe(20_000);
  });

  it('derives the features from the configuration and from instance.json', async () => {
    const plain = await build(await fixture());
    // the instance-wide content search exists (WP-57) and the trend chart is on unless a task turns it off
    expect(plain.queries.instanceInfo(plain.scope).features).toEqual({
      transcriptSearch: 'instance',
      costEstimates: false,
      usageTrend: true,
      hooks: false,
    });
    const chartOff = await build(await fixture({ runtime: { schema_version: 1, analytics: { usageTrend: false } } }));
    expect(chartOff.queries.instanceInfo(chartOff.scope).features.usageTrend).toBe(false);
    const rich = await build(
      await fixture({
        hooks: true,
        runtime: {
          schema_version: 1,
          analytics: { usageTrend: true },
          pricing: {
            models: [
              {
                match: 'model-x',
                effectiveFrom: '2026-01-01',
                inputPerMTok: 1,
                outputPerMTok: 2,
                cacheReadPerMTok: 0.1,
                cacheWrite5mPerMTok: 1.25,
                cacheWrite1hPerMTok: 2,
              },
            ],
          },
        },
      }),
    );
    expect(rich.queries.instanceInfo(rich.scope).features).toEqual({
      transcriptSearch: 'instance',
      costEstimates: true,
      usageTrend: true,
      hooks: true,
    });
  });

  it('fills the six commands of 01 6.6 from the launcher of the skill, the slug, the repo and the workspace', async () => {
    const fx = await fixture();
    const ctx = await build(fx);
    const expected = instanceCommands({
      launcherPath: path.join(fx.skill, 'scripts', 'mcs.mjs'),
      slug: 'demo',
      repoDir: ctx.config.monitor.repo,
      instanceDir: fx.ws.dir,
    });
    expect(ctx.queries.instanceInfo(ctx.scope).commands).toEqual(expected);
    expect(expected.export).toContain('/logs/export.ndjson');
  });

  it('has headSeq of the change log and the epoch of this database open', async () => {
    const ctx = await build(await fixture());
    expect(ctx.queries.instanceInfo(ctx.scope).headSeq).toBe(0);
    withWriteTx(ctx.db, ctx.scope, (tx) => new AlertsRepo(ctx.db).insertOpen(ctx.scope, tx, alertInput()));
    const info = ctx.queries.instanceInfo(ctx.scope);
    expect(info.headSeq).toBe(ctx.db.headSeq());
    expect(info.headSeq).toBeGreaterThan(0);
    expect(info.epoch).toMatch(/^[0-9a-f]{8}$/);
  });
});

function alertInput(
  over: Partial<Parameters<AlertsRepo['insertOpen']>[2]> = {},
): Parameters<AlertsRepo['insertOpen']>[2] {
  return {
    ruleId: 'import_lag',
    ruleKind: 'import_lag',
    scopeKind: 'instance',
    scopeKey: 'instance',
    sessionId: null,
    sessionUid: null,
    severity: 'warning',
    title: 'Transcript import 90 s behind',
    detail: { lagMs: 90_000 },
    at: NOW - 5000,
    ...over,
  };
}

describe('health (DA-T-API-16, 03 6.2)', () => {
  it('parses, with the resources of the process, the database files and the stubbed statistics', async () => {
    const fx = await fixture();
    const ctx = await build(fx);
    const stats = {
      'git.status': { refreshes: 3, failures: 1, lastDurationMs: 12, lastStatus: 'ok' },
    } as const satisfies PanelStats;
    const children = zeroChildStats();
    children.git = { spawned: 4, failed: 1, timedOut: 0, totalMs: 80 };
    const queries = createQueries(ctx.db, serverDeps(ctx, { childStats: () => children, panelStats: () => stats }));
    const report = queries.health(ctx.scope);
    expect(HealthReportSchema.safeParse(report).success).toBe(true);
    expect(report.instanceId).toBe(ID);
    expect(report.epoch).toBe(ctx.db.epoch);
    expect(report.asOfSeq).toBe(ctx.db.headSeq());
    expect(report.checkedAt).toBe(isoMsZ(NOW));
    expect(report.runtime.version).toBe(RUNTIME_VERSION);
    expect(report.runtime.codeStamp).toBe('abcdef0123');
    expect(report.runtime.outdated).toBe(false);
    expect(report.runtime.pid).toBe(ctx.process.pid);
    expect(report.runtime.startedAt).toBe(isoMsZ(ctx.process.startedAtMs));
    expect(report.runtime.rssBytes).toBeGreaterThan(0);
    expect(report.runtime.heapUsedBytes).toBeGreaterThan(0);
    expect(report.db.ok).toBe(true);
    expect(report.db.sizeBytes).toBeGreaterThan(0);
    expect(report.db.walBytes).toBeGreaterThanOrEqual(0);
    expect(report.db.schemaVersion).toBe(1);
    expect(report.db.freeDiskBytes === null || report.db.freeDiskBytes > 0).toBe(true);
    expect(Object.keys(report.children).sort()).toEqual([...CHILD_KINDS].sort());
    expect(report.children.git).toEqual({ spawned: 4, failed: 1, timedOut: 0, totalMs: 80 });
    expect(report.panels).toEqual(stats);
  });

  it('reports the flags of ctx.process and the bound gauges, and is zero and false for the DbReader deps (CR-WP-18-5, CR-WP-17-3)', async () => {
    const ctx = await build(await fixture());
    const flagged = createQueries(
      ctx.db,
      serverDeps(ctx, {
        process: { ...ctx.process, previousRunUnclean: true, ownershipConflict: () => true },
        healthGauges: () => ({
          sseClients: 6,
          search: { total: 2, byStoppedBy: { complete: 2, match_limit: 0, time_budget: 0, cancelled: 0 } },
        }),
      }),
    );
    const report = flagged.health(ctx.scope);
    expect(HealthReportSchema.safeParse(report).success).toBe(true);
    expect(report.runtime).toMatchObject({ previousRunUnclean: true, ownershipConflict: true, sseClients: 6 });
    expect(report.runtime.search.total).toBe(2);

    const quiet = ctx.queries.health(ctx.scope);
    expect(quiet.runtime).toMatchObject({ previousRunUnclean: false, ownershipConflict: false, sseClients: 0 });

    const reader = createQueries(ctx.db, { config: ctx.config, now: () => NOW, audit: noAudit }).health(ctx.scope);
    expect(reader.runtime).toMatchObject({ previousRunUnclean: false, ownershipConflict: false, sseClients: 0 });
  });

  it('cpuUserMicros does not decrease across two calls', async () => {
    const ctx = await build(await fixture());
    const first = ctx.queries.health(ctx.scope);
    let busy = 0;
    for (let i = 0; i < 200_000; i += 1) busy += i % 7;
    expect(busy).toBeGreaterThan(0);
    const second = ctx.queries.health(ctx.scope);
    expect(second.runtime.cpuUserMicros).toBeGreaterThanOrEqual(first.runtime.cpuUserMicros);
    expect(second.runtime.cpuSystemMicros).toBeGreaterThanOrEqual(first.runtime.cpuSystemMicros);
  });

  it('asks the process for outdated and the uptime comes from the injected clock', async () => {
    const fx = await fixture();
    const ctx = await build(fx);
    const outdated: RuntimeProcessInfo['outdated'] = () => ({ outdated: true, reason: 'code_stamp_changed' });
    const queries = createQueries(
      ctx.db,
      serverDeps(ctx, { process: { ...ctx.process, outdated, startedAtMs: NOW - 30_000 } }),
    );
    const report = queries.health(ctx.scope);
    expect(report.runtime.outdated).toBe(true);
    expect(report.runtime.uptimeMs).toBe(30_000);
  });

  it('has zero children and no panels when the deps carry none (the DbReader), and falls back for the process facts', async () => {
    const ctx = await build(await fixture());
    const queries = createQueries(ctx.db, { config: ctx.config, now: () => NOW, audit: noAudit });
    const report = queries.health(ctx.scope);
    expect(HealthReportSchema.safeParse(report).success).toBe(true);
    expect(Object.keys(report.children).sort()).toEqual([...CHILD_KINDS].sort());
    expect(report.children.node).toEqual({ spawned: 0, failed: 0, timedOut: 0, totalMs: 0 });
    expect(report.panels).toEqual({});
    expect(report.runtime.pid).toBe(process.pid);
    expect(report.runtime.version).toBe(RUNTIME_VERSION);
    expect(report.runtime.outdated).toBe(false);
  });

  it('is degraded with the ingestion `unknown` before the ingest service stored a report', async () => {
    const ctx = await build(await fixture());
    const report = ctx.queries.health(ctx.scope);
    expect(report.status).toBe('degraded');
    expect(report.ingestion.status).toBe('unknown');
    expect(report.ingestion.reasons).toEqual(['NOT_EVALUATED']);
    expect(report.ingestion.hooks.enabled).toBe(false);
  });

  it('projects the stored report and follows hooks.enabled of instance.json (DA-T-API-13)', async () => {
    const ctx = await build(await fixture({ hooks: true }));
    storeReport(ctx, storedReport(ctx));
    const report = ctx.queries.health(ctx.scope);
    expect(report.status).toBe('ok');
    expect(report.ingestion.status).toBe('ok');
    expect(report.ingestion.hooks.enabled).toBe(true);
    expect(report.ingestion.hooks.lastReceivedAt).toBe(isoMsZ(NOW - 2000));
    expect(report.ingestion.transcripts.filesTracked).toBe(2);
  });

  it('is `error` when the stored report is down, and reads a damaged row as "not evaluated"', async () => {
    const ctx = await build(await fixture());
    storeReport(ctx, storedReport(ctx, { status: 'down' }));
    expect(ctx.queries.health(ctx.scope).status).toBe('error');
    storeReport(ctx, '[]'); // valid JSON (the column has a json_valid CHECK) that is not an IngestHealth
    expect(ctx.queries.health(ctx.scope).ingestion.status).toBe('unknown');
  });

  it('lists the open alerts newest first, at most 20, and is degraded by a critical one', async () => {
    const ctx = await build(await fixture());
    storeReport(ctx, storedReport(ctx));
    const repo = new AlertsRepo(ctx.db);
    withWriteTx(ctx.db, ctx.scope, (tx) => {
      repo.insertOpen(ctx.scope, tx, alertInput({ ruleId: 'a', at: NOW - 3000 }));
      repo.insertOpen(ctx.scope, tx, alertInput({ ruleId: 'b', ruleKind: 'db_disk', at: NOW - 1000 }));
    });
    let report = ctx.queries.health(ctx.scope);
    expect(report.alerts.map((a) => a.ruleId)).toEqual(['b', 'a']);
    expect(report.status).toBe('ok');
    withWriteTx(ctx.db, ctx.scope, (tx) => {
      repo.insertOpen(ctx.scope, tx, alertInput({ ruleId: 'c', ruleKind: 'hook_failing', severity: 'critical' }));
    });
    report = ctx.queries.health(ctx.scope);
    expect(report.status).toBe('degraded');
    expect(report.alerts.some((a) => a.severity === 'critical')).toBe(true);
    withWriteTx(ctx.db, ctx.scope, (tx) => {
      for (let i = 0; i < 25; i += 1)
        repo.insertOpen(ctx.scope, tx, alertInput({ ruleId: `r${String(i)}`, scopeKey: `k${String(i)}` }));
    });
    expect(ctx.queries.health(ctx.scope).alerts).toHaveLength(20);
    expect(HealthReportSchema.safeParse(ctx.queries.health(ctx.scope)).success).toBe(true);
  });
});

describe('ingestHealth (DA-T-API-13)', () => {
  it('equals the stored report plus asOfSeq', async () => {
    const ctx = await build(await fixture());
    const report = storedReport(ctx, { evaluatedAt: NOW - 4321 });
    storeReport(ctx, report);
    const answer = ctx.queries.ingestHealth(ctx.scope);
    expect(answer).toEqual({ ...report, asOfSeq: ctx.db.headSeq() });
  });

  it('says it was not evaluated when nothing was stored, and for a damaged row', async () => {
    const ctx = await build(await fixture());
    for (const stored of [null, '[]', '{}']) {
      if (stored !== null) storeReport(ctx, stored);
      const answer = ctx.queries.ingestHealth(ctx.scope);
      const { asOfSeq, ...report } = answer;
      expect(IngestHealthSchema.safeParse(report).success).toBe(true);
      expect(asOfSeq).toBe(ctx.db.headSeq());
      expect(report.status).toBe('degraded');
      expect(report.reasons.map((r) => r.code)).toEqual(['NOT_EVALUATED']);
      expect(report.evaluatedAt).toBe(NOW);
    }
  });
});

describe('hookProbe (DA-T-API-14, I-37)', () => {
  it('answers receivedAt and committedAt of a committed probe, and null for an unknown one', async () => {
    const ctx = await build(await fixture());
    withWriteTx(ctx.db, ctx.scope, (tx) => {
      new HookProbesRepo(ctx.db).insert(ctx.scope, tx, {
        probeSessionId: PROBE,
        receivedAt: NOW - 50,
        committedAt: NOW,
      });
    });
    expect(ctx.queries.hookProbe(ctx.scope, PROBE)).toEqual({ receivedAt: isoMsZ(NOW - 50), committedAt: isoMsZ(NOW) });
    expect(ctx.queries.hookProbe(ctx.scope, '00000000-0000-4000-8000-0000000000a2')).toBeNull();
    expect(ctx.db.headSeq()).toBe(0); // a probe never becomes a change, a session or an event
  });
});

describe('every query is scoped to the instance (DA-I3)', () => {
  it('refuses a foreign context with scope_mismatch before reading anything', async () => {
    const ctx = await build(await fixture());
    const calls: Record<string, () => unknown> = {
      instanceInfo: () => ctx.queries.instanceInfo(FOREIGN),
      health: () => ctx.queries.health(FOREIGN),
      ingestHealth: () => ctx.queries.ingestHealth(FOREIGN),
      hookProbe: () => ctx.queries.hookProbe(FOREIGN, PROBE),
    };
    for (const [name, call] of Object.entries(calls)) {
      let caught: unknown;
      try {
        call();
      } catch (error) {
        caught = error;
      }
      expect(isDbError(caught, 'scope_mismatch'), name).toBe(true);
    }
  });

  it('checks the scope first: a foreign context is refused before the clock, the process or the database is touched', async () => {
    const ctx = await build(await fixture());
    const now = vi.fn(() => NOW);
    const queries = createQueries(ctx.db, serverDeps(ctx, { now }));
    now.mockClear(); // the layer reads the clock once when it is created (the start of a runtime without process facts)
    for (const call of [() => queries.health(FOREIGN), () => queries.ingestHealth(FOREIGN)]) {
      expect(call).toThrow(expect.objectContaining({ code: 'scope_mismatch' }));
    }
    expect(now).not.toHaveBeenCalled();
    queries.health(ctx.scope); // the same layer answers its own instance, and asks the clock
    expect(now).toHaveBeenCalled();
  });

  it('answers synchronously (one synchronous step, DA-I8)', async () => {
    const ctx = await build(await fixture());
    for (const value of [
      ctx.queries.instanceInfo(ctx.scope),
      ctx.queries.health(ctx.scope),
      ctx.queries.ingestHealth(ctx.scope),
      ctx.queries.hookProbe(ctx.scope, PROBE),
    ]) {
      expect(value instanceof Promise).toBe(false);
    }
  });
});

describe('sessionAuditRefs (DA-T-API-17, I-19)', () => {
  const detail = { startedAt: isoMsZ(NOW - 60_000), endedAt: isoMsZ(NOW - 1000), lastActivityAt: isoMsZ(NOW - 2000) };
  const ref = { file: 'changes', at: isoMsZ(NOW - 5000), title: 'init', summary: 'Created the task.' } as const;

  it('reads the entries of the session window (ended: to endedAt + 1 ms; open: to lastActivityAt + 1 ms) and passes them on', async () => {
    const ctx = await build(await fixture());
    const entriesBetween = vi.fn<AuditReader['entriesBetween']>(() => Promise.resolve([ref]));
    const queries = createQueries(ctx.db, serverDeps(ctx, { audit: { entriesBetween } }));
    expect(await queries.sessionAuditRefs(detail)).toEqual([ref]);
    expect(entriesBetween).toHaveBeenLastCalledWith(NOW - 60_000, NOW - 1000 + 1, 10);
    expect(await queries.sessionAuditRefs({ ...detail, endedAt: null })).toEqual([ref]);
    expect(entriesBetween).toHaveBeenLastCalledWith(NOW - 60_000, NOW - 2000 + 1, 10);
  });

  it('gives [] for a rejected read, a read that throws at once, and a time that is not a date', async () => {
    const ctx = await build(await fixture());
    const rejecting = createQueries(
      ctx.db,
      serverDeps(ctx, { audit: { entriesBetween: () => Promise.reject(new Error('disk')) } }),
    );
    expect(await rejecting.sessionAuditRefs(detail)).toEqual([]);
    const throwing = createQueries(
      ctx.db,
      serverDeps(ctx, {
        audit: {
          entriesBetween: () => {
            throw new Error('sync failure');
          },
        },
      }),
    );
    expect(await throwing.sessionAuditRefs(detail)).toEqual([]);
    const entriesBetween = vi.fn(() => Promise.resolve([ref]));
    const strict = createQueries(ctx.db, serverDeps(ctx, { audit: { entriesBetween } }));
    expect(await strict.sessionAuditRefs({ ...detail, startedAt: 'not a time' })).toEqual([]);
    expect(entriesBetween).not.toHaveBeenCalled();
  });

  it('reads the real audit files of the workspace through the context', async () => {
    const ctx = await build(await fixture());
    const refs = await ctx.queries.sessionAuditRefs({
      startedAt: isoMsZ(NOW - 10_000),
      endedAt: isoMsZ(NOW + 10_000),
      lastActivityAt: isoMsZ(NOW),
    });
    expect(refs.length).toBeGreaterThan(0); // `init` wrote its entry into audit/changes.md
    expect(refs.map((r) => r.file)).toContain('changes');
  });
});

describe('registerQueryPart: the extension point of the later work packages', () => {
  it('adds the methods of a part to every query layer that is created afterwards', async () => {
    const ctx = await build(await fixture());
    const part = vi.fn(() => ({ extraQuery: (): string => 'extra' }));
    const unregister = registerQueryPart(part, ['extraQuery']);
    try {
      const queries: Record<string, unknown> = { ...createQueries(ctx.db, serverDeps(ctx)) };
      expect(typeof queries['extraQuery']).toBe('function');
      expect(part).toHaveBeenCalledTimes(1);
      expect(typeof queries['health']).toBe('function');
    } finally {
      unregister();
    }
    expect(Object.hasOwn(createQueries(ctx.db, serverDeps(ctx)), 'extraQuery')).toBe(false);
  });

  it('refuses a layer that lacks a method a part promised', async () => {
    const ctx = await build(await fixture());
    const unregister = registerQueryPart(() => ({}), ['promisedQuery']);
    try {
      expect(() => createQueries(ctx.db, serverDeps(ctx))).toThrow(/promisedQuery/);
    } finally {
      unregister();
    }
  });
});
