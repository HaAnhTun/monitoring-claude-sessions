// The probe behind the "a built bundle loads its native files by path" test (CAW-56, TC-PTY-01; design 01 section 8, design 08
// section 4.3). The test builds a bundle into a folder with a space and a non-ASCII letter in its name, copies this file NEXT TO
// `mcs-server.mjs` of that bundle and runs it from there: the production loader (`loadNodePty`) then sees the bundle layout from
// the URL of this file and requires `native/<host>/lib/index.js` by path, exactly as the bundled server does. The probe starts the
// fake claude through the backend that results, resizes it, lets it exit, and kills a second one with a grandchild.
//
// Run: node --conditions=@mcs/source probe.mjs <engine-terminal-url> <fake-claude-script> <folder> <inbox|dll|missing> <wait-ms>
//   inbox    the inbox console host            dll      the bundled conpty.dll and OpenConsole.exe
//   missing  a bundle without native files: the backend must say native-missing and nothing may be started
// Standard input: a line `go` after the `loaded` event and another after the `ready` event: the test looks at the process tree in
// between (the console hosts below this process, before the first session and with it).
// Output: one JSON object per line on stdout, a fixed vocabulary and no path:
//   loaded       { via, dirIsBundle, entryFromBundle, fromNodeModules }
//   unsupported  { reason }                       (mode missing; the probe ends with exit code 0)
//   ready        { pid, fakePid }                 (the first session shows READY; the probe waits for `go`)
//   resized      { size }                         (what the child reports after the resize)
//   exited       { code, bye }                    (after `/exit`)
//   killed       { code, rootPid, fakePid, childPid }   (after `kill()` of a second session that has a grandchild)
//   done         {}
//   error        { code }                         (a fixed word; exit code 1)
// Nothing is written to stderr.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [engineUrl, script, folder, mode, waitText] = process.argv.slice(2);
if (
  engineUrl === undefined ||
  script === undefined ||
  folder === undefined ||
  !['inbox', 'dll', 'missing'].includes(mode) ||
  !/^\d+$/.test(waitText ?? '')
) {
  process.stdout.write('{"event":"error","code":"usage"}\n');
  process.exit(2);
}
const WAIT_MS = Number(waitText);

function emit(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function fail(code) {
  emit('error', { code });
  process.exit(1);
}

async function until(probe, code) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) fail(code);
    await delay(25);
  }
}

// ---- standard input: the `go` line --------------------------------------------------------------------------------------------
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('error', () => undefined);

/** Waits until the test has sent `count` lines `go`. */
async function awaitGo(count) {
  await until(() => input.split('\n').filter((line) => line.trim() === 'go').length >= count, 'no-go');
}

// ---- the backend, loaded by the production loader from THIS file's place -----------------------------------------------------------
const T = await import(engineUrl);
const moduleUrl = import.meta.url;
const nodeRequire = createRequire(moduleUrl);
const deps = { ...T.realLoaderDeps(), moduleUrl, require: (id) => nodeRequire(id) };
const target = `${process.platform}-${process.arch}`;
const backend = T.createNodePtyBackend({
  platform: process.platform,
  arch: process.arch,
  release: os.release(),
  useConptyDll: mode === 'dll',
  startTimeoutMs: WAIT_MS,
  load: () => T.loadNodePty(deps),
});

if (mode === 'missing') {
  if (backend.support.supported) fail('loaded-without-native');
  emit('unsupported', { reason: backend.support.reason });
  process.exit(0);
}
if (!backend.support.supported) fail(`unsupported-${backend.support.reason}`);

const here = import.meta.dirname;
const expectedDir = path.join(here, 'native', target);
const cached = Object.keys(nodeRequire.cache).map((key) => key.toLowerCase());
const entry = path.join(expectedDir, 'lib', 'index.js').toLowerCase();
emit('loaded', {
  via: backend.via,
  dirIsBundle:
    typeof backend.dir === 'string' &&
    path.resolve(backend.dir).toLowerCase() === path.resolve(expectedDir).toLowerCase(),
  entryFromBundle: cached.includes(entry),
  fromNodeModules: cached.some((key) => key.includes(`${path.sep}node_modules${path.sep}@lydell${path.sep}`)),
});

// ---- a session -----------------------------------------------------------------------------------------------------------------
const env = {};
for (const [name, value] of Object.entries(process.env)) if (typeof value === 'string') env[name] = value;

function startSession() {
  const state = { text: '', exit: null };
  const pty = backend.spawn(process.execPath, [script], folder, 120, 30, env);
  pty.onData((chunk) => {
    state.text += Buffer.from(chunk).toString('utf8');
  });
  pty.onExit((exit) => {
    state.exit = exit;
  });
  return { pty, state };
}

async function ready(session) {
  try {
    await session.pty.started;
  } catch {
    fail('start-failed');
  }
  const match = await until(() => /READY pid=(\d+) cols=(\d+) rows=(\d+)/.exec(session.state.text), 'no-ready');
  return Number(match[1]);
}

/** Types `command` and waits for a new line that starts with `tag`; resolves to the rest of that line. */
async function ask(session, command, tag) {
  const before = session.state.text.split(tag).length - 1;
  session.pty.write(`${command}\r`);
  return until(
    () => {
      let from = -1;
      for (let i = 0; i <= before; i += 1) {
        from = session.state.text.indexOf(tag, from + 1);
        if (from === -1) return null;
      }
      const rest = session.state.text.slice(from + tag.length);
      const end = rest.search(/[\r\n]/);
      return end === -1 ? null : rest.slice(0, end);
    },
    `no-${tag.replace(/[^A-Za-z]/g, '').toLowerCase()}`,
  );
}

// First session: start, resize, `/exit`. The test has looked at the console hosts of this process once `loaded` was reported.
await awaitGo(1);
const first = startSession();
const fakePid = await ready(first);
emit('ready', { pid: first.pty.pid, fakePid });
await awaitGo(2);

first.pty.resize(100, 40);
// The resize is debounced and then sent to the console: ask again until the child reports the new size.
const size = await until(async () => {
  const answer = await ask(first, '/size', 'SIZE:');
  return answer === '100x40' ? answer : null;
}, 'no-resize');
emit('resized', { size });
first.pty.write('/exit\r');
await until(() => first.state.exit !== null, 'no-exit');
emit('exited', { code: first.state.exit.code, bye: first.state.text.includes('BYE:0') });

// Second session: a grandchild, then `kill()` (it forks the console list agent from the bundle's lib folder).
const second = startSession();
const secondFake = await ready(second);
const childPid = Number(await ask(second, '/spawn', 'CHILD:'));
const rootPid = second.pty.pid;
second.pty.kill();
await until(() => second.state.exit !== null, 'no-kill-exit');
emit('killed', { code: second.state.exit.code, rootPid, fakePid: secondFake, childPid });
emit('done');
process.exit(0);
