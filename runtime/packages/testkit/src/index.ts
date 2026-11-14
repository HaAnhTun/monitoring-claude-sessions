export { FIXTURE_MARKER_TEXT, makeTempDir, useTempDirs, writeFixtureMarker, type TempDir } from './temp.ts';
export { VITEST_PORTS, allocatePort, assertPortClosed, type PortRange } from './ports.ts';
export { eventLoopLagProbe, waitFor } from './wait.ts';
export { FIXTURE_EPOCH_MS, FakeClock } from './clock.ts';
export { killAllTracked, runCli, spawnTracked, type TrackedProcess } from './processes.ts';
export { hermeticEnv, makeJunction, spawnImpostor, startInstance, type StartedInstance } from './isolation.ts';
export { httpRequest, readSse } from './http.ts';
export { CANARY, scanFilesFor, scanForCanaries } from './canary.ts';
export { TranscriptBuilder, bigTranscript, type UsageFixture } from './transcript.ts';
export { buildClaudeHome, type ClaudeHome, type SessionSpec } from './claude-home.ts';
export { hookPayload, runHookHandler, type HookEventName, type RunHookOptions } from './hooks.ts';
export { buildRepo, buildTaskWorkspace, snapshotTree } from './workspace.ts';
export { buildDemo, type DemoLetter, type DemoOptions, type DemoResult, type DemoSession } from './demo.ts';
export { FILE_HOLDER_SKIP_REASON, holdFileOpen, type FileHolder } from './file-holder.ts';
export {
  BRACKETED_PASTE_ON,
  BURST_DEFAULT_LINE_BYTES,
  BURST_MAX_KIB,
  BURST_MIN_LINE_BYTES,
  ENVSCAN_MIN_NEEDLE,
  FAKE_BANNER,
  FAKE_CRASH_CODE,
  FAKE_DEFAULT_SEED,
  FAKE_PROMPT,
  HOSTILE_LONG_LINE_BYTES,
  SAFE_ENV_NAMES,
  TAG,
  UTF8_UNIT,
  burstExpected,
  burstLine,
  coalesceStdin,
  fakeSessionId,
  fnv1a32,
  fnv1a32Hex,
  parseFakeLog,
  parseReady,
  type BurstExpectation,
  type FakeLogEntry,
  type FakeLogEvent,
  type FakeReady,
  type FakeTag,
} from './fake-claude/protocol.ts';
export {
  FAKE_CLAUDE_FILE,
  assertClaudeFree,
  claudeFreePath,
  fakeClaudeInvocation,
  fakeClaudeLauncher,
  fakeClaudeScriptPath,
  installFakeClaude,
  terminalEnv,
  writeFakeClaudeShim,
  type FakeClaudeFlavour,
  type FakeClaudeInstall,
  type InstallFakeClaudeOptions,
} from './fake-claude/install.ts';
export {
  registryDir,
  registryEntryJson,
  registryFile,
  removeRegistryEntry,
  rewriteRegistryEntry,
  writeRegistryEntry,
  writeRegistryFile,
  type RegistryEntryFixture,
  type RegistryPatch,
  type WriteRegistryOptions,
} from './registry.ts';
export {
  DA_INDEX_MAX_BYTES,
  DA_META_MAX_BYTES,
  DA_VARIANTS,
  daMemoryDir,
  daSlug,
  daTimestamp,
  daVariantFolders,
  writeDaMemory,
  type DaFolderSpec,
  type DaMemoryFixture,
  type DaMemorySpec,
  type DaMetaMode,
  type DaVariant,
} from './da-memory.ts';
export {
  RawWsClient,
  TERMINAL_SUBPROTOCOL_V1,
  WS_GUID,
  acceptKeyFor,
  openTerminalSocket,
  type ConnectOptions,
  type FrameSpec,
  type OpenedTerminalSocket,
  type WsMessage,
} from './terminal/ws-client.ts';
export { TerminalOutput, stripAnsi } from './terminal/output.ts';
export {
  PTY_SKIP_REASON_OFF_WINDOWS,
  describePtyTests,
  ptySupport,
  scaled,
  type DescribePtyDeps,
  type PtySupportDeps,
  type PtySupportResult,
} from './terminal/pty-support.ts';
export { MIN_MARKER_LENGTH, findProcesses, type FoundProcess } from './terminal/process-scan.ts';

// @wp-begin WP-55
// @wp-end WP-55
