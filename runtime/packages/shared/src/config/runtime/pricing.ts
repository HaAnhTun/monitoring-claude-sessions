// `pricing` section (03 section 8.3, D15): configured prices only, none ship. Without `models` every cost is null.
// The owner text gives no ranges; the checks below are chosen by 01: non-empty strings, an ISO date, finite prices >= 0.
import { z } from 'zod';

import { type KeySpec, sectionSchema } from './section.ts';

const price = z.number().min(0);

export const PricingModelSchema = z.strictObject({
  /** Model id or a glob with `*`. */
  match: z.string().min(1).max(200),
  /** `YYYY-MM-DD` (UTC day); the latest entry with `effectiveFrom <= message day` applies. */
  effectiveFrom: z.iso.date(),
  inputPerMTok: price,
  outputPerMTok: price,
  cacheReadPerMTok: price,
  cacheWrite5mPerMTok: price,
  cacheWrite1hPerMTok: price,
});

export type PricingModel = z.infer<typeof PricingModelSchema>;

const currency: KeySpec<z.ZodString> = { schema: z.string().min(1).max(32), default: 'USD' };
const models: KeySpec<z.ZodArray<typeof PricingModelSchema>> = {
  schema: z.array(PricingModelSchema).max(1000),
  default: [],
};

export const PricingSectionKeys = { currency, models };

export const PricingSectionSchema = sectionSchema(PricingSectionKeys);
