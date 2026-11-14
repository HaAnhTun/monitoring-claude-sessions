import { inspect } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hostPlatform, type HostPlatform } from '../platform/host.ts';
import { TerminalError, type TerminalErrorCode } from './errors.ts';
import { FakePtyBackend } from './fake-pty.ts';
import {
  DEFAULT_START_TIMEOUT_MS,
  HELD_OUTPUT_MAX_BYTES,
  NodePtyBackend,
  PTY_TERM_NAME,
  createNodePtyBackend,
  type CreateNodePtyBackendOptions,
} from './node-pty-backend.ts';
import type { LoadedNodePty, NodePtyModule, NodePtySpawnOptions, NodePtyTerm } from './node-pty-loader.ts';
import type { Pty, PtyExit, UnsupportedReason } from './types.ts';
import { UnsupportedBackend, unsupportedReasonOf } from './unsupported-backend.ts';

// FIXTURE: invented paths and values. The "native module" below is a script: no addon is loaded and no process starts.
const SECRET = 'C:\\caw\\secret-folder\\claude.exe';
const KIB = 1024;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- the scripted native module ----------------------------------------------------------------------------------

type DataListener = (data: string) => void;
type ExitListener = (event: { exitCode: number; signal?: number }) => void;

/** A node-pty `IPty` that only records. Its pid is 0 until a test sets it, as the real one is before the first data event. */
class ScriptedTerm implements NodePtyTerm {
  pid = 0;
  readonly cols = 120;
  readonly rows = 30;
  readonly process = 'scripted';
  handleFlowControl = false;
  readonly writes: (string | Buffer)[] = [];
  readonly resizes: unknown[][] = [];
  readonly kills: unknown[][] = [];
  writeError: Error | null = null;
  resizeError: Error | null = null;
  killError: Error | null = null;
  onKill: () => void = () => undefined;
  readonly #data = new Set<DataListener>();
  readonly #exit = new Set<ExitListener>();

  readonly onData: NodePtyTerm['onData'] = (listener) => {
    this.#data.add(listener);
    return {
      dispose: () => {
        this.#data.delete(listener);
      },
    };
  };

  readonly onExit: NodePtyTerm['onExit'] = (listener) => {
    this.#exit.add(listener);
    return {
      dispose: () => {
        this.#exit.delete(listener);
      },
    };
  };

  get dataListeners(): number {
    return this.#data.size;
  }

  get exitListeners(): number {
    return this.#exit.size;
  }

  /** Output as node-pty gives it: a string on Windows, bytes where `encoding` is null. */
  emitData(value: string | Buffer): void {
    for (const listener of [...this.#data]) listener(typeof value === 'string' ? value : (value as unknown as string));
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const listener of [...this.#exit]) listener(signal === undefined ? { exitCode } : { exitCode, signal });
  }

  write(data: string | Buffer): void {
    if (this.writeError !== null) throw this.writeError;
    this.writes.push(data);
  }

  resize(...args: unknown[]): void {
    this.resizes.push(args);
    if (this.resizeError !== null) throw this.resizeError;
  }

  kill(...args: unknown[]): void {
    this.kills.push(args);
    this.onKill();
    if (this.killError !== null) throw this.killError;
  }

  clear(): void {
    // not scripted: the adapter never calls it
  }

  pause(): void {
    // not scripted: the adapter never calls it
  }

  resume(): void {
    // not scripted: the adapter never calls it
  }
}

interface SpawnCall {
  readonly file: string;
  readonly args: string[] | string;
  readonly options: NodePtySpawnOptions;
}

class ScriptedNative {
  readonly calls: SpawnCall[] = [];
  readonly terms: ScriptedTerm[] = [];
  spawnError: Error | null = null;
  readonly module: NodePtyModule = {
    spawn: (file, args, options) => {
      this.calls.push({ file, args, options });
      if (this.spawnError !== null) throw this.spawnError;
      const term = new ScriptedTerm();
      this.terms.push(term);
      return term;
    },
  };

  get last(): ScriptedTerm {
    const term = this.terms[this.terms.length - 1];
    if (term === undefined) throw new Error('nothing was spawned');
    return term;
  }
}

/**
 * node-pty and the module loader can throw any value, and `only-throw-error` rightly asks for an Error. This is the one place
 * that scripts a throw of something else: the type is a lie on purpose, the runtime value is what the code under test must survive.
 */
function asThrowable(value: unknown): Error {
  return value as Error;
}

function codeError(code: string, message = 'boom'): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

interface Rig {
  readonly native: ScriptedNative;
  readonly backend: NodePtyBackend;
}

function rig(o: { platform?: HostPlatform; useConptyDll?: boolean; startTimeoutMs?: number } = {}): Rig {
  const native = new ScriptedNative();
  const loaded: LoadedNodePty = { module: native.module, via: 'node_modules', dir: null };
  const backend = new NodePtyBackend(loaded, {
    platform: o.platform ?? 'win32',
    ...(o.useConptyDll === undefined ? {} : { useConptyDll: o.useConptyDll }),
    ...(o.startTimeoutMs === undefined ? {} : { startTimeoutMs: o.startTimeoutMs }),
  });
  return { native, backend };
}

function start(r: Rig): { pty: Pty; term: ScriptedTerm } {
  const pty = r.backend.spawn('C:\\tools\\claude.exe', ['--flag'], 'D:\\work', 120, 30, { A: '1' });
  return { pty, term: r.native.last };
}

// ---- promise and listener helpers --------------------------------------------------------------------------------

interface Tracked<T> {
  state: 'pending' | 'resolved' | 'rejected';
  value?: T;
  error?: unknown;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { state: 'pending' };
  promise.then(
    (value) => {
      tracked.state = 'resolved';
      tracked.value = value;
    },
    (error: unknown) => {
      tracked.state = 'rejected';
      tracked.error = error;
    },
  );
  return tracked;
}

/** Lets the promise reactions run (fake timers do not fake microtasks, so this is enough). */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function collect(pty: Pty): { chunks: Buffer[]; text(): string; off: () => void } {
  const chunks: Buffer[] = [];
  const off = pty.onData((chunk) => chunks.push(chunk));
  return { chunks, text: () => Buffer.concat(chunks).toString('utf8'), off };
}

function expectTerminalError(error: unknown, code: TerminalErrorCode): TerminalError {
  expect(error).toBeInstanceOf(TerminalError);
  if (!(error instanceof TerminalError)) throw new Error('not a TerminalError');
  expect(error.code).toBe(code);
  return error;
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

// ---- spawn: the options node-pty gets ----------------------------------------------------------------------------

describe('NodePtyBackend: what is handed to node-pty', () => {
  it('maps the call to the node-pty options on Windows: no encoding, useConptyDll false, the xterm name', () => {
    const r = rig();
    const args = ['--resume', 'abc 123'];
    const env = { PATH: 'C:\\bin', COLORTERM: 'truecolor' };
    r.backend.spawn('C:\\tools\\claude.exe', args, 'D:\\my project', 100, 40, env);
    expect(r.native.calls).toHaveLength(1);
    const call = r.native.calls[0]!;
    expect(call.file).toBe('C:\\tools\\claude.exe');
    expect(call.args).toEqual(['--resume', 'abc 123']);
    expect(call.options).toEqual({
      name: 'xterm-256color',
      cols: 100,
      rows: 40,
      cwd: 'D:\\my project',
      env: { PATH: 'C:\\bin', COLORTERM: 'truecolor' },
      useConptyDll: false,
    });
    expect(Object.keys(call.options).sort()).toEqual(['cols', 'cwd', 'env', 'name', 'rows', 'useConptyDll']);
    expect(PTY_TERM_NAME).toBe('xterm-256color');
  });

  it('copies the argument list and the environment, so a later change by the caller does not reach node-pty', () => {
    const r = rig();
    const args = ['one'];
    const env: Record<string, string> = { A: '1' };
    r.backend.spawn('claude', args, 'D:\\w', 80, 24, env);
    args.push('two');
    env['B'] = '2';
    const call = r.native.calls[0]!;
    expect(call.args).toEqual(['one']);
    expect(call.args).not.toBe(args);
    expect(call.options.env).toEqual({ A: '1' });
  });

  it('passes a string command line (the cmd.exe route) unchanged', () => {
    const r = rig();
    const line = '/d /s /c ""C:\\Program Files\\claude.cmd" --resume abc"';
    r.backend.spawn('C:\\Windows\\System32\\cmd.exe', line, 'D:\\w', 80, 24, {});
    expect(r.native.calls[0]!.args).toBe(line);
  });

  it('passes useConptyDll true when the configuration asks for the shipped conpty.dll', () => {
    const r = rig({ useConptyDll: true });
    r.backend.spawn('claude', [], 'D:\\w', 80, 24, {});
    expect(r.native.calls[0]!.options).toMatchObject({ useConptyDll: true });
  });

  it.each(['linux', 'darwin'] as const)(
    'on %s data is bytes (encoding null) and there is no ConPTY option',
    (platform) => {
      const r = rig({ platform });
      r.backend.spawn('/usr/bin/claude', ['-x'], '/home/work', 80, 24, { A: '1' });
      const options = r.native.calls[0]!.options;
      expect(Object.keys(options).sort()).toEqual(['cols', 'cwd', 'encoding', 'env', 'name', 'rows']);
      expect(options).toMatchObject({ encoding: null, name: 'xterm-256color' });
    },
  );

  it('a synchronous throw of node-pty is SPAWN_FAILED without the message, only the code survives', () => {
    const r = rig();
    r.native.spawnError = codeError('ENOENT', `File not found: ${SECRET}`);
    const error = expectTerminalError(
      thrownBy(() => r.backend.spawn(SECRET, [], 'D:\\w', 80, 24, {})),
      'SPAWN_FAILED',
    );
    expect(error.message).toBe('The terminal process could not be started.');
    expect(error.cause).toEqual({ code: 'ENOENT' });
    expect(inspect(error, { depth: 6 })).not.toContain('secret-folder');
  });

  it('keeps no text of a thrown value that is not an Error either', () => {
    const r = rig();
    r.native.spawnError = asThrowable(SECRET);
    const error = expectTerminalError(
      thrownBy(() => r.backend.spawn('claude', [], 'D:\\w', 80, 24, {})),
      'SPAWN_FAILED',
    );
    expect(error.cause).toEqual({ code: null });
    expect(inspect(error, { depth: 6 })).not.toContain('secret-folder');
  });

  it('describes itself: the node-pty backend, supported, with the branch the module came from', () => {
    const native = new ScriptedNative();
    const backend = new NodePtyBackend(
      { module: native.module, via: 'bundle', dir: 'C:\\caw\\bundle\\native\\win32-x64' },
      { platform: 'win32' },
    );
    expect(backend.name).toBe('node-pty');
    expect(backend.support).toEqual({ supported: true });
    expect(backend.via).toBe('bundle');
    expect(backend.dir).toBe('C:\\caw\\bundle\\native\\win32-x64');
  });
});

// ---- started, pid ------------------------------------------------------------------------------------------------

describe('Pty.started and pid', () => {
  it('has pid 0 and a pending start until the first data event, then resolves with the pid node-pty has by then', async () => {
    const r = rig();
    const { pty, term } = start(r);
    const started = track(pty.started);
    await flush();
    expect(started.state).toBe('pending');
    expect(pty.pid).toBe(0);
    term.pid = 5150;
    term.emitData('banner');
    await flush();
    expect(started.state).toBe('resolved');
    expect(started.value).toEqual({ pid: 5150 });
    expect(pty.pid).toBe(5150);
  });

  it('does not count an empty data event as the start', async () => {
    const r = rig();
    const { pty, term } = start(r);
    const started = track(pty.started);
    const out = collect(pty);
    term.pid = 7;
    term.emitData('');
    term.emitData(Buffer.alloc(0));
    await flush();
    expect(started.state).toBe('pending');
    expect(out.chunks).toEqual([]);
    term.emitData('x');
    await flush();
    expect(started.state).toBe('resolved');
  });

  it('rejects with SPAWN_FAILED when the child exits before any data (a bad folder gives exit 267), pid stays 0', async () => {
    const r = rig();
    const { pty, term } = start(r);
    const started = track(pty.started);
    term.emitExit(267);
    await flush();
    expect(started.state).toBe('rejected');
    const error = expectTerminalError(started.error, 'SPAWN_FAILED');
    expect(error.cause).toEqual({ exitCode: 267 });
    expect(pty.pid).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a start that fails and that nobody awaits is not an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const r = rig();
      const { term } = start(r);
      term.emitExit(1);
      await flush();
      await flush();
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('Pty.started: the start timeout', () => {
  it('rejects with START_TIMEOUT after the default wait, and the child is already killed when the rejection is seen', async () => {
    const r = rig();
    const { pty, term } = start(r);
    const order: string[] = [];
    term.onKill = () => order.push('kill');
    pty.started.catch(() => order.push('rejected'));
    const started = track(pty.started);
    await vi.advanceTimersByTimeAsync(DEFAULT_START_TIMEOUT_MS - 1);
    expect(started.state).toBe('pending');
    expect(term.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started.state).toBe('rejected');
    expectTerminalError(started.error, 'START_TIMEOUT');
    expect(order).toEqual(['kill', 'rejected']);
    expect(term.kills).toEqual([[]]);
    expect(pty.pid).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the default wait is the default of terminal.startTimeoutMs, 10 seconds', () => {
    expect(DEFAULT_START_TIMEOUT_MS).toBe(10_000);
  });

  it('honours the configured wait', async () => {
    const r = rig({ startTimeoutMs: 2500 });
    const { pty } = start(r);
    const started = track(pty.started);
    await vi.advanceTimersByTimeAsync(2499);
    expect(started.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(started.state).toBe('rejected');
  });

  it('still rejects with START_TIMEOUT when the kill throws', async () => {
    const r = rig();
    const { pty, term } = start(r);
    term.killError = new Error(SECRET);
    const started = track(pty.started);
    await vi.advanceTimersByTimeAsync(DEFAULT_START_TIMEOUT_MS);
    expect(started.state).toBe('rejected');
    const error = expectTerminalError(started.error, 'START_TIMEOUT');
    expect(inspect(error, { depth: 6 })).not.toContain('secret-folder');
  });

  it('the first data cancels the timer, so a late clock does not kill a running child', async () => {
    const r = rig();
    const { pty, term } = start(r);
    const started = track(pty.started);
    term.pid = 9;
    term.emitData('hello');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_START_TIMEOUT_MS * 3);
    expect(started.state).toBe('resolved');
    expect(term.kills).toEqual([]);
  });

  it('does not keep the process alive while it waits', () => {
    const r = rig();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    start(r);
    expect(spy).toHaveBeenCalledTimes(1);
    const timer: unknown = spy.mock.results[0]?.value;
    if (typeof timer !== 'object' || timer === null || !('hasRef' in timer) || typeof timer.hasRef !== 'function') {
      throw new Error('the timer has no hasRef');
    }
    const referenced: unknown = Reflect.apply(timer.hasRef, timer, []);
    expect(referenced).toBe(false);
  });

  it('output that arrives after a failed start is not forwarded', async () => {
    const r = rig();
    const { pty, term } = start(r);
    const out = collect(pty);
    await vi.advanceTimersByTimeAsync(DEFAULT_START_TIMEOUT_MS);
    term.emitData('too late');
    expect(out.chunks).toEqual([]);
  });
});

// ---- data --------------------------------------------------------------------------------------------------------

describe('Pty.onData', () => {
  it('turns a string into a UTF-8 Buffer and keeps multi-byte characters whole', async () => {
    const r = rig();
    const { pty, term } = start(r);
    const out = collect(pty);
    term.emitData('xin chào 👋\r\n');
    await flush();
    expect(out.chunks).toHaveLength(1);
    expect(Buffer.isBuffer(out.chunks[0])).toBe(true);
    expect(out.text()).toBe('xin chào 👋\r\n');
    expect(out.chunks[0]).toEqual(Buffer.from('xin chào 👋\r\n', 'utf8'));
  });

  it('copies bytes that arrive as a Buffer (a POSIX host with encoding null)', () => {
    const r = rig({ platform: 'linux' });
    const { pty, term } = start(r);
    const out = collect(pty);
    const bytes = Buffer.from([0x1b, 0x5b, 0x32, 0x4a, 0xff]);
    term.emitData(bytes);
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]).toEqual(bytes);
    expect(out.chunks[0]).not.toBe(bytes);
  });

  it('gives every listener the same bytes, and stops after the unsubscribe', () => {
    const r = rig();
    const { pty, term } = start(r);
    const a = collect(pty);
    const b = collect(pty);
    term.emitData('one');
    a.off();
    term.emitData('two');
    expect(a.text()).toBe('one');
    expect(b.text()).toBe('onetwo');
  });

  it('holds what arrives before the first listener and hands it over in order, then goes live', () => {
    const r = rig();
    const { pty, term } = start(r);
    term.pid = 11;
    term.emitData('first ');
    term.emitData('second ');
    const late = collect(pty);
    expect(late.text()).toBe('first second ');
    term.emitData('third');
    expect(late.text()).toBe('first second third');
    const later = collect(pty);
    expect(later.text()).toBe('');
    term.emitData('!');
    expect(later.text()).toBe('!');
  });

  it('holds at most one MiB before the first listener, oldest first, whole chunks only', () => {
    const r = rig();
    const { pty, term } = start(r);
    const half = 'a'.repeat(HELD_OUTPUT_MAX_BYTES / 2);
    term.emitData(half);
    term.emitData(half);
    term.emitData('dropped');
    const out = collect(pty);
    expect(out.chunks.map((chunk) => chunk.length)).toEqual([HELD_OUTPUT_MAX_BYTES / 2, HELD_OUTPUT_MAX_BYTES / 2]);
    expect(HELD_OUTPUT_MAX_BYTES).toBe(1024 * KIB);
  });

  it('isolates a listener that throws: the others still hear, node-pty never sees the throw', () => {
    const r = rig();
    const { pty, term } = start(r);
    pty.onData(() => {
      throw new Error(SECRET);
    });
    const ok = collect(pty);
    expect(() => {
      term.emitData('data');
    }).not.toThrow();
    expect(ok.text()).toBe('data');
  });

  it('isolates a listener that throws while it receives the held output', () => {
    const r = rig();
    const { pty, term } = start(r);
    term.emitData('held');
    expect(() =>
      pty.onData(() => {
        throw new Error('x');
      }),
    ).not.toThrow();
    const ok = collect(pty);
    term.emitData('live');
    expect(ok.text()).toBe('live');
  });

  it('forwards nothing after the exit', () => {
    const r = rig();
    const { pty, term } = start(r);
    const out = collect(pty);
    term.emitData('before');
    term.emitExit(0);
    term.emitData('after');
    expect(out.text()).toBe('before');
  });
});

// ---- exit --------------------------------------------------------------------------------------------------------

describe('Pty.onExit', () => {
  function exits(pty: Pty): PtyExit[] {
    const seen: PtyExit[] = [];
    pty.onExit((exit) => seen.push(exit));
    return seen;
  }

  it('reports the exit code as the OS gave it, signed and unchanged', () => {
    const r = rig();
    const { pty, term } = start(r);
    const seen = exits(pty);
    term.pid = 3;
    term.emitData('x');
    term.emitExit(-1_073_741_510);
    expect(seen).toEqual([{ code: -1_073_741_510 }]);
  });

  it('reports a code of null when the exit has no integer code', () => {
    for (const odd of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      const r = rig();
      const { pty, term } = start(r);
      const seen = exits(pty);
      term.emitExit(odd);
      expect(seen).toEqual([{ code: null }]);
    }
  });

  it('reports the exit once, even when node-pty repeats it', () => {
    const r = rig();
    const { pty, term } = start(r);
    const seen = exits(pty);
    term.emitExit(0);
    term.emitExit(0);
    expect(seen).toEqual([{ code: 0 }]);
  });

  it('isolates an exit listener that throws', () => {
    const r = rig();
    const { pty, term } = start(r);
    pty.onExit(() => {
      throw new Error('x');
    });
    const seen = exits(pty);
    expect(() => {
      term.emitExit(3);
    }).not.toThrow();
    expect(seen).toEqual([{ code: 3 }]);
  });

  it('delivers the exit to a listener that comes after it, once and asynchronously', async () => {
    const r = rig();
    const { pty, term } = start(r);
    term.emitExit(3);
    const seen: PtyExit[] = [];
    pty.onExit((exit) => seen.push(exit));
    expect(seen).toEqual([]);
    await flush();
    expect(seen).toEqual([{ code: 3 }]);
    await flush();
    expect(seen).toEqual([{ code: 3 }]);
  });

  it('a late listener that unsubscribes at once hears nothing', async () => {
    const r = rig();
    const { pty, term } = start(r);
    term.emitExit(3);
    const seen: PtyExit[] = [];
    const off = pty.onExit((exit) => seen.push(exit));
    off();
    await flush();
    expect(seen).toEqual([]);
  });

  it('stops listening to node-pty after the exit', () => {
    const r = rig();
    const { term } = start(r);
    expect(term.dataListeners).toBe(1);
    expect(term.exitListeners).toBe(1);
    term.emitExit(0);
    expect(term.dataListeners).toBe(0);
    expect(term.exitListeners).toBe(0);
  });

  it('an exit after the timeout reaches the listeners too', async () => {
    const r = rig();
    const { pty, term } = start(r);
    const seen = exits(pty);
    await vi.advanceTimersByTimeAsync(DEFAULT_START_TIMEOUT_MS);
    term.emitExit(-1);
    expect(seen).toEqual([{ code: -1 }]);
  });
});

// ---- write, resize, kill -----------------------------------------------------------------------------------------

describe('Pty.write', () => {
  it('passes a string on as it is', () => {
    const r = rig();
    const { pty, term } = start(r);
    pty.write('hello\r');
    expect(term.writes).toEqual(['hello\r']);
  });

  it('passes bytes on as a Buffer over the same bytes, also for a view into a larger buffer', () => {
    const r = rig();
    const { pty, term } = start(r);
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]);
    pty.write(backing.subarray(2, 5));
    pty.write(new Uint8Array([0xe2, 0x82, 0xac]));
    const [first, second] = term.writes;
    expect(Buffer.isBuffer(first)).toBe(true);
    expect([...(first as Buffer)]).toEqual([2, 3, 4]);
    expect((second as Buffer).toString('utf8')).toBe('€');
  });

  it('does not throw when node-pty does', () => {
    const r = rig();
    const { pty, term } = start(r);
    term.writeError = new Error(SECRET);
    expect(() => {
      pty.write('x');
    }).not.toThrow();
  });

  it('is ignored after the exit', () => {
    const r = rig();
    const { pty, term } = start(r);
    term.emitExit(0);
    pty.write('x');
    expect(term.writes).toEqual([]);
  });
});

describe('Pty.resize', () => {
  it('passes the size on, columns first, with nothing else', () => {
    const r = rig();
    const { pty, term } = start(r);
    pty.resize(132, 43);
    expect(term.resizes).toEqual([[132, 43]]);
  });

  it('swallows the error of a pty that has already exited', () => {
    const r = rig();
    const { pty, term } = start(r);
    term.resizeError = new Error('Cannot resize a pty that has already exited');
    expect(() => {
      pty.resize(100, 30);
    }).not.toThrow();
    term.resizeError = asThrowable('not even an Error');
    expect(() => {
      pty.resize(100, 30);
    }).not.toThrow();
    expect(term.resizes).toHaveLength(2);
  });

  it('is ignored after the exit', () => {
    const r = rig();
    const { pty, term } = start(r);
    term.emitExit(0);
    pty.resize(100, 30);
    expect(term.resizes).toEqual([]);
  });
});

describe('Pty.kill', () => {
  it('asks node-pty to kill the tree, with no signal (Windows has none)', () => {
    const r = rig();
    const { pty, term } = start(r);
    pty.kill();
    expect(term.kills).toEqual([[]]);
  });

  it('may be called again: it never throws, whatever node-pty says about a second kill', () => {
    const r = rig();
    const { pty, term } = start(r);
    pty.kill();
    term.killError = new Error('Cannot kill a pty that is already killed');
    expect(() => {
      pty.kill();
    }).not.toThrow();
    term.killError = asThrowable(SECRET);
    expect(() => {
      pty.kill();
    }).not.toThrow();
    expect(term.kills).toHaveLength(3);
  });

  it('is ignored after the exit', () => {
    const r = rig();
    const { pty, term } = start(r);
    term.emitExit(-1_073_741_510);
    pty.kill();
    expect(term.kills).toEqual([]);
  });

  it('a kill before the first data is handed to node-pty, which defers it itself', () => {
    const r = rig();
    const { pty, term } = start(r);
    pty.kill();
    expect(term.kills).toEqual([[]]);
    expect(pty.pid).toBe(0);
  });
});

// ---- UnsupportedBackend ------------------------------------------------------------------------------------------

describe('UnsupportedBackend', () => {
  const CODE_OF: readonly (readonly [UnsupportedReason, TerminalErrorCode])[] = [
    ['unsupported-os', 'UNSUPPORTED_OS'],
    ['os-too-old', 'UNSUPPORTED_OS'],
    ['native-missing', 'NATIVE_MISSING'],
    ['native-load-failed', 'NATIVE_LOAD_FAILED'],
  ];

  it.each(CODE_OF)('reason %s: not supported, and spawn throws %s', (reason, code) => {
    const backend = new UnsupportedBackend(reason);
    expect(backend.name).toBe('unsupported');
    expect(backend.reason).toBe(reason);
    expect(backend.support).toEqual({ supported: false, reason });
    const error = expectTerminalError(
      thrownBy(() => backend.spawn('claude', [], 'D:\\w', 80, 24, {})),
      code,
    );
    expect(error.cause).toBeUndefined();
  });

  it.each(CODE_OF)('throws the same code as FakePtyBackend does for %s', (reason, code) => {
    const fake = new FakePtyBackend({ support: { supported: false, reason } });
    expectTerminalError(
      thrownBy(() => fake.spawn('claude', [], 'D:\\w', 80, 24, {})),
      code,
    );
  });

  it('unsupportedReasonOf reads the three backend codes and nothing else', () => {
    expect(unsupportedReasonOf('UNSUPPORTED_OS')).toBe('unsupported-os');
    expect(unsupportedReasonOf('NATIVE_MISSING')).toBe('native-missing');
    expect(unsupportedReasonOf('NATIVE_LOAD_FAILED')).toBe('native-load-failed');
    for (const code of [
      'CLAUDE_NOT_FOUND',
      'SPAWN_FAILED',
      'START_TIMEOUT',
      'SESSION_LIMIT',
      'SHUTTING_DOWN',
    ] as const) {
      expect(unsupportedReasonOf(code)).toBeNull();
    }
  });
});

// ---- createNodePtyBackend ----------------------------------------------------------------------------------------

interface LogCall {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

type SetupOptions = Omit<Partial<CreateNodePtyBackendOptions>, 'logger'> & {
  /** A logger of the test, or `'none'` for a call without one. The default records into `logs`. */
  readonly logger?: CreateNodePtyBackendOptions['logger'] | 'none';
};

function setup(o: SetupOptions = {}): {
  backend: ReturnType<typeof createNodePtyBackend>;
  native: ScriptedNative;
  loads: number[];
  logs: LogCall[];
} {
  const native = new ScriptedNative();
  const loads: number[] = [];
  const logs: LogCall[] = [];
  const { logger, ...rest } = o;
  const recording = {
    info: (event: string, fields?: Readonly<Record<string, unknown>>) => logs.push({ level: 'info', event, fields }),
    warn: (event: string, fields?: Readonly<Record<string, unknown>>) => logs.push({ level: 'warn', event, fields }),
  };
  const backend = createNodePtyBackend({
    platform: 'win32',
    arch: 'x64',
    release: '10.0.26200',
    load: () => {
      loads.push(1);
      return { module: native.module, via: 'bundle', dir: 'C:\\caw\\bundle\\native\\win32-x64' };
    },
    ...rest,
    ...(logger === 'none' ? {} : { logger: logger ?? recording }),
  });
  return { backend, native, loads, logs };
}

function unsupportedReason(backend: ReturnType<typeof createNodePtyBackend>): UnsupportedReason | null {
  return backend.support.supported ? null : backend.support.reason;
}

describe('createNodePtyBackend', () => {
  it('returns the real backend on a shipped target with a new enough Windows, and loads the addon once', () => {
    const { backend, loads, logs } = setup();
    expect(backend).toBeInstanceOf(NodePtyBackend);
    expect(backend.name).toBe('node-pty');
    expect(backend.support).toEqual({ supported: true });
    expect(loads).toHaveLength(1);
    expect(backend).toMatchObject({ via: 'bundle', dir: 'C:\\caw\\bundle\\native\\win32-x64' });
    expect(logs).toEqual([{ level: 'info', event: 'terminal.native', fields: { phase: 'loaded' } }]);
  });

  it('hands the configuration to the backend it builds', async () => {
    const { backend, native } = setup({ useConptyDll: true, startTimeoutMs: 1500 });
    const pty = backend.spawn('claude', [], 'D:\\w', 80, 24, {});
    expect(native.calls[0]!.options).toMatchObject({ useConptyDll: true });
    const started = track(pty.started);
    await vi.advanceTimersByTimeAsync(1500);
    expect(started.state).toBe('rejected');
  });

  it.each([
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['other', 'x64'],
    ['win32', 'ia32'],
    ['win32', 'arm'],
  ] as const)('%s on %s is unsupported-os and the addon is never loaded', (platform, arch) => {
    const { backend, loads, logs } = setup({ platform, arch });
    expect(backend).toBeInstanceOf(UnsupportedBackend);
    expect(backend.name).toBe('unsupported');
    expect(unsupportedReason(backend)).toBe('unsupported-os');
    expect(loads).toEqual([]);
    expect(logs).toEqual([]);
    expectTerminalError(
      thrownBy(() => backend.spawn('claude', [], 'D:\\w', 80, 24, {})),
      'UNSUPPORTED_OS',
    );
  });

  it.each(['10.0.17762', '10.0.17134', '10.0.10240', '6.3.9600', '', 'not a release'])(
    'Windows release %j is os-too-old (ConPTY needs build 17763) and the addon is never loaded',
    (release) => {
      const { backend, loads } = setup({ release });
      expect(backend).toBeInstanceOf(UnsupportedBackend);
      expect(unsupportedReason(backend)).toBe('os-too-old');
      expect(loads).toEqual([]);
    },
  );

  it('build 17763 is the first that works', () => {
    expect(setup({ release: '10.0.17763' }).backend.support).toEqual({ supported: true });
  });

  it('checks the target before the Windows build', () => {
    const { backend } = setup({ platform: 'linux', release: '5.15.0' });
    expect(unsupportedReason(backend)).toBe('unsupported-os');
  });

  it('a missing native folder is native-missing, logged as such, with no path', () => {
    const { backend, logs } = setup({
      load: () => {
        throw new TerminalError('NATIVE_MISSING');
      },
    });
    expect(unsupportedReason(backend)).toBe('native-missing');
    expect(logs).toEqual([{ level: 'warn', event: 'terminal.native', fields: { phase: 'missing' } }]);
    expectTerminalError(
      thrownBy(() => backend.spawn('claude', [], 'D:\\w', 80, 24, {})),
      'NATIVE_MISSING',
    );
  });

  it('a load that fails is native-load-failed, logged with the error code only', () => {
    const { backend, logs } = setup({
      load: () => {
        throw new TerminalError('NATIVE_LOAD_FAILED', { cause: { code: 'ERR_DLOPEN_FAILED' } });
      },
    });
    expect(unsupportedReason(backend)).toBe('native-load-failed');
    expect(logs).toEqual([
      { level: 'warn', event: 'terminal.native', fields: { phase: 'failed', code: 'ERR_DLOPEN_FAILED' } },
    ]);
  });

  it('a loader that reports UNSUPPORTED_OS makes the backend unsupported-os', () => {
    const { backend } = setup({
      load: () => {
        throw new TerminalError('UNSUPPORTED_OS');
      },
    });
    expect(unsupportedReason(backend)).toBe('unsupported-os');
  });

  it('an unexpected throw of the loader is native-load-failed and nothing of it is logged', () => {
    for (const thrown of [new Error(SECRET), SECRET, null, new TerminalError('SESSION_LIMIT')]) {
      const { backend, logs } = setup({
        load: () => {
          throw asThrowable(thrown);
        },
      });
      expect(unsupportedReason(backend)).toBe('native-load-failed');
      expect(logs).toEqual([{ level: 'warn', event: 'terminal.native', fields: { phase: 'failed' } }]);
      expect(inspect(logs, { depth: 6 })).not.toContain('secret-folder');
    }
  });

  it('works without a logger', () => {
    const { backend } = setup({ logger: 'none' });
    expect(backend.support).toEqual({ supported: true });
  });

  it('a throwing logger does not break the backend', () => {
    const { backend } = setup({
      logger: {
        info: () => {
          throw new Error('x');
        },
        warn: () => {
          throw new Error('x');
        },
      },
    });
    expect(backend.support).toEqual({ supported: true });
  });

  it.runIf(hostPlatform === 'win32' && (process.arch === 'x64' || process.arch === 'arm64'))(
    'without a scripted loader it loads the installed addon of this checkout',
    () => {
      const backend = createNodePtyBackend({ platform: hostPlatform, arch: process.arch, release: '10.0.26200' });
      expect(backend).toBeInstanceOf(NodePtyBackend);
      expect(backend).toMatchObject({ via: 'node_modules', dir: null });
    },
  );

  it('without a scripted loader, a host that has no target never reaches the real loader', () => {
    const backend = createNodePtyBackend({ platform: 'linux', arch: 'x64', release: '5.15.0' });
    expect(unsupportedReason(backend)).toBe('unsupported-os');
  });
});
