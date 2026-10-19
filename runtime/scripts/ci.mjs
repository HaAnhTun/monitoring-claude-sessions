// Local CI: runs every gate in a fixed order and prints a result table. Zero dependencies.
// Usage: npm run ci [-- --offline] [-- --keep-going]   |   npm run ci:full (adds the slow suites + e2e)
// `--bundle` adds `bundle:check` and a smoke run through the bundle after `smoke` (ADR 0063 item 7).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { binPath, runNode } from './lib.mjs';

const args = new Set(process.argv.slice(2));
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

const results = [];
for (const [name, script, stepArgs] of steps) {
  if (script === undefined) {
    results.push([name, 'SKIPPED (npm CLI not found: run through npm so npm_execpath is set)', 0]);
    continue;
  }
  const started = Date.now();
  console.log(`\n=== ${name}`);
  const code = await runNode(script, stepArgs);
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
