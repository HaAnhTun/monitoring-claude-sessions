// The flake detector of the pty layer (design 08 sections 4.1 and 4.5): runs `test-pty.mjs` several times and prints, per test, in
// how many runs it passed. A test that passed in some but not all runs is FLAKY. No retry, no quarantine: a flake is fixed by
// isolation. Exit 0 when every test passed in every run, 1 otherwise, 77 when the pty gate cannot run on this platform.
// Usage: node scripts/pty-soak.mjs [--runs 3]
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RUNTIME_ROOT, runNode } from './lib.mjs';
import { SKIP_EXIT, readPtyReport } from './test-pty.mjs';

const DEFAULT_RUNS = 3;

/** The number of runs from `--runs N` (default 3). */
export function parseRuns(argv) {
  const at = argv.indexOf('--runs');
  if (at < 0) return DEFAULT_RUNS;
  const text = argv[at + 1] ?? '';
  if (!/^[1-9]\d*$/.test(text)) throw new Error('--runs must be a positive integer');
  return Number(text);
}

/** Rows `{key, passes, runs, verdict}` from the per-run maps of test name to status. Verdicts: ok, FLAKY, FAILED, SKIPPED. */
export function tally(runs) {
  const names = new Set(runs.flatMap((run) => Object.keys(run)));
  return [...names].sort().map((key) => {
    const statuses = runs.map((run) => run[key]);
    const passes = statuses.filter((status) => status === 'passed').length;
    let verdict = 'ok';
    if (passes < runs.length) {
      if (passes > 0) verdict = 'FLAKY';
      else verdict = statuses.includes('failed') ? 'FAILED' : 'SKIPPED';
    }
    return { key, passes, runs: runs.length, verdict };
  });
}

/** The per-test table of the soak. */
export function renderTable(rows) {
  const lines = ['| test | passes | verdict |', '|---|---|---|'];
  for (const row of rows)
    lines.push(`| ${row.key.replaceAll('|', '/')} | ${row.passes}/${row.runs} | ${row.verdict} |`);
  return lines.join('\n');
}

/** Runs the soak; resolves to the exit code. `io.runOnce(index)` resolves to `{code, tests}` (`tests` is null without a report). */
export async function runSoak(argv, io) {
  const out = (text) => io.stdout.write(`${text}\n`);
  const runs = parseRuns(argv);
  const results = [];
  let problem = false;
  for (let i = 0; i < runs; i += 1) {
    const result = await io.runOnce(i);
    if (i === 0 && result.code === SKIP_EXIT) {
      out('pty-soak: SKIPPED: the pty gate cannot run on this platform (exit 77)');
      return SKIP_EXIT;
    }
    if (result.tests === null) {
      out(`pty-soak: run ${i + 1} produced no report (exit ${result.code})`);
      problem = true;
      results.push({});
      continue;
    }
    if (result.code !== 0) problem = true;
    results.push(result.tests);
  }
  const rows = tally(results);
  out(renderTable(rows));
  const flaky = rows.filter((row) => row.verdict === 'FLAKY');
  for (const row of flaky) out(`FLAKY: ${row.key} passed ${row.passes} of ${row.runs} runs`);
  if (rows.some((row) => row.verdict !== 'ok')) problem = true;
  out(`pty-soak: ${runs} run(s), ${rows.length} test(s), ${flaky.length} flaky: ${problem ? 'FAIL' : 'ok'}`);
  return problem ? 1 : 0;
}

async function runOnceForReal(index) {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-pty-soak-'));
  const file = join(dir, `run-${index}.json`);
  try {
    const code = await runNode(join(RUNTIME_ROOT, 'scripts', 'test-pty.mjs'), ['--json-out', file]);
    if (!existsSync(file)) return { code, tests: null };
    const tests = readPtyReport(JSON.parse(readFileSync(file, 'utf8')), RUNTIME_ROOT);
    return { code, tests: Object.fromEntries(tests.map((t) => [t.name, t.status])) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await runSoak(process.argv.slice(2), { stdout: process.stdout, runOnce: runOnceForReal });
  } catch (error) {
    console.error(`pty-soak: ${error.message}`);
    process.exitCode = 2;
  }
}
