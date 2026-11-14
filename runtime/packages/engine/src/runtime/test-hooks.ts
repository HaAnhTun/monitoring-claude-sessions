// The test hooks of 01 2.10 (I-27): production code reads the test variables only through `testHook(name)`, and the
// function answers `undefined` unless the process runs in test mode (`MCS_TEST` is exactly `1`). The names of the three
// hooks live here and nowhere else, so a scan of the production sources for them finds only this file.
//
// Registered for the terminal and the user instance (CAW-06) and wired into `TEST_HOOK_NAMES` by the packages that read
// them: MCS_TEST_FAKE_TERMINALS (scripted terminal sessions), MCS_TEST_OPEN_FILE (records the open-in-shell target) and
// MCS_TEST_FOLDER_PICKER (a fixed answer for the folder dialog).

/** The documented hooks by their short name: T-LC-06 (control ignored), T-LC-08 (boot hangs), T-LC-10 (init crash). */
export const TEST_HOOK_NAMES = ['IGNORE_CONTROL', 'BOOT_HANG', 'INIT_CRASH'] as const;

export type TestHookName = (typeof TEST_HOOK_NAMES)[number];

/** The environment variable behind each hook. */
export const TEST_HOOK_VARIABLES: Readonly<Record<TestHookName, string>> = {
  IGNORE_CONTROL: 'MCS_TEST_IGNORE_CONTROL',
  BOOT_HANG: 'MCS_TEST_BOOT_HANG',
  INIT_CRASH: 'MCS_TEST_INIT_CRASH',
};

function variableOf(name: string): string | undefined {
  for (const hook of TEST_HOOK_NAMES) {
    const variable = TEST_HOOK_VARIABLES[hook];
    if (name === hook || name === variable) return variable;
  }
  return undefined;
}

/**
 * The value of the hook `name` (the short name such as `'BOOT_HANG'`, or the full variable name), or `undefined` when test
 * mode is off, the hook is not one of the documented three, or the variable is unset or empty. `env` defaults to the
 * process environment.
 */
export function testHook(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (env['MCS_TEST'] !== '1') return undefined;
  const variable = variableOf(name);
  if (variable === undefined) return undefined;
  const value = env[variable];
  return value === undefined || value === '' ? undefined : value;
}
