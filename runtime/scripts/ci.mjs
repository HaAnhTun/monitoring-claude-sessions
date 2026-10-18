// Local CI: runs every gate in a fixed order and prints a result table. Zero dependencies.
// Usage: npm run ci [-- --offline] [-- --keep-going]   |   npm run ci:full (adds the slow suites + e2e)
// `--bundle` adds `bundle:check` and a smoke run through the bundle after `smoke` (ADR 0063 item 7).
// `--summary-json <file>` also writes the `mcs.ci-run/1` summary (gate results, durations, the last 40 output lines of the
// failing gate) that `scripts/ci-status.mjs summarize` turns into a job record (ADR 0065 item 3).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { binPath, RUNTIME_ROOT, runNode } from './lib.mjs';

const argv = process.argv.slice(2);
const args = new Set(argv);
const summaryAt = argv.indexOf('--summary-json');
const summaryJson = summaryAt === -1 ? undefined : argv[summaryAt + 1];
if (summaryAt !== -1 && (summaryJson === undefined || summaryJson.startsWith('--'))) {
  console.error('ci: --summary-json needs a file path');
  process.exit(2);
}
const full = args.has('--full');
const offline = args.has('--offline');
const keepGoing = args.has('--keep-going');
const strict = args.has('--strict'); // release-check: a SKIPPED gate fails
const bundle = args.has('--bundle');
// npm_execpath is set when run through npm; otherwise fall back to the npm CLI bundled next to this node binary (lead decision, CR-WP-01-2).
function resolveNpmCli() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  const root = dirname(process.execPath);
  const candidates = [
    join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(root, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
const npmCli = resolveNpmCli();
const SKIP_EXIT = 77; // a gate that cannot run yet (smoke before 01 S8/S9); shown as SKIPPED, never as PASS
const SKIPPED = `SKIPPED (exit ${SKIP_EXIT})`;

const steps = [
  ['format:check', binPath('prettier'), ['--check', '.', '--log-level', 'warn']],
  ['lint', binPath('eslint'), ['.', '--max-warnings', '0']],
  ['typecheck', 'scripts/typecheck.mjs', []],
  ['check:deps', 'scripts/check-deps.mjs', []],
  // @wp-begin WP-75
  // @wp-end WP-75
  // `build` runs before `test`: about 150 tests spawn dist/main.js, dist/hook.js or dist/boot.js and read .mcs-build.json.
  // The standalone `test:int`, `test:isolation` and `test:resilience` scripts need `npm run build` first as well.
  ['build', npmCli, ['run', 'build']],
  [
    'test',
    binPath('vitest'),
    [
      'run',
      '--project',
      'unit',
      '--project',
      'web',
      '--project',
      'integration',
      '--project',
      'isolation',
      '--project',
      'resilience',
      // @wp-begin WP-72
      // @wp-end WP-72
    ],
  ],
  ['smoke', 'scripts/smoke.mjs', []],
];
// @wp-begin WP-84
if (bundle) {
  steps.push(['bundle:check', 'scripts/bundle.mjs', ['--check']]);
  steps.push(['smoke:bundle', 'scripts/smoke.mjs', ['--bundle']]);
}
// @wp-end WP-84
if (!offline) steps.push(['audit', npmCli, ['audit', '--audit-level=low']]);
if (full) {
  steps.push(['test:slow', binPath('vitest'), ['run', '--project', 'slow']]);
  steps.push([
    'test:e2e',
    binPath('@playwright/test', 'playwright'),
    ['test', '-c', 'packages/web/e2e/playwright.config.ts'],
  ]);
}

const TAIL_LINES = 40;

/** Like `runNode`, but tees the output and keeps its last lines (for `--summary-json`). Resolves to `{ code, tail }`. */
function runCaptured(script, stepArgs) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, ...stepArgs], {
      cwd: RUNTIME_ROOT,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let lines = [''];
    const keep = (chunk) => {
      const parts = chunk.toString('utf8').split(/\r?\n/);
      lines[lines.length - 1] += parts[0];
      lines.push(...parts.slice(1));
      if (lines.length > TAIL_LINES + 1) lines = lines.slice(-(TAIL_LINES + 1));
    };
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      keep(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      keep(chunk);
    });
    const tail = () => (lines.at(-1) === '' ? lines.slice(0, -1) : lines).slice(-TAIL_LINES);
    child.on('error', () => resolvePromise({ code: 127, tail: tail() }));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, tail: tail() }));
  });
}

const results = [];
let failedTail = [];
for (const [name, script, stepArgs] of steps) {
  if (script === undefined) {
    results.push([name, 'SKIPPED (npm CLI not found: run through npm so npm_execpath is set)', 0]);
    continue;
  }
  const started = Date.now();
  console.log(`\n=== ${name}`);
  const { code, tail } =
    summaryJson === undefined
      ? { code: await runNode(script, stepArgs), tail: [] }
      : await runCaptured(script, stepArgs);
  if (code !== 0 && code !== SKIP_EXIT && failedTail.length === 0) failedTail = tail;
  const result = code === 0 ? 'PASS' : code === SKIP_EXIT ? SKIPPED : `FAIL (exit ${code})`;
  results.push([name, result, Date.now() - started]);
  if (name === 'build' && result.startsWith('FAIL') && keepGoing) {
    console.log(
      'note: the build gate failed; tests that spawn dist/ fail because of that, not because of their own code.',
    );
  }
  if (result.startsWith('FAIL') && !keepGoing) break;
}

console.log('\n| gate | result | ms |\n|---|---|---|');
for (const [name, result, ms] of results) console.log(`| ${name} | ${result} | ${ms} |`);
const notRun = steps.slice(results.length).map(([name]) => name);
if (notRun.length > 0) console.log(`not run: ${notRun.join(', ')}`);
const ok = (r) => r === 'PASS' || (r === SKIPPED && !strict);
process.exitCode = results.every(([, r]) => ok(r)) && notRun.length === 0 ? 0 : 1;

if (summaryJson !== undefined) {
  const short = (r) => (r === 'PASS' ? 'pass' : r.startsWith('SKIPPED') ? 'skipped' : 'fail');
  const failed = results.find(([, r]) => short(r) === 'fail');
  const summary = {
    schema: 'mcs.ci-run/1',
    result: process.exitCode === 0 ? 'pass' : 'fail',
    gates: [
      ...results.map(([name, r, ms]) => ({ name, result: short(r), ms })),
      ...notRun.map((name) => ({ name, result: 'not-run', ms: 0 })),
    ],
    failedGate: failed === undefined ? null : failed[0],
    tail: failed === undefined ? [] : failedTail,
  };
  const target = resolve(RUNTIME_ROOT, summaryJson);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`);
}
