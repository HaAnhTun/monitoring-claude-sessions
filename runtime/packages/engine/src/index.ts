export * from './json/index.ts';

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
export {
  TimeFormatError,
  parseTimeWithFormat,
  timeFieldsToEpochMs,
  validateTimeFormat,
} from './platform/time-format.ts';
export type { TimeFields } from './platform/time-format.ts';
export {
  PYTHON_SYNTAX_HINT,
  RegexCompileError,
  applyLabelTemplate,
  compileRegex,
  pythonSyntaxHint,
  tryCompileRegex,
} from './regex/index.ts';
export type { CompiledRegex, RegexContext, RegexMatch, TryCompileResult } from './regex/index.ts';
export { createWatchHint } from './platform/watch-hint.ts';
export type { WatchHint, WatchHintOptions } from './platform/watch-hint.ts';
export { MutexTimeoutError, acquireMutex, mutexName, tryAcquireMutex } from './platform/mutex.ts';
export type { AcquireOptions, ProcessMutex } from './platform/mutex.ts';
export { hasRuntimeMarker, listRuntimeProcesses } from './platform/markers.ts';
export type { RuntimeProcess } from './platform/markers.ts';

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

export {
  checkSchemaVersion,
  defaultRuntimeDir,
  defaultSkillDir,
  getEntry,
  loadSkillDefaults,
  parseLegacyConfig,
  readConfigJson,
  readOptionalConfigJson,
  schemaVersionOf,
  skillDirOfRuntimeDir,
  SKILL_FOLDER_NAME,
  LegacyConfigSchema,
} from './config/defaults.ts';
export type { LegacyConfig, SkillDefaults } from './config/defaults.ts';
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

export {
  appendWorkspaceFile,
  assertNotLink,
  compareAndDelete,
  isLink,
  isMissingFileError,
  readJsonFile,
  readTextTail,
  readTextUniversal,
  writeJsonFile,
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
  instanceFileToDoc,
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

export { createQueries, registerQueryPart } from './query/index.ts';
export type { AuditQueries, AuditReader, EngineQueries, Queries, QueryDeps, QueryPart } from './query/index.ts';
export { formatCommand, instanceCommands } from './ops/commands.ts';
export type { InstanceCommandInput } from './ops/commands.ts';

export * as opsLifecycle from './ops/lifecycle.ts';
export {
  controlAddressOf,
  createProbe,
  httpGet,
  identifyInstance,
  isLiveState,
  isLoopbackBase,
  isRunningState,
  jsonBodyOf,
  probeInstance,
  readStateSnapshot,
  requestControl,
} from './ops/probe.ts';
export type {
  AddressHost,
  ControlAttempt,
  ControlReply,
  HttpAttempt,
  HttpReply,
  IdentifyResponse,
  ProbeDeps,
  ProbeOptions,
  ProbeResult,
  ProbeState,
  StateSnapshot,
} from './ops/probe.ts';
export type {
  LifecycleCommand,
  LifecycleDeps,
  ProcessApi,
  RestartResult,
  ServeInput,
  ServeResult,
  SessionLike,
  SessionSummaryCounts,
  SpawnDetachedFn,
  SpawnForegroundFn,
  StartInput,
  StartOutcome,
  StartResult,
  StatusReport,
  StatusResult,
  StopInput,
  StopOutcome,
  StopResult,
  TargetInput,
  VerifyResult,
} from './ops/lifecycle.ts';

// @wp-begin WP-22
export * as opsInstances from './ops/instances.ts';
export * as opsDoctor from './ops/doctor.ts';
export type { InstancesSeams, ListInput, ListResult, RepairIdentityResult, RepairInput } from './ops/instances.ts';
export type { DoctorCheckProvider, DoctorDeps, DoctorInput } from './ops/doctor.ts';
export type { CheckEnv, DoctorSeams } from './ops/doctor-checks.ts';
// @wp-end WP-22

export { DISABLE_ALL_HOOKS_SETTINGS, claudeArgsWithoutHooks } from './external/launch-claude.ts';
export type { ClaudeLaunch } from './external/launch-claude.ts';

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

// @wp-begin WP-29
export { CompletionTargetError, explainCompletion, validateCompletionTarget } from './lifecycle/completion.ts';
export type {
  AttemptRowRef,
  CompletionCandidate,
  CompletionDerivation,
  CompletionLookup,
  CompletionTarget,
  CompletionTargetCode,
} from './lifecycle/completion.ts';
export type { CompletionQueries } from './query/completion.ts';
// @wp-end WP-29

export { NotFoundError, QueryRefusal } from './query/index.ts';
export type { NotFoundCode, PathSessionOptions, RefusalCode } from './query/index.ts';

export { mergeServerErrors } from './query/errors.ts';
export { registerMetricProvider } from './query/overview.ts';
export type { MetricProvider, MetricProviderInput } from './query/overview.ts';

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

export {
  detectTranscriptsDir,
  discoverSession as discoverTranscriptSession,
  discoverTranscripts,
  nodeDiscoveryFs,
  projectsRoot,
  readAgentMeta,
  readCustomTitle,
  readWorkflowStatus,
  sanitizeProjectName,
} from './ingest/transcripts/discovery.ts';
export type {
  AgentMeta,
  DiscoveredFile,
  DiscoveredSession as DiscoveredTranscriptSession,
  DiscoveryCounters,
  DiscoveryFs,
  DiscoveryPolicy,
  DiscoveryResult,
  EntryStat,
  WorkflowStatusFile,
} from './ingest/transcripts/discovery.ts';
export {
  CLASSIFY_LINE_LIMIT,
  classify,
  compileSessionRules,
  realFirstPrompt,
  userTexts,
} from './ingest/transcripts/classify.ts';
export type {
  Classification,
  ClassifyOptions,
  CompiledRule,
  HeadRecord,
  SessionRule,
} from './ingest/transcripts/classify.ts';
export { DEFAULT_IMPORT_SETTINGS, createTranscriptImporter } from './ingest/transcripts/importer.ts';
export type {
  DiscoverySummary,
  ImportPhase,
  ImportSettings,
  ImportWork,
  SliceOutcome,
  TranscriptImporter,
  TranscriptImporterOptions,
  TranscriptStats,
} from './ingest/transcripts/importer.ts';
export { createImportScheduler, pickWork } from './ingest/transcripts/scheduler.ts';
export type {
  ImportScheduler,
  ImportSchedulerOptions,
  ImporterPort,
  SchedulerStats,
  SpoolPort,
  StepResult,
} from './ingest/transcripts/scheduler.ts';
export { readEntryText } from './ingest/transcripts/entry-text.ts';
export type { EntryTextFailure, EntryTextOptions, TranscriptRef } from './ingest/transcripts/entry-text.ts';

export {
  IngestIdleTimeoutError,
  createIngestService,
  importSettingsOf,
  lifecycleCfgOf,
  publishRouteFile,
  sessionRulesOf,
} from './ingest/service.ts';
export type { IngestService, IngestServiceOptions, IngestStats } from './ingest/service.ts';
export { createLifecycleSweeper } from './lifecycle/sweeper.ts';
export type { LifecycleSweeper, SweeperContext, SweeperOptions, SweeperWriter } from './lifecycle/sweeper.ts';
export { nodeExternalFs } from './external/fs.ts';
export type { ExternalFs, ExternalPoll } from './external/fs.ts';
export { createRegistryReader, REGISTRY_REPEAT_MS } from './external/registry.ts';
export type { RegistryEvent, RegistryReader, RegistryReaderOptions } from './external/registry.ts';
export { createJobsReader } from './external/jobs.ts';
export type { JobEvent, JobsReader, JobsReaderOptions } from './external/jobs.ts';
export { pidEvents } from './external/pid.ts';
export type { PidEvent, PidTarget } from './external/pid.ts';
export {
  bindHealthSources,
  computeIngestHealth,
  createIngestHealthEvaluator,
  healthContextOf,
  ingestHealthEvaluatorOf,
  parseHandlerLog,
  percentile95,
  thresholdsOf,
} from './health/ingest-health.ts';
export type {
  HealthContext,
  HealthSources,
  HealthThresholds,
  IngestHealthEvaluator,
  IngestHealthFacts,
  WriterFigures,
} from './health/ingest-health.ts';
export {
  activeAlertConditions,
  createAlertInputTracker,
  emitAlertInputs,
  subscribeAlertInputs,
} from './health/alert-inputs.ts';
export type {
  AlertInput,
  AlertInputCode,
  AlertInputListener,
  AlertInputSnapshot,
  AlertInputTracker,
  AlertPayload,
} from './health/alert-inputs.ts';
export { bindActivityFlush, createDbScheduler, createDbSchedulerWith } from './maintenance/schedule.ts';
export type {
  DbScheduler,
  DbSchedulerHandle,
  HealthRefresher,
  SchedulerContext,
  SchedulerSeams,
} from './maintenance/schedule.ts';

// @wp-begin WP-37
export {
  HOOK_MARKER,
  buildEntry,
  desiredEntries,
  hooksFailed,
  isOurs,
  ourHandlers,
  planHooks,
  sameHandler,
  unifiedDiff,
} from './hooks/installer/plan.ts';
export type { EntryContext, HookCommandEntry, HooksOp, HooksPlan } from './hooks/installer/plan.ts';
export {
  BACKUPS_KEPT,
  assertNotRealInTest,
  assertScopeAllowed,
  backupFolder,
  displayPath,
  isTestMode,
  realSettingsIo,
  settingsPathFor,
  writeBackup,
} from './hooks/installer/settings-io.ts';
export type {
  BackupInput,
  GuardInput,
  GuardTarget,
  SettingsIo,
  SettingsPathInput,
  SettingsSnapshot,
} from './hooks/installer/settings-io.ts';
export { LOCK_TIMEOUT_MS, MAX_ATTEMPTS, applyHooks, hooksWarnings } from './hooks/installer/apply.ts';
export type {
  ApplyHooksInput,
  HooksChangeInput,
  HooksOutcome,
  HooksSeams,
  UninstallHooksInput,
} from './hooks/installer/apply.ts';
export { uninstallHooks } from './hooks/installer/uninstall.ts';
export {
  EMPTY_MANIFEST,
  MANIFEST_VERSION,
  findInstall,
  hasInstall,
  hooksFolder,
  installsOf,
  manifestKey,
  manifestPath,
  readManifest,
  writeManifest,
} from './hooks/installer/manifest.ts';
export type { HookInstallRecord, HooksManifest, ManifestRead } from './hooks/installer/manifest.ts';
export {
  HOOK_SCRIPT_NAME,
  foreignImports,
  hookScriptState,
  inspectHookScript,
  installHookScript,
  planHookScript,
  readHookSource,
  removeHookScript,
  stableScriptPath,
} from './hooks/installer/script-copy.ts';
export type {
  HookScriptCopy,
  HookScriptInput,
  HookScriptPlan,
  HookScriptSource,
} from './hooks/installer/script-copy.ts';
// @wp-end WP-37

// @wp-begin WP-38
export * as opsHooks from './ops/hooks.ts';
export type {
  HooksInstallInput,
  HooksOpDeps,
  HooksStatusInput,
  HooksTargetInput,
  HooksToggleInput,
  HooksToggleResult,
  HooksUninstallInput,
  HooksVerifyInput,
} from './ops/hooks.ts';
export * as opsIngest from './ops/ingest.ts';
export type { ReplayDeps, ReplayInput, ReplayResult, ReplaySegment } from './ops/ingest.ts';
export { hooksStatus } from './hooks/installer/status.ts';
export type {
  HooksScanTarget,
  HooksStatusInput as HooksStatusEngineInput,
  StatusSeams,
} from './hooks/installer/status.ts';
export { verifyHooks } from './hooks/installer/verify.ts';
export type { VerifyHooksInput, VerifyInstance, VerifySeams } from './hooks/installer/verify.ts';
// @wp-end WP-38

// @wp-begin WP-40
export { DEFAULT_TIME_FORMAT, MAX_MATCH_CODE_POINTS, parseChainLine } from './panels/attempts/parse.ts';
export type { ChainEnd, ChainLine, ChainPatterns, ChainStart } from './panels/attempts/parse.ts';
export { OPEN_EVIDENCE, externalState, supersededEvidence } from './panels/attempts/state.ts';
export {
  MATCH_MAX_DELTA_MS as ATTEMPT_MATCH_MAX_DELTA_MS,
  MATCH_MIN_DELTA_MS as ATTEMPT_MATCH_MIN_DELTA_MS,
  chooseCandidate as chooseAttemptCandidate,
  matchRuns as matchAttemptRuns,
} from './panels/attempts/match.ts';
export type {
  Assignment as AttemptMatch,
  MatchOptions as AttemptMatchOptions,
  MatchRun as AttemptMatchRun,
} from './panels/attempts/match.ts';
export {
  closeEvidenceState,
  createEvidenceState,
  planEvidence,
  publishEvidence,
  stampEvents,
} from './panels/attempts/evidence.ts';
export type {
  EvidencePlan,
  EvidenceState,
  EvidenceWriter,
  PlanInput,
  PlannedAttempt,
  PublishDeps,
} from './panels/attempts/evidence.ts';
export {
  ATTEMPTS_LIMITS,
  attemptsSettings,
  closeAttemptsState,
  configHash as attemptsConfigHash,
  createAttemptsState,
  tickAttempts,
} from './panels/attempts/ingest.ts';
export type {
  AttemptsDeps,
  AttemptsLimits,
  AttemptsSettings,
  AttemptsState,
  AttemptsTickContext,
} from './panels/attempts/ingest.ts';
export { createAttemptsStore, readAttemptsPanel } from './panels/attempts/repo.ts';
export type { AttemptsPanelContext, AttemptsStore } from './panels/attempts/repo.ts';
// @wp-end WP-40

// @wp-begin WP-41
export {
  ATTEMPTS_DEFAULT_LIMIT,
  ATTEMPTS_MAX_LIMIT,
  PanelServiceClosedError,
  createPanelService,
} from './panels/service.ts';
export type { PanelSamplers, PanelServiceContext, PanelServiceOptions } from './panels/service.ts';
// @wp-end WP-41

// @wp-begin WP-57
export { SearchBusyError, createSearchQueryPart, createSearchService } from './search/service.ts';
export type { SearchQueries, SearchService, SearchServiceOptions, SearchStats } from './search/service.ts';
export { buildPrefilter } from './search/scan.ts';
// @wp-end WP-57

// @wp-begin WP-58
export { COST_NOTE, matchesModel, resolvePrice } from './analytics/cost.ts';
export { bucketStart } from './analytics/series.ts';
// @wp-end WP-58

// @wp-begin WP-59
export { evaluate as evaluateAlertRule } from './alerts/evaluator.ts';
export type { AlertFacts, AlertResult, Downtime, ScopedResult, SessionRef } from './alerts/evaluator.ts';
export { effectiveRules } from './alerts/rules.ts';
export type { EffectiveRule, EffectiveRules } from './alerts/rules.ts';
export { alertContextOf, createAlertComponents, createAlertService } from './alerts/service.ts';
export type { AlertService, AlertServiceContext, AlertServiceOptions, ApplyOutcome } from './alerts/service.ts';
// @wp-end WP-59

// @wp-begin WP-60
export {
  assertExportable,
  createLineSink,
  exportInstance,
  projectPseudonym,
  redactLine,
} from './maintenance/export.ts';
export type { ExportContext, ExportOptions, ExportOutput, LineSink } from './maintenance/export.ts';
export { applyRetention, runBookkeepingRetention } from './maintenance/retention.ts';
export type {
  ApplyRetentionOptions,
  BookkeepingOptions,
  BookkeepingResult,
  RetentionPlan,
  RetentionPolicy,
  RetentionResult,
  RetentionSessionSample,
  RetentionSettings,
} from './maintenance/retention.ts';
export { bindScheduledJob, boundRun } from './maintenance/schedule.ts';
export type { ScheduledRun } from './maintenance/schedule.ts';
// @wp-end WP-60

// @wp-begin WP-61
export { openInstanceReader, readerErrorOfCode, readerReasonOf } from './reader/open.ts';
export type { InstanceReader, ReaderDeps, ReaderOutput } from './reader/open.ts';
export { createApiReader, loopbackStream } from './reader/api-reader.ts';
export type { ApiHttpGet, ApiReaderOptions, ApiStreamOpen, StreamAttempt, StreamedReply } from './reader/api-reader.ts';
export { openDbReader, readerFailureOf } from './reader/db-reader.ts';
export type { DbReaderOptions } from './reader/db-reader.ts';
export * as opsData from './ops/data.ts';
export type {
  DataDeps,
  ErrorsFlags,
  ErrorsInput,
  SessionsListFlags,
  SessionsListInput,
  SessionsShowInput,
  SessionsShowOutcome,
  UsageFlags,
  UsageInput,
  UsageRequest,
} from './ops/data.ts';
export { httpGetWithHeaders } from './ops/probe.ts';
export type { HttpFullAttempt, HttpFullReply } from './ops/probe.ts';
// @wp-end WP-61

// @wp-begin WP-108
export { checkExportPath, exportToFile, isWindowsReservedName } from './ops/export-file.ts';
export type { ExportFileOptions, ExportFileResult, ExportPathOptions, ExportTarget } from './ops/export-file.ts';
export type { CompletionFlags, CompletionInput, CompletionReport, ExportFlags } from './ops/data.ts';
// @wp-end WP-108

// @wp-begin WP-62
export * as opsBackup from './ops/backup.ts';
export type {
  BackupCreateInput,
  BackupListInput,
  BackupOpDeps,
  BackupReason,
  BackupRestoreInput,
  ListedBackup,
  MadeBackup,
} from './ops/backup.ts';
export * as opsInstanceUpgrade from './ops/instance-upgrade.ts';
export type { DbMigrateInput, DbRebuildInput, UpgradeDeps, UpgradeInput, UpgradeStep } from './ops/instance-upgrade.ts';
// @wp-end WP-62

// @wp-begin WP-85
export { PROJECT_NAME_MAX, claudeHomeOf, projectFolderName } from './ingest/transcripts/discovery.ts';
export type { DetectOptions } from './ingest/transcripts/discovery.ts';
export { recentSessionsOf } from './ingest/transcripts/recent-sessions.ts';
export type { RecentSession, RecentSessionsLog } from './ingest/transcripts/recent-sessions.ts';
export { refreshRouteFile } from './ingest/route-refresh.ts';
export type { RouteRefreshContext } from './ingest/route-refresh.ts';
// @wp-end WP-85

// @wp-begin WP-82
export {
  BUILD_STAMP_FILE,
  BUNDLE_CLI_FILE,
  BUNDLE_HOOK_FILE,
  BUNDLE_SERVER_FILE,
  layoutOfModule,
  layoutOfRuntimeDir,
} from './platform/layout.ts';
export type { LayoutFs, RuntimeLayout, RuntimeLayoutMode } from './platform/layout.ts';
export { BUNDLE_SERVER_ENTRY, RUNTIME_ENTRIES, RUNTIME_ENTRY } from './platform/markers.ts';
export { defaultMigrationsDir } from './db/migrations.ts';
// @wp-end WP-82

// @wp-begin WP-95
export * as opsMigrate from './ops/migrate-workspace.ts';
export type { MigrateDeps, MigrateInput, PatternStep, WorkspaceMigrationReport } from './ops/migrate-workspace.ts';
// @wp-end WP-95

// @wp-begin WP-100
export { bindHealthGauges, healthGaugesOf } from './runtime/context.ts';
export type { HealthGaugeSources, HealthGaugeValues, SearchGauge } from './runtime/context.ts';
// @wp-end WP-100

// @wp-begin WP-102
export { ChangesRepo, type ChangeRow } from './db/repos/changes.ts';
// @wp-end WP-102

// @wp-begin WP-105
export { CONFIG_KEY_SUPPORT, configKeyWarnings } from './config/key-support.ts';
export type {
  ConfigKeyInput,
  ConfigKeyOptions,
  ConfigKeyWarning,
  ConfigKeyWarningCode,
  KeyStatus,
  KeySupport,
} from './config/key-support.ts';
// @wp-end WP-105

// @wp-begin WP-107
export * as opsCleanup from './ops/cleanup.ts';
export type { CleanupDeps, CleanupInput } from './ops/cleanup.ts';
export type { ConfigMigrateDeps, ConfigMigrateInput } from './ops/config.ts';
// @wp-end WP-107

// @wp-begin WP-141
export * as opsDiagnostics from './ops/diagnostics.ts';
export type {
  DiagnosticsDeps,
  DiagnosticsInput,
  DiagnosticsResult,
  DiagnosticsSeams,
  Scrubber,
} from './ops/diagnostics.ts';
// @wp-end WP-141

// @wp-begin CAW-18
export { ACCESS_LIMITS, createAccessService } from './runtime/access-service.ts';
export type {
  AccessLimits,
  AccessMint,
  AccessService,
  AccessServiceOptions,
  AccessSession,
  ExchangeOutcome,
} from './runtime/access-service.ts';
export { createControlTokenSource } from './ops/probe.ts';
export type { ControlTokenSource } from './ops/probe.ts';
// @wp-end CAW-18

// @wp-begin CAW-21
export { spawnDetachedVisible } from './platform/exec.ts';
export { appWindowArgs, findAppBrowser, openLoginUrl } from './platform/browser.ts';
export type { AppBrowser, BrowserKind, BrowserSeams, OpenFailure, OpenOutcome } from './platform/browser.ts';
export {
  USER_DEFAULT_PORT,
  USER_INSTANCE_NAME,
  USER_INSTANCE_SLUG,
  USER_ROOT_DIRNAME,
  isUserRoot,
  userBrowserProfileDirOf,
  userInstanceDirOf,
  userOpContext,
  userRootOf,
} from './user-instance/paths.ts';
export { ensureUserInstance } from './user-instance/ensure.ts';
export type { EnsureUserInstanceDeps, EnsureUserInstanceResult } from './user-instance/ensure.ts';
export {
  AUTOSTART_SHORTCUT_NAME,
  autostartStatus,
  disableAutostart,
  enableAutostart,
  refreshAutostartIfEnabled,
} from './ops/autostart.ts';
export type { AutostartDeps, AutostartRefresh, AutostartTarget } from './ops/autostart.ts';
// @wp-end CAW-21
