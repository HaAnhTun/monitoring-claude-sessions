// The ingest service (02 4.10, ADR 0012, 0015): the one object that makes an instance ingest on its own. It owns the single writer
// (02 4.6), the spool drainer (priority P0), the transcript importer with its scheduler (P1 to P3) and the two external pollers
// of 02 7.10 (registry, jobs), and it publishes the figures that the ingestion health needs (`bindHealthSources`).
//
// `start()` (in order): resolve the transcripts folder, write the route file, drain every unsealed spool segment once (this is
// where `runtime_unavailable` is recorded), then start the import scheduler and the pollers. `stop(deadlineMs)` stops them, gives
// the writer until the deadline to commit what is queued (what is not committed stays in the spool or is read again from the
// transcript, nothing is lost) and marks the route file stopped.
//
// Everything here runs on the main thread: no worker thread, one write transaction per writer tick. Timers are `setTimeout` chains
// that `stop` clears; the time they act on is `ctx.clock`.
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import { SID_RE } from '@mcs/shared/protocol';

import { onCommitted } from '../db/write.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import { nodeExternalFs, type ExternalFs, type ExternalPoll } from '../external/fs.ts';
import { createJobsReader } from '../external/jobs.ts';
import { createRegistryReader } from '../external/registry.ts';
import { bindHealthSources } from '../health/ingest-health.ts';
import { DEFAULT_LIFECYCLE_CFG, type LifecycleCfg } from '../lifecycle/facts.ts';
import { pidAlive as realPidAlive } from '../platform/process.ts';
import type { InstanceContext } from '../runtime/context.ts';
import { IngestWriterClosedError, ingestError } from './errors.ts';
import type { LogicalEvent } from './event-row.ts';
import { writeRouteFile, type RouteInstance } from './routes-file.ts';
import { createSpoolDrainer, type SpoolDrainer, type SpoolDrainerOptions } from './spool/spool-drainer.ts';
import { createImportScheduler, type ImporterPort } from './transcripts/scheduler.ts';
import type { SessionRule } from './transcripts/classify.ts';
import { detectTranscriptsDir } from './transcripts/discovery.ts';
import {
  DEFAULT_IMPORT_SETTINGS,
  createTranscriptImporter,
  type ImportSettings,
  type TranscriptImporter,
} from './transcripts/importer.ts';
import {
  createIngestWriter,
  type IngestItem,
  type IngestWriter,
  type IngestWriterHandle,
  type IngestWriterOptions,
} from './writer.ts';

export interface IngestStats {
  queued: number;
  queuedBytes: number;
  lastCommitAt: number | null;
  failures: number;
  spoolBytesBehind: number;
  transcriptBytesBehind: number;
  backfillRemainingBytes: number;
  filesTracked: number;
}

/** `untilIdle` ran out of time: `pending` is what was still left (02 4.10, registry C06). */
export class IngestIdleTimeoutError extends Error {
  readonly pending: IngestStats;

  constructor(pending: IngestStats) {
    super('ingestion did not become idle within the time given');
    this.name = 'IngestIdleTimeoutError';
    this.pending = pending;
  }
}

export interface IngestService {
  /** The one writer of the instance: the sweeper and the panel service submit through it. It cannot be closed from outside. */
  readonly writer: IngestWriter;
  start(): Promise<void>;
  /** `deadlineMs` is an absolute `clock.now()` value. */
  stop(deadlineMs: number): Promise<void>;
  /** Resolves when nothing is left to ingest; rejects with `IngestIdleTimeoutError` on time out and with `IngestWriterClosedError` after `stop`. */
  untilIdle(o: { timeoutMs: number }): Promise<void>;
  /** `POST /api/v3/ingest/nudge` (02 2.8): coalesced, never waits. */
  nudge(): void;
  /** Control op `ingest-replay` (02 2.7): resets the cursors from `fromSegment` (all when null) and reads again. */
  replay(fromSegment: string | null): Promise<{ segmentsReset: number }>;
  stats(): IngestStats;
}

/** Test seams: nothing here changes what the service does in production. */
export interface IngestServiceOptions {
  /** Merged over the options the service gives the writer (retry delays, transaction size, `beforeCommit`). */
  readonly writer?: Partial<IngestWriterOptions>;
  /** Merged over the options the service gives the spool drainer (slice size). */
  readonly drainer?: Partial<SpoolDrainerOptions>;
  /** Milliseconds between two looks of `untilIdle` (default 50). */
  readonly idlePollMs?: number;
  /** Called at every look of `untilIdle`, before it checks anything. */
  readonly onIdlePoll?: () => void;
  readonly externalFs?: ExternalFs;
  readonly pidAlive?: (pid: number) => boolean;
}

// ---- configuration ------------------------------------------------------------------------------------------------------

/** The thresholds of 02 7.8; a derived key that no layer set reads as its default. */
export function lifecycleCfgOf(config: ResolvedConfig): LifecycleCfg {
  return {
    activeSeconds: config.runtime.lifecycle.activeSeconds ?? DEFAULT_LIFECYCLE_CFG.activeSeconds,
    pendingToolGraceSeconds:
      config.runtime.lifecycle.pendingToolGraceSeconds ?? DEFAULT_LIFECYCLE_CFG.pendingToolGraceSeconds,
    subagentActiveSeconds: config.runtime.lifecycle.subagentActiveSeconds,
    staleAfterSeconds: config.runtime.lifecycle.staleAfterSeconds,
    abandonedAfterSeconds: config.runtime.lifecycle.abandonedAfterSeconds,
    processGoneGraceSeconds: config.runtime.lifecycle.processGoneGraceSeconds,
    crossSourceToleranceMs: config.runtime.lifecycle.crossSourceToleranceMs,
    reopenToleranceMs: config.runtime.lifecycle.reopenToleranceMs,
    sweepIntervalMs: config.runtime.lifecycle.sweepIntervalMs,
    pidCheckIntervalMs: config.runtime.lifecycle.pidCheckIntervalMs,
    registryPollMs: config.runtime.lifecycle.registryPollMs,
    jobsPollMs: config.runtime.lifecycle.jobsPollMs,
  };
}

/** The `import.*` keys that the importer reads (02 1.2); a derived key that no layer set reads as its default. */
export function importSettingsOf(config: ResolvedConfig): ImportSettings {
  return {
    lookbackHours: config.runtime.import.lookbackHours ?? DEFAULT_IMPORT_SETTINGS.lookbackHours,
    headMaxBytes: config.runtime.import.headMaxBytes,
    tailWindowBytes: config.runtime.import.tailWindowBytes ?? DEFAULT_IMPORT_SETTINGS.tailWindowBytes,
    backfillMaxBytes: config.runtime.import.backfillMaxBytes ?? DEFAULT_IMPORT_SETTINGS.backfillMaxBytes,
    untrackAfterHours: config.runtime.import.untrackAfterHours,
    sliceMs: config.runtime.import.sliceMs,
  };
}

/** The `session_rules` of the configuration for the classifier: `name` and `scope` are read loosely (the schema keeps unknown keys). */
export function sessionRulesOf(config: ResolvedConfig): SessionRule[] {
  return config.monitor.session_rules.map((rule) => {
    const name: unknown = rule['name'];
    const scope: unknown = rule['scope'];
    return {
      match: rule.match,
      ...(rule.label === undefined ? {} : { label: rule.label }),
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof scope === 'string' ? { scope } : {}),
    };
  });
}

// ---- the transcripts folder and the route file (02 2.6.2, 5.1.1) --------------------------------------------------------------

/** The folder of the transcripts: the configured one, or (`auto`, the shipped value, and null) the folder of the repository. */
async function resolveTranscriptsDir(ctx: InstanceContext): Promise<string | null> {
  const configured = ctx.config.monitor.transcripts_dir;
  if (configured !== null && configured !== '' && configured !== 'auto') return path.resolve(configured);
  return detectTranscriptsDir(ctx.config.monitor.repo, path.join(ctx.claudeHome, 'projects'));
}

function routeInstanceOf(ctx: InstanceContext, transcriptsDir: string | null): RouteInstance {
  return {
    instanceId: ctx.instanceId,
    instanceDir: ctx.instanceDir,
    mcsHome: ctx.mcsHome,
    repoDir: ctx.config.monitor.repo,
    hooksEnabled: ctx.hooksEnabled,
    sessionIds: ctx.config.monitor.session_ids.filter((id) => SID_RE.test(id)),
    transcriptsDir,
    projectsRoot: path.join(ctx.claudeHome, 'projects'),
  };
}

/**
 * Component 6 of the composition root (01 4.4a): the route file with `stoppedAt: null`, once everything started. The ingest
 * service wrote the same content at its own start; the write is idempotent.
 */
export async function publishRouteFile(ctx: InstanceContext): Promise<void> {
  const dir = await resolveTranscriptsDir(ctx);
  await writeRouteFile(routeInstanceOf(ctx, dir), { stoppedAt: null }, { now: ctx.clock.now() });
}

// ---- the service ----------------------------------------------------------------------------------------------------------

const IDLE_POLL_MS = 50;
const HOUR_MS = 3_600_000;
const ITEM_BYTES = 200;
const COMMIT_SAMPLES = 200;
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The time a stop that missed its deadline still gives the writer to finish the transaction it is in. */
const WRITER_CLOSE_GRACE_MS = 1000;
/** The time the components that started get to stop when a start fails (01 4.4a). */
const START_FAILURE_STOP_MS = 2000;

/** What a log line or the error ring may say about a failure: its code or its name, never its message (a path may be in it). */
function failureCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

/** The `external` item of one event. */
function externalItem(event: LogicalEvent): IngestItem {
  return { kind: 'external', events: [event], rows: [] };
}

interface Poller {
  start(): void;
  /** Clears the timer and waits for the poll that is running, until `until` (an absolute `clock.now()` value). */
  stop(until: number): Promise<void>;
}

export function createIngestService(ctx: InstanceContext, options: IngestServiceOptions = {}): IngestService {
  const { db, scope, clock, logger } = ctx;
  const spoolDir = path.join(ctx.instanceDir, 'data', 'spool');
  const idlePollMs = options.idlePollMs ?? IDLE_POLL_MS;
  const sessions = new SessionsRepo(db);

  // ---- the writer, with the commit duration of the health report measured around its transactions
  const commitDurations: number[] = [];
  let txStartedAt: number | null = null;
  const callerBeforeCommit = options.writer?.beforeCommit;
  const writer: IngestWriterHandle = createIngestWriter({
    db,
    scope,
    lifecycle: lifecycleCfgOf(ctx.config),
    logger,
    queueMaxItems: ctx.config.runtime.ingest.queueMaxItems,
    queueMaxBytes: ctx.config.runtime.ingest.queueMaxBytes,
    ...options.writer,
    beforeCommit: (tx, batches) => {
      txStartedAt = tx.now;
      callerBeforeCommit?.(tx, batches);
    },
  });
  let unsubscribeCommits: (() => void) | null = null;
  const noteCommit = (): void => {
    if (txStartedAt === null) return;
    commitDurations.push(Math.max(0, clock.now() - txStartedAt));
    if (commitDurations.length > COMMIT_SAMPLES) commitDurations.shift();
    txStartedAt = null;
  };

  const publicWriter: IngestWriter = {
    submit: (batch) => writer.submit(batch),
    onDrain: (cb) => {
      writer.onDrain(cb);
    },
    flushNow: () => writer.flushNow(),
    get stats() {
      return writer.stats;
    },
  };

  // ---- the producers
  const drainer: SpoolDrainer = createSpoolDrainer({
    db,
    scope,
    instanceId: ctx.instanceId,
    spoolDir,
    writer,
    clock,
    logger,
    pollMs: ctx.config.runtime.spool.pollMs,
    sealGraceMs: ctx.config.runtime.spool.sealGraceMs,
    retainHours: ctx.config.runtime.spool.retainHours,
    ...options.drainer,
  });
  const importer: TranscriptImporter = createTranscriptImporter({
    db,
    scope,
    writer,
    clock,
    transcriptsDir: null,
    settings: importSettingsOf(ctx.config),
    rules: sessionRulesOf(ctx.config),
    pinned: ctx.config.monitor.session_ids,
    logger,
  });

  // ---- the transcripts folder and the route file (02 2.6.2, 5.1.1)
  let transcriptsDir: string | null = null;

  async function writeRoute(state: { stoppedAt: number | null; spoolUntil?: number | null }): Promise<void> {
    try {
      await writeRouteFile(routeInstanceOf(ctx, transcriptsDir), state, { now: clock.now() });
    } catch (error) {
      logger.warn('route_file_failed', { code: failureCode(error) });
      ctx.errors.push({
        source: 'ingest',
        code: 'ROUTE_FILE_FAILED',
        where: 'ingest.route-file',
        message: `the route file could not be written (${failureCode(error)})`,
      });
    }
  }

  /** Looks for the folder again while it is not known; a folder that appears is announced to the hooks through the route file. */
  async function ensureTranscriptsDir(): Promise<void> {
    if (transcriptsDir !== null) return;
    const found = await resolveTranscriptsDir(ctx);
    if (found === null) return;
    transcriptsDir = found;
    importer.setTranscriptsDir(found);
    if (accepting) await writeRoute({ stoppedAt: null });
  }

  // ---- the import scheduler (P1 to P3)
  const importerPort: ImporterPort = {
    work: () => importer.work(),
    runSlice: (work, deadline) => importer.runSlice(work, deadline),
    statTick: () => importer.statTick(),
    discoverSession: (sessionId) => importer.discoverSession(sessionId),
    isIdle: () => importer.isIdle(),
    discover: async () => {
      await ensureTranscriptsDir();
      return importer.discover();
    },
  };
  const scheduler = createImportScheduler({
    importer: importerPort,
    sliceMs: ctx.config.runtime.import.sliceMs,
    scanIntervalMs: ctx.config.runtime.import.scanIntervalMs,
    discoveryIntervalMs: ctx.config.runtime.import.discoveryIntervalMs,
    backfillShare: ctx.config.runtime.import.backfillShare,
    logger,
  });

  // ---- the external pollers (02 7.10)
  const externalFs = options.externalFs ?? nodeExternalFs;
  const alive = options.pidAlive ?? realPidAlive;
  const isKnownSession = (uid: string): boolean => sessions.idByUid(scope, uid) !== undefined;
  const registry = createRegistryReader({
    claudeHome: ctx.claudeHome,
    now: () => clock.now(),
    isKnownSession,
    pidAlive: alive,
    fs: externalFs,
  });
  const jobs = createJobsReader({ claudeHome: ctx.claudeHome, now: () => clock.now(), isKnownSession, fs: externalFs });

  function poller(name: string, intervalMs: number, poll: () => Promise<ExternalPoll<LogicalEvent>>): Poller {
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running: Promise<void> | null = null;
    let reportedFailures = 0;

    async function once(): Promise<void> {
      try {
        const result = await poll();
        const items: IngestItem[] = result.events.map(externalItem);
        // a damaged file is reported once per change of the count, not at every poll
        if (result.readFailures !== reportedFailures) {
          if (result.readFailures > 0) {
            items.push({
              kind: 'external',
              events: [],
              rows: [
                {
                  t: 'error',
                  error: ingestError('EXTERNAL_READ_FAILED', 'external', {
                    detail: `${name}: ${String(result.readFailures)} file(s)`,
                  }),
                },
              ],
            });
          }
          reportedFailures = result.readFailures;
        }
        if (items.length === 0 || writer.submit({ source: 'external', items, bytes: items.length * ITEM_BYTES })) {
          result.commit();
        }
      } catch (error) {
        logger.warn('external_poll_failed', { phase: name, code: failureCode(error) });
      }
    }

    function arm(delayMs: number): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = null;
          const current = once().finally(() => {
            running = null;
            if (armed) arm(intervalMs);
          });
          running = current;
        },
        Math.min(delayMs, MAX_TIMER_MS),
      );
      timer.unref();
    }

    return {
      start() {
        if (armed) return;
        armed = true;
        arm(0);
      },
      async stop(until) {
        armed = false;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        const pending = running;
        if (pending === null) return;
        let guard: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<void>((resolve) => {
          guard = setTimeout(resolve, Math.min(Math.max(0, until - clock.now()), MAX_TIMER_MS));
        });
        try {
          await Promise.race([pending, expired]);
        } finally {
          if (guard !== undefined) clearTimeout(guard);
        }
      },
    };
  }

  const registryPoller = poller('registry', ctx.config.runtime.lifecycle.registryPollMs, () => registry.poll());
  const jobsPoller = poller('jobs', ctx.config.runtime.lifecycle.jobsPollMs, () => jobs.poll());

  // ---- the figures of the ingestion health (02 8.2)
  bindHealthSources(ctx, {
    spoolDir,
    writer: () => ({
      queued: writer.stats.queued,
      queuedBytes: writer.stats.queuedBytes,
      lastCommitAt: writer.stats.lastCommitAt,
      failures: writer.stats.failures,
      lastError: writer.stats.lastError,
      paused: writer.stats.paused,
    }),
    commitDurationsMs: () => commitDurations,
    spool: () => drainer.stats(),
    transcripts: () => importer.stats(),
    transcriptsDir: () => transcriptsDir,
  });

  // ---- the lifecycle of the service
  let accepting = false;
  let routeWritten = false;
  let started: Promise<void> | null = null;
  let stopped: Promise<void> | null = null;

  function stats(): IngestStats {
    const w = writer.stats;
    const t = importer.stats();
    return {
      queued: w.queued,
      queuedBytes: w.queuedBytes,
      lastCommitAt: w.lastCommitAt,
      failures: w.failures,
      spoolBytesBehind: drainer.stats().bytesBehind,
      transcriptBytesBehind: t.bytesBehind,
      backfillRemainingBytes: t.backfillRemainingBytes,
      filesTracked: t.filesTracked,
    };
  }

  async function doStart(): Promise<void> {
    try {
      unsubscribeCommits = onCommitted(db, noteCommit);
      accepting = true;
      transcriptsDir = await resolveTranscriptsDir(ctx);
      importer.setTranscriptsDir(transcriptsDir);
      await writeRoute({ stoppedAt: null });
      routeWritten = true;
      await drainer.start();
      scheduler.start();
      registryPoller.start();
      jobsPoller.start();
    } catch (error) {
      // a start that fails leaves nothing running (the composition root does not stop the component that failed)
      await teardown(clock.now() + START_FAILURE_STOP_MS).catch(() => undefined);
      throw error;
    }
  }

  function start(): Promise<void> {
    if (stopped !== null) {
      return Promise.reject(new McsError('INTERNAL', 'the ingest service was stopped; create a new one'));
    }
    started ??= doStart();
    return started;
  }

  /** `promise` or the end of the time until `until`, whichever comes first. */
  async function within(until: number, promise: Promise<unknown>): Promise<void> {
    let guard: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      guard = setTimeout(resolve, Math.min(Math.max(0, until - clock.now()), MAX_TIMER_MS));
    });
    try {
      await Promise.race([promise.then(() => undefined), expired]);
    } finally {
      if (guard !== undefined) clearTimeout(guard);
    }
  }

  /** Stops everything that runs; safe to call twice and for a service that never started. */
  async function teardown(deadlineMs: number): Promise<void> {
    accepting = false;
    // the pollers, the scheduler and the drainer finish the slice they are in, then nothing more is read
    await within(
      deadlineMs,
      Promise.all([scheduler.stop(), drainer.stop(), registryPoller.stop(deadlineMs), jobsPoller.stop(deadlineMs)]),
    );
    importer.close();
    // what the writer can commit before the deadline is committed; the rest stays in the spool or is read again
    await within(deadlineMs, writer.flushNow());
    await within(deadlineMs + WRITER_CLOSE_GRACE_MS, writer.close());
    unsubscribeCommits?.();
    unsubscribeCommits = null;
    if (!routeWritten) return;
    const now = clock.now();
    const hours = ctx.config.runtime.hooks.spoolWhileStoppedHours;
    await within(
      deadlineMs + WRITER_CLOSE_GRACE_MS,
      writeRoute({ stoppedAt: now, spoolUntil: hours > 0 ? now + hours * HOUR_MS : null }),
    );
  }

  async function doStop(deadlineMs: number): Promise<void> {
    accepting = false;
    if (started !== null) {
      await started.then(
        () => undefined,
        () => undefined,
      );
    }
    await teardown(deadlineMs);
  }

  function stop(deadlineMs: number): Promise<void> {
    if (!Number.isFinite(deadlineMs)) {
      return Promise.reject(new RangeError(`stop: deadlineMs must be a finite number, got ${String(deadlineMs)}`));
    }
    stopped ??= doStop(deadlineMs);
    return stopped;
  }

  // ---- untilIdle (02 4.10)
  const idleNow = (): boolean => drainer.isIdle() && importer.isIdle() && writer.stats.queued === 0;
  // a function, not a comparison in place: stop can be called while untilIdle waits
  const isStopped = (): boolean => stopped !== null;

  async function untilIdle(o: { timeoutMs: number }): Promise<void> {
    if (!Number.isFinite(o.timeoutMs) || o.timeoutMs < 0) {
      throw new RangeError(`untilIdle: timeoutMs must be a finite number of at least 0, got ${String(o.timeoutMs)}`);
    }
    // a stopped service has drained nothing since: idle would be a claim nothing confirms (the same error as replay)
    if (isStopped()) throw new IngestWriterClosedError();
    const deadline = clock.now() + o.timeoutMs;
    // a new transcript file is noticed here, not only at the next discovery cycle
    await importerPort.discover();
    for (;;) {
      if (isStopped()) throw new IngestWriterClosedError();
      options.onIdlePoll?.();
      // what the poll timers have not seen yet: new spool lines, growth of tracked files
      await drainer.drainNow();
      await importer.statTick();
      if (idleNow()) {
        await writer.flushNow();
        if (idleNow()) return;
      }
      const remaining = deadline - clock.now();
      if (remaining <= 0) throw new IngestIdleTimeoutError(stats());
      await sleep(Math.min(idlePollMs, remaining));
    }
  }

  return {
    writer: publicWriter,
    start,
    stop,
    untilIdle,
    nudge: () => {
      if (!accepting) return;
      drainer.nudge();
      scheduler.wake();
    },
    replay: (fromSegment) => {
      if (!accepting) return Promise.reject(new IngestWriterClosedError());
      return drainer.replay(fromSegment);
    },
    stats,
  };
}
