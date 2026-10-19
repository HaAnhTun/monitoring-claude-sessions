// The exit codes of the server process (01 4.1, registry 7.3), once. Pure: the server boot returns them, the lifecycle commands
// of the engine and the CLI turn a child's exit code into its name. 1 is never used (Windows reports it for a forced stop).

export const SERVER_EXIT_CODES = {
  OK: 0,
  CONFIG_INVALID: 10,
  IDENTITY_MISMATCH: 11,
  INSTANCE_LOCKED: 12,
  PORT_EXHAUSTED: 13,
  DB_ERROR: 14,
  DB_NEWER_THAN_RUNTIME: 15,
  DB_UPGRADE_REQUIRED: 16,
  WORKSPACE_INVALID: 17,
  BUILD_INVALID: 18,
  INTERNAL: 70,
} as const;

export type ServerExitName = keyof typeof SERVER_EXIT_CODES;
export type ServerExitCode = (typeof SERVER_EXIT_CODES)[ServerExitName];
/** An exit code that says the boot failed. */
export type ServerFailureCode = Exclude<ServerExitCode, 0>;

/** Every exit code once, so that a code added to the table above is also named here (a missing key does not compile). */
const NAME_OF_CODE: Readonly<Record<ServerExitCode, ServerExitName>> = {
  0: 'OK',
  10: 'CONFIG_INVALID',
  11: 'IDENTITY_MISMATCH',
  12: 'INSTANCE_LOCKED',
  13: 'PORT_EXHAUSTED',
  14: 'DB_ERROR',
  15: 'DB_NEWER_THAN_RUNTIME',
  16: 'DB_UPGRADE_REQUIRED',
  17: 'WORKSPACE_INVALID',
  18: 'BUILD_INVALID',
  70: 'INTERNAL',
};

/** The name of an exit code of the table, or `null` for a number that is not one of ours. */
export function serverExitNameOf(code: number): ServerExitName | null {
  return Object.entries(NAME_OF_CODE).find(([key]) => Number(key) === code)?.[1] ?? null;
}
