// The lifecycle of the user instance on real processes (design 06 section 6, the integration list): `start --no-open`, a second
// `start`, `status` as lines and as JSON, `open` (recorded by the browser hook) and `open --print`, the stop guard with scripted
// terminals (exit 3, nothing stopped), `stop --force`, `restart`, an outdated app, a busy port, the upgrade before a start, the
// access code that never reaches a file or an output that did not ask for it, the login URL on 127.0.0.1 beside an IPv6 squatter,
// and the autostart shortcut on Windows.
//
// Every app runs in a sandbox of the testkit harness (`createUserSandbox`): a temp root for the per-user folder, the Claude home,
// the profile and the Windows folders, a port of the test range written to the configuration, test mode on, and a browser that is
// never opened. The harness refuses to run a command whose environment or port leaves that sandbox; the first block proves it.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { defaultSkillDir } from '@mcs/engine';
import { PRODUCT_NAME, RUNTIME_VERSION } from '@mcs/shared';
import { LOGIN_URL_RE } from '@mcs/shared/protocol';
import {
  PRODUCT_DEFAULT_PORT,
  allocatePort,
  assertPortClosed,
  createUserSandbox,
  httpRequest,
  killAllTracked,
  mentionsProductPort,
  scanFilesFor,
  startUserInstance,
  useTempDirs,
  waitFor,
  type UserInstance,
  type UserSandbox,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const makeTemp = useTempDirs();
const REAL_CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const REAL_BOOT = fileURLToPath(new URL('../../server/dist/boot.js', import.meta.url));
const REAL_MIGRATIONS = fileURLToPath(new URL('../../engine/migrations', import.meta.url));
const IS_WINDOWS = process.platform === 'win32';
const LF = String.fromCharCode(10);
const TEST_MS = 300_000;

const listeners: Server[] = [];

afterEach(async () => {
  for (const listener of listeners.splice(0)) {
    await new Promise<void>((resolve) => {
      listener.close(() => {
        resolve();
      });
    });
  }
  await killAllTracked();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataOf(run: { readonly envelope: { readonly data: unknown } }): Record<string, unknown> {
  if (!isRecord(run.envelope.data)) throw new Error('the envelope has no data object');
  return run.envelope.data;
}

function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${path.basename(file)} is not an object`);
  return parsed;
}

/**
 * True when the text holds a login URL fragment. The assertions on it compare this boolean, never the text: a failure message must
 * not print an access code into a test log.
 */
function holdsLogin(text: string): boolean {
  return text.includes('#code=');
}

function codeOf(loginUrl: string): string {
  return loginUrl.slice(loginUrl.indexOf('#code=') + '#code='.length);
}

/** The status of the health route on `port`; 0 when nothing answers there. */
async function healthStatus(port: number): Promise<number> {
  return (await httpRequest(port, '/api/v3/health').catch(() => ({ status: 0 }))).status;
}

/** A listener on `host:port`, closed after the test. Resolves `null` when the address cannot be bound. */
function listen(port: number, host: string, onConnection: () => void = () => undefined): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      onConnection();
      socket.destroy();
    });
    server.once('error', () => {
      resolve(null);
    });
    server.listen({ port, host, exclusive: true, ipv6Only: host.includes(':') }, () => {
      listeners.push(server);
      resolve(server);
    });
  });
}

/** True when this host has an IPv6 loopback that a process can listen on. Decided once, before the tests are declared. */
async function hasIpv6Loopback(): Promise<boolean> {
  // a port of the test range, like every other listener of the tests
  const port = await allocatePort();
  const can = await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen({ port, host: '::1', ipv6Only: true }, () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
  await assertPortClosed(port);
  return can;
}

const IPV6_LOOPBACK = await hasIpv6Loopback();

// ---- a private runtime copy: its own build stamp and its own launcher path ---------------------------------------------------------

interface PrivateRuntime {
  readonly cliEntry: string;
  readonly runtimeDir: string;
  /** Rewrites the build stamp of the copy (what `status` compares the running app with). */
  stamp(codeStamp: string): void;
  /** Rewrites the CLI shim so that the next call names `launcherPath` as its launcher. */
  launcher(launcherPath: string): void;
}

/**
 * A skill folder in a temp root with the defaults, a build stamp, and two shims at the paths of the real entries that run the
 * built server and CLI of the checkout with this folder as their runtime folder (the technique of `status.int.test.ts`).
 */
function privateRuntime(): PrivateRuntime {
  const skillDir = path.join(makeTemp('user-life-rt').path, 'skill');
  const runtimeDir = path.join(skillDir, 'runtime');
  const serverDist = path.join(runtimeDir, 'packages', 'server', 'dist');
  const cliDist = path.join(runtimeDir, 'packages', 'cli', 'dist');
  for (const dir of [path.join(skillDir, 'config'), serverDist, cliDist]) mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skillDir, 'config', 'defaults.json'));
  copyFileSync(path.join(defaultSkillDir(), 'runtime', 'defaults.json'), path.join(runtimeDir, 'defaults.json'));
  // the upgrade plan of a start reads the migrations of the runtime folder it runs from
  cpSync(REAL_MIGRATIONS, path.join(runtimeDir, 'packages', 'engine', 'migrations'), { recursive: true });
  const stamp = (codeStamp: string): void => {
    writeFileSync(
      path.join(runtimeDir, '.mcs-build.json'),
      JSON.stringify({ schemaVersion: 1, runtimeVersion: RUNTIME_VERSION, buildStamp: 'f'.repeat(64), codeStamp }),
    );
  };
  stamp('abcdef0123');
  writeFileSync(
    path.join(serverDist, 'main.js'),
    [
      `import { serveMain } from ${JSON.stringify(pathToFileURL(REAL_BOOT).href)};`,
      `process.exit(await serveMain({ argv: process.argv.slice(2), env: process.env, runtimeDir: ${JSON.stringify(runtimeDir)} }));`,
      '',
    ].join(LF),
  );
  const cliEntry = path.join(cliDist, 'main.js');
  const launcher = (launcherPath: string): void => {
    writeFileSync(
      cliEntry,
      [
        `import { main } from ${JSON.stringify(pathToFileURL(REAL_CLI).href)};`,
        `const paths = { launcherPath: ${JSON.stringify(launcherPath)}, skillDir: ${JSON.stringify(skillDir)}, runtimeDir: ${JSON.stringify(runtimeDir)} };`,
        'process.exitCode = await main(process.argv.slice(2), paths);',
        '',
      ].join(LF),
    );
  };
  launcher(path.join(skillDir, 'scripts', 'caw.mjs'));
  return { cliEntry, runtimeDir, stamp, launcher };
}

// ---- the sandbox itself ------------------------------------------------------------------------------------------------------------

describe('the sandbox of the lifecycle tests is hermetic', () => {
  it(
    'a new sandbox resolves the app inside its temp root: not running, the temp folder, the test port, never 7690',
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-life-box' });
      const lines = await sandbox.runCli(['status', '--user']);
      expect(lines.code).toBe(1);
      expect(lines.stdout.split(/\r?\n/)[0]).toBe(`${PRODUCT_NAME}: not running`);
      expect(lines.stdout).toContain(sandbox.paths.instanceDir);
      expect(mentionsProductPort(`${lines.stdout}${lines.stderr}`)).toBe(false);

      const json = await sandbox.runJson(['status', '--user', '--json']);
      expect(json.code).toBe(1);
      expect(dataOf(json)).toMatchObject({
        scope: 'user',
        running: false,
        configured_port: sandbox.port,
        home: sandbox.paths.instanceDir,
        state_file: sandbox.paths.stateFile,
        terminals: null,
      });
      expect(mentionsProductPort(json.stdout)).toBe(false);
      expect(sandbox.statePid()).toBeNull();
      expect(await sandbox.processes()).toEqual([]);
    },
    TEST_MS,
  );

  it(
    'the harness refuses a command that names port 7690, a port outside the test range, or a home outside the root',
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-life-box' });
      const elsewhere = makeTemp('user-life-else').path;
      const refused: (() => Promise<unknown>)[] = [
        () => sandbox.runCli(['start', '--user', '--no-open', '--port', String(PRODUCT_DEFAULT_PORT)]),
        () => sandbox.runCli(['restart', '--user', '--force', `--port=${String(PRODUCT_DEFAULT_PORT)}`]),
        () => sandbox.runCli(['config', 'set', 'server.port', String(PRODUCT_DEFAULT_PORT)]),
        () => sandbox.runCli(['start', '--user', '--no-open', '--port', '8765']),
        () => sandbox.runCli(['status', '--user'], { env: { MCS_HOME: path.join(elsewhere, 'mcs-home') } }),
        () => sandbox.runCli(['stop', '--user', '--force'], { env: { LOCALAPPDATA: elsewhere } }),
        () => sandbox.runCli(['open', '--user'], { env: { MCS_TEST: '' } }),
      ];
      for (const call of refused) {
        // the guard rejects before a process exists: nothing ran
        await expect(call()).rejects.toThrow(/refusing to act/);
      }
      expect(sandbox.statePid()).toBeNull();
      expect(await sandbox.processes()).toEqual([]);
      expect(readdirSync(elsewhere)).toEqual(['FIXTURE.md']);
    },
    TEST_MS,
  );

  it(
    'the harness refuses a start once the configured port is not a test port any more (the product default would be used)',
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-life-box' });
      const unset = await sandbox.runCli(['configure', '--user', '--unset', 'server.port', '--reason', 'test']);
      expect(unset.code, unset.stderr).toBe(0);
      for (const command of ['start', 'restart', 'open', 'serve']) {
        await expect(sandbox.runCli([command, '--user'])).rejects.toThrow(/would start on the product default port/);
      }
      expect(sandbox.statePid()).toBeNull();
      expect(await sandbox.processes()).toEqual([]);
    },
    TEST_MS,
  );
});

// ---- start, status, open, restart, stop --------------------------------------------------------------------------------------------

describe('caw start, status, open, restart and stop of the user instance', () => {
  it(
    'start --no-open makes the instance under <MCS_HOME>/instances/user; a second start reports it; status shows it',
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-life' });
      const { port, paths } = sandbox;
      const started = await sandbox.runCli(['start', '--user', '--no-open', '--port', String(port)]);
      expect(started.code, started.stderr).toBe(0);
      const startLine = /^started: http:\/\/127\.0\.0\.1:(\d+)\/ \(pid (\d+)\)$/m.exec(started.stdout);
      expect(startLine?.[1]).toBe(String(port));
      const pid = Number(startLine?.[2]);
      expect(started.stdout).toContain('next: caw open');
      // nothing was opened and no login code was minted: no output holds one
      expect(holdsLogin(`${started.stdout}${started.stderr}`)).toBe(false);
      expect(existsSync(paths.openFile)).toBe(false);

      // the state lives in the temp per-user folder, the identity says `user`, and the seeded port of a new instance is the default
      expect(sandbox.statePid()).toBe(pid);
      expect(readJson(path.join(paths.instanceDir, 'instance.json'))).toMatchObject({ kind: 'user', slug: 'user' });
      expect(readJson(path.join(paths.instanceDir, 'config.json'))['port']).toBe(PRODUCT_DEFAULT_PORT);
      expect(readJson(path.join(paths.instanceDir, 'runtime.json'))).toMatchObject({ server: { port, portScan: 0 } });
      expect(await healthStatus(port)).toBe(200);
      // the default port of the product was never bound by this app: it listens on the port of the sandbox only
      expect(readJson(paths.stateFile)).toMatchObject({ pid, port, url: `http://127.0.0.1:${String(port)}` });

      const again = await sandbox.runCli(['start', '--user', '--no-open']);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toContain(`already running: http://127.0.0.1:${String(port)}/ (pid ${String(pid)})`);
      expect(sandbox.statePid()).toBe(pid);

      const status = await sandbox.runCli(['status', '--user']);
      expect(status.code, status.stderr).toBe(0);
      const lines = status.stdout.split(/\r?\n/);
      expect(lines[0]).toBe(`${PRODUCT_NAME} ${RUNTIME_VERSION}: running`);
      expect(status.stdout).toMatch(new RegExp(`^ {2}url: +http://127\\.0\\.0\\.1:${String(port)}/$`, 'm'));
      expect(status.stdout).toMatch(new RegExp(`^ {2}pid: +${String(pid)} \\(up \\d+ (s|min)\\)$`, 'm'));
      expect(status.stdout).toMatch(/^ {2}terminals: +0 live \(max 8\)$/m);
      expect(status.stdout).toMatch(/^ {2}outdated: +no$/m);
      expect(status.stdout).toMatch(IS_WINDOWS ? /^ {2}autostart: +off$/m : /^ {2}autostart: +unsupported$/m);
      expect(status.stdout).toContain(paths.instanceDir);
      expect(holdsLogin(status.stdout)).toBe(false);

      const json = await sandbox.runJson(['status', '--user', '--json']);
      expect(json.code).toBe(0);
      expect(json.envelope).toMatchObject({ command: 'status', ok: true, exitCode: 0, error: null });
      expect(dataOf(json)).toMatchObject({
        scope: 'user',
        running: true,
        pid,
        url: `http://127.0.0.1:${String(port)}`,
        configured_port: port,
        port_note: null,
        terminals: { live: 0, max: 8 },
        outdated: false,
        home: paths.instanceDir,
        logs_dir: paths.logsDir,
      });

      const stopped = await sandbox.runCli(['stop', '--user']);
      expect(stopped.code, stopped.stderr).toBe(0);
      expect(stopped.stdout).toContain(`stopped runtime pid ${String(pid)}`);
      await waitFor(() => assertPortClosed(port).then(() => true), { what: 'the port to close', timeoutMs: 30_000 });
      expect(sandbox.statePid()).toBeNull();
      // a stop of an app that does not run is not an error
      const nothing = await sandbox.runCli(['stop', '--user']);
      expect(nothing.code, nothing.stderr).toBe(0);
      expect(nothing.stdout).toContain('nothing to stop');
    },
    TEST_MS,
  );

  it(
    'open records the login URL through the browser hook, open --print shows one, and the access code leaks nowhere else',
    async () => {
      const app = await startUserInstance({ purpose: 'user-life-open' });
      const { port, paths } = app;

      // `open`: the URL goes to the recorder of the hook (instead of a browser) and to no output
      const opened = await app.runCli(['open', '--user']);
      expect(opened.code, opened.stderr).toBe(0);
      expect(opened.stdout).toContain('opened: default browser tab');
      expect(holdsLogin(`${opened.stdout}${opened.stderr}`)).toBe(false);
      const recorded = readFileSync(paths.openFile, 'utf8').trim().split(LF);
      expect(recorded.length).toBe(1);
      const recordedUrl = recorded[0] ?? '';
      expect(LOGIN_URL_RE.test(recordedUrl)).toBe(true);
      expect(recordedUrl.startsWith(`http://127.0.0.1:${String(port)}/#code=`)).toBe(true);

      // `open --json` without `--print` carries no login either
      const openedJson = await app.runJson(['open', '--user', '--json']);
      expect(openedJson.code).toBe(0);
      const { login: jsonLogin, ...openedData } = dataOf(openedJson);
      expect(jsonLogin === null).toBe(true);
      expect(openedData).toMatchObject({ scope: 'user', port, browser: 'default-browser' });
      expect(holdsLogin(openedJson.stdout)).toBe(false);

      // `open --print`: the one line that shows it, because the person asked
      const printed = await app.runCli(['open', '--user', '--print']);
      expect(printed.code, printed.stderr).toBe(0);
      const printedUrl = /^login: (\S+) {2}\(single use, 120 s\)$/m.exec(printed.stdout)?.[1] ?? '';
      expect(LOGIN_URL_RE.test(printedUrl)).toBe(true);
      expect(holdsLogin(printed.stderr)).toBe(false);
      const jsonUrl = await app.accessUrl();

      // every code is its own, and each works once
      const codes = [...readFileSync(paths.openFile, 'utf8').trim().split(LF), printedUrl, jsonUrl].map(codeOf);
      expect(new Set(codes).size).toBe(codes.length);
      const anonymous = app.api();
      expect((await anonymous.post('/api/v3/auth/exchange', { code: codeOf(printedUrl) })).status).toBe(200);
      expect((await anonymous.post('/api/v3/auth/exchange', { code: codeOf(printedUrl) })).status).toBe(401);
      const cookie = await app.exchange();
      expect((await app.api(cookie).get('/api/v3/auth/session')).json).toEqual({ authenticated: true });

      // commands that were not asked for a login never print one
      for (const args of [
        ['status', '--user'],
        ['status', '--user', '--json'],
        ['start', '--user', '--no-open'],
      ]) {
        const run = await app.runCli(args);
        expect(holdsLogin(`${run.stdout}${run.stderr}`), args.join(' ')).toBe(false);
      }

      // a restart starts a new process on the same port, and its output holds no code
      const pidBefore = app.statePid();
      const restarted = await app.runCli(['restart', '--user', '--no-open']);
      expect(restarted.code, restarted.stderr).toBe(0);
      expect(restarted.stdout).toContain(`stopped runtime pid ${String(pidBefore)}`);
      expect(restarted.stdout).toContain(`started: http://127.0.0.1:${String(port)}/`);
      expect(holdsLogin(`${restarted.stdout}${restarted.stderr}`)).toBe(false);
      expect(app.statePid()).not.toBe(pidBefore);
      expect(await healthStatus(port)).toBe(200);
      // the session of the old process is gone with it
      expect((await app.api(cookie).get('/api/v3/auth/session')).json).toEqual({ authenticated: false });

      const stopped = await app.runCli(['stop', '--user']);
      expect(stopped.code, stopped.stderr).toBe(0);
      await waitFor(() => assertPortClosed(port).then(() => true), { what: 'the port to close', timeoutMs: 30_000 });

      // the non-leak grep (06 5.2): no file of the instance, of the per-user folder or of the profile holds a code or a
      // login URL. The recorder of the browser hook is the test's own stand-in for the browser, so it is the one file left out.
      const cookieValue = cookie.slice(cookie.indexOf('=') + 1);
      const hits = scanFilesFor([paths.mcsHome, paths.home, paths.claudeHome], [...codes, cookieValue, '#code=']);
      // a hit is named by its file and its kind, never by the text that was found
      const named = hits.map((hit) => ({
        file: path.relative(app.root, hit.file),
        found: hit.needle === '#code=' ? 'a login URL' : 'an access code or the cookie',
      }));
      expect(named).toEqual([]);
      expect(readFileSync(path.join(paths.logsDir, 'runtime.log'), 'utf8').length).toBeGreaterThan(0);
    },
    TEST_MS,
  );
});

// ---- the stop guard ---------------------------------------------------------------------------------------------------------------

describe('the stop and restart guard with live terminals (MCS_TEST_FAKE_TERMINALS=2)', () => {
  it(
    'stop and restart exit 3 with the count and the names, nothing is stopped; --force ends the app',
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-life-guard' });
      const app = await sandbox.start({ env: { MCS_TEST_FAKE_TERMINALS: '2' } });
      const { port, pid } = app;
      const stateBefore = readFileSync(app.paths.stateFile);

      const status = await app.runJson(['status', '--user', '--json']);
      expect(dataOf(status)).toMatchObject({ running: true, terminals: { live: 2, max: 8 } });

      const refused = await app.runCli(['stop', '--user']);
      expect(refused.code).toBe(3);
      expect(refused.stderr).toContain('2 terminal sessions are live (fake-1, fake-2); stopping would end them');
      expect(refused.stderr).toContain('caw stop --force');
      const refusedJson = await app.runJson(['stop', '--user', '--json']);
      expect(refusedJson.code).toBe(3);
      expect(refusedJson.envelope).toMatchObject({
        ok: false,
        exitCode: 3,
        error: { code: 'TERMINALS_LIVE', details: { live: 2, sessions: ['fake-1', 'fake-2'] } },
      });

      const noRestart = await app.runCli(['restart', '--user', '--no-open']);
      expect(noRestart.code).toBe(3);
      expect(noRestart.stderr).toContain('2 terminal sessions are live (fake-1, fake-2); restarting would end them');
      expect(noRestart.stderr).toContain('caw restart --force');

      // nothing was stopped: the same process answers, and its state file is byte for byte the one from before
      expect(app.statePid()).toBe(pid);
      expect(readFileSync(app.paths.stateFile).equals(stateBefore)).toBe(true);
      expect(await healthStatus(port)).toBe(200);
      expect((await app.processes()).map((found) => found.pid)).toContain(pid);
      // the harness reports the refusal instead of hiding it
      await expect(app.stop()).rejects.toThrow(/TERMINALS_LIVE/);
      expect(await healthStatus(port)).toBe(200);

      const forced = await app.runJson(['stop', '--user', '--force', '--json']);
      expect(forced.code, forced.stderr).toBe(0);
      expect(dataOf(forced)).toMatchObject({ scope: 'user', pid, terminalsEnded: 2 });
      await waitFor(() => assertPortClosed(port).then(() => true), { what: 'the port to close', timeoutMs: 30_000 });
      expect(app.statePid()).toBeNull();
      await waitFor(async () => (await app.processes()).length === 0, {
        what: 'the server process to be gone',
        timeoutMs: 30_000,
        intervalMs: 250,
      });
    },
    TEST_MS,
  );

  it(
    'restart --force of an app with live terminals starts a new process (the harness restart)',
    async () => {
      const sandbox = await createUserSandbox({
        purpose: 'user-life-guard',
        env: { MCS_TEST_FAKE_TERMINALS: '1' },
      });
      const app = await sandbox.start();
      const before = app.pid;
      const refused = await app.runCli(['restart', '--user', '--no-open']);
      expect(refused.code).toBe(3);
      expect(refused.stderr).toContain('1 terminal session is live (fake-1); restarting would end it');
      expect(app.statePid()).toBe(before);

      await app.restart();
      expect(app.pid).not.toBe(before);
      expect(app.statePid()).toBe(app.pid);
      expect((await app.api().get('/api/v3/health')).status).toBe(200);
      await app.stop({ force: true });
      expect(existsSync(app.root)).toBe(false);
    },
    TEST_MS,
  );
});

// ---- outdated, a busy port, the upgrade before a start ----------------------------------------------------------------------------

describe('an outdated app, a busy port and an old instance', () => {
  it(
    'status and start say outdated once the build stamp of the runtime folder is another one, and never restart the app',
    async () => {
      const runtime = privateRuntime();
      const app = await startUserInstance({ purpose: 'user-life-old', cliEntry: runtime.cliEntry });
      const pid = app.pid;
      expect(dataOf(await app.runJson(['status', '--user', '--json']))).toMatchObject({
        outdated: false,
        code_stamp: 'abcdef0123',
      });

      runtime.stamp('ffffffffff');
      const status = await app.runCli(['status', '--user']);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toMatch(/^ {2}outdated: +yes \(run `caw restart`\)$/m);
      expect(dataOf(await app.runJson(['status', '--user', '--json']))).toMatchObject({
        outdated: true,
        outdated_reason: 'code_stamp_changed',
      });

      const again = await app.runJson(['start', '--user', '--no-open', '--json']);
      expect(again.code).toBe(0);
      expect(dataOf(again)).toMatchObject({ outcome: 'already-running', outdated: true, pid });
      expect(again.envelope.warnings).toContain('the running app is outdated; run `caw restart` to use the new code');
      expect(app.statePid()).toBe(pid);

      // the restart loads the new code: the app is current again
      await app.restart();
      expect(app.pid).not.toBe(pid);
      expect(dataOf(await app.runJson(['status', '--user', '--json']))).toMatchObject({
        outdated: false,
        code_stamp: 'ffffffffff',
      });
      await app.stop();
    },
    TEST_MS,
  );

  it(
    'a listener on the configured port: the app takes the next one and start and status say which was busy',
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-life-busy', portScan: 5 });
      const { port } = sandbox;
      expect(await listen(port, '127.0.0.1')).not.toBeNull();

      const started = await sandbox.runJson(['start', '--user', '--no-open', '--json', '--port', String(port)]);
      expect(started.code, started.stderr).toBe(0);
      const data = dataOf(started);
      const used = Number(new URL(String(data['url'])).port);
      expect(used).toBeGreaterThan(port);
      expect(used).toBeLessThanOrEqual(port + 5);
      const note = `${String(port)} was busy; using ${String(used)}`;
      expect(data).toMatchObject({
        configuredPort: port,
        portNote: note,
        browserUrl: `http://127.0.0.1:${String(used)}/`,
      });
      expect(await healthStatus(used)).toBe(200);

      const lines = await sandbox.runCli(['status', '--user']);
      expect(lines.stdout).toMatch(new RegExp(`^ {2}url: +http://127\\.0\\.0\\.1:${String(used)}/$`, 'm'));
      expect(lines.stdout).toMatch(new RegExp(`^ {2}port: +${note}$`, 'm'));
      expect(dataOf(await sandbox.runJson(['status', '--user', '--json']))).toMatchObject({
        configured_port: port,
        port_note: note,
      });
      // a second start names the port the app really uses
      const again = await sandbox.runCli(['start', '--user', '--no-open']);
      expect(again.stdout).toContain(`already running: http://127.0.0.1:${String(used)}/`);
      expect(again.stdout).toContain(`note: ${note}`);

      const stopped = await sandbox.runCli(['stop', '--user']);
      expect(stopped.code, stopped.stderr).toBe(0);
      await waitFor(() => assertPortClosed(used).then(() => true), { what: 'the port to close', timeoutMs: 30_000 });
    },
    TEST_MS,
  );

  it(
    'an instance.json of an older runtime is upgraded by the start, which says so; the person never runs upgrade',
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-life-upg' });
      const file = path.join(sandbox.paths.instanceDir, 'instance.json');
      const instance = readJson(file);
      expect(instance['runtimeVersion']).toBe(RUNTIME_VERSION);
      writeFileSync(file, `${JSON.stringify({ ...instance, runtimeVersion: '3.9.0' }, null, 2)}\n`);

      const started = await sandbox.runJson(['start', '--user', '--no-open', '--json', '--port', String(sandbox.port)]);
      expect(started.code, started.stderr).toBe(0);
      expect(dataOf(started)).toMatchObject({
        outcome: 'started',
        upgraded: { runtimeFrom: '3.9.0', runtimeTo: RUNTIME_VERSION },
      });
      const message = JSON.stringify(dataOf(started)['message']);
      expect(message).toContain(`upgraded the app: runtime 3.9.0 -> ${RUNTIME_VERSION}`);
      expect(readJson(file)['runtimeVersion']).toBe(RUNTIME_VERSION);
      expect(await healthStatus(sandbox.port)).toBe(200);

      // the next start has nothing to upgrade
      const stopped = await sandbox.runCli(['stop', '--user']);
      expect(stopped.code, stopped.stderr).toBe(0);
      const second = await sandbox.runJson(['start', '--user', '--no-open', '--json']);
      expect(dataOf(second)).toMatchObject({ outcome: 'started', upgraded: null });
      expect((await sandbox.runCli(['stop', '--user'])).code).toBe(0);
    },
    TEST_MS,
  );
});

// ---- the login URL and the IPv6 loopback ------------------------------------------------------------------------------------------

describe('the login URL names 127.0.0.1, never localhost', () => {
  const title = IPV6_LOOPBACK
    ? 'with a squatter on [::1]:<port> the printed login URL still reaches the app, and the squatter hears nothing'
    : 'with a squatter on [::1]:<port> the printed login URL still reaches the app [skipped: this host has no IPv6 loopback to listen on]';

  it.skipIf(!IPV6_LOOPBACK)(
    title,
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-life-v6' });
      const { port } = sandbox;
      let heard = 0;
      const squatter = await listen(port, '::1', () => {
        heard += 1;
      });
      expect(squatter, 'the squatter on the IPv6 loopback').not.toBeNull();

      // the app binds 127.0.0.1 only, so the squatter does not make the port busy for it
      const app = await sandbox.start();
      expect(app.port).toBe(port);
      const started = await app.runJson(['start', '--user', '--no-open', '--json']);
      expect(dataOf(started)).toMatchObject({ portNote: null, browserUrl: `http://127.0.0.1:${String(port)}/` });

      const printed = await app.runCli(['open', '--user', '--print']);
      const url = /^login: (\S+)/m.exec(printed.stdout)?.[1] ?? '';
      expect(url.startsWith(`http://127.0.0.1:${String(port)}/#code=`)).toBe(true);
      expect(printed.stdout.includes('localhost')).toBe(false);
      const status = await app.runCli(['status', '--user']);
      expect(status.stdout).toContain(`http://127.0.0.1:${String(port)}/`);
      expect(status.stdout).not.toContain('localhost');
      // `open` through the browser hook records the same host
      expect((await app.runCli(['open', '--user'])).code).toBe(0);
      expect(readFileSync(app.paths.openFile, 'utf8').startsWith(`http://127.0.0.1:${String(port)}/#code=`)).toBe(true);

      // the URL is the address of the app: its code is redeemed there, and the page of that URL is the app's
      const exchanged = await app.api().post('/api/v3/auth/exchange', { code: codeOf(url) });
      expect(exchanged.status).toBe(200);
      const parsed = new URL(url);
      expect(parsed.hostname).toBe('127.0.0.1');
      expect(await healthStatus(Number(parsed.port))).toBe(200);
      expect(heard).toBe(0);
      await app.stop();
    },
    TEST_MS,
  );
});

// ---- autostart (Windows) ----------------------------------------------------------------------------------------------------------

describe.runIf(IS_WINDOWS)('autostart against a temp APPDATA (Windows)', () => {
  const SHORTCUT = 'Claude Agent Workspace.lnk';

  function startupDir(sandbox: UserSandbox): string {
    return path.join(sandbox.paths.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  }

  it(
    'enable writes a real shortcut into the Startup folder of the temp APPDATA, status reads it back, disable removes it',
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-life-auto' });
      const lnk = path.join(startupDir(sandbox), SHORTCUT);
      expect(dataOf(await sandbox.runJson(['autostart', 'status', '--user', '--json']))).toMatchObject({
        supported: true,
        enabled: false,
      });

      const enabled = await sandbox.runJson(['autostart', 'enable', '--user', '--json']);
      expect(enabled.code, enabled.stderr).toBe(0);
      const made = dataOf(enabled);
      expect(made).toMatchObject({
        supported: true,
        enabled: true,
        shortcut: lnk,
        targetExists: true,
        matchesLauncher: true,
        note: null,
      });
      expect(String(made['target']).toLowerCase()).toBe(process.execPath.toLowerCase());
      expect(String(made['arguments'])).toMatch(/^"[^"]+" start --no-open$/);
      expect(existsSync(lnk)).toBe(true);
      expect(readdirSync(startupDir(sandbox))).toEqual([SHORTCUT]);

      const lines = await sandbox.runCli(['autostart', 'status', '--user']);
      expect(lines.stdout).toContain('autostart: on');
      expect(lines.stdout).toContain(lnk);
      expect(dataOf(await sandbox.runJson(['status', '--user', '--json']))).toMatchObject({ autostart: 'on' });

      const disabled = await sandbox.runJson(['autostart', 'disable', '--user', '--json']);
      expect(disabled.code, disabled.stderr).toBe(0);
      expect(dataOf(disabled)).toMatchObject({ supported: true, enabled: false });
      expect(existsSync(lnk)).toBe(false);
      expect(dataOf(await sandbox.runJson(['status', '--user', '--json']))).toMatchObject({ autostart: 'off' });
    },
    TEST_MS,
  );

  it(
    'a start heals a shortcut that was written with a launcher path that no longer exists',
    async () => {
      const runtime = privateRuntime();
      const oldLauncher = path.join(path.dirname(runtime.runtimeDir), 'old-version', 'scripts', 'caw.mjs');
      const newLauncher = path.join(path.dirname(runtime.runtimeDir), 'scripts', 'caw.mjs');
      runtime.launcher(oldLauncher);
      const sandbox = await createUserSandbox({ purpose: 'user-life-heal', cliEntry: runtime.cliEntry });
      const enabled = await sandbox.runJson(['autostart', 'enable', '--user', '--json']);
      expect(enabled.code, enabled.stderr).toBe(0);
      expect(String(dataOf(enabled)['arguments'])).toBe(`"${oldLauncher}" start --no-open`);

      // the install moved: the same command is now run through another launcher, and the old one is gone
      runtime.launcher(newLauncher);
      const stale = dataOf(await sandbox.runJson(['autostart', 'status', '--user', '--json']));
      expect(stale).toMatchObject({ enabled: true, matchesLauncher: false });

      const started = await sandbox.runCli(['start', '--user', '--no-open', '--port', String(sandbox.port)]);
      expect(started.code, started.stderr).toBe(0);
      expect(started.stdout).toContain('refreshed the autostart shortcut');
      const healed = dataOf(await sandbox.runJson(['autostart', 'status', '--user', '--json']));
      expect(healed).toMatchObject({ enabled: true, matchesLauncher: true, note: null });
      expect(String(healed['arguments'])).toBe(`"${newLauncher}" start --no-open`);
      // only the temp Startup folder was touched
      expect(readdirSync(startupDir(sandbox))).toEqual([SHORTCUT]);

      const stopped = await sandbox.runCli(['stop', '--user']);
      expect(stopped.code, stopped.stderr).toBe(0);
    },
    TEST_MS,
  );
});

// ---- the harness on a real app (every OS): what the later suites build on -----------------------------------------------------------

describe('startUserInstance: the handle of a running app', () => {
  it(
    'gives a fresh login per call, an API with and without the cookie, and a stop that leaves nothing behind',
    async () => {
      const app: UserInstance = await startUserInstance({ purpose: 'user-life-handle' });
      const { root, port } = app;
      expect(app.baseUrl).toBe(`http://127.0.0.1:${String(port)}`);
      expect(app.statePid()).toBe(app.pid);
      expect((await app.processes()).map((found) => found.pid)).toEqual([app.pid]);

      const first = await app.accessUrl();
      const second = await app.accessUrl();
      expect(codeOf(first) === codeOf(second)).toBe(false);
      // `--print` never touched the recorder of the browser hook: no file holds a code
      expect(existsSync(app.paths.openFile)).toBe(false);

      const cookie = await app.cookie();
      expect((await app.cookie()) === cookie).toBe(true);
      expect((await app.api(cookie).get('/api/v3/terminal/state')).status).toBe(200);
      expect((await app.api().get('/api/v3/terminal/state')).status).toBe(401);
      expect(app.fakeLog().entries).toEqual([]);
      const folder = app.project('demo');
      expect(folder.endsWith('FIXTURE-demo')).toBe(true);
      expect(existsSync(folder)).toBe(true);

      await app.stop();
      expect(existsSync(root)).toBe(false);
      await assertPortClosed(port);
    },
    TEST_MS,
  );
});
