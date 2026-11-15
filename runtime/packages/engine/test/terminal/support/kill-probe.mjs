// The probe behind the "a spawn-and-kill child prints nothing" regression test (CAW-55, TC-PTY-08; design 01 D6).
// node-pty 1.1.0 wrote an uncaught `AttachConsole failed` error to the stderr of its host a moment after `kill()`; the chosen
// build (1.2.0-beta.18) does not. This process starts the fake claude through the production backend, kills it and ends; the test
// reads its stderr and expects zero bytes.
//
// Run: node --conditions=@mcs/source kill-probe.mjs <engine-terminal-url> <fake-claude-script> <folder> <after-data|immediately>
//   after-data   waits for the first output (the pid is valid by then), then kills
//   immediately  kills before the first output: node-pty defers that kill until the first data event
// Output: the single word `ok` on stdout and exit 0 once the process has exited and the late-error window has passed; otherwise a
// fixed code on stdout and a non-zero exit. Nothing is ever written to stderr by this script itself.
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const [engineUrl, script, folder, mode] = process.argv.slice(2);
if (
  engineUrl === undefined ||
  script === undefined ||
  folder === undefined ||
  !['after-data', 'immediately'].includes(mode)
) {
  process.stdout.write('usage\n');
  process.exit(2);
}

/** A late error of the addon arrives on stderr within this window after the exit event (measured: well under a second). */
const LATE_ERROR_WINDOW_MS = 1500;
const EXIT_WAIT_MS = 20_000;

function fail(code) {
  process.stdout.write(`${code}\n`);
  process.exit(1);
}

const { createNodePtyBackend } = await import(engineUrl);
const backend = createNodePtyBackend({ platform: process.platform, arch: process.arch, release: os.release() });
if (!backend.support.supported) fail('unsupported');

const env = {};
for (const [name, value] of Object.entries(process.env)) if (typeof value === 'string') env[name] = value;

const pty = backend.spawn(process.execPath, [script], folder, 120, 30, env);
const state = { exited: false };
pty.onExit(() => {
  state.exited = true;
});
if (mode === 'after-data') {
  try {
    await pty.started;
  } catch {
    fail('start-failed');
  }
}
pty.kill();
// Idempotent: a second call must not throw either.
pty.kill();

const deadline = Date.now() + EXIT_WAIT_MS;
while (!state.exited) {
  if (Date.now() >= deadline) fail('no-exit');
  await delay(25);
}
await delay(LATE_ERROR_WINDOW_MS);
process.stdout.write('ok\n');
process.exit(0);
