// Contracts of the two reading commands `events` and `wait` (ADR 0108): the NDJSON line `caw.event/1`
// (`schemas/event.v1.schema.json`), the wait conditions, the result of a wait and its exit codes. A line carries ids,
// states and times only: no label, folder, project name, evidence text, transcript or registry text.
import { z } from 'zod';

import { CompletionOutcomeSchema } from '../api/completion.ts';
import { type StateAssessment, StateAssessmentSchema } from '../api/entities.ts';
import { CountSchema, EpochSchema, InstanceIdSchema, PositiveIdSchema, SessionIdSchema } from '../api/ids.ts';
import { ChangeKindSchema, ChangeOpSchema, STREAM_RESET_REASONS } from '../api/stream.ts';
import { IsoTimeSchema } from '../api/time.ts';
import { ATTENTION_POSTURES, ATTENTION_REASONS, attentionOf } from '../attention.ts';

/** The first `caw.` wire identifier; the `mcs.*` family stays frozen (ADR 0108 decision 1). */
export const CLI_EVENT_SCHEMA = 'caw.event/1' as const;

// ---- the state a line or a result carries -------------------------------------------------------------------------

/** The part of a state assessment that leaves the machine: no evidence text, no end reason. */
export const WaitStateSchema = StateAssessmentSchema.pick({
  state: true,
  rule: true,
  basis: true,
  confidence: true,
  presence: true,
  waitReason: true,
  turnOutcome: true,
  since: true,
});
export type WaitState = z.infer<typeof WaitStateSchema>;

export const AttentionSummarySchema = z.strictObject({
  posture: z.enum(ATTENTION_POSTURES),
  reason: z.enum(ATTENTION_REASONS).nullable(),
});
export type AttentionSummary = z.infer<typeof AttentionSummarySchema>;

export const CliEventSessionSchema = WaitStateSchema.extend({ attention: AttentionSummarySchema });
export type CliEventSession = z.infer<typeof CliEventSessionSchema>;

export function waitStateOf(state: StateAssessment): WaitState {
  return {
    state: state.state,
    rule: state.rule,
    basis: state.basis,
    confidence: state.confidence,
    presence: state.presence,
    waitReason: state.waitReason,
    turnOutcome: state.turnOutcome,
    since: state.since,
  };
}

export function attentionSummaryOf(state: StateAssessment): AttentionSummary {
  const { posture, reason } = attentionOf(state);
  return { posture, reason };
}

/** The `session` of a `change` line, from the state of a session summary. */
export function cliEventSessionOf(state: StateAssessment): CliEventSession {
  return { ...waitStateOf(state), attention: attentionSummaryOf(state) };
}

// ---- caw.event/1 --------------------------------------------------------------------------------------------------

export const CLI_EVENT_TYPES = ['hello', 'change', 'reset', 'end'] as const;
export type CliEventType = (typeof CLI_EVENT_TYPES)[number];

const schemaTag = z.literal(CLI_EVENT_SCHEMA);

export const CliEventHelloSchema = z.strictObject({
  schema: schemaTag,
  type: z.literal('hello'),
  instanceId: InstanceIdSchema,
  epoch: EpochSchema,
  headSeq: CountSchema,
  serverTime: IsoTimeSchema,
});

/** One change of the durable stream. `session` is set only for `kind: session`, `op: upsert` with readable data. */
export const CliEventChangeSchema = z
  .strictObject({
    schema: schemaTag,
    type: z.literal('change'),
    seq: PositiveIdSchema,
    at: IsoTimeSchema,
    kind: ChangeKindSchema,
    op: ChangeOpSchema,
    sessionId: SessionIdSchema.nullable(),
    session: CliEventSessionSchema.nullable(),
  })
  .refine((event) => event.session === null || (event.kind === 'session' && event.op === 'upsert'), {
    path: ['session'],
    message: 'session is set only for a session upsert',
  });

export const CliEventResetSchema = z.strictObject({
  schema: schemaTag,
  type: z.literal('reset'),
  reason: z.enum(STREAM_RESET_REASONS),
  headSeq: CountSchema,
});

/** The replay of `--since` without `--follow` ended after `count` change lines. */
export const CliEventEndSchema = z.strictObject({
  schema: schemaTag,
  type: z.literal('end'),
  headSeq: CountSchema,
  count: CountSchema,
});

/** One NDJSON line of `events`: strict, discriminated on `type`. */
export const CliEventSchema = z.discriminatedUnion('type', [
  CliEventHelloSchema,
  CliEventChangeSchema,
  CliEventResetSchema,
  CliEventEndSchema,
]);
export type CliEvent = z.infer<typeof CliEventSchema>;

// ---- wait ---------------------------------------------------------------------------------------------------------

export const WAIT_UNTILS = ['needs_you', 'turn_ended', 'completed', 'failed', 'ended'] as const;
export const WaitUntilSchema = z.enum(WAIT_UNTILS);
export type WaitUntil = z.infer<typeof WaitUntilSchema>;

export const WAIT_OUTCOMES = ['met', 'timeout', 'ended', 'missing'] as const;
export const WaitOutcomeSchema = z.enum(WAIT_OUTCOMES);
export type WaitOutcome = z.infer<typeof WaitOutcomeSchema>;

/**
 * The exit code of each wait outcome. `ended` is "ended another way" (the condition can no longer come true), `missing`
 * is "no such session". 1 (error), 2 (usage), 3 (the stop guard, never used by a wait) and 130 keep their meaning.
 */
export const WAIT_EXIT_CODES = { met: 0, timeout: 4, ended: 5, missing: 6 } as const satisfies Readonly<
  Record<WaitOutcome, number>
>;
export type WaitExitCode = (typeof WAIT_EXIT_CODES)[WaitOutcome];

export function waitExitCode(outcome: WaitOutcome): WaitExitCode {
  return WAIT_EXIT_CODES[outcome];
}

/** The `data` of the `wait` envelope; for an outcome other than `met` the envelope is `ok: false` with `error: null`. */
export const WaitResultSchema = z.strictObject({
  outcome: WaitOutcomeSchema,
  until: WaitUntilSchema,
  sessionId: SessionIdSchema.nullable(),
  /** The last state read, `null` when the session was never seen. */
  state: WaitStateSchema.nullable(),
  attention: AttentionSummarySchema.nullable(),
  /** The answer of the completion check; set only for `until: completed` once it was asked. */
  completion: z.strictObject({ outcome: CompletionOutcomeSchema, ruleId: z.string() }).nullable(),
  waitedMs: CountSchema,
  /** The condition already held at the first read (never with `--next`). */
  alreadyTrue: z.boolean(),
});
export type WaitResult = z.infer<typeof WaitResultSchema>;

// ---- durations ----------------------------------------------------------------------------------------------------

export const WAIT_TIMEOUT_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const WAIT_TIMEOUT_DEFAULT_MS = 30 * 60 * 1000;
/** How long a `needs_you` must keep holding before it counts. */
export const WAIT_HOLD_DEFAULT_MS = 3000;
/** How long a wait gives the session row to exist. */
export const WAIT_APPEAR_DEFAULT_MS = 30_000;

const DURATION_RE = /^(\d{1,9})(s|m|h|d)?$/;
const UNIT_MS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parses `0`, `45`, `45s`, `30m`, `2h`, `7d` (whole numbers; no unit means seconds) to milliseconds. Returns `null` for
 * any other text and for a duration above `maxMs` (7 days unless given).
 */
export function parseDuration(text: string, maxMs: number = WAIT_TIMEOUT_MAX_MS): number | null {
  const match = DURATION_RE.exec(text);
  if (match === null) return null;
  const unitMs = UNIT_MS[match[2] ?? 's'];
  if (unitMs === undefined) return null;
  const ms = Number(match[1]) * unitMs;
  return ms <= maxMs ? ms : null;
}
