// The pure part of the health and instance queries (03 6.2, DA-T-API-13 and 16): the projection of the stored
// `IngestHealth` onto `HealthReport.ingestion`, the status rules of the report, the alert mapping, the disk probe and the
// "not evaluated yet" report.
import {
  CHILD_KINDS,
  HealthReportSchema,
  IngestHealthSchema,
  isoMsZ,
  type AlertItem,
  type ChildKindStats,
  type IngestHealth,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { AlertRow } from '../db/repos/alerts.ts';
import {
  INGEST_NOT_EVALUATED,
  buildHealthReport,
  createDiskProbe,
  emptyIngestHealth,
  eventLoopDelayP99Ms,
  parseStoredIngestHealth,
  projectIngestion,
  toAlertItem,
  zeroChildStats,
  type HealthFacts,
} from './health.ts';

const NOW = Date.UTC(2026, 9, 11, 14, 5, 7, 250);
const STARTED = NOW - 90_000;
const ID = '11111111-1111-4111-8111-111111111111';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BACKLOG_WARN_MS = 10_000;

/** A fully valid report in which every block is healthy. */
function okReport(over: Partial<IngestHealth> = {}): IngestHealth {
  return {
    evaluatedAt: NOW - 1000,
    provider: { lastActivityAt: NOW - 2000, source: 'hook', status: 'active' },
    receiving: {
      hooks: {
        installed: [{ scope: 'project', settingsPath: 'settings.json', verifiedAt: NOW - 60_000, ok: true }],
        lastEnvelopeAt: NOW - 2000,
        envelopes1h: 40,
        duplicates1h: 0,
        invalid1h: 0,
        handlerErrors: [],
        transcriptHookFailures: 0,
        coverage: { full: 3, partial: 0, none: 0 },
        status: 'ok',
      },
      spool: {
        segments: 1,
        bytes: 2048,
        bytesBehind: 0,
        oldestPendingReceivedAt: null,
        lastNudgeAt: NOW - 3000,
        lastDrainAt: NOW - 2500,
        foreignFiles: 0,
      },
      transcripts: {
        dir: 'transcripts',
        dirFound: true,
        filesTracked: 4,
        filesMissing: 0,
        filesUnreadable: 0,
        bytesBehind: 0,
        maxLagMs: 120,
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
      commitP95Ms: 3,
      failures1h: 0,
      lastError: null,
      status: 'ok',
    },
    display: { headSeq: 12, serverTime: NOW - 1000 },
    runtime: { startedAt: STARTED, eventLoopDelayP99Ms: 4 },
    status: 'ok',
    reasons: [],
    ...over,
  };
}

const PROJECTION = { nowMs: NOW, hooksEnabled: true, backlogWarnMs: BACKLOG_WARN_MS } as const;

describe('fixtures', () => {
  it('the healthy report is a valid IngestHealth', () => {
    expect(IngestHealthSchema.safeParse(okReport()).success).toBe(true);
  });
});

describe('projectIngestion (02 8.2 "Projection to the UI")', () => {
  it('maps a healthy report field by field', () => {
    const projected = projectIngestion(okReport(), PROJECTION);
    expect(projected.status).toBe('ok');
    expect(projected.reasons).toEqual([]);
    expect(projected.hooks).toEqual({
      enabled: true,
      installed: true,
      lastReceivedAt: isoMsZ(NOW - 2000),
      lastEventAt: isoMsZ(NOW - 2500),
      spoolPendingBytes: 0,
      spoolLagMs: null,
      errorsLastHour: 0,
      lastError: null,
    });
    expect(projected.transcripts).toEqual({
      dirFound: true,
      filesTracked: 4,
      lastScanAt: isoMsZ(NOW - 4000),
      lastImportedAt: isoMsZ(NOW - 3500),
      importLagMs: 120,
      pendingBytes: 0,
      invalidLines: 0,
      errorsLastHour: 0,
      lastError: null,
    });
    expect(HealthReportSchema.shape.ingestion.safeParse(projected).success).toBe(true);
  });

  it('is `down` when the report is down, whatever else it says', () => {
    const report = okReport({ status: 'down', reasons: [{ code: 'DB_ERROR', severity: 'error', since: NOW - 5000 }] });
    const projected = projectIngestion(report, PROJECTION);
    expect(projected.status).toBe('down');
    expect(projected.reasons).toEqual(['DB_ERROR']);
  });

  it('is `stalled` for a persisted backlog, and for a spool backlog older than health.backlogWarnMs', () => {
    const backlog = okReport({
      status: 'degraded',
      persisted: { ...okReport().persisted, queueItems: 5, status: 'backlog' },
      reasons: [{ code: 'SPOOL_BACKLOG', severity: 'warn', since: NOW - 20_000 }],
    });
    expect(projectIngestion(backlog, PROJECTION).status).toBe('stalled');

    const spool = (pendingSince: number): IngestHealth =>
      okReport({
        receiving: {
          ...okReport().receiving,
          spool: { ...okReport().receiving.spool, bytesBehind: 900, oldestPendingReceivedAt: pendingSince },
        },
      });
    expect(projectIngestion(spool(NOW - BACKLOG_WARN_MS - 1), PROJECTION).status).toBe('stalled');
    expect(projectIngestion(spool(NOW - BACKLOG_WARN_MS), PROJECTION).status).toBe('ok');
    expect(projectIngestion(spool(NOW - 100), PROJECTION).status).toBe('ok');
  });

  it('is `degraded` for any other non-ok report, and never `disabled`', () => {
    const lagging = okReport({
      status: 'degraded',
      reasons: [{ code: 'IMPORT_LAG', severity: 'warn', since: NOW - 40_000 }],
    });
    expect(projectIngestion(lagging, PROJECTION).status).toBe('degraded');
    expect(projectIngestion(lagging, { ...PROJECTION, hooksEnabled: false }).status).toBe('degraded');
  });

  it('reports hooks that are switched off or not installed in the hooks block, not in the status', () => {
    const none = okReport({
      receiving: {
        ...okReport().receiving,
        hooks: { ...okReport().receiving.hooks, installed: [], lastEnvelopeAt: null, status: 'not_installed' },
      },
    });
    const projected = projectIngestion(none, { ...PROJECTION, hooksEnabled: false });
    expect(projected.status).toBe('ok');
    expect(projected.hooks.enabled).toBe(false);
    expect(projected.hooks.installed).toBe(false);
    expect(projected.hooks.lastReceivedAt).toBeNull();
  });

  it('computes the spool lag, the error counts and the last handler error', () => {
    const report = okReport({
      receiving: {
        ...okReport().receiving,
        hooks: {
          ...okReport().receiving.hooks,
          invalid1h: 2,
          handlerErrors: [
            { code: 'SPOOL_WRITE_FAILED', count: 3, lastAt: NOW - 60_000 },
            { code: 'HANDLER_UNAVAILABLE', count: 1, lastAt: NOW - 120_000 },
            { code: 'OLD_ONE', count: 50, lastAt: NOW - 3_600_001 },
          ],
        },
        spool: { ...okReport().receiving.spool, bytesBehind: 4096, oldestPendingReceivedAt: NOW - 7000 },
        transcripts: {
          ...okReport().receiving.transcripts,
          bytesBehind: 100,
          backfillRemainingBytes: 25,
          errors: { invalid_json: 2, not_object: 1, shape_invalid: 4, FILE_UNREADABLE: 3 },
        },
      },
    });
    const projected = projectIngestion(report, PROJECTION);
    expect(projected.hooks.spoolPendingBytes).toBe(4096);
    expect(projected.hooks.spoolLagMs).toBe(7000);
    expect(projected.hooks.errorsLastHour).toBe(2 + 3 + 1);
    expect(projected.hooks.lastError).toEqual({
      at: isoMsZ(NOW - 60_000),
      source: 'handler',
      code: 'SPOOL_WRITE_FAILED',
      where: null,
      message: 'hook handler error SPOOL_WRITE_FAILED',
      sessionId: null,
    });
    expect(projected.transcripts.pendingBytes).toBe(125);
    expect(projected.transcripts.invalidLines).toBe(2 + 1 + 4);
    expect(projected.transcripts.errorsLastHour).toBe(2 + 1 + 4 + 3);
  });

  it('ignores a handler error that is older than an hour: no last error, no count; one of exactly an hour still counts', () => {
    const withErrors = (handlerErrors: IngestHealth['receiving']['hooks']['handlerErrors']): IngestHealth =>
      okReport({
        receiving: { ...okReport().receiving, hooks: { ...okReport().receiving.hooks, invalid1h: 1, handlerErrors } },
      });
    const old = projectIngestion(withErrors([{ code: 'OLD_ONE', count: 5, lastAt: NOW - 3_600_001 }]), PROJECTION);
    expect(old.hooks.lastError).toBeNull();
    expect(old.hooks.errorsLastHour).toBe(1);
    const edge = projectIngestion(withErrors([{ code: 'EDGE', count: 5, lastAt: NOW - 3_600_000 }]), PROJECTION);
    expect(edge.hooks.lastError?.code).toBe('EDGE');
    expect(edge.hooks.lastError?.at).toBe(isoMsZ(NOW - 3_600_000));
    expect(edge.hooks.errorsLastHour).toBe(1 + 5);
  });

  it('never reports a negative spool lag when the oldest pending envelope was received after `now`', () => {
    const report = okReport({
      receiving: {
        ...okReport().receiving,
        spool: { ...okReport().receiving.spool, bytesBehind: 10, oldestPendingReceivedAt: NOW + 5000 },
      },
    });
    const projected = projectIngestion(report, PROJECTION);
    expect(projected.hooks.spoolLagMs).toBe(0);
    expect(projected.status).toBe('ok'); // a spool that is 0 ms behind is not stalled
  });

  it('answers `unknown` with the NOT_EVALUATED reason when no report was stored yet', () => {
    const projected = projectIngestion(null, PROJECTION);
    expect(projected.status).toBe('unknown');
    expect(projected.reasons).toEqual([INGEST_NOT_EVALUATED]);
    expect(projected.hooks.enabled).toBe(true);
    expect(projected.hooks.installed).toBeNull();
    expect(projected.transcripts.dirFound).toBe(false);
    expect(HealthReportSchema.shape.ingestion.safeParse(projected).success).toBe(true);
  });
});

describe('emptyIngestHealth and parseStoredIngestHealth', () => {
  it('the not-evaluated report is a valid IngestHealth that says so', () => {
    const empty = emptyIngestHealth({ nowMs: NOW, startedAtMs: STARTED, headSeq: 7, eventLoopDelayP99Ms: 2 });
    expect(IngestHealthSchema.safeParse(empty).success).toBe(true);
    expect(empty.status).toBe('degraded');
    expect(empty.reasons).toEqual([{ code: INGEST_NOT_EVALUATED, severity: 'warn', since: STARTED }]);
    expect(empty.display).toEqual({ headSeq: 7, serverTime: NOW });
    expect(empty.runtime).toEqual({ startedAt: STARTED, eventLoopDelayP99Ms: 2 });
  });

  it('parses a stored report and refuses everything else', () => {
    const report = okReport();
    expect(parseStoredIngestHealth(JSON.stringify(report))).toEqual(report);
    expect(parseStoredIngestHealth('not json')).toBeNull();
    expect(parseStoredIngestHealth('{}')).toBeNull();
    expect(parseStoredIngestHealth(JSON.stringify({ ...report, extra: 1 }))).toBeNull();
    expect(parseStoredIngestHealth('null')).toBeNull();
  });
});

function facts(over: Partial<HealthFacts> = {}): HealthFacts {
  return {
    nowMs: NOW,
    instanceId: ID,
    asOfSeq: 12,
    epoch: 'deadbeef',
    runtime: { version: '3.0.0', codeStamp: 'abc123', outdated: false, pid: 4242, startedAtMs: STARTED },
    resources: {
      eventLoopDelayP99Ms: 3.5,
      rssBytes: 100_000_000,
      heapUsedBytes: 40_000_000,
      cpuUserMicros: 1_200_000,
      cpuSystemMicros: 300_000,
    },
    db: { sizeBytes: 4096, walBytes: 0, freeDiskBytes: 1_000_000, schemaVersion: 1 },
    report: okReport(),
    hooksEnabled: true,
    backlogWarnMs: BACKLOG_WARN_MS,
    children: undefined,
    panels: undefined,
    alerts: [],
    criticalAlertsOpen: false,
    ...over,
  };
}

function alertRow(over: Partial<AlertRow> = {}): AlertRow {
  return {
    id: 9,
    ruleId: 'db_disk',
    ruleKind: 'db_disk',
    scopeKind: 'instance',
    scopeKey: 'instance',
    sessionId: 3,
    severity: 'critical',
    status: 'open',
    title: 'Disk space is low',
    detail: { freeMb: 100, low: true, note: null, unit: 'MB' },
    firstFiredAt: NOW - 600_000,
    lastFiredAt: NOW - 1000,
    fireCount: 4,
    resolvedAt: null,
    resolvedReason: null,
    updatedSeq: 77,
    ...over,
  };
}

describe('buildHealthReport (03 6.2 status rules)', () => {
  it('builds a valid report: ok, zero children for every kind, no panels, uptime from the process start', () => {
    const report = buildHealthReport(facts());
    expect(HealthReportSchema.safeParse(report).success).toBe(true);
    expect(report.status).toBe('ok');
    expect(report.checkedAt).toBe(isoMsZ(NOW));
    expect(report.instanceId).toBe(ID);
    expect(report.asOfSeq).toBe(12);
    expect(report.epoch).toBe('deadbeef');
    expect(report.runtime).toMatchObject({
      version: '3.0.0',
      codeStamp: 'abc123',
      outdated: false,
      pid: 4242,
      startedAt: isoMsZ(STARTED),
      uptimeMs: 90_000,
      eventLoopDelayP99Ms: 3.5,
      rssBytes: 100_000_000,
      heapUsedBytes: 40_000_000,
      cpuUserMicros: 1_200_000,
      cpuSystemMicros: 300_000,
      sseClients: 0,
      search: { total: 0, byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 } },
    });
    expect(report.db).toEqual({
      ok: true,
      sizeBytes: 4096,
      walBytes: 0,
      freeDiskBytes: 1_000_000,
      schemaVersion: 1,
      lastError: null,
    });
    expect(Object.keys(report.children).sort()).toEqual([...CHILD_KINDS].sort());
    expect(report.children.git).toEqual({ spawned: 0, failed: 0, timedOut: 0, totalMs: 0 });
    expect(report.panels).toEqual({});
    expect(report.alerts).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it('never reports a negative uptime when the clock is behind the start', () => {
    expect(buildHealthReport(facts({ nowMs: STARTED - 10 })).runtime.uptimeMs).toBe(0);
  });

  it('passes the children and panel statistics through unchanged', () => {
    const children = zeroChildStats();
    const git: ChildKindStats = { spawned: 5, failed: 1, timedOut: 0, totalMs: 120 };
    children.git = git;
    const panels = { 'git.status': { refreshes: 2, failures: 0, lastDurationMs: 4, lastStatus: 'ok' } } as const;
    const report = buildHealthReport(facts({ children, panels }));
    expect(report.children.git).toEqual(git);
    expect(report.panels).toEqual(panels);
  });

  it('is `error` when the database is not ok or ingestion is down', () => {
    const failing = okReport({
      persisted: { ...okReport().persisted, status: 'failing', lastError: { code: 'db_io', at: NOW - 1000 } },
      status: 'down',
    });
    const report = buildHealthReport(facts({ report: failing }));
    expect(report.status).toBe('error');
    expect(report.db.ok).toBe(false);
    expect(report.db.lastError).toBe('db_io');
    const dbError = okReport({
      persisted: { ...okReport().persisted, status: 'db_error', lastError: { code: 'db_full', at: NOW } },
    });
    expect(buildHealthReport(facts({ report: dbError })).status).toBe('error');
    const downReport = buildHealthReport(facts({ report: okReport({ status: 'down' }) }));
    expect(downReport.db.ok).toBe(true);
    expect(downReport.status).toBe('error');
  });

  it('is `degraded` when ingestion is not ok, when no report exists yet, or when a critical alert is open', () => {
    const lagging = okReport({ status: 'degraded', reasons: [{ code: 'IMPORT_LAG', severity: 'warn', since: NOW }] });
    expect(buildHealthReport(facts({ report: lagging })).status).toBe('degraded');
    expect(buildHealthReport(facts({ report: null })).status).toBe('degraded');
    expect(buildHealthReport(facts({ criticalAlertsOpen: true })).status).toBe('degraded');
  });

  it('copies the alerts and the outdated flag', () => {
    const alert: AlertItem = toAlertItem(alertRow(), SESSION);
    const report = buildHealthReport(facts({ alerts: [alert], runtime: { ...facts().runtime, outdated: true } }));
    expect(report.alerts).toEqual([alert]);
    expect(report.runtime.outdated).toBe(true);
    expect(HealthReportSchema.safeParse(report).success).toBe(true);
  });
});

describe('toAlertItem', () => {
  it('maps a row to the API item', () => {
    expect(toAlertItem(alertRow(), SESSION)).toEqual({
      id: 9,
      seq: 77,
      ruleId: 'db_disk',
      rule: 'db_disk',
      severity: 'critical',
      status: 'open',
      title: 'Disk space is low',
      scope: { kind: 'instance', key: 'instance' },
      sessionId: SESSION,
      since: isoMsZ(NOW - 600_000),
      lastFiredAt: isoMsZ(NOW - 1000),
      fireCount: 4,
      resolvedAt: null,
      resolvedReason: null,
      detail: { freeMb: 100, low: true, note: null, unit: 'MB' },
    });
  });

  it('has a null session when the alert has none or the session is gone', () => {
    expect(toAlertItem(alertRow({ sessionId: null }), undefined).sessionId).toBeNull();
    expect(toAlertItem(alertRow(), undefined).sessionId).toBeNull();
  });

  it('maps a resolved alert', () => {
    const item = toAlertItem(
      alertRow({ status: 'resolved', resolvedAt: NOW, resolvedReason: 'condition_cleared' }),
      undefined,
    );
    expect(item.status).toBe('resolved');
    expect(item.resolvedAt).toBe(isoMsZ(NOW));
    expect(item.resolvedReason).toBe('condition_cleared');
  });
});

describe('createDiskProbe', () => {
  it('reads the free bytes (available blocks times block size) and caches them for 30 seconds', () => {
    let calls = 0;
    const probe = createDiskProbe(() => {
      calls += 1;
      return { bavail: 250, bsize: 4096 };
    });
    expect(probe.freeBytes('somewhere', NOW)).toBe(1_024_000);
    expect(probe.freeBytes('somewhere', NOW + 29_999)).toBe(1_024_000);
    expect(calls).toBe(1);
    expect(probe.freeBytes('somewhere', NOW + 30_000)).toBe(1_024_000);
    expect(calls).toBe(2);
  });

  it('accepts bigint counters and answers null (and retries later) when the statistics are unavailable', () => {
    const big = createDiskProbe(() => ({ bavail: 10n, bsize: 512n }));
    expect(big.freeBytes('x', NOW)).toBe(5120);
    let fail = true;
    const flaky = createDiskProbe(() => {
      if (fail) throw new Error('no statfs');
      return { bavail: 1, bsize: 1 };
    });
    expect(flaky.freeBytes('x', NOW)).toBeNull();
    fail = false;
    expect(flaky.freeBytes('x', NOW + 1)).toBe(1);
  });
});

describe('zeroChildStats and eventLoopDelayP99Ms', () => {
  it('has every child kind with zero counters, in fresh objects', () => {
    const a = zeroChildStats();
    const b = zeroChildStats();
    expect(Object.keys(a)).toEqual([...CHILD_KINDS]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.node).not.toBe(b.node);
  });

  it('answers a finite number of milliseconds that is not negative', () => {
    const value = eventLoopDelayP99Ms(Date.now());
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  });
});
