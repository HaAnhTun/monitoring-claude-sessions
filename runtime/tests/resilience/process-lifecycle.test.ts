// The process lifecycle under fault (01 4.16): T-LC-06 (the forced stop verifies the marker before it kills, and never kills
// an impostor), T-LC-08 (a start that never becomes healthy kills its own child and leaves nothing behind) and T-LC-13
// (Windows: the detached server has no console). The CLI and the server are the built ones, started from a temp copy of the
// runtime folder with its own build stamp; the test hooks of 01 2.10 (`MCS_TEST`, `MCS_TEST_IGNORE_CONTROL`,
// `MCS_TEST_BOOT_HANG`) are set only in the environment of the processes that need them.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  defaultSkillDir,
  execFileText,
  forceKill,
  listRuntimeProcesses,
  pidAlive,
  powershellEncodedArgs,
  resolveExecutable,
  waitForExit,
} from '@mcs/engine';
import { CliEnvelopeSchema, RUNTIME_VERSION, StateFileSchema } from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  buildRepo,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  spawnTracked,
  useTempDirs,
  waitFor,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const REAL_CLI = fileURLToPath(new URL('../../packages/cli/dist/main.js', import.meta.url));
const REAL_BOOT = fileURLToPath(new URL('../../packages/server/dist/boot.js', import.meta.url));
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

interface Prepared {
  readonly sb: Sandbox;
  readonly port: number;
  readonly instanceId: string;
}

async function prepare(purpose: string): Promise<Prepared> {
  const sb = sandbox(purpose);
  const port = await allocatePort();
  sb.port = port;
  const init = await mcs(sb, ['init', '--slug', SLUG, '--name', 'FIXTURE demo', '--port', String(port)]);
  expect(init.code, init.stderr).toBe(0);
  const instance = JSON.parse(readFileSync(path.join(sb.ws, 'instance.json'), 'utf8')) as { instanceId: string };
  return { sb, port, instanceId: instance.instanceId };
}

const serveArgs = (p: Prepared): string[] => [
  'serve',
  `--mcs-instance=${p.instanceId}`,
  `--instance-dir=${p.sb.ws}`,
  `--port=${String(p.port)}`,
];

function readState(sb: Sandbox): { pid: number; url: string } {
  const state = StateFileSchema.parse(JSON.parse(readFileSync(path.join(sb.ws, 'state.json'), 'utf8')));
  return { pid: state.pid, url: state.url };
}

const healthy = async (port: number): Promise<boolean> =>
  (await httpRequest(port, '/api/v3/health').catch(() => ({ status: 0 }))).status === 200;

/** HTTP is bound before `state.json` is written (01 4.4 steps 9 and 10): a server is up when both are there. */
async function serverUp(p: Prepared): Promise<void> {
  await waitFor(() => healthy(p.port), { what: 'the server to serve HTTP', timeoutMs: 60_000, intervalMs: 100 });
  await waitFor(() => existsSync(path.join(p.sb.ws, 'state.json')), { what: 'state.json', timeoutMs: 30_000 });
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

const HOOKS = { MCS_TEST: '1', MCS_TEST_IGNORE_CONTROL: '1' };

describe('T-LC-06: the forced stop (01 4.9, ADR 0006)', () => {
  it('a runtime that ignores its control channel is killed after its marker was verified; files are cleaned', async () => {
    const p = await prepare('lc06-forced');
    const server = spawnTracked(process.execPath, [p.sb.serverEntry, ...serveArgs(p)], {
      env: { ...p.sb.env, ...HOOKS },
    });
    await serverUp(p);
    expect(readState(p.sb).pid).toBe(server.pid);

    const status = await mcs(p.sb, ['status', '--task', SLUG]);
    expect(status.code).toBe(1);
    expect(JSON.parse(status.stdout)).toMatchObject({ running: false, probe: 'unhealthy', pid: server.pid });

    const stopped = await mcs(p.sb, ['stop', '--task', SLUG]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout.trim()).toMatch(
      new RegExp(
        `^stopped runtime pid ${String(server.pid)} \\(http://127[.]0[.]0[.]1:${String(p.port)}\\) \\(forced: .+\\)$`,
      ),
    );
    expect(await waitForExit(server.pid, 10_000)).toBe(true);
    expect(existsSync(path.join(p.sb.ws, 'state.json'))).toBe(false);
    expect(existsSync(path.join(p.sb.ws, 'run', 'control.token'))).toBe(false);
    await assertPortClosed(p.port);
  }, 180_000);

  it('a process that holds the name but lacks the marker is an impostor: exit 1, nothing killed, nothing deleted', async () => {
    const p = await prepare('lc06-impostor');
    // the same server, started by a wrapper whose command line has no `packages/server/dist/main.js`
    const code = [
      `import { serveMain } from ${JSON.stringify(pathToFileURL(REAL_BOOT).href)};`,
      `process.exit(await serveMain({ argv: process.argv.slice(1), env: process.env, runtimeDir: ${JSON.stringify(p.sb.runtimeDir)} }));`,
    ].join(' ');
    const impostor = spawnTracked(process.execPath, ['--input-type=module', '-e', code, ...serveArgs(p)], {
      env: { ...p.sb.env, ...HOOKS },
    });
    await serverUp(p);
    expect(readState(p.sb).pid).toBe(impostor.pid);

    const stopped = await mcs(p.sb, ['stop', '--task', SLUG]);
    expect(stopped.code).toBe(1);
    expect(stopped.stdout).toBe('');
    expect(stopped.stderr.split(LF)[0]).toBe(
      `ERROR: pid ${String(impostor.pid)} does not carry this instance's runtime marker; nothing was killed`,
    );
    expect(pidAlive(impostor.pid)).toBe(true);
    expect(await healthy(p.port)).toBe(true);
    expect(existsSync(path.join(p.sb.ws, 'state.json'))).toBe(true);
    expect(existsSync(path.join(p.sb.ws, 'run', 'control.token'))).toBe(true);
    const json = CliEnvelopeSchema.parse(JSON.parse((await mcs(p.sb, ['stop', '--task', SLUG, '--json'])).stdout));
    expect(json.error?.code).toBe('NOT_OUR_PROCESS');
    expect(pidAlive(impostor.pid)).toBe(true);
  }, 180_000);

  it('a graceful stop of a healthy runtime never needs the forced path', async () => {
    const p = await prepare('lc06-graceful');
    const started = await mcs(p.sb, ['start', '--task', SLUG]);
    expect(started.code, started.stderr).toBe(0);
    const { pid } = readState(p.sb);
    const stopped = await mcs(p.sb, ['stop', '--task', SLUG, '--json']);
    const envelope = CliEnvelopeSchema.parse(JSON.parse(stopped.stdout));
    expect(envelope.data).toMatchObject({ outcome: 'stopped', forced: false });
    expect(pidAlive(pid)).toBe(false);
  }, 180_000);
});

describe('T-LC-08: a start that never becomes healthy', () => {
  it('exits 1 after the timeout, kills the child it started and leaves no state file', async () => {
    const p = await prepare('lc08');
    const run = await mcs(p.sb, ['start', '--task', SLUG, '--timeout-ms', '1500', '--json'], {
      MCS_TEST: '1',
      MCS_TEST_BOOT_HANG: '1',
    });
    expect(run.code).toBe(1);
    const envelope = CliEnvelopeSchema.parse(JSON.parse(run.stdout));
    expect(envelope).toMatchObject({ command: 'start', ok: false, exitCode: 1, data: null });
    expect(envelope.error?.code).toBe('START_TIMEOUT');
    expect(envelope.error?.message.split(LF)[0]).toBe('runtime did not become healthy within 1.5 s');
    expect(envelope.error?.hint).toBe('mcs doctor --task demo');
    const pid = envelope.error?.details?.['pid'];
    expect(typeof pid).toBe('number');
    if (typeof pid !== 'number') return;
    expect(pidAlive(pid)).toBe(false);
    expect(existsSync(path.join(p.sb.ws, 'state.json'))).toBe(false);
    expect(await listRuntimeProcesses(p.sb.runtimeDir)).toEqual([]);
    await assertPortClosed(p.port);
    expect(existsSync(path.join(p.sb.ws, 'logs', 'boot.log'))).toBe(true);
  }, 180_000);

  it('the same instance starts normally afterwards (nothing of the failed start is in the way)', async () => {
    const p = await prepare('lc08-after');
    const failed = await mcs(p.sb, ['start', '--task', SLUG, '--timeout-ms', '1000'], {
      MCS_TEST: '1',
      MCS_TEST_BOOT_HANG: '1',
    });
    expect(failed.code).toBe(1);
    const started = await mcs(p.sb, ['start', '--task', SLUG]);
    expect(started.code, started.stderr).toBe(0);
    expect((await mcs(p.sb, ['stop', '--task', SLUG])).code).toBe(0);
  }, 180_000);
});

// ---- T-LC-13 -------------------------------------------------------------------------------------------------------------------

/**
 * One constant script: no console can be attached to a process that has none (`AttachConsole` fails with
 * ERROR_INVALID_HANDLE, 6); `MainWindowHandle` is 0 for a process without a window. Only the integer pid is interpolated.
 */
function consoleProbeScript(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('consoleProbeScript: not a pid');
  return [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -Name P -Namespace X -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(int pid); [DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();'`,
    `$proc = Get-Process -Id ${String(pid)}`,
    '[void][X.P]::FreeConsole()',
    `$ok = [X.P]::AttachConsole(${String(pid)})`,
    '$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()',
    '$hw = [X.P]::GetConsoleWindow()',
    '[void][X.P]::FreeConsole()',
    "'attach=' + $ok + ';error=' + $err + ';consoleWindow=' + $hw.ToInt64() + ';mainWindow=' + [int64]$proc.MainWindowHandle",
  ].join(LF);
}

interface ConsoleFacts {
  readonly attach: boolean;
  readonly error: number;
  readonly consoleWindow: number;
  readonly mainWindow: number;
}

async function consoleFacts(pid: number): Promise<ConsoleFacts> {
  const file = await resolveExecutable('powershell');
  if (file === null) throw new Error('powershell.exe was not found');
  const result = await execFileText({
    kind: 'powershell.cmdline',
    file,
    args: powershellEncodedArgs(consoleProbeScript(pid)),
    timeoutMs: 60_000,
    maxOutputBytes: 65_536,
    encoding: 'utf8',
  });
  const line = result.stdout.split(/\r?\n/).find((l) => l.startsWith('attach='));
  if (!result.ok || line === undefined)
    throw new Error(`the console probe failed: ${result.error ?? 'no result'} ${result.stderr}`);
  const fields = new Map<string, string>();
  for (const part of line.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) fields.set(part.slice(0, at), part.slice(at + 1));
  }
  return {
    attach: fields.get('attach') === 'True',
    error: Number(fields.get('error')),
    consoleWindow: Number(fields.get('consoleWindow')),
    mainWindow: Number(fields.get('mainWindow')),
  };
}

/** A console program started the visible way (minimized): the detector must see its console, or it cannot be trusted. */
async function visibleConsoleProgram(): Promise<number> {
  const file = await resolveExecutable('powershell');
  if (file === null) throw new Error('powershell.exe was not found');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$p = Start-Process -FilePath ping.exe -ArgumentList '-n','40','127.0.0.1' -WindowStyle Minimized -PassThru",
    'Start-Sleep -Milliseconds 800',
    "'' + $p.Id",
  ].join(LF);
  const result = await execFileText({
    kind: 'powershell.cmdline',
    file,
    args: powershellEncodedArgs(script),
    timeoutMs: 60_000,
    maxOutputBytes: 65_536,
    encoding: 'utf8',
  });
  const pid = Number(result.stdout.trim());
  if (!result.ok || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('the positive control did not start');
  return pid;
}

describe.runIf(process.platform === 'win32')(
  'T-LC-13: the detached server has no console (Windows, 01 4.15, ADR 0004)',
  () => {
    it('a server started by `mcs start` has no console and no window, and the detector sees a console that exists', async () => {
      const p = await prepare('lc13');
      const started = await mcs(p.sb, ['start', '--task', SLUG]);
      expect(started.code, started.stderr).toBe(0);
      const { pid } = readState(p.sb);

      const control = await visibleConsoleProgram();
      try {
        const visible = await consoleFacts(control);
        expect(visible.attach, 'the positive control has a console: the detector must attach to it').toBe(true);
        expect(visible.consoleWindow).toBeGreaterThan(0);
      } finally {
        await forceKill(control);
      }

      const server = await consoleFacts(pid);
      expect(server.attach, `AttachConsole to the server answered error ${String(server.error)}`).toBe(false);
      expect(server.error).toBe(6);
      expect(server.consoleWindow).toBe(0);
      expect(server.mainWindow).toBe(0);
      expect((await mcs(p.sb, ['stop', '--task', SLUG])).code).toBe(0);
    }, 240_000);
  },
);
