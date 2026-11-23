// The `--json` envelope of every CLI command (01 section 6.2, ADR 0008): one document on stdout,
// `schemas/cli-envelope.v1.schema.json`. Per-command `data` types live in `cli/results.ts`.
import { z } from 'zod';

import { type CliErrorCode, CliErrorCodeSchema, type McsError, cliExitCode } from '../errors.ts';

export const CLI_SCHEMA = 'mcs.cli/1' as const;

export interface CliError {
  code: CliErrorCode;
  message: string;
  hint: string | null;
  details: Record<string, unknown> | null;
}

export interface CliEnvelope<T> {
  schema: typeof CLI_SCHEMA;
  command: string;
  ok: boolean;
  /** 4, 5 and 6 are the outcomes of `wait` (`WAIT_EXIT_CODES` of `cli/watch.ts`): data and no error. */
  exitCode: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  data: T | null;
  error: CliError | null;
  warnings: string[];
}

export const CliErrorSchema = z.strictObject({
  code: CliErrorCodeSchema,
  message: z.string(),
  hint: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});

/**
 * Envelope schema for a given `data` schema. Beyond the shapes it checks what the contract says about the exit code:
 * `ok` means exit 0 and no error; a failure has a non-zero exit code, and an error fixes it (`USAGE` = 2, `TERMINALS_LIVE` = 3, others = 1).
 * A failure may carry `data` and no error (a check that found problems, a wait that was not met: exit codes 4, 5 and 6 are
 * never the code of an error).
 */
export function cliEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z
    .strictObject({
      schema: z.literal(CLI_SCHEMA),
      command: z.string().min(1),
      ok: z.boolean(),
      exitCode: z.union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
      ]),
      data: data.nullable(),
      error: CliErrorSchema.nullable(),
      warnings: z.array(z.string()),
    })
    .superRefine((env, ctx) => {
      if (env.ok) {
        if (env.exitCode !== 0) ctx.addIssue({ code: 'custom', path: ['exitCode'], message: 'ok needs exitCode 0' });
        if (env.error !== null) ctx.addIssue({ code: 'custom', path: ['error'], message: 'ok needs error null' });
        return;
      }
      if (env.exitCode === 0)
        ctx.addIssue({ code: 'custom', path: ['exitCode'], message: 'a failure needs a non-zero exitCode' });
      else if (env.error !== null && env.exitCode !== cliExitCode(env.error.code)) {
        ctx.addIssue({
          code: 'custom',
          path: ['exitCode'],
          message: `error ${env.error.code} needs exitCode ${cliExitCode(env.error.code)}`,
        });
      }
    });
}

/** Envelope with an unvalidated `data`. */
export const CliEnvelopeSchema = cliEnvelopeSchema(z.unknown());

/** `McsError` -> `CliError` (`hint` and `details` become `null` when absent). */
export function toCliError(error: McsError): CliError {
  return {
    code: error.code,
    message: error.message,
    hint: error.hint ?? null,
    details: error.details === undefined ? null : { ...error.details },
  };
}

export function successEnvelope<T>(command: string, data: T | null, warnings: readonly string[] = []): CliEnvelope<T> {
  return { schema: CLI_SCHEMA, command, ok: true, exitCode: 0, data, error: null, warnings: [...warnings] };
}

export interface FailureOptions<T> {
  /** Result data that accompanies a failure (for example the checks of a `doctor` run). */
  readonly data?: T;
  readonly warnings?: readonly string[];
}

export function failureEnvelope<T = never>(
  command: string,
  error: CliError,
  options: FailureOptions<T> = {},
): CliEnvelope<T> {
  return {
    schema: CLI_SCHEMA,
    command,
    ok: false,
    exitCode: cliExitCode(error.code),
    data: options.data ?? null,
    error,
    warnings: [...(options.warnings ?? [])],
  };
}
