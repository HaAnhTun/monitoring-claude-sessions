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
// @wp-end WP-17

// @wp-begin WP-19
// @wp-end WP-19

// @wp-begin WP-22
// @wp-end WP-22

// @wp-begin WP-25
// @wp-end WP-25

// @wp-begin WP-28
// @wp-end WP-28

// @wp-begin WP-29
// @wp-end WP-29

// @wp-begin WP-30
// @wp-end WP-30

// @wp-begin WP-31
// @wp-end WP-31

// @wp-begin WP-32
// @wp-end WP-32

// @wp-begin WP-33
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
