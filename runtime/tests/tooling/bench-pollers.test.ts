// The headless UI poller `bench/lib/pollers.mjs` (WP-109) and the idle budgets of `bench/lib/stats.mjs` (B1, B2, B3, B7).
// The poller replays the polling intervals of `GET /api/v3/instance`; the tests run it against a stub server on a port of the
// test range and against an injected request function. The `.mjs` modules are loaded with a dynamic import and their exports are
// narrowed here, no declarations exist.
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { allocatePort, assertPortClosed, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const BENCH_LIB = resolve(import.meta.dirname, '..', '..', 'bench', 'lib');

interface Endpoint {
  name: string;
  path: string;
  everyMs: number;
}
interface PollerStats {
  requests: number;
  errors: number;
  minGapMs: number | null;
  everyMs: number;
}
interface Poller {
  stop: () => Promise<void>;
  stats: () => Record<string, PollerStats>;
}
interface Reply {
  status: number;
  body?: unknown;
}
type RequestFn = (port: number, path: string) => Promise<Reply>;
interface PollersModule {
  SECOND_CLIENT_OFFSET_MS: number;
  endpointsFor: (info: unknown) => Endpoint[];
  fetchInstanceInfo: (port: number, opts?: { request?: RequestFn }) => Promise<Record<string, unknown>>;
  startPoller: (opts: { port: number; info: unknown; offsetMs?: number; request?: RequestFn }) => Poller;
  startPollers: (opts: {
    port: number;
    clients: number;
    stepMs?: number;
    request?: RequestFn;
  }) => Promise<{ info: unknown; stop: () => Promise<void>; stats: () => Record<string, PollerStats>[] }>;
}
interface Check {
  name: string;
  figure: number | null;
  limit: number;
  ok: boolean | null;
}
interface Row {
  id: string;
  status: 'PASS' | 'FAIL' | 'NOT MEASURED';
  checks: Check[];
  note: string | null;
}
interface StatsModule {
  evaluateB1: (input: { idle: number | null; withTab: number | null }) => Row;
  evaluateB2: (input: { cpuPct: number | null; spawns: number | null }) => Row;
  evaluateB3: (input: {
    oneTab: { selfPct: number | null; childPct: number | null } | null;
    twoTabs: { selfPct: number | null; childPct: number | null } | null;
  }) => Row;
  evaluateB7: (input: {
    platform: string;
    spawnsPerMin: Record<string, number> | null;
    childCpuMs: number | null;
  }) => Row;
}

async function loadPollers(): Promise<PollersModule> {
  return (await import(pathToFileURL(resolve(BENCH_LIB, 'pollers.mjs')).href)) as PollersModule;
}
async function loadStats(): Promise<StatsModule> {
  return (await import(pathToFileURL(resolve(BENCH_LIB, 'stats.mjs')).href)) as StatsModule;
}

// Real time is what the poller intervals are measured in, so the pause is a wait for the clock rather than a sleep.
async function sleep(ms: number): Promise<void> {
  const end = performance.now() + ms;
  await waitFor(() => performance.now() >= end, { timeoutMs: ms + 5000, intervalMs: 10, what: 'the pause' });
}

const INFO = {
  poll: {
    healthMs: 100,
    sessionsMs: 200,
    overviewMs: 150,
    transcriptMs: 1000,
    machineMs: 100,
    logsMs: 300,
    attemptsMs: 300,
  },
  panels: { git: false, machine: true, attempts: false, ledger: true, chainLog: false, logs: true },
};

describe('endpointsFor', () => {
  it('takes every interval from the instance answer and skips the disabled panels', async () => {
    const { endpointsFor } = await loadPollers();
    const byName = Object.fromEntries(endpointsFor(INFO).map((e) => [e.name, e]));
    expect(Object.keys(byName).toSorted()).toEqual([
      'health',
      'overview',
      'panel:ledger',
      'panel:logs',
      'panel:machine',
      'sessions',
    ]);
    expect(byName['health']?.everyMs).toBe(100);
    expect(byName['panel:ledger']?.everyMs).toBe(150);
    expect(byName['panel:logs']?.path).toBe('/api/v3/panels/logs');
    expect(byName['sessions']?.everyMs).toBe(200);
  });

  it('refuses an answer without usable intervals', async () => {
    const { endpointsFor } = await loadPollers();
    expect(() => endpointsFor({})).toThrow(/poll/);
    expect(() => endpointsFor({ poll: { ...INFO.poll, healthMs: 0 }, panels: INFO.panels })).toThrow(/healthMs/);
    expect(() => endpointsFor({ poll: { ...INFO.poll, sessionsMs: 'x' }, panels: INFO.panels })).toThrow(/sessionsMs/);
  });
});

describe('startPoller with an injected request', () => {
  it('issues each endpoint at its interval, never faster, and sends nothing after stop()', async () => {
    const { startPoller } = await loadPollers();
    const seen = new Map<string, number[]>();
    const request: RequestFn = (_port, path) => {
      const list = seen.get(path) ?? [];
      list.push(performance.now());
      seen.set(path, list);
      return Promise.resolve({ status: 200 });
    };
    const poller = startPoller({ port: 1, info: INFO, request });
    await sleep(1000);
    await poller.stop();
    const total = [...seen.values()].reduce((sum, list) => sum + list.length, 0);
    const health = seen.get('/api/v3/health') ?? [];
    // 100 ms interval over 1 s: the first request at once, then about every 100 ms (generous bounds for a loaded machine)
    expect(health.length).toBeGreaterThanOrEqual(6);
    expect(health.length).toBeLessThanOrEqual(11);
    for (let i = 1; i < health.length; i += 1) {
      // timers may fire a millisecond early; the poller itself must never go below the interval by more than that
      expect((health[i] ?? 0) - (health[i - 1] ?? 0)).toBeGreaterThanOrEqual(98);
    }
    const sessions = seen.get('/api/v3/sessions?limit=100') ?? [];
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    expect(sessions.length).toBeLessThanOrEqual(6);
    const stats = poller.stats();
    expect(stats['health']?.requests).toBe(health.length);
    expect(stats['health']?.minGapMs).toBeGreaterThanOrEqual(98);
    await sleep(400);
    expect([...seen.values()].reduce((sum, list) => sum + list.length, 0)).toBe(total);
  });

  it('does not overlap a slow answer: the next request waits for the previous one', async () => {
    const { startPoller } = await loadPollers();
    const starts: number[] = [];
    const request: RequestFn = async () => {
      starts.push(performance.now());
      await sleep(250);
      return { status: 200 };
    };
    const poller = startPoller({
      port: 1,
      info: { poll: { ...INFO.poll, healthMs: 50 }, panels: {} },
      request: (port, path) => (path === '/api/v3/health' ? request(port, path) : Promise.resolve({ status: 200 })),
    });
    await sleep(900);
    await poller.stop();
    expect(starts.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < starts.length; i += 1)
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(245);
  });

  it('counts a failed or non-2xx answer as an error and keeps polling', async () => {
    const { startPoller } = await loadPollers();
    let calls = 0;
    const request: RequestFn = () => {
      calls += 1;
      return calls % 2 === 0 ? Promise.reject(new Error('down')) : Promise.resolve({ status: 503 });
    };
    const poller = startPoller({ port: 1, info: { poll: { ...INFO.poll, healthMs: 50 }, panels: {} }, request });
    await sleep(300);
    await poller.stop();
    const stats = poller.stats()['health'];
    expect(stats?.requests).toBeGreaterThanOrEqual(3);
    expect(stats?.errors).toBe(stats?.requests);
  });

  it('delays the first request by the client offset', async () => {
    const { startPoller } = await loadPollers();
    const t0 = performance.now();
    const first: number[] = [];
    const request: RequestFn = () => {
      first.push(performance.now() - t0);
      return Promise.resolve({ status: 200 });
    };
    const poller = startPoller({ port: 1, info: INFO, offsetMs: 300, request });
    await sleep(150);
    expect(first).toHaveLength(0);
    await sleep(350);
    await poller.stop();
    expect(first.length).toBeGreaterThan(0);
    expect(Math.min(...first)).toBeGreaterThanOrEqual(295);
  });

  it('stops promptly while waiting for the offset', async () => {
    const { startPoller } = await loadPollers();
    let calls = 0;
    const poller = startPoller({
      port: 1,
      info: INFO,
      offsetMs: 60_000,
      request: () => {
        calls += 1;
        return Promise.resolve({ status: 200 });
      },
    });
    const started = performance.now();
    await poller.stop();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(calls).toBe(0);
  });
});

describe('startPollers against a stub instance', () => {
  let server: Server | undefined;
  afterEach(async () => {
    const listening = server;
    server = undefined;
    if (listening !== undefined)
      await new Promise<void>((done) =>
        listening.close(() => {
          done();
        }),
      );
  });

  it('reads the intervals from /instance and starts the second client at an offset', async () => {
    const { startPollers, SECOND_CLIENT_OFFSET_MS } = await loadPollers();
    expect(SECOND_CLIENT_OFFSET_MS).toBeGreaterThan(0);
    const port = await allocatePort([18760, 18789]);
    const hits: { path: string; at: number }[] = [];
    const t0 = performance.now();
    server = createServer((req, res) => {
      const path = req.url ?? '';
      hits.push({ path, at: performance.now() - t0 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(path === '/api/v3/instance' ? JSON.stringify({ data: INFO }) : '{}');
    });
    const listening = server;
    await new Promise<void>((done) =>
      listening.listen(port, '127.0.0.1', () => {
        done();
      }),
    );

    const run = await startPollers({ port, clients: 2, stepMs: 400 });
    expect((run.info as { poll: { healthMs: number } }).poll.healthMs).toBe(100);
    await sleep(900);
    const stats = run.stats();
    await run.stop();
    expect(stats).toHaveLength(2);
    expect(stats[0]?.['health']?.requests).toBeGreaterThan(stats[1]?.['health']?.requests ?? 0);
    const healthHits = hits.filter((hit) => hit.path === '/api/v3/health');
    expect(healthHits.length).toBeGreaterThan(0);
    // nothing reaches the server after stop()
    const after = hits.length;
    await sleep(300);
    expect(hits.length).toBe(after);
    await new Promise<void>((done) =>
      listening.close(() => {
        done();
      }),
    );
    server = undefined;
    await assertPortClosed(port);
  });

  it('fails clearly when /instance does not answer 200', async () => {
    const { fetchInstanceInfo } = await loadPollers();
    await expect(fetchInstanceInfo(1, { request: () => Promise.resolve({ status: 500 }) })).rejects.toThrow(/500/);
    await expect(fetchInstanceInfo(1, { request: () => Promise.resolve({ status: 0 }) })).rejects.toThrow(/instance/);
  });
});

describe('idle budgets B1, B2, B3 and B7', () => {
  const MB = 1024 * 1024;

  it('B1 compares the RSS p95 of the idle run and of the run with a tab', async () => {
    const { evaluateB1 } = await loadStats();
    expect(evaluateB1({ idle: 90 * MB, withTab: 150 * MB }).status).toBe('PASS');
    expect(evaluateB1({ idle: 111 * MB, withTab: 150 * MB }).status).toBe('FAIL');
    expect(evaluateB1({ idle: 90 * MB, withTab: null }).status).toBe('NOT MEASURED');
    expect(evaluateB1({ idle: 120 * MB, withTab: null }).status).toBe('FAIL');
  });

  it('B2 needs the CPU under 0.3 percent and no child spawn', async () => {
    const { evaluateB2 } = await loadStats();
    expect(evaluateB2({ cpuPct: 0.05, spawns: 0 }).status).toBe('PASS');
    expect(evaluateB2({ cpuPct: 0.31, spawns: 0 }).status).toBe('FAIL');
    expect(evaluateB2({ cpuPct: 0.05, spawns: 1 }).status).toBe('FAIL');
    expect(evaluateB2({ cpuPct: null, spawns: null }).status).toBe('NOT MEASURED');
  });

  it('B3 adds the child CPU to the Node CPU and bounds what a second tab adds', async () => {
    const { evaluateB3 } = await loadStats();
    const pass = evaluateB3({
      oneTab: { selfPct: 1.2, childPct: 0.5 },
      twoTabs: { selfPct: 1.5, childPct: 0.5 },
    });
    expect(pass.status).toBe('PASS');
    expect(
      evaluateB3({ oneTab: { selfPct: 2.0, childPct: 1.5 }, twoTabs: { selfPct: 2.0, childPct: 1.5 } }).status,
    ).toBe('FAIL');
    expect(
      evaluateB3({ oneTab: { selfPct: 1.0, childPct: 0.2 }, twoTabs: { selfPct: 1.8, childPct: 0.2 } }).status,
    ).toBe('FAIL');
    // without a calibration the children are unknown: the row is NOT MEASURED, but a failing self part still fails
    const noChildren = evaluateB3({ oneTab: { selfPct: 1.0, childPct: null }, twoTabs: null });
    expect(noChildren.status).toBe('NOT MEASURED');
    expect(noChildren.note).toMatch(/child CPU/);
    expect(evaluateB3({ oneTab: { selfPct: 3.5, childPct: null }, twoTabs: null }).status).toBe('FAIL');
    expect(evaluateB3({ oneTab: null, twoTabs: null }).status).toBe('NOT MEASURED');
  });

  it('B7 limits the spawns per OS and leaves the CPU part NOT MEASURED without a figure', async () => {
    const { evaluateB7 } = await loadStats();
    expect(evaluateB7({ platform: 'win32', spawnsPerMin: { 'powershell.processes': 3 }, childCpuMs: 187 }).status).toBe(
      'PASS',
    );
    expect(evaluateB7({ platform: 'win32', spawnsPerMin: { 'powershell.processes': 4 }, childCpuMs: 187 }).status).toBe(
      'FAIL',
    );
    expect(evaluateB7({ platform: 'win32', spawnsPerMin: { 'powershell.processes': 3 }, childCpuMs: 260 }).status).toBe(
      'FAIL',
    );
    // the spawn-count part is still evaluated when the CPU part cannot be measured
    const noCpu = evaluateB7({ platform: 'win32', spawnsPerMin: { 'powershell.processes': 6 }, childCpuMs: null });
    expect(noCpu.status).toBe('FAIL');
    const unmeasured = evaluateB7({ platform: 'win32', spawnsPerMin: { 'powershell.processes': 2 }, childCpuMs: null });
    expect(unmeasured.status).toBe('NOT MEASURED');
    expect(unmeasured.note).toMatch(/NOT MEASURED/);
    expect(evaluateB7({ platform: 'darwin', spawnsPerMin: { ps: 3 }, childCpuMs: 10 }).status).toBe('PASS');
    expect(evaluateB7({ platform: 'darwin', spawnsPerMin: { ps: 4 }, childCpuMs: 10 }).status).toBe('FAIL');
    expect(evaluateB7({ platform: 'linux', spawnsPerMin: {}, childCpuMs: null }).status).toBe('PASS');
    expect(evaluateB7({ platform: 'linux', spawnsPerMin: { ps: 1 }, childCpuMs: null }).status).toBe('FAIL');
    expect(evaluateB7({ platform: 'linux', spawnsPerMin: null, childCpuMs: null }).status).toBe('NOT MEASURED');
  });
});
