// fetch wrapper: timeout, readable errors, and per-endpoint last-success / last-error tracking.
// Errors are never swallowed here: callers get an ApiError, and the tracker keeps the details
// so the health bar can show them.

export class ApiError extends Error {
  constructor(message, { status = 0, kind = 'http', url = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind; // 'network' | 'timeout' | 'http' | 'parse'
    this.url = url;
  }
}

/** Human, actionable message for a failed request. */
export function describeFailure(kind, status, serverMessage, timeoutMs) {
  if (kind === 'timeout') return `No answer from the monitor within ${Math.round(timeoutMs / 1000)} s`;
  if (kind === 'network') return 'Cannot reach the monitor (is the viewer process still running?)';
  if (kind === 'parse') return 'The monitor sent an unreadable response';
  if (status === 403) return 'Request rejected (403): open this page via 127.0.0.1 or localhost';
  if (status === 404) return serverMessage ? `Not found: ${serverMessage}` : 'Not found (404)';
  if (status >= 500) return `Monitor error (${status})${serverMessage ? `: ${serverMessage}` : ''}`;
  return `Request failed (${status})${serverMessage ? `: ${serverMessage}` : ''}`;
}

export function createApi({ fetchImpl, timeoutMs = 8000, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const endpoints = new Map();
  const listeners = new Set();

  function rec(name) {
    if (!endpoints.has(name)) {
      endpoints.set(name, { name, lastSuccess: null, lastError: null, failures: 0, lastUrl: '' });
    }
    return endpoints.get(name);
  }
  const notify = () => listeners.forEach((fn) => { try { fn(); } catch { /* listener bugs must not break polling */ } });

  async function get(name, url, { timeout = timeoutMs } = {}) {
    const r = rec(name);
    r.lastUrl = url;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
    try {
      let resp;
      let text;
      try {
        resp = await doFetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
        text = await resp.text();
      } catch (e) {
        const kind = timedOut || (e && e.name === 'AbortError') ? 'timeout' : 'network';
        throw new ApiError(describeFailure(kind, 0, '', timeout), { kind, url });
      }
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = undefined; }
      if (!resp.ok) {
        const sm = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
        throw new ApiError(describeFailure('http', resp.status, sm, timeout), { status: resp.status, kind: 'http', url });
      }
      if (body === undefined) throw new ApiError(describeFailure('parse', 0, '', timeout), { kind: 'parse', url });
      r.lastSuccess = now();
      r.failures = 0;
      notify();
      return body;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(String(e && e.message ? e.message : e), { kind: 'network', url });
      r.failures += 1;
      r.lastError = { message: err.message, status: err.status, kind: err.kind, t: now() };
      notify();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get,
    status: (name) => { const r = endpoints.get(name); return r ? { ...r } : null; },
    snapshot: () => [...endpoints.values()].map((r) => ({ ...r })),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
