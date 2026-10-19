// `HealthReport`, `InstanceInfo`, `ErrorItem` and `HookProbeResult` (03 6.2, registry C51). `HealthReport` is the
// measurement surface of 06 8.2: runtime resources, child-process counters and panel counters.
import { z } from 'zod';

import { AlertItemSchema } from './entities.ts';
import { CountSchema, InstanceIdSchema, EpochSchema } from './ids.ts';
import { ChildKindSchema, ChildKindStatsSchema, PanelStatsSchema } from './panels.ts';
import { IsoTimeSchema, NullableIsoTimeSchema } from './time.ts';

/** One row of `GET /errors`, and the `lastError` of the health blocks. Server ring entries have `source 'server'`, `code 'INTERNAL'`. */
export const ErrorItemSchema = z.strictObject({
  at: IsoTimeSchema,
  source: z.string(),
  code: z.string(),
  where: z.string().nullable(),
  message: z.string(),
  sessionId: z.string().nullable(),
});
export type ErrorItem = z.infer<typeof ErrorItemSchema>;

/** Body of `GET /ingest/probes/:probeSessionId` (I-37). */
export const HookProbeResultSchema = z.strictObject({ receivedAt: IsoTimeSchema, committedAt: IsoTimeSchema });
export type HookProbeResult = z.infer<typeof HookProbeResultSchema>;

const nonNegative = z.number().min(0);

export const HealthReportSchema = z.strictObject({
  checkedAt: IsoTimeSchema,
  status: z.enum(['ok', 'degraded', 'error']),
  instanceId: InstanceIdSchema,
  asOfSeq: CountSchema,
  epoch: EpochSchema,
  runtime: z.strictObject({
    version: z.string(),
    codeStamp: z.string(),
    outdated: z.boolean(),
    pid: CountSchema,
    startedAt: IsoTimeSchema,
    uptimeMs: nonNegative,
    eventLoopDelayP99Ms: nonNegative,
    rssBytes: CountSchema,
    heapUsedBytes: CountSchema,
    /** Cumulative since process start; benchmarks take differences. */
    cpuUserMicros: CountSchema,
    cpuSystemMicros: CountSchema,
    sseClients: CountSchema,
    /** True when the previous run of this instance ended without a clean shutdown (01 4.13). */
    previousRunUnclean: z.boolean(),
    /** True while `state.json` names another live process (the state watchdog, 01 4.6). */
    ownershipConflict: z.boolean(),
    search: z.strictObject({
      total: CountSchema,
      byStoppedBy: z.strictObject({
        complete: CountSchema,
        match_limit: CountSchema,
        time_budget: CountSchema,
        cancelled: CountSchema,
      }),
    }),
  }),
  db: z.strictObject({
    ok: z.boolean(),
    sizeBytes: CountSchema,
    walBytes: CountSchema,
    freeDiskBytes: CountSchema.nullable(),
    schemaVersion: CountSchema,
    lastError: z.string().nullable(),
  }),
  /** The projection of the last `IngestHealth` of 02 8.2 (`disabled` is never produced). */
  ingestion: z.strictObject({
    status: z.enum(['ok', 'degraded', 'stalled', 'down', 'disabled', 'unknown']),
    reasons: z.array(z.string()),
    hooks: z.strictObject({
      enabled: z.boolean(),
      installed: z.boolean().nullable(),
      lastReceivedAt: NullableIsoTimeSchema,
      lastEventAt: NullableIsoTimeSchema,
      spoolPendingBytes: CountSchema,
      spoolLagMs: nonNegative.nullable(),
      errorsLastHour: CountSchema,
      lastError: ErrorItemSchema.nullable(),
    }),
    transcripts: z.strictObject({
      dirFound: z.boolean(),
      filesTracked: CountSchema,
      lastScanAt: NullableIsoTimeSchema,
      lastImportedAt: NullableIsoTimeSchema,
      importLagMs: nonNegative.nullable(),
      pendingBytes: CountSchema,
      invalidLines: CountSchema,
      errorsLastHour: CountSchema,
      lastError: ErrorItemSchema.nullable(),
    }),
  }),
  /** Every `ChildKind` is present, zeros when never spawned (06 3.6 `childStats()`). */
  children: z.record(ChildKindSchema, ChildKindStatsSchema),
  /** `PanelService.stats()`: only the sources that were read at least once. */
  panels: PanelStatsSchema,
  /** Open alerts, newest first, at most 20. */
  alerts: z.array(AlertItemSchema).max(20),
  /** The server error ring, newest first, at most 20. */
  errors: z.array(ErrorItemSchema).max(20),
});
export type HealthReport = z.infer<typeof HealthReportSchema>;

const PollSchema = z.strictObject({
  /** The constant 5000 (no legacy key). */
  healthMs: CountSchema,
  sessionsMs: CountSchema,
  /** Config `poll.overview_ms`; also the interval of the git, ledger and chain log panels (registry C26). */
  overviewMs: CountSchema,
  /** Config `poll.events_ms`. */
  transcriptMs: CountSchema,
  machineMs: CountSchema,
  logsMs: CountSchema,
  attemptsMs: CountSchema,
});

export const InstanceInfoSchema = z.strictObject({
  instanceId: InstanceIdSchema,
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  runtimeVersion: z.string(),
  codeStamp: z.string(),
  dbSchemaVersion: CountSchema,
  headSeq: CountSchema,
  epoch: EpochSchema,
  /** Config `poll.stale_after_ms`. */
  staleAfterMs: CountSchema,
  heartbeatMs: CountSchema,
  windowHours: nonNegative,
  ui: z.strictObject({
    theme: z.enum(['auto', 'light', 'dark']),
    density: z.enum(['comfortable', 'compact']),
    newestFirst: z.boolean(),
    showTools: z.boolean(),
    showThinking: z.boolean(),
    showPrompts: z.boolean(),
  }),
  /** Which panels the instance config enables, by `PanelKey`. */
  panels: z.strictObject({
    git: z.boolean(),
    machine: z.boolean(),
    attempts: z.boolean(),
    ledger: z.boolean(),
    chainLog: z.boolean(),
    logs: z.boolean(),
  }),
  poll: PollSchema,
  features: z.strictObject({
    transcriptSearch: z.enum(['session', 'instance']),
    costEstimates: z.boolean(),
    usageTrend: z.boolean(),
    hooks: z.boolean(),
  }),
  retention: z.strictObject({ summary: z.string() }),
  /** Copy-paste commands (01 6.6). */
  commands: z.strictObject({
    status: z.string(),
    restart: z.string(),
    inspect: z.string(),
    export: z.string(),
    backup: z.string(),
    cleanupDryRun: z.string(),
  }),
  limits: z.strictObject({
    pageMax: z.literal(200),
    eventsQueryWindowDays: z.literal(7),
    searchBudgetMsMax: z.literal(10000),
    textChars: CountSchema,
  }),
});
export type InstanceInfo = z.infer<typeof InstanceInfoSchema>;
