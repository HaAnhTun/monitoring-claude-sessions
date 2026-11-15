// Real ConPTY, real node-pty, the fake claude (CAW-55; design 01 section 8, design 08 section 3.4, ids TC-PTY-02 to TC-PTY-09).
// What a unit test over `FakePty` cannot show: the bytes that come out of the pseudo console (colours, wide characters, 5 MiB), the
// size the child sees after a resize, the environment it gets, how it ends, and that a kill ends the whole tree and says nothing on
// stderr. The fake claude answers with the tags of design 08 section 2.3 (READY, ECHO:, SIZE:, ...). Windows only; a missing
// addon FAILS the run (`describePtyTests`, principle 3).
import { execFile } from 'node:child_process';

import {
  BRACKETED_PASTE_ON,
  CANARY,
  FAKE_BANNER,
  burstExpected,
  describePtyTests,
  eventLoopLagProbe,
  parseReady,
  scaled,
  waitFor,
} from '@mcs/testkit';
import { expect, it } from 'vitest';

import { pidAlive } from '../../src/platform/process.ts';
import {
  A_CIRCUMFLEX_ACUTE,
  E_ACUTE,
  E_CIRCUMFLEX_DOT,
  ENGINE_TERMINAL_URL,
  GRINNING_FACE,
  PER_TEST_TIMEOUT_MS,
  SOURCE_NODE_FLAGS,
  exitWaitMs,
  readBurst,
  sameFolder,
  supportScript,
  useRealHarnesses,
  type RealSession,
} from './real-harness.ts';

const ESC = String.fromCharCode(0x1b);

interface ProbeRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs Node with `args` and reports its exit code and both streams; stderr is exactly what the process wrote. */
function runNode(args: readonly string[], env: Record<string, string>): Promise<ProbeRun> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...args],
      { env, windowsHide: true, timeout: exitWaitMs() * 2, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** The size the child reports, asked again until it is the wanted one (the resize is debounced and then sent to the console). */
async function waitForSize(session: RealSession, cols: number, rows: number): Promise<void> {
  await waitFor(
    async () => ((await session.ask('/size', 'SIZE:')) === `${String(cols)}x${String(rows)}` ? true : null),
    {
      timeoutMs: exitWaitMs(),
      intervalMs: 100,
      what: `the child to report ${String(cols)}x${String(rows)}`,
    },
  );
}

/** The last bytes of a recording, as text: the cheap way to see that a long run has finished. */
function tail(bytes: Buffer): string {
  return bytes.subarray(Math.max(0, bytes.length - 256)).toString('latin1');
}

describePtyTests('real node-pty with the fake claude', () => {
  const start = useRealHarnesses();

  it(
    'TC-PTY-02 the banner, the READY line, typed input and 24-bit colours pass through ConPTY unchanged',
    async () => {
      const h = start({ route: 'direct' });
      const s = await h.open();
      // The direct route: the root of the pseudo console is the fake claude itself, started with the size of the request.
      expect(parseReady(s.output.text())).toEqual({ pid: s.pid, cols: 120, rows: 30, args: [] });
      expect(s.fakePid).toBe(s.pid);
      expect(s.output.text()).toContain(FAKE_BANNER);
      // The fake switches bracketed paste on at startup, as the real client does: the sequence reaches the viewer.
      expect(s.output.raw().toString('latin1')).toContain(BRACKETED_PASTE_ON);

      expect(await s.ask('hello world', 'ECHO:')).toBe('hello world');

      s.line('/colors');
      await s.waitText('COLORS-DONE');
      const raw = s.output.raw().toString('latin1');
      const missing: string[] = [];
      for (let i = 0; i < 256; i += 1) if (!raw.includes(`${ESC}[38;5;${String(i)}m`)) missing.push(`256:${String(i)}`);
      for (let i = 0; i < 64; i += 1) {
        const triple = `${String(i * 4)};${String(255 - i * 4)};128`;
        if (!raw.includes(`${ESC}[38;2;${triple}m`)) missing.push(`rgb:${triple}`);
      }
      for (let i = 0; i < 16; i += 1) {
        if (!raw.includes(`${ESC}[${String(i < 8 ? 30 + i : 82 + i)}m`)) missing.push(`fg:${String(i)}`);
        if (!raw.includes(`${ESC}[${String(i < 8 ? 40 + i : 92 + i)}m`)) missing.push(`bg:${String(i)}`);
      }
      // 24-bit, 256-colour and 16-colour sequences all arrive byte for byte.
      expect(missing).toEqual([]);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-02 typed Vietnamese letters and an emoji reach the child and come back intact',
    async () => {
      const h = start({ route: 'direct' });
      const s = await h.open();
      const text = `ti${A_CIRCUMFLEX_ACUTE}ng Vi${E_CIRCUMFLEX_DOT}t ${GRINNING_FACE} caf${E_ACUTE}`;
      expect(await s.ask(text, 'ECHO:')).toBe(text);
      expect(s.output.text()).not.toContain(String.fromCodePoint(0xfffd));
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-03 configured arguments with spaces, a resume id and a working folder with spaces and non-ASCII letters reach the child',
    async () => {
      const resume = '0a1b2c3d-1111-4222-8333-444455556666';
      const configured = ['--name', 'two words', `--tag=${E_ACUTE} x`];
      const h = start({ route: 'direct', config: { args: configured } });
      const folder = h.projectDir(`FIXTURE-caf${E_ACUTE} x`);
      const s = await h.open({ folder, resume, cols: 200 });

      const args: unknown = JSON.parse(await s.ask('/args', 'ARGS:'));
      expect(args).toEqual([...configured, '--resume', resume]);
      expect(parseReady(s.output.text())?.args).toEqual([...configured, '--resume', resume]);
      expect(sameFolder(await s.ask('/cwd', 'CWD:'), folder)).toBe(true);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-04 a resize reaches the child (100x30, 120x40, 60x20) and sizes outside the limits are clamped before the PTY',
    async () => {
      const h = start({ route: 'direct' });
      const s = await h.open();
      for (const [cols, rows] of [
        [100, 30],
        [120, 40],
        [60, 20],
      ] as const) {
        s.session.resize(cols, rows);
        await waitForSize(s, cols, rows);
        expect(s.session.info()).toMatchObject({ cols, rows });
      }
      // Outside 20..500 by 5..200: the PTY never sees it.
      s.session.resize(9999, 9999);
      await waitForSize(s, 500, 200);
      s.session.resize(1, 1);
      await waitForSize(s, 20, 5);
      // Not a number: ignored, the size stays.
      s.session.resize(Number.NaN, 30);
      expect(await s.ask('/size', 'SIZE:')).toBe('20x5');
      expect(s.session.info()).toMatchObject({ cols: 20, rows: 5 });
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-05 the child environment drops the Claude markers, keeps other secrets and sets the terminal values',
    async () => {
      const stripped = 'FIXTURE-STRIPPED-VALUE-1f9c2b7e';
      const h = start({
        route: 'direct',
        env: {
          CLAUDECODE: '1',
          CLAUDE_SESSION_ID: stripped,
          CLAUDE_CODE_ENTRYPOINT: stripped,
          CLAUDE_CODE_FIXTURE_FLAG: stripped,
          NO_COLOR: '1',
          FORCE_COLOR: '1',
          ANTHROPIC_API_KEY: CANARY.key,
        },
      });
      const s = await h.open({ cols: 200 });

      // Dropped.
      for (const name of ['CLAUDECODE', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'NO_COLOR', 'FORCE_COLOR']) {
        expect(await s.ask(`/env ${name}`, 'ENV:')).toBe(`${name}=UNSET`);
      }
      expect(await s.ask('/envnames CLAUDE_CODE', 'ENVNAMES:')).toBe('CLAUDE_CODE:');
      expect(await s.ask('/envnames MCS_HOOK', 'ENVNAMES:')).toBe('MCS_HOOK:');
      expect(await s.ask(`/envscan ${stripped}`, 'ENVSCAN:')).toBe('ABSENT');
      // Kept: a secret of another name reaches the child and is never printed by the fake (set, not its value).
      expect(await s.ask('/env ANTHROPIC_API_KEY', 'ENV:')).toBe('ANTHROPIC_API_KEY=set');
      expect(await s.ask(`/envscan ${CANARY.key}`, 'ENVSCAN:')).toBe('FOUND');
      expect(await s.ask('/envnames MCS_TEST', 'ENVNAMES:')).toBe('MCS_TEST:MCS_TEST');
      // Set by the service.
      expect(await s.ask('/env COLORTERM', 'ENV:')).toBe('COLORTERM=truecolor');
      expect(await s.ask('/env TERM', 'ENV:')).toBe('TERM=xterm-256color');
      expect(await s.ask('/envnames TERM_PROGRAM', 'ENVNAMES:')).toBe('TERM_PROGRAM:TERM_PROGRAM');
      expect(await s.ask('/envnames NoDefault', 'ENVNAMES:')).toBe('NoDefault:NoDefaultCurrentDirectoryInExePath');
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-05 a name listed in terminal.envKeep survives the stripping of the child environment',
    async () => {
      const value = 'FIXTURE-KEPT-VALUE-83d0a6e4';
      const h = start({
        route: 'direct',
        config: { envKeep: ['CLAUDE_CODE_FIXTURE_FLAG', 'claudecode'] },
        env: { CLAUDECODE: '1', CLAUDE_CODE_FIXTURE_FLAG: value, CLAUDE_CODE_OTHER_FLAG: value },
      });
      const s = await h.open({ cols: 200 });
      // The kept names reach the child (a name is compared without regard to case on Windows); the other one is still dropped.
      expect(await s.ask('/envnames CLAUDE_CODE', 'ENVNAMES:')).toBe('CLAUDE_CODE:CLAUDE_CODE_FIXTURE_FLAG');
      expect(await s.ask('/env CLAUDECODE', 'ENV:')).toBe('CLAUDECODE=1');
      expect(await s.ask(`/envscan ${value}`, 'ENVSCAN:')).toBe('FOUND');
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-07 /exit ends with code 0, /exit 3 and /crash with code 3, and each session leaves the list',
    async () => {
      const h = start({ route: 'direct' });
      // Three live sessions at once: the most a real-terminal test keeps.
      const sessions = [await h.open(), await h.open(), await h.open()] as const;
      const [a, b, c] = sessions;
      a.line('/exit');
      b.line('/exit 3');
      c.line('/crash');
      const exits = await Promise.all(sessions.map((s) => s.waitEnd()));
      expect(exits).toEqual([
        { code: 0, reason: 'exited' },
        { code: 3, reason: 'exited' },
        { code: 3, reason: 'exited' },
      ]);
      expect(h.service.list()).toEqual([]);
      expect(h.service.liveCount()).toBe(0);
      for (const s of sessions) expect(s.endedView()?.end.reason).toBe('exited');
      expect(a.endedView()?.text).toContain('BYE:0');
      expect(b.endedView()?.text).toContain('BYE:3');
      expect(c.endedView()?.text).toContain('CRASH');
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-07 a process ended from outside ends the session as exited, with a non-zero code',
    async () => {
      const h = start({ route: 'direct' });
      const s = await h.open();
      // The root of the direct route is the fake claude: ending it is what a crash or a task manager does.
      process.kill(s.pid);
      const exit = await s.waitEnd();
      expect(exit.reason).toBe('exited');
      expect(exit.code).not.toBeNull();
      expect(exit.code).not.toBe(0);
      expect(h.service.list()).toEqual([]);
      expect(s.endedView()?.end.reason).toBe('exited');
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-09 5 MiB of output arrives line by line in order, and the 1 MiB replay keeps an intact tail',
    async () => {
      const h = start({ route: 'direct' });
      const s = await h.open();
      s.line('/burst 5120');
      await waitFor(() => /BURST-DONE:\d+:[0-9a-f]{8}\r?\n/.test(tail(s.output.raw())), {
        timeoutMs: exitWaitMs(),
        intervalMs: 250,
        what: 'the end of the 5 MiB burst',
      });
      const expected = burstExpected(5120);
      expect(expected.lines).toBe(52_428);

      // The live consumer: every line, in order, and the checksum of the fake and of the oracle agree with what arrived.
      const live = readBurst(s.output.text());
      expect(live.seqs.length).toBe(expected.lines);
      expect(live.seqs[0]).toBe(0);
      expect(live.seqs[live.seqs.length - 1]).toBe(expected.lines - 1);
      expect(live.breaks).toBe(0);
      expect(live.done).toEqual({ lines: expected.lines, checksum: expected.checksum });
      expect(live.checksum).toBe(expected.checksum);

      // A viewer that comes later gets the last megabyte, from a line boundary, with no gap and with the closing line.
      const late = s.attachViewer();
      expect(late.replayedBytes).toBeLessThanOrEqual(h.config.replayBytes + 4);
      expect(late.replayedBytes).toBeGreaterThan(h.config.replayBytes / 2);
      const replayText = late.output.text();
      expect(/^\s*B\d{6}:[a-z0-9]{90}\r?\n/.test(replayText)).toBe(true);
      const replay = readBurst(replayText);
      expect(replay.breaks).toBe(0);
      expect(replay.seqs[replay.seqs.length - 1]).toBe(expected.lines - 1);
      expect(replay.seqs.length).toBeLessThan(expected.lines);
      expect(replay.done).toEqual(live.done);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it.each(['direct', 'shim'] as const)(
    'TC-PTY-08 kill() ends the root, the fake claude and its grandchild (%s route), and a second kill does not throw',
    async (route) => {
      const h = start({ route });
      const s = await h.open();
      const child = Number(await s.ask('/spawn', 'CHILD:'));
      const pids = [...new Set([s.pid, s.fakePid, child])];
      // The shim route has three processes (cmd.exe, the fake, its child), the direct route two.
      expect(pids.length).toBe(route === 'shim' ? 3 : 2);
      for (const pid of pids) expect(pidAlive(pid)).toBe(true);

      expect(await h.service.kill(s.name)).toBe(true);
      await h.waitGone(pids, 'the root, the fake claude and its grandchild to end');
      expect(h.service.list()).toEqual([]);
      // After the exit: unknown name, and the session object answers again with what happened.
      expect(await h.service.kill(s.name)).toBe(false);
      await expect(s.session.kill()).resolves.toMatchObject({ reason: 'killed' });
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-08 kill() before the first output ends the process, and kill twice or after the exit does not throw',
    async () => {
      const h = start({ route: 'direct' });
      const raw = h.rawSpawn();
      // node-pty has no pid and no output yet: it defers this kill until the first data event.
      raw.pty.kill();
      raw.pty.kill();
      let exited = false;
      void raw.exited.then(() => {
        exited = true;
      });
      await waitFor(() => exited, { timeoutMs: exitWaitMs(), intervalMs: 50, what: 'the killed process to exit' });
      expect(() => {
        raw.pty.kill();
        raw.pty.write('ignored after the exit');
        raw.pty.resize(100, 30);
      }).not.toThrow();
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-08 a child process that spawns and kills a pseudo console prints nothing on stderr (the defect of node-pty 1.1.0)',
    async () => {
      const h = start({ route: 'direct' });
      const folder = h.projectDir();
      // Positive control: the capture below does see what a process writes to stderr.
      const control = await runNode(['-e', "process.stderr.write('noise')"], h.env);
      expect(control).toEqual({ code: 0, stdout: '', stderr: 'noise' });

      for (const mode of ['after-data', 'immediately', 'after-data', 'immediately']) {
        const run = await runNode(
          [...SOURCE_NODE_FLAGS, supportScript('kill-probe.mjs'), ENGINE_TERMINAL_URL, h.install.script, folder, mode],
          h.env,
        );
        expect(run, `kill-probe ${mode}`).toEqual({ code: 0, stdout: 'ok\n', stderr: '' });
      }
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-08 the event loop of the host stays responsive while sessions with descendants are killed',
    async () => {
      const h = start({ route: 'direct' });
      const sessions = [await h.open(), await h.open(), await h.open()];
      const roots: number[] = [];
      for (const s of sessions) {
        // A descendant each: kill() asks the console list agent for the processes of the console.
        await s.ask('/spawn', 'CHILD:');
        roots.push(s.pid);
      }
      const probe = eventLoopLagProbe();
      await h.service.killAll();
      await h.waitGone(roots, 'the killed sessions to end');
      const { maxMs } = probe.stop();
      // A coarse bound, far above what was measured (about 25 ms): a kill that blocks on the pseudo console would be seconds.
      expect(maxMs).toBeLessThan(scaled(500));
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );
});
