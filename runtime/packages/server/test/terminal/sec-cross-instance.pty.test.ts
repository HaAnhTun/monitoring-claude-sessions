// What one instance is to another, on real processes (CAW-58, design 08 section 3.6, ids TC-SEC-60, 61 and 62; project `pty`,
// Windows only). Every instance here is a real one in a hermetic temp root, on a port of the test range:
//   - TC-SEC-60: a task instance (the monitor of one repository) mounts no access, terminal or folder route: every such path, and
//     the socket upgrade, is `404 route_not_found`.
//   - TC-SEC-61: two user instances with their own homes and ports share nothing: not the cookie name, not a credential, not a
//     code, not a session; stopping one leaves the other running with its terminal.
//   - TC-SEC-62: a start on a port that is taken says so and binds nothing (no address reuse, no other port); the port the
//     product uses by default is never used by a test, and the harness refuses to name it.
// The stack variant with two in-process instances is `sec-stack-jar.int.test.ts`. A missing terminal addon FAILS the run under
// `QA_PTY_REQUIRED=1`.
import { existsSync, mkdirSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import path from 'node:path';

import {
  ACCESS_POLICY,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  TerminalStateSchema,
  buildPath,
  routes,
  type ErrorCode,
  type RouteId,
} from '@mcs/shared';
import {
  PRODUCT_DEFAULT_PORT,
  RawWsClient,
  USER_INSTANCE_PORTS,
  allocatePort,
  assertSafeCliArgs,
  assertTestPort,
  buildRepo,
  createUserSandbox,
  describePtyTests,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  makeTempDir,
  mentionsProductPort,
  parseReady,
  runCli,
  scaled,
  startInstance,
  startUserInstance,
  stripAnsi,
  waitFor,
  type TempDir,
  type UserInstance,
} from '@mcs/testkit';
import { afterEach, expect, it } from 'vitest';

const temps: TempDir[] = [];
const listeners: Server[] = [];

afterEach(async () => {
  for (const listener of listeners.splice(0)) {
    await new Promise<void>((resolve) => {
      listener.close(() => {
        resolve();
      });
    });
  }
  try {
    await killAllTracked();
  } finally {
    for (const temp of temps.splice(0)) temp.remove();
  }
});

const OUTPUT_WAIT_MS = scaled(30_000);
const EXIT_WAIT_MS = scaled(30_000);
// FIXTURE: invented values for paths that take a parameter
const SAMPLE_SESSION_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SAMPLE_PARAMS: Readonly<Record<string, string>> = {
  sessionId: SAMPLE_SESSION_ID,
  name: 'work-1',
  key: 'demo-folder',
};

function codeOf(reply: { body: string }): ErrorCode | undefined {
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
    return parsed.success ? parsed.data.error.code : undefined;
  } catch {
    return undefined;
  }
}

/** The routes that only a user instance mounts: everything that needs the session or the access code, and the session probe. */
const USER_ONLY: readonly RouteId[] = (Object.keys(ACCESS_POLICY) as RouteId[]).filter(
  (id) => ACCESS_POLICY[id] === 'session' || ACCESS_POLICY[id] === 'ticket' || id === 'authSession',
);

function pathOf(id: RouteId): string {
  return routes[id].path.replace(/:(\w+)/g, (_match, param: string) => {
    const value = SAMPLE_PARAMS[param];
    if (value === undefined) throw new Error(`sec-cross-instance: the path parameter ":${param}" has no sample value`);
    return encodeURIComponent(value);
  });
}

function cookieNameOf(cookie: string): string {
  return cookie.slice(0, cookie.indexOf('='));
}

async function namesOn(app: UserInstance, cookie: string): Promise<string[]> {
  const state = await app.api(cookie).get(routes.terminalState.path);
  return TerminalStateSchema.parse(state.json).sessions.map((session) => session.name);
}

describePtyTests('one instance and another', () => {
  it(
    'TC-SEC-60: a real task instance answers 404 route_not_found for every access, terminal and folder path, and for the socket upgrade',
    async () => {
      const temp = makeTempDir('cross-task');
      temps.push(temp);
      const env = hermeticEnv(temp.path);
      const mcsHome = env['MCS_HOME'] ?? '';
      const repo = path.join(temp.path, 'repo');
      mkdirSync(repo, { recursive: true });
      buildRepo(repo);
      const port = await allocatePort();
      assertTestPort(port);
      const slug = 'cross-task';
      const made = await runCli(
        ['init', '--name', 'FIXTURE task', '--slug', slug, '--port', String(port), '--repo', repo],
        { mcsHome, env, cwd: temp.path },
      );
      expect(made.code, made.stderr).toBe(0);
      const task = await startInstance({ repo, slug, env }, { port });

      // it is a task instance, and it serves its monitor
      const instance = await httpRequest(port, routes.instance.path);
      expect(JSON.parse(instance.body)).toMatchObject({ kind: 'task', slug });
      expect((await httpRequest(port, routes.overview.path)).status).toBe(200);

      const origin = `http://127.0.0.1:${String(port)}`;
      expect(USER_ONLY).toEqual(
        expect.arrayContaining([
          'authSession',
          'authExchange',
          'authLogout',
          'terminalState',
          'terminalSocket',
          'listFolders',
        ]),
      );
      for (const id of USER_ONLY) {
        const method = routes[id].method;
        const reply = await httpRequest(port, pathOf(id), {
          method,
          origin,
          headers: {
            // a credential of any kind changes nothing: there is no route to give it to
            Cookie: `caw_00000000=${Buffer.alloc(32, 9).toString('base64url')}`,
            ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-MCS-Request': '1' } : {}),
          },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        expect(reply.status, id).toBe(ERROR_HTTP_STATUS.route_not_found);
        expect(codeOf(reply), id).toBe('route_not_found');
        expect(reply.headers['set-cookie'], id).toBeUndefined();
      }
      const upgrade = await RawWsClient.connect(port, { path: pathOf('terminalSocket'), origin });
      expect(upgrade.status).toBe(ERROR_HTTP_STATUS.route_not_found);
      expect(codeOf(upgrade)).toBe('route_not_found');
      await task.stop();
    },
    scaled(240_000),
  );

  it(
    'TC-SEC-61: two user instances share no cookie, credential, code or session, and stopping one leaves the other running',
    async () => {
      const a = await startUserInstance({ purpose: 'cross-a' });
      const b = await startUserInstance({ purpose: 'cross-b' });
      expect(a.port).not.toBe(b.port);
      expect(a.pid).not.toBe(b.pid);
      expect(a.paths.mcsHome).not.toBe(b.paths.mcsHome);
      const [cookieA, cookieB] = [await a.cookie(), await b.cookie()];
      // each instance names its cookie after its own id, so one browser jar holds both
      expect(cookieNameOf(cookieA)).not.toBe(cookieNameOf(cookieB));
      const jar = `${cookieA}; ${cookieB}`;
      const signedIn = async (app: UserInstance, cookie: string): Promise<unknown> =>
        (await app.api(cookie).get(routes.authSession.path)).json;
      for (const [app, own, other] of [
        [a, cookieA, cookieB],
        [b, cookieB, cookieA],
      ] as const) {
        expect(await signedIn(app, own)).toEqual({ authenticated: true });
        expect(await signedIn(app, jar)).toEqual({ authenticated: true });
        expect(await signedIn(app, other)).toEqual({ authenticated: false });
        expect((await app.api(other).get(routes.terminalState.path)).status).toBe(ERROR_HTTP_STATUS.access_required);
        // the credential of the other instance under this instance's cookie name is still nothing here
        const renamed = `${cookieNameOf(own)}=${other.slice(other.indexOf('=') + 1)}`;
        expect(await signedIn(app, renamed)).toEqual({ authenticated: false });
      }

      // a code of A redeems nothing on B and is not spent by B's refusal
      const url = await a.accessUrl();
      const code = url.slice(url.indexOf('#code=') + '#code='.length);
      const onB = await b.api().post(routes.authExchange.path, { code });
      expect(onB.status).toBe(ERROR_HTTP_STATUS.access_code_invalid);
      expect(onB.headers['set-cookie']).toBeUndefined();
      expect((await a.api().post(routes.authExchange.path, { code })).status).toBe(200);

      // a session of A is a process of A: B does not list it, cannot kill it and cannot open its socket
      const session = await a.createSession(a.project('cross'));
      const viewer = await a.ws(session.name);
      const seen = (): string => stripAnsi(Buffer.concat([viewer.replay, viewer.client.collected()]));
      const ready = await waitFor(() => parseReady(seen()), { what: 'the READY line', timeoutMs: OUTPUT_WAIT_MS });
      expect(await namesOn(a, jar)).toEqual([session.name]);
      expect(await namesOn(b, jar)).toEqual([]);
      const kill = await b.api(jar).post(buildPath(routes.terminalKillSession, { name: session.name }));
      expect(kill.status).toBe(ERROR_HTTP_STATUS.terminal_not_found);
      const socket = await RawWsClient.connect(b.port, {
        path: buildPath(routes.terminalSocket, { name: session.name }),
        cookie: jar,
        origin: b.baseUrl,
      });
      expect(socket.status).toBe(ERROR_HTTP_STATUS.terminal_not_found);
      // the processes of one root do not carry the name of the other
      const ofA = (await a.processes()).map((found) => found.pid);
      const ofB = (await b.processes()).map((found) => found.pid);
      expect(ofA).toContain(ready.pid);
      expect(ofB).not.toContain(ready.pid);
      expect(ofA.filter((pid) => ofB.includes(pid))).toEqual([]);

      // B stops (it holds no terminal): A, its session and its viewer never notice
      await b.stop();
      expect((await a.api().get(routes.health.path)).status).toBe(200);
      expect(a.statePid()).toBe(a.pid);
      expect(viewer.client.closeInfo()).toBeNull();
      viewer.client.sendBinary(Buffer.from('/pid\r'));
      await waitFor(() => new RegExp(`^PID:${String(ready.pid)} `, 'm').test(seen()), {
        what: 'the session of A to answer after B stopped',
        timeoutMs: OUTPUT_WAIT_MS,
      });
      await a.stop({ force: true });
    },
    scaled(480_000),
  );

  it(
    'TC-SEC-62: a start on a taken port reports the port and binds nothing, and the default port of the product is never used',
    async () => {
      // the port the product listens on by default is outside the range of every test, and the harness refuses to name it
      expect(PRODUCT_DEFAULT_PORT < USER_INSTANCE_PORTS[0] || PRODUCT_DEFAULT_PORT > USER_INSTANCE_PORTS[1]).toBe(true);
      expect(() => {
        assertTestPort(PRODUCT_DEFAULT_PORT);
      }).toThrow();
      expect(() => {
        assertSafeCliArgs(['start', '--user', '--port', String(PRODUCT_DEFAULT_PORT)]);
      }).toThrow();

      const sandbox = await createUserSandbox({ purpose: 'cross-port' });
      const { port } = sandbox;
      assertTestPort(port);
      // somebody else holds the port: a plain listener of this test that greets whoever connects
      const holder = createServer((socket) => {
        socket.on('error', () => undefined);
        socket.end('FIXTURE-PORT-HOLDER\n');
      });
      listeners.push(holder);
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.listen(port, '127.0.0.1', () => {
          resolve();
        });
      });
      const greeting = (): Promise<string> =>
        new Promise((resolve, reject) => {
          const socket = connect({ port, host: '127.0.0.1' });
          let text = '';
          socket.on('data', (chunk: Buffer) => {
            text += chunk.toString('utf8');
          });
          socket.once('error', reject);
          socket.once('close', () => {
            resolve(text);
          });
        });

      const started = await sandbox.runJson(['start', '--user', '--no-open', '--json', '--port', String(port)]);
      expect(started.code).not.toBe(0);
      expect(started.envelope.ok).toBe(false);
      expect(started.envelope.error).not.toBeNull();
      // the failure names the port that is taken, and no other port was tried or mentioned
      const said = `${started.stdout}\n${started.stderr}`;
      expect(said).toContain(String(port));
      expect(mentionsProductPort(said)).toBe(false);
      // nothing was bound and nothing runs: the holder still answers, and no process of the root is left
      expect(await greeting()).toBe('FIXTURE-PORT-HOLDER\n');
      await waitFor(async () => (await sandbox.processes()).length === 0, {
        what: 'no process of the failed start to be left',
        timeoutMs: EXIT_WAIT_MS,
        intervalMs: 250,
      });
      expect(sandbox.statePid()).toBeNull();
      const status = await sandbox.runJson(['status', '--user', '--json']);
      expect(status.envelope.data).toMatchObject({ running: false, configured_port: port });

      // once the port is free the same start works, on that port
      await new Promise<void>((resolve) => {
        holder.close(() => {
          resolve();
        });
      });
      listeners.splice(listeners.indexOf(holder), 1);
      const app = await sandbox.start();
      expect(app.port).toBe(port);
      expect((await app.api().get(routes.health.path)).status).toBe(200);
      await app.stop();
      expect(existsSync(sandbox.root)).toBe(false);
    },
    scaled(360_000),
  );
});
