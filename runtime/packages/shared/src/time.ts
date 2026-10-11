// The only place that declares `Clock` (01 section 4.4a, I-36, registry C27). Engine code reads time through a
// `Clock`; `@mcs/testkit` implements it with `FakeClock`.

/** Epoch milliseconds UTC; the only time source of engine code. */
export interface Clock {
  now(): number;
}

/** The real clock. */
export const systemClock: Clock = { now: () => Date.now() };

const SECONDS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * `YYYY-MM-DDTHH:MM:SSZ` for audit headers, instance.json and backup ids. Milliseconds are dropped, never rounded up.
 * Throws `RangeError` for NaN, infinities and years outside 0000-9999.
 */
export function isoSecondsZ(ms: number): string {
  const text = `${new Date(ms).toISOString().slice(0, 19)}Z`;
  if (!SECONDS_Z.test(text)) throw new RangeError(`time value ${ms} has no four-digit-year representation`);
  return text;
}

/** `new Date(ms).toISOString()` (`YYYY-MM-DDTHH:MM:SS.mmmZ`). Throws `RangeError` for an invalid time value. */
export function isoMsZ(ms: number): string {
  return new Date(ms).toISOString();
}
