// `lifecycle` section: thresholds of the session-state rules (02 section 7.8). 02 states no ranges, so the bounds are
// chosen by 01 (01 1.6); the owner may narrow them.
import { z } from 'zod';

import { type KeySpec, intKey, sectionSchema } from './section.ts';

/** Positive seconds, at most one day; `null` = derived from the legacy key named in `R_DERIVED_DEFAULTS`. */
const derivedSeconds: KeySpec<z.ZodNullable<z.ZodNumber>> = {
  schema: z.number().gt(0).max(86_400).nullable(),
  default: null,
};

export const LifecycleSectionKeys = {
  /** Derived from `active_seconds` (120). */
  activeSeconds: derivedSeconds,
  /** Derived from `pending_tool_grace_seconds` (900). */
  pendingToolGraceSeconds: derivedSeconds,
  subagentActiveSeconds: intKey(1, 86_400, 60),
  staleAfterSeconds: intKey(60, 604_800, 1800),
  abandonedAfterSeconds: intKey(600, 2_592_000, 86_400),
  processGoneGraceSeconds: intKey(0, 3600, 30),
  crossSourceToleranceMs: intKey(0, 60_000, 2000),
  reopenToleranceMs: intKey(0, 60_000, 2000),
  sweepIntervalMs: intKey(500, 60_000, 5000),
  pidCheckIntervalMs: intKey(1000, 600_000, 10_000),
  registryPollMs: intKey(1000, 600_000, 5000),
  jobsPollMs: intKey(1000, 600_000, 15_000),
};

export const LifecycleSectionSchema = sectionSchema(LifecycleSectionKeys);
