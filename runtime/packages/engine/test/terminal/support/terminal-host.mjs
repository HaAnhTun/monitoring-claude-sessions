// A host process of the real-terminal suites (CAW-55, design 01 section 8): the production TerminalService over the real node-pty
// backend, in a process of its own, so that a test can start it detached and hidden the way `start` starts the server
// (hidden-console) or end it by force (terminal-orphans).
//
// Run: node --conditions=@mcs/source terminal-host.mjs <engine-terminal-url> <control-dir>
//   <engine-terminal-url>  the file URL of `engine/src/terminal/index.ts` (Node strips the types; the condition resolves `@mcs/shared`)
//   <control-dir>          a folder that holds `config.json`, written by the test before the start:
//                          { "config": <terminal section>, "mcsHome": <folder>, "folder": <working folder>, "sessions": <count>, "spawnChild": <bool> }
// The environment of this process is the environment of the sessions: its PATH must reach the fake claude.
//
// Output, all inside <control-dir> and written atomically:
//   ready.json    { hostPid, sessions: [{ name, pid, fakePid, childPid }] } once every session shows READY (and CHILD with spawnChild);
//                 pid is the root of the pseudo console, fakePid the fake claude, childPid its grandchild (null without spawnChild)
//   killed.json   { name, code, reason } after a kill request
//   stopped.json  {} after a stop request, just before the host exits with code 0
//   error.json    { code } when the host fails (a fixed word: no message, it could hold a path)
// Requests: a file named `kill` (its content is a session name) or `stop` appears in <control-dir>; the host removes it and acts.
//
// Nothing here prints, and nothing creates a window.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [engineUrl, controlDir] = process.argv.slice(2);
if (engineUrl === undefined || controlDir === undefined) process.exit(2);

const POLL_MS = 100;
const WAIT_MS = 30_000;

function writeJson(name, value) {
  const target = join(controlDir, name);
  writeFileSync(`${target}.tmp`, JSON.stringify(value));
  renameSync(`${target}.tmp`, target);
}

async function until(probe, what) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
}

const quiet = () => undefined;
const logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };

async function startSessions(service, setup) {
  const sessions = [];
  for (let i = 0; i < setup.sessions; i += 1) {
    const info = await service.create({ folder: setup.folder });
    const session = service.get(info.name);
    const seen = { text: '' };
    session.attach({
      send: (chunk) => {
        seen.text += Buffer.from(chunk).toString('utf8');
      },
      end: quiet,
    });
    const fakePid = Number((await until(() => /READY pid=(\d+)/.exec(seen.text), 'READY'))[1]);
    let childPid = null;
    if (setup.spawnChild) {
      session.write('/spawn\r');
      childPid = Number((await until(() => /CHILD:(\d+)/.exec(seen.text), 'CHILD'))[1]);
    }
    sessions.push({ name: info.name, pid: info.pid, fakePid, childPid });
  }
  return sessions;
}

async function main() {
  const setup = JSON.parse(readFileSync(join(controlDir, 'config.json'), 'utf8'));
  const { createDefaultTerminalService } = await import(engineUrl);
  const service = createDefaultTerminalService({ config: setup.config, logger, mcsHome: setup.mcsHome });
  const sessions = await startSessions(service, setup);
  writeJson('ready.json', { hostPid: process.pid, sessions });

  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    handleRequests(service)
      .catch(() => {
        writeJson('error.json', { code: 'request-failed' });
        process.exit(1);
      })
      .finally(() => {
        busy = false;
      });
  }, POLL_MS);
}

async function handleRequests(service) {
  const killFile = join(controlDir, 'kill');
  if (existsSync(killFile)) {
    const name = readFileSync(killFile, 'utf8').trim();
    rmSync(killFile, { force: true });
    const session = service.get(name);
    if (session === undefined) {
      writeJson('killed.json', { name, code: null, reason: 'unknown' });
    } else {
      const exit = await session.kill();
      writeJson('killed.json', { name, code: exit.code, reason: exit.reason });
    }
  }
  const stopFile = join(controlDir, 'stop');
  if (existsSync(stopFile)) {
    rmSync(stopFile, { force: true });
    await service.shutdown();
    writeJson('stopped.json', {});
    process.exit(0);
  }
}

main().catch((error) => {
  const code =
    error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'host-failed';
  try {
    writeJson('error.json', { code: /^[A-Z_]{1,40}$/.test(code) ? code : 'host-failed' });
  } catch {
    // The folder is gone: nobody is waiting.
  }
  process.exit(1);
});
