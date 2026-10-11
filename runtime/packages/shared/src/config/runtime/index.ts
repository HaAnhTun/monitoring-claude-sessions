// Composition of the `runtime.json` sections (01 section 1.6, registry 6.2). Every section module is written here from
// the owner's normative key table; `runtime-sections.contract.test.ts` fails on any difference with the registry.
import { z } from 'zod';

import { AlertsSectionKeys, AlertsSectionSchema } from './alerts.ts';
import { AnalyticsSectionKeys, AnalyticsSectionSchema } from './analytics.ts';
import { BackupSectionKeys, BackupSectionSchema } from './backup.ts';
import { BoardSectionKeys, BoardSectionSchema } from './board.ts';
import { HealthSectionKeys, HealthSectionSchema } from './health.ts';
import { HooksSectionKeys, HooksSectionSchema } from './hooks.ts';
import { ImportSectionKeys, ImportSectionSchema } from './import.ts';
import { IngestSectionKeys, IngestSectionSchema } from './ingest.ts';
import { LifecycleSectionKeys, LifecycleSectionSchema } from './lifecycle.ts';
import { LogLevelSchema } from './logging.ts';
import { PanelOptionsSectionKeys, PanelOptionsSectionSchema } from './panelOptions.ts';
import { PricingSectionKeys, PricingSectionSchema } from './pricing.ts';
import { ProcessSectionKeys, ProcessSectionSchema } from './process.ts';
import { RetentionSectionKeys, RetentionSectionSchema } from './retention.ts';
import { MIB, type KeySpec, sectionOverridesSchema } from './section.ts';
import { ServerSectionKeys, ServerSectionSchema } from './server.ts';
import { SpoolSectionKeys, SpoolSectionSchema } from './spool.ts';

export * from './alerts.ts';
export * from './analytics.ts';
export * from './backup.ts';
export * from './board.ts';
export * from './health.ts';
export * from './hooks.ts';
export * from './import.ts';
export * from './ingest.ts';
export * from './lifecycle.ts';
export * from './logging.ts';
export * from './panelOptions.ts';
export * from './pricing.ts';
export * from './process.ts';
export * from './retention.ts';
export { type KeySpec, type SectionKeys, sectionOverridesSchema, sectionSchema } from './section.ts';
export * from './server.ts';
export * from './spool.ts';

/** The merged configuration: every key present, every default filled. `schema_version` is the file marker. */
export const RuntimeFileSchema = z.strictObject({
  schema_version: z.literal(1),
  logLevel: LogLevelSchema.default('info'),
  server: ServerSectionSchema,
  process: ProcessSectionSchema,
  backup: BackupSectionSchema,
  lifecycle: LifecycleSectionSchema,
  hooks: HooksSectionSchema,
  ingest: IngestSectionSchema,
  import: ImportSectionSchema,
  spool: SpoolSectionSchema,
  health: HealthSectionSchema,
  analytics: AnalyticsSectionSchema,
  board: BoardSectionSchema,
  panelOptions: PanelOptionsSectionSchema,
  retention: RetentionSectionSchema,
  alerts: AlertsSectionSchema,
  pricing: PricingSectionSchema,
});

/** The file on disk: partial sections only, unknown keys rejected, no defaults injected. */
export const RuntimeOverridesSchema = z.strictObject({
  schema_version: z.literal(1),
  logLevel: LogLevelSchema.optional(),
  server: sectionOverridesSchema(ServerSectionKeys),
  process: sectionOverridesSchema(ProcessSectionKeys),
  backup: sectionOverridesSchema(BackupSectionKeys),
  lifecycle: sectionOverridesSchema(LifecycleSectionKeys),
  hooks: sectionOverridesSchema(HooksSectionKeys),
  ingest: sectionOverridesSchema(IngestSectionKeys),
  import: sectionOverridesSchema(ImportSectionKeys),
  spool: sectionOverridesSchema(SpoolSectionKeys),
  health: sectionOverridesSchema(HealthSectionKeys),
  analytics: sectionOverridesSchema(AnalyticsSectionKeys),
  board: sectionOverridesSchema(BoardSectionKeys),
  panelOptions: sectionOverridesSchema(PanelOptionsSectionKeys),
  retention: sectionOverridesSchema(RetentionSectionKeys),
  alerts: sectionOverridesSchema(AlertsSectionKeys),
  pricing: sectionOverridesSchema(PricingSectionKeys),
});

export type RuntimeConfig = Omit<z.output<typeof RuntimeFileSchema>, 'schema_version'>;
export type RuntimeOverrides = z.output<typeof RuntimeOverridesSchema>;

export const R_TOP_KEYS = [
  'logLevel',
  'server',
  'process',
  'backup',
  'lifecycle',
  'hooks',
  'ingest',
  'import',
  'spool',
  'health',
  'analytics',
  'board',
  'panelOptions',
  'retention',
  'alerts',
  'pricing',
] as const;

/** Every object section merges per sub-key (01 2.2); only `logLevel` is a plain scalar. */
export const R_MERGED: ReadonlySet<string> = new Set(R_TOP_KEYS.filter((k) => k !== 'logLevel'));

// ---- derived defaults (01 1.6): the mechanism lives in `resolveConfig` step 6 (WP-12); the data is here.

export type DerivedMap = 'identity' | 'mib-to-bytes';

export interface DerivedDefault {
  /** Dotted path of the legacy (L) key the default comes from. */
  readonly from: string;
  readonly map: DerivedMap;
}

export const R_DERIVED_DEFAULTS: Readonly<Record<string, DerivedDefault>> = {
  'lifecycle.activeSeconds': { from: 'active_seconds', map: 'identity' },
  'lifecycle.pendingToolGraceSeconds': { from: 'pending_tool_grace_seconds', map: 'identity' },
  'import.lookbackHours': { from: 'window_hours', map: 'identity' },
  'import.tailWindowBytes': { from: 'limits.event_window_mb', map: 'mib-to-bytes' },
  'import.backfillMaxBytes': { from: 'limits.usage_max_mb', map: 'mib-to-bytes' },
};

/** Applies the map of a derived default: `identity`, or `Math.floor(v * 1048576)` for megabytes to bytes. */
export function applyDerivedMap(map: DerivedMap, value: number): number {
  return map === 'identity' ? value : Math.floor(value * MIB);
}

// ---- the catalogue

export interface RKeyCatalogueEntry {
  /** Dotted path; `alerts.rules.<ruleId>` is one entry per rule (an object value). */
  readonly key: string;
  /** Effective default: for a derived key, the value derived from the shipped `config/defaults.json`. */
  readonly default: unknown;
  /** A valid value that differs from the default, accepted by `RuntimeOverridesSchema`. */
  readonly sample: unknown;
  /** Design that owns the semantics (the owner's table is normative). */
  readonly owner: '01' | '02' | '03' | '06';
  /** The owner's normative section, e.g. `02 7.8`. */
  readonly ref: string;
}

type Owner = RKeyCatalogueEntry['owner'];

function entry(
  key: string,
  spec: Pick<KeySpec, 'default'>,
  sample: unknown,
  owner: Owner,
  ref: string,
): RKeyCatalogueEntry {
  const derived = R_DERIVED_DEFAULTS[key];
  // Defaults shipped in config/defaults.json: window_hours 8, active_seconds 120, pending_tool_grace_seconds 900,
  // limits.event_window_mb 8, limits.usage_max_mb 512 (checked against the file by derived-defaults.test.ts).
  const effective = derived === undefined ? structuredClone(spec.default) : DERIVED_EFFECTIVE[key];
  return { key, default: effective, sample, owner, ref };
}

const DERIVED_EFFECTIVE: Readonly<Record<string, number>> = {
  'lifecycle.activeSeconds': 120,
  'lifecycle.pendingToolGraceSeconds': 900,
  'import.lookbackHours': 8,
  'import.tailWindowBytes': 8 * MIB,
  'import.backfillMaxBytes': 512 * MIB,
};

const boardSample = {
  key: 'release',
  title: 'Release',
  match: { labels: ['release'], labelPrefix: 'rel-', sessionIds: ['session-1'], attemptParts: ['part-1'] },
};

const priceSample = {
  match: 'claude-*',
  effectiveFrom: '2026-01-01',
  inputPerMTok: 1,
  outputPerMTok: 5,
  cacheReadPerMTok: 0.1,
  cacheWrite5mPerMTok: 1.25,
  cacheWrite1hPerMTok: 2,
};

const rules = AlertsSectionKeys.rules.default;

export const R_KEY_CATALOGUE: readonly RKeyCatalogueEntry[] = [
  entry('logLevel', { default: 'info' }, 'debug', '01', '01 1.6'),
  // server (01)
  entry('server.port', ServerSectionKeys.port, 8800, '01', '01 4.11'),
  entry('server.portScan', ServerSectionKeys.portScan, 5, '01', '01 4.11'),
  entry('server.requestTimeoutMs', ServerSectionKeys.requestTimeoutMs, 60_000, '01', '01 1.6'),
  entry('server.shutdownGraceMs', ServerSectionKeys.shutdownGraceMs, 10_000, '01', '01 4.5'),
  // process (01)
  entry('process.startTimeoutMs', ProcessSectionKeys.startTimeoutMs, 30_000, '01', '01 4.7'),
  entry('process.stopTimeoutMs', ProcessSectionKeys.stopTimeoutMs, 20_000, '01', '01 4.9'),
  entry('process.stateWatchdogMs', ProcessSectionKeys.stateWatchdogMs, 30_000, '01', '01 4.6'),
  // backup (01)
  entry('backup.keep', BackupSectionKeys.keep, 10, '01', '01 5.5'),
  // lifecycle (02 7.8; the bounds are 01's)
  entry('lifecycle.activeSeconds', LifecycleSectionKeys.activeSeconds, 90, '02', '02 7.8'),
  entry('lifecycle.pendingToolGraceSeconds', LifecycleSectionKeys.pendingToolGraceSeconds, 600, '02', '02 7.8'),
  entry('lifecycle.subagentActiveSeconds', LifecycleSectionKeys.subagentActiveSeconds, 30, '02', '02 7.8'),
  entry('lifecycle.staleAfterSeconds', LifecycleSectionKeys.staleAfterSeconds, 900, '02', '02 7.8'),
  entry('lifecycle.abandonedAfterSeconds', LifecycleSectionKeys.abandonedAfterSeconds, 43_200, '02', '02 7.8'),
  entry('lifecycle.processGoneGraceSeconds', LifecycleSectionKeys.processGoneGraceSeconds, 10, '02', '02 7.8'),
  entry('lifecycle.crossSourceToleranceMs', LifecycleSectionKeys.crossSourceToleranceMs, 1000, '02', '02 7.8'),
  entry('lifecycle.reopenToleranceMs', LifecycleSectionKeys.reopenToleranceMs, 1500, '02', '02 7.8'),
  entry('lifecycle.sweepIntervalMs', LifecycleSectionKeys.sweepIntervalMs, 2000, '02', '02 7.8'),
  entry('lifecycle.pidCheckIntervalMs', LifecycleSectionKeys.pidCheckIntervalMs, 5000, '02', '02 7.8'),
  entry('lifecycle.registryPollMs', LifecycleSectionKeys.registryPollMs, 3000, '02', '02 7.8'),
  entry('lifecycle.jobsPollMs', LifecycleSectionKeys.jobsPollMs, 10_000, '02', '02 7.8'),
  // hooks, ingest, import, spool, health (02 1.2)
  entry('hooks.spoolWhileStoppedHours', HooksSectionKeys.spoolWhileStoppedHours, 0, '02', '02 2.6.2'),
  entry('ingest.queueMaxItems', IngestSectionKeys.queueMaxItems, 1000, '02', '02 4.7'),
  entry('ingest.queueMaxBytes', IngestSectionKeys.queueMaxBytes, 16 * MIB, '02', '02 4.7'),
  entry('import.lookbackHours', ImportSectionKeys.lookbackHours, 12, '02', '02 5.1.2'),
  entry('import.tailWindowBytes', ImportSectionKeys.tailWindowBytes, 4 * MIB, '02', '02 5.5'),
  entry('import.backfillMaxBytes', ImportSectionKeys.backfillMaxBytes, 256 * MIB, '02', '02 5.5'),
  entry('import.headMaxBytes', ImportSectionKeys.headMaxBytes, 8 * MIB, '02', '02 5.2'),
  entry('import.untrackAfterHours', ImportSectionKeys.untrackAfterHours, 24, '02', '02 5.1.2'),
  entry('import.discoveryIntervalMs', ImportSectionKeys.discoveryIntervalMs, 2000, '02', '02 5.1.2'),
  entry('import.scanIntervalMs', ImportSectionKeys.scanIntervalMs, 500, '02', '02 5.4'),
  entry('import.sliceMs', ImportSectionKeys.sliceMs, 10, '02', '02 5.4'),
  entry('import.backfillShare', ImportSectionKeys.backfillShare, 0.5, '02', '02 5.4'),
  entry('spool.pollMs', SpoolSectionKeys.pollMs, 250, '02', '02 2.7'),
  entry('spool.sealGraceMs', SpoolSectionKeys.sealGraceMs, 60_000, '02', '02 2.7'),
  entry('spool.retainHours', SpoolSectionKeys.retainHours, 48, '02', '02 2.7'),
  entry('health.importLagWarnMs', HealthSectionKeys.importLagWarnMs, 60_000, '02', '02 8.2'),
  entry('health.backlogWarnMs', HealthSectionKeys.backlogWarnMs, 20_000, '02', '02 8.2'),
  // analytics (03 6.2)
  entry('analytics.usageTrend', AnalyticsSectionKeys.usageTrend, true, '03', '03 6.2'),
  // board (02 7.11)
  entry('board.items', BoardSectionKeys.items, [boardSample], '02', '02 7.11'),
  // panelOptions (06 3.5)
  entry('panelOptions.attemptsWindowHours', PanelOptionsSectionKeys.attemptsWindowHours, 48, '06', '06 3.5'),
  entry(
    'panelOptions.machineProcessIntervalMs',
    PanelOptionsSectionKeys.machineProcessIntervalMs,
    30_000,
    '06',
    '06 3.5',
  ),
  // retention (03 3.8)
  entry('retention.changesMaxAgeHours', RetentionSectionKeys.changesMaxAgeHours, 48, '03', '03 3.8'),
  entry('retention.changesMaxRows', RetentionSectionKeys.changesMaxRows, 50_000, '03', '03 3.8'),
  entry('retention.ingestErrorsMaxRows', RetentionSectionKeys.ingestErrorsMaxRows, 500, '03', '03 3.8'),
  entry('retention.resolvedAlertsDays', RetentionSectionKeys.resolvedAlertsDays, 7, '03', '03 3.8'),
  entry('retention.instanceReconciliationsDays', RetentionSectionKeys.instanceReconciliationsDays, 30, '03', '03 3.8'),
  entry('retention.sessionsDays', RetentionSectionKeys.sessionsDays, 30, '03', '03 3.8'),
  entry('retention.eventsDays', RetentionSectionKeys.eventsDays, 14, '03', '03 3.8'),
  // alerts (03 10.1)
  entry('alerts.enabled', AlertsSectionKeys.enabled, false, '03', '03 10.1'),
  entry('alerts.sweepSeconds', AlertsSectionKeys.sweepSeconds, 30, '03', '03 10.1'),
  entry(
    'alerts.rules.inactivity',
    { default: rules.inactivity },
    { enabled: false, minutes: 5, cooldownMinutes: 1 },
    '03',
    '03 10.1',
  ),
  entry(
    'alerts.rules.ingest_errors',
    { default: rules.ingest_errors },
    { count: 5, windowMinutes: 5 },
    '03',
    '03 10.1',
  ),
  entry(
    'alerts.rules.runtime_unavailable',
    { default: rules.runtime_unavailable },
    { expireHours: 48 },
    '03',
    '03 10.1',
  ),
  entry(
    'alerts.rules.token_threshold',
    { default: rules.token_threshold },
    { enabled: true, tokens: 1_000_000, field: 'output' },
    '03',
    '03 10.1',
  ),
  entry('alerts.rules.import_lag', { default: rules.import_lag }, { cooldownMinutes: 5 }, '03', '03 10.1'),
  entry('alerts.rules.db_disk', { default: rules.db_disk }, { minFreeMb: 100, maxDbMb: 4096 }, '03', '03 10.1'),
  entry('alerts.rules.hook_gap', { default: rules.hook_gap }, { enabled: false }, '03', '03 10.1'),
  entry('alerts.rules.hook_failing', { default: rules.hook_failing }, { cooldownMinutes: 5 }, '03', '03 10.1'),
  // pricing (03 8.3)
  entry('pricing.currency', PricingSectionKeys.currency, 'EUR', '03', '03 8.3'),
  entry('pricing.models', PricingSectionKeys.models, [priceSample], '03', '03 8.3'),
];
