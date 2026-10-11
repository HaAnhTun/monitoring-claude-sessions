// Type-checks every project with noEmit against sources (custom condition @mcs/source), no build needed.
import { binPath, runNode } from './lib.mjs';

const PROJECTS = [
  'packages/shared',
  'packages/engine',
  'packages/server',
  'packages/cli',
  'packages/testkit',
  'packages/web',
  'tests',
  'packages/web/e2e',
];

const tsc = binPath('typescript', 'tsc');
let failed = 0;
for (const project of PROJECTS) {
  const started = Date.now();
  const code = await runNode(tsc, ['-p', project, '--pretty', 'false']);
  console.log(`typecheck ${project}: ${code === 0 ? 'ok' : `FAILED (exit ${code})`} ${Date.now() - started} ms`);
  if (code !== 0) failed += 1;
}
process.exitCode = failed === 0 ? 0 : 1;
