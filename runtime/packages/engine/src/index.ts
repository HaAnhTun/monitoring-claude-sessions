// @wp-begin WP-05
export * from './pyjson/index.ts';
// @wp-end WP-05

// @wp-begin WP-07
export { hostPlatform, pathsCaseInsensitive } from './platform/host.ts';
export type { HostPlatform } from './platform/host.ts';
export {
  buildChildEnv,
  childStats,
  execFileText,
  firstLine,
  powershellEncodedArgs,
  resolveExecutable,
  setChildLogSink,
  spawnDetached,
  spawnForeground,
} from './platform/exec.ts';
export type {
  ChildErrorCode,
  ChildKind,
  ChildKindStats,
  ChildLogEntry,
  ChildLogSink,
  ChildResult,
  ChildSpec,
} from './platform/exec.ts';
export { commandLineOf, forceKill, isValidPid, pidAlive, waitForExit } from './platform/process.ts';
export {
  AtomicWriteError,
  SmallFileError,
  atomicWriteFile,
  clipCodePoints,
  pySplitlines,
  readSmallFile,
  tailLines,
  unlinkWithRetry,
} from './platform/fsx.ts';
export type { AtomicWriteOptions } from './platform/fsx.ts';
export { canonicalPath, isMsysPath, pathKey, samePath, toPosixRel } from './platform/paths.ts';
export { globFiles } from './platform/glob.ts';
export type { GlobOptions, GlobResult } from './platform/glob.ts';
export { PyStrptimeFormatError, pyStrptime, pyStrptimeValidate, toEpochMs } from './platform/pytime.ts';
export type { PyTimeFields } from './platform/pytime.ts';
export { createWatchHint } from './platform/watch-hint.ts';
export type { WatchHint, WatchHintOptions } from './platform/watch-hint.ts';
export { MutexTimeoutError, acquireMutex, mutexName, tryAcquireMutex } from './platform/mutex.ts';
export type { AcquireOptions, ProcessMutex } from './platform/mutex.ts';
export { hasLegacyMarker, hasRuntimeMarker, listRuntimeProcesses } from './platform/markers.ts';
export type { RuntimeProcess } from './platform/markers.ts';
// @wp-end WP-07

// @wp-begin WP-08
export { AGENT_RE, RUN_ID_RE, SID_RE, isContained, resolveContained, walkNoLinks } from './security/paths.ts';
export type { WalkOptions, WalkSummary } from './security/paths.ts';
export {
  LOG_FIELD_NAMES,
  LOG_KEEP,
  LOG_MAX_QUEUED_LINES,
  LOG_ROTATE_BYTES,
  LOG_ROTATE_RETRY_BUDGET_MS,
  createLogger,
} from './log/logger.ts';
export type { LogFields, LogLevel, Logger, LoggerOptions, LoggerStats } from './log/logger.ts';
// @wp-end WP-08

// @wp-begin WP-09
export {
  openSqlite,
  pragmaNumber,
  pragmaValue,
  toDbError,
  type SqlDriver,
  type SqlParams,
  type SqlValue,
  type Stmt,
} from './db/driver.ts';
export {
  DB_ERROR_CODES,
  DbError,
  isDbError,
  type DbConstraintKind,
  type DbErrorCode,
  type DbErrorDetails,
} from './db/errors.ts';
export {
  DB_OPEN_EXIT_CODES,
  openInstanceDb,
  type InstanceDb,
  type OpenInstanceDbOptions,
  type OpenMode,
  type RepoContext,
} from './db/open.ts';
export {
  loadMigrationFiles,
  migrateDb,
  migrationStatus,
  peekDbSchemaVersion,
  planDbMigrations,
  type MigrateDbOptions,
  type MigrationFile,
  type MigrationStatus,
} from './db/migrations.ts';
export { backupDb, type BackupOptions, type BackupSourcePath } from './db/backup.ts';
export { onCommitted, withWriteTx, type WriteTx } from './db/write.ts';
export type { ChangeRecorder } from './db/changes.ts';
// @wp-end WP-09

// @wp-begin WP-12
export {
  checkSchemaVersion,
  defaultSkillDir,
  getEntry,
  loadSkillDefaults,
  parseLegacyConfig,
  readConfigJson,
  readOptionalConfigJson,
  schemaVersionOf,
  LegacyConfigSchema,
} from './config/defaults.ts';
export type { LegacyConfig, PyObject, SkillDefaults } from './config/defaults.ts';
export { L_MERGED, isPlainObject, mergeLayer } from './config/merge.ts';
export type { PlainObject } from './config/merge.ts';
export {
  FILE_MIGRATIONS,
  applyMigrations,
  assertMigrationRegistry,
  latestFileVersion,
  planFileMigrations,
} from './config/migrations.ts';
export type { FileMigration, MigratedFile } from './config/migrations.ts';
export { leafPaths, legacyProvenance, runtimeProvenance } from './config/provenance.ts';
export type { RuntimeLayer } from './config/provenance.ts';
export { resolveConfig } from './config/resolve.ts';
export type { ConfigWorkspace, ResolveInput, ResolvedConfig } from './config/resolve.ts';
export {
  LEGACY_KEYS,
  LegacyConfigFileSchema,
  compileConfigPatterns,
  validateLegacy,
} from './config/validate-legacy.ts';
export type { CompiledPatterns, LegacyKeySpec, LegacyValidateOptions } from './config/validate-legacy.ts';
// @wp-end WP-12

// @wp-begin WP-13
export {
  appendWorkspaceFile,
  assertNotLink,
  compareAndDelete,
  isLink,
  isMissingFileError,
  readJsonFile,
  readTextTail,
  readTextUniversal,
  writePyJsonFile,
  writeWorkspaceFile,
} from './workspace/fsio.ts';
export type { WriteOptions } from './workspace/fsio.ts';
export {
  TASK_MUTEX_TIMEOUT_MS,
  WORKSPACE_DIRS,
  WORKSPACE_JSON_FILES,
  checkSlug,
  resolveWorkspace,
  slugify,
  tasksRootOf,
  withTaskMutex,
  workspacePath,
} from './workspace/paths.ts';
export type { TaskMutexOptions, WorkspaceRef } from './workspace/paths.ts';
export {
  RUNTIME_MUTABLE_PATHS,
  changedWorkspaces,
  isRuntimeMutable,
  snapshotWorkspace,
  snapshotWorkspaces,
} from './workspace/snapshot.ts';
export type { SnapshotOptions, SnapshotsOptions } from './workspace/snapshot.ts';
export {
  adoptWorkspace,
  ensureWorkspaceDir,
  instanceFileToPy,
  newInstanceFile,
  readInstanceFile,
  readTaskFile,
  writeInstanceFile,
} from './workspace/adopt.ts';
export type {
  AdoptOptions,
  AdoptResult,
  EngineName,
  NewInstanceOptions,
  ReadInstanceOptions,
} from './workspace/adopt.ts';
export { cleanupStaging, initWorkspace } from './workspace/init.ts';
export type { InitOptions, InitResult } from './workspace/init.ts';
export { listWorkspaceSlugs, listWorkspaces } from './workspace/list.ts';
export type { WorkspaceEntry } from './workspace/list.ts';
export { applyRepair, planRepair } from './workspace/repair.ts';
export type { RepairOptions, RepairPlan, RepairResult, RunningCheck } from './workspace/repair.ts';
export {
  AUDIT_ACTIONS,
  CHANGES_HEADER,
  DECISIONS_HEADER,
  appendChange,
  appendDecision,
  changeEntryText,
  decisionEntryText,
  lastChange,
  recentAudit,
} from './audit/writer.ts';
export type { AuditAction, ChangeEntry } from './audit/writer.ts';
export { AUDIT_FILES, AUDIT_READ_BYTES, auditFilePath, entriesBetween, readAuditText } from './audit/reader.ts';
export type { AuditFile, AuditLogSink, AuditRef, EntriesOptions } from './audit/reader.ts';
// @wp-end WP-13

// @wp-begin WP-14
export * as opsWorkspace from './ops/workspace.ts';
export * as opsConfig from './ops/config.ts';
export * as opsAudit from './ops/audit.ts';
export { version as opsVersion } from './ops/workspace.ts';
export type {
  DiscoverDeps,
  DiscoverResult,
  DiscoveredInstance,
  DiscoveredSession,
  InitDeps,
  InitInput,
  InitOpResult,
  OpContext,
  ProbeSummary,
  QuickProbe,
  QuickProbeState,
  TranscriptDiscovery,
  VersionDeps,
  VersionResult,
} from './ops/workspace.ts';
export type {
  CheckDeps,
  CheckInput,
  CheckResult,
  ConfigureDeps,
  ConfigureInput,
  ConfigureReport,
  InspectDeps,
  InspectReport,
  InspectResult,
  InspectTasksResult,
} from './ops/config.ts';
export type { AuditCheckInput, AuditReportItem, DecisionInput, DecisionResult } from './ops/audit.ts';
// @wp-end WP-14

// @wp-begin WP-16
export { createErrorRing } from './runtime/error-ring.ts';
export type { ErrorRing } from './runtime/error-ring.ts';
export { bindPanelStats, buildInstanceContext } from './runtime/context.ts';
export type { BuildContextInput, ExecApi, InstanceContext, RuntimeProcessInfo } from './runtime/context.ts';
export { createInstanceRuntime } from './runtime/instance-runtime.ts';
export type {
  InstanceRuntime,
  InstanceRuntimeOptions,
  RuntimeComponent,
  RuntimeFactories,
} from './runtime/instance-runtime.ts';
export { createStateWatchdog } from './runtime/state-watchdog.ts';
export type { StateWatchdog } from './runtime/state-watchdog.ts';
export { testHook } from './runtime/test-hooks.ts';
// @wp-end WP-16

// @wp-begin WP-17
export { createQueries, registerQueryPart } from './query/index.ts';
export type { AuditQueries, AuditReader, EngineQueries, Queries, QueryDeps, QueryPart } from './query/index.ts';
export { formatCommand, instanceCommands } from './ops/commands.ts';
export type { InstanceCommandInput } from './ops/commands.ts';
// @wp-end WP-17

// @wp-begin WP-19
// @wp-end WP-19

// @wp-begin WP-22
// @wp-end WP-22

// @wp-begin WP-25
export { DISABLE_ALL_HOOKS_SETTINGS, claudeArgsWithoutHooks } from './external/launch-claude.ts';
export type { ClaudeLaunch } from './external/launch-claude.ts';
// @wp-end WP-25

// @wp-begin WP-28
export {
  AGENT_KINDS,
  AGENT_NOTIFICATION_STATUSES,
  AgentFactsSchema,
  BASES,
  CONFIDENCES,
  DEFAULT_LIFECYCLE_CFG,
  EVIDENCE_FACTS,
  EVIDENCE_SOURCES,
  JOURNAL_STATES,
  PRESENCES,
  STALE_KINDS,
  SessionFactsSchema,
  START_SOURCES,
  TURN_OUTCOMES,
  ToolCallRowSchema,
  WAIT_REASONS,
  WorkflowFactsSchema,
  agentFactsOfEvent,
  agentFactsWith,
  emptyAgentFacts,
  emptySessionFacts,
  emptyToolCallRow,
  emptyWorkflowFacts,
  parseAgentFacts,
  parseSessionFacts,
  parseToolCallRow,
  parseWorkflowFacts,
  sessionFactsOfEvent,
  sessionFactsWith,
  toolRowsOfEvent,
  workflowFactsOfEvent,
  workflowFactsWith,
} from './lifecycle/facts.ts';
export type {
  AgentFactKind,
  AgentFacts,
  AgentNotificationStatus,
  AttemptFact,
  Basis,
  Confidence,
  EventOrigin,
  EvidenceFact,
  EvidenceSource,
  JournalState,
  LegacyFacts,
  LifecycleCfg,
  LifecycleEvidence,
  LifecycleView,
  Lww,
  PermissionFact,
  Presence,
  RegistryFact,
  SessionFacts,
  StaleKind,
  StartSource,
  ToolCallRow,
  TurnEndInfo,
  TurnOutcome,
  WaitReason,
  WorkflowFacts,
} from './lifecycle/facts.ts';
export {
  PERMISSIONS_KEPT,
  agentFactsOf,
  applyEvent,
  emptyModel,
  joinLww,
  joinStamp,
  mergeAgentFacts,
  mergeFacts,
  mergeModels,
  mergeSessionFacts,
  mergeToolCallRow,
  mergeWorkflowFacts,
  workflowFactsOf,
} from './lifecycle/merge.ts';
export type { LifecycleModel } from './lifecycle/merge.ts';
export { deriveModel, deriveSession, isReopened } from './lifecycle/derive-session.ts';
export type { ModelViews } from './lifecycle/derive-session.ts';
export { deriveAgent } from './lifecycle/derive-agent.ts';
export { deriveWorkflow } from './lifecycle/derive-workflow.ts';
export { fmtAge, renderEvidence, toApiEvidence, viewChanged } from './lifecycle/rules.ts';
export type { AgentRows, AgentSummary, SessionRows, WorkflowRows, WorkflowSummary } from './lifecycle/rules.ts';
export {
  classifyLegacy,
  classifyLegacyAgent,
  classifyLegacyOfFacts,
  legacyAgentDone,
  legacyDone,
  legacyInputOfFacts,
  legacyOfSession,
  toLegacy,
} from './lifecycle/legacy.ts';
export type { LegacyClassification, LegacyClassifyInput, LegacyRows } from './lifecycle/legacy.ts';
export { nextCheckAt } from './lifecycle/next-check.ts';
export type { NextCheckInput } from './lifecycle/next-check.ts';
export { deriveWorkItems } from './lifecycle/work-items.ts';
export type {
  DerivedWorkItem,
  WorkItemAttempt,
  WorkItemInput,
  WorkItemMember,
  WorkItemSession,
} from './lifecycle/work-items.ts';
// @wp-end WP-28

// @wp-begin WP-29
// @wp-end WP-29

// @wp-begin WP-30
export { NotFoundError, QueryRefusal } from './query/index.ts';
export type { NotFoundCode, PathSessionOptions, RefusalCode } from './query/index.ts';
// @wp-end WP-30

// @wp-begin WP-31
// @wp-end WP-31

// @wp-begin WP-32
export {
  INGEST_ERROR_CODES,
  INGEST_ERROR_DETAIL_MAX_CP,
  IngestWriterClosedError,
  SpoolSegmentNotFoundError,
  ingestError,
  isIngestErrorCode,
} from './ingest/errors.ts';
export type { IngestErrorCode, IngestErrorOrigin, IngestErrorRecord } from './ingest/errors.ts';
export {
  CONTENT_WINDOW_MS,
  SOURCE_HOOK,
  emptyDuplicateCounts,
  judgeHookRow,
  layerOfSilentInsert,
  totalDuplicates,
} from './ingest/dedupe.ts';
export type { DedupeLookup, DedupeVerdict, DuplicateCounts, DuplicateLayer } from './ingest/dedupe.ts';
export { createIngestWriter, envelopeItem } from './ingest/writer.ts';
export type {
  CursorUpdate,
  IngestBatch,
  IngestItem,
  IngestWriter,
  IngestWriterHandle,
  IngestWriterOptions,
  IngestWriterStats,
  RowWrite,
} from './ingest/writer.ts';
export { readRouteFile, removeRouteFile, routeFilePath, routeOf, writeRouteFile } from './ingest/routes-file.ts';
export type { RouteInstance, RouteState, RouteWriteOptions } from './ingest/routes-file.ts';
export {
  hourEndOf,
  isSegmentName,
  listSegments,
  retentionExpired,
  sealDecision,
  segmentNameOf,
} from './ingest/spool/segments.ts';
export type { SealInput, SegmentFile, SegmentListing } from './ingest/spool/segments.ts';
export { applySpoolReplay, planSpoolReplay } from './ingest/spool/replay.ts';
export type { SpoolReplayPlan, SpoolReplaySegment } from './ingest/spool/replay.ts';
export { createSpoolDrainer } from './ingest/spool/spool-drainer.ts';
export type { SpoolDrainer, SpoolDrainerOptions, SpoolStats } from './ingest/spool/spool-drainer.ts';
// @wp-end WP-32

// @wp-begin WP-33
export { clipText, countEntries, displayEntries, recordTimestamp } from './transcript/entries.ts';
export type { DisplayEntry } from './transcript/entries.ts';
export { INDEX_CHUNK_BYTES, TranscriptError, createEntryIndexService } from './transcript/index-service.ts';
export type {
  EntryIndexOptions,
  EntryIndexResult,
  EntryIndexService,
  TranscriptErrorCode,
} from './transcript/index-service.ts';
export { createTranscriptQueryPart, createTranscriptWindowService } from './transcript/window.ts';
export type {
  TranscriptLocateRequest,
  TranscriptWindowQueries,
  TranscriptWindowRequest,
  TranscriptWindowService,
  TranscriptWindowServiceOptions,
} from './transcript/window.ts';
// @wp-end WP-33

// @wp-begin WP-34
// @wp-end WP-34

// @wp-begin WP-35
// @wp-end WP-35

// @wp-begin WP-37
// @wp-end WP-37

// @wp-begin WP-38
// @wp-end WP-38

// @wp-begin WP-40
// @wp-end WP-40

// @wp-begin WP-41
// @wp-end WP-41

// @wp-begin WP-57
// @wp-end WP-57

// @wp-begin WP-58
// @wp-end WP-58

// @wp-begin WP-59
// @wp-end WP-59

// @wp-begin WP-60
// @wp-end WP-60

// @wp-begin WP-61
// @wp-end WP-61

// @wp-begin WP-62
// @wp-end WP-62

// @wp-begin WP-63
// @wp-end WP-63
