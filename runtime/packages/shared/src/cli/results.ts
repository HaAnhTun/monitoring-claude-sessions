// Per-command `data` types of the CLI (01 section 6.2, 6.4). WP-02 writes the configuration inspection, which the
// server also serves as `GET /api/v3/config` (03 6.1, I-20); the blocks below are filled by the owning work packages.
import { z } from 'zod';

import { R_TOP_KEYS } from '../config/runtime/index.ts';

export const CONFIG_SOURCES = ['builtin', 'skill', 'config', 'runtime', 'env', 'cli'] as const;

/** Where a configuration value comes from, highest layer last: builtin < skill < config / runtime < env < cli. */
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

export const ConfigSourceSchema = z.enum(CONFIG_SOURCES);

export const CONFIG_FILE_NAMES = ['defaults.json', 'runtime/defaults.json', 'config.json', 'runtime.json'] as const;

export const ConfigFileStatusSchema = z.strictObject({
  name: z.enum(CONFIG_FILE_NAMES),
  path: z.string(),
  schemaVersion: z.number().int().nullable(),
  present: z.boolean(),
  ok: z.boolean(),
});

export type ConfigFileStatus = z.infer<typeof ConfigFileStatusSchema>;

export const ConfigInspectionEntrySchema = z.strictObject({
  key: z.string(),
  value: z.unknown(),
  source: ConfigSourceSchema,
});

export type ConfigInspectionEntry = z.infer<typeof ConfigInspectionEntrySchema>;

export const ConfigInspectionSchema = z.strictObject({
  entries: z.array(ConfigInspectionEntrySchema),
  files: z.array(ConfigFileStatusSchema),
  effectivePort: z.number().int().min(1).max(65535),
  /** `null` for a workspace without `instance.json` (a pre-4.0 workspace). */
  engine: z.literal('node').nullable(),
});

export type ConfigInspection = z.infer<typeof ConfigInspectionSchema>;

/**
 * The part of the engine `ResolvedConfig` (01 2.3) that the projection reads. `ResolvedConfig` satisfies it, so
 * `toConfigInspection(ctx.config, 'node')` type-checks in the engine without shared depending on the engine.
 */
export interface ConfigInspectionSource {
  /** Merged legacy (L) keys. */
  readonly monitor: unknown;
  /** Merged runtime (R) keys. */
  readonly runtime: unknown;
  readonly effectivePort: number;
  /** Dotted key to source tag, including the extra entry `effectivePort` (01 2.5). */
  readonly provenance: Readonly<Record<string, ConfigSource>>;
  readonly files: readonly ConfigFileStatus[];
}

const R_TOP: ReadonlySet<string> = new Set(R_TOP_KEYS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep copy of a JSON-like value; `undefined` members are dropped and `undefined` itself becomes `null`. */
function toPlain(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((v: unknown) => toPlain(v));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toPlain(v);
    return out;
  }
  return value;
}

function valueAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (!isRecord(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Code-point order (Python `sorted` on `str`), so the result does not depend on the locale or on UTF-16 surrogate ordering.
 * The one string comparator for sorted keys, names and slugs; an astral character sorts after every BMP character.
 */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * Pure projection of a resolved configuration (01 6.4): one entry per provenance key except `effectivePort`, whose
 * value is read at the dotted path from the runtime (R) keys when the first segment is a runtime key, else from the
 * legacy (L) keys (the two name sets are disjoint). Entries are sorted by key in code-point order. No redaction:
 * loopback API, same user (D-C6).
 */
export function toConfigInspection(r: ConfigInspectionSource, engine: 'node' | null): ConfigInspection {
  const entries: ConfigInspectionEntry[] = [];
  for (const [key, source] of Object.entries(r.provenance)) {
    if (key === 'effectivePort') continue;
    const root = R_TOP.has(key.split('.')[0] ?? '') ? r.runtime : r.monitor;
    entries.push({ key, value: toPlain(valueAt(root, key)), source });
  }
  entries.sort((a, b) => compareCodePoints(a.key, b.key));
  return { entries, files: r.files.map((f) => ({ ...f })), effectivePort: r.effectivePort, engine };
}

// @wp-begin WP-22
/** One row of `mcs instances list` (01 6.4): the Node identity of a workspace and what the probe says of its runtime. */
export const InstanceRowSchema = z.strictObject({
  slug: z.string(),
  /** `node`: a usable `instance.json`; `missing`: none (not initialized); `broken`: unreadable, a link or a copied workspace. */
  identity: z.enum(['node', 'missing', 'broken']),
  /** A probe state of 01 4.8, or a quick one (`--no-probe`). */
  state: z.string(),
  url: z.string().nullable(),
  pid: z.number().int().nullable(),
  /** The runtime version of the live runtime, else the one `instance.json` names; `null` without either. */
  version: z.string().nullable(),
  /** A live runtime runs other code than the runtime folder holds now. */
  outdated: z.boolean(),
  /** Why the identity is `broken`; `null` otherwise. */
  problem: z.string().nullable(),
});

export type InstanceRow = z.infer<typeof InstanceRowSchema>;

export const DOCTOR_LEVELS = ['error', 'warn'] as const;

/** One check of `mcs doctor`: `ok`, or a failure whose `level` says whether it fails the command (`error`). */
export const DoctorCheckSchema = z.strictObject({
  id: z.string(),
  ok: z.boolean(),
  level: z.enum(DOCTOR_LEVELS),
  detail: z.string(),
  /** What to do about a failed check; stable text, so tests and agents can match it. */
  fix: z.string().optional(),
});

export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorReportSchema = z.strictObject({
  /** The task whose workspace checks ran; `null` when only the machine-wide checks ran. */
  task: z.string().nullable(),
  checks: z.array(DoctorCheckSchema),
  /** No error-level check failed (the exit code is 1 otherwise). */
  ok: z.boolean(),
});

export type DoctorReport = z.infer<typeof DoctorReportSchema>;
// @wp-end WP-22

// @wp-begin WP-37
// Result types of the hooks commands (02 3.1, ADR 0014, ADR 0070). The engine installer (`engine/src/hooks/installer/`)
// returns `HooksApplyResult`; `hooks verify` and `hooks status` return the other two.

/** Where a hooks command writes: the project-local or the user settings file, or an explicit file (`--settings-file`). */
export const HOOKS_SCOPES = ['project-local', 'user', 'file'] as const;

export type HooksScope = (typeof HOOKS_SCOPES)[number];

export const HooksScopeSchema = z.enum(HOOKS_SCOPES);

export const HOOKS_WARNING_CODES = ['HOOKS_SETTINGS_NOT_IGNORED', 'HOOKS_USER_SCOPE', 'HOOKS_LIVE_RELOAD'] as const;

export type HooksWarningCode = (typeof HOOKS_WARNING_CODES)[number];

export const HooksWarningSchema = z.strictObject({
  code: z.enum(HOOKS_WARNING_CODES),
  message: z.string(),
});

export type HooksWarning = z.infer<typeof HooksWarningSchema>;

/**
 * The `details.reason` of a `HOOKS_FAILED` error. The first eleven are the reasons of design 02 3.1; the rest are the
 * failures that design did not name (a read or write that fails at the operating system, the bundle and the home folder).
 */
export const HOOKS_FAILURE_REASONS = [
  'SETTINGS_INVALID_JSON',
  'SETTINGS_NOT_OBJECT',
  'SETTINGS_HOOKS_NOT_OBJECT',
  'SETTINGS_EVENT_NOT_ARRAY',
  'SCOPE_NOT_ALLOWED',
  'LOCKED',
  'REAL_SETTINGS_IN_TEST',
  'WRITE_VALIDATION_FAILED',
  'SETTINGS_CHANGED_CONCURRENTLY',
  'RENAME_FAILED',
  'POST_CHECK_FAILED',
  'SETTINGS_UNREADABLE',
  'SETTINGS_NOT_WRITABLE',
  'WRITE_FAILED',
  'BACKUP_FAILED',
  'HOOK_BUNDLE_MISSING',
  'SCRIPT_COPY_FAILED',
  'MANIFEST_FAILED',
] as const;

export type HooksFailureReason = (typeof HOOKS_FAILURE_REASONS)[number];

/** What a command does to the settings file: `plan` is a dry run that would change it, `noop` means nothing to change. */
export const HOOKS_ACTIONS = ['plan', 'applied', 'noop', 'refused'] as const;

export type HooksAction = (typeof HOOKS_ACTIONS)[number];

/** What happens to the stable copy of the hook script (ADR 0070): install gives the first three, uninstall the last three. */
export const HOOK_SCRIPT_ACTIONS = ['created', 'refreshed', 'current', 'removed', 'kept', 'absent'] as const;

export type HookScriptAction = (typeof HOOK_SCRIPT_ACTIONS)[number];

export const HooksScriptResultSchema = z.strictObject({
  action: z.enum(HOOK_SCRIPT_ACTIONS),
  /** `<MCS_HOME>/hooks/mcs-hook.mjs`, forward slashes. */
  path: z.string(),
  /** sha256 of the copy after the command; `null` when there is no copy. */
  sha256: z.string().nullable(),
});

export type HooksScriptResult = z.infer<typeof HooksScriptResultSchema>;

/** `hooks install` and `hooks uninstall` (02 3.1 plus the `script` field of ADR 0070). */
export const HooksApplyResultSchema = z.strictObject({
  scope: HooksScopeSchema,
  settingsPath: z.string(),
  action: z.enum(HOOKS_ACTIONS),
  /** Event names (02 3.4 step 8). */
  added: z.array(z.string()),
  replaced: z.array(z.string()),
  removed: z.array(z.string()),
  kept: z.array(z.string()),
  warnings: z.array(HooksWarningSchema),
  backupPath: z.string().nullable(),
  /** Unified diff of the `hooks` key only; empty when nothing changes. */
  diff: z.string(),
  script: HooksScriptResultSchema,
});

export type HooksApplyResult = z.infer<typeof HooksApplyResultSchema>;

export const HOOKS_VERIFY_CHECKS = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7'] as const;

/** `hooks verify` (02 3.7): `ok: null` means the check was skipped (V7 while the server is stopped). */
export const HooksVerifyResultSchema = z.strictObject({
  checks: z.array(
    z.strictObject({
      check: z.enum(HOOKS_VERIFY_CHECKS),
      ok: z.boolean().nullable(),
      detail: z.string(),
    }),
  ),
});

export type HooksVerifyResult = z.infer<typeof HooksVerifyResultSchema>;

/** `current`: same bytes as the bundled script; `stale`: another version; `missing`: recorded but gone; `unknown`: not decidable. */
export const HOOK_SCRIPT_STATES = ['current', 'stale', 'missing', 'not_installed', 'unknown'] as const;

export type HookScriptState = (typeof HOOK_SCRIPT_STATES)[number];

/** `hooks status` (02 3.1, ADR 0070). */
export const HooksStatusResultSchema = z.strictObject({
  installs: z.array(
    z.strictObject({
      settingsPath: z.string(),
      scope: HooksScopeSchema,
      events: z.number().int(),
      handlerVersion: z.string(),
      at: z.number(),
    }),
  ),
  /** The stable copy under `$MCS_HOME/hooks`. */
  script: z.strictObject({
    state: z.enum(HOOK_SCRIPT_STATES),
    path: z.string(),
    sha256: z.string().nullable(),
    handlerVersion: z.string().nullable(),
  }),
  handlerLog: z.array(z.strictObject({ code: z.string(), count: z.number().int(), lastAt: z.number() })),
  /** Newest envelope time per instance id; `null` when none was seen. */
  lastEnvelopeAt: z.record(z.string(), z.number().nullable()),
});

export type HooksStatusResult = z.infer<typeof HooksStatusResultSchema>;
// @wp-end WP-37

// @wp-begin WP-61
// Result types of the data commands (01 6.4): `sessions list`, `sessions show`, `usage` and `errors`. Every one carries the task and
// the mode of the reader that answered (`api`: the instance runs; `db`: it is stopped), which is for debugging and not part of the data.
import {
  AgentNodeSchema,
  EntryKindSchema,
  EventCategorySchema,
  EventKindSchema,
  SessionDetailSchema,
  SessionSummarySchema,
  ToolFrequencyReportSchema,
  ToolStatusSchema,
  UsageReportSchema,
  UsageSeriesSchema,
} from '../api/entities.ts';
import { ErrorItemSchema } from '../api/health.ts';
import { AgentIdSchema, CountSchema } from '../api/ids.ts';
import { IsoTimeSchema } from '../api/time.ts';

export const READER_MODES = ['api', 'db'] as const;

export type ReaderMode = (typeof READER_MODES)[number];

export const ReaderModeSchema = z.enum(READER_MODES);

/** `mcs sessions list`: the sessions of the page, and whether more match than were returned. */
export const SessionsListResultSchema = z.strictObject({
  task: z.string(),
  mode: ReaderModeSchema,
  items: z.array(SessionSummarySchema),
  /** The number of matching sessions (capped at 10000). */
  total: CountSchema.nullable(),
  totalIsLowerBound: z.boolean(),
  limit: z.number().int().min(1).max(500),
  /** More sessions match than `items` holds. */
  hasMore: z.boolean(),
});

export type SessionsListResult = z.infer<typeof SessionsListResultSchema>;

/** One activity event of `mcs sessions show`; `summary` (the tool summary) is `null` unless `--include-text` was given. */
export const SessionEventLineSchema = z.strictObject({
  id: CountSchema,
  at: IsoTimeSchema,
  agentId: AgentIdSchema.nullable(),
  type: EventKindSchema,
  category: EventCategorySchema,
  severity: z.enum(['info', 'warning', 'error']),
  toolName: z.string().nullable(),
  toolStatus: ToolStatusSchema.nullable(),
  durationMs: CountSchema.nullable(),
  summary: z.string().nullable(),
});

export type SessionEventLine = z.infer<typeof SessionEventLineSchema>;

/** The newest transcript entries of the main agent, only with `--include-text`; each text is clipped to `clipChars` characters. */
export const SessionTranscriptTailSchema = z.strictObject({
  agentId: AgentIdSchema,
  /** Entries in the transcript file. */
  total: CountSchema,
  clipChars: z.number().int().min(1),
  entries: z.array(
    z.strictObject({
      i: CountSchema,
      t: z.string(),
      k: EntryKindSchema,
      name: z.string().nullable(),
      text: z.string(),
    }),
  ),
});

export type SessionTranscriptTail = z.infer<typeof SessionTranscriptTailSchema>;

/** `mcs sessions show`: the session with its state and evidence, its agents, its newest events and, on request, transcript text. */
export const SessionsShowResultSchema = z.strictObject({
  task: z.string(),
  mode: ReaderModeSchema,
  session: SessionDetailSchema,
  agents: z.array(AgentNodeSchema),
  /** More agents exist than `agents` holds. */
  agentsTruncated: z.boolean(),
  /** Oldest first. */
  events: z.array(SessionEventLineSchema),
  /** Older events exist than `events` holds. */
  eventsTruncated: z.boolean(),
  transcript: SessionTranscriptTailSchema.nullable(),
});

export type SessionsShowResult = z.infer<typeof SessionsShowResultSchema>;

export const USAGE_GROUPS = ['session', 'model', 'day', 'tool'] as const;

export type UsageGroup = (typeof USAGE_GROUPS)[number];

/** `mcs usage --by session|model|day|tool`: the report of the matching analytics route. */
export const UsageResultSchema = z.discriminatedUnion('by', [
  z.strictObject({ task: z.string(), mode: ReaderModeSchema, by: z.literal('session'), report: UsageReportSchema }),
  z.strictObject({ task: z.string(), mode: ReaderModeSchema, by: z.literal('model'), report: UsageReportSchema }),
  z.strictObject({ task: z.string(), mode: ReaderModeSchema, by: z.literal('day'), series: UsageSeriesSchema }),
  z.strictObject({ task: z.string(), mode: ReaderModeSchema, by: z.literal('tool'), tools: ToolFrequencyReportSchema }),
]);

export type UsageResult = z.infer<typeof UsageResultSchema>;

/** `mcs errors`: the recent errors of the instance, newest first. */
export const ErrorsResultSchema = z.strictObject({
  task: z.string(),
  mode: ReaderModeSchema,
  items: z.array(ErrorItemSchema),
});

export type ErrorsResult = z.infer<typeof ErrorsResultSchema>;
// @wp-end WP-61

// @wp-begin WP-62
import { BACKUP_DB_COPIES, BACKUP_REASONS } from '../files/backup-manifest.ts';
import { IsoSecondsZ, Semver } from '../ids.ts';

/** One backup folder with a valid manifest, as `mcs backup list` shows it (01 5.5). */
export const BackupRowSchema = z.strictObject({
  id: z.string(),
  reason: z.enum(BACKUP_REASONS),
  createdAt: IsoSecondsZ,
  runtimeVersion: Semver,
  dbSchemaVersion: z.number().int().min(0),
  dbCopy: z.enum(BACKUP_DB_COPIES),
  /** The number of files the manifest lists. */
  files: z.number().int().min(0),
  /** The sum of the listed sizes. */
  bytes: z.number().int().min(0),
  /** `--verify`: every listed file was read again and matches its size and sha256; `null` without `--verify`. */
  verified: z.boolean().nullable(),
  /** What `--verify` found wrong (a missing or changed file); empty otherwise. */
  problems: z.array(z.string()),
});

export type BackupRow = z.infer<typeof BackupRowSchema>;

export const BackupListResultSchema = z.strictObject({
  task: z.string(),
  verify: z.boolean(),
  /** Newest first. */
  backups: z.array(BackupRowSchema),
});

export type BackupListResult = z.infer<typeof BackupListResultSchema>;

export const BackupCreateResultSchema = z.strictObject({
  task: z.string(),
  id: z.string(),
  reason: z.enum(BACKUP_REASONS),
  /** `data/backups/<id>/`, relative to the workspace. */
  folder: z.string(),
  dbCopy: z.enum(BACKUP_DB_COPIES),
  dbSchemaVersion: z.number().int().min(0),
  files: z.number().int().min(0),
  bytes: z.number().int().min(0),
  /** Who copied the database: the CLI (stopped instance), the running server (control op `backup`) or nobody (no database). */
  dbCopiedBy: z.enum(['cli', 'server']).nullable(),
  /** Ids of the older backups the automatic pruning (`backup.keep`) removed. */
  pruned: z.array(z.string()),
});

export type BackupCreateResult = z.infer<typeof BackupCreateResultSchema>;

export const BackupRestoreResultSchema = z.strictObject({
  task: z.string(),
  id: z.string(),
  /** `false`: a dry run (no `--yes`), nothing was changed. */
  applied: z.boolean(),
  dbCopy: z.enum(BACKUP_DB_COPIES),
  /** The schema version of the database in the backup. */
  dbSchemaVersion: z.number().int().min(0),
  /** The runtime that made the backup. */
  runtimeVersion: Semver,
  /** Workspace files the restore replaces (or would replace), relative with `/`. */
  restores: z.array(z.string()),
  /** The `pre-restore` backup that was made first; `null` for a dry run. */
  preRestoreBackup: z.string().nullable(),
  /** The restored database is older than this runtime: `mcs upgrade` is the next step. */
  upgradeNeeded: z.boolean(),
  pruned: z.array(z.string()),
});

export type BackupRestoreResult = z.infer<typeof BackupRestoreResultSchema>;

/** One pending database migration. */
export const DbMigrationStepSchema = z.strictObject({ version: z.number().int().min(1), name: z.string() });

export type DbMigrationStep = z.infer<typeof DbMigrationStepSchema>;

export const DbPlanSchema = z.strictObject({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  steps: z.array(DbMigrationStepSchema),
});

export type DbPlan = z.infer<typeof DbPlanSchema>;

export const UpgradePlanSchema = z.strictObject({
  runtimeFrom: Semver,
  runtimeTo: Semver,
  /** `null`: the workspace has no database yet (the first start creates it at the current schema). */
  db: DbPlanSchema.nullable(),
  /** File migrations of `config migrate` that are pending (none exist yet). */
  files: z.array(z.string()),
  /** Anything to do: a newer runtime version to record or a database migration. */
  needed: z.boolean(),
  /** The backup that applying the plan makes first: `data/backups/<id>/`, relative to the workspace. */
  backup: z.string().nullable(),
});

export type UpgradePlan = z.infer<typeof UpgradePlanSchema>;

export const UpgradeResultSchema = z.strictObject({
  task: z.string(),
  /** `current`: nothing to do; `dry-run`: the plan only; `upgraded`: applied. */
  outcome: z.enum(['current', 'dry-run', 'upgraded']),
  plan: UpgradePlanSchema,
  /** The id of the `upgrade` backup (applied runs only). */
  backup: z.string().nullable(),
  /** `ok` after migrations (the copy was read again with `PRAGMA quick_check`); `null` when no migration ran. */
  integrity: z.literal('ok').nullable(),
  /** `--restart`: what happened to the server. `null` without `--restart`. */
  restart: z
    .strictObject({
      stopped: z.boolean(),
      started: z.boolean(),
      url: z.string().nullable(),
      pid: z.number().int().nullable(),
    })
    .nullable(),
  pruned: z.array(z.string()),
  /** 1 when `--restart` did not bring the server up. */
  exitCode: z.union([z.literal(0), z.literal(1)]),
});

export type UpgradeResult = z.infer<typeof UpgradeResultSchema>;

export const DbMigrateResultSchema = z.strictObject({
  task: z.string(),
  /** `no-database`: nothing to migrate, the first start creates the database. */
  outcome: z.enum(['no-database', 'current', 'dry-run', 'migrated']),
  db: DbPlanSchema.nullable(),
  backup: z.string().nullable(),
  integrity: z.literal('ok').nullable(),
  pruned: z.array(z.string()),
});

export type DbMigrateResult = z.infer<typeof DbMigrateResultSchema>;

export const DbRebuildResultSchema = z.strictObject({
  task: z.string(),
  /** `false`: a dry run, nothing was moved. */
  applied: z.boolean(),
  /** The database files that are (or would be) moved into the backup. Empty: there is no database. */
  files: z.array(z.strictObject({ path: z.string(), bytes: z.number().int().min(0) })),
  /** The `db-rebuild` backup the files were moved into (applied runs only). */
  backup: z.string().nullable(),
  pruned: z.array(z.string()),
});

export type DbRebuildResult = z.infer<typeof DbRebuildResultSchema>;
// @wp-end WP-62

// @wp-begin WP-64
// @wp-end WP-64

// @wp-begin WP-107
/** The scopes of `mcs cleanup` (01 6.4), in the order the help lists them. */
export const CLEANUP_SCOPES = ['stale-state', 'init-leftovers', 'logs', 'backups', 'spool', 'data'] as const;

export type CleanupScope = (typeof CLEANUP_SCOPES)[number];

export const CleanupScopeSchema = z.enum(CLEANUP_SCOPES);

/** One thing a cleanup run deletes (or would delete): a path relative to the workspace (or the tasks root) with `/`. */
export const CleanupTargetSchema = z.strictObject({
  path: z.string(),
  bytes: z.number().int().min(0),
});

export type CleanupTarget = z.infer<typeof CleanupTargetSchema>;

/** A candidate that the run left alone, with the reason (a link, a live monitor, an unfinished backup, ...). */
export const CleanupSkippedSchema = z.strictObject({
  path: z.string(),
  reason: z.string(),
});

export type CleanupSkipped = z.infer<typeof CleanupSkippedSchema>;

/** What `--scope data` deletes (or would delete): the plan of the retention run (03 3.8) without any session text. */
export const CleanupDataSchema = z.strictObject({
  /** Sessions the run deletes. */
  sessions: z.number().int().min(0),
  /** Last activity before this instant (ISO, UTC) is deleted; `null` = the policy keeps sessions. */
  sessionsBefore: z.string().nullable(),
  /** Timeline rows before this instant of sessions that stay are deleted; `null` = the policy keeps them. */
  eventsBefore: z.string().nullable(),
  /** Rows that go with the sessions, per table. */
  rows: z.record(z.string(), z.number().int().min(0)),
  /** Message keys that another session's transcript still holds: their usage moves there. */
  reownedMessages: z.number().int().min(0),
  /** Database bytes given back; `null` for a dry run. */
  freedBytes: z.number().int().min(0).nullable(),
});

export type CleanupData = z.infer<typeof CleanupDataSchema>;

export const CleanupResultSchema = z.strictObject({
  /** `null` for `init-leftovers`, which works on the tasks root. */
  task: z.string().nullable(),
  scope: CleanupScopeSchema,
  /** `false`: a dry run, nothing was deleted. */
  applied: z.boolean(),
  /** What the plan lists (a dry run) or what was deleted (an applied run). */
  targets: z.array(CleanupTargetSchema),
  skipped: z.array(CleanupSkippedSchema),
  /** Number of targets, and the sum of their sizes. For `data`: the sessions deleted, and 0. */
  count: z.number().int().min(0),
  bytes: z.number().int().min(0),
  /** Applied runs: the targets that were listed again after the deletion and are still there (empty = confirmed). */
  remaining: z.array(z.string()),
  /** The `cleanup` backup made first (`data` only, applied runs only). */
  backup: z.string().nullable(),
  data: CleanupDataSchema.nullable(),
  /** Ids of the older backups the automatic pruning removed after the `cleanup` backup. */
  pruned: z.array(z.string()),
  /** Why nothing is listed when that is not obvious (no database, no retention policy, no state to look at). */
  note: z.string().nullable(),
});

export type CleanupResult = z.infer<typeof CleanupResultSchema>;

export const CONFIG_MIGRATE_FILES = ['config.json', 'runtime.json', 'instance.json'] as const;

export type ConfigMigrateFile = (typeof CONFIG_MIGRATE_FILES)[number];

/** One file migration step (`FileMigration` of the engine without its function). */
export const ConfigMigrateStepSchema = z.strictObject({
  file: z.enum(CONFIG_MIGRATE_FILES),
  from: z.number().int().min(1),
  to: z.number().int().min(2),
  describe: z.string(),
});

export type ConfigMigrateStep = z.infer<typeof ConfigMigrateStepSchema>;

export const ConfigMigrateResultSchema = z.strictObject({
  task: z.string(),
  /** `current`: nothing pending, nothing written; `dry-run`: the plan only; `migrated`: applied. */
  outcome: z.enum(['current', 'dry-run', 'migrated']),
  /** Every file of the workspace that exists, with its `schema_version` before the run. */
  files: z.array(z.strictObject({ file: z.enum(CONFIG_MIGRATE_FILES), version: z.number().int() })),
  steps: z.array(ConfigMigrateStepSchema),
  /** The `config-migrate` backup made before the first write (applied runs only). */
  backup: z.string().nullable(),
  /** The server runs and reads `runtime.json` at start only (applied runs). */
  restartNeeded: z.boolean(),
  pruned: z.array(z.string()),
});

export type ConfigMigrateResult = z.infer<typeof ConfigMigrateResultSchema>;
// @wp-end WP-107

// @wp-begin WP-141
// The diagnostics bundle of `mcs diagnostics` (01 6.4, `schemas/diagnostics.v1.schema.json`). It is a report about the runtime
// for a person who asks for help: it holds no prompt, no transcript text, no regex or other configuration text, no environment
// value and no token. Absolute paths are written as `<repo>` and `<home>` relative forms.
import { AlertItemSchema } from '../api/entities.ts';
import { HealthReportSchema } from '../api/health.ts';

/** The `schema` field of a bundle. */
export const DIAGNOSTICS_SCHEMA = 'mcs.diagnostics/1';

/** At most this many records of `runtime.log` go into a bundle. */
export const DIAGNOSTICS_LOG_RECORDS = 200;

/** A value `safeValues` may hold: a number, a boolean, or the member of a closed list of words (an enumeration). */
export const SafeValueSchema = z.union([z.number(), z.boolean(), z.string()]);

/** One record of `runtime.log`, reduced to the allow-listed fields of the logger (05 S-LOG-1). */
export const LogRecordSchema = z
  .object({
    ts: z.string(),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    event: z.string(),
  })
  .catchall(z.union([z.string(), z.number(), z.boolean()]));

export type LogRecord = z.infer<typeof LogRecordSchema>;

const NonNegativeInt = z.number().int().min(0);

/** What `status` knows of the instance, without the task text and the legacy reader block. */
export const DiagnosticsStatusSchema = z.strictObject({
  running: z.boolean(),
  /** A probe state of 01 4.8. */
  probe: z.string(),
  pid: z.number().int().nullable(),
  url: z.string().nullable(),
  uptimeS: z.number().min(0).nullable(),
  codeStamp: z.string().nullable(),
  runtimeVersion: z.string().nullable(),
  outdated: z.boolean().nullable(),
  outdatedReason: z.enum(['code_stamp_changed', 'runtime_version_changed']).nullable(),
  dbSchemaVersion: NonNegativeInt.nullable(),
  ingestion: z.strictObject({ status: z.string(), reasons: z.array(z.string()) }).nullable(),
  sessions: z
    .strictObject({
      RUNNING: NonNegativeInt,
      IDLE: NonNegativeInt,
      COMPLETED: NonNegativeInt,
      FAILED: NonNegativeInt,
      UNKNOWN: NonNegativeInt,
    })
    .nullable(),
  partialSessions: NonNegativeInt.nullable(),
  hint: z.string().nullable(),
  recentErrors: z.array(z.strictObject({ at: z.string(), where: z.string(), message: z.string() })),
});

export type DiagnosticsStatus = z.infer<typeof DiagnosticsStatusSchema>;

/** An alert as the bundle keeps it: the kind and the numbers, never the title or the detail (they can name a session). */
export const DiagnosticsAlertSchema = z.strictObject({
  rule: AlertItemSchema.shape.rule,
  severity: AlertItemSchema.shape.severity,
  status: AlertItemSchema.shape.status,
  since: AlertItemSchema.shape.since,
  fireCount: AlertItemSchema.shape.fireCount,
});

/** `GET /api/v3/health` as served, with the alerts reduced to `DiagnosticsAlertSchema`. */
export const DiagnosticsHealthSchema = HealthReportSchema.omit({ alerts: true }).extend({
  alerts: z.array(DiagnosticsAlertSchema).max(20),
});

export type DiagnosticsHealth = z.infer<typeof DiagnosticsHealthSchema>;

export const DiagnosticsBundleSchema = z.strictObject({
  schema: z.literal(DIAGNOSTICS_SCHEMA),
  generatedAt: z.string(),
  runtime: z.strictObject({
    version: z.string(),
    /** The build stamp of the runtime folder; `null` without one. */
    codeStamp: z.string().nullable(),
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    /** The running runtime is built from the code in the runtime folder; `null` when no runtime runs (or no task). */
    buildCurrent: z.boolean().nullable(),
  }),
  /** `null` without a task, or when the workspace has no readable `instance.json`. */
  instance: z
    .strictObject({
      instanceId: z.string(),
      slug: z.string(),
      dbSchemaVersion: NonNegativeInt,
      hooksEnabled: z.boolean(),
    })
    .nullable(),
  /** `null` without a task, or when the configuration cannot be resolved (`doctor` says why). */
  config: z
    .strictObject({
      files: z.array(ConfigFileStatusSchema),
      provenance: z.record(z.string(), ConfigSourceSchema),
      /** Numbers, booleans and members of closed word lists only. */
      safeValues: z.record(z.string(), SafeValueSchema),
      /** Every other key, with a marker for what is there: `<path>`, `<pattern length=N>`, `<text length=N>`, `<list length=N>`, `<unset>`. */
      redacted: z.record(z.string(), z.string()),
    })
    .nullable(),
  doctor: z.array(DoctorCheckSchema),
  status: DiagnosticsStatusSchema.nullable(),
  health: DiagnosticsHealthSchema.nullable(),
  hooks: HooksVerifyResultSchema.nullable(),
  logTail: z.array(LogRecordSchema).max(DIAGNOSTICS_LOG_RECORDS),
  disk: z.strictObject({ freeBytes: NonNegativeInt.nullable() }),
  /** What could not be collected, one short line each (a stopped instance has no health). */
  notes: z.array(z.string()),
});

export type DiagnosticsBundle = z.infer<typeof DiagnosticsBundleSchema>;
// @wp-end WP-141
