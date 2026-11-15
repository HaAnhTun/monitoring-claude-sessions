// What a start that goes wrong looks like against real processes (CAW-56; design 08 section 3.4, id TC-PTY-12). Every failure
// has to reach the caller as a TerminalError with a fixed sentence (never a path), give the slot back, leave no process and no
// registry entry, and leave the service able to start the next session.
//
// Measured on the real console (the design assumed otherwise): a pseudo console speaks first. Its initialisation bytes arrive
// about 60 ms after the spawn, before the child runs, so `create` RESOLVES for a claude that exits at once or hangs, and the
// session then ends as `exited` (the exit event follows about a second later) or stays live until it is killed. START_TIMEOUT
// therefore guards only a console that never speaks; it is proved here by a start timeout shorter than the first output.
// Windows only; a missing addon FAILS the run (`describePtyTests`).
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  TerminalOutput,
  describePtyTests,
  findProcesses,
  installFakeClaude,
  parseFakeLog,
  scanFilesFor,
  waitFor,
} from '@mcs/testkit';
import { expect, it } from 'vitest';

import { REGISTRY_DIR, TerminalError, type SessionExit, type ViewerEnd } from '../../src/terminal/index.ts';
import {
  PER_TEST_TIMEOUT_MS,
  exitWaitMs,
  outputWaitMs,
  useRealHarnesses,
  type RealHarness,
  type RealHarnessOptions,
} from './real-harness.ts';

const SESSION_BASE = 'FIXTURE-one';

/** The sentence and the cause of an error as a string: it must hold no path (every path of a run holds the marker). */
function visibleText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return JSON.stringify([error.name, error.message, error.cause ?? null]);
}

/** The error a create rejected with, as a TerminalError (the test fails when it resolved or rejected with something else). */
async function rejection(h: RealHarness, folder: string): Promise<TerminalError> {
  try {
    await h.service.create({ folder });
  } catch (error) {
    expect(error).toBeInstanceOf(TerminalError);
    if (error instanceof TerminalError) return error;
  }
  throw new Error('the create did not reject with a TerminalError');
}

function registryFiles(h: RealHarness): string[] {
  const dir = path.join(h.mcsHome, REGISTRY_DIR);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** After a failed start: nothing counted, nothing announced, nothing registered, no process of this run. */
function expectNothingLeft(h: RealHarness): void {
  expect(h.service.liveCount()).toBe(0);
  expect(h.service.list()).toEqual([]);
  expect(h.service.status().sessions).toBe(0);
  expect(h.changes.filter((change) => change.type === 'created')).toEqual([]);
  expect(registryFiles(h)).toEqual([]);
}

interface Refusal {
  readonly title: string;
  readonly code: TerminalError['code'];
  readonly options: RealHarnessOptions;
  /** Makes the request fail; returns the folder to ask for. */
  readonly arrange: (h: RealHarness) => string;
  /** Undoes `arrange`, so that the next start can succeed. */
  readonly heal: (h: RealHarness) => void;
}

const LAUNCHERS = ['claude.cmd', 'claude.ps1', 'claude'];

/** The folder of the fake keeps its script but no launcher: a PATH that holds the folder and nothing named claude. */
function removeLaunchers(binDir: string): void {
  for (const name of LAUNCHERS) rmSync(path.join(binDir, name), { force: true });
}

const REFUSALS: readonly Refusal[] = [
  {
    title: 'no claude on the search path',
    code: 'CLAUDE_NOT_FOUND',
    options: {
      route: 'shim',
      afterInstall: ({ binDir }) => {
        removeLaunchers(binDir);
      },
    },
    arrange: (h) => h.projectDir(),
    heal: (h) => {
      installFakeClaude(h.install.binDir);
    },
  },
  {
    title: 'a folder that does not exist',
    code: 'FOLDER_NOT_FOUND',
    options: { route: 'direct' },
    arrange: (h) => path.join(h.root, 'does not exist'),
    heal: () => undefined,
  },
  {
    title: 'a folder that is not an absolute path',
    code: 'FOLDER_INVALID',
    options: { route: 'direct' },
    arrange: () => 'relative\\folder',
    heal: () => undefined,
  },
  {
    title: 'a configured argument that cmd.exe would reinterpret',
    code: 'ARGS_UNSAFE',
    options: { route: 'shim', config: { args: ['one & two'] } },
    arrange: (h) => h.projectDir(),
    heal: (h) => {
      h.config.args = [];
    },
  },
  {
    title: 'a shim whose path cmd.exe would expand',
    code: 'COMMAND_UNSUPPORTED',
    // `%VAR%` is expanded by cmd.exe even inside quotes, so a shim in a folder with a percent sign is never started.
    options: { route: 'shim', binDirName: 'fake %COMSPEC% bin' },
    arrange: (h) => h.projectDir(),
    heal: (h) => {
      h.env['PATH'] = installFakeClaude(path.join(h.root, 'plain bin')).pathValue();
    },
  },
];

describePtyTests('real start failures', () => {
  const start = useRealHarnesses();

  it.each(REFUSALS)(
    'TC-PTY-12 $title is refused as $code before any process starts, and the next start is a normal one',
    async ({ code, options, arrange, heal }) => {
      const h = start(options);
      const folder = arrange(h);
      const error = await rejection(h, folder);
      expect(error.code).toBe(code);
      // The sentence of the code, with no path in it or in its cause.
      expect(visibleText(error)).not.toContain(h.marker);
      expect(visibleText(error)).not.toContain(SESSION_BASE);
      expectNothingLeft(h);
      expect(await findProcesses(h.marker)).toEqual([]);

      // The refusal took no name: the first session that does start is number 1.
      heal(h);
      const session = await h.open();
      expect(session.name).toBe(`${SESSION_BASE}-1`);
      expect(h.service.liveCount()).toBe(1);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-12 a claude that is missing and then installed: the status follows, and the next create finds it',
    async () => {
      const h = start({
        route: 'shim',
        afterInstall: ({ binDir }) => {
          removeLaunchers(binDir);
        },
      });
      expect(h.service.status().claude).toEqual({ found: false, kind: null, display: null });
      installFakeClaude(h.install.binDir);
      expect(h.service.status().claude).toMatchObject({ found: true, kind: 'shim' });
      const session = await h.open();
      expect(session.name).toBe(`${SESSION_BASE}-1`);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-12 a claude that exits at once: the create resolves, the session ends as exited with its code, and the slot is free',
    async () => {
      // One slot: a second create is only possible when the first session really gave its slot back.
      const h = start({ route: 'shim', config: { maxSessions: 1 }, env: { FAKE_CLAUDE_STARTUP: 'exit:3' } });
      const folder = h.projectDir();

      for (const number of [1, 2]) {
        const info = await h.service.create({ folder });
        h.track(info.pid);
        expect(info.name).toBe(`${SESSION_BASE}-${String(number)}`);
        const session = h.service.get(info.name);
        if (session === undefined) throw new Error('the created session is not in the service');
        const seen = new TerminalOutput();
        const state: { end: ViewerEnd | null } = { end: null };
        session.attach({
          send: (chunk) => {
            seen.push(chunk);
          },
          end: (end) => {
            state.end = end;
          },
        });

        const ended = await waitFor(
          () => h.changes.find((change) => change.type === 'ended' && change.session.name === info.name),
          { timeoutMs: exitWaitMs(), intervalMs: 50, what: 'the session of the exiting claude to end' },
        );
        const exit: SessionExit | undefined = ended.type === 'ended' ? ended.exit : undefined;
        expect(exit).toEqual({ code: 3, reason: 'exited' });
        expect(state.end?.reason).toBe('exited');
        // The fake never printed: nothing but the console's own initialisation reached the viewer.
        expect(seen.text()).not.toContain('READY');
        expect(h.service.liveCount()).toBe(0);
        expect(h.service.list()).toEqual([]);
      }

      // The program really started and chose to exit (and did not fail to start): its own log says so, twice.
      const log = parseFakeLog(readFileSync(h.env['FAKE_CLAUDE_LOG'] ?? '', 'utf8'));
      expect(log.filter((entry) => entry.ev === 'start')).toHaveLength(2);
      expect(log.filter((entry) => entry.ev === 'exit').map((entry) => entry['code'])).toEqual([3, 3]);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-12 a claude that hangs is a live session that prints nothing: it holds its slot until it is killed, and then leaves nothing',
    async () => {
      const h = start({ route: 'shim', config: { maxSessions: 1 }, env: { FAKE_CLAUDE_STARTUP: 'hang' } });
      const folder = h.projectDir();
      const info = await h.service.create({ folder });
      const session = h.service.get(info.name);
      if (session === undefined) throw new Error('the created session is not in the service');
      const seen = new TerminalOutput();
      session.attach({
        send: (chunk) => {
          seen.push(chunk);
        },
        end: () => undefined,
      });

      // The program has started when its own log says so; from there it prints nothing and never ends.
      const logFile = h.env['FAKE_CLAUDE_LOG'] ?? '';
      const waitForStarts = (count: number): Promise<boolean> =>
        waitFor(
          () =>
            existsSync(logFile) &&
            parseFakeLog(readFileSync(logFile, 'utf8')).filter((e) => e.ev === 'start').length >= count,
          { timeoutMs: outputWaitMs(), intervalMs: 50, what: 'the hanging claude to start' },
        );
      await waitForStarts(1);
      const pids = await h.service.claudePids(info.name);
      for (const pid of pids) h.track(pid);
      expect(pids.length).toBeGreaterThanOrEqual(2);
      expect(seen.text()).not.toContain('READY');
      expect(h.service.list()).toHaveLength(1);
      expect(h.service.liveCount()).toBe(1);
      // It is a session like any other: it holds the only slot.
      await expect(h.service.create({ folder })).rejects.toMatchObject({ code: 'SESSION_LIMIT' });

      // The way out of a hung program is the kill, and it ends the whole tree.
      expect(await h.service.kill(info.name)).toBe(true);
      await h.waitGone(pids, 'the root and the hung claude to end');
      expect(h.service.liveCount()).toBe(0);
      expect(h.service.list()).toEqual([]);
      expect(h.changes.filter((change) => change.type === 'ended').map((change) => change.session.name)).toEqual([
        info.name,
      ]);

      // The slot is back: the next create is not refused (and hangs the same way until the shutdown).
      const again = await h.service.create({ folder });
      expect(again.name).toBe(`${SESSION_BASE}-2`);
      // Its whole chain is up before the shutdown of `close()` ends it (a kill that races the start of the chain is not what
      // this test is about).
      await waitForStarts(2);
      for (const pid of await h.service.claudePids(again.name)) h.track(pid);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-12 a start timeout shorter than the first output is START_TIMEOUT: the slot is freed, the child is killed, nothing is left',
    async () => {
      // 1 ms: the console cannot have spoken yet (its first bytes come tens of milliseconds after the spawn). The pty has no pid
      // at that moment, so its kill is deferred to the first data event: the harness proves below that it did end.
      const h = start({ route: 'direct', config: { startTimeoutMs: 1, maxSessions: 1 }, logFile: true });
      const folder = h.projectDir();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // With one slot, a later attempt is refused as SESSION_LIMIT unless the earlier timeout gave its slot back.
        const error = await rejection(h, folder);
        expect(error.code).toBe('START_TIMEOUT');
        expect(visibleText(error)).not.toContain(h.marker);
        expectNothingLeft(h);
      }

      // The log has the failures by code, and no path, folder or name.
      await h.stop();
      const log = h.logPath ?? '';
      const text = readFileSync(log, 'utf8');
      expect(text).toContain('terminal.spawn_failed');
      expect(text).toContain('START_TIMEOUT');
      expect(scanFilesFor([log], [h.marker, SESSION_BASE, 'work space'])).toEqual([]);
      // `close()` waits for the processes of the three children (the fake claude of each) to be gone, and fails when one is not.
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-12 a program that cannot be run is SPAWN_FAILED with a fixed sentence, takes its name for good, and leaves nothing',
    async () => {
      const h = start({ route: 'shim', logFile: true });
      const broken = path.join(h.root, 'not a program.exe');
      writeFileSync(broken, 'this file is text, not a Windows program');
      h.config.command = broken;
      const folder = h.projectDir();

      const error = await rejection(h, folder);
      expect(error.code).toBe('SPAWN_FAILED');
      expect(visibleText(error)).not.toContain(h.marker);
      expect(visibleText(error)).not.toContain('not a program');
      expectNothingLeft(h);

      // The service is fine: the real claude (the fake) starts next. The name of the failed start is not handed out again.
      h.config.command = 'claude';
      const session = await h.open({ folder });
      expect(session.name).toBe(`${SESSION_BASE}-2`);

      await h.stop();
      const log = h.logPath ?? '';
      expect(readFileSync(log, 'utf8')).toContain('terminal.spawn_failed');
      expect(scanFilesFor([log], [h.marker, 'not a program', SESSION_BASE])).toEqual([]);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-12 the backend itself reports a missing program and a missing working folder as SPAWN_FAILED, without a path',
    async () => {
      const h = start({ route: 'direct' });
      const missingExe = path.join(h.root, 'nothere.exe');
      let thrown: unknown = null;
      try {
        h.backend.spawn(missingExe, [], h.root, 120, 30, h.env);
      } catch (error) {
        thrown = error;
      }
      // node-pty throws "File not found" with the path in the message: the adapter keeps a fixed sentence and a code.
      expect(thrown).toBeInstanceOf(TerminalError);
      expect(thrown).toMatchObject({ code: 'SPAWN_FAILED' });
      expect(visibleText(thrown)).not.toContain('nothere');
      expect(visibleText(thrown)).not.toContain(h.marker);

      // A working folder that does not exist: no throw, no data, an exit event with a non-zero code, and `started` rejects.
      const raw = h.rawSpawn({ folder: path.join(h.root, 'no such folder') });
      const failure = await raw.pty.started.then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(TerminalError);
      expect(failure).toMatchObject({ code: 'SPAWN_FAILED' });
      expect(visibleText(failure)).not.toContain('no such folder');
      const exit = await raw.exited;
      expect(exit.code).not.toBeNull();
      expect(exit.code).not.toBe(0);
      expect(raw.pty.pid).toBe(0);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );
});
