// `import` section: transcript import (02 sections 5.1.2, 5.2, 5.4, 5.5, 1.2). Nine keys. There is no
// `import.maxLineBytes` (I-32, registry C01): the line cap is the constant `MAX_LINE_BYTES` of `protocol/limits.ts`.
import { z } from 'zod';

import { GIB, MIB, type KeySpec, intKey, nullableIntKey, sectionSchema } from './section.ts';

const backfillShare: KeySpec<z.ZodNumber> = { schema: z.number().min(0.05).max(1), default: 0.25 };

export const ImportSectionKeys = {
  /** Derived from `window_hours`. A fractional legacy value is refused (N-04). */
  lookbackHours: nullableIntKey(1, 8760),
  /** Derived from `limits.event_window_mb` x 1 MiB. `event_window_mb` below 1 is refused (N-04). */
  tailWindowBytes: nullableIntKey(MIB, 4 * GIB),
  /** Derived from `limits.usage_max_mb` x 1 MiB. */
  backfillMaxBytes: nullableIntKey(0, 64 * GIB),
  headMaxBytes: intKey(MIB, 256 * MIB, 16 * MIB),
  untrackAfterHours: intKey(1, 8760, 48),
  discoveryIntervalMs: intKey(1000, 600_000, 5000),
  scanIntervalMs: intKey(250, 60_000, 1000),
  sliceMs: intKey(5, 200, 20),
  backfillShare,
};

export const ImportSectionSchema = sectionSchema(ImportSectionKeys);
