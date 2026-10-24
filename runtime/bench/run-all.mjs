// `npm run bench`: runs every bench/bench-*.mjs in name order (one child process each, forwarding --launcher), reads the JSON
// document each prints, and writes bench/results/summary-<UTC stamp>.json with one PASS, FAIL or NOT MEASURED row per budget
// B1..B7. Exit 1 when a budget fails on the host class of the budget table; `--report-only` always exits 0.
// Usage: node bench/run-all.mjs [--launcher <path>] [--report-only]
import { readdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { describeRow, notMeasured, summarize } from './lib/stats.mjs';
import { BENCH_DIR, RESULTS_DIR, describeHost, resolveTarget, runNode, writeResult } from './lib/target.mjs';

/** The budgets each script answers for (design 06 section 8.3). */
const BUDGETS_OF = {
  'bench-api.mjs': ['B5'],
  'bench-first-import.mjs': ['B4'],
  'bench-idle.mjs': ['B1', 'B2', 'B3', 'B7'],
  'bench-search.mjs': [],
  'bench-start.mjs': ['B6'],
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { launcher: { type: 'string' }, 'report-only': { type: 'boolean' } },
  strict: true,
});

let host;
try {
  host = describeHost(await resolveTarget({ launcher: values.launcher }));
} catch (error) {
  process.stderr.write(`bench: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const scripts = readdirSync(BENCH_DIR)
  .filter((name) => /^bench-.+\.mjs$/.test(name))
  .toSorted();
const forwarded = [
  ...(values.launcher === undefined ? [] : ['--launcher', values.launcher]),
  ...(values['report-only'] === true ? ['--report-only'] : []),
];

const rows = [];
const runs = [];
for (const script of scripts) {
  process.stderr.write(`bench: ${script}\n`);
  const run = await runNode(join(BENCH_DIR, script), forwarded, {
    cwd: BENCH_DIR,
    env: process.env,
    timeoutMs: 2_400_000,
  });
  let doc = null;
  try {
    doc = JSON.parse(run.stdout);
  } catch {
    // reported below as a script that produced no document
  }
  const own = doc?.summary?.rows?.filter((row) => (BUDGETS_OF[script] ?? []).includes(row.id)) ?? [];
  if (own.length === 0) {
    const reason = (run.stderr.trim().split('\n').at(-1) ?? '') || `exit ${String(run.code)}`;
    for (const id of BUDGETS_OF[script] ?? []) rows.push(notMeasured(id, `${script} produced no result: ${reason}`));
  } else {
    rows.push(...own);
  }
  runs.push({ script, exitCode: run.code, produced: doc !== null });
}

const summary = summarize(rows, { ...host, cpus: cpus().length });
for (const row of summary.rows) process.stderr.write(`${describeRow(row)}\n`);
if (!summary.asserted) {
  process.stderr.write(
    'bench: this host is not the class of the budget table (Windows 11, 12 logical CPUs, Node 24): figures are reported, budgets are not asserted\n',
  );
}
const doc = { schema: 'mcs.bench-summary/1', at: new Date().toISOString(), scripts: runs, ...summary };
const file = writeResult('summary', doc, { dir: RESULTS_DIR });
process.stderr.write(`bench: summary ${file}\n`);
process.exitCode = values['report-only'] === true ? 0 : summary.exitCode;
