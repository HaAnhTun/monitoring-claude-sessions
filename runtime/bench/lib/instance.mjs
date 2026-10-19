// Starting and stopping instances through the launcher for the benchmarks. Ports come from 18900-18949 (`allocatePort`), an instance
// is always stopped in `finally`, and every started instance is recorded in `<stateDir>/.live.json` so that the next run (or a
// signal handler) can stop what a killed script left behind.
import { readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import { median } from './stats.mjs';
import { RESULTS_DIR, describeHost, loadTestkit, makeEnvFor, resolveTarget, runNode } from './target.mjs';

export const BENCH_PORTS = Object.freeze([18900, 18949]);

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** A free port of 18900-18949, reserved in this process until `releasePort`. */
export async function allocateBenchPort() {
  const { allocatePort } = await loadTestkit();
  return allocatePort(BENCH_PORTS);
}

export async function releasePort(port) {
  const { assertPortClosed } = await loadTestkit();
  await assertPortClosed(port).catch(() => undefined);
}

/** Resolves true when nothing accepts a connection on the loopback `port`. */
export function portClosed(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolvePromise(true);
    });
  });
}

async function waitPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portClosed(port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/** One GET on the loopback `port`. Resolves `{ status, ms, body }` (body parsed when it is JSON, else the text); never rejects. */
export function get(port, path, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolvePromise) => {
    const started = performance.now();
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', agent: false, timeout: timeoutMs }, (res) => {
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
        resolvePromise({ status: res.statusCode ?? 0, ms: performance.now() - started, body });
      });
      res.on('error', () => resolvePromise({ status: 0, ms: performance.now() - started, body: null }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolvePromise({ status: 0, ms: performance.now() - started, body: null }));
    req.end();
  });
}

/** Polls `/api/v3/health` until it answers 200 or the timeout passes. Resolves the health body, or null. */
export async function waitForHealth(port, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reply = await get(port, '/api/v3/health', { timeoutMs: 2000 });
    if (reply.status === 200) return reply.body;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

// ---- the record of started instances ------------------------------------------------------------------------------------------

function liveFile(stateDir) {
  return join(stateDir, '.live.json');
}

function readLive(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(liveFile(stateDir), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLive(stateDir, entries) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(liveFile(stateDir), `${JSON.stringify(entries, null, 2)}\n`);
}

function record(stateDir, entry) {
  writeLive(stateDir, [...readLive(stateDir).filter((e) => e.port !== entry.port), entry]);
}

function forget(stateDir, port) {
  const left = readLive(stateDir).filter((e) => e.port !== port);
  if (left.length === 0) rmSync(liveFile(stateDir), { force: true });
  else writeLive(stateDir, left);
}

function readPid(repo, slug) {
  try {
    const state = JSON.parse(readFileSync(join(repo, '.claude', 'monitor', 'tasks', slug, 'state.json'), 'utf8'));
    return Number.isInteger(state?.pid) && state.pid > 0 ? state.pid : null;
  } catch {
    return null;
  }
}

/** The arguments the launcher takes for one task (01 6.3). */
function taskArgs(command, { repo, slug, port }) {
  return command === 'start'
    ? ['start', '--task', slug, '--repo', repo, '--port', String(port)]
    : ['stop', '--task', slug, '--repo', repo];
}

/**
 * Stops the instance of `entry` (`{ launcher, root, repo, slug, port }`) through the launcher, then makes sure the port is closed
 * (an instance that ignores `stop` is killed by the pid in its `state.json`). Resolves true when the port is closed.
 */
async function stopEntry(entry, env, graceMs = 5000) {
  await runNode(entry.launcher, taskArgs('stop', entry), { env, cwd: entry.root, timeoutMs: 30_000 });
  if (await waitPortClosed(entry.port, graceMs)) return true;
  const pid = readPid(entry.repo, entry.slug);
  if (pid !== null) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  return waitPortClosed(entry.port, 5000);
}

/**
 * Starts an instance through the launcher and waits for health. `opts`: `{ launcher, root, repo, slug, port, env, stateDir, stopGraceMs }`.
 * Resolves `{ port, repo, slug, startMs, healthyMs, stop }`: `startMs` is the wall time of the `start` command and `healthyMs` the
 * time from before `start` was spawned until the first health answer 200 (the figure of B6). A failed start stops what it started.
 */
export async function startInstance(opts) {
  const stateDir = opts.stateDir ?? RESULTS_DIR;
  const entry = { launcher: opts.launcher, root: opts.root, repo: opts.repo, slug: opts.slug, port: opts.port };
  record(stateDir, entry);
  const fail = async (message) => {
    await stopEntry(entry, opts.env, opts.stopGraceMs).catch(() => false);
    forget(stateDir, entry.port);
    throw new Error(message);
  };
  const t0 = performance.now();
  const run = await runNode(opts.launcher, taskArgs('start', entry), {
    env: opts.env,
    cwd: opts.root,
    timeoutMs: 60_000,
  });
  const startMs = performance.now() - t0;
  if (run.code !== 0) {
    return fail(`start exited ${String(run.code)}: ${(run.stderr || run.stdout).trim().split('\n')[0] ?? ''}`);
  }
  const health = await waitForHealth(opts.port, { timeoutMs: opts.healthTimeoutMs ?? 20_000 });
  const healthyMs = performance.now() - t0;
  if (health === null) return fail(`no health answer on port ${String(opts.port)}`);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const closed = await stopEntry(entry, opts.env, opts.stopGraceMs);
    if (!closed) throw new Error(`port ${String(opts.port)} is still open after stop`);
    forget(stateDir, entry.port);
  };
  return { port: opts.port, repo: opts.repo, slug: opts.slug, startMs, healthyMs, health, stop };
}

/** Starts an instance, runs `measured(instance)` and always stops the instance, also when the callback throws. */
export async function withInstance(opts, measured) {
  const instance = await startInstance(opts);
  try {
    return await measured(instance);
  } finally {
    await instance.stop();
  }
}

/**
 * Stops the instances that an earlier run left in `<stateDir>/.live.json` (a script killed in the middle of a run), removes their
 * temp roots and returns `{ reaped, stuck }` (ports). `envFor(root)` gives the environment of the launcher (`hermeticEnv`).
 */
export async function reapStale({ stateDir = RESULTS_DIR, envFor, stopGraceMs }) {
  const reaped = [];
  const stuck = [];
  for (const entry of readLive(stateDir)) {
    const closed = existsSync(entry.launcher)
      ? await stopEntry(entry, envFor(entry.root), stopGraceMs).catch(() => false)
      : false;
    if (closed || (await portClosed(entry.port))) {
      reaped.push(entry.port);
      forget(stateDir, entry.port);
      rmTree(entry.root);
    } else {
      stuck.push(entry.port);
    }
  }
  return { reaped, stuck };
}

/** Removes a temp tree (with retries for Windows file locks). The trees of the benchmarks hold no links. */
export function rmTree(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

/** On SIGINT, SIGTERM and SIGHUP stops the recorded instances before exiting; returns a function that removes the handlers. */
export function installSignalCleanup({ stateDir = RESULTS_DIR, envFor }) {
  const handler = (signal) => {
    reapStale({ stateDir, envFor })
      .catch(() => undefined)
      .finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, handler);
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
}

/**
 * Polls health and the session detail every `intervalMs` until the session's events and usage are complete and nothing is pending
 * (the import of B4 is done). Resolves `{ done, doneAt, rssBytes, eventLoopP99Ms, polls, lastSeen }` (`lastSeen`: the ingestion block and the freshness of the last poll, kept to explain an import that did not finish): `doneAt` is a `performance.now()`
 * reading, the two arrays hold one figure per poll from `HealthReport.runtime`. `isStopped()` lets a caller end the wait early.
 */
export async function awaitImport(
  port,
  sessionId,
  { timeoutMs = 120_000, intervalMs = 100, isStopped = () => false } = {},
) {
  const rssBytes = [];
  const eventLoopP99Ms = [];
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  let lastSeen = null;
  while (Date.now() < deadline && !isStopped()) {
    const health = await get(port, '/api/v3/health', { timeoutMs: 5000 });
    polls += 1;
    if (health.status === 200) {
      const runtime = health.body?.runtime;
      if (typeof runtime?.rssBytes === 'number') rssBytes.push(runtime.rssBytes);
      if (typeof runtime?.eventLoopDelayP99Ms === 'number') eventLoopP99Ms.push(runtime.eventLoopDelayP99Ms);
      const pending = health.body?.ingestion?.transcripts?.pendingBytes;
      lastSeen = { transcripts: health.body?.ingestion?.transcripts ?? null, freshness: lastSeen?.freshness ?? null };
      if (pending === 0) {
        const detail = await get(port, `/api/v3/sessions/${sessionId}`, { timeoutMs: 5000 });
        const fresh = detail.body?.freshness;
        lastSeen = {
          transcripts: lastSeen?.transcripts ?? null,
          freshness: fresh ?? null,
          sessionStatus: detail.status,
        };
        if (detail.status === 200 && fresh?.eventsComplete === true && fresh?.usageComplete === true) {
          return { done: true, doneAt: performance.now(), rssBytes, eventLoopP99Ms, polls, lastSeen };
        }
      }
    }
    await sleep(intervalMs);
  }
  return { done: false, doneAt: performance.now(), rssBytes, eventLoopP99Ms, polls, lastSeen };
}

/** Waits until nothing is pending for `quietMs` (the fixture sessions are imported), then returns the idle RSS: the median of `samples` health reads. */
export async function settleIdle(port, { timeoutMs = 60_000, quietMs = 1500, samples = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let quietSince = null;
  while (Date.now() < deadline) {
    const health = await get(port, '/api/v3/health', { timeoutMs: 5000 });
    const transcripts = health.body?.ingestion?.transcripts;
    const quiet = health.status === 200 && transcripts?.pendingBytes === 0 && transcripts?.filesTracked > 0;
    if (!quiet) quietSince = null;
    else if (quietSince === null) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) break;
    await sleep(200);
  }
  const rss = [];
  for (let i = 0; i < samples; i += 1) {
    const health = await get(port, '/api/v3/health', { timeoutMs: 5000 });
    if (typeof health.body?.runtime?.rssBytes === 'number') rss.push(health.body.runtime.rssBytes);
    await sleep(200);
  }
  return { rssIdleBytes: median(rss), settled: quietSince !== null };
}

/**
 * The start of every benchmark script: parses `--launcher <path>` plus the script's own options, resolves and checks the target,
 * stops the instances an earlier killed run left behind and installs the signal handlers. Resolves
 * `{ values, target, host, envFor, finish }`; `finish()` removes the handlers. An unusable launcher prints the reason and exits 1.
 */
export async function bootstrap(argv, options = {}) {
  const { values } = parseArgs({
    args: argv,
    options: { launcher: { type: 'string' }, 'report-only': { type: 'boolean' }, ...options },
    strict: true,
  });
  let target;
  try {
    target = await resolveTarget({ launcher: values.launcher });
  } catch (error) {
    process.stderr.write(`bench: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  const envFor = await makeEnvFor();
  const { reaped, stuck } = await reapStale({ envFor });
  if (reaped.length > 0) process.stderr.write(`bench: stopped leftover instances on ports ${reaped.join(', ')}\n`);
  if (stuck.length > 0)
    throw new Error(`ports ${stuck.join(', ')} of an earlier run are still open and could not be stopped`);
  const finish = installSignalCleanup({ envFor });
  return { values, target, host: describeHost(target), envFor, finish };
}

/** Positive integer option with a default; throws for anything else. */
export function intOption(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new RangeError(`--${name} must be a positive integer`);
  return parsed;
}
