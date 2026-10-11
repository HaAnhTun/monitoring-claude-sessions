// The pure part of the health and instance queries (03 6.2, registry C51): the projection of the stored `IngestHealth`
// (02 8.2) onto `HealthReport.ingestion`, the status rules of the report, the alert mapping, the free-disk probe and the
// "not evaluated yet" report. Nothing here touches the database: `query/index.ts` gathers the facts and calls these
// functions, so every rule is a table-driven unit test.
import { statfsSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import {
  IngestHealthSchema,
  isoMsZ,
  type AlertItem,
  type ChildKind,
  type ChildKindStats,
  type ErrorItem,
  type HealthReport,
  type IngestHealth,
  type PanelStats,
} from '@mcs/shared';

import type { AlertRow } from '../db/repos/alerts.ts';

/** The code of the one reason of a report that was never evaluated (no `ingest_health` row yet). */
export const INGEST_NOT_EVALUATED = 'NOT_EVALUATED';

const HOUR_MS = 3_600_000;
/** `freeDiskBytes` is read at most this often (03 6.2). */
const DISK_CACHE_MS = 30_000;
/** The event loop histogram starts over this often (03 6.2). */
const LOOP_RESET_MS = 60_000;
/** The transcript import errors that count as invalid lines (02 8.2). */
const INVALID_LINE_CODES: readonly string[] = ['invalid_json', 'not_object', 'shape_invalid'];
/** A code from a stored report is shown clipped. */
const CODE_MAX_CHARS = 64;

// ---- the stored report -----------------------------------------------------------------------------------------------

/** The stored `ingest_health.report_json`, or `null` when it is not a valid `IngestHealth` (a damaged row reads as absent). */
export function parseStoredIngestHealth(reportJson: string): IngestHealth | null {
  let value: unknown;
  try {
    value = JSON.parse(reportJson);
  } catch {
    return null;
  }
  const parsed = IngestHealthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface EmptyIngestHealthInput {
  readonly nowMs: number;
  /** When this process started (`runtime.startedAt`). */
  readonly startedAtMs: number;
  readonly headSeq: number;
  readonly eventLoopDelayP99Ms: number;
}

/**
 * What `GET /health/ingest` answers before the ingest service stored its first report (the first seconds after a start,
 * and a runtime without the service). It says so: status `degraded` with the one reason `NOT_EVALUATED`; every block
 * holds the empty values, which are not findings.
 */
export function emptyIngestHealth(i: EmptyIngestHealthInput): IngestHealth {
  return {
    evaluatedAt: i.nowMs,
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
    display: { headSeq: i.headSeq, serverTime: i.nowMs },
    runtime: { startedAt: i.startedAtMs, eventLoopDelayP99Ms: i.eventLoopDelayP99Ms },
    status: 'degraded',
    reasons: [{ code: INGEST_NOT_EVALUATED, severity: 'warn', since: i.startedAtMs }],
  };
}

// ---- projection onto HealthReport.ingestion ---------------------------------------------------------------------------

export interface ProjectionOptions {
  readonly nowMs: number;
  /** `instance.json` `hooks.enabled`. */
  readonly hooksEnabled: boolean;
  /** `health.backlogWarnMs`. */
  readonly backlogWarnMs: number;
}

type Ingestion = HealthReport['ingestion'];

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : isoMsZ(ms);
}

function ingestionStatus(report: IngestHealth, o: ProjectionOptions): Ingestion['status'] {
  if (report.status === 'down') return 'down';
  const { spool } = report.receiving;
  const spoolStalled =
    spool.bytesBehind > 0 &&
    spool.oldestPendingReceivedAt !== null &&
    o.nowMs - spool.oldestPendingReceivedAt > o.backlogWarnMs;
  if (report.persisted.status === 'backlog' || spoolStalled) return 'stalled';
  return report.status === 'ok' ? 'ok' : 'degraded';
}

/** The most recent handler error of the last hour as an `ErrorItem`, or `null`. */
function lastHandlerError(report: IngestHealth, nowMs: number): ErrorItem | null {
  let latest: IngestHealth['receiving']['hooks']['handlerErrors'][number] | null = null;
  for (const entry of report.receiving.hooks.handlerErrors) {
    if (nowMs - entry.lastAt > HOUR_MS) continue;
    if (latest === null || entry.lastAt > latest.lastAt) latest = entry;
  }
  if (latest === null) return null;
  const code = latest.code.slice(0, CODE_MAX_CHARS);
  return {
    at: isoMsZ(latest.lastAt),
    source: 'handler',
    code,
    where: null,
    message: `hook handler error ${code}`,
    sessionId: null,
  };
}

function notEvaluated(hooksEnabled: boolean): Ingestion {
  return {
    status: 'unknown',
    reasons: [INGEST_NOT_EVALUATED],
    hooks: {
      enabled: hooksEnabled,
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
  };
}

/**
 * `HealthReport.ingestion` from the last stored `IngestHealth` exactly as 02 8.2 defines it ("Projection to the UI"):
 * `down` stays `down`, a persisted backlog or a spool backlog older than `health.backlogWarnMs` is `stalled`, any other
 * non-ok report is `degraded`, `ok` is `ok`; `disabled` is never produced. With no report the status is `unknown`.
 * `hooks.lastEventAt` is the time of the last committed write (`persisted.lastCommitAt`): 02 8.2 names no closer field.
 */
export function projectIngestion(report: IngestHealth | null, o: ProjectionOptions): Ingestion {
  if (report === null) return notEvaluated(o.hooksEnabled);
  const { hooks, spool, transcripts } = report.receiving;
  const handlerErrorsLastHour = sum(
    hooks.handlerErrors.filter((entry) => o.nowMs - entry.lastAt <= HOUR_MS).map((entry) => entry.count),
  );
  return {
    status: ingestionStatus(report, o),
    reasons: report.reasons.map((reason) => reason.code),
    hooks: {
      enabled: o.hooksEnabled,
      installed: hooks.status !== 'not_installed',
      lastReceivedAt: iso(hooks.lastEnvelopeAt),
      lastEventAt: iso(report.persisted.lastCommitAt),
      spoolPendingBytes: spool.bytesBehind,
      spoolLagMs: spool.oldestPendingReceivedAt === null ? null : Math.max(0, o.nowMs - spool.oldestPendingReceivedAt),
      errorsLastHour: hooks.invalid1h + handlerErrorsLastHour,
      lastError: lastHandlerError(report, o.nowMs),
    },
    transcripts: {
      dirFound: transcripts.dirFound,
      filesTracked: transcripts.filesTracked,
      lastScanAt: iso(transcripts.lastScanAt),
      lastImportedAt: iso(transcripts.lastSyncAt),
      importLagMs: transcripts.maxLagMs,
      pendingBytes: transcripts.bytesBehind + transcripts.backfillRemainingBytes,
      invalidLines: sum(INVALID_LINE_CODES.map((code) => transcripts.errors[code] ?? 0)),
      errorsLastHour: sum(Object.values(transcripts.errors)),
      lastError: null,
    },
  };
}

// ---- the report ------------------------------------------------------------------------------------------------------

const zero = (): ChildKindStats => ({ spawned: 0, failed: 0, timedOut: 0, totalMs: 0 });

/**
 * Every child kind with zero counters, in the order of `CHILD_KINDS`; fresh objects on every call. The literal lists the
 * ten kinds, so a kind that is added to or removed from the shared list is a compile error here.
 */
export function zeroChildStats(): Record<ChildKind, ChildKindStats> {
  return {
    'powershell.processes': zero(),
    'powershell.cmdline': zero(),
    git: zero(),
    docker: zero(),
    ps: zero(),
    taskkill: zero(),
    node: zero(),
    python: zero(),
    icacls: zero(),
    opener: zero(),
  };
}

export interface HealthFacts {
  readonly nowMs: number;
  readonly instanceId: string;
  readonly asOfSeq: number;
  readonly epoch: string;
  readonly runtime: {
    readonly version: string;
    readonly codeStamp: string;
    readonly outdated: boolean;
    readonly pid: number;
    readonly startedAtMs: number;
  };
  readonly resources: {
    readonly eventLoopDelayP99Ms: number;
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly cpuUserMicros: number;
    readonly cpuSystemMicros: number;
  };
  readonly db: {
    readonly sizeBytes: number;
    readonly walBytes: number;
    readonly freeDiskBytes: number | null;
    readonly schemaVersion: number;
  };
  /** The last stored ingestion report, or `null` when there is none. */
  readonly report: IngestHealth | null;
  readonly hooksEnabled: boolean;
  readonly backlogWarnMs: number;
  /** `QueryDeps.childStats()`; absent for the DbReader (zeros). */
  readonly children: Record<ChildKind, ChildKindStats> | undefined;
  /** `QueryDeps.panelStats()`; absent for the DbReader (`{}`). */
  readonly panels: PanelStats | undefined;
  /** Open alerts, newest first, at most 20. */
  readonly alerts: readonly AlertItem[];
  readonly criticalAlertsOpen: boolean;
}

/** `db.ok`: the stored report names no failing or erroring write (03 6.2). */
function dbOk(report: IngestHealth | null): boolean {
  const status = report?.persisted.status;
  return status !== 'failing' && status !== 'db_error';
}

/**
 * `HealthReport` from gathered facts (03 6.2): `status` is `error` when the database is not ok or ingestion is down,
 * `degraded` when ingestion is not `ok` (also `unknown`) or a critical alert is open, else `ok`. The server error ring
 * is not known to the query layer: the route fills `errors` (`HealthReport.errors` is `[]` here). `sseClients` and the
 * search counters are zero until the stream hub and the search service report theirs.
 */
export function buildHealthReport(f: HealthFacts): HealthReport {
  const ingestion = projectIngestion(f.report, {
    nowMs: f.nowMs,
    hooksEnabled: f.hooksEnabled,
    backlogWarnMs: f.backlogWarnMs,
  });
  const ok = dbOk(f.report);
  let status: HealthReport['status'] = 'ok';
  if (!ok || ingestion.status === 'down') status = 'error';
  else if (ingestion.status !== 'ok' || f.criticalAlertsOpen) status = 'degraded';
  return {
    checkedAt: isoMsZ(f.nowMs),
    status,
    instanceId: f.instanceId,
    asOfSeq: f.asOfSeq,
    epoch: f.epoch,
    runtime: {
      version: f.runtime.version,
      codeStamp: f.runtime.codeStamp,
      outdated: f.runtime.outdated,
      pid: f.runtime.pid,
      startedAt: isoMsZ(f.runtime.startedAtMs),
      uptimeMs: Math.max(0, f.nowMs - f.runtime.startedAtMs),
      eventLoopDelayP99Ms: f.resources.eventLoopDelayP99Ms,
      rssBytes: f.resources.rssBytes,
      heapUsedBytes: f.resources.heapUsedBytes,
      cpuUserMicros: f.resources.cpuUserMicros,
      cpuSystemMicros: f.resources.cpuSystemMicros,
      sseClients: 0,
      search: { total: 0, byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 } },
    },
    db: {
      ok,
      sizeBytes: f.db.sizeBytes,
      walBytes: f.db.walBytes,
      freeDiskBytes: f.db.freeDiskBytes,
      schemaVersion: f.db.schemaVersion,
      lastError: f.report?.persisted.lastError?.code ?? null,
    },
    ingestion,
    children: f.children ?? zeroChildStats(),
    panels: f.panels ?? {},
    alerts: [...f.alerts],
    errors: [],
  };
}

// ---- alerts ----------------------------------------------------------------------------------------------------------

/** One stored alert as the API item; `sessionUid` is the provider session id of `row.sessionId` (`undefined` = none or deleted). */
export function toAlertItem(row: AlertRow, sessionUid: string | undefined): AlertItem {
  return {
    id: row.id,
    seq: row.updatedSeq,
    ruleId: row.ruleId,
    rule: row.ruleKind,
    severity: row.severity,
    status: row.status,
    title: row.title,
    scope: { kind: row.scopeKind, key: row.scopeKey },
    sessionId: row.sessionId === null ? null : (sessionUid ?? null),
    since: isoMsZ(row.firstFiredAt),
    lastFiredAt: isoMsZ(row.lastFiredAt),
    fireCount: row.fireCount,
    resolvedAt: iso(row.resolvedAt),
    resolvedReason: row.resolvedReason,
    detail: { ...row.detail },
  };
}

// ---- resources -------------------------------------------------------------------------------------------------------

export interface FsStatistics {
  readonly bavail: number | bigint;
  readonly bsize: number | bigint;
}

export interface DiskProbe {
  /** Free bytes for an unprivileged user (`bavail * bsize`) of the file system that holds `dir`; `null` when unknown. */
  freeBytes(dir: string, nowMs: number): number | null;
}

/** `fs.statfs` is read at most every 30 s (03 6.2); a failed read is not cached. `statfs` is injectable for tests. */
export function createDiskProbe(statfs: (dir: string) => FsStatistics = (dir) => statfsSync(dir)): DiskProbe {
  let cached: { at: number; dir: string; bytes: number } | null = null;
  return {
    freeBytes: (dir, nowMs) => {
      if (cached !== null && cached.dir === dir && nowMs >= cached.at && nowMs - cached.at < DISK_CACHE_MS) {
        return cached.bytes;
      }
      try {
        const stats = statfs(dir);
        const bytes = Number(stats.bavail) * Number(stats.bsize);
        if (!Number.isFinite(bytes) || bytes < 0) return null;
        cached = { at: nowMs, dir, bytes };
        return bytes;
      } catch {
        return null;
      }
    },
  };
}

let loopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let loopResetAt = 0;

/**
 * The 99th percentile of the event loop delay in milliseconds (03 6.2): one histogram per process (resolution 20 ms),
 * enabled by the first call and started over every 60 s. 0 until it has samples.
 */
export function eventLoopDelayP99Ms(nowMs: number): number {
  if (loopHistogram === null) {
    loopHistogram = monitorEventLoopDelay({ resolution: 20 });
    loopHistogram.enable();
    loopResetAt = nowMs;
  }
  const p99 = loopHistogram.percentile(99) / 1e6;
  if (nowMs - loopResetAt >= LOOP_RESET_MS) {
    loopHistogram.reset();
    loopResetAt = nowMs;
  }
  return Number.isFinite(p99) && p99 > 0 ? p99 : 0;
}
