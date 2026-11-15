// The harness of the real-terminal suites (CAW-55, design 08 sections 3.2 and 3.4): the production `TerminalService` over the real
// node-pty backend, the fake claude of the testkit on a PATH that cannot reach the real claude, and a recorder (`TerminalOutput`) on
// every session. Every file of this folder is `*.pty.test.ts` and opens with `describePtyTests`; each of them builds one harness per
// test with `useRealHarnesses()` and ends the test with `await harness.close()`.
//
// Rules the harness enforces (design 01 section 8, design 08 principles 3, 6 and 8):
// - every temp root, and every command line of a process the test starts, carries a random marker of at least 12 characters;
//   `close()` shuts the service down and then asserts, with `findProcesses(marker)` and a probe of the recorded pids, that no process of
//   this run is left; a process that is left is killed (only after its command line proved it is ours) and the test fails;
// - waits are `waitFor` polls of `scaled()` budgets, never a sleep; nothing here asserts an elapsed time;
// - the real `claude` is never started: `terminalEnv` throws when a folder of the PATH holds a launcher that is not the fake.
//
// What the harness does not do: it does not hold more than the sessions a test opens (a test keeps at most 3 live at once), and it
// never reads the real home folder (`HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR`, `MCS_HOME` are folders of the temp root).
import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TerminalSectionSchema, systemClock, type TerminalSection } from '@mcs/shared';
import {
  BURST_DEFAULT_LINE_BYTES,
  TerminalOutput,
  findProcesses,
  fnv1a32Hex,
  installFakeClaude,
  makeTempDir,
  scaled,
  stripAnsi,
  terminalEnv,
  waitFor,
  type FakeClaudeFlavour,
  type FakeClaudeInstall,
  type TempDir,
} from '@mcs/testkit';
import { afterAll, afterEach } from 'vitest';

import { createLogger, type Logger } from '../../src/log/logger.ts';
import { hostPlatform } from '../../src/platform/host.ts';
import { commandLineOf, forceKillTree, pidAlive } from '../../src/platform/process.ts';
import {
  buildLaunch,
  buildTerminalEnv,
  createDefaultTerminalService,
  createNodePtyBackend,
  realTerminalFs,
  resolveClaudeCommand,
  type Pty,
  type PtyBackend,
  type PtyExit,
  type SessionExit,
  type SessionInfo,
  type TerminalChange,
  type TerminalService,
  type TerminalSession,
  type Viewer,
  type ViewerEnd,
} from '../../src/terminal/index.ts';

/** The file URL of the terminal barrel of the engine: the support scripts import it (Node strips the types of the sources). */
export const ENGINE_TERMINAL_URL = new URL('../../src/terminal/index.ts', import.meta.url).href;

/** Node flags that let a plain `.mjs` import the TypeScript sources of the workspace: the `@mcs/source` export condition resolves `@mcs/shared`. */
export const SOURCE_NODE_FLAGS: readonly string[] = [
  '--conditions=@mcs/source',
  '--disable-warning=ExperimentalWarning',
];

/** The path of a script of the `support/` folder. */
export function supportScript(name: string): string {
  return path.join(fileURLToPath(new URL('./support/', import.meta.url)), name);
}

/** The budget of one test (design 01 section 8: 60 s). Pass it as the third argument of `it`. */
export const PER_TEST_TIMEOUT_MS = 60_000;

/** Waits for output and for a start: 15 s on a quiet machine, more under `QA_TIME_SCALE`. */
export const outputWaitMs = (): number => scaled(15_000);
/** Waits for an exit, a kill and the end of a process tree: 20 s on a quiet machine. */
export const exitWaitMs = (): number => scaled(20_000);

/** The budget of the `afterEach` that closes a harness a test left open: the wait for the processes, a kill, and the removal of the folder. */
const CLOSE_HOOK_TIMEOUT_MS = exitWaitMs() + outputWaitMs() + 30_000;

/** Characters outside ASCII are built from code points: the sources of this repository stay ASCII. */
export const E_ACUTE = String.fromCodePoint(0xe9);
export const A_CIRCUMFLEX_ACUTE = String.fromCodePoint(0x1ebf);
export const E_CIRCUMFLEX_DOT = String.fromCodePoint(0x1ec7);
export const GRINNING_FACE = String.fromCodePoint(0x1f600);

const DEFAULT_PROJECT = 'FIXTURE-one';
const POLL_MS = 50;
/** The command line of the grandchild that the fake claude starts with `/spawn`: `node -e "setTimeout(function () {}, 600000)"`. */
export const GRANDCHILD_COMMAND_LINE_PART = '600000';

export type Route = 'shim' | 'direct';

export interface RealHarnessOptions {
  /**
   * `shim` (default): `terminal.command` stays `claude`; the PATH search finds `claude.cmd` of the fake and the service runs it
   * through `cmd.exe /d /s /c`, as it runs the npm shim of the real claude. `direct`: `terminal.command` is this Node and
   * `terminal.args` start with the fake script (the `.exe` branch, no shim).
   */
  route?: Route;
  /** Over the defaults of the `terminal` section. On the direct route `args` follow the script. The service reads it at every create. */
  config?: Partial<TerminalSection>;
  /** Added to the environment of the service (the child environment is built from it), after `terminalEnv`. */
  env?: Readonly<Record<string, string>>;
  /** The folder of the fake launchers; default `fake bin <e acute>`: a space and a character outside ASCII. */
  binDirName?: string;
  flavour?: FakeClaudeFlavour;
  /** Runs after the fake is installed and before the service exists: a test replaces the launcher here. */
  afterInstall?: (where: { root: string; binDir: string; install: FakeClaudeInstall }) => void;
  /** The service gets a real logger that writes `<root>/logs/runtime.log` (debug level): for the canary scan. */
  logFile?: boolean;
}

export interface OpenOptions {
  /** A folder made by `projectDir`; default `FIXTURE-one`. */
  folder?: string;
  cols?: number;
  rows?: number;
  resume?: string;
}

export interface ViewerRecorder {
  readonly viewer: Viewer;
  readonly output: TerminalOutput;
  /** The bytes of the replay this viewer received when it attached. */
  readonly replayedBytes: number;
  /** What the viewer was told when its session ended; null while it lives. */
  ended(): ViewerEnd | null;
  detach(): void;
}

export interface RealSession {
  readonly name: string;
  readonly folder: string;
  readonly info: SessionInfo;
  /** The root of the pseudo console: the fake claude (direct route) or `cmd.exe` (shim route). */
  readonly pid: number;
  /** The pid that the READY line of the fake claude shows. */
  readonly fakePid: number;
  readonly session: TerminalSession;
  /** The first viewer, attached with its replay as soon as the session exists. */
  readonly output: TerminalOutput;
  /** Types the text and a carriage return. */
  line(text: string): void;
  /** Types a command, waits for a NEW line that starts with `tag` and returns the rest of that line (a pid found there is tracked). */
  ask(command: string, tag: string): Promise<string>;
  waitText(text: string, what?: string): Promise<void>;
  waitMatch(pattern: RegExp, what?: string): Promise<RegExpExecArray>;
  /** Waits until the service reports the end of this session. */
  waitEnd(): Promise<SessionExit>;
  /** What the first viewer was told at the end, and the text it had received by then; null before the end. */
  endedView(): { end: ViewerEnd; text: string } | null;
  attachViewer(opts?: { replay?: boolean }): ViewerRecorder;
  /** Detaches the first viewer: its recorder stops growing, the session goes on (a closed browser tab). */
  detach(): void;
}

export interface RawPty {
  readonly pty: Pty;
  /** Resolves with the exit of the process, whenever it comes. */
  readonly exited: Promise<PtyExit>;
}

export interface RealHarness {
  readonly root: string;
  /** At least 12 characters, in every path of this run: `findProcesses(marker)` finds the processes of this harness. */
  readonly marker: string;
  readonly route: Route;
  readonly install: FakeClaudeInstall;
  /** The environment of the service. A test may add a variable before the next create. */
  readonly env: Record<string, string>;
  /** The configuration the service reads at every create; a test may change `args` between creates. */
  readonly config: TerminalSection;
  readonly service: TerminalService;
  readonly backend: PtyBackend;
  /** `<mcsHome>`: the child registry writes `terminals/<pid>-<start>.json` below it. */
  readonly mcsHome: string;
  /** The log file, with `logFile: true`; otherwise null. */
  readonly logPath: string | null;
  /** Every change the service reported, in order. */
  readonly changes: readonly TerminalChange[];
  /** A real folder below the root (a space in its parent path): `<root>/work space/<name>`. */
  projectDir(name?: string): string;
  open(opts?: OpenOptions): Promise<RealSession>;
  /** Starts the fake through the production launch rules and the real backend, without a session around it. */
  rawSpawn(opts?: { folder?: string; cols?: number; rows?: number }): RawPty;
  /** True while `pid` is still the process that was recorded under it: alive, with a command line that holds what was recorded (a reused pid is not ours). */
  stillRuns(pid: number): Promise<boolean>;
  /** Waits until none of `pids` is still the recorded process. Prefer it to `pidAlive`: the system reuses pids quickly. */
  waitGone(pids: readonly number[], what?: string): Promise<void>;
  /** Records a process this run started: `close()` and `killRecordedProcesses()` end it when it is still ours (command line has `expect`). */
  track(pid: number, expect?: string): void;
  /** `service.shutdown()` and the close of the logger. Idempotent. */
  stop(): Promise<void>;
  /** `stop()`, then the proof that nothing of this run is left, then the removal of the temp root. Idempotent. */
  close(): Promise<void>;
}

// ---- process book ---------------------------------------------------------------------------------------------------------------

interface Tracked {
  readonly pid: number;
  /** A text the command line of the process must contain before it is killed (a reused pid is not ours). */
  readonly expect: string;
}

/** Every process any harness of this file recorded: the `afterAll` of `useRealHarnesses` ends what is still running. */
const BOOK = new Set<Tracked>();

async function endIfOurs(entry: Tracked): Promise<boolean> {
  if (!pidAlive(entry.pid)) return false;
  const line = await commandLineOf(entry.pid);
  // Unknown: the process may be gone by now, or its command line cannot be read. A pid whose line is unknown is left alone.
  if (!line?.includes(entry.expect)) return false;
  await forceKillTree(entry.pid);
  return true;
}

/** Ends every recorded process that still runs and is still the recorded one. Never throws. */
export async function killRecordedProcesses(): Promise<number> {
  let ended = 0;
  for (const entry of [...BOOK]) {
    try {
      if (await endIfOurs(entry)) ended += 1;
    } catch {
      // The process is gone or cannot be ended from here; the marker scan of `close()` reports what is left.
    }
    BOOK.delete(entry);
  }
  return ended;
}

// ---- text helpers ---------------------------------------------------------------------------------------------------------------

/** The rest of the line that starts with the `index`-th (from 0) occurrence of `tag`; null while that line is not complete. */
function tagLine(text: string, tag: string, index: number): string | null {
  let from = -1;
  for (let i = 0; i <= index; i += 1) {
    from = text.indexOf(tag, from + 1);
    if (from === -1) return null;
  }
  const rest = text.slice(from + tag.length);
  const end = rest.search(/[\r\n]/);
  return end === -1 ? null : rest.slice(0, end);
}

function countOf(text: string, tag: string): number {
  return text.split(tag).length - 1;
}

/** True when two paths name the same folder: the real path, without regard to case (short names, `\\?\`, the spelling of the drive). */
export function sameFolder(a: string, b: string): boolean {
  const real = (value: string): string => realpathSync.native(value).toLowerCase();
  return real(a) === real(b);
}

export interface BurstReading {
  /** The sequence numbers of the burst lines found, in the order they arrived. */
  readonly seqs: readonly number[];
  /** Places where a number is not the previous one plus one (a lost, repeated or reordered line). */
  readonly breaks: number;
  /** The closing `BURST-DONE:<lines>:<checksum>` line, when it arrived. */
  readonly done: { readonly lines: number; readonly checksum: string } | null;
  /** FNV-1a 32 over the lines found, rebuilt as the fake writes them (`B<seq>:<fill>` and CRLF). */
  readonly checksum: string;
}

/** Reads the output of `/burst` from the stripped text of a terminal: every line, in order, and the closing checksum. */
export function readBurst(text: string): BurstReading {
  const seqs: number[] = [];
  let rebuilt = '';
  let breaks = 0;
  for (const match of text.matchAll(/B(\d{6}):([a-z0-9]+)/g)) {
    const seq = Number(match[1]);
    const previous = seqs[seqs.length - 1];
    if (previous !== undefined && seq !== previous + 1) breaks += 1;
    seqs.push(seq);
    rebuilt += `B${match[1] ?? ''}:${match[2] ?? ''}\r\n`;
  }
  const done = /BURST-DONE:(\d+):([0-9a-f]{8})/.exec(text);
  return {
    seqs,
    breaks,
    done: done === null ? null : { lines: Number(done[1]), checksum: done[2] ?? '' },
    checksum: fnv1a32Hex(rebuilt),
  };
}

/** The `BURST_DEFAULT_LINE_BYTES` of the protocol, for tests that name the default line width. */
export const BURST_LINE_BYTES = BURST_DEFAULT_LINE_BYTES;

// ---- the harness ----------------------------------------------------------------------------------------------------------------

class Harness implements RealHarness {
  readonly root: string;
  readonly marker: string;
  readonly route: Route;
  readonly install: FakeClaudeInstall;
  readonly env: Record<string, string>;
  readonly config: TerminalSection;
  readonly service: TerminalService;
  readonly backend: PtyBackend;
  readonly mcsHome: string;
  readonly logPath: string | null;
  readonly changes: TerminalChange[] = [];
  readonly #temp: TempDir;
  readonly #logger: Logger | null;
  readonly #own = new Set<Tracked>();
  readonly #raw: RawPty[] = [];
  readonly #ends = new Map<string, SessionExit>();
  #stopped: Promise<void> | null = null;
  #closed: Promise<void> | null = null;

  constructor(opts: RealHarnessOptions) {
    this.route = opts.route ?? 'shim';
    this.marker = `pty-${randomBytes(8).toString('hex')}`;
    this.#temp = makeTempDir(this.marker);
    this.root = this.#temp.path;
    const binDir = path.join(this.root, opts.binDirName ?? `fake bin ${E_ACUTE}`);
    this.install = installFakeClaude(binDir, opts.flavour === undefined ? {} : { flavour: opts.flavour });
    opts.afterInstall?.({ root: this.root, binDir, install: this.install });
    this.env = terminalEnv(this.root, this.install, { ...opts.env });
    this.mcsHome = path.join(this.root, 'mcs-home');

    const config: TerminalSection = { ...TerminalSectionSchema.parse(undefined), ...opts.config };
    if (this.route === 'direct') {
      config.command = process.execPath;
      config.args = [this.install.script, ...(opts.config?.args ?? [])];
    }
    this.config = config;

    this.backend = createNodePtyBackend({
      platform: hostPlatform,
      arch: process.arch,
      release: os.release(),
      useConptyDll: config.conptyDll,
      startTimeoutMs: config.startTimeoutMs,
    });
    if (!this.backend.support.supported) {
      throw new Error(`the real terminal backend is not usable here: ${this.backend.support.reason}`);
    }
    if (opts.logFile === true) {
      this.logPath = path.join(this.root, 'logs', 'runtime.log');
      this.#logger = createLogger({ file: this.logPath, level: 'debug', rotate: false, clock: systemClock });
    } else {
      this.logPath = null;
      this.#logger = null;
    }
    const quiet = (): void => undefined;
    this.service = createDefaultTerminalService({
      config,
      logger: this.#logger ?? { debug: quiet, info: quiet, warn: quiet, error: quiet },
      mcsHome: this.mcsHome,
      backend: this.backend,
      env: () => this.env,
      home: path.join(this.root, 'home'),
    });
    this.service.onChange((change) => {
      this.changes.push(change);
      if (change.type === 'ended') this.#ends.set(change.session.name, change.exit);
    });
  }

  projectDir(name: string = DEFAULT_PROJECT): string {
    const folder = path.join(this.root, 'work space', name);
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  track(pid: number, expect: string = this.marker): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    const entry: Tracked = { pid, expect };
    this.#own.add(entry);
    BOOK.add(entry);
  }

  async open(opts: OpenOptions = {}): Promise<RealSession> {
    const folder = opts.folder ?? this.projectDir();
    const info = await this.service.create({
      folder,
      ...(opts.cols === undefined ? {} : { cols: opts.cols }),
      ...(opts.rows === undefined ? {} : { rows: opts.rows }),
      ...(opts.resume === undefined ? {} : { resume: opts.resume }),
    });
    this.track(info.pid);
    const session = this.service.get(info.name);
    if (session === undefined) throw new Error('open: the service created a session it cannot find');
    const real = new OpenSession(this, info, folder, session);
    await real.start();
    return real;
  }

  rawSpawn(opts: { folder?: string; cols?: number; rows?: number } = {}): RawPty {
    const resolved = resolveClaudeCommand({
      command: this.config.command,
      env: this.env,
      platform: hostPlatform,
      fs: realTerminalFs,
    });
    if (resolved === null) throw new Error('rawSpawn: the fake claude is not on the PATH of the harness');
    const launch = buildLaunch(resolved, this.config.args, {
      env: this.env,
      platform: hostPlatform,
      fs: realTerminalFs,
    });
    const childEnv = buildTerminalEnv(this.env, { keep: this.config.envKeep, platform: hostPlatform });
    const pty = this.backend.spawn(
      launch.file,
      launch.args,
      opts.folder ?? this.projectDir(),
      opts.cols ?? 120,
      opts.rows ?? 30,
      childEnv,
    );
    const exited = new Promise<PtyExit>((resolve) => {
      pty.onExit(resolve);
    });
    pty.started.then(
      ({ pid }) => {
        this.track(pid);
      },
      () => undefined,
    );
    const raw: RawPty = { pty, exited };
    this.#raw.push(raw);
    return raw;
  }

  sessionEnd(name: string): SessionExit | undefined {
    return this.#ends.get(name);
  }

  stop(): Promise<void> {
    this.#stopped ??= (async (): Promise<void> => {
      await this.service.shutdown();
      await this.#logger?.close();
    })();
    return this.#stopped;
  }

  close(): Promise<void> {
    this.#closed ??= this.#finish();
    return this.#closed;
  }

  /** True once `close()` was called (the `afterEach` of `useRealHarnesses` skips such a harness). */
  get isClosing(): boolean {
    return this.#closed !== null;
  }

  async #finish(): Promise<void> {
    const problems: string[] = [];
    try {
      await this.stop();
    } catch {
      problems.push('the service shutdown failed');
    }
    for (const raw of this.#raw) raw.pty.kill();
    const left = await this.#waitUntilGone();
    if (left.length > 0) {
      problems.push(`${String(left.length)} process(es) of this run were left: ${left.join(', ')}`);
      for (const pid of left) {
        try {
          await forceKillTree(pid);
        } catch {
          // Gone in the meantime.
        }
      }
    }
    for (const entry of this.#own) BOOK.delete(entry);
    try {
      await this.#removeRoot();
    } catch {
      problems.push('the temp folder of this run could not be removed');
    }
    if (problems.length > 0) throw new Error(`close: ${problems.join('; ')}`);
  }

  /**
   * The pids of this run that still exist and are provably ours: a command line that holds the marker, or a recorded pid that is
   * alive and whose command line still holds the text recorded with it. A pid that the system gave to another program after ours
   * ended is not ours and is never reported, never waited for and never killed.
   */
  async #stillThere(): Promise<number[]> {
    const found = new Set<number>((await findProcesses(this.marker)).map((row) => row.pid));
    for (const entry of this.#own) if (!found.has(entry.pid) && (await this.#isRecorded(entry))) found.add(entry.pid);
    return [...found].sort((a, b) => a - b);
  }

  async #isRecorded(entry: Tracked): Promise<boolean> {
    if (!pidAlive(entry.pid)) return false;
    const line = await commandLineOf(entry.pid);
    return line?.includes(entry.expect) === true;
  }

  async stillRuns(pid: number): Promise<boolean> {
    const entry = [...this.#own].reverse().find((candidate) => candidate.pid === pid) ?? { pid, expect: this.marker };
    return this.#isRecorded(entry);
  }

  async waitGone(pids: readonly number[], what = 'the processes to end'): Promise<void> {
    await waitFor(
      async () => {
        for (const pid of pids) if (await this.stillRuns(pid)) return false;
        return true;
      },
      { timeoutMs: exitWaitMs(), intervalMs: 100, what },
    );
  }
  async #waitUntilGone(): Promise<number[]> {
    let last: number[] = [];
    try {
      await waitFor(
        async () => {
          last = await this.#stillThere();
          return last.length === 0;
        },
        { timeoutMs: exitWaitMs(), intervalMs: 300, what: 'every process of this run to end' },
      );
      return [];
    } catch {
      return last;
    }
  }

  async #removeRoot(): Promise<void> {
    try {
      this.#temp.remove();
    } catch {
      // A process that was just killed may hold a handle for a moment.
      await waitFor(
        () => {
          this.#temp.remove();
          return true;
        },
        { timeoutMs: outputWaitMs(), intervalMs: 500, what: 'the temp folder to be removable' },
      );
    }
  }
}

class OpenSession implements RealSession {
  readonly name: string;
  readonly folder: string;
  readonly info: SessionInfo;
  readonly pid: number;
  readonly session: TerminalSession;
  readonly output = new TerminalOutput();
  #fakePid = 0;
  #end: { end: ViewerEnd; bytes: number } | null = null;
  readonly #harness: Harness;
  readonly #viewer: Viewer = {
    send: (chunk) => {
      this.output.push(chunk);
    },
    end: (end) => {
      this.#end = { end, bytes: this.output.raw().length };
    },
  };

  constructor(harness: Harness, info: SessionInfo, folder: string, session: TerminalSession) {
    this.#harness = harness;
    this.name = info.name;
    this.folder = folder;
    this.info = info;
    this.pid = info.pid;
    this.session = session;
  }

  get fakePid(): number {
    return this.#fakePid;
  }

  /** Attaches the first viewer (with the replay of what was printed before) and waits for the READY line. */
  async start(): Promise<void> {
    this.session.attach(this.#viewer);
    const ready = await this.waitMatch(/READY pid=(\d+)/, 'the READY line of the fake claude');
    this.#fakePid = Number(ready[1]);
    this.#harness.track(this.#fakePid);
  }

  detach(): void {
    this.session.detach(this.#viewer);
  }

  line(text: string): void {
    this.session.write(`${text}\r`);
  }

  async ask(command: string, tag: string): Promise<string> {
    const before = countOf(this.output.text(), tag);
    this.line(command);
    const answer = await waitFor(() => tagLine(this.output.text(), tag, before), {
      timeoutMs: outputWaitMs(),
      intervalMs: POLL_MS,
      what: `the answer ${tag} to ${command.split(' ')[0] ?? command}`,
    });
    const pid = /^(\d+)/.exec(answer)?.[1];
    if ((tag === 'CHILD:' || tag === 'PID:') && pid !== undefined) {
      this.#harness.track(Number(pid), tag === 'CHILD:' ? GRANDCHILD_COMMAND_LINE_PART : this.#harness.marker);
    }
    return answer;
  }

  async waitText(text: string, what: string = JSON.stringify(text)): Promise<void> {
    await waitFor(() => this.output.text().includes(text), {
      timeoutMs: outputWaitMs(),
      intervalMs: POLL_MS,
      what,
    });
  }

  waitMatch(pattern: RegExp, what = String(pattern)): Promise<RegExpExecArray> {
    const flags = pattern.flags.replace(/[gy]/g, '');
    return waitFor(() => new RegExp(pattern.source, flags).exec(this.output.text()), {
      timeoutMs: outputWaitMs(),
      intervalMs: POLL_MS,
      what,
    });
  }

  async waitEnd(): Promise<SessionExit> {
    return waitFor(() => this.#harness.sessionEnd(this.name), {
      timeoutMs: exitWaitMs(),
      intervalMs: POLL_MS,
      what: 'the end of the session',
    });
  }

  endedView(): { end: ViewerEnd; text: string } | null {
    if (this.#end === null) return null;
    return { end: this.#end.end, text: stripAnsi(this.output.raw().subarray(0, this.#end.bytes)) };
  }

  attachViewer(opts: { replay?: boolean } = {}): ViewerRecorder {
    const output = new TerminalOutput();
    const state: { ended: ViewerEnd | null } = { ended: null };
    const viewer: Viewer = {
      send: (chunk) => {
        output.push(chunk);
      },
      end: (end) => {
        state.ended = end;
      },
    };
    const { replayedBytes } = this.session.attach(viewer, opts.replay === undefined ? {} : { replay: opts.replay });
    return {
      viewer,
      output,
      replayedBytes,
      ended: () => state.ended,
      detach: () => {
        this.session.detach(viewer);
      },
    };
  }
}

/**
 * The factory a pty suite uses inside its `describePtyTests` body: `const start = useRealHarnesses();` and then
 * `const h = start({ route: 'direct' })` in a test. It registers an `afterEach` that closes every harness the test left open (a test
 * normally ends with `await h.close()` itself, so the failure belongs to the test) and an `afterAll` that ends every recorded
 * process that still runs, so a failed test cannot leak a stand-in for `claude`.
 */
export function useRealHarnesses(): (opts?: RealHarnessOptions) => RealHarness {
  const open: Harness[] = [];
  afterEach(async () => {
    const leftOpen = open.splice(0);
    const failures: string[] = [];
    for (const harness of leftOpen) {
      if (harness.isClosing) continue;
      try {
        await harness.close();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
  }, CLOSE_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await killRecordedProcesses();
  });
  return (opts = {}) => {
    const harness = new Harness(opts);
    open.push(harness);
    return harness;
  };
}
