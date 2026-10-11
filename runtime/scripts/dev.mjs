// Development mode: server from TypeScript sources (native type stripping + @mcs/source condition, restarts on
// change) and the Vite dev server with /api proxied to it. Ports are test-range defaults, never 8765/3000.
// Usage: npm run dev [-- --api-port 18765 --web-port 18766 -- <extra server args>]
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { binPath, RUNTIME_ROOT } from './lib.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'api-port': { type: 'string', default: '18765' }, 'web-port': { type: 'string', default: '18766' } },
});
const env = {
  ...process.env,
  MCS_HOOK_DISABLE: '1',
  MCS_DEV_API: `http://127.0.0.1:${values['api-port']}`,
  MCS_WEB_DEV_PORT: values['web-port'],
};
const children = [
  spawn(
    process.execPath,
    [
      '--watch',
      '--conditions=@mcs/source',
      join(RUNTIME_ROOT, 'packages/server/src/main.ts'),
      '--port',
      values['api-port'],
      ...positionals,
    ],
    { stdio: 'inherit', shell: false, windowsHide: true, env },
  ),
  spawn(process.execPath, [binPath('vite')], {
    cwd: join(RUNTIME_ROOT, 'packages/web'),
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    env,
  }),
];
console.log(`dev: api http://127.0.0.1:${values['api-port']}  web http://127.0.0.1:${values['web-port']}`);

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => stopAll(code ?? 1));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
