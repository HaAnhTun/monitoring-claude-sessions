// The production TerminalService over the real node-pty backend and the fake claude (CAW-55; design 01 section 8, design 08 section
// 3.4, ids TC-PTY-02, 03, 05, 07, 08, 09 and 14). The service is the one the server builds (`createDefaultTerminalService`); what is
// real here is everything below it: the `.cmd` shim through `cmd.exe /d /s /c`, the pseudo console, the viewers, the replay, the
// registry of children and the end of the processes. Windows only; a missing addon FAILS the run.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  CANARY,
  FAKE_BANNER,
  describePtyTests,
  parseReady,
  scanFilesFor,
  scanForCanaries,
  waitFor,
} from '@mcs/testkit';
import { expect, it } from 'vitest';

import { pidAlive } from '../../src/platform/process.ts';
import { TerminalError, stripTerminalQueries } from '../../src/terminal/index.ts';
import {
  E_ACUTE,
  PER_TEST_TIMEOUT_MS,
  exitWaitMs,
  outputWaitMs,
  sameFolder,
  useRealHarnesses,
  type RealHarness,
} from './real-harness.ts';

const ESC = String.fromCharCode(0x1b);

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The JSON files below `<mcsHome>/terminals`: one per owner process. */
function registryFiles(h: RealHarness): string[] {
  const dir = path.join(h.mcsHome, 'terminals');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name));
}

describePtyTests('terminal service over real node-pty', () => {
  const start = useRealHarnesses();

  it.each(['direct', 'shim'] as const)(
    'TC-PTY-02 the %s route starts the fake claude: banner, READY, echo, colours, and the process chain',
    async (route) => {
      const h = start({ route });
      expect(h.service.status()).toMatchObject({
        supported: true,
        reason: null,
        backend: 'node-pty',
        conptyDll: false,
        sessions: 0,
        claude: { found: true, kind: route === 'shim' ? 'shim' : 'exe' },
      });

      const s = await h.open();
      expect(parseReady(s.output.text())).toMatchObject({ pid: s.fakePid, cols: 120, rows: 30, args: [] });
      expect(s.output.text()).toContain(FAKE_BANNER);
      expect(await s.ask('through the service', 'ECHO:')).toBe('through the service');
      s.line('/colors');
      await s.waitText('COLORS-DONE');
      expect(s.output.raw().toString('latin1')).toContain(`${ESC}[38;2;0;255;128m`);

      // The chain: the shim route is cmd.exe (the root) and then the fake claude; the direct route is the fake claude alone.
      const answer = /^(\d+) PPID:(\d+)$/.exec(await s.ask('/pid', 'PID:'));
      expect(Number(answer?.[1])).toBe(s.fakePid);
      if (route === 'shim') {
        expect(s.fakePid).not.toBe(s.pid);
        expect(Number(answer?.[2])).toBe(s.pid);
      } else {
        expect(s.fakePid).toBe(s.pid);
      }
      const expected = [...new Set([s.pid, s.fakePid])].sort((a, b) => a - b);
      expect(await h.service.claudePids(s.name)).toEqual(expected);
      expect(h.service.list()).toEqual([expect.objectContaining({ name: s.name, pid: s.pid, viewers: 1 })]);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-03 the .cmd shim route passes arguments with spaces and a resume id, and starts in the working folder',
    async () => {
      const resume = '0a1b2c3d-1111-4222-8333-444455556666';
      const configured = ['--name', 'two words', 'C:\\x y\\z', `--tag=caf${E_ACUTE}`];
      // The shim sits in `fake bin <e acute>` (a space and a letter outside ASCII), the project folder has both too.
      const h = start({ route: 'shim', config: { args: configured } });
      const folder = h.projectDir(`FIXTURE-caf${E_ACUTE} x`);
      const s = await h.open({ folder, resume, cols: 200 });

      const args: unknown = JSON.parse(await s.ask('/args', 'ARGS:'));
      expect(args).toEqual([...configured, '--resume', resume]);
      expect(sameFolder(await s.ask('/cwd', 'CWD:'), folder)).toBe(true);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-09 two viewers get the same bytes, a closed tab keeps the session, and a reopened tab replays it once',
    async () => {
      const h = start({ route: 'direct' });
      const s = await h.open();
      const second = s.attachViewer();
      expect(h.service.list()[0]?.viewers).toBe(2);

      const token = 'TOKEN-two-viewers-7c1e';
      expect(await s.ask(token, 'ECHO:')).toBe(token);
      await waitFor(() => second.output.text().includes(`ECHO:${token}`), {
        timeoutMs: outputWaitMs(),
        intervalMs: 50,
        what: 'the second viewer to see the answer',
      });
      // Both viewers were fed from the same chunks (the second one began with the replay of the first viewer's start).
      expect(second.output.raw().equals(s.output.raw())).toBe(true);

      // Both tabs close: the session stays, with no viewer.
      second.detach();
      s.detach();
      expect(h.service.list()).toEqual([expect.objectContaining({ name: s.name, viewers: 0 })]);
      expect(h.service.get(s.name)).toBeDefined();

      // A reopened tab gets the whole story once: the banner, the typed line and the answer, each a single time.
      const third = s.attachViewer();
      const replay = third.output.text();
      expect(countOf(replay, `ECHO:${token}`)).toBe(1);
      expect(countOf(replay, FAKE_BANNER)).toBe(1);
      expect(third.replayedBytes).toBeGreaterThan(0);
      // And the session still answers: it never knew the tabs were gone.
      s.session.write('still here\r');
      await waitFor(() => third.output.text().includes('ECHO:still here'), {
        timeoutMs: outputWaitMs(),
        intervalMs: 50,
        what: 'the session to answer the reopened tab',
      });
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-14 hostile output reaches a live viewer, the replay holds no terminal query, and the session stays responsive',
    async () => {
      // A replay buffer big enough that nothing of the 1 MiB hostile line is trimmed away with the sequences at its start.
      const h = start({ route: 'direct', config: { replayBytes: 4 * 1024 * 1024 } });
      const s = await h.open();
      s.line('/hostile');
      await s.waitText('HOSTILE-DONE');

      // Live: the window report query and the clipboard write pass through (the stream is never filtered: the real terminal
      // decides what to do with them).
      const live = s.output.raw().toString('latin1');
      expect(live).toContain(`${ESC}[21t`);
      expect(live).toContain(`${ESC}]52;c;`);

      // Replay: the query is gone, everything else is kept, and no query form is left in what a new viewer would answer.
      const late = s.attachViewer();
      const replay = late.output.raw();
      expect(replay.length).toBeGreaterThan(1_000_000);
      const replayText = replay.toString('latin1');
      expect(replayText).not.toContain(`${ESC}[21t`);
      expect(replayText).toContain(`${ESC}]52;c;`);
      expect(stripTerminalQueries(replay).equals(replay)).toBe(true);
      expect(late.output.text()).toContain('HOSTILE-DONE');

      // ConPTY answers `ESC [ c` and `ESC [ 6 n` itself; whatever it passes on, the replay must not hold them.
      s.line('/query');
      await s.waitText('QUERY:');
      const again = s.attachViewer().output.raw().toString('latin1');
      expect(again).not.toContain(`${ESC}[c`);
      expect(again).not.toContain(`${ESC}[6n`);

      expect(await s.ask('after the hostile output', 'ECHO:')).toBe('after the hostile output');
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-07 /exit removes the session from the list, and the changes arrive as created, updated and ended in order',
    async () => {
      const h = start({ route: 'direct' });
      const s = await h.open();
      s.line('/exit');
      expect(await s.waitEnd()).toEqual({ code: 0, reason: 'exited' });
      await waitFor(() => h.service.list().length === 0, {
        timeoutMs: exitWaitMs(),
        intervalMs: 50,
        what: 'the list to be empty',
      });

      const types = h.changes.map((change) => change.type);
      expect(types[0]).toBe('created');
      expect(types.at(-1)).toBe('ended');
      expect(types.filter((type) => type === 'ended')).toHaveLength(1);
      const versions = h.changes.map((change) => change.version);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
      expect(new Set(versions).size).toBe(versions.length);

      expect(h.service.get(s.name)).toBeUndefined();
      expect(h.service.liveCount()).toBe(0);
      // The object a caller still holds refuses a viewer.
      expect(() => s.session.attach({ send: () => undefined, end: () => undefined })).toThrow(TerminalError);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-07 the session limit, the names proj-1 and proj-2, and the slot that an exit gives back',
    async () => {
      const h = start({ route: 'direct', config: { maxSessions: 2 } });
      const folder = h.projectDir('proj');
      await expect(h.service.create({ folder: path.join(h.root, 'does not exist') })).rejects.toMatchObject({
        code: 'FOLDER_NOT_FOUND',
      });

      const first = await h.open({ folder });
      const second = await h.open({ folder });
      expect([first.name, second.name]).toEqual(['proj-1', 'proj-2']);
      await expect(h.service.create({ folder })).rejects.toMatchObject({ code: 'SESSION_LIMIT' });
      expect(h.service.status()).toMatchObject({ sessions: 2, maxSessions: 2 });

      first.line('/exit');
      await first.waitEnd();
      const third = await h.open({ folder });
      // Numbers are not reused within a run: a viewer of proj-1 can never land in another session.
      expect(third.name).toBe('proj-3');
      expect(h.service.list().map((info) => info.name)).toEqual(['proj-2', 'proj-3']);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-08 shutdown() leaves no process alive, empties the child registry and refuses new sessions',
    async () => {
      const h = start({ route: 'shim' });
      const a = await h.open();
      const b = await h.open();
      const children = [Number(await a.ask('/spawn', 'CHILD:')), Number(await b.ask('/spawn', 'CHILD:'))];
      const pids = [a.pid, a.fakePid, children[0] ?? 0, b.pid, b.fakePid, children[1] ?? 0];
      expect(new Set(pids).size).toBe(6);
      for (const pid of pids) expect(pidAlive(pid)).toBe(true);

      // While they live, the registry of this owner names the roots (and only pids and times).
      const files = registryFiles(h);
      expect(files).toHaveLength(1);
      const registry: unknown = JSON.parse(readFileSync(files[0] ?? '', 'utf8'));
      expect(registry).toMatchObject({
        schemaVersion: 1,
        owner: { pid: process.pid },
        children: [{ pid: a.pid }, { pid: b.pid }],
      });

      await h.service.shutdown();
      await h.waitGone(pids, 'every process of both sessions to end');
      expect(registryFiles(h)).toEqual([]);
      expect(h.service.liveCount()).toBe(0);
      expect(h.service.list()).toEqual([]);
      expect(a.endedView()?.end.reason).toBe('shutdown');
      expect(b.endedView()?.end.reason).toBe('shutdown');
      await expect(h.service.create({ folder: h.projectDir() })).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
      await expect(h.service.shutdown()).resolves.toBeUndefined();
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-05 neither the log nor the child registry holds a folder name, a session name, typed text or terminal output',
    async () => {
      const h = start({ route: 'shim', logFile: true, env: { ANTHROPIC_API_KEY: CANARY.key } });
      // A folder named like a secret: the session name derives from the folder name and appears in URLs, never in a log.
      const folder = h.projectDir(CANARY.key);
      const s = await h.open({ folder });
      expect(s.name).toBe(`${CANARY.key}-1`);
      s.line(`typed ${CANARY.prompt}`);
      await s.waitText(`ECHO:typed ${CANARY.prompt}`);
      s.line(`/echo ${CANARY.toolResult}`);
      // Once as the typed line and once as the answer.
      await waitFor(() => countOf(s.output.text(), CANARY.toolResult) >= 2, {
        timeoutMs: outputWaitMs(),
        intervalMs: 50,
        what: 'the fake claude to print the canary',
      });

      const needles = [s.name, CANARY.key, CANARY.prompt, CANARY.toolResult, h.marker];
      const registryDir = path.join(h.mcsHome, 'terminals');
      expect(registryFiles(h)).toHaveLength(1);
      expect(scanFilesFor([registryDir], needles)).toEqual([]);
      expect(scanForCanaries([registryDir], [])).toEqual([]);

      // The log is closed (flushed) before it is read; it must not be empty, or the scan proves nothing.
      await h.stop();
      const { logPath } = h;
      expect(logPath).not.toBeNull();
      const log = readFileSync(logPath ?? '', 'utf8');
      expect(log).toContain('terminal.started');
      expect(scanFilesFor([logPath ?? ''], needles)).toEqual([]);
      expect(scanForCanaries([logPath ?? ''], [])).toEqual([]);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );
});
