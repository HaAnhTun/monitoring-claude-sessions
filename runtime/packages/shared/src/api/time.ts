// API time (03 5.1): output is ISO-8601 UTC with milliseconds and `Z`; input is ISO-8601 with `Z` or an offset and is
// normalised to the output form. The `Date` arithmetic stays in the engine; this file only checks and converts.
import { z } from 'zod';

import { isoMsZ } from '../time.ts';

/** `YYYY-MM-DDTHH:MM:SS.mmmZ`, the exact form of `Date.prototype.toISOString`. */
export type IsoTime = string;

const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** An output timestamp. Calendar-invalid dates such as February 31 are refused (V8 would roll them over). */
export const IsoTimeSchema = z
  .string()
  .regex(ISO_TIME_RE)
  .refine((text) => {
    const ms = Date.parse(text);
    return Number.isFinite(ms) && isoMsZ(ms) === text;
  }, 'not a calendar date');

/** `IsoTime | null`, the way the API says "unknown". */
export const NullableIsoTimeSchema = IsoTimeSchema.nullable();

/**
 * An input timestamp (query parameter): `Z` or an offset, any fraction; output is the normalised `IsoTime`. An input
 * that normalises to a year outside 0000-9999 is refused.
 */
export const IsoTimeInputSchema = z.iso
  .datetime({ offset: true })
  .refine((text) => Number.isFinite(Date.parse(text)), 'not a calendar date')
  .transform((text) => isoMsZ(Date.parse(text)))
  // an offset can push a valid input outside years 0000-9999, where `toISOString` writes an expanded year
  .pipe(IsoTimeSchema);

/** Epoch milliseconds as an output timestamp. Throws `RangeError` for an invalid time value. */
export function toIsoTime(ms: number): IsoTime {
  return isoMsZ(ms);
}

/** Epoch milliseconds of an output timestamp. */
export function isoTimeToMs(time: IsoTime): number {
  return Date.parse(time);
}
