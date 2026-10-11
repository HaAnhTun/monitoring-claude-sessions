// CLI error codes and `McsError` (01 section 6.2, registry 7.2, C19). The name `ErrorCode` belongs to the HTTP codes of
// 03 (`api/errors.ts`); the CLI union is `CliErrorCode`.
import { z } from 'zod';

/** Every code that can appear in `CliEnvelope.error.code`. `USAGE` exits 2, all others exit 1. */
export const CLI_ERROR_CODES = [
  'USAGE',
  'CONFIG_INVALID',
  'CONFIG_SCHEMA_MISSING',
  'CONFIG_SCHEMA_UNSUPPORTED',
  'CONFIG_UNREADABLE',
  'REGEX_UNSUPPORTED',
  'SLUG_INVALID',
  'TASK_NOT_FOUND',
  'WORKSPACE_ESCAPE',
  'WORKSPACE_SYMLINK',
  'WORKSPACE_INVALID',
  'WORKSPACE_EXISTS_CONFIG_DIFFERS',
  'INSTANCE_NOT_INITIALIZED',
  'IDENTITY_MISMATCH',
  'INSTANCE_RUNNING',
  'INSTANCE_NOT_RUNNING',
  'ENGINE_CONFLICT',
  'LEGACY_ENGINE_UNAVAILABLE',
  'START_FAILED',
  'START_TIMEOUT',
  'PORT_EXHAUSTED',
  'STOP_FAILED',
  'NOT_OUR_PROCESS',
  'DB_NEWER_THAN_RUNTIME',
  'DB_UPGRADE_REQUIRED',
  'DB_ERROR',
  'DOWNGRADE_REFUSED',
  'BACKUP_NOT_FOUND',
  'BACKUP_INVALID',
  'CONFIRMATION_REQUIRED',
  'ISOLATION_VIOLATION',
  'OUTPUT_EXISTS',
  'OUTPUT_PATH_FORBIDDEN',
  'BOOTSTRAP_FAILED',
  'NODE_TOO_OLD',
  'RUNTIME_IN_USE',
  'HOOKS_FAILED',
  'NOT_FOUND',
  'API_ERROR',
  'INTERNAL',
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

export const CliErrorCodeSchema = z.enum(CLI_ERROR_CODES);

const KNOWN: ReadonlySet<unknown> = new Set(CLI_ERROR_CODES);

export function isCliErrorCode(value: unknown): value is CliErrorCode {
  return KNOWN.has(value);
}

/** Process exit code of a failed command: 2 for a usage error, 1 for every other code (01 6.2). */
export function cliExitCode(code: CliErrorCode): 1 | 2 {
  return code === 'USAGE' ? 2 : 1;
}

export interface McsErrorOptions {
  readonly hint?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** The error every engine operation throws for an expected failure. Matches `CliError` (registry 1.8, note N7). */
export class McsError extends Error {
  readonly code: CliErrorCode;
  readonly hint?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: CliErrorCode, message: string, options: McsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'McsError';
    this.code = code;
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.details !== undefined) this.details = options.details;
  }
}
