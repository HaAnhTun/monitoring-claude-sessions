// The headless UI poller of the idle benchmarks (design 06 section 8.2, WP-109). It replays the polling the Overview page does:
// the intervals come from `GET /api/v3/instance` (`InstanceInfo.poll`, registry C26), one request loop per endpoint, so no
// browser is needed. A loop never sends a request sooner than its interval after the previous one started (single flight: a slow
// answer delays the next request instead of overlapping it), and nothing is sent after `stop()`.
import { Agent, request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';

/** Start offset of the second client, so that two tabs do not poll in lock step (a real second tab opens at another moment). */
export const SECOND_CLIENT_OFFSET_MS = 1300;

/** The panel key behind each `InstanceInfo.panels` flag, with the `poll` key that sets its interval. */
const PANEL_POLL = Object.freeze([
  { flag: 'machine', key: 'machine', pollKey: 'machineMs' },
  { flag: 'logs', key: 'logs', pollKey: 'logsMs' },
  { flag: 'git', key: 'git', pollKey: 'overviewMs' },
  { flag: 'ledger', key: 'ledger', pollKey: 'overviewMs' },
  { flag: 'chainLog', key: 'chainLog', pollKey: 'overviewMs' },
  { flag: 'attempts', key: 'attempts', pollKey: 'attemptsMs' },
]);

const SESSIONS_PATH = '/api/v3/sessions?limit=100';

/**
 * The requests of the Overview page for one instance: `[{ name, path, everyMs }]`. `info` is the `data` of `GET /instance`
 * (`{ poll, panels }`); a panel the config disables is not requested. Throws for an answer without usable intervals.
 */
export function endpointsFor(info) {
  const poll = info?.poll;
  if (poll === null || typeof poll !== 'object') throw new TypeError('the instance answer has no poll intervals');
  const every = (key) => {
    const value = poll[key];
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`poll.${key} is not a positive integer`);
    return value;
  };
  const list = [
    { name: 'health', path: '/api/v3/health', everyMs: every('healthMs') },
    { name: 'sessions', path: SESSIONS_PATH, everyMs: every('sessionsMs') },
    { name: 'overview', path: '/api/v3/overview', everyMs: every('overviewMs') },
  ];
  for (const { flag, key, pollKey } of PANEL_POLL) {
    if (info.panels?.[flag] === true)
      list.push({ name: `panel:${key}`, path: `/api/v3/panels/${key}`, everyMs: every(pollKey) });
  }
  return list;
}

const sharedAgent = new Agent({ keepAlive: true, maxSockets: 8 });

/** One GET on the loopback `port`; resolves `{ status, body }` (`status` 0 for a transport failure) and never rejects. */
export function httpGet(port, path, { host = '127.0.0.1', timeoutMs = 10_000 } = {}) {
  return new Promise((resolvePromise) => {
    const req = httpRequest({ host, port, path, method: 'GET', agent: sharedAgent, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = text;
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON: keep the text
        }
        resolvePromise({ status: res.statusCode ?? 0, body });
      });
      res.on('error', () => resolvePromise({ status: 0, body: null }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolvePromise({ status: 0, body: null }));
    req.end();
  });
}

/** Reads `GET /api/v3/instance` once and returns its `data` (the envelope's payload), or throws. */
export async function fetchInstanceInfo(port, { request = httpGet } = {}) {
  const reply = await request(port, '/api/v3/instance');
  if (reply.status !== 200) throw new Error(`GET /api/v3/instance answered ${String(reply.status)}`);
  const body = reply.body;
  const info = body !== null && typeof body === 'object' && 'data' in body ? body.data : body;
  if (info === null || typeof info !== 'object') throw new Error('GET /api/v3/instance did not answer an object');
  return info;
}

/**
 * Starts one headless client. `options`: `{ port, info, offsetMs = 0, request = httpGet, now = performance.now }`.
 * `info` is the instance answer (`endpointsFor`); `request(port, path)` resolves `{ status }` (replaceable in tests).
 * Resolves `{ stop(): Promise<void>, stats(): Record<name, { requests, errors, minGapMs, everyMs }> }`; `stop()` waits for the
 * requests in flight, after which the poller sends nothing.
 */
export function startPoller(options) {
  const { port, info, offsetMs = 0, request = httpGet, now = () => performance.now() } = options;
  const endpoints = endpointsFor(info);
  const stats = Object.fromEntries(
    endpoints.map((endpoint) => [endpoint.name, { requests: 0, errors: 0, minGapMs: null, everyMs: endpoint.everyMs }]),
  );
  let stopped = false;
  const timers = new Set();
  const inFlight = new Set();

  /** Resolves after `ms`, or at once when the poller is stopped. */
  const sleepUntil = (ms) =>
    new Promise((resolvePromise) => {
      if (stopped) return resolvePromise();
      const handle = { timer: null, resolvePromise };
      handle.timer = setTimeout(
        () => {
          timers.delete(handle);
          resolvePromise();
        },
        Math.max(0, ms),
      );
      timers.add(handle);
    });

  async function loop(endpoint) {
    const entry = stats[endpoint.name];
    // the first request of every loop waits for the client offset
    await sleepUntil(offsetMs);
    let lastStart = null;
    while (!stopped) {
      const started = now();
      if (lastStart !== null) {
        const gap = started - lastStart;
        entry.minGapMs = entry.minGapMs === null ? gap : Math.min(entry.minGapMs, gap);
      }
      lastStart = started;
      entry.requests += 1;
      const pending = request(port, endpoint.path).then(
        (reply) => {
          if (reply.status < 200 || reply.status >= 300) entry.errors += 1;
        },
        () => {
          entry.errors += 1;
        },
      );
      inFlight.add(pending);
      await pending;
      inFlight.delete(pending);
      if (stopped) return;
      await sleepUntil(started + endpoint.everyMs - now());
    }
  }

  const loops = endpoints.map((endpoint) => loop(endpoint));
  return {
    async stop() {
      stopped = true;
      for (const { timer, resolvePromise } of timers) {
        clearTimeout(timer);
        resolvePromise();
      }
      timers.clear();
      await Promise.allSettled([...inFlight, ...loops]);
    },
    stats() {
      return Object.fromEntries(Object.entries(stats).map(([name, entry]) => [name, { ...entry }]));
    },
  };
}

/**
 * Starts `clients` pollers against one instance: reads the intervals from the instance, starts client k at `k * stepMs`
 * (`SECOND_CLIENT_OFFSET_MS` by default). Resolves `{ info, stop(), stats() }` (`stats()` is one record per client).
 */
export async function startPollers({ port, clients, stepMs = SECOND_CLIENT_OFFSET_MS, request = httpGet, now }) {
  const info = await fetchInstanceInfo(port, { request });
  const pollers = Array.from({ length: clients }, (_, index) =>
    startPoller({ port, info, offsetMs: index * stepMs, request, ...(now === undefined ? {} : { now }) }),
  );
  return {
    info,
    async stop() {
      await Promise.all(pollers.map((poller) => poller.stop()));
    },
    stats() {
      return pollers.map((poller) => poller.stats());
    },
  };
}
