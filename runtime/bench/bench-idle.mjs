// B1, B2, B3 and the spawn part of B7 (design 06 section 8.1): memory and CPU of one idle instance and the child processes its
// panels spawn. For each client count one fixture instance is started and `/api/v3/health` is sampled every 5 s for
// `--minutes`; with clients, headless pollers (`lib/pollers.mjs`) replay the UI polling intervals announced by
// `GET /api/v3/instance`, the second one offset by 1.3 s. The CPU figures are the difference of the cumulative
// `cpuUserMicros + cpuSystemMicros` counters of the health report over the wall time between the first and the last sample (a
// monotonic client clock, cross-checked with the server's uptime), never a `ps` snapshot. The child CPU of B3 is the spawn count
// times the calibrated CPU of a child of that kind (`bench/results/calibration-*.json`, written by `calibrate-children.mjs`); without a
// calibration the figure is null and the rows say so.
// The run with no client uses 10 sessions in the window, the runs with a tab 300 (the B1 table rows). The sampling request
// itself is part of what is measured.
// Usage: node bench/bench-idle.mjs [--minutes 10] [--clients 0,1,2] [--launcher <path>] [--report-only]
import { readdirSync, readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildFixture } from './lib/fixtures.mjs';
import { allocateBenchPort, bootstrap, get, releasePort, settleIdle, withInstance } from './lib/instance.mjs';
import { startPollers } from './lib/pollers.mjs';
import { describeRow, evaluateB1, evaluateB2, evaluateB3, evaluateB7, p95, round, summarize } from './lib/stats.mjs';
import { RESULTS_DIR, writeResult } from './lib/target.mjs';

const SAMPLE_MS = 5000;
const MAX_CONSECUTIVE_FAILURES = 3;
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const boot = await bootstrap(process.argv.slice(2), { minutes: { type: 'string' }, clients: { type: 'string' } });

const minutes = Number(boot.values.minutes ?? '10');
if (!Number.isFinite(minutes) || minutes <= 0) {
  process.stderr.write('bench-idle: --minutes must be a positive number\n');
  process.exit(2);
}
const clientCounts = (boot.values.clients ?? '0,1,2').split(',').map((part) => Number(part.trim()));
if (clientCounts.length === 0 || clientCounts.some((count) => ![0, 1, 2].includes(count))) {
  process.stderr.write('bench-idle: --clients takes 0, 1 or 2, or a comma separated list of them\n');
  process.exit(2);
}

/** The newest calibration of this platform (`bench/results/calibration-*.json`), or null. */
function latestCalibration() {
  let names;
  try {
    names = readdirSync(RESULTS_DIR)
      .filter((name) => /^calibration-.+\.json$/.test(name))
      .toSorted()
      .toReversed();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const doc = JSON.parse(readFileSync(join(RESULTS_DIR, name), 'utf8'));
      if (
        doc?.schema === 'mcs.bench/1' &&
        doc.bench === 'calibrate-children' &&
        doc.host?.platform === process.platform
      ) {
        return { name, kinds: doc.kinds ?? {} };
      }
    } catch {
      // an unreadable file is skipped
    }
  }
  return null;
}

/** One sample of `HealthReport`; null when the instance did not answer 200. */
async function sampleHealth(port) {
  const at = performance.now();
  const reply = await get(port, '/api/v3/health', { timeoutMs: 5000 });
  const runtime = reply.body?.runtime;
  if (reply.status !== 200 || runtime === undefined || runtime === null) return null;
  return {
    at,
    pid: runtime.pid,
    uptimeMs: runtime.uptimeMs,
    cpuMicros: runtime.cpuUserMicros + runtime.cpuSystemMicros,
    rssBytes: runtime.rssBytes,
    children: reply.body.children ?? {},
  };
}

/**
 * The figures of one run from its samples. CPU percent is the cumulative CPU over the wall time between first and last sample
 * (100 is one full core). `childCpuPct` is null when a kind that spawned has no calibrated CPU.
 */
function figuresOf(samples, calibration) {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const wallMs = last.at - first.at;
  const cpuMs = (last.cpuMicros - first.cpuMicros) / 1000;
  const intervals = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = samples[i].at - samples[i - 1].at;
    if (dt > 0) intervals.push(((samples[i].cpuMicros - samples[i - 1].cpuMicros) / 1000 / dt) * 100);
  }
  const uptimeDeltaMs = last.uptimeMs - first.uptimeMs;
  const spawns = {};
  let childCpuMs = 0;
  let childKnown = true;
  for (const kind of Object.keys(last.children)) {
    const delta = (last.children[kind]?.spawned ?? 0) - (first.children[kind]?.spawned ?? 0);
    if (delta <= 0) continue;
    spawns[kind] = delta;
    const per = calibration?.kinds?.[kind]?.cpuMsMedian;
    if (typeof per === 'number') childCpuMs += delta * per;
    else childKnown = false;
  }
  const failures = {};
  for (const kind of Object.keys(last.children)) {
    const delta =
      (last.children[kind]?.failed ?? 0) +
      (last.children[kind]?.timedOut ?? 0) -
      ((first.children[kind]?.failed ?? 0) + (first.children[kind]?.timedOut ?? 0));
    if (delta > 0) failures[kind] = delta;
  }
  const perMinute = Object.fromEntries(Object.entries(spawns).map(([kind, n]) => [kind, (n / wallMs) * 60_000]));
  const clockDriftPct = wallMs > 0 ? (Math.abs(uptimeDeltaMs - wallMs) / wallMs) * 100 : null;
  return {
    samples: samples.length,
    wallMs: round(wallMs, 0),
    nodeCpuPct: wallMs > 0 ? round((cpuMs / wallMs) * 100, 3) : null,
    nodeCpuPctIntervalP95: round(p95(intervals), 3),
    childCpuPct: childKnown && wallMs > 0 ? round((childCpuMs / wallMs) * 100, 3) : null,
    rssP95Bytes: p95(samples.map((sample) => sample.rssBytes)),
    rssMaxBytes: Math.max(...samples.map((sample) => sample.rssBytes)),
    spawns,
    spawnsTotal: Object.values(spawns).reduce((sum, n) => sum + n, 0),
    spawnsPerMin: Object.fromEntries(Object.entries(perMinute).map(([kind, n]) => [kind, round(n, 2)])),
    childFailures: failures,
    clockDriftPct: round(clockDriftPct, 2),
    clockNote:
      clockDriftPct !== null && clockDriftPct > 5
        ? 'the server uptime and the client clock disagree by more than 5% (a clock jump or a suspended machine); the figures use the monotonic client clock'
        : null,
  };
}

/** Runs one instance for `minutes` with `clients` headless pollers. Resolves the run record; never throws for a lost instance. */
async function runOnce(clients, calibration) {
  const fixture = await buildFixture({ sessions: clients === 0 ? 10 : 300 });
  const port = await allocateBenchPort();
  const record = {
    clients,
    sessionsInWindow: fixture.sessionCount,
    aborted: null,
    loadStart: loadavg(),
    settled: null,
  };
  const samples = [];
  try {
    await fixture.init(boot.target.launcher, port);
    await withInstance(
      {
        launcher: boot.target.launcher,
        root: fixture.root,
        repo: fixture.repo,
        slug: fixture.slug,
        port,
        env: fixture.env,
      },
      async () => {
        const idle = await settleIdle(port);
        record.settled = idle.settled;
        let pollers = null;
        try {
          const firstSample = await sampleHealth(port);
          if (firstSample === null) {
            record.aborted = 'the instance did not answer health after it settled';
            return;
          }
          samples.push(firstSample);
          if (clients > 0) pollers = await startPollers({ port, clients });
          const startAt = performance.now();
          const endAt = startAt + minutes * 60_000;
          let failures = 0;
          for (let tick = 1; ; tick += 1) {
            const due = startAt + tick * SAMPLE_MS;
            if (due > endAt + SAMPLE_MS / 2) break;
            await sleep(Math.min(due, endAt) - performance.now());
            const sample = await sampleHealth(port);
            if (sample === null) {
              failures += 1;
              if (failures >= MAX_CONSECUTIVE_FAILURES) {
                record.aborted = `the instance stopped answering health after ${String(samples.length)} samples`;
                break;
              }
            } else if (sample.pid !== firstSample.pid) {
              record.aborted = 'the instance process was replaced during the run (its CPU counters restarted)';
              break;
            } else {
              failures = 0;
              samples.push(sample);
            }
            if (performance.now() >= endAt) break;
          }
        } finally {
          if (pollers !== null) {
            record.pollers = pollers.stats();
            await pollers.stop();
          }
        }
      },
    );
  } finally {
    await releasePort(port);
    fixture.dispose();
  }
  record.loadEnd = loadavg();
  record.figures = figuresOf(samples, calibration);
  return record;
}

const calibration = latestCalibration();
const runs = {};
const order = [];
let aborted = null;
try {
  for (const clients of clientCounts) {
    process.stderr.write(`bench-idle: ${String(minutes)} min with ${String(clients)} client(s)\n`);
    const run = await runOnce(clients, calibration);
    runs[String(clients)] = run;
    order.push(clients);
    if (run.aborted !== null) {
      aborted = `clients ${String(clients)}: ${run.aborted}`;
      break;
    }
  }
} finally {
  boot.finish();
}

const figures = (clients) => runs[String(clients)]?.figures ?? null;
const completed = (clients) => runs[String(clients)]?.aborted === null && figures(clients) !== null;
const usable = (clients) => (completed(clients) ? figures(clients) : null);
const platform = boot.host.platform;
const calibratedCpu = (kind) => {
  const value = calibration?.kinds?.[kind]?.cpuMsMax;
  return typeof value === 'number' ? value : null;
};
const samplerKind = platform === 'win32' ? 'powershell.processes' : platform === 'darwin' ? 'ps' : null;
const none = usable(0);
const one = usable(1);
const two = usable(2);

const rows = [
  evaluateB1({ idle: none?.rssP95Bytes ?? null, withTab: one?.rssP95Bytes ?? null }),
  evaluateB2({ cpuPct: none?.nodeCpuPct ?? null, spawns: none?.spawnsTotal ?? null }),
  evaluateB3({
    oneTab: one === null ? null : { selfPct: one.nodeCpuPct, childPct: one.childCpuPct },
    twoTabs: two === null ? null : { selfPct: two.nodeCpuPct, childPct: two.childCpuPct },
  }),
  evaluateB7({
    platform,
    spawnsPerMin: one?.spawnsPerMin ?? null,
    childCpuMs: samplerKind === null ? null : calibratedCpu(samplerKind),
  }),
];
const summary = summarize(rows, boot.host, ['B1', 'B2', 'B3', 'B7']);
const doc = {
  schema: 'mcs.bench/1',
  bench: 'idle',
  at: new Date().toISOString(),
  host: { ...boot.host, loadAverage: loadavg(), cpuCount: cpus().length },
  options: { minutes, clients: clientCounts, sampleMs: SAMPLE_MS },
  calibration: calibration === null ? null : calibration.name,
  aborted,
  runs,
  summary,
};
const file = writeResult('bench-idle', doc);
for (const row of summary.rows) process.stderr.write(`${describeRow(row)}\n`);
if (aborted !== null) process.stderr.write(`bench-idle: aborted, ${aborted}; the figures so far are in the result\n`);
process.stderr.write(`result: ${file}\n`);
process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
process.exitCode = aborted !== null ? 1 : boot.values['report-only'] === true ? 0 : summary.exitCode;
