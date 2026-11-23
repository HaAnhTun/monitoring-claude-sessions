// The stop guard of the app with real terminals (CAW-58, design 08 section 3.5, TC-E2E-12 at the level of the CLI; project
// `pty`, Windows only): one real app in a hermetic temp root (`startUserInstance`), two sessions of the fake claude on real pseudo
// consoles, one of them with a child process of its own.
//   - `stop` and `restart` without `--force` refuse with `TERMINALS_LIVE`: the exit code of that refusal, the number of live
//     sessions in the message and in the envelope, and NOTHING is stopped: the server, both sessions, the child and the viewers
//     go on and still answer.
//   - `stop --force` ends the server, every session and the children of the sessions, and leaves no process of the root.
// The harness refuses every call that could reach an app outside its temp root (see `user-instance.ts`), so the stops here can
// only meet the instance this test started. A missing terminal addon FAILS the run under `QA_PTY_REQUIRED=1`.
import { existsSync } from 'node:fs';

import { TerminalStateSchema, cliExitCode, routes } from '@mcs/shared';
import {
  TAG,
  assertPortClosed,
  describePtyTests,
  killAllTracked,
  parseReady,
  scaled,
  startUserInstance,
  stripAnsi,
  waitFor,
  type FakeReady,
  type RawWsClient,
  type UserInstance,
} from '@mcs/testkit';
import { afterEach, expect, it } from 'vitest';

afterEach(killAllTracked);

const OUTPUT_WAIT_MS = scaled(30_000);
const EXIT_WAIT_MS = scaled(30_000);
const REFUSED = cliExitCode('TERMINALS_LIVE');

interface Terminal {
  readonly name: string;
  readonly client: RawWsClient;
  readonly ready: FakeReady;
  run(line: string, answer: RegExp): Promise<RegExpExecArray>;
}

async function open(app: UserInstance, folder: string): Promise<Terminal> {
  const { name } = await app.createSession(folder);
  const { client, replay } = await app.ws(name);
  const seen = (): string => stripAnsi(Buffer.concat([replay, client.collected()]));
  const ready = await waitFor(() => parseReady(seen()), {
    what: 'the READY line of the fake claude',
    timeoutMs: OUTPUT_WAIT_MS,
  });
  return {
    name,
    client,
    ready,
    run: async (line, answer) => {
      const from = seen().length;
      client.sendBinary(Buffer.from(`${line}\r`));
      return waitFor(() => answer.exec(seen().slice(from)), {
        what: `the answer of ${line.split(' ')[0] ?? 'the line'}`,
        timeoutMs: OUTPUT_WAIT_MS,
      });
    },
  };
}

/** The pids of the fake claude processes of the root, ascending. */
async function fakeClaudePids(app: UserInstance): Promise<number[]> {
  return (await app.processes())
    .filter((found) => found.commandLine.includes('fake-claude.mjs') && found.name.toLowerCase().startsWith('node'))
    .map((found) => found.pid)
    .sort((a, b) => a - b);
}

/** Whether a process exists: the null signal asks and sends nothing. */
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function liveNames(app: UserInstance): Promise<string[]> {
  const state = await app.api(await app.cookie()).get(routes.terminalState.path);
  return TerminalStateSchema.parse(state.json)
    .sessions.map((session) => session.name)
    .sort();
}

describePtyTests('stop and restart of an app with live terminals', () => {
  it(
    'TC-E2E-12: stop with live sessions exits with the refusal code and the count and stops nothing; --force ends the sessions and their children',
    async () => {
      const app = await startUserInstance({ purpose: 'stop-guard' });
      const one = await open(app, app.project('guard-a'));
      const two = await open(app, app.project('guard-b'));
      const child = await one.run('/spawn-child', new RegExp(`^${TAG.child}(\\d+)`, 'm'));
      const childPid = Number(child[1]);
      const serverPid = app.pid;
      const fakes = [one.ready.pid, two.ready.pid].sort((a, b) => a - b);
      expect(await fakeClaudePids(app)).toEqual(fakes);
      expect(exists(childPid)).toBe(true);

      /** Everything that a refused stop must leave as it was. */
      const expectUntouched = async (names: readonly string[], terminals: readonly Terminal[]): Promise<void> => {
        expect((await app.api().get(routes.health.path)).status).toBe(200);
        expect(app.statePid()).toBe(serverPid);
        expect((await app.processes()).map((found) => found.pid)).toContain(serverPid);
        expect(await liveNames(app)).toEqual([...names].sort());
        expect(exists(childPid)).toBe(true);
        for (const terminal of terminals) {
          expect(terminal.client.closeInfo()).toBeNull();
          // the same process still answers on the same socket
          const pid = await terminal.run('/pid', new RegExp(`^${TAG.pid}(\\d+)`, 'm'));
          expect(Number(pid[1])).toBe(terminal.ready.pid);
        }
        // no process of a session ended or was signalled
        expect(app.fakeLog().count('exit')).toBe(0);
        expect(app.fakeLog().count('signal')).toBe(0);
      };

      // ---- two live sessions: stop is refused, as JSON and as text ----------------------------------------------------------
      const refused = await app.runJson(['stop', '--user', '--json']);
      expect(refused.code).toBe(REFUSED);
      expect(refused.envelope).toMatchObject({ ok: false, exitCode: REFUSED, error: { code: 'TERMINALS_LIVE' } });
      expect(refused.envelope.error?.details).toMatchObject({ live: 2 });
      expect(refused.envelope.error?.message).toContain('2 terminal sessions are live');
      expect(refused.envelope.error?.hint).toContain('--force');
      const refusedText = await app.runCli(['stop', '--user']);
      expect(refusedText.code).toBe(REFUSED);
      expect(`${refusedText.stdout}${refusedText.stderr}`).toContain('2 terminal sessions are live');
      await expectUntouched([one.name, two.name], [one, two]);

      // ---- restart is guarded the same way -------------------------------------------------------------------------------------
      const restart = await app.runJson(['restart', '--user', '--no-open', '--json', '--port', String(app.port)]);
      expect(restart.code).toBe(REFUSED);
      expect(restart.envelope.error?.code).toBe('TERMINALS_LIVE');
      expect(restart.envelope.error?.details).toMatchObject({ live: 2 });
      await expectUntouched([one.name, two.name], [one, two]);

      // ---- one session ends by itself: the count follows, and one live session still refuses -----------------------------------
      await app.killSession(two.name);
      await waitFor(async () => (await fakeClaudePids(app)).length === 1, {
        what: 'the killed session to be gone',
        timeoutMs: EXIT_WAIT_MS,
        intervalMs: 250,
      });
      const single = await app.runJson(['stop', '--user', '--json']);
      expect(single.code).toBe(REFUSED);
      expect(single.envelope.error?.details).toMatchObject({ live: 1 });
      expect(single.envelope.error?.message).toContain('1 terminal session is live');
      await expectUntouched([one.name], [one]);

      // ---- --force: the server, the session and the child of the session all end ------------------------------------------------
      const port = app.port;
      const forced = await app.runJson(['stop', '--user', '--force', '--json']);
      expect(forced.code).toBe(0);
      expect(forced.envelope).toMatchObject({ ok: true, exitCode: 0, error: null });
      await waitFor(() => one.client.isClosed(), {
        what: 'the viewer to be closed by the stop',
        timeoutMs: EXIT_WAIT_MS,
      });
      await waitFor(async () => (await app.processes()).length === 0, {
        what: 'every process of the root to exit',
        timeoutMs: EXIT_WAIT_MS,
        intervalMs: 250,
      });
      await waitFor(() => !exists(childPid), { what: 'the child of the session to exit', timeoutMs: EXIT_WAIT_MS });
      expect(exists(one.ready.pid)).toBe(false);
      expect(exists(serverPid)).toBe(false);
      expect(app.statePid()).toBeNull();
      await waitFor(() => assertPortClosed(port).then(() => true), {
        what: 'the port to close',
        timeoutMs: EXIT_WAIT_MS,
      });
      // a process that was ended from outside wrote no exit entry: none of them left by itself
      expect(app.fakeLog().count('exit')).toBe(0);
      // a second stop finds nothing to stop and says so without an error
      const again = await app.runJson(['stop', '--user', '--json']);
      expect(again.code).toBe(0);
      await app.destroy();
      expect(existsSync(app.root)).toBe(false);
    },
    scaled(360_000),
  );
});
