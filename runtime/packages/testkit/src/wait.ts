// The only sanctioned polling of tests (05 4.6 rule 1) and the event-loop probe of the benchmarks.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export interface WaitOptions {
  /** Budget in ms (default 5000). */
  timeoutMs?: number;
  /** Pause between probes in ms (default 25). */
  intervalMs?: number;
  /** Names the thing waited for in the timeout error. */
  what?: string;
}

type Attempt<T> = { ready: true; value: NonNullable<T> } | { ready: false; detail: string; timedOut?: true };

function isReady<T>(value: T): value is NonNullable<T> {
  const loose: unknown = value;
  return loose !== null && loose !== undefined && loose !== false;
}

async function run<T>(probe: () => T | Promise<T>): Promise<Attempt<T>> {
  try {
    const value = await probe();
    return isReady(value) ? { ready: true, value } : { ready: false, detail: `last value: ${inspect(value)}` };
  } catch (error) {
    return { ready: false, detail: `last error: ${inspect(error)}` };
  }
}

/** One probe call raced against the time left, so a probe that never settles cannot outlive the budget. */
async function attempt<T>(probe: () => T | Promise<T>, budgetMs: number, previous: string): Promise<Attempt<T>> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<Attempt<T>>((resolve) => {
    timer = setTimeout(
      () => {
        const note = `the probe did not settle within the remaining ${String(budgetMs)} ms`;
        resolve({ ready: false, detail: previous === '' ? note : `${note}; ${previous}`, timedOut: true });
      },
      Math.max(1, budgetMs),
    );
  });
  try {
    return await Promise.race([run(probe), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls `probe` until it returns a value that is not `null`, `undefined` or `false`, and returns that value. A probe that
 * throws counts as "not yet". The timeout error names `what`, the budget and the last value (or the last error).
 */
export async function waitFor<T>(probe: () => T | Promise<T>, opts: WaitOptions = {}): Promise<NonNullable<T>> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 25;
  if (!(timeoutMs > 0)) throw new RangeError(`waitFor: timeoutMs must be positive, got ${String(timeoutMs)}`);
  if (!(intervalMs > 0)) throw new RangeError(`waitFor: intervalMs must be positive, got ${String(intervalMs)}`);
  const deadline = Date.now() + timeoutMs;
  let outcome = await attempt(probe, deadline - Date.now(), '');
  while (!outcome.ready) {
    if (outcome.timedOut === true || Date.now() >= deadline) {
      const what = opts.what ?? 'the condition';
      throw new Error(`waitFor: timed out after ${String(timeoutMs)} ms waiting for ${what}; ${outcome.detail}`);
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    outcome = await attempt(probe, deadline - Date.now(), outcome.detail);
  }
  return outcome.value;
}

/** Event-loop delay recorder (`perf_hooks.monitorEventLoopDelay`, 10 ms resolution). */
export function eventLoopLagProbe(): { stop(): { maxMs: number; p99Ms: number } } {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  return {
    stop: () => {
      histogram.disable();
      const toMs = (ns: number): number => (Number.isFinite(ns) ? ns / 1e6 : 0);
      return { maxMs: toMs(histogram.max), p99Ms: toMs(histogram.percentile(99)) };
    },
  };
}
