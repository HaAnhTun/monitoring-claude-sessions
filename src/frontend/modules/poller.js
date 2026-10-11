// Polling with bounded exponential backoff. A failed run is retried after
// min(cap, max(interval, 1 s) * 2^failures); the first success resumes the normal interval.

export const BACKOFF_CAP_MS = 30000;

export function nextDelay(intervalMs, failures, capMs = BACKOFF_CAP_MS) {
  const base = Math.max(1000, Number(intervalMs) || 1000);
  const interval = Number(intervalMs) > 0 ? Number(intervalMs) : base;
  if (!failures || failures < 0) return interval;
  return Math.min(capMs, base * 2 ** Math.min(failures, 12));
}

/**
 * run(): async, throws on failure. getInterval(): current normal interval in ms.
 * onError(err, failures) is called after each failed run (never swallowed silently).
 */
export function createPoller({ name, run, getInterval, onError, delayFn = nextDelay, setT = setTimeout, clearT = clearTimeout }) {
  let timer = null;
  let running = false;
  let again = false;
  let stopped = true;
  const state = { name, failures: 0, nextAt: 0, lastRunAt: 0 };

  async function tick() {
    if (running) { again = true; return; }
    running = true;
    clearT(timer);
    timer = null;
    try {
      await run();
      state.failures = 0;
    } catch (err) {
      state.failures += 1;
      try { if (onError) onError(err, state.failures); } catch { /* ignore */ }
    }
    state.lastRunAt = Date.now();
    running = false;
    if (stopped) return;
    if (again) { again = false; tick(); return; }
    const d = delayFn(getInterval(), state.failures);
    state.nextAt = Date.now() + d;
    timer = setT(tick, d);
  }

  return {
    state,
    start() { stopped = false; tick(); },
    stop() { stopped = true; clearT(timer); timer = null; },
    /** Poll now (also used by the Retry button). */
    trigger() { stopped = false; tick(); },
    get running() { return running; },
  };
}
