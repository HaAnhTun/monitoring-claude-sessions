import { describe, expect, it } from 'vitest';

import { ErrorItemSchema, HealthReportSchema, HookProbeResultSchema, InstanceInfoSchema } from './health.ts';
import { CHILD_KINDS } from './panels.ts';

/** A copy of `value` without the key `omit` (the tests need an object with a missing field). */
function without(value: object, omit: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omit));
}

const AT = '2026-10-11T10:00:00.000Z';

const errorItem = {
  at: AT,
  source: 'server',
  code: 'INTERNAL',
  where: 'listSessions',
  message: 'Internal error.',
  sessionId: null,
};

const children = Object.fromEntries(CHILD_KINDS.map((k) => [k, { spawned: 0, failed: 0, timedOut: 0, totalMs: 0 }]));

const report = {
  checkedAt: AT,
  status: 'ok',
  instanceId: '3f2b8c1e-0d4a-4b7e-9c11-5a6d7e8f9a0b',
  asOfSeq: 12,
  epoch: 'deadbeef',
  runtime: {
    version: '3.0.0',
    codeStamp: 'abc123',
    outdated: false,
    pid: 4242,
    startedAt: AT,
    uptimeMs: 5000,
    eventLoopDelayP99Ms: 1.5,
    rssBytes: 100_000_000,
    heapUsedBytes: 20_000_000,
    cpuUserMicros: 123,
    cpuSystemMicros: 45,
    sseClients: 1,
    search: { total: 3, byStoppedBy: { complete: 2, match_limit: 1, time_budget: 0, cancelled: 0 } },
  },
  db: { ok: true, sizeBytes: 1000, walBytes: 0, freeDiskBytes: null, schemaVersion: 1, lastError: null },
  ingestion: {
    status: 'ok',
    reasons: [],
    hooks: {
      enabled: true,
      installed: true,
      lastReceivedAt: AT,
      lastEventAt: AT,
      spoolPendingBytes: 0,
      spoolLagMs: null,
      errorsLastHour: 0,
      lastError: null,
    },
    transcripts: {
      dirFound: true,
      filesTracked: 3,
      lastScanAt: AT,
      lastImportedAt: AT,
      importLagMs: 10,
      pendingBytes: 0,
      invalidLines: 0,
      errorsLastHour: 1,
      lastError: errorItem,
    },
  },
  children,
  panels: { memory: { refreshes: 2, failures: 0, lastDurationMs: 3, lastStatus: 'ok' } },
  alerts: [],
  errors: [errorItem],
};

const info = {
  instanceId: '3f2b8c1e-0d4a-4b7e-9c11-5a6d7e8f9a0b',
  slug: 'demo',
  title: 'Demo',
  description: null,
  runtimeVersion: '3.0.0',
  codeStamp: 'abc123',
  dbSchemaVersion: 1,
  headSeq: 12,
  epoch: 'deadbeef',
  staleAfterMs: 15000,
  heartbeatMs: 15000,
  windowHours: 6,
  ui: {
    theme: 'auto',
    density: 'comfortable',
    newestFirst: true,
    showTools: true,
    showThinking: false,
    showPrompts: true,
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
  features: { transcriptSearch: 'session', costEstimates: false, usageTrend: false, hooks: true },
  retention: { summary: 'Keeps data for 90 days.' },
  commands: { status: 's', restart: 'r', inspect: 'i', export: 'e', backup: 'b', cleanupDryRun: 'c' },
  limits: { pageMax: 200, eventsQueryWindowDays: 7, searchBudgetMsMax: 10000, textChars: 6000 },
};

describe('HealthReport (03 6.2, registry C51)', () => {
  it('parses the full report, including resources, children and panels (I-21)', () => {
    expect(HealthReportSchema.parse(report)).toEqual(report);
  });

  it('children must hold every ChildKind (zeros when never spawned)', () => {
    expect(HealthReportSchema.safeParse({ ...report, children: without(children, 'opener') }).success).toBe(false);
    expect(HealthReportSchema.safeParse({ ...report, children: { ...children, bash: children['git'] } }).success).toBe(
      false,
    );
  });

  it('children use ChildKindStats (never the old ChildStat name or shape)', () => {
    expect(
      HealthReportSchema.safeParse({ ...report, children: { ...children, git: { count: 1, failures: 0, totalMs: 1 } } })
        .success,
    ).toBe(false);
  });

  it('has no configWarnings field (C43) and no undocumented key', () => {
    expect(HealthReportSchema.safeParse({ ...report, configWarnings: [] }).success).toBe(false);
    expect(HealthReportSchema.safeParse({ ...report, runtime: { ...report.runtime, extra: 1 } }).success).toBe(false);
  });

  it('checks the status vocabularies', () => {
    expect(HealthReportSchema.safeParse({ ...report, status: 'fine' }).success).toBe(false);
    expect(
      HealthReportSchema.safeParse({ ...report, ingestion: { ...report.ingestion, status: 'stalled' } }).success,
    ).toBe(true);
    expect(
      HealthReportSchema.safeParse({ ...report, ingestion: { ...report.ingestion, status: 'broken' } }).success,
    ).toBe(false);
    expect(HealthReportSchema.safeParse({ ...report, epoch: 'xyz' }).success).toBe(false);
  });

  it('keeps alerts and errors bounded at 20', () => {
    expect(
      HealthReportSchema.safeParse({ ...report, errors: Array.from({ length: 21 }, () => errorItem) }).success,
    ).toBe(false);
    expect(
      HealthReportSchema.safeParse({ ...report, errors: Array.from({ length: 20 }, () => errorItem) }).success,
    ).toBe(true);
  });
});

describe('InstanceInfo (03 6.2, registry C26)', () => {
  it('parses and has exactly the seven poll keys (healthMs is the constant 5000)', () => {
    expect(InstanceInfoSchema.parse(info)).toEqual(info);
    expect(Object.keys(info.poll).sort()).toEqual([
      'attemptsMs',
      'healthMs',
      'logsMs',
      'machineMs',
      'overviewMs',
      'sessionsMs',
      'transcriptMs',
    ]);
    expect(InstanceInfoSchema.safeParse({ ...info, poll: without(info.poll, 'overviewMs') }).success).toBe(false);
    expect(InstanceInfoSchema.safeParse({ ...info, poll: { ...info.poll, gitMs: 1 } }).success).toBe(false);
  });

  it('limits are the literal constants of the API', () => {
    expect(InstanceInfoSchema.safeParse({ ...info, limits: { ...info.limits, pageMax: 100 } }).success).toBe(false);
    expect(
      InstanceInfoSchema.safeParse({ ...info, features: { ...info.features, transcriptSearch: 'instance' } }).success,
    ).toBe(true);
    expect(
      InstanceInfoSchema.safeParse({ ...info, features: { ...info.features, transcriptSearch: 'both' } }).success,
    ).toBe(false);
  });

  it('panels flags cover the six panel keys', () => {
    expect(InstanceInfoSchema.safeParse({ ...info, panels: without(info.panels, 'logs') }).success).toBe(false);
  });
});

describe('ErrorItem and HookProbeResult', () => {
  it('ErrorItem has six fields', () => {
    expect(ErrorItemSchema.parse(errorItem)).toEqual(errorItem);
    expect(ErrorItemSchema.safeParse({ ...errorItem, detail: 'x' }).success).toBe(false);
    expect(ErrorItemSchema.safeParse({ ...errorItem, where: undefined }).success).toBe(false);
  });

  it('HookProbeResult is { receivedAt, committedAt }', () => {
    expect(HookProbeResultSchema.safeParse({ receivedAt: AT, committedAt: AT }).success).toBe(true);
    expect(HookProbeResultSchema.safeParse({ receivedAt: AT }).success).toBe(false);
    expect(HookProbeResultSchema.safeParse({ receivedAt: AT, committedAt: AT, asOfSeq: 1 }).success).toBe(false);
  });
});
