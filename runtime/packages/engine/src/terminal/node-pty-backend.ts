// The node-pty adapter (design 01 section 3.11): `IPty` of the addon becomes the platform-neutral `Pty` of the terminal service,
// and `createNodePtyBackend` decides whether this host gets the real backend or an UnsupportedBackend with a reason.
//
// What the adapter settles, measured on Windows 11 with @lydell/node-pty 1.2.0-beta.18 (design 01 section 1.2):
// - `spawn()` returns with pid 0; the pid is valid by the first data event, so `started` resolves there. A bad working folder
//   does not throw: an exit event (code 267) arrives with no data, which rejects `started`.
// - Data arrives as UTF-8 strings (multi-byte characters whole). `encoding` must stay unset on Windows (node-pty prints a
//   warning), and is `null` on a POSIX host so that data is bytes there too.
// - `resize` and `kill` throw for a pty that has gone; both are swallowed. A listener that throws would break the emitter of
//   node-pty (it runs inside a socket handler), so every listener is isolated.
// - No message of node-pty is ever kept: they hold file paths. Errors carry a fixed sentence and, as cause, only a code.
import type { Logger } from '../log/logger.ts';
import type { HostPlatform } from '../platform/host.ts';
import { TerminalError } from './errors.ts';
import { targetOf, windowsBuildOk } from './native-targets.ts';
import {
  errorCodeOf,
  loadNodePty,
  realLoaderDeps,
  safeCause,
  type LoadedNodePty,
  type NodePtyModule,
  type NodePtySpawnOptions,
  type NodePtyTerm,
} from './node-pty-loader.ts';
import type { Pty, PtyBackend, PtyExit, TerminalSupport, Unsubscribe } from './types.ts';
import { UnsupportedBackend, unsupportedReasonOf } from './unsupported-backend.ts';

/** The terminal type the child sees (`TERM`). */
export const PTY_TERM_NAME = 'xterm-256color';
/** How long `started` waits for the first output; the default of `terminal.startTimeoutMs`. */
export const DEFAULT_START_TIMEOUT_MS = 10_000;
/** Output that arrives before the first listener is held up to this many bytes (the first banner of a session is small). */
export const HELD_OUTPUT_MAX_BYTES = 1024 * 1024;

type Disposable = ReturnType<NodePtyTerm['onData']>;

function isolated<T>(listener: (value: T) => void, value: T): void {
  try {
    listener(value);
  } catch {
    // A listener that throws must not break node-pty's emitter or the other listeners.
  }
}

/** Output as bytes. node-pty gives a string on Windows and a Buffer where `encoding` is null; anything else is dropped. */
function toBuffer(data: unknown): Buffer | null {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) return Buffer.from(data);
  return null;
}

/** One started node-pty terminal as a `Pty`. */
class NodePtyProcess implements Pty {
  readonly started: Promise<{ readonly pid: number }>;
  readonly #term: NodePtyTerm;
  readonly #dataListeners = new Set<(chunk: Buffer) => void>();
  readonly #exitListeners = new Set<(exit: PtyExit) => void>();
  readonly #subscriptions: Disposable[] = [];
  #held: Buffer[] = [];
  #heldBytes = 0;
  #state: 'pending' | 'started' | 'failed' = 'pending';
  #pid = 0;
  #exit: PtyExit | null = null;
  #timer: NodeJS.Timeout | null = null;
  #resolveStarted: (value: { readonly pid: number }) => void = () => undefined;
  #rejectStarted: (error: unknown) => void = () => undefined;

  constructor(term: NodePtyTerm, startTimeoutMs: number) {
    this.#term = term;
    this.started = new Promise((resolve, reject) => {
      this.#resolveStarted = resolve;
      this.#rejectStarted = reject;
    });
    // A start that fails while nobody awaits it must not be reported as an unhandled rejection.
    this.started.catch(() => undefined);
    // Subscribed at once and before any event can arrive: the first chunk is what makes the pid valid.
    this.#subscriptions.push(
      term.onData((data) => {
        this.#onNativeData(data);
      }),
    );
    this.#subscriptions.push(
      term.onExit((event) => {
        this.#onNativeExit(event.exitCode);
      }),
    );
    this.#timer = setTimeout(() => {
      this.#onStartTimeout();
    }, startTimeoutMs);
    this.#timer.unref();
  }

  /** 0 until `started` resolved. */
  get pid(): number {
    return this.#pid;
  }

  onData(listener: (chunk: Buffer) => void): Unsubscribe {
    this.#dataListeners.add(listener);
    if (this.#held.length > 0) {
      const held = this.#held;
      this.#held = [];
      this.#heldBytes = 0;
      for (const chunk of held) isolated(listener, chunk);
    }
    return () => {
      this.#dataListeners.delete(listener);
    };
  }

  onExit(listener: (exit: PtyExit) => void): Unsubscribe {
    const exit = this.#exit;
    if (exit !== null) {
      // The exit was reported before this listener came: it still hears it, once, after the caller has finished its setup.
      let active = true;
      queueMicrotask(() => {
        if (active) isolated(listener, exit);
      });
      return () => {
        active = false;
      };
    }
    this.#exitListeners.add(listener);
    return () => {
      this.#exitListeners.delete(listener);
    };
  }

  write(data: string | Uint8Array): void {
    if (this.#exit !== null) return;
    try {
      this.#term.write(typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    } catch {
      // A write to a terminal that is going away is not actionable: the exit event follows.
    }
  }

  resize(cols: number, rows: number): void {
    if (this.#exit !== null) return;
    try {
      this.#term.resize(cols, rows);
    } catch {
      // node-pty throws "Cannot resize a pty that has already exited"; the exit event is on its way.
    }
  }

  kill(): void {
    if (this.#exit !== null) return;
    try {
      // No signal: Windows has none, and a POSIX host picks its own default. A kill before the first data is deferred by node-pty.
      this.#term.kill();
    } catch {
      // node-pty throws for a kill of a pty that is already killed.
    }
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #onNativeData(data: unknown): void {
    if (this.#exit !== null || this.#state === 'failed') return;
    const chunk = toBuffer(data);
    if (chunk === null || chunk.length === 0) return;
    if (this.#state === 'pending') {
      this.#state = 'started';
      this.#pid = this.#term.pid;
      this.#clearTimer();
      this.#resolveStarted({ pid: this.#pid });
    }
    if (this.#dataListeners.size === 0) {
      // Nobody listens yet (the service subscribes after `started`): keep the output for the first listener.
      if (this.#heldBytes + chunk.length <= HELD_OUTPUT_MAX_BYTES) {
        this.#held.push(chunk);
        this.#heldBytes += chunk.length;
      }
      return;
    }
    for (const listener of [...this.#dataListeners]) isolated(listener, chunk);
  }

  #onNativeExit(exitCode: number): void {
    if (this.#exit !== null) return;
    const exit: PtyExit = { code: Number.isInteger(exitCode) ? exitCode : null };
    this.#exit = exit;
    this.#clearTimer();
    for (const subscription of this.#subscriptions) {
      try {
        subscription.dispose();
      } catch {
        // Nothing left to release.
      }
    }
    if (this.#state === 'pending') {
      // The child ended before it printed anything (a folder that cannot be entered gives exit 267): it never started.
      this.#state = 'failed';
      this.#rejectStarted(new TerminalError('SPAWN_FAILED', { cause: { exitCode: exit.code } }));
    }
    for (const listener of [...this.#exitListeners]) isolated(listener, exit);
  }

  #onStartTimeout(): void {
    this.#timer = null;
    if (this.#state !== 'pending') return;
    this.#state = 'failed';
    // Kill first: the caller releases the name and the slot on the rejection and must not be left with a running child.
    this.kill();
    this.#rejectStarted(new TerminalError('START_TIMEOUT'));
  }
}

export interface NodePtyBackendOptions {
  /** Decides the spawn options: Windows gets `useConptyDll` and no `encoding`, a POSIX host gets `encoding: null`. */
  readonly platform: HostPlatform;
  /** `terminal.conptyDll`: use the shipped conpty.dll and OpenConsole.exe instead of the Windows console host. Default false. */
  readonly useConptyDll?: boolean;
  /** `terminal.startTimeoutMs`. Default {@link DEFAULT_START_TIMEOUT_MS}. */
  readonly startTimeoutMs?: number;
}

export class NodePtyBackend implements PtyBackend {
  readonly name = 'node-pty';
  readonly support: TerminalSupport = { supported: true };
  /** Where the addon came from (`check` shows it). */
  readonly via: LoadedNodePty['via'];
  readonly dir: string | null;
  readonly #module: NodePtyModule;
  readonly #windows: boolean;
  readonly #useConptyDll: boolean;
  readonly #startTimeoutMs: number;

  constructor(loaded: LoadedNodePty, options: NodePtyBackendOptions) {
    this.#module = loaded.module;
    this.via = loaded.via;
    this.dir = loaded.dir;
    this.#windows = options.platform === 'win32';
    this.#useConptyDll = options.useConptyDll ?? false;
    const wait = options.startTimeoutMs;
    this.#startTimeoutMs = wait !== undefined && Number.isFinite(wait) && wait > 0 ? wait : DEFAULT_START_TIMEOUT_MS;
  }

  spawn(
    cmd: string,
    args: readonly string[] | string,
    cwd: string,
    cols: number,
    rows: number,
    env: Readonly<Record<string, string>>,
  ): Pty {
    const base = { name: PTY_TERM_NAME, cols, rows, cwd, env: { ...env } };
    const options: NodePtySpawnOptions = this.#windows
      ? { ...base, useConptyDll: this.#useConptyDll }
      : { ...base, encoding: null };
    let term: NodePtyTerm;
    try {
      term = this.#module.spawn(cmd, typeof args === 'string' ? args : [...args], options);
    } catch (error) {
      throw new TerminalError('SPAWN_FAILED', { cause: safeCause(error) });
    }
    try {
      return new NodePtyProcess(term, this.#startTimeoutMs);
    } catch (error) {
      try {
        term.kill();
      } catch {
        // Already gone.
      }
      throw new TerminalError('SPAWN_FAILED', { cause: safeCause(error) });
    }
  }
}

export interface CreateNodePtyBackendOptions {
  readonly platform: HostPlatform;
  readonly arch: string;
  /** `os.release()`: on Windows `10.0.<build>`. */
  readonly release: string;
  /** `terminal.conptyDll`. */
  readonly useConptyDll?: boolean;
  /** `terminal.startTimeoutMs`. */
  readonly startTimeoutMs?: number;
  /** Receives `terminal.native` (phase `loaded`, `missing` or `failed`, and the error code of a failure); nothing else. */
  readonly logger?: Pick<Logger, 'info' | 'warn'>;
  /** Loads the addon. Default: `loadNodePty` over the real file system, with `platform` and `arch` above. Tests pass a script. */
  readonly load?: () => LoadedNodePty;
}

function logNative(
  logger: CreateNodePtyBackendOptions['logger'],
  level: 'info' | 'warn',
  fields: { phase: 'loaded' | 'missing' | 'failed'; code?: string },
): void {
  if (logger === undefined) return;
  try {
    logger[level]('terminal.native', fields);
  } catch {
    // The log is not worth a terminal.
  }
}

/**
 * The backend of this host. In order: no shipped target (`unsupported-os`), a Windows build below 17763 (`os-too-old`), then the
 * addon is loaded: `native-missing` or `native-load-failed` when it cannot be, else the real backend. It never throws.
 */
export function createNodePtyBackend(options: CreateNodePtyBackendOptions): NodePtyBackend | UnsupportedBackend {
  if (targetOf(options.platform, options.arch) === null) return new UnsupportedBackend('unsupported-os');
  if (options.platform === 'win32' && !windowsBuildOk(options.release)) return new UnsupportedBackend('os-too-old');
  const load =
    options.load ??
    ((): LoadedNodePty => loadNodePty({ ...realLoaderDeps(), platform: options.platform, arch: options.arch }));
  let loaded: LoadedNodePty;
  try {
    loaded = load();
  } catch (error) {
    const reason = (error instanceof TerminalError ? unsupportedReasonOf(error.code) : null) ?? 'native-load-failed';
    const code = errorCodeOf(error instanceof TerminalError ? error.cause : error);
    logNative(options.logger, 'warn', {
      phase: reason === 'native-missing' ? 'missing' : 'failed',
      ...(code === null ? {} : { code }),
    });
    return new UnsupportedBackend(reason);
  }
  logNative(options.logger, 'info', { phase: 'loaded' });
  return new NodePtyBackend(loaded, {
    platform: options.platform,
    ...(options.useConptyDll === undefined ? {} : { useConptyDll: options.useConptyDll }),
    ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
  });
}
