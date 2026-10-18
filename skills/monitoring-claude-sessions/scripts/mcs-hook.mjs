// Stable entry of the Claude Code hook (02 2.1, ADR 0010). Committed, zero dependencies, never a build output: the path in
// the user's settings must keep working while the runtime is being built or upgraded. It checks MCS_HOOK_DISABLE, imports the
// first existing handler of HANDLER_CANDIDATES (ADR 0062 item 6: the built dist/hook.js of a checkout, else the bundle's
// mcs-hook.mjs) and calls it. When there is none or the import fails it drains stdin, logs HANDLER_UNAVAILABLE and exits 0:
// a missing handler path would make every hook fail and add a `hook_non_blocking_error` line to the user's transcript per firing.
//
// Hook mode (`--mcs-hook <Event>`) never writes to stdout or stderr and always exits 0. The only mode that prints is
// `--version` (the handler version, used by `mcs hooks verify`). Any other arguments do nothing.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

const HARD_EXIT_MS = 1200;
const LOG_MAX_BYTES = 1024 * 1024;
const EVENT_NAME_RE = /^[A-Za-z]{1,64}$/;
/** Relative to this file: a checkout with a build first (tests and development run fresh code), then the bundle. */
const HANDLER_CANDIDATES = ['../../../runtime/packages/cli/dist/hook.js', '../bundle/mcs-hook.mjs'];

/** The URL of the first handler candidate that exists; throws when there is none. */
function handlerUrl() {
  for (const candidate of HANDLER_CANDIDATES) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(url)) return url.href;
  }
  throw new Error('no handler found');
}

const argv = process.argv.slice(2);
const hookIndex = argv.indexOf('--mcs-hook');
const hookMode = hookIndex >= 0;
const eventArg = hookIndex >= 0 ? argv[hookIndex + 1] : undefined;
const event = eventArg !== undefined && EVENT_NAME_RE.test(eventArg) ? eventArg : '';

/** Same rule as `resolveMcsHome` of the protocol (02 2.6.1), repeated here because the stub must not import the runtime. */
function mcsHome() {
  const env = process.env;
  if (env.MCS_HOME && isAbsolute(env.MCS_HOME)) return env.MCS_HOME.replace(/[\\/]+$/, '');
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA;
    return (local && isAbsolute(local) ? local.replace(/[\\/]+$/, '') : homedir() + '/AppData/Local') + '/mcs';
  }
  const state = env.XDG_STATE_HOME;
  return (state && isAbsolute(state) ? state.replace(/[\\/]+$/, '') : homedir() + '/.local/state') + '/mcs';
}

function logUnavailable(reason) {
  try {
    const dir = mcsHome() + '/logs';
    const file = dir + '/hook-handler.jsonl';
    mkdirSync(dir, { recursive: true });
    try {
      if (statSync(file).size >= LOG_MAX_BYTES) renameSync(file, dir + '/hook-handler.1.jsonl');
    } catch {
      // no file yet, or another handler rotated it first
    }
    const detail = String(reason)
      .replace(/[^\x20-\x7e]/g, '?')
      .slice(0, 120);
    const line = {
      at: Date.now(),
      code: 'HANDLER_UNAVAILABLE',
      event,
      instanceId: null,
      pid: process.pid,
      detail,
    };
    appendFileSync(file, JSON.stringify(line) + '\n');
  } catch {
    // the log is a diagnostic aid; the hook must still exit 0
  }
}

/** Reads stdin to its end and discards it, so the process that wrote it never sees a broken pipe. */
function drainStdin() {
  return new Promise((resolve) => {
    try {
      if (process.stdin.isTTY === true) return resolve();
      process.stdin.on('data', () => undefined);
      process.stdin.on('end', resolve);
      process.stdin.on('close', resolve);
      process.stdin.on('error', resolve);
    } catch {
      resolve();
    }
  });
}

async function main() {
  if (!hookMode) {
    if (!argv.includes('--version')) return;
    try {
      const { HANDLER_VERSION } = await import(handlerUrl());
      if (typeof HANDLER_VERSION === 'string') {
        await new Promise((done) => process.stdout.write(HANDLER_VERSION + '\n', done));
      }
    } catch {
      // not built: print nothing, `mcs hooks verify` reports the missing version
    }
    return;
  }
  if (process.env.MCS_HOOK_DISABLE === '1') {
    await drainStdin();
    return;
  }
  let handler;
  try {
    handler = await import(handlerUrl());
    if (typeof handler.runHook !== 'function') throw new Error('the handler has no runHook');
  } catch (error) {
    logUnavailable(error instanceof Error ? error.name : 'import failed');
    await drainStdin();
    return;
  }
  await handler.runHook(argv);
}

if (hookMode) {
  // Armed before the import: a hang while loading must not hold up Claude Code either.
  setTimeout(() => process.exit(0), Math.max(200, HARD_EXIT_MS - performance.now())).unref();
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}
try {
  await main();
} catch {
  // never let an error reach stderr or the exit code
}
process.exit(0);
