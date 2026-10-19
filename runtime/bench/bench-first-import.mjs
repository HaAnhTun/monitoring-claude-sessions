// B4 (design 06 section 8.1): the first import of a big transcript. Per run a fresh fixture (100 sessions) is imported and
// settles, the idle RSS is read, then a transcript of `--mb` MiB appears in the project folder and the clock runs until the
// session's events and usage are complete and nothing is pending. Every figure is a timer reading or a `HealthReport` field
// (`runtime.rssBytes`, `runtime.eventLoopDelayP99Ms`, `ingestion.transcripts.pendingBytes`). The event-loop figure is the highest
// p99 the health report showed while the import ran (the report's histogram is reset once a minute).
// Usage: node bench/bench-first-import.mjs [--mb 70] [--runs 3] [--launcher <path>] [--report-only]
import { performance } from 'node:perf_hooks';

import { buildFixture } from './lib/fixtures.mjs';
import {
  allocateBenchPort,
  awaitImport,
  bootstrap,
  intOption,
  releasePort,
  settleIdle,
  withInstance,
} from './lib/instance.mjs';
import { describeRow, evaluateB4, maximum, median, round, summarize } from './lib/stats.mjs';
import { writeResult } from './lib/target.mjs';

const boot = await bootstrap(process.argv.slice(2), { mb: { type: 'string' }, runs: { type: 'string' } });
const mb = intOption(boot.values.mb, 70, 'mb');
const runs = intOption(boot.values.runs, 3, 'runs');
const MiB = 1024 * 1024;

async function oneRun(index) {
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
    return await withInstance(opts, async (instance) => {
      const idle = await settleIdle(port);
      const big = fixture.writeBig(mb);
      const startedAt = performance.now();
      const watched = await awaitImport(port, big.sessionId, { timeoutMs: 180_000 });
      const wallMs = watched.doneAt - startedAt;
      return {
        run: index + 1,
        completed: watched.done,
        transcriptBytes: big.bytes,
        startToHealthyMs: round(instance.healthyMs),
        wallMs: round(wallMs),
        eventLoopP99MaxMs: round(maximum(watched.eventLoopP99Ms)),
        rssIdleBytes: idle.rssIdleBytes,
        rssPeakBytes: maximum(watched.rssBytes),
        rssGrowthMiB: round(
          typeof idle.rssIdleBytes === 'number' ? (maximum(watched.rssBytes) - idle.rssIdleBytes) / MiB : null,
        ),
        polls: watched.polls,
        idleSettled: idle.settled,
        lastSeen: watched.done ? undefined : watched.lastSeen,
      };
    });
  } finally {
    await releasePort(port);
    fixture.dispose();
  }
}

let exitCode;
try {
  const results = [];
  for (let index = 0; index < runs; index += 1) results.push(await oneRun(index));
  // an import that did not finish in time exceeds the wall budget by far: the row fails, with the count in its note
  const completed = results.filter((r) => r.completed);
  const row =
    completed.length === results.length ? evaluateB4(completed) : { ...evaluateB4(completed), status: 'FAIL' };
  if (completed.length < results.length) {
    row.note = `${String(results.length - completed.length)} of ${String(results.length)} imports did not complete within 180 s`;
  }
  const summary = summarize([row], boot.host, ['B4']);
  const doc = {
    schema: 'mcs.bench/1',
    bench: 'first-import',
    at: new Date().toISOString(),
    host: boot.host,
    options: { mb, runs },
    runs: results,
    median: {
      wallMs: round(median(completed.map((r) => r.wallMs))),
      eventLoopP99MaxMs: round(median(completed.map((r) => r.eventLoopP99MaxMs))),
      rssGrowthMiB: round(median(completed.map((r) => r.rssGrowthMiB))),
    },
    summary,
  };
  const file = writeResult('bench-first-import', doc);
  process.stderr.write(`${describeRow(row)}\nresult: ${file}\n`);
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  exitCode = boot.values['report-only'] === true ? 0 : summary.exitCode;
} finally {
  boot.finish();
}
process.exitCode = exitCode;
