// B5 (design 06 section 8.1): API latency. Idle phase: `--requests` sequential requests (after a warm-up) and the same number at
// concurrency 4 per endpoint: the sessions page (100 sessions), a 250-event transcript page and every enabled `/panels/*`. A
// panel that does not answer 200 (route missing, panel disabled) is recorded with its status and not measured. Import phase:
// requests round-robin over the same endpoints while a big transcript is imported (`--mb`). The verdict uses the sequential idle
// p95 per endpoint and the p95 of the import phase; the concurrent figures are reported next to them.
// Usage: node bench/bench-api.mjs [--requests 200] [--mb 70] [--launcher <path>] [--report-only]
import { buildFixture } from './lib/fixtures.mjs';
import {
  allocateBenchPort,
  awaitImport,
  bootstrap,
  get,
  intOption,
  releasePort,
  settleIdle,
  withInstance,
} from './lib/instance.mjs';
import { describeRow, evaluateB5, round, summarize, summarizeSamples } from './lib/stats.mjs';
import { writeResult } from './lib/target.mjs';

const boot = await bootstrap(process.argv.slice(2), {
  requests: { type: 'string' },
  mb: { type: 'string' },
  concurrency: { type: 'string' },
});
const requests = intOption(boot.values.requests, 200, 'requests');
const mb = intOption(boot.values.mb, 70, 'mb');
const concurrency = intOption(boot.values.concurrency, 4, 'concurrency');
const PANEL_KEYS = ['machine', 'git', 'logs', 'ledger', 'chain_log', 'attempts'];
const WARMUP = 5;

function endpoints(pageSessionId) {
  return [
    { name: 'sessions', path: '/api/v3/sessions?limit=100' },
    { name: 'transcript', path: `/api/v3/sessions/${pageSessionId}/transcript?limit=250` },
    ...PANEL_KEYS.map((key) => ({ name: `panel:${key}`, path: `/api/v3/panels/${key}` })),
  ];
}

/** Warms an endpoint; resolves its status of the last warm-up request (panels fill their cache on the first read). */
async function warm(port, path) {
  let status = 0;
  for (let i = 0; i < WARMUP; i += 1) status = (await get(port, path)).status;
  return status;
}

async function sequential(port, path, count) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const reply = await get(port, path);
    if (reply.status === 200) samples.push(reply.ms);
  }
  return samples;
}

async function concurrent(port, path, count) {
  const samples = [];
  let next = 0;
  const worker = async () => {
    while (next < count) {
      next += 1;
      const reply = await get(port, path);
      if (reply.status === 200) samples.push(reply.ms);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return samples;
}

const figures = (samples) => {
  const s = summarizeSamples(samples);
  return Object.fromEntries(Object.entries(s).map(([key, value]) => [key, key === 'n' ? value : round(value, 2)]));
};

async function measure() {
  const fixture = await buildFixture({ sessions: 100 });
  const port = await allocateBenchPort();
  try {
    await fixture.init(boot.target.launcher, port);
    const opts = {
      launcher: boot.target.launcher,
      root: fixture.root,
      repo: fixture.repo,
      slug: fixture.slug,
      port,
      env: fixture.env,
    };
    return await withInstance(opts, async () => {
      const idleState = await settleIdle(port);
      const list = endpoints(fixture.pageSessionId);
      const statuses = {};
      const idle = {};
      for (const endpoint of list) {
        statuses[endpoint.name] = await warm(port, endpoint.path);
        if (statuses[endpoint.name] !== 200) {
          idle[endpoint.name] = { status: statuses[endpoint.name], sequential: figures([]), concurrent: figures([]) };
          continue;
        }
        const seq = figures(await sequential(port, endpoint.path, requests));
        const con = figures(await concurrent(port, endpoint.path, requests));
        idle[endpoint.name] = { status: 200, sequential: seq, concurrent: con };
      }
      // during the first import of the big transcript
      const measured = list.filter((endpoint) => statuses[endpoint.name] === 200);
      const big = fixture.writeBig(mb);
      let finished = false;
      const watching = awaitImport(port, big.sessionId, { timeoutMs: 180_000 }).finally(() => {
        finished = true;
      });
      const duringByEndpoint = Object.fromEntries(measured.map((endpoint) => [endpoint.name, []]));
      const all = [];
      while (!finished && measured.length > 0) {
        for (const endpoint of measured) {
          if (finished) break;
          const reply = await get(port, endpoint.path, { timeoutMs: 20_000 });
          if (reply.status === 200) {
            duringByEndpoint[endpoint.name].push(reply.ms);
            all.push(reply.ms);
          }
        }
      }
      const imported = await watching;
      return { idleState, idle, statuses, duringByEndpoint, all, imported, transcriptBytes: big.bytes };
    });
  } finally {
    await releasePort(port);
    fixture.dispose();
  }
}

let exitCode;
try {
  const m = await measure();
  const idleForVerdict = Object.fromEntries(
    Object.entries(m.idle).map(([name, entry]) => [name, { p95: entry.sequential.p95, n: entry.sequential.n }]),
  );
  const MIN_DURING_SAMPLES = 10;
  const duringAll = figures(m.all);
  const during = {
    all: m.all.length >= MIN_DURING_SAMPLES ? duringAll : { ...duringAll, p95: null },
    note:
      m.all.length >= MIN_DURING_SAMPLES
        ? null
        : `only ${String(m.all.length)} requests completed while the import ran (fewer than ${String(MIN_DURING_SAMPLES)})`,
    importCompleted: m.imported.done,
    byEndpoint: Object.fromEntries(Object.entries(m.duringByEndpoint).map(([name, s]) => [name, figures(s)])),
  };
  const row = evaluateB5({ idle: idleForVerdict, during });
  const summary = summarize([row], boot.host, ['B5']);
  const doc = {
    schema: 'mcs.bench/1',
    bench: 'api',
    at: new Date().toISOString(),
    host: boot.host,
    options: { requests, concurrency, mb },
    idle: m.idle,
    duringImport: during,
    summary,
  };
  const file = writeResult('bench-api', doc);
  process.stderr.write(`${describeRow(row)}\nresult: ${file}\n`);
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  exitCode = boot.values['report-only'] === true ? 0 : summary.exitCode;
} finally {
  boot.finish();
}
process.exitCode = exitCode;
