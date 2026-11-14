// A pseudo terminal that is only a script (design 01 sections 3.11 and 8): tests drive `Session`, the terminal service and the
// WebSocket layer through it, so every unit test runs on every host without ConPTY. Nothing here starts a process. It behaves
// like the node-pty adapter where that matters: the pid is known when `started` resolves, output that arrives before the first
// listener is held for it, a listener that throws is isolated, and input and resizes after the exit are ignored.
import { TerminalError, type TerminalErrorCode } from './errors.ts';
import type { Pty, PtyBackend, PtyExit, TerminalSupport, Unsubscribe, UnsupportedReason } from './types.ts';

/** What ConPTY reports for a process that was ended by `ClosePseudoConsole` (0xC000013A as a signed 32 bit value). */
export const FAKE_KILLED_EXIT_CODE = -1_073_741_510;
/** Output that arrives before the first listener is held up to this many bytes (the first banner of a real session is small). */
const HELD_BYTES_MAX = 1024 * 1024;

export interface FakePtyOptions {
  /** The pid `started` resolves with (default 4242). */
  readonly pid?: number;
  /** True (default): `started` resolves at once. False: it resolves with the first `emitData` or `start()`, like node-pty. */
  readonly autoStart?: boolean;
  /** True (default): `kill()` ends the process at once, inside the call. False: the test calls `emitExit` itself. */
  readonly autoExitOnKill?: boolean;
  /** The exit code of an automatic exit on `kill()` (default {@link FAKE_KILLED_EXIT_CODE}). */
  readonly killExitCode?: number | null;
}

type StartState = 'pending' | 'started' | 'failed';

export class FakePty implements Pty {
  /** Everything written, as Buffers, in order. Input after the exit is not recorded. */
  readonly written: Buffer[] = [];
  /** Every `resize(cols, rows)` that reached the process. */
  readonly sizes: { cols: number; rows: number }[] = [];
  /** How many times `kill()` was called, including calls after the exit. */
  killCalls = 0;
  /** The switch of {@link FakePtyOptions.autoExitOnKill}; a test may flip it. */
  autoExitOnKill: boolean;
  readonly started: Promise<{ readonly pid: number }>;

  readonly #pidToHandOut: number;
  readonly #killExitCode: number | null;
  readonly #dataListeners = new Set<(chunk: Buffer) => void>();
  readonly #exitListeners = new Set<(exit: PtyExit) => void>();
  #held: Buffer[] = [];
  #heldBytes = 0;
  #state: StartState = 'pending';
  #pid = 0;
  #exit: PtyExit | null = null;
  #resolveStarted: (value: { readonly pid: number }) => void = () => undefined;
  #rejectStarted: (error: unknown) => void = () => undefined;

  constructor(options: FakePtyOptions = {}) {
    this.#pidToHandOut = options.pid ?? 4242;
    this.autoExitOnKill = options.autoExitOnKill ?? true;
    this.#killExitCode = options.killExitCode === undefined ? FAKE_KILLED_EXIT_CODE : options.killExitCode;
    this.started = new Promise((resolve, reject) => {
      this.#resolveStarted = resolve;
      this.#rejectStarted = reject;
    });
    // A start that nobody awaits and that fails must not be reported as an unhandled rejection.
    this.started.catch(() => undefined);
    if (options.autoStart ?? true) this.start();
  }

  /** 0 until `started` resolved. */
  get pid(): number {
    return this.#pid;
  }

  /** True once the process has exited. */
  get exited(): boolean {
    return this.#exit !== null;
  }

  /** The exit code; null while the process runs and also for an exit without a code (see `exited`). */
  get exitCode(): number | null {
    return this.#exit?.code ?? null;
  }

  /** What was written, as one UTF-8 text. */
  get writtenText(): string {
    return Buffer.concat(this.written).toString('utf8');
  }

  /** How many data listeners are subscribed (a leak check). */
  get dataListeners(): number {
    return this.#dataListeners.size;
  }

  /** The child exists: `started` resolves with the pid. Harmless when it already did or the start failed. */
  start(): void {
    if (this.#state !== 'pending') return;
    this.#state = 'started';
    this.#pid = this.#pidToHandOut;
    this.#resolveStarted({ pid: this.#pid });
  }

  /** The child could not start: `started` rejects (SPAWN_FAILED by default) and the pid stays 0. */
  failStart(error?: unknown): void {
    if (this.#state !== 'pending') return;
    this.#state = 'failed';
    this.#rejectStarted(error ?? new TerminalError('SPAWN_FAILED'));
  }

  /** Output of the process. The first chunk starts a pty that was not started, as node-pty does. Ignored after the exit. */
  emitData(chunk: string | Uint8Array): void {
    if (this.#exit !== null || this.#state === 'failed') return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    if (bytes.length === 0) return;
    this.start();
    if (this.#dataListeners.size === 0) {
      if (this.#heldBytes + bytes.length <= HELD_BYTES_MAX) {
        this.#held.push(bytes);
        this.#heldBytes += bytes.length;
      }
      return;
    }
    for (const listener of [...this.#dataListeners]) {
      try {
        listener(bytes);
      } catch {
        // A listener that throws must not break the emitter (the node-pty adapter isolates them the same way).
      }
    }
  }

  /** The process ended. Reported once; later calls are ignored. */
  emitExit(code: number | null): void {
    if (this.#exit !== null) return;
    this.#exit = { code };
    for (const listener of [...this.#exitListeners]) {
      try {
        listener(this.#exit);
      } catch {
        // Isolated, as for data.
      }
    }
  }

  onData(listener: (chunk: Buffer) => void): Unsubscribe {
    this.#dataListeners.add(listener);
    if (this.#held.length > 0) {
      const held = this.#held;
      this.#held = [];
      this.#heldBytes = 0;
      for (const chunk of held) {
        try {
          listener(chunk);
        } catch {
          // Isolated.
        }
      }
    }
    return () => {
      this.#dataListeners.delete(listener);
    };
  }

  onExit(listener: (exit: PtyExit) => void): Unsubscribe {
    // A process that already exited has reported it: a listener that comes later hears nothing, as with an EventEmitter.
    this.#exitListeners.add(listener);
    return () => {
      this.#exitListeners.delete(listener);
    };
  }

  write(data: string | Uint8Array): void {
    if (this.#exit !== null) return;
    this.written.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
  }

  resize(cols: number, rows: number): void {
    if (this.#exit !== null) return;
    this.sizes.push({ cols, rows });
  }

  kill(): void {
    this.killCalls += 1;
    if (this.#exit === null && this.autoExitOnKill) this.emitExit(this.#killExitCode);
  }
}

/** One call of `FakePtyBackend.spawn`, with copies of the arguments. */
export interface FakeSpawn {
  readonly cmd: string;
  readonly args: readonly string[] | string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string>>;
  readonly pty: FakePty;
}

export interface FakePtyBackendOptions {
  /** Default `{ supported: true }`. An unsupported backend throws the matching TerminalError from `spawn`. */
  readonly support?: TerminalSupport;
  /** The pid of the first pty (default 1000); each spawn adds one. */
  readonly firstPid?: number;
  /** Options of every pty it creates (the pid is the backend's). */
  readonly pty?: Omit<FakePtyOptions, 'pid'>;
}

const CODE_OF_REASON: Readonly<Record<UnsupportedReason, TerminalErrorCode>> = {
  'unsupported-os': 'UNSUPPORTED_OS',
  'os-too-old': 'UNSUPPORTED_OS',
  'native-missing': 'NATIVE_MISSING',
  'native-load-failed': 'NATIVE_LOAD_FAILED',
};

export class FakePtyBackend implements PtyBackend {
  readonly name = 'fake';
  readonly support: TerminalSupport;
  /** Every spawn, in order. */
  readonly spawns: FakeSpawn[] = [];
  /** Options for the ptys of the next spawns; a test may replace it between spawns. */
  ptyOptions: Omit<FakePtyOptions, 'pid'>;
  /** While it is not null, `spawn` throws it (a synchronous spawn failure) and records nothing. */
  spawnError: Error | null = null;
  #nextPid: number;

  constructor(options: FakePtyBackendOptions = {}) {
    this.support = options.support ?? { supported: true };
    this.#nextPid = options.firstPid ?? 1000;
    this.ptyOptions = options.pty ?? {};
  }

  /** The pty of the most recent spawn. */
  get last(): FakePty | undefined {
    return this.spawns[this.spawns.length - 1]?.pty;
  }

  spawn(
    cmd: string,
    args: readonly string[] | string,
    cwd: string,
    cols: number,
    rows: number,
    env: Readonly<Record<string, string>>,
  ): FakePty {
    if (!this.support.supported) throw new TerminalError(CODE_OF_REASON[this.support.reason]);
    if (this.spawnError !== null) throw this.spawnError;
    const pty = new FakePty({ ...this.ptyOptions, pid: this.#nextPid });
    this.#nextPid += 1;
    this.spawns.push({ cmd, args: typeof args === 'string' ? args : [...args], cwd, cols, rows, env: { ...env }, pty });
    return pty;
  }
}
