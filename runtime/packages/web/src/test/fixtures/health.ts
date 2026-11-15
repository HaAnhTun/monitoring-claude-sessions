// FIXTURE: invented data for tests
import { CHILD_KINDS, type ChildKind, type ChildKindStats, type HealthReport, type InstanceInfo } from '@mcs/shared';

import { FIXTURE_EPOCH, FIXTURE_INSTANCE_ID, iso } from './ids.ts';

/** The legacy poll defaults (04 5.2); the same numbers the data hooks fall back to. */
export const FIXTURE_POLL: InstanceInfo['poll'] = {
  healthMs: 5000,
  sessionsMs: 6000,
  overviewMs: 5000,
  transcriptMs: 1500,
  machineMs: 2000,
  logsMs: 3000,
  attemptsMs: 6000,
};

export function makeInstance(overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    instanceId: FIXTURE_INSTANCE_ID,
    slug: 'fixture',
    title: 'FIXTURE monitor',
    description: null,
    runtimeVersion: '3.0.0',
    codeStamp: 'fixture-stamp',
    dbSchemaVersion: 1,
    headSeq: 10,
    epoch: FIXTURE_EPOCH,
    kind: 'task',
    app: null,
    staleAfterMs: 30_000,
    heartbeatMs: 15_000,
    windowHours: 24,
    ui: {
      theme: 'auto',
      density: 'comfortable',
      newestFirst: false,
      showTools: true,
      showThinking: false,
      showPrompts: true,
    },
    panels: { git: true, machine: true, attempts: true, ledger: true, chainLog: true, logs: true },
    poll: FIXTURE_POLL,
    features: { transcriptSearch: 'session', costEstimates: false, usageTrend: true, hooks: false },
    retention: { summary: 'FIXTURE retention summary' },
    commands: {
      status: '$MCS status --task fixture',
      restart: '$MCS restart --task fixture',
      inspect: '$MCS inspect --task fixture',
      export: '$MCS export --task fixture',
      backup: '$MCS backup --task fixture',
      cleanupDryRun: '$MCS cleanup --task fixture --dry-run',
    },
    limits: { pageMax: 200, eventsQueryWindowDays: 7, searchBudgetMsMax: 10_000, textChars: 4000 },
    ...overrides,
  };
}

const ZERO_STATS: ChildKindStats = { spawned: 0, failed: 0, timedOut: 0, totalMs: 0 };

export function makeHealth(status: HealthReport['status'] = 'ok', overrides: Partial<HealthReport> = {}): HealthReport {
  const children = Object.fromEntries(
    CHILD_KINDS.map((kind): [ChildKind, ChildKindStats] => [kind, { ...ZERO_STATS }]),
  ) as HealthReport['children'];
  return {
    checkedAt: iso(0),
    status,
    instanceId: FIXTURE_INSTANCE_ID,
    asOfSeq: 10,
    epoch: FIXTURE_EPOCH,
    runtime: {
      version: '3.0.0',
      codeStamp: 'fixture-stamp',
      outdated: false,
      pid: 4242,
      startedAt: iso(-7200),
      uptimeMs: 7_200_000,
      eventLoopDelayP99Ms: 1,
      rssBytes: 100_000_000,
      heapUsedBytes: 50_000_000,
      cpuUserMicros: 1000,
      cpuSystemMicros: 500,
      sseClients: 0,
      previousRunUnclean: false,
      ownershipConflict: false,
      search: { total: 0, byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 } },
    },
    db: {
      ok: true,
      sizeBytes: 1_000_000,
      walBytes: 0,
      freeDiskBytes: 10_000_000_000,
      schemaVersion: 1,
      lastError: null,
    },
    ingestion: {
      status: status === 'ok' ? 'ok' : status === 'degraded' ? 'degraded' : 'down',
      reasons: status === 'ok' ? [] : ['FIXTURE reason'],
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
        dirFound: true,
        filesTracked: 1,
        lastScanAt: iso(-5),
        lastImportedAt: iso(-5),
        importLagMs: 0,
        pendingBytes: 0,
        invalidLines: 0,
        errorsLastHour: 0,
        lastError: null,
      },
    },
    children,
    panels: {},
    alerts: [],
    errors: [],
    ...overrides,
  };
}
