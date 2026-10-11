// Monitor connection / data freshness, kept separate from session execution state.
// Pure: takes api.snapshot() records and returns a description; the page renders it.

/**
 * coreNames: endpoints that define "the monitor is working" (health, sessions, events when a
 * session is selected). Returns:
 *  connection: 'connecting' | 'ok' | 'reconnecting' | 'lost'
 *  stale: no successful poll of some core endpoint for staleAfterMs
 *  ageMs: age of the OLDEST core success (worst case freshness), null if none yet
 *  lastError: {name, message, t} of the most recent failing core endpoint, or null
 */
export function computeHealth({ records, now, staleAfterMs, coreNames }) {
  const byName = new Map(records.map((r) => [r.name, r]));
  const core = coreNames.map((n) => byName.get(n)).filter(Boolean);
  const touched = core.filter((r) => r.lastSuccess !== null || r.lastError);
  if (!touched.length) return { connection: 'connecting', stale: false, ageMs: null, lastError: null, failing: [] };

  const succeeded = core.filter((r) => r.lastSuccess !== null);
  const ageMs = succeeded.length ? now - Math.min(...succeeded.map((r) => r.lastSuccess)) : null;
  const failing = core.filter((r) => r.failures > 0);

  let connection = 'ok';
  if (failing.length) {
    const down = failing.some((r) => (r.lastSuccess === null ? r.failures >= 3 : now - r.lastSuccess >= staleAfterMs));
    connection = down ? 'lost' : 'reconnecting';
  }
  const stale = ageMs !== null && ageMs > staleAfterMs;
  let lastError = null;
  for (const r of failing) {
    if (r.lastError && (!lastError || r.lastError.t > lastError.t)) lastError = { name: r.name, message: r.lastError.message, t: r.lastError.t };
  }
  return { connection, stale, ageMs, lastError, failing: failing.map((r) => r.name) };
}

/** Count top-level session states. */
export function countStates(sessions) {
  const c = { RUNNING: 0, IDLE: 0, COMPLETED: 0, FAILED: 0, UNKNOWN: 0 };
  for (const s of sessions) c[normalizeState(s.state)] += 1;
  return c;
}

export function normalizeState(s) {
  return ['RUNNING', 'IDLE', 'COMPLETED', 'FAILED', 'UNKNOWN'].includes(s) ? s : 'UNKNOWN';
}

/** Page title: plain words, never emoji-only. */
export function titleFor(counts, title, connection) {
  const parts = [];
  if (counts.RUNNING) parts.push(`${counts.RUNNING} running`);
  if (counts.FAILED) parts.push(`${counts.FAILED} failed`);
  const prefix = connection === 'lost' ? 'Monitor offline' : parts.join(', ');
  return prefix ? `${prefix} - ${title}` : title;
}
