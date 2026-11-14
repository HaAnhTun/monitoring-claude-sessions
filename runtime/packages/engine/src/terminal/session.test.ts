import { FIXTURE_EPOCH_MS, FakeClock } from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOG_FIELD_NAMES } from '../log/logger.ts';
import { TerminalError } from './errors.ts';
import { FakePty, FakePtyBackend, type FakePtyOptions } from './fake-pty.ts';
import { RESIZE_DEBOUNCE_MS, REPLAY_FRAME_BYTES, VIEWER_BACKLOG_LIMIT_BYTES } from './limits.ts';
import { KILL_TREE_WAIT_MS, Session, clampSessionSize, type SessionLogger } from './session.ts';
import * as testing from './testing.ts';
import type { SessionExit, Viewer, ViewerEnd } from './types.ts';

const ESC = '\u001b';
const MIB = 1024 * 1024;
const KILLED_BY_CONPTY = -1_073_741_510;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- fakes -------------------------------------------------------------------------------------------------------

/** A viewer that records what it gets. `pendingBytes` and the failures are switches. */
class TestViewer implements Viewer {
  readonly chunks: Buffer[] = [];
  readonly ends: ViewerEnd[] = [];
  pending = 0;
  sendError: Error | null = null;
  endError: Error | null = null;
  pendingError: Error | null = null;
  readonly #label: string;
  readonly #order: string[] | null;

  constructor(label = 'viewer', order: string[] | null = null) {
    this.#label = label;
    this.#order = order;
  }

  send(chunk: Uint8Array): void {
    if (this.sendError !== null) throw this.sendError;
    this.chunks.push(Buffer.from(chunk));
    this.#order?.push(this.#label);
  }

  pendingBytes(): number {
    if (this.pendingError !== null) throw this.pendingError;
    return this.pending;
  }

  end(reason: ViewerEnd): void {
    this.ends.push(reason);
    if (this.endError !== null) throw this.endError;
  }

  get bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  get text(): string {
    return this.bytes.toString('latin1');
  }
}

interface LogCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

function capturingLogger(): { logger: SessionLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const at =
    (level: LogCall['level']) =>
    (event: string, fields?: Readonly<Record<string, unknown>>): void => {
      calls.push({ level, event, fields });
    };
  return {
    calls,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
}

interface RigOptions {
  pty?: FakePtyOptions;
  replayBytes?: number;
  maxInputBytes?: number;
  killTimeoutMs?: number;
  killTree?: (pid: number) => Promise<void>;
  logger?: SessionLogger;
  throwingCallbacks?: boolean;
}

const NAME = 'proj-1';
const CWD = 'D:\\work\\proj';

function rig(o: RigOptions = {}) {
  const pty = new FakePty({ pid: 4321, ...o.pty });
  const clock = new FakeClock(FIXTURE_EPOCH_MS + 12_000);
  const ended: SessionExit[] = [];
  const killedTrees: number[] = [];
  const state = { updated: 0 };
  const session = new Session({
    name: NAME,
    cwd: CWD,
    pty,
    startedAt: FIXTURE_EPOCH_MS + 2000,
    cols: 120,
    rows: 30,
    replayBytes: o.replayBytes ?? MIB,
    maxInputBytes: o.maxInputBytes ?? 1024,
    killTimeoutMs: o.killTimeoutMs ?? 3000,
    clock,
    killTree:
      o.killTree ??
      ((pid) => {
        killedTrees.push(pid);
        return Promise.resolve();
      }),
    onUpdated: () => {
      state.updated += 1;
      if (o.throwingCallbacks === true) throw new Error('listener failed');
    },
    onEnded: (exit) => {
      ended.push(exit);
      if (o.throwingCallbacks === true) throw new Error('listener failed');
    },
    ...(o.logger === undefined ? {} : { logger: o.logger }),
  });
  return { session, pty, clock, ended, killedTrees, state };
}

/** Numbered lines of 64 bytes each, in chunks of 8 KiB (128 lines): output with a recognisable tail and line starts. */
function numberedChunks(totalBytes: number): Buffer[] {
  const chunks: Buffer[] = [];
  let line = 0;
  for (let written = 0; written < totalBytes; written += 8192) {
    let text = '';
    for (let i = 0; i < 128; i += 1) {
      text += `${String(line).padStart(8, '0')} ${'x'.repeat(54)}\n`;
      line += 1;
    }
    chunks.push(Buffer.from(text, 'latin1'));
  }
  return chunks;
}

// ---- FakePty and FakePtyBackend ----------------------------------------------------------------------------------

describe('TC-UNIT-08 FakePty', () => {
  it('is started at once by default, with the pid it was given', async () => {
    const pty = new FakePty({ pid: 77 });
    await expect(pty.started).resolves.toEqual({ pid: 77 });
    expect(pty.pid).toBe(77);
  });

  it('with autoStart off has pid 0 and starts with the first data, like node-pty', async () => {
    const pty = new FakePty({ pid: 77, autoStart: false });
    expect(pty.pid).toBe(0);
    let resolved = false;
    void pty.started.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    pty.emitData('first');
    await expect(pty.started).resolves.toEqual({ pid: 77 });
    expect(pty.pid).toBe(77);
  });

  it('with autoStart off can be started by hand, and start() twice is harmless', async () => {
    const pty = new FakePty({ pid: 5, autoStart: false });
    pty.start();
    pty.start();
    await expect(pty.started).resolves.toEqual({ pid: 5 });
  });

  it('failStart rejects `started` (SPAWN_FAILED by default, or the given error) and keeps the pid 0', async () => {
    const pty = new FakePty({ autoStart: false });
    pty.failStart();
    const error = await pty.started.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TerminalError);
    expect(error).toMatchObject({ code: 'SPAWN_FAILED' });
    expect(pty.pid).toBe(0);
    const other = new FakePty({ autoStart: false });
    other.failStart(new TerminalError('START_TIMEOUT'));
    await expect(other.started).rejects.toMatchObject({ code: 'START_TIMEOUT' });
  });

  it('a started pty ignores failStart and a failed one ignores start', async () => {
    const started = new FakePty({ pid: 9 });
    started.failStart();
    await expect(started.started).resolves.toEqual({ pid: 9 });
    const failed = new FakePty({ pid: 9, autoStart: false });
    failed.failStart();
    failed.start();
    failed.emitData('x');
    await expect(failed.started).rejects.toMatchObject({ code: 'SPAWN_FAILED' });
  });

  it('delivers data as Buffers, text as UTF-8, to every listener, until unsubscribed', () => {
    const pty = new FakePty();
    const a: Buffer[] = [];
    const b: Buffer[] = [];
    const offA = pty.onData((chunk) => a.push(chunk));
    pty.onData((chunk) => b.push(chunk));
    pty.emitData('h\u00e9');
    pty.emitData(Uint8Array.from([1, 2, 3]));
    offA();
    pty.emitData('later');
    expect(a.map((chunk) => [...chunk])).toEqual([
      [0x68, 0xc3, 0xa9],
      [1, 2, 3],
    ]);
    expect(b).toHaveLength(3);
    expect(Buffer.isBuffer(b[0])).toBe(true);
    expect(pty.dataListeners).toBe(1);
  });

  it('holds output that arrives before the first listener and hands it over in order, once', () => {
    const pty = new FakePty();
    pty.emitData('one');
    pty.emitData('two');
    const first: string[] = [];
    pty.onData((chunk) => first.push(chunk.toString()));
    expect(first).toEqual(['one', 'two']);
    const second: string[] = [];
    pty.onData((chunk) => second.push(chunk.toString()));
    expect(second).toEqual([]);
  });

  it('ignores empty chunks and data after the exit', () => {
    const pty = new FakePty();
    const seen: Buffer[] = [];
    pty.onData((chunk) => seen.push(chunk));
    pty.emitData('');
    pty.emitExit(0);
    pty.emitData('late');
    expect(seen).toEqual([]);
  });

  it('reports the exit once, and a listener that throws does not stop the others', () => {
    const pty = new FakePty();
    const codes: (number | null)[] = [];
    pty.onExit(() => {
      throw new Error('boom');
    });
    pty.onExit((exit) => codes.push(exit.code));
    pty.emitExit(3);
    pty.emitExit(4);
    expect(codes).toEqual([3]);
    expect(pty.exitCode).toBe(3);
    expect(pty.exited).toBe(true);
    const late: (number | null)[] = [];
    pty.onExit((exit) => late.push(exit.code));
    expect(late).toEqual([]);
  });

  it('isolates a data listener that throws', () => {
    const pty = new FakePty();
    const seen: string[] = [];
    pty.onData(() => {
      throw new Error('boom');
    });
    pty.onData((chunk) => seen.push(chunk.toString()));
    pty.emitData('x');
    expect(seen).toEqual(['x']);
  });

  it('records input as Buffers and sizes, and ignores both after the exit', () => {
    const pty = new FakePty();
    pty.write('ab');
    pty.write(Uint8Array.from([0x63]));
    pty.resize(100, 40);
    expect(pty.written.map((chunk) => chunk.toString())).toEqual(['ab', 'c']);
    expect(pty.writtenText).toBe('abc');
    expect(pty.sizes).toEqual([{ cols: 100, rows: 40 }]);
    pty.emitExit(0);
    pty.write('late');
    pty.resize(1, 1);
    expect(pty.writtenText).toBe('abc');
    expect(pty.sizes).toHaveLength(1);
  });

  it('kill() counts every call and exits at once with the ConPTY code, or stays alive when autoExitOnKill is off', () => {
    const killed = new FakePty();
    killed.kill();
    killed.kill();
    expect(killed.killCalls).toBe(2);
    expect(killed.exitCode).toBe(KILLED_BY_CONPTY);
    const stubborn = new FakePty({ autoExitOnKill: false });
    stubborn.kill();
    expect(stubborn.killCalls).toBe(1);
    expect(stubborn.exited).toBe(false);
    stubborn.autoExitOnKill = true;
    stubborn.kill();
    expect(stubborn.exited).toBe(true);
    const custom = new FakePty({ killExitCode: null });
    custom.kill();
    expect(custom.exited).toBe(true);
    expect(custom.exitCode).toBeNull();
  });
});

describe('TC-UNIT-08 FakePtyBackend', () => {
  it('records every spawn with copies of its arguments and hands out ptys with increasing pids', async () => {
    const backend = new FakePtyBackend({ firstPid: 500 });
    const env = { A: '1' };
    const args = ['--x'];
    const first = backend.spawn('claude', args, 'D:\\a', 120, 30, env);
    const second = backend.spawn('cmd.exe', '/d /s /c ""x.cmd""', 'D:\\b', 80, 24, {});
    args.push('--y');
    env.A = '2';
    expect(backend.name).toBe('fake');
    expect(backend.support).toEqual({ supported: true });
    expect(backend.spawns).toHaveLength(2);
    expect(backend.spawns[0]).toMatchObject({
      cmd: 'claude',
      args: ['--x'],
      cwd: 'D:\\a',
      cols: 120,
      rows: 30,
      env: { A: '1' },
    });
    expect(backend.spawns[1]).toMatchObject({ cmd: 'cmd.exe', args: '/d /s /c ""x.cmd""', cwd: 'D:\\b' });
    expect(backend.spawns[0]?.pty).toBe(first);
    expect(backend.last).toBe(second);
    await expect(first.started).resolves.toEqual({ pid: 500 });
    await expect(second.started).resolves.toEqual({ pid: 501 });
  });

  it('passes its pty options on, and `ptyOptions` can change between spawns', async () => {
    const backend = new FakePtyBackend({ pty: { autoStart: false } });
    const slow = backend.spawn('claude', [], 'D:\\a', 120, 30, {});
    expect(slow.pid).toBe(0);
    backend.ptyOptions = { autoExitOnKill: false };
    const stubborn = backend.spawn('claude', [], 'D:\\a', 120, 30, {});
    stubborn.kill();
    expect(stubborn.killCalls).toBe(1);
    await expect(stubborn.started).resolves.toBeDefined();
  });

  it('throws spawnError when it is set, and then records nothing', () => {
    const backend = new FakePtyBackend();
    const failure = new TerminalError('SPAWN_FAILED');
    backend.spawnError = failure;
    expect(() => backend.spawn('claude', [], 'D:\\a', 120, 30, {})).toThrow(failure);
    expect(backend.spawns).toEqual([]);
    backend.spawnError = null;
    expect(() => backend.spawn('claude', [], 'D:\\a', 120, 30, {})).not.toThrow();
  });

  it('with an unsupported `support` throws the matching TerminalError from spawn', () => {
    const reasons = [
      ['unsupported-os', 'UNSUPPORTED_OS'],
      ['os-too-old', 'UNSUPPORTED_OS'],
      ['native-missing', 'NATIVE_MISSING'],
      ['native-load-failed', 'NATIVE_LOAD_FAILED'],
    ] as const;
    for (const [reason, code] of reasons) {
      const backend = new FakePtyBackend({ support: { supported: false, reason } });
      expect(backend.support).toEqual({ supported: false, reason });
      expect(() => backend.spawn('claude', [], 'D:\\a', 120, 30, {})).toThrow(expect.objectContaining({ code }));
    }
  });

  it('is exported through the testing entry point', () => {
    expect(testing.FakePty).toBe(FakePty);
    expect(testing.FakePtyBackend).toBe(FakePtyBackend);
  });
});

// ---- clampSessionSize --------------------------------------------------------------------------------------------

describe('TC-UNIT-08 clampSessionSize', () => {
  it('clamps to 20..500 columns and 5..200 rows, and cuts fractions', () => {
    expect(clampSessionSize(1000, 1000)).toEqual({ cols: 500, rows: 200 });
    expect(clampSessionSize(1, 1)).toEqual({ cols: 20, rows: 5 });
    expect(clampSessionSize(-50, 0)).toEqual({ cols: 20, rows: 5 });
    expect(clampSessionSize(100.9, 40.2)).toEqual({ cols: 100, rows: 40 });
    expect(clampSessionSize(20, 5)).toEqual({ cols: 20, rows: 5 });
    expect(clampSessionSize(500, 200)).toEqual({ cols: 500, rows: 200 });
  });

  it('is null when a value is not a finite number', () => {
    expect(clampSessionSize(Number.NaN, 30)).toBeNull();
    expect(clampSessionSize(120, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

// ---- Session -----------------------------------------------------------------------------------------------------

describe('TC-UNIT-08 Session: identity', () => {
  it('describes itself', () => {
    const t = rig();
    expect(t.session.info()).toEqual({
      name: NAME,
      cwd: CWD,
      pid: 4321,
      startedAt: FIXTURE_EPOCH_MS + 2000,
      cols: 120,
      rows: 30,
      viewers: 0,
    });
  });

  it('clamps the size it is given', () => {
    const pty = new FakePty();
    const session = new Session({
      name: NAME,
      cwd: CWD,
      pty,
      startedAt: 0,
      cols: 9999,
      rows: 1,
      replayBytes: MIB,
      maxInputBytes: 1024,
      killTimeoutMs: 3000,
      clock: new FakeClock(0),
      killTree: () => Promise.resolve(),
      onUpdated: () => undefined,
      onEnded: () => undefined,
    });
    expect(session.info()).toMatchObject({ cols: 500, rows: 5 });
  });
});

describe('TC-UNIT-08 Session: attach, replay and viewers', () => {
  it('replays the output so far, then the live bytes, without a gap or a repeat', () => {
    const t = rig();
    t.pty.emitData('one ');
    t.pty.emitData('two ');
    const viewer = new TestViewer();
    const attached = t.session.attach(viewer);
    t.pty.emitData('three');
    expect(viewer.text).toBe('one two three');
    expect(attached).toEqual({ replayedBytes: 8, cols: 120, rows: 30 });
  });

  it('sends the replay in frames of at most 64 KiB, every byte once and in order', () => {
    const t = rig();
    const output = Buffer.concat(numberedChunks(200 * 1024));
    for (let at = 0; at < output.length; at += 8192) t.pty.emitData(output.subarray(at, at + 8192));
    const viewer = new TestViewer();
    const attached = t.session.attach(viewer);
    expect(viewer.chunks.length).toBe(Math.ceil(output.length / REPLAY_FRAME_BYTES));
    expect(viewer.chunks.every((chunk) => chunk.length <= REPLAY_FRAME_BYTES)).toBe(true);
    expect(viewer.chunks[0]?.length).toBe(REPLAY_FRAME_BYTES);
    expect(attached.replayedBytes).toBe(output.length);
    expect(viewer.bytes.equals(output)).toBe(true);
  });

  it('sends nothing for an empty replay, and nothing when `replay` is false', () => {
    const t = rig();
    const empty = new TestViewer();
    expect(t.session.attach(empty).replayedBytes).toBe(0);
    expect(empty.chunks).toEqual([]);
    t.pty.emitData('abc');
    const quiet = new TestViewer();
    expect(t.session.attach(quiet, { replay: false }).replayedBytes).toBe(0);
    expect(quiet.chunks).toEqual([]);
    t.pty.emitData('def');
    expect(quiet.text).toBe('def');
    expect(empty.text).toBe('abcdef');
  });

  it('removes terminal queries from the replay but never from the live stream', () => {
    const t = rig();
    const early = new TestViewer();
    t.session.attach(early);
    t.pty.emitData(`${ESC}[c hello ${ESC}[6n${ESC}[31mred${ESC}[0m`);
    expect(early.text).toBe(`${ESC}[c hello ${ESC}[6n${ESC}[31mred${ESC}[0m`);
    const late = new TestViewer();
    t.session.attach(late);
    expect(late.text).toBe(` hello ${ESC}[31mred${ESC}[0m`);
  });

  it('feeds several viewers the same bytes, in attach order', () => {
    const t = rig();
    const order: string[] = [];
    const a = new TestViewer('A', order);
    const b = new TestViewer('B', order);
    const c = new TestViewer('C', order);
    t.session.attach(a);
    t.session.attach(b);
    t.pty.emitData('x');
    t.session.attach(c);
    t.pty.emitData('y');
    // A and B got "x" live, C got it as its replay, then all three got "y" in attach order.
    expect(order).toEqual(['A', 'B', 'C', 'A', 'B', 'C']);
    expect(a.text).toBe('xy');
    expect(b.text).toBe('xy');
    expect(c.text).toBe('xy');
    expect(t.session.info().viewers).toBe(3);
  });

  it('delivers one chunk to the viewers in the order they attached', () => {
    const t = rig();
    const order: string[] = [];
    for (const label of ['A', 'B', 'C']) t.session.attach(new TestViewer(label, order));
    t.pty.emitData('x');
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('stops feeding a viewer that detached, and detaching twice or an unknown viewer is harmless', () => {
    const t = rig();
    const a = new TestViewer();
    const b = new TestViewer();
    t.session.attach(a);
    t.session.attach(b);
    t.pty.emitData('1');
    t.session.detach(a);
    t.session.detach(a);
    t.session.detach(new TestViewer());
    t.pty.emitData('2');
    expect(a.text).toBe('1');
    expect(b.text).toBe('12');
    expect(a.ends).toEqual([]);
    expect(t.session.info().viewers).toBe(1);
  });

  it('keeps a viewer that attaches twice once, and does not replay to it again', () => {
    const t = rig();
    t.pty.emitData('abc');
    const viewer = new TestViewer();
    t.session.attach(viewer);
    expect(t.session.attach(viewer).replayedBytes).toBe(0);
    expect(viewer.text).toBe('abc');
    t.pty.emitData('d');
    expect(viewer.text).toBe('abcd');
    expect(t.session.info().viewers).toBe(1);
  });

  it('lets a viewer detach itself inside send: it is not ended, and the others still get the chunk', () => {
    const t = rig();
    const seen: string[] = [];
    const selfDetaching: Viewer = {
      send: () => {
        t.session.detach(selfDetaching);
      },
      end: () => {
        seen.push('ended');
      },
    };
    const other = new TestViewer();
    t.session.attach(selfDetaching);
    t.session.attach(other);
    t.pty.emitData('x');
    expect(seen).toEqual([]);
    expect(other.text).toBe('x');
    expect(t.session.info().viewers).toBe(1);
  });

  it('gives a viewer that attaches from inside send the chunk once, through its replay', () => {
    const t = rig();
    const late = new TestViewer();
    let attached = false;
    const trigger: Viewer = {
      send: () => {
        if (attached) return;
        attached = true;
        t.session.attach(late);
      },
      end: () => undefined,
    };
    t.session.attach(trigger);
    t.pty.emitData('x');
    expect(late.text).toBe('x');
    t.pty.emitData('y');
    expect(late.text).toBe('xy');
  });

  it('tells the owner about every attach and detach', () => {
    const t = rig();
    const viewer = new TestViewer();
    t.session.attach(viewer);
    expect(t.state.updated).toBe(1);
    t.session.detach(viewer);
    expect(t.state.updated).toBe(2);
    t.session.detach(viewer);
    expect(t.state.updated).toBe(2);
  });

  it('refuses to attach once the session is over', () => {
    const t = rig();
    t.pty.emitExit(0);
    expect(() => t.session.attach(new TestViewer())).toThrow(expect.objectContaining({ code: 'SESSION_ENDED' }));
  });

  it('does not register a viewer whose send throws during the replay, and ends it with error', () => {
    const t = rig();
    t.pty.emitData('abc');
    const dead = new TestViewer();
    dead.sendError = new Error('peer gone');
    const attached = t.session.attach(dead);
    expect(attached.replayedBytes).toBe(0);
    expect(dead.ends).toEqual([{ reason: 'error' }]);
    expect(t.session.info().viewers).toBe(0);
  });
});

describe('TC-UNIT-08 Session: slow and failing viewers', () => {
  it('evicts a viewer whose queue passes the backlog limit, ends it as slow and keeps the others', () => {
    const t = rig();
    const slow = new TestViewer();
    const fast = new TestViewer();
    t.session.attach(slow);
    t.session.attach(fast);
    t.state.updated = 0;
    slow.pending = VIEWER_BACKLOG_LIMIT_BYTES + 1;
    t.pty.emitData('a');
    t.pty.emitData('b');
    expect(slow.ends).toEqual([{ reason: 'slow' }]);
    expect(slow.text).toBe('a');
    expect(fast.text).toBe('ab');
    expect(fast.ends).toEqual([]);
    expect(t.session.info().viewers).toBe(1);
    expect(t.state.updated).toBe(1);
  });

  it('keeps a viewer whose queue is exactly at the limit', () => {
    const t = rig();
    const viewer = new TestViewer();
    t.session.attach(viewer);
    viewer.pending = VIEWER_BACKLOG_LIMIT_BYTES;
    t.pty.emitData('a');
    expect(viewer.ends).toEqual([]);
    expect(t.session.info().viewers).toBe(1);
  });

  it('evicts a viewer whose send throws, in the middle of the pump, without losing the chunk for the rest', () => {
    const t = rig();
    const first = new TestViewer();
    const broken = new TestViewer();
    const last = new TestViewer();
    for (const viewer of [first, broken, last]) t.session.attach(viewer);
    broken.sendError = new Error('peer gone');
    t.pty.emitData('x');
    expect(first.text).toBe('x');
    expect(last.text).toBe('x');
    expect(broken.ends).toEqual([{ reason: 'error' }]);
    t.pty.emitData('y');
    expect(first.text).toBe('xy');
    expect(last.text).toBe('xy');
    expect(broken.ends).toHaveLength(1);
  });

  it('evicts a viewer whose pendingBytes throws, as error', () => {
    const t = rig();
    const viewer = new TestViewer();
    t.session.attach(viewer);
    viewer.pendingError = new Error('socket closed');
    t.pty.emitData('x');
    expect(viewer.ends).toEqual([{ reason: 'error' }]);
  });

  it('works with a viewer that has no pendingBytes', () => {
    const t = rig();
    const seen: string[] = [];
    const plain: Viewer = {
      send: (chunk) => {
        seen.push(Buffer.from(chunk).toString());
      },
      end: () => undefined,
    };
    t.session.attach(plain);
    t.pty.emitData('x');
    expect(seen).toEqual(['x']);
  });

  it('survives a viewer whose end() throws, when it is evicted and when the session ends', () => {
    const t = rig();
    const evicted = new TestViewer();
    const other = new TestViewer();
    evicted.endError = new Error('already closed');
    other.endError = new Error('already closed');
    t.session.attach(evicted);
    t.session.attach(other);
    evicted.sendError = new Error('peer gone');
    t.pty.emitData('x');
    expect(evicted.ends).toHaveLength(1);
    t.pty.emitExit(0);
    expect(other.ends).toHaveLength(1);
    expect(t.ended).toHaveLength(1);
  });

  it('never pauses or slows the process for a slow viewer: the replay holds the output', () => {
    const t = rig();
    const slow = new TestViewer();
    slow.pending = VIEWER_BACKLOG_LIMIT_BYTES * 2;
    t.session.attach(slow);
    t.pty.emitData('keep going');
    const late = new TestViewer();
    t.session.attach(late);
    expect(late.text).toBe('keep going');
  });
});

describe('TC-UNIT-08 Session: replay is bounded', () => {
  it('keeps a 1 MiB tail of 3 MiB of output, starting at a line, ending with the last byte', () => {
    const t = rig();
    const chunks = numberedChunks(3 * MIB);
    for (const chunk of chunks) t.pty.emitData(chunk);
    const all = Buffer.concat(chunks);
    expect(all.length).toBe(3 * MIB);
    const viewer = new TestViewer();
    const attached = t.session.attach(viewer);
    expect(attached.replayedBytes).toBeLessThanOrEqual(MIB);
    expect(attached.replayedBytes).toBeGreaterThan(MIB - 8192);
    expect(viewer.bytes.length).toBe(attached.replayedBytes);
    const replay = viewer.bytes;
    expect(replay.subarray(0, 4).toString('latin1')).toBe(`${ESC}[0m`);
    expect(/^\d{8} x{54}\n/.test(replay.subarray(4, 4 + 64).toString('latin1'))).toBe(true);
    const tail = replay.subarray(4);
    expect(tail.equals(all.subarray(all.length - tail.length))).toBe(true);
  });

  it('honours a smaller replay capacity', () => {
    const t = rig({ replayBytes: 65_536 });
    for (const chunk of numberedChunks(MIB)) t.pty.emitData(chunk);
    const viewer = new TestViewer();
    expect(t.session.attach(viewer).replayedBytes).toBeLessThanOrEqual(65_536);
  });
});

describe('TC-UNIT-08 Session: input', () => {
  it('forwards a string and bytes to the process unchanged', () => {
    const t = rig();
    t.session.write('ls\r');
    t.session.write(Uint8Array.from([0x03]));
    t.session.write('h\u00e9');
    expect(t.pty.written.map((chunk) => [...chunk])).toEqual([[0x6c, 0x73, 0x0d], [0x03], [0x68, 0xc3, 0xa9]]);
  });

  it('refuses input over maxInputBytes with MESSAGE_TOO_LARGE and forwards nothing', () => {
    const t = rig({ maxInputBytes: 1024 });
    t.session.write('a'.repeat(1024));
    expect(t.pty.written).toHaveLength(1);
    expect(() => {
      t.session.write('a'.repeat(1025));
    }).toThrow(expect.objectContaining({ code: 'MESSAGE_TOO_LARGE' }));
    expect(() => {
      t.session.write(new Uint8Array(1025));
    }).toThrow(expect.objectContaining({ code: 'MESSAGE_TOO_LARGE' }));
    expect(t.pty.written).toHaveLength(1);
  });

  it('measures a string in UTF-8 bytes, not characters', () => {
    const t = rig({ maxInputBytes: 1024 });
    t.session.write('\u00e9'.repeat(512));
    expect(() => {
      t.session.write('\u00e9'.repeat(513));
    }).toThrow(expect.objectContaining({ code: 'MESSAGE_TOO_LARGE' }));
    expect(t.pty.written).toHaveLength(1);
  });

  it('ignores empty input and input after the exit, even an oversized one', () => {
    const t = rig({ maxInputBytes: 1024 });
    t.session.write('');
    t.session.write(new Uint8Array(0));
    expect(t.pty.written).toEqual([]);
    t.pty.emitExit(0);
    t.session.write('late');
    expect(() => {
      t.session.write('a'.repeat(5000));
    }).not.toThrow();
    expect(t.pty.written).toEqual([]);
  });

  it('does not let a failing process write reach the caller', () => {
    const t = rig();
    t.pty.write = () => {
      throw new Error('pipe closed');
    };
    expect(() => {
      t.session.write('x');
    }).not.toThrow();
  });
});

describe('TC-UNIT-08 Session: resize', () => {
  it('applies a resize 60 ms after the call, once', () => {
    const t = rig();
    t.session.resize(100, 40);
    expect(t.pty.sizes).toEqual([]);
    expect(t.session.info()).toMatchObject({ cols: 120, rows: 30 });
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS - 1);
    expect(t.pty.sizes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.pty.sizes).toEqual([{ cols: 100, rows: 40 }]);
    expect(t.session.info()).toMatchObject({ cols: 100, rows: 40 });
    vi.advanceTimersByTime(1000);
    expect(t.pty.sizes).toHaveLength(1);
  });

  it('is a trailing debounce: every call restarts the 60 ms, and the last size wins', () => {
    const t = rig();
    t.session.resize(100, 40);
    vi.advanceTimersByTime(50);
    t.session.resize(90, 35);
    vi.advanceTimersByTime(50);
    t.session.resize(80, 25);
    vi.advanceTimersByTime(59);
    expect(t.pty.sizes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.pty.sizes).toEqual([{ cols: 80, rows: 25 }]);
  });

  it('clamps the size, and ignores a value that is not a finite number', () => {
    const t = rig();
    t.session.resize(1000, 1000);
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    t.session.resize(1, 1);
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    t.session.resize(Number.NaN, 30);
    t.session.resize(80, Number.POSITIVE_INFINITY);
    vi.advanceTimersByTime(1000);
    expect(t.pty.sizes).toEqual([
      { cols: 500, rows: 200 },
      { cols: 20, rows: 5 },
    ]);
  });

  it('ignores a call that equals the current size', () => {
    const t = rig();
    t.session.resize(120, 30);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(t.pty.sizes).toEqual([]);
  });

  it('does not restart the debounce for a call that equals the pending size', () => {
    const t = rig();
    t.session.resize(100, 40);
    vi.advanceTimersByTime(50);
    t.session.resize(100, 40);
    vi.advanceTimersByTime(10);
    expect(t.pty.sizes).toEqual([{ cols: 100, rows: 40 }]);
  });

  it('cancels a pending resize when the last call returns to the current size', () => {
    const t = rig();
    t.session.resize(100, 40);
    t.session.resize(120, 30);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(t.pty.sizes).toEqual([]);
    expect(t.session.info()).toMatchObject({ cols: 120, rows: 30 });
  });

  it('applies a size that equals an earlier applied one again only after another size', () => {
    const t = rig();
    t.session.resize(100, 40);
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    t.session.resize(100, 40);
    vi.advanceTimersByTime(1000);
    t.session.resize(120, 30);
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(t.pty.sizes).toEqual([
      { cols: 100, rows: 40 },
      { cols: 120, rows: 30 },
    ]);
  });

  it('tells the owner once per applied resize, not per call', () => {
    const t = rig();
    t.session.resize(100, 40);
    t.session.resize(90, 35);
    expect(t.state.updated).toBe(0);
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(t.state.updated).toBe(1);
  });

  it('reports the applied size to a viewer that attaches while a resize is pending', () => {
    const t = rig();
    t.session.resize(100, 40);
    expect(t.session.attach(new TestViewer())).toMatchObject({ cols: 120, rows: 30 });
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(t.session.attach(new TestViewer())).toMatchObject({ cols: 100, rows: 40 });
  });

  it('drops a pending resize when the process exits, and ignores resizes afterwards', () => {
    const t = rig();
    t.session.resize(100, 40);
    t.pty.emitExit(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    t.session.resize(90, 35);
    vi.advanceTimersByTime(1000);
    expect(t.pty.sizes).toEqual([]);
  });
});

describe('TC-UNIT-08 Session: exit', () => {
  it('finalises a natural exit: viewers end with the exit, the owner hears once, the session is over', () => {
    const t = rig();
    const a = new TestViewer();
    const b = new TestViewer();
    t.session.attach(a);
    t.session.attach(b);
    t.pty.emitExit(0);
    const exit: SessionExit = { code: 0, reason: 'exited' };
    expect(a.ends).toEqual([{ reason: 'exited', exit }]);
    expect(b.ends).toEqual([{ reason: 'exited', exit }]);
    expect(t.ended).toEqual([exit]);
    expect(t.session.info().viewers).toBe(0);
    t.pty.emitExit(5);
    expect(t.ended).toHaveLength(1);
  });

  it('keeps a null exit code as it is', () => {
    const t = rig();
    t.pty.emitExit(null);
    expect(t.ended).toEqual([{ code: null, reason: 'exited' }]);
  });

  it('stops listening to the process after the exit and holds no timer', () => {
    const t = rig();
    expect(t.pty.dataListeners).toBe(1);
    t.session.resize(100, 40);
    t.pty.emitExit(0);
    expect(t.pty.dataListeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is not an update for the owner (the owner hears onEnded instead)', () => {
    const t = rig();
    t.session.attach(new TestViewer());
    t.state.updated = 0;
    t.pty.emitExit(0);
    expect(t.state.updated).toBe(0);
  });

  it('survives an owner callback that throws', () => {
    const t = rig({ throwingCallbacks: true });
    const viewer = new TestViewer();
    t.session.attach(viewer);
    t.pty.emitExit(0);
    expect(viewer.ends).toHaveLength(1);
    expect(t.ended).toHaveLength(1);
  });

  it('resolves kill() with the exit that already happened', async () => {
    const t = rig();
    t.pty.emitExit(7);
    await expect(t.session.kill()).resolves.toEqual({ code: 7, reason: 'exited' });
    expect(t.pty.killCalls).toBe(0);
  });
});

describe('TC-UNIT-08 Session: kill', () => {
  it('asks the process to end, and resolves with reason killed when it does', async () => {
    const t = rig();
    const viewer = new TestViewer();
    t.session.attach(viewer);
    const exit = await t.session.kill();
    expect(t.pty.killCalls).toBe(1);
    expect(exit).toEqual({ code: KILLED_BY_CONPTY, reason: 'killed' });
    expect(viewer.ends).toEqual([{ reason: 'killed', exit }]);
    expect(t.ended).toEqual([exit]);
    expect(t.killedTrees).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the exit event when the process ends later, and does not escalate', async () => {
    const t = rig({ pty: { autoExitOnKill: false } });
    const promise = t.session.kill();
    await vi.advanceTimersByTimeAsync(2000);
    t.pty.emitExit(1);
    await expect(promise).resolves.toEqual({ code: 1, reason: 'killed' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.killedTrees).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is idempotent: later calls share the first, and the process is asked once', async () => {
    const t = rig({ pty: { autoExitOnKill: false } });
    const first = t.session.kill();
    const second = t.session.kill();
    expect(second).toBe(first);
    expect(t.pty.killCalls).toBe(1);
    t.pty.emitExit(0);
    const exit = await first;
    expect(await t.session.kill()).toEqual(exit);
    expect(t.pty.killCalls).toBe(1);
    expect(t.ended).toHaveLength(1);
  });

  it('escalates to the injected tree kill after killTimeoutMs, with the pid of the process', async () => {
    const t = rig({ pty: { autoExitOnKill: false }, killTimeoutMs: 3000 });
    void t.session.kill();
    await vi.advanceTimersByTimeAsync(2999);
    expect(t.killedTrees).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.killedTrees).toEqual([4321]);
    await vi.advanceTimersByTimeAsync(KILL_TREE_WAIT_MS - 1);
    expect(t.ended).toEqual([]);
    t.pty.emitExit(-1);
    expect(t.ended).toEqual([{ code: -1, reason: 'killed' }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.killedTrees).toEqual([4321]);
  });

  it('honours the configured killTimeoutMs', async () => {
    const t = rig({ pty: { autoExitOnKill: false }, killTimeoutMs: 500 });
    void t.session.kill();
    await vi.advanceTimersByTimeAsync(499);
    expect(t.killedTrees).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.killedTrees).toEqual([4321]);
  });

  it('ends as lost, 2 s after the tree kill, when the process never reports an exit', async () => {
    const t = rig({ pty: { autoExitOnKill: false }, killTimeoutMs: 3000 });
    const viewer = new TestViewer();
    t.session.attach(viewer);
    const promise = t.session.kill();
    await vi.advanceTimersByTimeAsync(3000 + KILL_TREE_WAIT_MS - 1);
    expect(t.ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const exit: SessionExit = { code: null, reason: 'lost' };
    await expect(promise).resolves.toEqual(exit);
    expect(t.ended).toEqual([exit]);
    expect(viewer.ends).toEqual([{ reason: 'exited', exit }]);
    expect(vi.getTimerCount()).toBe(0);
    t.pty.emitExit(0);
    expect(t.ended).toHaveLength(1);
    expect(() => t.session.attach(new TestViewer())).toThrow(expect.objectContaining({ code: 'SESSION_ENDED' }));
  });

  it('survives a tree kill that rejects and one that throws', async () => {
    const rejecting = rig({
      pty: { autoExitOnKill: false },
      killTree: () => Promise.reject(new Error('taskkill failed')),
    });
    const first = rejecting.session.kill();
    await vi.advanceTimersByTimeAsync(3000 + KILL_TREE_WAIT_MS);
    await expect(first).resolves.toEqual({ code: null, reason: 'lost' });

    const throwing = rig({
      pty: { autoExitOnKill: false },
      killTree: () => {
        throw new Error('no taskkill');
      },
    });
    const second = throwing.session.kill();
    await vi.advanceTimersByTimeAsync(3000 + KILL_TREE_WAIT_MS);
    await expect(second).resolves.toEqual({ code: null, reason: 'lost' });
  });

  it('survives a process whose kill() throws, and still escalates', async () => {
    const t = rig({ pty: { autoExitOnKill: false } });
    t.pty.kill = () => {
      throw new Error('already dead');
    };
    void t.session.kill();
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.killedTrees).toEqual([4321]);
  });

  it('ends viewers with shutdown when the service shuts down, and the first reason wins', async () => {
    const t = rig();
    const viewer = new TestViewer();
    t.session.attach(viewer);
    const exit = await t.session.kill('shutdown');
    expect(exit).toEqual({ code: KILLED_BY_CONPTY, reason: 'shutdown' });
    expect(viewer.ends).toEqual([{ reason: 'shutdown', exit }]);
    const other = rig({ pty: { autoExitOnKill: false } });
    const first = other.session.kill();
    void other.session.kill('shutdown');
    other.pty.emitExit(0);
    await expect(first).resolves.toEqual({ code: 0, reason: 'killed' });
  });

  it('still forwards input while the process is being killed, and ignores it after the exit', () => {
    const t = rig({ pty: { autoExitOnKill: false } });
    void t.session.kill();
    t.session.write('x');
    expect(t.pty.written).toHaveLength(1);
    t.pty.emitExit(0);
    t.session.write('y');
    expect(t.pty.written).toHaveLength(1);
  });

  it('tells the owner of the end before kill() resolves', async () => {
    const t = rig();
    let seenByOwner = false;
    const promise = t.session.kill().then(() => {
      seenByOwner = t.ended.length === 1;
    });
    await promise;
    expect(seenByOwner).toBe(true);
  });
});

describe('TC-UNIT-08 Session: log lines', () => {
  it('logs kill phases, the exit and an eviction with the closed field list and without the name or the folder', async () => {
    const { logger, calls } = capturingLogger();
    const t = rig({ logger, pty: { autoExitOnKill: false } });
    const slow = new TestViewer();
    t.session.attach(slow);
    slow.pending = VIEWER_BACKLOG_LIMIT_BYTES + 1;
    t.pty.emitData(`secret terminal text ${CWD}`);
    void t.session.kill();
    await vi.advanceTimersByTimeAsync(3000 + KILL_TREE_WAIT_MS);

    const byEvent = (event: string): LogCall[] => calls.filter((call) => call.event === event);
    expect(byEvent('terminal.viewer_evicted').map((call) => call.fields)).toEqual([{ code: 'slow' }]);
    expect(byEvent('terminal.kill').map((call) => call.fields)).toEqual([
      { pid: 4321, phase: 'request' },
      { pid: 4321, phase: 'escalate' },
      { pid: 4321, phase: 'lost' },
    ]);
    const exited = byEvent('terminal.exited');
    expect(exited).toHaveLength(1);
    expect(exited[0]?.fields).toEqual({ pid: 4321, durationMs: 10_000 });

    const names: ReadonlySet<string> = new Set(LOG_FIELD_NAMES);
    for (const call of calls) {
      for (const key of Object.keys(call.fields ?? {})) expect(names.has(key), `${call.event}: ${key}`).toBe(true);
    }
    const dump = JSON.stringify(calls);
    expect(dump).not.toContain(NAME);
    expect(dump).not.toContain('work');
    expect(dump).not.toContain('secret');
  });

  it('logs the exit code of a process that ended', () => {
    const { logger, calls } = capturingLogger();
    const t = rig({ logger });
    t.pty.emitExit(3);
    expect(calls.map((call) => [call.event, call.fields])).toEqual([
      ['terminal.exited', { pid: 4321, code: 3, durationMs: 10_000 }],
    ]);
  });
});
