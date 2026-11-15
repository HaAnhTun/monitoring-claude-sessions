// The test hooks of 01 2.10 (I-27): production code reads the test variables only through `testHook(name)`, and the
// function answers `undefined` unless the process runs in test mode (`MCS_TEST` is exactly `1`). The names of the
// hooks live here and nowhere else, so a scan of the production sources for them finds only this file.
//
// Registered for the terminal and the user instance (CAW-06) and wired into `TEST_HOOK_NAMES` by the packages that read
// them: MCS_TEST_OPEN_FILE (records the login URL instead of opening a browser; `platform/browser.ts`, wired),
// MCS_TEST_FAKE_TERMINALS (scripted terminal sessions that only the stop guard sees; `withFakeTerminals`, below) and
// MCS_TEST_FOLDER_PICKER (runs the testkit fake picker instead of the Windows folder dialog; `folderPickerHook`, below, read by
// `terminal/folder-picker.ts`).
import type { TerminalCensus, TerminalCensusEntry } from './user-services.ts';

/**
 * The documented hooks by their short name: T-LC-06 (control ignored), T-LC-08 (boot hangs), T-LC-10 (init crash) and
 * `OPEN_FILE` (the login URL is appended to that file instead of being opened, 06 2.5) and `FAKE_TERMINALS` (the census of a
 * user instance reports that many extra sessions, 06 1.7) and `FOLDER_PICKER` (the script of the fake folder picker that runs
 * instead of the Windows dialog).
 */
export const TEST_HOOK_NAMES = [
  'IGNORE_CONTROL',
  'BOOT_HANG',
  'INIT_CRASH',
  'OPEN_FILE',
  'FAKE_TERMINALS',
  'FOLDER_PICKER',
] as const;

export type TestHookName = (typeof TEST_HOOK_NAMES)[number];

/** The environment variable behind each hook. */
export const TEST_HOOK_VARIABLES: Readonly<Record<TestHookName, string>> = {
  IGNORE_CONTROL: 'MCS_TEST_IGNORE_CONTROL',
  BOOT_HANG: 'MCS_TEST_BOOT_HANG',
  INIT_CRASH: 'MCS_TEST_INIT_CRASH',
  OPEN_FILE: 'MCS_TEST_OPEN_FILE',
  FAKE_TERMINALS: 'MCS_TEST_FAKE_TERMINALS',
  FOLDER_PICKER: 'MCS_TEST_FOLDER_PICKER',
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
 * mode is off, the hook is not a documented one, or the variable is unset or empty. `env` defaults to the
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

// ---- FAKE_TERMINALS (06 1.7) ----------------------------------------------------------------------------------------------------

/** The most fake sessions the hook makes: a larger value is read as this one. */
export const FAKE_TERMINALS_MAX = 64;

/** When the fake sessions "started": long before any real session, so the list stays oldest first. */
const FAKE_STARTED_AT = '2026-01-01T00:00:00.000Z';

/**
 * How many fake sessions the hook asks for: the value of `MCS_TEST_FAKE_TERMINALS` when it is a positive whole number (at most
 * `FAKE_TERMINALS_MAX`), else 0 (the hook is off, test mode is off, or the value is not a count).
 */
export function fakeTerminalCount(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = testHook('FAKE_TERMINALS', env);
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return 0;
  return Math.min(Number(value), FAKE_TERMINALS_MAX);
}

/**
 * The census with the scripted sessions of the hook added: the count grows by n and the list gets `fake-1`..`fake-n` in front
 * (they are the oldest), so the stop guard of the lifecycle tests can be proven on real processes without a pseudo console.
 * Nothing is ever started or ended: the drain goes to the wrapped census. While the hook is off the census is returned as it is.
 */
export function withFakeTerminals(
  census: TerminalCensus,
  env: Readonly<Record<string, string | undefined>> = process.env,
): TerminalCensus {
  const n = fakeTerminalCount(env);
  if (n === 0) return census;
  const fakes: readonly TerminalCensusEntry[] = Array.from({ length: n }, (_, index) => ({
    name: `fake-${String(index + 1)}`,
    startedAt: FAKE_STARTED_AT,
  }));
  return {
    count: () => census.count() + n,
    sessions: (limit) => [...fakes, ...census.sessions(limit)].slice(0, Math.max(0, limit)),
    beginDrain: () => {
      census.beginDrain();
    },
  };
}

// ---- FOLDER_PICKER ---------------------------------------------------------------------------------------------------------------

/** What the hook FOLDER_PICKER asks for: the script that runs instead of the dialog, and the environment it is given. */
export interface FolderPickerHook {
  /** The script to run with Node (the `fake-picker.mjs` of the testkit). Whatever the variable says: the caller refuses what cannot run. */
  readonly script: string;
  /** The only variable of the environment that the script is given: `FAKE_PICKER_RESULT`, when set (the answer it plays). */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The hook of the folder picker: while test mode is on and `MCS_TEST_FOLDER_PICKER` names a script, the folder picker runs that
 * script with Node instead of showing the Windows dialog, and gives it `FAKE_PICKER_RESULT` of the environment (a path, nothing for
 * a cancel, or one of the failure words of the fake). `undefined` while the hook is off, so the real dialog is used.
 */
export function folderPickerHook(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FolderPickerHook | undefined {
  const script = testHook('FOLDER_PICKER', env);
  if (script === undefined) return undefined;
  const answer = env['FAKE_PICKER_RESULT'];
  return { script, env: answer === undefined ? {} : { FAKE_PICKER_RESULT: answer } };
}
