// The one query layer of the engine (03 12.1, ADR 0029, registry 2.7): the server routes, the stream hub, the CLI DbReader and
// the runtime call `createQueries(db, deps)` and nothing else reads the database for them. Every function reads inside one
// synchronous step and carries `asOfSeq` (DA-I8); every function first checks that the caller's `RepoContext` is this
// instance (DA-I3).
//
// WP-17 seeds the layer with its meta part: `instanceInfo`, `health`, `ingestHealth`, `hookProbe` and the asynchronous
// `sessionAuditRefs` (03 6.3, I-19: it reads no table, only the audit files, and a failed read is `[]`). The pure rules
// (the projection of the stored ingestion report, the status of the report, the alert mapping) are in `health.ts`.
//
// How a later work package adds its part (plan section 4.2, one marked block each, at the top level of this file):
//   (inside its own marked block)
//   import { createSessionQueries, type SessionQueries } from './sessions.ts';
//   export interface EngineQueries extends SessionQueries {}      // declaration merging: the interface above grows
//   registerQueryPart(createSessionQueries, ['listSessions', 'getSession']);
// `createQueries` merges the objects that the registered parts return, then checks that every promised method exists, so
// a part that forgot one fails at the first `createQueries`, not at the first request. The seed interfaces of
// `runtime/context.ts` extend these ones (WP-17 block there), so `ctx.queries` has every member that a block adds.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  InstanceFileSchema,
  RUNTIME_VERSION,
  STREAM_HEARTBEAT_MS,
  isoMsZ,
  type AlertItem,
  type HealthReport,
  type HookProbeResult,
  type IngestHealth,
  type InstanceInfo,
} from '@mcs/shared';

import type { AuditRef } from '../audit/reader.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import { pragmaNumber } from '../db/driver.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import { AlertsRepo } from '../db/repos/alerts.ts';
import { HookProbesRepo } from '../db/repos/hook-probes.ts';
import { IngestHealthRepo } from '../db/repos/ingest-health.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { instanceCommands } from '../ops/commands.ts';
import type { AuditQueries, QueryDeps, TranscriptQueries } from '../runtime/context.ts';
import {
  buildHealthReport,
  createDiskProbe,
  emptyIngestHealth,
  eventLoopDelayP99Ms,
  parseStoredIngestHealth,
  toAlertItem,
} from './health.ts';

export type { AuditQueries, AuditReader, QueryDeps, TranscriptQueries } from '../runtime/context.ts';

/** The part of 03 12.1 `EngineQueries` that WP-17 owns (the meta part); `metaQueries` returns exactly these members. */
export interface MetaQueries {
  instanceInfo(ctx: RepoContext): InstanceInfo;
  health(ctx: RepoContext): HealthReport;
  ingestHealth(ctx: RepoContext): IngestHealth & { asOfSeq: number };
  /** Route `ingestProbe` (I-37): `null` = not committed yet, or never received. */
  hookProbe(ctx: RepoContext, probeSessionId: string): HookProbeResult | null;
}

/** The whole layer (03 12.1): the meta part here, the blocks of later work packages merge the rest into it (declaration merging). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the anchor of the declaration merging below: every block adds its members here
export interface EngineQueries extends MetaQueries {}

/** What `createQueries` returns (registry 2.7). */
export type Queries = EngineQueries & TranscriptQueries & AuditQueries;

// ---- the extension point ----------------------------------------------------------------------------------------------------

/** One work package's part of the layer: a factory over the database and the deps that returns its methods. */
export type QueryPart = (db: InstanceDb, deps: QueryDeps) => object;

interface PartRegistration {
  readonly part: QueryPart;
  readonly methods: readonly string[];
}

const registrations: PartRegistration[] = [];

/**
 * Adds a part to every layer that `createQueries` makes afterwards. `methods` are the names the part promises; the layer
 * refuses to be created without them. Returns the function that removes the part again (tests).
 */
export function registerQueryPart(part: QueryPart, methods: readonly string[]): () => void {
  const entry: PartRegistration = { part, methods };
  registrations.push(entry);
  return () => {
    const index = registrations.indexOf(entry);
    if (index >= 0) registrations.splice(index, 1);
  };
}

// ---- identity of the instance ------------------------------------------------------------------------------------------------

interface Identity {
  readonly slug: string;
  readonly description: string | null;
  readonly hooksEnabled: boolean;
  /** `<workspace>/` of the instance; `null` when the configuration was resolved without a workspace. */
  readonly workspaceDir: string | null;
  readonly launcherPath: string;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function descriptionOf(task: unknown): string | null {
  if (typeof task !== 'object' || task === null || !('description' in task)) return null;
  return typeof task.description === 'string' && task.description !== '' ? task.description : null;
}

/**
 * What `QueryDeps` does not carry (slug, task description, `hooks.enabled`, the launcher): read once, when the layer is
 * created, from the files next to the resolved configuration (`config.json` is in `<workspace>/`, the shared defaults in
 * `<skill>/config/`). A file that is missing or invalid reads as the default: no hooks, no description.
 */
function readIdentity(config: ResolvedConfig): Identity {
  const configFile = config.files.find((file) => file.name === 'config.json');
  const defaultsFile = config.files.find((file) => file.name === 'defaults.json');
  const workspaceDir = configFile === undefined ? null : path.dirname(configFile.path);
  const skillDir = defaultsFile === undefined ? null : path.dirname(path.dirname(defaultsFile.path));
  const launcherPath = path.join(skillDir ?? '.', 'scripts', 'mcs.mjs');
  if (workspaceDir === null) {
    return { slug: '', description: null, hooksEnabled: false, workspaceDir, launcherPath };
  }
  const instance = InstanceFileSchema.safeParse(readJson(path.join(workspaceDir, 'instance.json')));
  return {
    slug: instance.success ? instance.data.slug : path.basename(workspaceDir),
    description: descriptionOf(readJson(path.join(workspaceDir, 'task.json'))),
    hooksEnabled: instance.success && instance.data.hooks.enabled,
    workspaceDir,
    launcherPath,
  };
}

// ---- instance info -----------------------------------------------------------------------------------------------------------

function num(record: Readonly<Record<string, number>>, key: string, fallback: number): number {
  return record[key] ?? fallback;
}

function keptOrDays(days: number | null): string {
  return days === null
    ? 'kept (cleanup removes data only when you ask)'
    : `cleanup removes those older than ${String(days)} days`;
}

function retentionSummary(config: ResolvedConfig): string {
  const r = config.runtime.retention;
  return (
    `Change log ${String(r.changesMaxAgeHours)} h or ${String(r.changesMaxRows)} rows, ` +
    `${String(r.ingestErrorsMaxRows)} ingest errors, resolved alerts ${String(r.resolvedAlertsDays)} days, ` +
    `instance reconciliations ${String(r.instanceReconciliationsDays)} days. ` +
    `Sessions: ${keptOrDays(r.sessionsDays)}. Timeline rows: ${keptOrDays(r.eventsDays)}.`
  );
}

/** The constant `healthMs` of `InstanceInfo.poll`: the legacy configuration has no key for it (registry C26). */
const HEALTH_POLL_MS = 5000;

function instanceInfoOf(
  db: InstanceDb,
  deps: QueryDeps,
  identity: Identity,
  runtime: { readonly version: string; readonly codeStamp: string },
): InstanceInfo {
  const { monitor, runtime: config } = deps.config;
  const { ui, poll, panels, limits } = monitor;
  return {
    instanceId: db.instanceId,
    slug: identity.slug,
    title: monitor.title,
    description: identity.description,
    runtimeVersion: runtime.version,
    codeStamp: runtime.codeStamp,
    dbSchemaVersion: pragmaNumber(db.driver, 'user_version'),
    headSeq: db.headSeq(),
    epoch: db.epoch,
    staleAfterMs: num(poll, 'stale_after_ms', 15_000),
    heartbeatMs: STREAM_HEARTBEAT_MS,
    windowHours: monitor.window_hours,
    ui: {
      theme: ui.theme,
      density: ui.density,
      newestFirst: ui.newest_first,
      showTools: ui.show_tools,
      showThinking: ui.show_thinking,
      showPrompts: ui.show_prompts,
    },
    panels: {
      git: panels['git'] === true,
      machine: panels['machine'] === true,
      attempts: panels['attempts'] === true,
      ledger: panels['ledger'] === true,
      chainLog: panels['chain_log'] === true,
      logs: panels['logs'] === true,
    },
    poll: {
      healthMs: HEALTH_POLL_MS,
      sessionsMs: num(poll, 'sessions_ms', 6000),
      overviewMs: num(poll, 'overview_ms', 5000),
      transcriptMs: num(poll, 'events_ms', 1500),
      machineMs: num(poll, 'machine_ms', 2000),
      logsMs: num(poll, 'logs_ms', 3000),
      attemptsMs: num(poll, 'attempts_ms', 6000),
    },
    // the instance-wide content search (`GET /search/transcripts`) exists since WP-57: the Search page of the UI needs this value
    features: {
      transcriptSearch: 'instance',
      costEstimates: config.pricing.models.length > 0,
      usageTrend: config.analytics.usageTrend,
      hooks: identity.hooksEnabled,
    },
    retention: { summary: retentionSummary(deps.config) },
    commands: instanceCommands({
      launcherPath: identity.launcherPath,
      slug: identity.slug,
      repoDir: monitor.repo,
      instanceDir: identity.workspaceDir ?? '',
    }),
    limits: {
      pageMax: 200,
      eventsQueryWindowDays: 7,
      searchBudgetMsMax: 10_000,
      textChars: num(limits, 'text_chars', 6000),
    },
  };
}

// ---- the meta part -----------------------------------------------------------------------------------------------------------

/** The stamp of a runtime without `RuntimeProcessInfo` (the DbReader): the version is the build's, the stamp is not known. */
const UNKNOWN_STAMP = 'unknown';

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function metaQueries(db: InstanceDb, deps: QueryDeps): MetaQueries & AuditQueries {
  const ingestRepo = new IngestHealthRepo(db);
  const probeRepo = new HookProbesRepo(db);
  const alertRepo = new AlertsRepo(db);
  const sessionRepo = new SessionsRepo(db);
  const identity = readIdentity(deps.config);
  const disk = createDiskProbe();
  const createdAtMs = deps.now();
  const proc = deps.process;
  const startedAtMs = (): number => proc?.startedAtMs ?? createdAtMs;
  const version = proc?.runtimeVersion ?? RUNTIME_VERSION;
  const codeStamp = proc?.bootCodeStamp ?? UNKNOWN_STAMP;

  /** The stored ingestion report of this instance, or `null` when there is none or it is damaged. */
  function storedReport(ctx: RepoContext): IngestHealth | null {
    const row = ingestRepo.get(ctx);
    return row === undefined ? null : parseStoredIngestHealth(row.reportJson);
  }

  function openAlerts(ctx: RepoContext): AlertItem[] {
    const rows = alertRepo.list(ctx, { status: 'open', limit: 20 });
    const sessionRowIds = rows.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]));
    const uids = sessionRepo.uidsByRowIds(ctx, sessionRowIds);
    return rows.map((row) => toAlertItem(row, row.sessionId === null ? undefined : uids.get(row.sessionId)));
  }

  return {
    instanceInfo: (ctx) => {
      db.assertScope(ctx);
      return instanceInfoOf(db, deps, identity, { version, codeStamp });
    },

    health: (ctx) => {
      db.assertScope(ctx);
      const nowMs = deps.now();
      const asOfSeq = db.headSeq();
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      const dbFile = db.driver.path;
      return buildHealthReport({
        nowMs,
        instanceId: db.instanceId,
        asOfSeq,
        epoch: db.epoch,
        runtime: {
          version,
          codeStamp,
          outdated: proc?.outdated().outdated ?? false,
          pid: proc?.pid ?? process.pid,
          startedAtMs: startedAtMs(),
          previousRunUnclean: proc?.previousRunUnclean ?? false,
          ownershipConflict: proc?.ownershipConflict() ?? false,
        },
        resources: {
          eventLoopDelayP99Ms: eventLoopDelayP99Ms(nowMs),
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          cpuUserMicros: cpu.user,
          cpuSystemMicros: cpu.system,
        },
        db: {
          sizeBytes: fileSize(dbFile),
          walBytes: fileSize(`${dbFile}-wal`),
          freeDiskBytes: disk.freeBytes(path.dirname(dbFile), nowMs),
          schemaVersion: pragmaNumber(db.driver, 'user_version'),
        },
        report: storedReport(ctx),
        hooksEnabled: identity.hooksEnabled,
        backlogWarnMs: deps.config.runtime.health.backlogWarnMs,
        children: deps.childStats?.(),
        panels: deps.panelStats?.(),
        gauges: deps.healthGauges?.(),
        alerts: openAlerts(ctx),
        criticalAlertsOpen: alertRepo.countOpen(ctx).critical > 0,
      });
    },

    ingestHealth: (ctx) => {
      db.assertScope(ctx);
      const nowMs = deps.now();
      const asOfSeq = db.headSeq();
      const report =
        storedReport(ctx) ??
        emptyIngestHealth({
          nowMs,
          startedAtMs: startedAtMs(),
          headSeq: asOfSeq,
          eventLoopDelayP99Ms: eventLoopDelayP99Ms(nowMs),
        });
      return { ...report, asOfSeq };
    },

    hookProbe: (ctx, probeSessionId) => {
      const row = probeRepo.get(ctx, probeSessionId);
      return row === undefined ? null : { receivedAt: isoMsZ(row.receivedAt), committedAt: isoMsZ(row.committedAt) };
    },

    sessionAuditRefs: async (detail): Promise<AuditRef[]> => {
      const fromMs = Date.parse(detail.startedAt);
      const toMs = Date.parse(detail.endedAt ?? detail.lastActivityAt) + 1;
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];
      try {
        return await deps.audit.entriesBetween(fromMs, toMs, 10);
      } catch {
        return []; // an unreadable audit trail never fails the session detail (I-19)
      }
    },
  };
}

const CORE_METHODS = ['instanceInfo', 'health', 'ingestHealth', 'hookProbe', 'sessionAuditRefs'] as const;

/** True when every promised method is there (the check of `createQueries`): the layer then has the members of `Queries`. */
function isComplete(
  candidate: Record<string, unknown>,
  required: readonly string[],
): candidate is Record<string, unknown> & Queries {
  return required.every((name) => typeof candidate[name] === 'function');
}

/**
 * The query layer of one instance (03 12.1): the server passes all six deps, the CLI DbReader `config`, `now` and `audit`.
 * Throws when a registered part promised a method that its factory did not return.
 */
export function createQueries(db: InstanceDb, deps: QueryDeps): Queries {
  const merged: Record<string, unknown> = { ...metaQueries(db, deps) };
  for (const { part } of registrations) Object.assign(merged, part(db, deps));
  const required = [...CORE_METHODS, ...registrations.flatMap((entry) => entry.methods)];
  if (!isComplete(merged, required)) {
    const missing = required.filter((name) => typeof merged[name] !== 'function');
    throw new Error(`the query layer lacks ${missing.join(', ')}`);
  }
  return merged;
}

// The blocks of the work packages that add their part (see the header). They are empty until those packages land.
// @wp-begin WP-29
// Completion evidence (03 6.3, I-08): `explainCompletion` over a lookup of the repositories; it throws `CompletionTargetError`.
import { createCompletionQueries, type CompletionQueries } from './completion.ts';

export interface EngineQueries {
  explainCompletion: CompletionQueries['explainCompletion'];
}
registerQueryPart(createCompletionQueries, ['explainCompletion']);
// @wp-end WP-29

// @wp-begin WP-30
import { createAgentQueries, type AgentQueries } from './agents.ts';
import { createEventQueries, type EventQueries } from './events.ts';
import { createSessionQueries, type SessionQueries } from './sessions.ts';
import { createToolCallQueries, type ToolCallQueries } from './tool-calls.ts';
import { createTransitionQueries, type TransitionQueries } from './transitions.ts';

export { NotFoundError, QueryRefusal } from './transitions.ts';
export type { NotFoundCode, PathSessionOptions, RefusalCode } from './transitions.ts';

// the part of 03 12.1 that WP-30 owns: sessions, agents, events, tool calls and transitions
export interface EngineQueries extends SessionQueries, AgentQueries, EventQueries, ToolCallQueries, TransitionQueries {}
registerQueryPart(createSessionQueries, ['listSessions', 'getSession', 'sessionSummaries']);
registerQueryPart(createAgentQueries, ['sessionAgents', 'listAgents', 'agentNode', 'workflowRun']);
registerQueryPart(createEventQueries, ['listEvents', 'getEvent', 'eventsByIdRange']);
registerQueryPart(createToolCallQueries, ['listToolCalls', 'toolCallsByIds']);
registerQueryPart(createTransitionQueries, ['sessionTransitions']);
// @wp-end WP-30

// @wp-begin WP-31
import { createAlertQueries, type AlertQueries } from './alerts.ts';
import { createErrorQueries, type ErrorQueries } from './errors.ts';
import { createOverviewQueries, type OverviewQueries } from './overview.ts';
import { createWorkItemQueries, type WorkItemQueries } from './work-items.ts';

// the part of 03 12.1 that WP-31 owns: overview, work items, alerts and errors
export interface EngineQueries extends OverviewQueries, WorkItemQueries, AlertQueries, ErrorQueries {}
registerQueryPart(createOverviewQueries, ['overview']);
registerQueryPart(createWorkItemQueries, ['workItemBoard', 'getWorkItem']);
registerQueryPart(createAlertQueries, ['listAlerts', 'alertById', 'alertRules']);
registerQueryPart(createErrorQueries, ['errors']);
// @wp-end WP-31

// @wp-begin WP-33
// The transcript window and locate (03 7.3): `TranscriptQueries.window` and `locate`. The interface merges into `EngineQueries`
// above, so `ctx.queries` has both; the part reads transcript files on demand and keeps no text (ADR 0016).
import { createTranscriptQueryPart, type TranscriptWindowQueries } from '../transcript/window.ts';

export interface EngineQueries {
  window: TranscriptWindowQueries['window'];
  locate: TranscriptWindowQueries['locate'];
}
registerQueryPart(createTranscriptQueryPart, ['window', 'locate']);
// @wp-end WP-33

// @wp-begin WP-57
// Transcript content search (03 7.4): per session and per instance, bounded, with a coverage report; the counters go to the health report.
import { createSearchQueryPart, type SearchQueries } from '../search/service.ts';

export interface EngineQueries {
  searchSession: SearchQueries['searchSession'];
  searchInstance: SearchQueries['searchInstance'];
  searchStats: SearchQueries['searchStats'];
}
registerQueryPart(createSearchQueryPart, ['searchSession', 'searchInstance', 'searchStats']);
// @wp-end WP-57

// @wp-begin WP-58
import { createSeriesQueries, type SeriesQueries } from '../analytics/series.ts';
import { createToolFrequencyQueries, type ToolFrequencyQueries } from '../analytics/tools.ts';
import { createUsageQueries, type UsageQueries } from '../analytics/usage.ts';

// the part of 03 12.1 that WP-58 owns: token usage, the time series and the tool frequency
export interface EngineQueries extends UsageQueries, SeriesQueries, ToolFrequencyQueries {}
registerQueryPart(createUsageQueries, ['usage', 'sessionUsage']);
registerQueryPart(createSeriesQueries, ['series']);
registerQueryPart(createToolFrequencyQueries, ['tools']);
// @wp-end WP-58
