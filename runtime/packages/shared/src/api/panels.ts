// Panel contracts (06 3.3, 3.4, 3.6; registry 1.6). The `data` types are a strict superset of the types of 04 section 13.
// `ChildKind`, `ChildKindStats` and `PanelStats` live here so that `HealthReport` can reference them without importing the
// engine; `engine/src/platform/exec.ts` re-exports `ChildKind` from this file.
import { z } from 'zod';

import { CountSchema, SessionIdSchema } from './ids.ts';
import { TokenUsageSchema } from './entities.ts';
import { IsoTimeSchema, NullableIsoTimeSchema } from './time.ts';

export const PANEL_KEYS = ['git', 'machine', 'attempts', 'ledger', 'chainLog', 'logs'] as const;
export const PanelKeySchema = z.enum(PANEL_KEYS);
export type PanelKey = z.infer<typeof PanelKeySchema>;

/** The `config.json` `panels` sub-key of each panel (legacy names). */
export const PANEL_CONFIG_KEY = {
  git: 'git',
  machine: 'machine',
  attempts: 'attempts',
  ledger: 'ledger',
  chainLog: 'chain_log',
  logs: 'logs',
} as const satisfies Record<PanelKey, string>;

export const PANEL_SOURCES = [
  'memory',
  'cpu',
  'processes',
  'docker',
  'git.status',
  'git.log',
  'stopFile',
  'ledger',
  'chainLog',
  'logs',
  'attempts',
] as const;
export const PanelSourceSchema = z.enum(PANEL_SOURCES);
export type PanelSource = z.infer<typeof PanelSourceSchema>;

export const SOURCE_STATUSES = ['ok', 'pending', 'disabled', 'unavailable', 'unsupported', 'error'] as const;
export const SourceStatusSchema = z.enum(SOURCE_STATUSES);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const PanelSourceStateSchema = z.strictObject({
  source: PanelSourceSchema,
  status: SourceStatusSchema,
  /** Time of the value being served; may be older than `generatedAt` (stale-while-revalidate). */
  sampledAt: NullableIsoTimeSchema,
  /** English, at most 200 characters, never transcript text, prompts or tokens. */
  message: z.string().max(200).nullable(),
});
export type PanelSourceState = z.infer<typeof PanelSourceStateSchema>;

/**
 * `ok`: every enabled source ok; `partial`: at least one source pending, unavailable, unsupported or in error but data is
 * present; `error`: no source produced data (`data` is null). A panel disabled in config is `404 panel_disabled`, not a response.
 */
export const PanelStatusSchema = z.enum(['ok', 'partial', 'error']);
export type PanelStatus = z.infer<typeof PanelStatusSchema>;

export const MachinePanelSchema = z.strictObject({
  /** Memory and CPU sample time. */
  sampledAt: IsoTimeSchema,
  freeGb: z.number().nullable(),
  totalGb: z.number().nullable(),
  usedPct: z.number().nullable(),
  /** `null` on the first sample of the process (legacy contract). */
  cpuPct: z.number().nullable(),
  /** Sorted by `mb` descending, then `name` ascending. */
  procs: z.array(z.strictObject({ name: z.string(), count: CountSchema, mb: z.number().nullable() })),
  /** `<name> (<status>)` lines; empty when disabled or unavailable, and the last rows are kept while `dockerStatus` is `error`. */
  docker: z.array(z.string()),
  platform: z.enum(['win32', 'linux', 'darwin', 'other']),
  procsSampledAt: NullableIsoTimeSchema,
  procsStatus: SourceStatusSchema,
  dockerEnabled: z.boolean(),
  dockerSampledAt: NullableIsoTimeSchema,
  dockerStatus: SourceStatusSchema,
});
export type MachinePanel = z.infer<typeof MachinePanelSchema>;

export const GitPanelSchema = z.strictObject({
  /** `null` when detached, not a repository, or git is missing. */
  branch: z.string().nullable(),
  /** Entries of `status --porcelain=v2`; `null` if unknown. */
  dirty: CountSchema.nullable(),
  /** `config.stop_file` exists (false when not configured). */
  stopFile: z.boolean(),
  /** Newest first, at most three. */
  commits: z.array(z.strictObject({ hash: z.string(), subject: z.string(), at: NullableIsoTimeSchema })).max(3),
  headOid: z.string().nullable(),
  detached: z.boolean(),
  repoState: z.enum(['ok', 'not_a_repository', 'git_missing', 'error']),
});
export type GitPanel = z.infer<typeof GitPanelSchema>;

/** Ledger (last 30 lines starting with `|`) and chain log (last 10 lines). */
export const LinesPanelSchema = z.strictObject({
  lines: z.array(z.string()),
  /** The configured path as written in config (relative or absolute). */
  file: z.string().nullable(),
  exists: z.boolean(),
  sizeBytes: CountSchema.nullable(),
  modifiedAt: NullableIsoTimeSchema,
});
export type LinesPanel = z.infer<typeof LinesPanelSchema>;

export const LogsPanelSchema = z.strictObject({
  files: z.array(
    z.strictObject({
      name: z.string(),
      ageS: z.number().min(0),
      sizeBytes: CountSchema,
      tail: z.array(z.string()),
      /** Forward slashes, relative to the repository when inside it, else absolute. */
      relPath: z.string(),
      modifiedAt: IsoTimeSchema,
    }),
  ),
  /** Files that matched before the top-4 cut. */
  matchedFiles: CountSchema,
});
export type LogsPanel = z.infer<typeof LogsPanelSchema>;

export const ATTEMPT_STATES = ['COMPLETED', 'FAILED', 'RUNNING', 'UNKNOWN'] as const;
export const AttemptStateSchema = z.enum(ATTEMPT_STATES);
export type AttemptState = z.infer<typeof AttemptStateSchema>;

export const AttemptsPanelSchema = z.strictObject({
  /** Start order, the last `limit` rows (default 30). */
  rows: z.array(
    z.strictObject({
      part: z.string(),
      n: z.number().int().nullable(),
      model: z.string().nullable(),
      effort: z.string().nullable(),
      startedAt: NullableIsoTimeSchema,
      endedAt: NullableIsoTimeSchema,
      exit: z.number().int().nullable(),
      status: z.string().nullable(),
      state: AttemptStateSchema.nullable(),
      sessionId: SessionIdSchema.nullable(),
      usage: TokenUsageSchema.nullable(),
      attemptId: z.number().int().min(1),
      /** Exact regex group text; the legacy semantics use the raw text. */
      nRaw: z.string().nullable(),
      exitRaw: z.string().nullable(),
      endReason: z.enum(['open', 'ended', 'superseded']),
      /** English evidence text (06 3.10.5). */
      evidence: z.string(),
      /** Session first record time minus `startedAt`, in seconds. */
      matchDeltaS: z.number().nullable(),
    }),
  ),
  sourceState: z.enum(['ok', 'not_configured', 'missing', 'error']),
});
export type AttemptsPanel = z.infer<typeof AttemptsPanelSchema>;

export const PanelDataSchemas = {
  git: GitPanelSchema,
  machine: MachinePanelSchema,
  attempts: AttemptsPanelSchema,
  ledger: LinesPanelSchema,
  chainLog: LinesPanelSchema,
  logs: LogsPanelSchema,
} as const;

export type PanelDataMap = { [K in PanelKey]: z.infer<(typeof PanelDataSchemas)[K]> };

function responseSchema<K extends PanelKey, D extends z.ZodType>(key: K, data: D) {
  return z.strictObject({
    key: z.literal(key),
    status: PanelStatusSchema,
    generatedAt: IsoTimeSchema,
    sources: z.array(PanelSourceStateSchema),
    data: data.nullable(),
  });
}

/** `GET /api/v3/panels/:key`: discriminated on `key`, so a payload of another panel is refused. */
export const PanelResponseSchema = z.discriminatedUnion('key', [
  responseSchema('git', GitPanelSchema),
  responseSchema('machine', MachinePanelSchema),
  responseSchema('attempts', AttemptsPanelSchema),
  responseSchema('ledger', LinesPanelSchema),
  responseSchema('chainLog', LinesPanelSchema),
  responseSchema('logs', LogsPanelSchema),
]);

/** `PanelResponse<K>`: the response of one panel, `data` typed by its key. */
export type PanelResponse<K extends PanelKey = PanelKey> = Extract<z.infer<typeof PanelResponseSchema>, { key: K }>;

// ---- child processes and panel statistics (HealthReport.children, HealthReport.panels) ------------------------------

/** The nine kinds of child process of 06 3.6 (ADR 0066 removed `python`); the order is the order of the registry. */
export const CHILD_KINDS = [
  'powershell.processes',
  'powershell.cmdline',
  'git',
  'docker',
  'ps',
  'taskkill',
  'node',
  'icacls',
  'opener',
] as const;
export const ChildKindSchema = z.enum(CHILD_KINDS);
export type ChildKind = z.infer<typeof ChildKindSchema>;

/** Counters per kind, from `childStats()` (registry C10: this name, never `ChildStat`). */
export const ChildKindStatsSchema = z.strictObject({
  spawned: CountSchema,
  failed: CountSchema,
  timedOut: CountSchema,
  totalMs: z.number().min(0),
});
export type ChildKindStats = z.infer<typeof ChildKindStatsSchema>;

export const PanelSourceStatsSchema = z.strictObject({
  refreshes: CountSchema,
  failures: CountSchema,
  lastDurationMs: z.number().min(0).nullable(),
  lastStatus: SourceStatusSchema.nullable(),
});
export type PanelSourceStats = z.infer<typeof PanelSourceStatsSchema>;

/** Only the sources that were read at least once; `PanelService.stats()`. */
export const PanelStatsSchema = z.partialRecord(PanelSourceSchema, PanelSourceStatsSchema);
export type PanelStats = z.infer<typeof PanelStatsSchema>;
