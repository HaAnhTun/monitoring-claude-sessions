// The closed list of documented environment variables (01 section 2.10, registry 6.3). `tests/tooling/env-vars.test.ts`
// (WP-23) greps the sources for `MCS_*` names and fails on a name that is not listed here; a listed name whose reader
// files do not exist yet is reported `pending`.
//
// There is no `MCS_E2E_PORT` (I-27, N-02): Playwright instances start on ports from the testkit `allocatePort`.
// Non-MCS names that the registry mentions (`VITEST`, `LOCALAPPDATA`, `NO_COLOR`, ...) are not configuration of this
// product and are not part of this constant; `CLAUDE_CONFIG_DIR` is, as 01 2.10 lists it.

export type EnvScope = 'runtime' | 'test' | 'dev';

export interface DocumentedEnvVar {
  readonly name: string;
  readonly scope: EnvScope;
  /** Files that read the variable, relative to the skill root, forward slashes. */
  readonly readers: readonly string[];
}

const TEST_HOOKS = 'runtime/packages/engine/src/runtime/test-hooks.ts';

export const DOCUMENTED_ENV_VARS: readonly DocumentedEnvVar[] = [
  { name: 'MCS_LOG_LEVEL', scope: 'runtime', readers: ['runtime/packages/engine/src/config/resolve.ts'] },
  {
    name: 'MCS_HOOK_DISABLE',
    scope: 'runtime',
    readers: ['runtime/packages/cli/src/hook.ts', 'runtime/packages/engine/src/external/launch-claude.ts'],
  },
  { name: 'MCS_HOME', scope: 'runtime', readers: ['runtime/packages/shared/src/protocol/routes.ts'] },
  {
    name: 'CLAUDE_CONFIG_DIR',
    scope: 'runtime',
    readers: ['runtime/packages/engine/src/ingest/transcripts/discovery.ts'],
  },
  { name: 'MCS_FS_WATCH', scope: 'runtime', readers: ['runtime/packages/engine/src/platform/watch-hint.ts'] },
  // Accepted and ignored since the bundle-first launcher (ADR 0062 item 4): there is nothing to bootstrap; the cleanup area removes it.
  {
    name: 'MCS_LAUNCHER_NO_BOOTSTRAP',
    scope: 'runtime',
    readers: ['skills/monitoring-claude-sessions/scripts/mcs.mjs'],
  },
  // `bundle` or `dev`: forces the launcher's runtime (default: the bundle when it exists, else a checkout's dist).
  { name: 'MCS_LAUNCHER_MODE', scope: 'runtime', readers: ['skills/monitoring-claude-sessions/scripts/mcs.mjs'] },
  {
    name: 'MCS_DEBUG',
    scope: 'runtime',
    readers: ['runtime/packages/cli/src/main.ts', 'skills/monitoring-claude-sessions/scripts/mcs.mjs'],
  },
  {
    name: 'MCS_TEST',
    scope: 'test',
    readers: [TEST_HOOKS, 'runtime/packages/engine/src/hooks/installer/apply.ts'],
  },
  { name: 'MCS_TEST_IGNORE_CONTROL', scope: 'test', readers: [TEST_HOOKS] },
  { name: 'MCS_TEST_BOOT_HANG', scope: 'test', readers: [TEST_HOOKS] },
  { name: 'MCS_TEST_INIT_CRASH', scope: 'test', readers: [TEST_HOOKS] },
  // Not a production hook: the number of generated cases per scenario template (default 500) of the lifecycle property tests;
  // 1 replays one failing seed together with MCS_TEST_SEED. Only that test file reads it.
  { name: 'MCS_TEST_CASES', scope: 'test', readers: ['runtime/packages/engine/src/lifecycle/properties.test.ts'] },
  { name: 'MCS_PERF_FACTOR', scope: 'test', readers: ['runtime/packages/cli/test/hook.int.test.ts'] },
  { name: 'MCS_E2E_CLAUDE', scope: 'test', readers: ['runtime/packages/engine/test/real-provider.int.test.ts'] },
  { name: 'MCS_DEV_API', scope: 'dev', readers: ['runtime/packages/web/vite.config.ts'] },
  { name: 'MCS_WEB_DEV_PORT', scope: 'dev', readers: ['runtime/packages/web/vite.config.ts'] },
  { name: 'MCS_WEB_PREVIEW_PORT', scope: 'dev', readers: ['runtime/packages/web/vite.config.ts'] },
  { name: 'MCS_BUILD_ID', scope: 'dev', readers: ['runtime/packages/web/vite.config.ts'] },
];
