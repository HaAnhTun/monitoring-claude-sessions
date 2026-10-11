// Polling with bounded exponential backoff (port of legacy modules/poller.js). A failed run is retried after
// min(cap, max(interval, 1 s) * 2^failures); the first success resumes the normal interval. Also the stream reconnect delay.

export const BACKOFF_CAP_MS = 30000;

export function nextDelay(intervalMs: number, failures: number, capMs: number = BACKOFF_CAP_MS): number {
  const requested = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  const base = Math.max(1000, requested);
  const interval = requested > 0 ? requested : base;
  if (failures <= 0 || !Number.isFinite(failures)) return interval;
  return Math.min(capMs, base * 2 ** Math.min(failures, 12));
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface PollerOptions {
  name: string;
  /** Async, rejects on failure. */
  run(): Promise<void>;
  /** Current normal interval in milliseconds. */
  getInterval(): number;
  /** Called after each failed run (never swallowed silently by the poller; a throwing handler cannot stop the loop). */
  onError?(err: unknown, failures: number): void;
  delayFn?: (intervalMs: number, failures: number) => number;
  setT?: (fn: () => void, ms: number) => TimerHandle;
  clearT?: (handle: TimerHandle) => void;
}

export interface PollerState {
  readonly name: string;
  failures: number;
  nextAt: number;
  lastRunAt: number;
}

export interface Poller {
  readonly state: PollerState;
  start(): void;
  stop(): void;
  /** Poll now (also used by a Retry button); coalesced while a run is in flight. */
  trigger(): void;
  readonly running: boolean;
}

/** One run at a time: a trigger during a run asks for exactly one more run after it. */
export function createPoller(o: PollerOptions): Poller {
  const delayFn = o.delayFn ?? nextDelay;
  const setT = o.setT ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT =
    o.clearT ??
    ((h) => {
      clearTimeout(h);
    });
  let timer: TimerHandle | null = null;
  let running = false;
  let again = false;
  let stopped = true;
  const state: PollerState = { name: o.name, failures: 0, nextAt: 0, lastRunAt: 0 };

  function clearTimer(): void {
    if (timer !== null) clearT(timer);
    timer = null;
  }

  async function tick(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    clearTimer();
    try {
      await o.run();
      state.failures = 0;
    } catch (err) {
      state.failures += 1;
      try {
        o.onError?.(err, state.failures);
      } catch {
        // a failing error handler must never stop the poll loop
      }
    }
    state.lastRunAt = Date.now();
    running = false;
    if (stopped) return;
    if (again) {
      again = false;
      void tick();
      return;
    }
    const d = delayFn(o.getInterval(), state.failures);
    state.nextAt = Date.now() + d;
    timer = setT(() => void tick(), d);
  }

  return {
    state,
    start() {
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      again = false;
      clearTimer();
    },
    trigger() {
      stopped = false;
      void tick();
    },
    get running() {
      return running;
    },
  };
}
