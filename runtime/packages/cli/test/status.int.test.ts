// `status` and the classification of an instance on real processes (01 4.8, 4.10): stopped, running, outdated, a server that
// was killed (stale), a pid that was reused (foreign-pid), and the full probe behind `discover`, `inspect` and `configure`.
// The CLI and the server are the built ones, started from a temp copy of the runtime folder with its own build stamp.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { defaultSkillDir, forceKill, listRuntimeProcesses, pidAlive, waitForExit } from '@mcs/engine';
import { CliEnvelopeSchema, RUNTIME_VERSION, StateFileSchema, type CliEnvelope } from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  buildRepo,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  spawnImpostor,
  spawnTracked,
  useTempDirs,
  waitFor,
  type TrackedProcess,
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
  writeStamp(runtimeDir, 'abcdef0123');
  writeFileSync(
    path.join(serverDist, 'main.js'),
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
  const install = { skillDir, runtimeDir, cliEntry };
  installs.push(install);
  return install;
}

function writeStamp(runtimeDir: string, codeStamp: string, runtimeVersion = RUNTIME_VERSION): void {
  writeFileSync(
    path.join(runtimeDir, '.mcs-build.json'),
    JSON.stringify({ schemaVersion: 1, runtimeVersion, buildStamp: 'f'.repeat(64), codeStamp }),
  );
}

function sandbox(purpose: string): Sandbox {
  const root = makeTemp(purpose).path;
  const { repo } = buildRepo(path.join(root, 'repo'));
  const install = installRuntime(root);
  const env = hermeticEnv(root);
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
function mcs(sb: Sandbox, args: readonly string[], timeoutMs = 90_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [sb.cliEntry, ...withPort(sb, args), '--repo', sb.repo], {
      cwd: sb.root,
      env: sb.env,
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

async function initTask(sb: Sandbox, port: number): Promise<void> {
  sb.port = port;
  const run = await mcs(sb, ['init', '--slug', SLUG, '--name', 'FIXTURE demo', '--port', String(port)]);
  expect(run.code, run.stderr).toBe(0);
}

function readState(sb: Sandbox): { pid: number; port: number; url: string } {
  const state = StateFileSchema.parse(JSON.parse(readFileSync(path.join(sb.ws, 'state.json'), 'utf8')));
  return { pid: state.pid, port: state.port, url: state.url };
}

function parseEnvelope(run: Run): CliEnvelope<unknown> {
  return CliEnvelopeSchema.parse(JSON.parse(run.stdout));
}

async function startedInstance(purpose: string): Promise<{ sb: Sandbox; port: number; pid: number; url: string }> {
  const sb = sandbox(purpose);
  const port = await allocatePort();
  await initTask(sb, port);
  const started = await mcs(sb, ['start', '--task', SLUG]);
  expect(started.code, started.stderr).toBe(0);
  const state = readState(sb);
  return { sb, port, pid: state.pid, url: state.url };
}

/** A state file of the Node engine that names `pid`, as a crashed server (or a reused pid) would leave it. */
function writeForeignState(sb: Sandbox, pid: number, port: number, instanceId: string): void {
  const state = {
    pid,
    url: `http://127.0.0.1:${String(port)}`,
    port,
    started: 1_700_000_000.5,
    version: RUNTIME_VERSION,
    task: SLUG,
    config: null,
    schema_version: 1,
    engine: 'node',
    instanceId,
    runtimeVersion: RUNTIME_VERSION,
    codeStamp: 'abcdef0123',
  };
  writeFileSync(path.join(sb.ws, 'state.json'), JSON.stringify(state, null, 2));
}

afterEach(async () => {
  await killAllTracked();
  for (const install of installs.splice(0)) {
    for (const found of await listRuntimeProcesses(install.runtimeDir)) {
      await forceKill(found.pid);
      await waitForExit(found.pid, 5000);
    }
  }
});

describe('status of an instance that is not running', () => {
  it('prints running false, the state file path and the probe, and exits 1', async () => {
    const sb = sandbox('status-stopped');
    await initTask(sb, await allocatePort());
    const run = await mcs(sb, ['status', '--task', SLUG]);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(report).toEqual({
      running: false,
      state_file: path.join(sb.ws, 'state.json'),
      engine: null,
      probe: 'stopped',
      instance_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    });
    const json = await mcs(sb, ['status', '--task', SLUG, '--json']);
    expect(json.code).toBe(1);
    expect(parseEnvelope(json)).toMatchObject({ command: 'status', ok: false, exitCode: 1, error: null });
  }, 120_000);

  it('a workspace that does not exist is TASK_NOT_FOUND (exit 1), not a stopped instance', async () => {
    const sb = sandbox('status-missing');
    const run = await mcs(sb, ['status', '--task', 'nope']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^ERROR: /);
    const json = await mcs(sb, ['status', '--task', 'nope', '--json']);
    expect(parseEnvelope(json).error?.code).toBe('TASK_NOT_FOUND');
  }, 120_000);
});

describe('status of a running instance', () => {
  it('prints the legacy keys first, then the new ones, from the real server', async () => {
    const { sb, pid, url } = await startedInstance('status-running');
    const run = await mcs(sb, ['status', '--task', SLUG]);
    expect(run.code, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(Object.keys(report).slice(0, 3)).toEqual(['running', 'state_file', 'url']);
    expect(report).toMatchObject({
      running: true,
      url,
      pid,
      outdated: false,
      config_source: 'task',
      task: { id: SLUG, name: 'FIXTURE demo', description: '' },
      engine: 'node',
      probe: 'running',
      runtime_version: RUNTIME_VERSION,
      code_stamp: 'abcdef0123',
      outdated_reason: null,
    });
    expect(typeof report['uptime_s']).toBe('number');
    expect(report['sessions']).toEqual({ RUNNING: 0, IDLE: 0, COMPLETED: 0, FAILED: 0, UNKNOWN: 0 });
    expect(report['partial_sessions']).toBe(0);
    expect(report['newest_session_age_s']).toBeNull();
    expect(report['db_schema_version']).toEqual(expect.any(Number) as unknown);
    expect(report).toHaveProperty('ingestion');
    expect(report).not.toHaveProperty('hint');
    await mcs(sb, ['stop', '--task', SLUG]);
  }, 180_000);

  it('says outdated, with the hint, once the build stamp of the runtime folder is another one', async () => {
    const { sb } = await startedInstance('status-outdated');
    writeStamp(sb.runtimeDir, 'ffffffffff');
    const run = await mcs(sb, ['status', '--task', SLUG]);
    expect(run.code, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({ running: true, outdated: true, outdated_reason: 'code_stamp_changed' });
    expect(report['hint']).toBe(
      'the runtime code changed since this instance started: run `mcs restart --task demo` (or `mcs upgrade --task demo --restart` when the database needs an upgrade)',
    );
    writeStamp(sb.runtimeDir, 'ffffffffff', '9.9.9');
    const version = JSON.parse((await mcs(sb, ['status', '--task', SLUG])).stdout) as Record<string, unknown>;
    expect(version['outdated_reason']).toBe('runtime_version_changed');
    await mcs(sb, ['stop', '--task', SLUG]);
  }, 180_000);

  it('discover, inspect and configure use the full probe', async () => {
    const { sb, url } = await startedInstance('status-probe');
    const discover = await mcs(sb, ['discover']);
    expect(discover.code, discover.stderr).toBe(0);
    expect(discover.stdout).toContain(`  ${SLUG} engine=node state=running ${url}`);
    const inspect = JSON.parse((await mcs(sb, ['inspect', '--task', SLUG])).stdout) as {
      probe: { state: string; pid: number };
    };
    expect(inspect.probe.state).toBe('running');
    // the summary of the probe, not its identity or the bytes of the state file
    expect(Object.keys(inspect.probe).sort()).toEqual(['pid', 'state', 'url']);
    const configure = JSON.parse(
      (await mcs(sb, ['configure', '--task', SLUG, '--set', 'ui.theme="dark"', '--reason', 'probe wiring'])).stdout,
    ) as { restart_needed: boolean };
    expect(configure.restart_needed).toBe(true);
    await mcs(sb, ['stop', '--task', SLUG]);
    const after = JSON.parse(
      (await mcs(sb, ['configure', '--task', SLUG, '--set', 'ui.theme="light"', '--reason', 'probe wiring'])).stdout,
    ) as {
      restart_needed: boolean;
    };
    expect(after.restart_needed).toBe(false);
  }, 240_000);
});

describe('a server that was killed, and a pid that was reused', () => {
  it('a killed server leaves a stale state file: status says so, stop clears it, start works again', async () => {
    const { sb, pid, port } = await startedInstance('status-stale');
    await forceKill(pid);
    expect(await waitForExit(pid, 10_000)).toBe(true);
    expect(existsSync(path.join(sb.ws, 'state.json'))).toBe(true);

    const status = await mcs(sb, ['status', '--task', SLUG]);
    expect(status.code).toBe(1);
    const report = JSON.parse(status.stdout) as { probe: string; running: boolean; stale_state_file?: { pid: number } };
    expect(report).toMatchObject({ running: false, probe: 'stale', engine: 'node' });
    expect(report.stale_state_file?.pid).toBe(pid);

    const stopped = await mcs(sb, ['stop', '--task', SLUG]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout.trim()).toBe(
      `pid ${String(pid)} is not this instance's runtime (already stopped or pid reused); removed the stale state file, nothing was killed`,
    );
    expect(existsSync(path.join(sb.ws, 'state.json'))).toBe(false);

    const again = await mcs(sb, ['start', '--task', SLUG]);
    expect(again.code, again.stderr).toBe(0);
    expect(readState(sb).port).toBe(port);
    expect(readState(sb).pid).not.toBe(pid);
    await mcs(sb, ['stop', '--task', SLUG]);
  }, 240_000);

  it('a live process that is not our runtime holds the pid of the state file: foreign-pid, and stop never kills it', async () => {
    const sb = sandbox('status-foreign');
    const port = await allocatePort();
    await initTask(sb, port);
    const instance = JSON.parse(readFileSync(path.join(sb.ws, 'instance.json'), 'utf8')) as { instanceId: string };
    const impostor = spawnImpostor(['--mcs-instance=' + instance.instanceId]);
    writeForeignState(sb, impostor.pid, port, instance.instanceId);
    const status = await mcs(sb, ['status', '--task', SLUG]);
    expect(status.code).toBe(1);
    expect(JSON.parse(status.stdout)).toMatchObject({ running: false, probe: 'foreign-pid', engine: 'node' });

    const stopped = await mcs(sb, ['stop', '--task', SLUG]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain('nothing was killed');
    expect(pidAlive(impostor.pid)).toBe(true);
    expect(existsSync(path.join(sb.ws, 'state.json'))).toBe(false);

    // and a start over the same state file simply replaces it
    writeForeignState(sb, impostor.pid, port, instance.instanceId);
    const started = await mcs(sb, ['start', '--task', SLUG]);
    expect(started.code, started.stderr).toBe(0);
    expect(readState(sb).pid).not.toBe(impostor.pid);
    expect(pidAlive(impostor.pid)).toBe(true);
    await mcs(sb, ['stop', '--task', SLUG]);
    await assertPortClosed(port);
  }, 240_000);
});

// ---- a live monitor that this runtime did not start (01 4.14, ADR 0066) ---------------------------------------------------------

/** What a pre-4.0 monitor's `/api/health` answers, as far as the probe reads it. */
const VIEWER_SOURCE = (port: number): string =>
  [
    "const http = require('node:http');",
    'http.createServer((req, res) => {',
    "  res.setHeader('Content-Type', 'application/json');",
    "  res.end(JSON.stringify({ ok: true, pid: process.pid, uptime: 1.5, code_stamp: 'legacystamp', task: { id: 'demo', name: 'FIXTURE demo', description: '' }, config_source: 'task' }));",
    `}).listen(${String(port)}, '127.0.0.1');`,
    'setInterval(() => undefined, 60000);',
  ].join(LF);

/**
 * A stand-in for a pre-4.0 monitor: an idle Node process that answers `/api/health` with its own pid and writes a seven-key
 * `state.json` (no `engine`). `named` puts a viewer script name into its command line (the old marker, which no command
 * trusts any more); without it the process answers the same.
 */
async function standInViewer(sb: Sandbox, port: number, named: boolean): Promise<TrackedProcess> {
  const child = spawnTracked(process.execPath, [
    '-e',
    VIEWER_SOURCE(port),
    ...(named ? [['viewer', 'py'].join('.'), 'serve'] : ['serve']),
  ]);
  await waitFor(async () => (await httpRequest(port, '/api/health').catch(() => ({ status: 0 }))).status === 200, {
    what: 'the stand-in viewer to answer /api/health',
    timeoutMs: 30_000,
    intervalMs: 100,
  });
  writeFileSync(
    path.join(sb.ws, 'state.json'),
    JSON.stringify(
      {
        pid: child.pid,
        url: `http://127.0.0.1:${String(port)}`,
        port,
        started: 1_700_000_000.5,
        version: '2.9.0',
        task: SLUG,
        config: null,
      },
      null,
      2,
    ),
  );
  return child;
}

describe('a monitor that this runtime did not start holds the workspace (01 4.14, ADR 0066)', () => {
  it('start, verify and stop refuse it and signal nothing; status reports it with exit 1', async () => {
    const sb = sandbox('status-unmanaged');
    const port = await allocatePort();
    await initTask(sb, port);
    const viewer = await standInViewer(sb, port, true);
    const url = `http://127.0.0.1:${String(port)}`;
    const before = readFileSync(path.join(sb.ws, 'state.json'));

    const started = await mcs(sb, ['start', '--task', SLUG, '--json']);
    expect(started.code, started.stderr).toBe(1);
    const startError = parseEnvelope(started).error;
    expect(startError?.code).toBe('INSTANCE_RUNNING');
    expect(startError?.message).toContain(`pid ${String(viewer.pid)}`);
    expect(startError?.message).toContain(url);
    expect(startError?.message).toContain('not started by this runtime');
    expect(await listRuntimeProcesses(sb.runtimeDir)).toEqual([]);
    expect(readFileSync(path.join(sb.ws, 'state.json')).equals(before)).toBe(true);

    const status = await mcs(sb, ['status', '--task', SLUG]);
    expect(status.code, status.stderr).toBe(1);
    const report = JSON.parse(status.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      running: false,
      engine: null,
      probe: 'unmanaged-running',
      pid: viewer.pid,
      url,
    });
    // nothing is fetched from it: the keys a running report reads from the server are absent
    expect(report).not.toHaveProperty('uptime_s');
    expect(report).not.toHaveProperty('code_stamp');

    const verified = await mcs(sb, ['verify', '--task', SLUG, '--json']);
    expect(verified.code).toBe(1);
    expect(parseEnvelope(verified).error?.code).toBe('INSTANCE_RUNNING');

    const stopped = await mcs(sb, ['stop', '--task', SLUG, '--json']);
    expect(stopped.code).toBe(1);
    const stopError = parseEnvelope(stopped).error;
    expect(stopError?.code).toBe('NOT_OUR_PROCESS');
    expect(stopError?.message).toContain(`pid ${String(viewer.pid)}`);
    expect(stopError?.message).toContain(url);
    expect(pidAlive(viewer.pid)).toBe(true);
    expect(readFileSync(path.join(sb.ws, 'state.json')).equals(before)).toBe(true);
  }, 240_000);

  it('a process that answers /api/health with the pid of the state file but has no viewer name is never killed either', async () => {
    const sb = sandbox('status-unmanaged-impostor');
    const port = await allocatePort();
    await initTask(sb, port);
    const impostor = await standInViewer(sb, port, false);

    const stopped = await mcs(sb, ['stop', '--task', SLUG, '--json']);
    expect(stopped.code).toBe(1);
    expect(parseEnvelope(stopped).error?.code).toBe('NOT_OUR_PROCESS');
    expect(pidAlive(impostor.pid)).toBe(true);
    expect(existsSync(path.join(sb.ws, 'state.json'))).toBe(true);
  }, 240_000);
});
