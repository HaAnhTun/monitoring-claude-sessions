// The process lifecycle on real processes (01 4.16): T-LC-01 (start, status, start again, verify, stop), T-LC-02 (an invalid
// configuration spawns nothing), T-LC-09 (the port scan and PORT_EXHAUSTED) and T-LC-15 (`serve` in the foreground, stopped
// the way Ctrl+C stops it). The CLI and the server are the built ones (`dist/`), started as the launcher starts them, from a
// temp copy of the runtime folder that holds its own build stamp: the integration gate builds first and the build removes the
// real stamp. Every call passes `--repo <temp repo>` and every start a `--port` (or a port in the config) of the test range;
// nothing touches a real workspace, a real Claude home or the live monitor.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  controlAddressOf,
  defaultSkillDir,
  forceKill,
  listRuntimeProcesses,
  pidAlive,
  requestControl,
  waitForExit,
} from '@mcs/engine';
import { CliEnvelopeSchema, RUNTIME_VERSION, StateFileSchema, type CliEnvelope } from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  buildRepo,
  hermeticEnv,
  httpRequest,
  useTempDirs,
  waitFor,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const REAL_CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const REAL_BOOT = fileURLToPath(new URL('../../server/dist/boot.js', import.meta.url));
const LF = String.fromCharCode(10);
const SLUG = 'demo';

interface Install {
  readonly skillDir: string;
  readonly runtimeDir: string;
  readonly cliEntry: string;
  readonly serverEntry: string;
}

interface Sandbox extends Install {
  readonly root: string;
  readonly repo: string;
  readonly ws: string;
  readonly env: Record<string, string>;
  /** The port of the task (`init --port`); every start, restart and serve passes it again (plan section 2 rule 5). */
  port: number;
}

const installs: Install[] = [];

/** A skill folder with defaults and a build stamp, and two shims at the paths of the real entries (the marker of 01 4.1). */
function installRuntime(root: string): Install {
  const skillDir = path.join(root, 'skill');
  const runtimeDir = path.join(skillDir, 'runtime');
  const serverDist = path.join(runtimeDir, 'packages', 'server', 'dist');
  const cliDist = path.join(runtimeDir, 'packages', 'cli', 'dist');
  for (const dir of [path.join(skillDir, 'config'), serverDist, cliDist]) mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skillDir, 'config', 'defaults.json'));
  copyFileSync(path.join(defaultSkillDir(), 'runtime', 'defaults.json'), path.join(runtimeDir, 'defaults.json'));
  writeFileSync(
    path.join(runtimeDir, '.mcs-build.json'),
    JSON.stringify({
      schemaVersion: 1,
      runtimeVersion: RUNTIME_VERSION,
      buildStamp: 'f'.repeat(64),
      codeStamp: 'abcdef0123',
    }),
  );
  const serverEntry = path.join(serverDist, 'main.js');
  writeFileSync(
    serverEntry,
    [
      `import { serveMain } from ${JSON.stringify(pathToFileURL(REAL_BOOT).href)};`,
      `process.exit(await serveMain({ argv: process.argv.slice(2), env: process.env, runtimeDir: ${JSON.stringify(runtimeDir)} }));`,
      '',
    ].join(LF),
  );
  const cliEntry = path.join(cliDist, 'main.js');
  writeFileSync(
    cliEntry,
    [
      `import { main } from ${JSON.stringify(pathToFileURL(REAL_CLI).href)};`,
      `const paths = { launcherPath: ${JSON.stringify(path.join(skillDir, 'scripts', 'mcs.mjs'))}, skillDir: ${JSON.stringify(skillDir)}, runtimeDir: ${JSON.stringify(runtimeDir)} };`,
      'process.exitCode = await main(process.argv.slice(2), paths);',
      '',
    ].join(LF),
  );
  const install = { skillDir, runtimeDir, cliEntry, serverEntry };
  installs.push(install);
  return install;
}

function sandbox(purpose: string): Sandbox {
  const root = makeTemp(purpose).path;
  const { repo } = buildRepo(path.join(root, 'repo'));
  const install = installRuntime(root);
  const env = { ...hermeticEnv(root), MCS_LAUNCHER_NO_BOOTSTRAP: '1' };
  return { ...install, root, repo, ws: path.join(repo, '.claude', 'monitor', 'tasks', SLUG), env, port: 0 };
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const PORT_COMMANDS: readonly string[] = ['start', 'restart', 'serve'];

/** `start`, `restart` and `serve` always carry `--port`: the default scan would reach the live monitor (plan section 2 rule 5). */
function withPort(sb: Sandbox, args: readonly string[]): readonly string[] {
  if (!PORT_COMMANDS.includes(args[0] ?? '') || args.includes('--port')) return args;
  if (sb.port <= 0) throw new Error(`test bug: ${args[0] ?? ''} without a port of the task`);
  return [...args, '--port', String(sb.port)];
}

/** Runs the CLI of the sandbox to its end; `--repo` is always passed (plan section 2 rule 5). */
function mcs(
  sb: Sandbox,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 90_000,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [sb.cliEntry, ...withPort(sb, args), '--repo', sb.repo], {
      cwd: sb.root,
      env: { ...sb.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // the signal kills the child and ends the call with an AbortError when the CLI hangs
      signal: AbortSignal.timeout(timeoutMs),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.once('error', (error) => {
      reject(new Error(`mcs ${args.join(' ')} did not finish within ${String(timeoutMs)} ms: ${error.message}`));
    });
    child.once('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

async function initTask(sb: Sandbox, port: number, runtime?: Record<string, unknown>): Promise<void> {
  sb.port = port;
  const run = await mcs(sb, ['init', '--slug', SLUG, '--name', 'FIXTURE demo', '--port', String(port)]);
  expect(run.code, run.stderr).toBe(0);
  if (runtime !== undefined)
    writeFileSync(path.join(sb.ws, 'runtime.json'), JSON.stringify({ schema_version: 1, ...runtime }));
}

function readState(sb: Sandbox): { pid: number; port: number; url: string } {
  const state = StateFileSchema.parse(JSON.parse(readFileSync(path.join(sb.ws, 'state.json'), 'utf8')));
  return { pid: state.pid, port: state.port, url: state.url };
}

const exists = (sb: Sandbox, ...parts: string[]): boolean => existsSync(path.join(sb.ws, ...parts));

function parseEnvelope(run: Run): CliEnvelope<unknown> {
  return CliEnvelopeSchema.parse(JSON.parse(run.stdout));
}

/** Every runtime process of an install is ended, whatever a test left behind (the real stop is what the tests exercise). */
afterEach(async () => {
  for (const install of installs.splice(0)) {
    for (const found of await listRuntimeProcesses(install.runtimeDir)) {
      await forceKill(found.pid);
      await waitForExit(found.pid, 5000);
    }
  }
});

// ---- T-LC-01 ---------------------------------------------------------------------------------------------------------------------

describe('T-LC-01: start, status, start again, verify, stop', () => {
  it('runs the whole cycle on a real server', async () => {
    expect(existsSync(REAL_CLI) && existsSync(REAL_BOOT), 'build the runtime first: the integration gate builds').toBe(
      true,
    );
    const sb = sandbox('lc01');
    const port = await allocatePort();
    await initTask(sb, port);

    const started = await mcs(sb, ['start', '--task', SLUG]);
    expect(started.code, started.stderr).toBe(0);
    const match = /^started: (http:\/\/127\.0\.0\.1:\d+) \(pid (\d+)\)$/m.exec(started.stdout);
    expect(match, started.stdout).not.toBeNull();
    const url = match?.[1] ?? '';
    const pid = Number(match?.[2]);
    expect(url).toBe(`http://127.0.0.1:${String(port)}`);
    expect(pidAlive(pid)).toBe(true);
    expect(readState(sb)).toEqual({ pid, port, url });
    expect(exists(sb, 'run', 'control.token')).toBe(true);
    expect(exists(sb, 'logs', 'boot.log')).toBe(true);

    const status = await mcs(sb, ['status', '--task', SLUG]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      running: true,
      url,
      pid,
      outdated: false,
      probe: 'running',
      engine: 'node',
      runtime_version: RUNTIME_VERSION,
      code_stamp: 'abcdef0123',
    });

    const again = await mcs(sb, ['start', '--task', SLUG]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout.trim()).toBe(`already running: ${url} (pid ${String(pid)})`);
    expect(readState(sb).pid).toBe(pid);

    const verified = await mcs(sb, ['verify', '--task', SLUG]);
    expect(verified.code, verified.stderr).toBe(0);
    expect(verified.stdout.trim()).toMatch(
      new RegExp(`^verified ${url.replaceAll('.', '[.]')}: health, instance, sessions \\(\\d+\\), overview all valid$`),
    );

    const stopped = await mcs(sb, ['stop', '--task', SLUG]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout.trim()).toBe(`stopped runtime pid ${String(pid)} (${url})`);
    expect(pidAlive(pid)).toBe(false);
    expect(exists(sb, 'state.json')).toBe(false);
    expect(exists(sb, 'run', 'control.token')).toBe(false);
    await assertPortClosed(port);
    const runtimeLog = readFileSync(path.join(sb.ws, 'logs', 'runtime.log'), 'utf8');
    expect(runtimeLog).toContain('"runtime_ready"');

    const nothing = await mcs(sb, ['stop', '--task', SLUG]);
    expect(nothing.code).toBe(0);
    expect(nothing.stdout.trim()).toBe(`nothing to stop (no state file ${path.join(sb.ws, 'state.json')})`);
  }, 180_000);

  it('prints one valid mcs.cli/1 envelope for start, status, verify and stop with --json', async () => {
    const sb = sandbox('lc01-json');
    const port = await allocatePort();
    await initTask(sb, port);
    const started = parseEnvelope(await mcs(sb, ['start', '--task', SLUG, '--json']));
    expect(started).toMatchObject({ command: 'start', ok: true, exitCode: 0, error: null });
    expect(started.data).toMatchObject({ outcome: 'started', slug: SLUG, engine: 'node' });
    const status = parseEnvelope(await mcs(sb, ['status', '--task', SLUG, '--json']));
    expect(status).toMatchObject({ command: 'status', ok: true, exitCode: 0 });
    expect(status.data).toMatchObject({ running: true, probe: 'running' });
    const verified = parseEnvelope(await mcs(sb, ['verify', '--task', SLUG, '--json']));
    expect(verified).toMatchObject({ command: 'verify', ok: true });
    const stopped = parseEnvelope(await mcs(sb, ['stop', '--task', SLUG, '--json']));
    expect(stopped).toMatchObject({ command: 'stop', ok: true });
    expect(stopped.data).toMatchObject({ outcome: 'stopped', forced: false });
    const after = await mcs(sb, ['status', '--task', SLUG, '--json']);
    expect(after.code).toBe(1);
    expect(parseEnvelope(after)).toMatchObject({ command: 'status', ok: false, exitCode: 1, error: null });
  }, 180_000);

  it('restart stops and starts again: two lines, a new pid, the same port', async () => {
    const sb = sandbox('lc01-restart');
    const port = await allocatePort();
    await initTask(sb, port);
    const first = await mcs(sb, ['start', '--task', SLUG]);
    expect(first.code, first.stderr).toBe(0);
    const before = readState(sb);
    const restarted = await mcs(sb, ['restart', '--task', SLUG]);
    expect(restarted.code, restarted.stderr).toBe(0);
    const lines = restarted.stdout.trim().split(LF);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`stopped runtime pid ${String(before.pid)} (${before.url})`);
    const after = readState(sb);
    expect(lines[1]).toBe(`started: ${after.url} (pid ${String(after.pid)})`);
    expect(after.pid).not.toBe(before.pid);
    expect(after.port).toBe(port);
    expect(pidAlive(before.pid)).toBe(false);
    expect(pidAlive(after.pid)).toBe(true);
    await mcs(sb, ['stop', '--task', SLUG]);
  }, 180_000);

  it('two starts at once: one process, one "started", the other "already running" (exit code 12 of the loser is not an error)', async () => {
    const sb = sandbox('lc01-race');
    const port = await allocatePort();
    await initTask(sb, port);
    const [a, b] = await Promise.all([mcs(sb, ['start', '--task', SLUG]), mcs(sb, ['start', '--task', SLUG])]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    const lines = [a.stdout.trim(), b.stdout.trim()];
    expect(lines.filter((line) => line.startsWith('started: '))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('already running: '))).toHaveLength(1);
    expect((await listRuntimeProcesses(sb.runtimeDir)).length).toBe(1);
  }, 180_000);

  it('start without --task makes the workspace "default"; status without --task finds it', async () => {
    const sb = sandbox('lc01-default');
    const port = await allocatePort();
    const none = await mcs(sb, ['status']);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('no default instance (use --task)');
    // the default workspace takes the port of the shared defaults unless it is told another: write it before the first start
    sb.port = port;
    const created = await mcs(sb, ['init', '--slug', 'default', '--name', 'Default monitor', '--port', String(port)]);
    expect(created.code, created.stderr).toBe(0);
    const started = await mcs(sb, ['start']);
    expect(started.code, started.stderr).toBe(0);
    expect(started.stdout).toContain(`started: http://127.0.0.1:${String(port)}`);
    const status = await mcs(sb, ['status']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ running: true });
    await mcs(sb, ['stop']);
  }, 180_000);
});

// ---- T-LC-02 ---------------------------------------------------------------------------------------------------------------------

describe('T-LC-02: an invalid configuration spawns nothing', () => {
  it('prints the problem, exits 1, leaves no process, no boot.log and no state.json', async () => {
    const sb = sandbox('lc02');
    const port = await allocatePort();
    await initTask(sb, port);
    const file = path.join(sb.ws, 'config.json');
    const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    config['session_rules'] = [{ match: '(unclosed', label: 'x' }];
    writeFileSync(file, JSON.stringify(config, null, 2));

    const run = await mcs(sb, ['start', '--task', SLUG]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/^ERROR: /);
    expect(run.stderr).toContain('session_rules');
    expect(await listRuntimeProcesses(sb.runtimeDir)).toEqual([]);
    expect(exists(sb, 'logs', 'boot.log')).toBe(false);
    expect(exists(sb, 'state.json')).toBe(false);
    await assertPortClosed(port);
  }, 120_000);
});

// ---- T-LC-09 ---------------------------------------------------------------------------------------------------------------------

/** Listeners on `count` consecutive ports starting at a free `base`; the ports after them stay free. */
async function occupy(count: number, free: number): Promise<{ base: number; holders: Server[] }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const base = await allocatePort();
    const holders: Server[] = [];
    try {
      for (let i = 0; i < count + free; i += 1) {
        const holder = createServer();
        await new Promise<void>((resolve, reject) => {
          holder.once('error', reject);
          holder.listen({ port: base + i, host: '127.0.0.1', exclusive: true }, resolve);
        });
        holders.push(holder);
      }
    } catch {
      for (const holder of holders) holder.close();
      continue;
    }
    // the ports that must stay free are released again
    for (const holder of holders.splice(count)) {
      await new Promise<void>((resolve) => {
        holder.close(() => {
          resolve();
        });
      });
    }
    return { base, holders };
  }
  throw new Error('no run of consecutive free ports in the test range');
}

describe('T-LC-09: the port scan (01 4.11)', () => {
  const held: Server[] = [];
  afterEach(async () => {
    for (const holder of held.splice(0)) {
      await new Promise<void>((resolve) => {
        holder.close(() => {
          resolve();
        });
      });
    }
  });

  it('binds base+2 when base and base+1 are taken', async () => {
    const sb = sandbox('lc09');
    const { base, holders } = await occupy(2, 1);
    held.push(...holders);
    await initTask(sb, base, { server: { portScan: 2 } });
    const run = await mcs(sb, ['start', '--task', SLUG]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`started: http://127.0.0.1:${String(base + 2)} `);
    expect(readState(sb).port).toBe(base + 2);
    const health = await httpRequest(base + 2, '/api/v3/health');
    expect(health.status).toBe(200);
    expect((await mcs(sb, ['stop', '--task', SLUG])).code).toBe(0);
  }, 180_000);

  it('exits 13 (PORT_EXHAUSTED) when the whole range is taken: the start fails, nothing stays behind', async () => {
    const sb = sandbox('lc09-full');
    const { base, holders } = await occupy(3, 0);
    held.push(...holders);
    await initTask(sb, base, { server: { portScan: 2 } });
    const run = await mcs(sb, ['start', '--task', SLUG]);
    expect(run.code).toBe(1);
    expect(run.stderr.split(LF)[0]).toBe('ERROR: runtime exited during start (PORT_EXHAUSTED)');
    expect(run.stderr).toContain('no free port');
    expect(run.stderr).toContain('mcs doctor --task demo');
    expect(exists(sb, 'state.json')).toBe(false);
    expect(await listRuntimeProcesses(sb.runtimeDir)).toEqual([]);
  }, 180_000);
});

// ---- T-LC-15 ---------------------------------------------------------------------------------------------------------------------

describe('T-LC-15: serve in the foreground', () => {
  it('stops the way Ctrl+C stops it: exit 0, state.json and the token are gone, the port is closed', async () => {
    const sb = sandbox('lc15');
    const port = await allocatePort();
    await initTask(sb, port);
    const child = spawn(
      process.execPath,
      [sb.cliEntry, 'serve', '--task', SLUG, '--port', String(port), '--repo', sb.repo],
      {
        cwd: sb.root,
        env: sb.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => out.push(chunk));
    const exited = new Promise<number | null>((resolve) => {
      child.once('close', (code) => {
        resolve(code);
      });
    });
    try {
      await waitFor(
        async () => (await httpRequest(port, '/api/v3/health').catch(() => ({ status: 0 }))).status === 200,
        {
          what: 'the foreground server to answer health',
          timeoutMs: 60_000,
          intervalMs: 100,
        },
      );
      // HTTP is bound before state.json is written (01 4.4 steps 9 and 10)
      await waitFor(() => existsSync(path.join(sb.ws, 'state.json')), { what: 'state.json', timeoutMs: 30_000 });
      const state = readState(sb);
      expect(pidAlive(state.pid)).toBe(true);
      expect(state.pid, 'the server is a child of the CLI process, not the CLI itself').not.toBe(child.pid);

      if (process.platform === 'win32') {
        // a console delivers Ctrl+C to every process of the group; here the effect is the control channel's `shutdown`
        const token = readFileSync(path.join(sb.ws, 'run', 'control.token'), 'utf8').trim();
        const instance = JSON.parse(readFileSync(path.join(sb.ws, 'instance.json'), 'utf8')) as { instanceId: string };
        const attempt = await requestControl(
          controlAddressOf(instance.instanceId),
          { v: 1, op: 'shutdown', instanceId: instance.instanceId, token, reason: 'signal' },
          { timeoutMs: 5000 },
        );
        expect(attempt.kind).toBe('reply');
      } else {
        child.kill('SIGINT');
      }
      const code = await exited;
      expect(code, Buffer.concat(out).toString('utf8')).toBe(0);
      expect(exists(sb, 'state.json')).toBe(false);
      expect(exists(sb, 'run', 'control.token')).toBe(false);
      expect(pidAlive(state.pid)).toBe(false);
      await assertPortClosed(port);
    } finally {
      child.kill();
    }
  }, 180_000);

  it('refuses to serve over a running instance (INSTANCE_RUNNING)', async () => {
    const sb = sandbox('lc15-busy');
    const port = await allocatePort();
    await initTask(sb, port);
    expect((await mcs(sb, ['start', '--task', SLUG])).code).toBe(0);
    const run = await mcs(sb, ['serve', '--task', SLUG]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^ERROR: the instance 'demo' is already running/);
    expect(readState(sb).port).toBe(port);
    await mcs(sb, ['stop', '--task', SLUG]);
  }, 180_000);
});
