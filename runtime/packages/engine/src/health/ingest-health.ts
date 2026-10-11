// The four-way ingestion health (02 8.2, T-HE-03 to T-HE-06): "is the provider generating", "are we receiving", "did we persist"
// and "can the UI tell" are four independent blocks, and a connected stream is never evidence of any of them. The rules are a
// pure function of facts (`computeIngestHealth`); `createIngestHealthEvaluator` gathers the facts (the ingest service binds the
// figures only it knows through `bindHealthSources`), stores the report in the `ingest_health` row that the query layer serves,
// and announces `health/upsert` only when a status changed (03 11.4). Alert inputs are evaluated here, after the commit and
// outside the ingest path (02 8.3).
import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { IngestHealthSchema, type Clock, type IngestHealth } from '@mcs/shared';
import { z } from 'zod';

import { createChangeSink, INSTANCE_KEY } from '../db/change-sink.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import { IngestHealthRepo } from '../db/repos/ingest-health.ts';
import { withWriteTx } from '../db/write.ts';
import type { SpoolStats } from '../ingest/spool/spool-drainer.ts';
import { listSegments } from '../ingest/spool/segments.ts';
import type { TranscriptStats } from '../ingest/transcripts/importer.ts';
import type { Logger } from '../log/logger.ts';
import type { InstanceContext } from '../runtime/context.ts';
import { eventLoopDelayP99Ms, parseStoredIngestHealth } from '../query/health.ts';
import { createAlertInputTracker, emitAlertInputs, type AlertInputSnapshot } from './alert-inputs.ts';

const HOUR_MS = 3_600_000;
const TEN_MINUTES_MS = 600_000;
/** The queries that scan an hour of rows are repeated at most this often. */
const SLOW_QUERY_CACHE_MS = 30_000;
const HANDLER_LOG_TAIL_BYTES = 64 * 1024;
const HANDLER_LOG_MAX_CODES = 20;
const EVENT_LOOP_WARN_MS = 50;
/**
 * A report that is not complete: a fact query failed, or the whole refresh did. Not a code of the registry list of 02 8.2, like
 * HOOKS_NOT_INSTALLED and IMPORT_ERRORS (CR-WP-35-5): the health is never ok while a fact is unknown (UI-I4).
 */
export const INGEST_HEALTH_PARTIAL = 'INGEST_HEALTH_PARTIAL';
/** The handler log codes that make the hooks `failing` (02 8.2 rule 2). */
const FAILING_HANDLER_CODES: ReadonlySet<string> = new Set(['HANDLER_UNAVAILABLE', 'SPOOL_FULL', 'SPOOL_WRITE_FAILED']);
/** The errors of `persisted.lastError` that mean the database cannot take writes at all (02 8.2 rule 4). */
const DB_ERROR_CODES: ReadonlySet<string> = new Set([
  'db_full',
  'db_io',
  'db_corrupt',
  'ENOSPC',
  'SQLITE_FULL',
  'SQLITE_CORRUPT',
]);
const SPOOL_INVALID_CODES = [
  'SPOOL_LINE_INVALID_JSON',
  'ENVELOPE_SCHEMA',
  'ENVELOPE_VERSION',
  'INSTANCE_MISMATCH',
  'INVALID_SESSION_ID',
] as const;

// ---- the facts and the rules ------------------------------------------------------------------------------------------------

type Report = IngestHealth;
type HooksBlock = Report['receiving']['hooks'];
type TranscriptsBlock = Report['receiving']['transcripts'];
type PersistedBlock = Report['persisted'];

export interface HealthThresholds {
  readonly activeSeconds: number;
  readonly staleAfterSeconds: number;
  /** `health.importLagWarnMs` */
  readonly importLagWarnMs: number;
  /** `health.backlogWarnMs` */
  readonly backlogWarnMs: number;
}

/** Everything the rules need; no field is derived from a stream connection (02 8.2). */
export interface IngestHealthFacts {
  readonly now: number;
  readonly startedAt: number;
  readonly eventLoopDelayP99Ms: number;
  /** How many fact queries failed while the facts were gathered (a failed query reads as 0 and is reported, never hidden). */
  readonly queryFailures: number;
  readonly headSeq: number;
  /** `received_at` of the newest envelope ever stored. */
  readonly lastEnvelopeAt: number | null;
  /** Newest `mtime` of a tracked transcript file. */
  readonly newestTranscriptMtime: number | null;
  /** Newest `mtime` of a spool segment. */
  readonly newestSpoolMtime: number | null;
  readonly hooks: {
    readonly installed: HooksBlock['installed'];
    readonly envelopes1h: number;
    readonly duplicates1h: number;
    readonly invalid1h: number;
    readonly handlerErrors: HooksBlock['handlerErrors'];
    /** The handler log has HANDLER_UNAVAILABLE, SPOOL_FULL or SPOOL_WRITE_FAILED for this instance in the last hour. */
    readonly handlerFailing: boolean;
    readonly transcriptHookFailures: number;
    readonly coverage: HooksBlock['coverage'];
  };
  readonly spool: Report['receiving']['spool'];
  readonly transcripts: Omit<TranscriptsBlock, 'status'> & {
    /** Read errors and identity resets of the last 10 minutes. */
    readonly recentProblems: number;
  };
  readonly persisted: Omit<PersistedBlock, 'status'> & {
    /** The last commit failed: the last error is newer than the last successful commit. */
    readonly lastCommitFailed: boolean;
    /** Ingestion is paused after a full disk (the writer retries every 30 s). */
    readonly paused: boolean;
    /** Since when a queue or a spool backlog exists without a break; null when there is none. */
    readonly backlogSince: number | null;
  };
}

type Severity = Report['reasons'][number]['severity'];

function providerOf(f: IngestHealthFacts, t: HealthThresholds): Report['provider'] {
  const candidates: { at: number; source: 'hook' | 'transcript_mtime' }[] = [];
  if (f.lastEnvelopeAt !== null) candidates.push({ at: f.lastEnvelopeAt, source: 'hook' });
  if (f.newestTranscriptMtime !== null) candidates.push({ at: f.newestTranscriptMtime, source: 'transcript_mtime' });
  if (f.newestSpoolMtime !== null) candidates.push({ at: f.newestSpoolMtime, source: 'hook' });
  let best: { at: number; source: 'hook' | 'transcript_mtime' } | null = null;
  for (const candidate of candidates) if (best === null || candidate.at > best.at) best = candidate;
  if (best === null) return { lastActivityAt: null, source: null, status: 'none' };
  // a file time has a fraction of a millisecond; the report holds whole milliseconds
  const at = Math.floor(best.at);
  const age = f.now - at;
  const status = age < t.activeSeconds * 1000 ? 'active' : age < t.staleAfterSeconds * 1000 ? 'quiet' : 'silent';
  return { lastActivityAt: at, source: best.source, status };
}

function hooksStatusOf(f: IngestHealthFacts, t: HealthThresholds, provider: Report['provider']): HooksBlock['status'] {
  if (f.hooks.handlerFailing || f.hooks.transcriptHookFailures > 0) return 'failing';
  const known = f.hooks.installed.length > 0 || f.lastEnvelopeAt !== null;
  if (!known) return 'not_installed';
  if (f.hooks.coverage.partial > 0) return 'gap';
  const silentFor = f.lastEnvelopeAt === null ? Number.POSITIVE_INFINITY : f.now - f.lastEnvelopeAt;
  if (provider.status === 'active' && silentFor >= t.staleAfterSeconds * 1000) return 'idle';
  return 'ok';
}

function transcriptsStatusOf(f: IngestHealthFacts, t: HealthThresholds): TranscriptsBlock['status'] {
  const tr = f.transcripts;
  if (tr.dir === null || !tr.dirFound) return 'not_found';
  if (tr.recentProblems > 0) return 'errors';
  if (tr.maxLagMs > t.importLagWarnMs) return 'lagging';
  if (tr.backfillRemainingBytes > 0) return 'backfilling';
  return 'ok';
}

function persistedStatusOf(f: IngestHealthFacts, t: HealthThresholds): PersistedBlock['status'] {
  const p = f.persisted;
  if (p.paused) return 'db_error';
  if (p.lastCommitFailed) return p.lastError !== null && DB_ERROR_CODES.has(p.lastError.code) ? 'db_error' : 'failing';
  if (p.backlogSince !== null && f.now - p.backlogSince > t.backlogWarnMs) return 'backlog';
  return 'ok';
}

/** The nearest-rank 95th percentile; 0 for no samples. */
export function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

/**
 * The report of 02 8.2 from facts. `since` holds the start of the reasons that were already there (a reason that is new starts
 * at `now`). Pure: the same facts give the same report.
 */
export function computeIngestHealth(
  f: IngestHealthFacts,
  t: HealthThresholds,
  since: ReadonlyMap<string, number> = new Map(),
): Report {
  const provider = providerOf(f, t);
  const hooksStatus = hooksStatusOf(f, t, provider);
  const transcriptsStatus = transcriptsStatusOf(f, t);
  const persistedStatus = persistedStatusOf(f, t);

  const reasons: { code: string; severity: Severity }[] = [];
  if (hooksStatus === 'failing') reasons.push({ code: 'HOOKS_FAILING', severity: 'error' });
  if (hooksStatus === 'gap') reasons.push({ code: 'HOOK_GAP', severity: 'warn' });
  if (hooksStatus === 'not_installed') reasons.push({ code: 'HOOKS_NOT_INSTALLED', severity: 'info' });
  if (transcriptsStatus === 'lagging') reasons.push({ code: 'IMPORT_LAG', severity: 'warn' });
  if (transcriptsStatus === 'errors') reasons.push({ code: 'IMPORT_ERRORS', severity: 'warn' });
  if (transcriptsStatus === 'backfilling') reasons.push({ code: 'BACKFILLING', severity: 'info' });
  if (transcriptsStatus === 'not_found') reasons.push({ code: 'TRANSCRIPTS_NOT_FOUND', severity: 'warn' });
  if (persistedStatus === 'backlog') reasons.push({ code: 'SPOOL_BACKLOG', severity: 'warn' });
  if (persistedStatus === 'db_error' || persistedStatus === 'failing')
    reasons.push({ code: 'DB_ERROR', severity: 'error' });
  if (provider.status === 'silent') reasons.push({ code: 'PROVIDER_SILENT', severity: 'info' });
  if (f.eventLoopDelayP99Ms > EVENT_LOOP_WARN_MS) reasons.push({ code: 'EVENT_LOOP_SLOW', severity: 'warn' });
  if (f.queryFailures > 0) reasons.push({ code: INGEST_HEALTH_PARTIAL, severity: 'warn' });

  const down =
    persistedStatus === 'db_error' ||
    persistedStatus === 'failing' ||
    (transcriptsStatus === 'not_found' && hooksStatus === 'not_installed');
  const degraded = reasons.some((reason) => reason.severity !== 'info');
  return {
    evaluatedAt: f.now,
    provider,
    receiving: {
      hooks: {
        installed: f.hooks.installed,
        lastEnvelopeAt: f.lastEnvelopeAt,
        envelopes1h: f.hooks.envelopes1h,
        duplicates1h: f.hooks.duplicates1h,
        invalid1h: f.hooks.invalid1h,
        handlerErrors: f.hooks.handlerErrors,
        transcriptHookFailures: f.hooks.transcriptHookFailures,
        coverage: f.hooks.coverage,
        status: hooksStatus,
      },
      spool: f.spool,
      transcripts: {
        dir: f.transcripts.dir,
        dirFound: f.transcripts.dirFound,
        filesTracked: f.transcripts.filesTracked,
        filesMissing: f.transcripts.filesMissing,
        filesUnreadable: f.transcripts.filesUnreadable,
        bytesBehind: f.transcripts.bytesBehind,
        maxLagMs: f.transcripts.maxLagMs,
        backfillRemainingBytes: f.transcripts.backfillRemainingBytes,
        lastScanAt: f.transcripts.lastScanAt,
        lastSyncAt: f.transcripts.lastSyncAt,
        errors: f.transcripts.errors,
        status: transcriptsStatus,
      },
    },
    persisted: {
      lastCommitAt: f.persisted.lastCommitAt,
      queueItems: f.persisted.queueItems,
      queueBytes: f.persisted.queueBytes,
      commitP95Ms: f.persisted.commitP95Ms,
      failures1h: f.persisted.failures1h,
      lastError: f.persisted.lastError,
      status: persistedStatus,
    },
    display: { headSeq: f.headSeq, serverTime: f.now },
    runtime: { startedAt: f.startedAt, eventLoopDelayP99Ms: f.eventLoopDelayP99Ms },
    status: down ? 'down' : degraded ? 'degraded' : 'ok',
    reasons: reasons.map((reason) => ({ ...reason, since: since.get(reason.code) ?? f.now })),
  };
}

// ---- the handler log (02 2.11) ---------------------------------------------------------------------------------------------

const HandlerLogLineSchema = z.looseObject({
  at: z.number().int().nonnegative(),
  code: z.string().min(1).max(64),
  instanceId: z.string().nullable(),
});

/**
 * The failures of the hook handler in the last hour, from the tail of `hook-handler.jsonl`: the lines of this instance and the
 * lines without an instance (the handler could not know it). A line that is damaged, cut by the tail or of another shape is skipped.
 */
export function parseHandlerLog(
  text: string,
  instanceId: string,
  now: number,
): { errors: HooksBlock['handlerErrors']; failing: boolean } {
  const byCode = new Map<string, { code: string; count: number; lastAt: number }>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = HandlerLogLineSchema.safeParse(value);
    if (!parsed.success) continue;
    const entry = parsed.data;
    if (entry.instanceId !== null && entry.instanceId !== instanceId) continue;
    if (now - entry.at > HOUR_MS) continue;
    const known = byCode.get(entry.code);
    if (known === undefined) byCode.set(entry.code, { code: entry.code, count: 1, lastAt: entry.at });
    else {
      known.count += 1;
      known.lastAt = Math.max(known.lastAt, entry.at);
    }
  }
  const all = [...byCode.values()].sort((a, b) => b.lastAt - a.lastAt || (a.code < b.code ? -1 : 1));
  return { errors: all.slice(0, HANDLER_LOG_MAX_CODES), failing: all.some((e) => FAILING_HANDLER_CODES.has(e.code)) };
}

async function readTail(file: string, bytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return '';
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

// ---- sources and the evaluator ----------------------------------------------------------------------------------------------

export interface WriterFigures {
  readonly queued: number;
  readonly queuedBytes: number;
  readonly lastCommitAt: number | null;
  readonly failures: number;
  readonly lastError: { readonly code: string; readonly at: number } | null;
  readonly paused: boolean;
}

/** The figures that only the ingest service knows; it binds them to the context (`bindHealthSources`). */
export interface HealthSources {
  /** `<workspace>/data/spool` */
  readonly spoolDir: string;
  writer(): WriterFigures;
  /** Recent commit durations in milliseconds (the last few hundred). */
  commitDurationsMs(): readonly number[];
  spool(): SpoolStats;
  transcripts(): TranscriptStats;
  transcriptsDir(): string | null;
}

/** What the evaluator reads of the instance context. */
export interface HealthContext {
  readonly db: InstanceDb;
  readonly scope: RepoContext;
  readonly clock: Clock;
  readonly instanceId: string;
  readonly mcsHome: string;
  readonly process: { readonly startedAtMs: number };
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  readonly thresholds: HealthThresholds;
}

export interface IngestHealthEvaluator {
  /** Gathers the facts, computes the report, stores it and evaluates the alert inputs. Never rejects. */
  refresh(): Promise<IngestHealth>;
  /** The report of the last `refresh`, or null before the first. */
  last(): IngestHealth | null;
}

/** The thresholds of 02 7.8 and 8.2 from the resolved configuration; a derived key that no layer set reads as its default. */
export function thresholdsOf(config: InstanceContext['config']): HealthThresholds {
  const { lifecycle, health } = config.runtime;
  return {
    activeSeconds: lifecycle.activeSeconds ?? 120,
    staleAfterSeconds: lifecycle.staleAfterSeconds,
    importLagWarnMs: health.importLagWarnMs,
    backlogWarnMs: health.backlogWarnMs,
  };
}

export function healthContextOf(ctx: InstanceContext): HealthContext {
  return {
    db: ctx.db,
    scope: ctx.scope,
    clock: ctx.clock,
    instanceId: ctx.instanceId,
    mcsHome: ctx.mcsHome,
    process: { startedAtMs: ctx.process.startedAtMs },
    logger: ctx.logger,
    thresholds: thresholdsOf(ctx.config),
  };
}

const boundSources = new WeakMap<object, HealthSources>();
const evaluators = new WeakMap<object, IngestHealthEvaluator>();

/** The ingest service of a context hands its figures to the evaluator of that context. */
export function bindHealthSources(ctx: object, sources: HealthSources): void {
  boundSources.set(ctx, sources);
}

/** One evaluator per context, shared by the DB scheduler (every 5 s) and the ingest service (after a stop). */
export function ingestHealthEvaluatorOf(ctx: InstanceContext): IngestHealthEvaluator {
  let evaluator = evaluators.get(ctx);
  if (evaluator === undefined) {
    evaluator = createIngestHealthEvaluator(healthContextOf(ctx), () => boundSources.get(ctx) ?? null, ctx);
    evaluators.set(ctx, evaluator);
  }
  return evaluator;
}

/** A counter that only grows, seen at times: how much it grew within the last hour (0 for the first sighting). */
class WindowedCounter {
  private samples: { at: number; value: number }[] = [];

  record(now: number, value: number): number {
    this.samples.push({ at: now, value });
    // the newest sample older than the window stays as the baseline
    while (this.samples.length > 1 && (this.samples[1]?.at ?? Number.POSITIVE_INFINITY) <= now - HOUR_MS) {
      this.samples.shift();
    }
    const base = this.samples[0]?.value ?? value;
    return Math.max(0, value - base);
  }
}

interface Cached<T> {
  at: number;
  value: T;
}

/** The fact queries that failed in one pass of gathering. */
interface FailureTally {
  n: number;
}

/**
 * The report of a refresh that failed: the last one (or the empty one), degraded at least, with the reason that says the
 * facts are not current. Pure, so that a failed refresh never hands out an ok that nothing has just confirmed.
 */
function withPartialReason(report: IngestHealth, now: number, since: ReadonlyMap<string, number>): IngestHealth {
  const reasons = report.reasons.some((reason) => reason.code === INGEST_HEALTH_PARTIAL)
    ? report.reasons
    : [
        ...report.reasons,
        { code: INGEST_HEALTH_PARTIAL, severity: 'warn' as const, since: since.get(INGEST_HEALTH_PARTIAL) ?? now },
      ];
  return { ...report, evaluatedAt: now, status: report.status === 'down' ? 'down' : 'degraded', reasons };
}

function sumOf(record: Readonly<Record<string, number>>): number {
  return Object.values(record).reduce((a, b) => a + b, 0);
}

const CountersSchema = z.object({ duplicates: z.record(z.string(), z.number().int().nonnegative()).default({}) });

function duplicatesOf(countersJson: string | undefined): number {
  if (countersJson === undefined) return 0;
  try {
    const parsed = CountersSchema.safeParse(JSON.parse(countersJson));
    return parsed.success ? sumOf(parsed.data.duplicates) : 0;
  } catch {
    return 0;
  }
}

/** A key that changes exactly when a status of the report changed: a refresh with the same key announces nothing. */
function statusKey(report: IngestHealth | null): string | null {
  if (report === null) return null;
  const { receiving, persisted, provider } = report;
  return [
    report.status,
    provider.status,
    receiving.hooks.status,
    receiving.transcripts.status,
    persisted.status,
    report.reasons.map((reason) => reason.code).join(','),
  ].join('|');
}

export function createIngestHealthEvaluator(
  ctx: HealthContext,
  sources: HealthSources | (() => HealthSources | null),
  alertTarget: object = ctx,
): IngestHealthEvaluator {
  const { db, scope, clock } = ctx;
  const repo = new IngestHealthRepo(db);
  const tracker = createAlertInputTracker();
  const failures = new WindowedCounter();
  const duplicates = new WindowedCounter();
  let sinceByReason = new Map<string, number>();
  let backlogSince: number | null = null;
  let report: IngestHealth | null = null;
  let hourly: Cached<{
    envelopes: number;
    invalid: number;
    hookFailures: number;
    coverage: HooksBlock['coverage'];
    errors: Record<string, number>;
    failedQueries: number;
  }> | null = null;
  let handlerLog: Cached<ReturnType<typeof parseHandlerLog>> | null = null;
  let running: Promise<IngestHealth> | null = null;

  const resolve = (): HealthSources | null => (typeof sources === 'function' ? sources() : sources);

  /** A failed query reads as 0 for the rules and is counted in failed, so that the report says so (INGEST_HEALTH_PARTIAL). */
  function count(failed: FailureTally, sql: string, params: Record<string, number> = {}): number {
    try {
      return db.driver.prepare<{ n: number }>(sql).get(params)?.n ?? 0;
    } catch {
      failed.n += 1;
      return 0;
    }
  }

  function hourlyFacts(now: number): NonNullable<typeof hourly>['value'] {
    if (hourly !== null && now >= hourly.at && now - hourly.at < SLOW_QUERY_CACHE_MS) return hourly.value;
    const since = now - HOUR_MS;
    const failed: FailureTally = { n: 0 };
    const coverage = { full: 0, partial: 0, none: 0 };
    try {
      const rows = db.driver
        .prepare<{ coverage: string; n: number }>(
          'SELECT hook_coverage AS coverage, count(*) AS n FROM sessions WHERE last_activity_at >= :since GROUP BY hook_coverage',
        )
        .all({ since });
      for (const row of rows) {
        if (row.coverage === 'full' || row.coverage === 'partial' || row.coverage === 'none')
          coverage[row.coverage] = row.n;
      }
    } catch {
      failed.n += 1; // a closing database too: the counts stay zero and the report says it is partial
    }
    const errors: Record<string, number> = {};
    try {
      const rows = db.driver
        .prepare<{ name: string; n: number }>(
          `SELECT 'invalid_json' AS name, coalesce(sum(invalid_json), 0) AS n FROM transcript_files WHERE state <> 'retired'
           UNION ALL SELECT 'not_object', coalesce(sum(not_object), 0) FROM transcript_files WHERE state <> 'retired'
           UNION ALL SELECT 'shape_invalid', coalesce(sum(shape_invalid), 0) FROM transcript_files WHERE state <> 'retired'
           UNION ALL SELECT 'oversized', coalesce(sum(oversized), 0) FROM transcript_files WHERE state <> 'retired'
           UNION ALL SELECT 'utf8_invalid', coalesce(sum(utf8_invalid), 0) FROM transcript_files WHERE state <> 'retired'
           UNION ALL SELECT 'read_errors', coalesce(sum(read_errors), 0) FROM transcript_files WHERE state <> 'retired'`,
        )
        .all();
      for (const row of rows) if (row.n > 0) errors[row.name] = row.n;
    } catch {
      failed.n += 1;
    }
    const value = {
      envelopes: count(failed, 'SELECT count(*) AS n FROM events WHERE ts >= :since AND (sources & 1) = 1', { since }),
      invalid: count(
        failed,
        `SELECT count(*) AS n FROM ingest_errors WHERE at >= :since AND source = 'spool' AND code IN (${SPOOL_INVALID_CODES.map((c) => `'${c}'`).join(',')})`,
        { since },
      ),
      hookFailures: count(
        failed,
        "SELECT count(*) AS n FROM events WHERE kind = 'hook.handler_error' AND ts >= :since",
        {
          since,
        },
      ),
      coverage,
      errors,
      failedQueries: failed.n,
    };
    hourly = { at: now, value };
    return value;
  }

  async function handlerFacts(now: number): Promise<ReturnType<typeof parseHandlerLog>> {
    if (handlerLog !== null && now >= handlerLog.at && now - handlerLog.at < SLOW_QUERY_CACHE_MS)
      return handlerLog.value;
    const text = await readTail(path.join(ctx.mcsHome, 'logs', 'hook-handler.jsonl'), HANDLER_LOG_TAIL_BYTES);
    const value = parseHandlerLog(text, ctx.instanceId, now);
    handlerLog = { at: now, value };
    return value;
  }

  async function newestSpoolMtime(dir: string): Promise<number | null> {
    try {
      const listing = await listSegments(dir);
      let newest: number | null = null;
      for (const segment of listing.segments) if (newest === null || segment.mtimeMs > newest) newest = segment.mtimeMs;
      return newest;
    } catch {
      return null;
    }
  }

  async function gather(now: number, src: HealthSources | null): Promise<IngestHealthFacts> {
    const row = repo.get(scope);
    const writer: WriterFigures = src?.writer() ?? {
      queued: 0,
      queuedBytes: 0,
      lastCommitAt: row?.lastCommitAt ?? null,
      failures: 0,
      lastError: null,
      paused: false,
    };
    const spool: SpoolStats = src?.spool() ?? {
      segments: 0,
      bytes: 0,
      bytesBehind: 0,
      lastNudgeAt: null,
      lastDrainAt: null,
      foreignFiles: 0,
    };
    const transcripts = src?.transcripts();
    const dir = src?.transcriptsDir() ?? null;
    const failed: FailureTally = { n: 0 };
    const hourFacts = hourlyFacts(now);
    const handler = await handlerFacts(now);
    const lastCommitAt = writer.lastCommitAt ?? row?.lastCommitAt ?? null;
    const backlogging = writer.queued > 0 || spool.bytesBehind > 0;
    backlogSince = backlogging ? (backlogSince ?? now) : null;
    const newestMtime = count(failed, "SELECT max(mtime_seen) AS n FROM transcript_files WHERE state = 'active'");
    const oldestPending =
      spool.bytesBehind > 0
        ? count(
            failed,
            'SELECT min(oldest_received_at) AS n FROM spool_cursors WHERE sealed = 0 AND oldest_received_at IS NOT NULL',
          )
        : 0;
    const recentProblems =
      count(
        failed,
        "SELECT count(*) AS n FROM ingest_errors WHERE at >= :since AND code IN ('READ_FAILED', 'IDENTITY_RESET')",
        { since: now - TEN_MINUTES_MS },
      ) +
      count(failed, "SELECT count(*) AS n FROM reconciliations WHERE kind = 'identity_reset' AND at >= :since", {
        since: now - TEN_MINUTES_MS,
      });
    return {
      now,
      startedAt: ctx.process.startedAtMs,
      eventLoopDelayP99Ms: eventLoopDelayP99Ms(now),
      queryFailures: failed.n + hourFacts.failedQueries,
      headSeq: db.headSeq(),
      lastEnvelopeAt: row?.lastEnvelopeAt ?? null,
      newestTranscriptMtime: newestMtime > 0 ? newestMtime : null,
      newestSpoolMtime: src === null ? null : await newestSpoolMtime(src.spoolDir),
      hooks: {
        installed: [],
        envelopes1h: hourFacts.envelopes,
        duplicates1h: duplicates.record(now, duplicatesOf(row?.countersJson)),
        invalid1h: hourFacts.invalid,
        handlerErrors: handler.errors,
        handlerFailing: handler.failing,
        transcriptHookFailures: hourFacts.hookFailures,
        coverage: hourFacts.coverage,
      },
      spool: {
        segments: spool.segments,
        bytes: spool.bytes,
        bytesBehind: spool.bytesBehind,
        oldestPendingReceivedAt: oldestPending > 0 ? oldestPending : null,
        lastNudgeAt: spool.lastNudgeAt,
        lastDrainAt: spool.lastDrainAt,
        foreignFiles: spool.foreignFiles,
      },
      transcripts: {
        dir,
        dirFound: dir !== null && isDirectory(dir),
        filesTracked: transcripts?.filesTracked ?? 0,
        filesMissing: transcripts?.filesMissing ?? 0,
        filesUnreadable: transcripts?.filesUnreadable ?? 0,
        bytesBehind: transcripts?.bytesBehind ?? 0,
        maxLagMs: transcripts?.maxLagMs ?? 0,
        backfillRemainingBytes: transcripts?.backfillRemainingBytes ?? 0,
        lastScanAt: transcripts?.lastScanAt ?? null,
        lastSyncAt: transcripts?.lastSyncAt ?? null,
        errors: hourFacts.errors,
        recentProblems,
      },
      persisted: {
        lastCommitAt,
        queueItems: writer.queued,
        queueBytes: writer.queuedBytes,
        commitP95Ms: percentile95(src?.commitDurationsMs() ?? []),
        failures1h: failures.record(now, writer.failures),
        lastError: writer.lastError === null ? null : { code: writer.lastError.code, at: writer.lastError.at },
        lastCommitFailed: writer.lastError !== null && (lastCommitAt === null || writer.lastError.at > lastCommitAt),
        paused: writer.paused,
        backlogSince,
      },
    };
  }

  function persist(next: IngestHealth, spool: SpoolStats | null, transcripts: TranscriptStats | null): void {
    try {
      withWriteTx(db, scope, (tx) => {
        const current = repo.get(scope);
        const changed = statusKey(next) !== statusKey(parseStoredIngestHealth(current?.reportJson ?? ''));
        repo.save(scope, tx, {
          evaluatedAt: next.evaluatedAt,
          status: next.status,
          lastEnvelopeAt: current?.lastEnvelopeAt ?? null,
          lastCommitAt: current?.lastCommitAt ?? null,
          lastDrainAt: Math.max(current?.lastDrainAt ?? 0, spool?.lastDrainAt ?? 0) || null,
          lastNudgeAt: Math.max(current?.lastNudgeAt ?? 0, spool?.lastNudgeAt ?? 0) || null,
          lastScanAt: transcripts?.lastScanAt ?? current?.lastScanAt ?? null,
          lastSyncAt: transcripts?.lastSyncAt ?? current?.lastSyncAt ?? null,
          countersJson: current?.countersJson ?? '{}',
          reportJson: JSON.stringify(next),
        });
        if (changed) createChangeSink(tx).record('ingest_health', INSTANCE_KEY, 'update');
      });
    } catch (error) {
      ctx.logger.warn('ingest_health_write_failed', { code: error instanceof Error ? error.name : 'unknown' });
    }
  }

  function alertSnapshot(now: number, next: IngestHealth): AlertInputSnapshot {
    const since = now - HOUR_MS;
    let failedRows = 0;
    const rows = <T>(sql: string, params: Record<string, number>): T[] => {
      try {
        return db.driver.prepare<T>(sql).all(params);
      } catch {
        failedRows += 1;
        return [];
      }
    };
    const [downtime] = rows<{ detail: string }>(
      "SELECT detail FROM reconciliations WHERE kind = 'runtime_unavailable' AND at >= :since ORDER BY at DESC LIMIT 1",
      { since },
    );
    let downtimeDetail: AlertInputSnapshot['downtime'] = null;
    if (downtime !== undefined) {
      const parsed = z
        .object({ from: z.number(), to: z.number(), envelopes: z.number() })
        .safeParse(safeJson(downtime.detail));
      if (parsed.success) downtimeDetail = parsed.data;
    }
    const errorRows = rows<{ code: string; n: number }>(
      'SELECT code, count(*) AS n FROM ingest_errors WHERE at >= :since GROUP BY code',
      { since: now - TEN_MINUTES_MS },
    );
    const workingSessionUids = rows<{ uid: string }>(
      "SELECT session_uid AS uid FROM sessions WHERE state IN ('working','running','waiting_tool','waiting_agent') LIMIT 50",
      {},
    ).map((row) => row.uid);
    const gaps = rows<{ uid: string; tools: number; turns: number }>(
      "SELECT session_uid AS uid, hook_missing_tools AS tools, hook_missing_turns AS turns FROM sessions WHERE hook_coverage = 'partial' AND last_activity_at >= :since LIMIT 20",
      { since },
    ).map((row) => ({ sessionId: row.uid, missingTools: row.tools, missingTurns: row.turns }));
    // the report was stored before this runs: a lost query cannot change it, but the alert inputs are then incomplete
    if (failedRows > 0) ctx.logger.warn('alert_inputs_partial', { queries: failedRows });
    return {
      report: next,
      workingSessionUids,
      errorsByCode10min: Object.fromEntries(errorRows.map((row) => [row.code, row.n])),
      downtime: downtimeDetail,
      gaps,
      noActivityMs: ctx.thresholds.staleAfterSeconds * 1000,
    };
  }

  async function doRefresh(): Promise<IngestHealth> {
    const now = clock.now();
    const src = resolve();
    const facts = await gather(now, src);
    const next = computeIngestHealth(facts, ctx.thresholds, sinceByReason);
    sinceByReason = new Map(next.reasons.map((reason) => [reason.code, reason.since]));
    persist(next, src?.spool() ?? null, src?.transcripts() ?? null);
    report = next;
    try {
      emitAlertInputs(alertTarget, tracker.evaluate(alertSnapshot(now, next)));
    } catch (error) {
      ctx.logger.warn('alert_inputs_failed', { code: error instanceof Error ? error.name : 'unknown' });
    }
    return next;
  }

  function computeFallback(now: number): IngestHealth {
    return IngestHealthSchema.parse(
      computeIngestHealth(
        {
          now,
          startedAt: ctx.process.startedAtMs,
          eventLoopDelayP99Ms: 0,
          queryFailures: 0,
          headSeq: 0,
          lastEnvelopeAt: null,
          newestTranscriptMtime: null,
          newestSpoolMtime: null,
          hooks: {
            installed: [],
            envelopes1h: 0,
            duplicates1h: 0,
            invalid1h: 0,
            handlerErrors: [],
            handlerFailing: false,
            transcriptHookFailures: 0,
            coverage: { full: 0, partial: 0, none: 0 },
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
            recentProblems: 0,
          },
          persisted: {
            lastCommitAt: null,
            queueItems: 0,
            queueBytes: 0,
            commitP95Ms: 0,
            failures1h: 0,
            lastError: null,
            lastCommitFailed: false,
            paused: false,
            backlogSince: null,
          },
        },
        ctx.thresholds,
      ),
    );
  }

  return {
    refresh() {
      if (running !== null) return running;
      const current = doRefresh()
        .catch((error: unknown) => {
          ctx.logger.warn('ingest_health_refresh_failed', { code: error instanceof Error ? error.name : 'unknown' });
          // not the last report as it was (it may say ok): the facts of this pass are unknown, and the report says that
          const now = clock.now();
          const failed = withPartialReason(report ?? computeFallback(now), now, sinceByReason);
          sinceByReason = new Map(failed.reasons.map((reason) => [reason.code, reason.since]));
          persist(failed, null, null);
          report = failed;
          return failed;
        })
        .finally(() => {
          running = null;
        });
      running = current;
      return current;
    },
    last: () => report,
  };
}

/** The folder is there now: a transcripts folder that was removed after it was found is `not_found` again (T-HE-03 c). */
function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
