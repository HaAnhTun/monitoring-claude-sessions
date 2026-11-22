// The lifecycle of the user instance under fault (06 section 6, resilience; 06 3.5):
//   - an app that holds its control channel and never answers (`MCS_TEST_IGNORE_CONTROL`) cannot be counted, so `stop` and
//     `restart` refuse (exit 3) and only `--force` ends it, after the marker of the process was verified; no file is left that
//     would keep the next start from working;
//   - an app that can no longer be asked while a REAL terminal runs: the forced stop ends the whole process tree, the claude of
//     the terminal and its own child included (Windows with the terminal addon; skipped with the reason elsewhere);
//   - a `restart` that is refused because terminals are live changes nothing: not the process, not a file.
// Every app lives in a sandbox of the testkit harness (temp per-user folder, a port of the test range, test mode on); the server
// that is started by hand gets the same environment, checked by the same guard.
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pidAlive, waitForExit } from '@mcs/engine';
import {
  assertHermeticEnv,
  assertPortClosed,
  createUserSandbox,
  describePtyTests,
  httpRequest,
  killAllTracked,
  parseReady,
  scaled,
  snapshotTree,
  spawnTracked,
  startUserInstance,
  stripAnsi,
  waitFor,
  type UserSandbox,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const SERVER_ENTRY = fileURLToPath(new URL('../../packages/server/dist/main.js', import.meta.url));
const TEST_MS = 300_000;

afterEach(killAllTracked);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataOf(run: { readonly envelope: { readonly data: unknown } }): Record<string, unknown> {
  if (!isRecord(run.envelope.data)) throw new Error('the envelope has no data object');
  return run.envelope.data;
}

function instanceIdOf(sandbox: UserSandbox): string {
  const parsed: unknown = JSON.parse(readFileSync(path.join(sandbox.paths.instanceDir, 'instance.json'), 'utf8'));
  if (!isRecord(parsed) || typeof parsed['instanceId'] !== 'string') throw new Error('instance.json has no instanceId');
  return parsed['instanceId'];
}

async function healthStatus(port: number): Promise<number> {
  return (await httpRequest(port, '/api/v3/health').catch(() => ({ status: 0 }))).status;
}

const UNKNOWN_CENSUS = 'the app does not answer, so its terminal sessions cannot be counted';

describe('a hung user instance (MCS_TEST_IGNORE_CONTROL)', () => {
  it(
    'cannot be counted: stop and restart refuse with exit 3 and kill nothing; stop --force verifies the process and ends it',
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-res-hung' });
      const { port, paths } = sandbox;
      // the server by hand, as the CLI would start it, with the hook that makes its control channel ignore every request
      const env = { ...sandbox.env, MCS_TEST_IGNORE_CONTROL: '1' };
      assertHermeticEnv(env, sandbox.root);
      const server = spawnTracked(
        process.execPath,
        [
          SERVER_ENTRY,
          'serve',
          `--mcs-instance=${instanceIdOf(sandbox)}`,
          `--instance-dir=${paths.instanceDir}`,
          `--port=${String(port)}`,
        ],
        { env },
      );
      await waitFor(async () => (await healthStatus(port)) === 200 && sandbox.statePid() === server.pid, {
        what: 'the hung app to serve HTTP and write its state file',
        timeoutMs: scaled(60_000),
        intervalMs: 100,
      });
      const stateBefore = readFileSync(paths.stateFile);

      const status = await sandbox.runJson(['status', '--user', '--json']);
      expect(status.code).toBe(1);
      expect(dataOf(status)).toMatchObject({ running: false, probe: 'unhealthy', pid: server.pid, terminals: null });

      const refused = await sandbox.runJson(['stop', '--user', '--json']);
      expect(refused.code).toBe(3);
      expect(refused.envelope.error).toMatchObject({ code: 'TERMINALS_LIVE', details: { live: null } });
      expect(refused.envelope.error?.message).toContain(`${UNKNOWN_CENSUS}; stopping may end live terminals`);
      expect(refused.envelope.error?.hint).toContain('caw stop --force');
      const noRestart = await sandbox.runJson(['restart', '--user', '--no-open', '--json']);
      expect(noRestart.code).toBe(3);
      expect(noRestart.envelope.error?.message).toContain(`${UNKNOWN_CENSUS}; restarting may end live terminals`);
      expect(noRestart.envelope.error?.hint).toContain('caw restart --force');

      // nothing was killed and nothing changed
      expect(pidAlive(server.pid)).toBe(true);
      expect(await healthStatus(port)).toBe(200);
      expect(readFileSync(paths.stateFile).equals(stateBefore)).toBe(true);

      const forced = await sandbox.runJson(['stop', '--user', '--force', '--json']);
      expect(forced.code, forced.stderr).toBe(0);
      expect(dataOf(forced)).toMatchObject({ scope: 'user', outcome: 'stopped-forced', pid: server.pid, forced: true });
      expect(String(dataOf(forced)['reason'])).toContain('does not answer');
      expect(await waitForExit(server.pid, 10_000)).toBe(true);
      await assertPortClosed(port);

      // no orphan file keeps the next start from working: the state and the token are gone, and the app starts and stops again
      expect(existsSync(paths.stateFile)).toBe(false);
      expect(existsSync(path.join(paths.instanceDir, 'run', 'control.token'))).toBe(false);
      const after = await sandbox.runJson(['status', '--user', '--json']);
      expect(dataOf(after)).toMatchObject({ running: false, probe: 'stopped' });
      const app = await sandbox.start();
      expect(app.pid).not.toBe(server.pid);
      expect(await healthStatus(port)).toBe(200);
      await app.stop();
    },
    TEST_MS,
  );
});

describe('a refused restart changes nothing', () => {
  it(
    'restart with a live terminal exits 3: the same process, the same files, the same terminal count',
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-res-keep', env: { MCS_TEST_FAKE_TERMINALS: '1' } });
      const app = await sandbox.start();
      const { pid, port, paths } = app;
      // logs and the database keep moving while the app runs: everything else in the folder must stay byte for byte
      const exclude = ['logs/**', 'data/**', 'audit/**'];
      const folderBefore = snapshotTree(paths.instanceDir, { exclude });
      const stateBefore = readFileSync(paths.stateFile);

      for (const args of [
        ['restart', '--user', '--no-open', '--json'],
        ['restart', '--user', '--no-open', '--port', String(port), '--json'],
      ]) {
        const refused = await app.runJson(args);
        expect(refused.code).toBe(3);
        expect(refused.envelope.error).toMatchObject({
          code: 'TERMINALS_LIVE',
          message: '1 terminal session is live (fake-1); restarting would end it',
          details: { live: 1, sessions: ['fake-1'] },
        });
      }

      expect(app.statePid()).toBe(pid);
      expect(pidAlive(pid)).toBe(true);
      expect(readFileSync(paths.stateFile).equals(stateBefore)).toBe(true);
      expect(snapshotTree(paths.instanceDir, { exclude })).toBe(folderBefore);
      expect(await healthStatus(port)).toBe(200);
      expect(dataOf(await app.runJson(['status', '--user', '--json']))).toMatchObject({
        running: true,
        pid,
        terminals: { live: 1, max: 8 },
      });
      expect((await app.processes()).map((found) => found.pid)).toEqual([pid]);
      await app.stop({ force: true });
    },
    TEST_MS,
  );
});

describePtyTests('the forced stop ends the process tree of a real terminal', () => {
  it(
    'an app that cannot be asked any more: stop refuses, stop --force kills the server, the claude of the terminal and its child',
    async () => {
      const app = await startUserInstance({ purpose: 'user-res-tree' });
      const { pid, port, paths } = app;
      const session = await app.createSession(app.project('tree'));
      const { client, replay } = await app.ws(session.name);
      const seen = (): string => stripAnsi(Buffer.concat([replay, client.collected()]));
      await waitFor(() => parseReady(seen()) !== null, { what: 'the READY line', timeoutMs: scaled(30_000) });
      const claudePid = parseReady(seen())?.pid ?? 0;
      client.sendBinary(Buffer.from('/spawn-child\r'));
      const childPid = Number(
        (
          await waitFor(() => /^CHILD:(\d+)/m.exec(seen()), {
            what: 'the child of the fake claude',
            timeoutMs: scaled(30_000),
          })
        )[1],
      );
      expect(pidAlive(claudePid)).toBe(true);
      expect(pidAlive(childPid)).toBe(true);

      // the token is what lets the CLI talk to the app: without it the terminals cannot be counted and no shutdown can be asked
      rmSync(path.join(paths.instanceDir, 'run', 'control.token'));
      const refused = await app.runJson(['stop', '--user', '--json']);
      expect(refused.code).toBe(3);
      expect(refused.envelope.error?.message).toContain(UNKNOWN_CENSUS);
      expect(pidAlive(pid)).toBe(true);
      expect(pidAlive(claudePid)).toBe(true);
      expect(await healthStatus(port)).toBe(200);

      const forced = await app.runJson(['stop', '--user', '--force', '--json']);
      expect(forced.code, forced.stderr).toBe(0);
      expect(dataOf(forced)).toMatchObject({
        outcome: 'stopped-forced',
        pid,
        forced: true,
        reason: 'there is no control token',
      });
      for (const [what, gone] of [
        ['the server', pid],
        ['the claude of the terminal', claudePid],
        ['the child of that claude', childPid],
      ] as const) {
        expect(await waitForExit(gone, scaled(15_000)), what).toBe(true);
      }
      await assertPortClosed(port);
      expect(await app.processes()).toEqual([]);
      // a killed claude wrote no exit entry; the viewer lost its connection without a close frame, as after any kill of a server
      expect(app.fakeLog().count('exit')).toBe(0);
      await waitFor(() => client.isClosed(), { what: 'the socket of the viewer to end', timeoutMs: scaled(15_000) });
      expect(client.closeInfo()).toBeNull();
      expect(existsSync(paths.stateFile)).toBe(false);

      // the next start sweeps what the dead run recorded and works; after its own stop no record of a terminal child is left
      const next = await app.start();
      expect(next.pid).not.toBe(pid);
      expect((await next.api(await next.cookie()).get('/api/v3/terminal/state')).json).toMatchObject({ sessions: [] });
      await next.stop({ keepFiles: true });
      const registry = path.join(paths.mcsHome, 'terminals');
      expect(existsSync(registry) ? readdirSync(registry).filter((name) => name.endsWith('.json')) : []).toEqual([]);
    },
    scaled(TEST_MS),
  );
});

describe('the sandbox of these tests', () => {
  it(
    'the server that a test starts by hand cannot be given an environment outside the sandbox',
    async () => {
      const sandbox = await createUserSandbox({ purpose: 'user-res-box' });
      expect(() => assertHermeticEnv({ ...sandbox.env, MCS_HOME: path.dirname(sandbox.root) }, sandbox.root)).toThrow(
        /refusing to act/,
      );
      expect(() => assertHermeticEnv({ ...process.env }, sandbox.root)).toThrow(/refusing to act/);
      expect(assertHermeticEnv(sandbox.env, sandbox.root)).toBe(sandbox.paths.instanceDir);
    },
    TEST_MS,
  );
});
