// Completion evidence (02 7.13, 03 6.1 and 6.3, registry C16 and C17): the answer to "did this unattended run really finish?".
// `CompletionEvidenceSchema` is the one definition; the engine's `explainCompletion` returns its `z.infer` type and the route
// `explainCompletion` answers `CompletionEvidence & { asOfSeq }`. The query accepts exactly one selector: a session id, an
// exact session label, or an attempt part (the empty part is legal: attempts of a chain log without a `part` group).
import { z } from 'zod';

import { EvidenceItemSchema, LifecycleStateSchema, StateAssessmentSchema } from './entities.ts';
import { CountSchema, SessionIdSchema } from './ids.ts';

/** A label is 1..200 code points (the length a stored session label is clipped to). */
export const COMPLETION_LABEL_MAX = 200;
/** An attempt part is 0..512 code points (the `attempt_runs.part` column cap of 03 3.5, registry C17). */
export const COMPLETION_PART_MAX = 512;

export const COMPLETION_OUTCOMES = ['completed', 'failed', 'not_terminal'] as const;
export const CompletionOutcomeSchema = z.enum(COMPLETION_OUTCOMES);
export type CompletionOutcome = z.infer<typeof CompletionOutcomeSchema>;

export const COMPLETION_RESOLVED_BY = ['session_id', 'label', 'attempt_part'] as const;
export const CompletionResolvedBySchema = z.enum(COMPLETION_RESOLVED_BY);
export type CompletionResolvedBy = z.infer<typeof CompletionResolvedBySchema>;

/**
 * True when `text` has at most `max` code points. A text longer than `2 * max` UTF-16 units cannot fit, so a very long
 * text is refused without being walked.
 */
export function withinCodePoints(text: string, max: number): boolean {
  if (text.length <= max) return true;
  if (text.length > 2 * max) return false;
  return Array.from(text).length <= max;
}

/**
 * What `explainCompletion` found. `outcome` is terminal (`completed`, `failed`) only when `basis` is `observed` (D9: an
 * inferred state is never terminal). `sessionId` is `null` only for an ended attempt row that no session matched.
 */
export const CompletionEvidenceSchema = z.strictObject({
  outcome: CompletionOutcomeSchema,
  state: LifecycleStateSchema,
  basis: StateAssessmentSchema.shape.basis,
  confidence: StateAssessmentSchema.shape.confidence,
  /** The evidence of the deciding view, words rendered at the time of the answer. */
  evidence: z.array(EvidenceItemSchema).max(8),
  sessionId: SessionIdSchema.nullable(),
  /** The lifecycle rule (`S-1` .. `S-10`) or `C-ATT-ENDED`, `C-ATT-OPEN`, `C-ATT-SUPERSEDED` for an attempt row alone. */
  ruleId: z.string(),
  resolvedBy: CompletionResolvedBySchema,
  /** Sessions (by label) or attempt rows (by part) that matched the target; 1 for a session id. */
  candidates: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type CompletionEvidence = z.infer<typeof CompletionEvidenceSchema>;

/** The body of `GET /completion`: the evidence and the change-log head it was read at. */
export const CompletionResponseSchema = CompletionEvidenceSchema.extend({ asOfSeq: CountSchema });
export type CompletionResponse = z.infer<typeof CompletionResponseSchema>;

/**
 * `GET /completion?session=` or `?label=` or `?attemptPart=`: exactly one. `attemptPart` may be present and empty; the
 * label is not trimmed because it is compared to stored labels for exact equality.
 */
export const CompletionQuerySchema = z
  .strictObject({
    session: SessionIdSchema.optional(),
    label: z
      .string()
      .min(1)
      .refine((text) => withinCodePoints(text, COMPLETION_LABEL_MAX), {
        error: `Expected at most ${String(COMPLETION_LABEL_MAX)} characters`,
      })
      .meta({ minLength: 1, maxLength: COMPLETION_LABEL_MAX })
      .optional(),
    attemptPart: z
      .string()
      .refine((text) => withinCodePoints(text, COMPLETION_PART_MAX), {
        error: `Expected at most ${String(COMPLETION_PART_MAX)} characters`,
      })
      .meta({ maxLength: COMPLETION_PART_MAX })
      .optional(),
  })
  .refine((q) => [q.session, q.label, q.attemptPart].filter((value) => value !== undefined).length === 1, {
    message: 'exactly one of session, label and attemptPart is required',
    path: ['session'],
  });
export type CompletionQuery = z.output<typeof CompletionQuerySchema>;
