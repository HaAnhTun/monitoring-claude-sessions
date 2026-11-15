// The closed list of documented environment variables (01 section 2.10, registry 6.3). `tests/tooling/env-vars.test.ts`
// (WP-23) greps the sources for `MCS_*` names and fails on a name that is not listed here; a listed name whose reader
// files do not exist yet is reported `pending`.
//
// There is no `MCS_E2E_PORT` (I-27, N-02): Playwright instances start on ports from the testkit `allocatePort`.
// Non-MCS names that the registry mentions (`VITEST`, `LOCALAPPDATA`, `NO_COLOR`, ...) are not configuration of this
// product and are not part of this constant; `CLAUDE_CONFIG_DIR` is, as 01 2.10 lists it.

import type { EnvLike } from './protocol/routes.ts';

export type EnvScope = 'runtime' | 'test' | 'dev';

export interface DocumentedEnvVar {
  /** Canonical name: `CAW_*` for a runtime variable (once flipped), the existing `MCS_*` family for test and dev ones. */
  readonly name: string;
  /**
   * The `MCS_*` spelling that is still read next to the canonical one (runtime scope only, `MCS_` plus the same suffix).
   * Readers go through `readEnv` of `protocol/env-names.ts`; the canonical name wins when both are defined.
   */
  readonly legacyName?: string;
  readonly scope: EnvScope;
  /** Files that read the variable, relative to the skill root, forward slashes. */
  readonly readers: readonly string[];
}

const TEST_HOOKS = 'runtime/packages/engine/src/runtime/test-hooks.ts';
const AUTOSTART = 'runtime/packages/engine/src/ops/autostart.ts';
const BATCH_FILES = ['start.bat', 'stop.bat', 'install-skill.bat'];
const QA_CONFIG = 'runtime/packages/web/e2e/qa/global-setup.ts';
const QA_PLAYWRIGHT = 'runtime/packages/web/e2e/qa/playwright.config.ts';

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
  // `bundle` or `dev`: forces the launcher's runtime (default: the bundle when it exists, else a checkout's dist).
  { name: 'MCS_LAUNCHER_MODE', scope: 'runtime', readers: ['skills/monitoring-claude-sessions/scripts/caw.mjs'] },
  {
    name: 'MCS_DEBUG',
    scope: 'runtime',
    readers: ['runtime/packages/cli/src/main.ts', 'skills/monitoring-claude-sessions/scripts/caw.mjs'],
  },
  {
    name: 'MCS_TEST',
    scope: 'test',
    readers: [TEST_HOOKS, 'runtime/packages/engine/src/hooks/installer/apply.ts'],
  },
  { name: 'MCS_TEST_IGNORE_CONTROL', scope: 'test', readers: [TEST_HOOKS] },
  { name: 'MCS_TEST_BOOT_HANG', scope: 'test', readers: [TEST_HOOKS] },
  { name: 'MCS_TEST_INIT_CRASH', scope: 'test', readers: [TEST_HOOKS] },
  // The terminal and user-instance hooks (CAW): a fake terminal host instead of the real pseudo console, a recorder instead
  // of opening a file in the shell, and a fixed answer instead of the Windows folder dialog.
  { name: 'MCS_TEST_FAKE_TERMINALS', scope: 'test', readers: [TEST_HOOKS] },
  { name: 'MCS_TEST_OPEN_FILE', scope: 'test', readers: [TEST_HOOKS] },
  { name: 'MCS_TEST_FOLDER_PICKER', scope: 'test', readers: [TEST_HOOKS] },
  // Child-only: the values of the autostart shortcut, set in the environment of the one PowerShell child that makes or reads the
  // `.lnk` (06 2.7). The scripts are constants and read these names; nothing reads them from the environment of the runtime.
  { name: 'CAW_LNK_PATH', scope: 'runtime', readers: [AUTOSTART] },
  { name: 'CAW_LNK_TARGET', scope: 'runtime', readers: [AUTOSTART] },
  { name: 'CAW_LNK_ARGS', scope: 'runtime', readers: [AUTOSTART] },
  { name: 'CAW_LNK_WORKDIR', scope: 'runtime', readers: [AUTOSTART] },
  { name: 'CAW_LNK_DESC', scope: 'runtime', readers: [AUTOSTART] },
  // The batch files at the repository root (06 4): the Node to run instead of the one found on PATH, and no pause or prompt
  // (scripts and tests; stop.bat then exits 3 when terminals are live).
  { name: 'CAW_NODE_PATH', scope: 'runtime', readers: BATCH_FILES },
  { name: 'CAW_NO_PROMPT', scope: 'runtime', readers: BATCH_FILES },
  // Not a production hook: the number of generated cases per scenario template (default 500) of the lifecycle property tests;
  // 1 replays one failing seed together with MCS_TEST_SEED. Only that test file reads it.
  { name: 'MCS_TEST_CASES', scope: 'test', readers: ['runtime/packages/engine/src/lifecycle/properties.test.ts'] },
  { name: 'MCS_PERF_FACTOR', scope: 'test', readers: ['runtime/packages/cli/test/hook.int.test.ts'] },
  { name: 'MCS_E2E_CLAUDE', scope: 'test', readers: ['runtime/packages/engine/test/real-provider.int.test.ts'] },
  // The visual QA tool (WP-122): where the PNGs and index.json go (never inside the repository), the views, viewports, themes,
  // languages and mode to shoot, and the browser channel (default: the installed Chrome; an empty value uses the bundled one).
  { name: 'MCS_SHOTS_DIR', scope: 'test', readers: [QA_CONFIG] },
  { name: 'MCS_SHOTS_VIEWS', scope: 'test', readers: [QA_CONFIG] },
  { name: 'MCS_SHOTS_VIEWPORTS', scope: 'test', readers: [QA_CONFIG] },
  { name: 'MCS_SHOTS_THEMES', scope: 'test', readers: [QA_CONFIG] },
  { name: 'MCS_SHOTS_LOCALES', scope: 'test', readers: [QA_CONFIG] },
  { name: 'MCS_SHOTS_MODE', scope: 'test', readers: [QA_CONFIG] },
  { name: 'MCS_PW_CHANNEL', scope: 'test', readers: [QA_PLAYWRIGHT] },
  { name: 'MCS_DEV_API', scope: 'dev', readers: ['runtime/packages/web/vite.config.ts'] },
  { name: 'MCS_WEB_DEV_PORT', scope: 'dev', readers: ['runtime/packages/web/vite.config.ts'] },
  { name: 'MCS_WEB_PREVIEW_PORT', scope: 'dev', readers: ['runtime/packages/web/vite.config.ts'] },
  { name: 'MCS_BUILD_ID', scope: 'dev', readers: ['runtime/packages/web/vite.config.ts'] },
  // A folder with the `npm pack` tarballs of the native terminal packages (ADR 0082): `npm run bundle` and `bundle:check` stage the
  // native files from it instead of the network (the Docker harness mounts it).
  { name: 'MCS_NATIVE_TARBALLS', scope: 'dev', readers: ['runtime/scripts/native-stage.mjs'] },
];

/**
 * The legacy names that are set in `env` while their canonical name is not: the ones a person should rename. Names only,
 * never values; in registry order. A legacy name that its canonical name overrides is not in use.
 */
export function legacyNamesInUse(env: EnvLike, vars: readonly DocumentedEnvVar[] = DOCUMENTED_ENV_VARS): string[] {
  const found: string[] = [];
  for (const v of vars) {
    if (v.legacyName === undefined) continue;
    if (env[v.legacyName] !== undefined && env[v.name] === undefined) found.push(v.legacyName);
  }
  return found;
}
