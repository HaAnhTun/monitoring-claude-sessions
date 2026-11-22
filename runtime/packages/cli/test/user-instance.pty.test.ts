// The user-instance harness on a real pseudo console (design 08 section 3.2; project `pty`, Windows only): one real app in a
// hermetic temp root, the fake claude behind the production command resolution, and every step of the harness that the stack,
// browser and benchmark suites build on: start, a fresh single-use login per call, the exchange, a session that is created, used
// and killed, a restart and a stop with its leak checks. A missing terminal addon FAILS the run under `QA_PTY_REQUIRED=1`.
import { existsSync, readFileSync } from 'node:fs';

import { LOGIN_URL_RE } from '@mcs/shared/protocol';
import {
  FAKE_BANNER,
  USER_INSTANCE_PORTS,
  describePtyTests,
  killAllTracked,
  parseReady,
  scaled,
  startUserInstance,
  stripAnsi,
  waitFor,
  type UserInstance,
} from '@mcs/testkit';
import { afterEach, expect, it } from 'vitest';

afterEach(killAllTracked);

const OUTPUT_WAIT_MS = scaled(30_000);
const EXIT_WAIT_MS = scaled(30_000);

function codeOf(loginUrl: string): string {
  return loginUrl.slice(loginUrl.indexOf('#code=') + '#code='.length);
}

/** The pids of the fake claude processes of the root (the launcher `cmd.exe` of a shim carries the marker too, not this name). */
async function fakeClaudePids(app: UserInstance): Promise<number[]> {
  return (await app.processes())
    .filter((found) => found.commandLine.includes('fake-claude.mjs') && found.name.toLowerCase().startsWith('node'))
    .map((found) => found.pid);
}

describePtyTests('startUserInstance on a real terminal', () => {
  it(
    'starts hermetic, logs in with a fresh single-use code per call, runs and kills a session, restarts and stops clean',
    async () => {
      const app = await startUserInstance({ purpose: 'user-pty' });
      const { root, marker } = app;

      // ---- start: the instance lives in the temp root, on a port of the test range ----------------------------------------
      expect(app.port).toBeGreaterThanOrEqual(USER_INSTANCE_PORTS[0]);
      expect(app.port).toBeLessThanOrEqual(USER_INSTANCE_PORTS[1]);
      expect(app.statePid()).toBe(app.pid);
      expect(existsSync(app.paths.stateFile)).toBe(true);
      const health = await app.api().get('/api/v3/health');
      expect(health.status).toBe(200);
      expect((await app.processes()).map((found) => found.pid)).toContain(app.pid);

      // ---- accessUrl: a fresh code per call, each single use --------------------------------------------------------------
      const first = await app.accessUrl();
      const second = await app.accessUrl();
      for (const url of [first, second]) {
        expect(LOGIN_URL_RE.test(url)).toBe(true);
        expect(url.startsWith(`http://127.0.0.1:${String(app.port)}/#code=`)).toBe(true);
      }
      expect(codeOf(first) === codeOf(second)).toBe(false);
      const open = app.api();
      expect((await open.post('/api/v3/auth/exchange', { code: codeOf(second) })).status).toBe(200);
      expect((await open.post('/api/v3/auth/exchange', { code: codeOf(second) })).status).toBe(401);
      // the code never reached the disk: not the recorder of the browser hook, not a log, not the state
      expect(existsSync(app.paths.openFile)).toBe(false);

      // ---- exchange: a cookie that the session routes accept ----------------------------------------------------------------
      const cookie = await app.exchange();
      expect((await app.api(cookie).get('/api/v3/auth/session')).json).toEqual({ authenticated: true });
      expect((await app.api(cookie).get('/api/v3/instance')).json).toMatchObject({ kind: 'user', slug: 'user' });
      expect((await app.api().get('/api/v3/terminal/state')).status).toBe(401);
      const state = await app.api(cookie).get('/api/v3/terminal/state');
      expect(state.json).toMatchObject({ capabilities: { available: true, reason: null }, sessions: [] });

      // ---- a session: the fake claude behind the production command resolution, on a real pseudo console --------------------
      const folder = app.project('demo');
      const session = await app.createSession(folder);
      expect(session.name).toMatch(/^[A-Za-z0-9._-]+$/);
      const { client, replay } = await app.ws(session.name);
      const seen = (): string => stripAnsi(Buffer.concat([replay, client.collected()]));
      await waitFor(() => parseReady(seen()) !== null, {
        what: 'the READY line of the fake claude',
        timeoutMs: OUTPUT_WAIT_MS,
      });
      expect(seen()).toContain(FAKE_BANNER);
      const ready = parseReady(seen());
      const fakePid = ready?.pid ?? 0;
      expect(await fakeClaudePids(app)).toContain(fakePid);

      client.sendBinary(Buffer.from('/cwd\r'));
      await waitFor(() => /^CWD:/m.test(seen()), { what: 'the answer of /cwd', timeoutMs: OUTPUT_WAIT_MS });
      const log = app.fakeLog();
      expect(log.count('start')).toBe(1);
      expect(log.stdin().toString('utf8')).toContain('/cwd');
      expect(log.commands()).toContain('/cwd');
      // the child got the hermetic environment of the server, and the fake wrote where the root says
      const names = log.of('start')[0]?.['env'];
      expect(names).toEqual(expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'FAKE_CLAUDE_LOG', 'MCS_HOME', 'TERM']));

      // ---- kill: the viewer is told, the process is gone, and a killed fake wrote no exit entry -----------------------------
      await app.killSession(session.name);
      await waitFor(() => client.closeInfo() !== null, {
        what: 'the socket to close after the kill',
        timeoutMs: EXIT_WAIT_MS,
      });
      expect(client.closeInfo()?.code).toBe(4001);
      await waitFor(async () => !(await fakeClaudePids(app)).includes(fakePid), {
        what: 'the fake claude to be gone after the kill',
        timeoutMs: EXIT_WAIT_MS,
        intervalMs: 250,
      });
      expect(app.fakeLog().count('exit')).toBe(0);
      expect((await app.api(cookie).get('/api/v3/terminal/state')).json).toMatchObject({ sessions: [] });

      // ---- restart: a new process on the same port; the old cookie died with the old one --------------------------------------
      const pidBefore = app.pid;
      const portBefore = app.port;
      await app.restart();
      expect(app.pid).not.toBe(pidBefore);
      expect(app.port).toBe(portBefore);
      expect(app.statePid()).toBe(app.pid);
      expect((await app.api(cookie).get('/api/v3/auth/session')).json).toEqual({ authenticated: false });
      const again = await app.createSession(folder);
      await waitFor(async () => (await fakeClaudePids(app)).length === 1, {
        what: 'the fake claude of the session after the restart',
        timeoutMs: OUTPUT_WAIT_MS,
        intervalMs: 250,
      });
      expect(app.fakeLog().count('start')).toBe(2);

      // ---- stop: refused while the terminal is live (nothing changes), then forced, with the leak checks of the harness -------
      await expect(app.stop()).rejects.toThrow(/TERMINALS_LIVE/);
      expect((await app.api().get('/api/v3/health')).status).toBe(200);
      expect(app.statePid()).toBe(app.pid);
      const live = await app.api(await app.cookie()).get('/api/v3/terminal/state');
      expect(live.json).toMatchObject({ sessions: [{ name: again.name }] });

      await app.stop({ force: true, keepFiles: true });
      expect(await app.processes()).toEqual([]);
      expect(app.statePid()).toBeNull();
      // nothing on disk holds an access code: the logs of the instance are searched for both codes that were minted
      for (const code of [codeOf(first), codeOf(second)]) {
        expect(readFileSync(`${app.paths.logsDir}/runtime.log`, 'utf8').includes(code)).toBe(false);
      }
      await app.destroy();
      expect(existsSync(root)).toBe(false);
      expect(marker.length).toBeGreaterThanOrEqual(12);
    },
    scaled(360_000),
  );

  it(
    'stop() without force ends an app that holds no terminal, and removes the temp tree itself',
    async () => {
      const app = await startUserInstance({ purpose: 'user-pty-idle' });
      const { root } = app;
      await app.stop();
      expect(existsSync(root)).toBe(false);
      // nothing answers on the port any more
      await expect(app.api().get('/api/v3/health')).rejects.toThrow();
    },
    scaled(240_000),
  );
});
