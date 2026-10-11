// The fake clock of tests. The `Clock` interface is 01's (`@mcs/shared` time.ts, registry C27); only the fake lives here.
import type { Clock } from '@mcs/shared';

/** 2026-01-01T00:00:00Z: the epoch every fixture timestamp derives from (05 4.6 rule 3). */
export const FIXTURE_EPOCH_MS: number = Date.UTC(2026, 0, 1);

function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`FakeClock: ${name} must be a finite number, got ${String(value)}`);
  return value;
}

export class FakeClock implements Clock {
  #ms: number;

  constructor(startMs: number) {
    this.#ms = finite('startMs', startMs);
  }

  now(): number {
    return this.#ms;
  }

  /** Moves forward by `ms` (zero allowed). */
  advance(ms: number): void {
    if (finite('ms', ms) < 0) throw new RangeError(`FakeClock.advance: ms must not be negative, got ${String(ms)}`);
    this.#ms += ms;
  }

  /** Jumps to `ms`, also backwards (clock-skew cases). */
  set(ms: number): void {
    this.#ms = finite('ms', ms);
  }
}
