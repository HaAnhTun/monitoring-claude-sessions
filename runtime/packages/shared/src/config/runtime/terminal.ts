// `terminal` section: the Claude sessions that the workspace runs in a pseudo console (CAW design 01 3.3, with the bounds
// of design 06 1.6). Nine keys. There is no `terminal.enabled`: the terminal is always on. The fixed values (default size,
// resize clamps, replay frame, viewer backlog) are constants of the engine, not configuration.
import { z } from 'zod';

import { KIB, MIB, type KeySpec, boolKey, intKey, sectionSchema } from './section.ts';

/**
 * The most bytes one input message to a terminal may carry, and the default of `terminal.maxInputBytes`. It is also the
 * largest payload of the terminal socket: one limit, so a message that passes the gateway always passes the session.
 */
const INPUT_MAX_BYTES = 256 * KIB;

const command: KeySpec<z.ZodString> = {
  /** Program of every new session: a name on PATH or an absolute path. No quotes or control characters. */
  schema: z
    .string()
    .min(1)
    .max(260)
    // printable characters only (no C0, DEL or C1 control, written as the allowed ranges) and no double quote
    .regex(/^[\u0020\u0021\u0023-\u007e\u00a1-\uffff]+$/),
  default: 'claude',
};

const args: KeySpec<z.ZodArray<z.ZodString>> = {
  /** Extra arguments in front of `--resume`, passed one by one and never through a shell. */
  schema: z
    .array(
      z
        .string()
        .max(500)
        .refine((value) => !value.includes('\u0000'), 'an argument cannot contain a NUL character'),
    )
    .max(32),
  default: [],
};

const envKeep: KeySpec<z.ZodArray<z.ZodString>> = {
  /** Names from the stripped set of the child environment that are kept (for example `CLAUDE_CODE_USE_BEDROCK`). */
  schema: z
    .array(
      z
        .string()
        .max(128)
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    )
    .max(32),
  default: [],
};

export const TerminalSectionKeys = {
  command,
  args,
  envKeep,
  /** Live and starting sessions at once; a create over the limit is refused. */
  maxSessions: intKey(1, 64, 8),
  /** Replay buffer of one session, in bytes. */
  replayBytes: intKey(64 * KIB, 16 * MIB, MIB),
  /** Largest single write to a terminal; a bigger one is refused (the web client sends a paste in chunks). */
  maxInputBytes: intKey(KIB, INPUT_MAX_BYTES, INPUT_MAX_BYTES),
  /** How long to wait for the pseudo console to report the child as started. */
  startTimeoutMs: intKey(1000, 60_000, 10_000),
  /** How long to wait for an exit after a kill before the whole process tree is killed. */
  killTimeoutMs: intKey(500, 30_000, 3000),
  /** Use the `conpty.dll` and `OpenConsole.exe` that ship with the terminal package instead of the inbox conhost. */
  conptyDll: boolKey(false),
};

export const TerminalSectionSchema = sectionSchema(TerminalSectionKeys);
export type TerminalSection = z.output<typeof TerminalSectionSchema>;
