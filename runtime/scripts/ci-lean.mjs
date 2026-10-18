// The lean gate set of the macOS job (ADR 0065): build, the platform unit tests and the bundle smoke. Like
// `ci.mjs --summary-json`, it writes an `mcs.ci-run/1` summary (gate results and a log tail) to `ci-summary.json`, so a
// failure reaches the ci-status branch with its gate name instead of only the job status.
// Usage: node scripts/ci-lean.mjs        (exit 0 when every gate passes, 1 otherwise; POSIX runners: npm is run by name)
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const GATES = [
  { name: 'build', argv: ['npm', 'run', 'build'] },
  {
    name: 'platform',
    argv: [
      process.execPath,
      'node_modules/vitest/vitest.mjs',
      'run',
      '--project',
      'unit',
      'packages/engine/src/platform',
    ],
  },
  { name: 'smoke:bundle', argv: [process.execPath, 'scripts/smoke.mjs', '--bundle'] },
];
const TAIL_LINES = 60;

const gates = [];
let log = '';
let failedGate = null;
for (const gate of GATES) {
  if (failedGate !== null) {
    gates.push({ name: gate.name, result: 'not-run', ms: 0 });
    continue;
  }
  console.log(`=== ${gate.name}`);
  const started = performance.now();
  const [file, ...args] = gate.argv;
  const run = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  process.stdout.write(output);
  log += `=== ${gate.name}\n${output}`;
  const ok = run.status === 0;
  gates.push({ name: gate.name, result: ok ? 'pass' : 'fail', ms: Math.round(performance.now() - started) });
  if (!ok) failedGate = gate.name;
}

const summary = {
  schema: 'mcs.ci-run/1',
  result: failedGate === null ? 'pass' : 'fail',
  gates,
  failedGate,
  tail: log.split('\n').slice(-TAIL_LINES),
};
writeFileSync('ci-summary.json', `${JSON.stringify(summary, null, 2)}\n`);
process.exit(failedGate === null ? 0 : 1);
