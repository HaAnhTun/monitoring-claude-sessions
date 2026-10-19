// B6 (design 06 section 8.1): start to healthy. A warm-up start imports the fixture sessions into a workspace; the measured
// starts then run on an existing database with nothing to import. Each run is `start`, first health answer 200, `stop`, timed
// from before `start` is spawned. Usage: node bench/bench-start.mjs [--runs 5] [--launcher <path>] [--report-only]
import { buildFixture } from './lib/fixtures.mjs';
import { allocateBenchPort, bootstrap, intOption, releasePort, settleIdle, startInstance } from './lib/instance.mjs';
import { describeRow, evaluateB6, median, round, summarize, summarizeSamples } from './lib/stats.mjs';
import { writeResult } from './lib/target.mjs';

const boot = await bootstrap(process.argv.slice(2), { runs: { type: 'string' } });
const runs = intOption(boot.values.runs, 5, 'runs');
let exitCode;
try {
  const fixture = await buildFixture({ sessions: 100 });
  const port = await allocateBenchPort();
  const timings = [];
  try {
    await fixture.init(boot.target.launcher, port);
    const common = {
      launcher: boot.target.launcher,
      root: fixture.root,
      repo: fixture.repo,
      slug: fixture.slug,
      port,
      env: fixture.env,
    };
    const warm = await startInstance(common);
    try {
      const idle = await settleIdle(port);
      if (!idle.settled) process.stderr.write('bench-start: the warm-up import did not settle in time\n');
    } finally {
      await warm.stop();
    }
    for (let run = 0; run < runs; run += 1) {
      const instance = await startInstance(common);
      try {
        timings.push({
          run: run + 1,
          startCommandMs: round(instance.startMs),
          startToHealthyMs: round(instance.healthyMs),
        });
      } finally {
        await instance.stop();
      }
    }
  } finally {
    await releasePort(port);
    fixture.dispose();
  }
  const figures = timings.map((t) => t.startToHealthyMs);
  const row = evaluateB6(figures);
  const summary = summarize([row], boot.host, ['B6']);
  const doc = {
    schema: 'mcs.bench/1',
    bench: 'start',
    at: new Date().toISOString(),
    host: boot.host,
    runs: timings,
    median: { startToHealthyMs: round(median(figures)) },
    spread: summarizeSamples(figures),
    summary,
  };
  const file = writeResult('bench-start', doc);
  process.stderr.write(`${describeRow(row)}\nresult: ${file}\n`);
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  exitCode = boot.values['report-only'] === true ? 0 : summary.exitCode;
} finally {
  boot.finish();
}
process.exitCode = exitCode;
