// Transcript search throughput (ADR 0023, open item O-1 of design 03 section 22): one instance imports a synthetic transcript of
// `--mb` MiB, then `--runs` times the search route of the session answers a no-match needle (a full scan) and a rare needle (a
// full scan that also verifies a few matches). The figure is `coverage.bytesScanned / coverage.elapsedMs` of the server, so the
// HTTP round trip is not in it; the client wall time is reported next to it. The scan is warm: the file was just written and read
// by the importer. A cold figure is taken only where the OS can drop its file cache without a privileged tool (`purge` on macOS, a
// writable `/proc/sys/vm/drop_caches` on Linux, for instance in a container that allows it); on Windows, and wherever the drop is
// refused, the cold figure is NOT MEASURED with the reason, never estimated. The result ends with the recommendation for the default
// `budgetMs`: below 200 MB/s the default rises from 3000 to 5000 (ADR 0023).
// Usage: node bench/bench-search.mjs [--mb 120] [--runs 3] [--launcher <path>] [--report-only]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';

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
import { median, round, summarizeSamples } from './lib/stats.mjs';
import { writeResult } from './lib/target.mjs';

const MIB = 1024 * 1024;
const THRESHOLD_MBPS = 200;
const DEFAULT_BUDGET_MS = 3000;
const RAISED_BUDGET_MS = 5000;
const SCAN_BUDGET_MS = 10_000; // the maximum the route accepts: the scan is measured to its end
const NO_MATCH = 'zzqx-no-such-needle';
const RARE = 'big answer 777 lorem';

const boot = await bootstrap(process.argv.slice(2), { mb: { type: 'string' }, runs: { type: 'string' } });
const mb = intOption(boot.values.mb, 120, 'mb');
const runs = intOption(boot.values.runs, 3, 'runs');

/**
 * Drops the file cache where the OS allows it without a privileged tool. Resolves `{ ok: true, method }` or
 * `{ ok: false, reason }`; never throws.
 */
function dropFileCache() {
  if (process.platform === 'win32') {
    return { ok: false, reason: 'Windows has no way to drop the file cache without a privileged tool' };
  }
  if (process.platform === 'darwin') {
    const done = spawnSync('purge', [], { encoding: 'utf8' });
    return done.status === 0
      ? { ok: true, method: 'purge' }
      : { ok: false, reason: 'purge failed or needs a privileged user' };
  }
  if (process.platform === 'linux') {
    spawnSync('sync', []);
    try {
      writeFileSync('/proc/sys/vm/drop_caches', '3');
      return { ok: true, method: 'drop_caches' };
    } catch {
      return { ok: false, reason: '/proc/sys/vm/drop_caches is not writable here (no privileged container)' };
    }
  }
  return { ok: false, reason: `no cache drop is known for ${process.platform}` };
}

/** One search of the session; resolves the figures of the reply, or `{ error }`. */
async function search(port, sessionId, q) {
  const path = `/api/v3/search/transcript?session=${sessionId}&q=${encodeURIComponent(q)}&budgetMs=${String(SCAN_BUDGET_MS)}&limit=50`;
  const started = performance.now();
  const reply = await get(port, path, { timeoutMs: 60_000 });
  const clientMs = performance.now() - started;
  const body = reply.body;
  const coverage = body?.coverage;
  if (reply.status !== 200 || coverage === undefined) {
    return { error: `the search answered ${String(reply.status)}`, clientMs };
  }
  const seconds = coverage.elapsedMs / 1000;
  return {
    bytesScanned: coverage.bytesScanned,
    bytesInScope: coverage.bytesInScope,
    elapsedMs: coverage.elapsedMs,
    clientMs: round(clientMs, 1),
    matches: body.count ?? body.matches?.length ?? 0,
    stoppedBy: coverage.stoppedBy,
    complete: coverage.complete,
    // an elapsed time of 0 ms (a scan under a millisecond) has no meaningful rate
    mbPerSec: seconds > 0 ? round(coverage.bytesScanned / MIB / seconds, 1) : null,
  };
}

async function measure() {
  const fixture = await buildFixture({ sessions: 8 });
  const port = await allocateBenchPort();
  try {
    await fixture.init(boot.target.launcher, port);
    return await withInstance(
      {
        launcher: boot.target.launcher,
        root: fixture.root,
        repo: fixture.repo,
        slug: fixture.slug,
        port,
        env: fixture.env,
      },
      async () => {
        await settleIdle(port);
        const big = fixture.writeBig(mb);
        const importStarted = performance.now();
        const imported = await awaitImport(port, big.sessionId, { timeoutMs: 300_000 });
        const indexMs = imported.doneAt - importStarted;
        if (!imported.done) return { big, imported: false, indexMs, lastSeen: imported.lastSeen };
        const warm = { noMatch: [], rare: [] };
        for (let i = 0; i < runs; i += 1) {
          warm.noMatch.push(await search(port, big.sessionId, NO_MATCH));
          warm.rare.push(await search(port, big.sessionId, RARE));
        }
        const drop = dropFileCache();
        let cold = null;
        if (drop.ok) cold = await search(port, big.sessionId, NO_MATCH);
        return { big, imported: true, indexMs, warm, drop, cold };
      },
    );
  } finally {
    await releasePort(port);
    fixture.dispose();
  }
}

/** The text of the recommendation; quotes the measured rate (warm, and cold when it exists). */
function recommend(warmMbps, coldMbps) {
  if (warmMbps === null) {
    return 'No recommendation: no complete scan produced a rate (the scan was under 1 ms or did not finish).';
  }
  const slowest = coldMbps === null ? warmMbps : Math.min(warmMbps, coldMbps);
  const basis =
    coldMbps === null
      ? `${String(warmMbps)} MB/s warm; the cold rate was not measured`
      : `${String(warmMbps)} MB/s warm and ${String(coldMbps)} MB/s cold`;
  return slowest < THRESHOLD_MBPS
    ? `Raise the default budgetMs from ${String(DEFAULT_BUDGET_MS)} to ${String(RAISED_BUDGET_MS)}: measured ${basis}, below ${String(THRESHOLD_MBPS)} MB/s (ADR 0023).`
    : `Keep the default budgetMs at ${String(DEFAULT_BUDGET_MS)}: measured ${basis}, at or above ${String(THRESHOLD_MBPS)} MB/s (ADR 0023); ${String(DEFAULT_BUDGET_MS)} ms covers about ${String(Math.round((slowest * DEFAULT_BUDGET_MS) / 1000))} MB.`;
}

let exitCode = 0;
try {
  const m = await measure();
  const doc = {
    schema: 'mcs.bench/1',
    bench: 'search',
    at: new Date().toISOString(),
    host: { ...boot.host, loadAverage: loadavg(), cpuCount: cpus().length },
    options: {
      mb,
      runs,
      needles: { noMatch: 'a string absent from the transcript', rare: 'a string present in a few lines' },
    },
    transcriptBytes: m.big.bytes,
    writeMs: round(m.big.writeMs, 0),
    indexMs: round(m.indexMs, 0),
    indexMBPerSec: m.indexMs > 0 ? round(m.big.bytes / MIB / (m.indexMs / 1000), 1) : null,
    imported: m.imported,
  };
  if (!m.imported) {
    doc.error = 'the import did not finish in time; no search was run';
    doc.lastSeen = m.lastSeen;
    exitCode = 1;
  } else {
    const completeRates = (list) =>
      list.filter((r) => r.error === undefined && r.complete && r.mbPerSec !== null).map((r) => r.mbPerSec);
    const figures = (list) => ({
      runs: list,
      ...summarizeSamples(completeRates(list)),
    });
    const warmNoMatch = completeRates(m.warm.noMatch);
    const warmMbps = median(warmNoMatch);
    const cold =
      m.cold === null ? null : m.cold.error === undefined && m.cold.mbPerSec !== null ? m.cold.mbPerSec : null;
    doc.warm = {
      kind: 'warm',
      note: 'the file was written and read by the importer a moment before: the OS cache holds it',
      noMatch: figures(m.warm.noMatch),
      rare: figures(m.warm.rare),
    };
    doc.cold = m.drop.ok
      ? {
          kind: 'cold',
          method: m.drop.method,
          run: m.cold,
          mbPerSec: cold,
          status: cold === null ? 'NOT MEASURED' : 'measured',
        }
      : { kind: 'cold', status: 'NOT MEASURED', reason: m.drop.reason };
    doc.stoppedBy = [...m.warm.noMatch, ...m.warm.rare, ...(m.cold === null ? [] : [m.cold])].map(
      (r) => r.stoppedBy ?? `error: ${r.error}`,
    );
    doc.warmMBPerSec = round(warmMbps, 1);
    doc.recommendation = recommend(round(warmMbps, 1), cold);
    if (doc.stoppedBy.some((value) => value !== 'complete')) {
      doc.recommendation += ' Some searches did not scan to the end; see stoppedBy.';
    }
    if (warmMbps === null) exitCode = 1;
    process.stderr.write(`${doc.recommendation}\n`);
    process.stderr.write(`cold: ${doc.cold.status}${doc.cold.reason === undefined ? '' : ` (${doc.cold.reason})`}\n`);
  }
  const file = writeResult('bench-search', doc);
  process.stderr.write(`result: ${file}\n`);
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
} finally {
  boot.finish();
}
// a search benchmark has no pass or fail budget: it fails only when it produced no figure
process.exitCode = boot.values['report-only'] === true ? 0 : exitCode;
