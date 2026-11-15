// The session event feed (CAW-20, design 02 6) without HTTP: a sink that can block, fake timers, a fake session list. What is
// proved here: the opening frames, one coalesced snapshot per 50 ms with a version, latest wins on a blocked sink, the heartbeat,
// the stall drop, the subscription that exists only while a client is connected, the close on revocation, the cap, and that no
// session name or folder reaches the log. The real response, the cookie and the route are `terminal-events.int.test.ts`.
import type { TerminalSessionInfo } from '@mcs/shared';
import { TerminalEventSchemas } from '@mcs/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionInfo } from '../../test/terminal/helpers/fake-terminal.ts';
import type { TERMINAL_EVENT_LIMITS } from './events.ts';
import { createTerminalEvents, type TerminalEventSink, type TerminalEvents } from './events.ts';

// FIXTURE: invented data for tests
const INSTANCE = '0b6f0f4e-6c1e-4a46-9d0a-0a5b3f7c9e11';
const EPOCH = 'a1b2c3d4';
const START = Date.UTC(2026, 9, 11, 14, 5, 7);

interface Frame {
  readonly event: string;
  readonly data: unknown;
}

/** A sink that records the text it was given and answers `false` from `write` while it is blocked, like a full socket. */
class FakeSink implements TerminalEventSink {
  readonly chunks: string[] = [];
  blocked = false;
  destroyed = 0;
  throwOnWrite = false;
  private drain: (() => void) | undefined;

  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error('socket gone');
    this.chunks.push(chunk);
    return !this.blocked;
  }

  onceDrain(callback: () => void): void {
    this.drain = callback;
  }

  destroy(): void {
    this.destroyed += 1;
  }

  /** The socket empties: the sink can take data again and the waiting callback runs. */
  release(): void {
    this.blocked = false;
    const callback = this.drain;
    this.drain = undefined;
    callback?.();
  }

  get text(): string {
    return this.chunks.join('');
  }

  get frames(): Frame[] {
    const out: Frame[] = [];
    for (const block of this.text.split('\n\n')) {
      let event: string | undefined;
      let data: string | undefined;
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (event !== undefined && data !== undefined) out.push({ event, data: JSON.parse(data) as unknown });
    }
    return out;
  }

  of(event: string): Frame[] {
    return this.frames.filter((frame) => frame.event === event);
  }
}

class FakeList {
  sessions: TerminalSessionInfo[] = [];
  readonly listeners = new Set<() => void>();
  subscribed = 0;
  list = (): readonly TerminalSessionInfo[] => this.sessions;
  subscribe = (listener: () => void): (() => void) => {
    this.subscribed += 1;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  change(sessions: TerminalSessionInfo[]): void {
    this.sessions = sessions;
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeAccess {
  readonly listeners = new Set<(credentialId: string) => void>();
  onRevoked = (listener: (credentialId: string) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  revoke(credentialId: string): void {
    for (const listener of [...this.listeners]) listener(credentialId);
  }
}

interface LogLine {
  readonly level: string;
  readonly event: string;
  readonly fields: unknown;
}

interface Harness {
  readonly events: TerminalEvents;
  readonly list: FakeList;
  readonly access: FakeAccess;
  readonly logs: LogLine[];
}

function harness(limits: Partial<typeof TERMINAL_EVENT_LIMITS> = {}): Harness {
  const list = new FakeList();
  const access = new FakeAccess();
  const logs: LogLine[] = [];
  const log =
    (level: string) =>
    (event: string, fields?: unknown): void => {
      logs.push({ level, event, fields });
    };
  const events = createTerminalEvents({
    sessions: list,
    access,
    instanceId: INSTANCE,
    epoch: EPOCH,
    now: () => Date.now(),
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    limits,
  });
  return { events, list, access, logs };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the opening of a stream (TC-WS-05)', () => {
  it('writes the retry hint, the hello and the full list, in that order, and each frame fits its schema', () => {
    const { events, list } = harness();
    list.sessions = [sessionInfo({ name: 'alpha-1' }), sessionInfo({ name: 'beta-1', path: 'C:\\work\\beta' })];
    const sink = new FakeSink();
    expect(events.accept(sink, 'cred-1')).not.toBeNull();
    expect(sink.chunks[0]).toBe('retry: 3000\n\n');
    expect(sink.frames.map((frame) => frame.event)).toEqual(['hello', 'sessions']);
    const hello = TerminalEventSchemas.hello.parse(sink.of('hello')[0]?.data);
    expect(hello).toEqual({
      instanceId: INSTANCE,
      epoch: EPOCH,
      serverTime: '2026-10-11T14:05:07.000Z',
      heartbeatMs: 15_000,
    });
    const sessions = TerminalEventSchemas.sessions.parse(sink.of('sessions')[0]?.data);
    expect(sessions.sessions.map((s) => s.name)).toEqual(['alpha-1', 'beta-1']);
    expect(sessions.version).toBe(1);
  });

  it('sends an empty list as a frame too (a client that connects to an empty host still learns it)', () => {
    const { events } = harness();
    const sink = new FakeSink();
    events.accept(sink, 'cred-1');
    expect(TerminalEventSchemas.sessions.parse(sink.of('sessions')[0]?.data).sessions).toEqual([]);
  });

  it('gives a second client the current version, not a new one', () => {
    const { events, list } = harness();
    list.sessions = [sessionInfo()];
    const first = new FakeSink();
    const second = new FakeSink();
    events.accept(first, 'cred-1');
    events.accept(second, 'cred-2');
    expect(second.of('sessions')[0]?.data).toEqual(first.of('sessions')[0]?.data);
  });
});

describe('coalescing (TC-WS-05)', () => {
  it('turns a burst of changes inside 50 ms into one frame with the newest list and the next version', () => {
    const { events, list } = harness();
    const sink = new FakeSink();
    events.accept(sink, 'cred-1');
    list.change([sessionInfo({ name: 'a-1' })]);
    vi.advanceTimersByTime(20);
    list.change([sessionInfo({ name: 'a-1' }), sessionInfo({ name: 'b-1' })]);
    vi.advanceTimersByTime(20);
    list.change([sessionInfo({ name: 'b-1' })]);
    expect(sink.of('sessions')).toHaveLength(1);
    vi.advanceTimersByTime(10);
    const frames = sink.of('sessions');
    expect(frames).toHaveLength(2);
    const last = TerminalEventSchemas.sessions.parse(frames[1]?.data);
    expect(last.version).toBe(2);
    expect(last.sessions.map((s) => s.name)).toEqual(['b-1']);
  });

  it('sends nothing when no change happened and a later change starts a new window', () => {
    const { events, list } = harness();
    const sink = new FakeSink();
    events.accept(sink, 'cred-1');
    vi.advanceTimersByTime(40);
    expect(sink.of('sessions')).toHaveLength(1);
    list.change([sessionInfo({ name: 'a-1' })]);
    vi.advanceTimersByTime(50);
    list.change([sessionInfo({ name: 'a-1' }), sessionInfo({ name: 'b-1' })]);
    vi.advanceTimersByTime(50);
    expect(sink.of('sessions').map((f) => TerminalEventSchemas.sessions.parse(f.data).version)).toEqual([1, 2, 3]);
  });

  it('does not send a connecting client the same version twice when a change was already waiting', () => {
    const { events, list } = harness();
    const first = new FakeSink();
    events.accept(first, 'cred-1');
    list.change([sessionInfo({ name: 'a-1' })]);
    const second = new FakeSink();
    events.accept(second, 'cred-2');
    vi.advanceTimersByTime(60);
    const versions = (sink: FakeSink): number[] =>
      sink.of('sessions').map((f) => TerminalEventSchemas.sessions.parse(f.data).version);
    expect(versions(second)).toEqual([2]);
    expect(versions(first)).toEqual([1, 2]);
  });
});

describe('a blocked client (latest wins)', () => {
  it('keeps one pending frame, the newest, and writes it when the sink drains', () => {
    const { events, list } = harness();
    const slow = new FakeSink();
    const fast = new FakeSink();
    events.accept(slow, 'cred-1');
    events.accept(fast, 'cred-2');
    slow.blocked = true;
    list.change([sessionInfo({ name: 'a-1' })]); // the write that finds the sink full: accepted, then the sink says "wait"
    vi.advanceTimersByTime(50);
    for (const name of ['b-1', 'c-1', 'd-1']) {
      list.change([sessionInfo({ name })]);
      vi.advanceTimersByTime(50);
    }
    const before = slow.of('sessions').length;
    expect(before).toBe(2); // the opening frame and the one write that filled the sink: nothing else was written
    expect(fast.of('sessions')).toHaveLength(5); // the others are not held back
    slow.release();
    const frames = slow.of('sessions');
    expect(frames).toHaveLength(before + 1);
    const last = TerminalEventSchemas.sessions.parse(frames[frames.length - 1]?.data);
    expect(last.sessions.map((s) => s.name)).toEqual(['d-1']);
    expect(last.version).toBe(5);
  });

  it('writes nothing on drain when no newer frame is pending', () => {
    const { events, list } = harness();
    const sink = new FakeSink();
    events.accept(sink, 'cred-1');
    sink.blocked = true;
    list.change([sessionInfo()]);
    vi.advanceTimersByTime(50);
    const written = sink.chunks.length;
    sink.release();
    expect(sink.chunks).toHaveLength(written);
  });

  it('skips the heartbeat of a client that has not drained', () => {
    const { events } = harness();
    const sink = new FakeSink();
    events.accept(sink, 'cred-1');
    sink.blocked = true;
    vi.advanceTimersByTime(15_000); // the heartbeat that finds the sink full: written, then the sink says "wait"
    const written = sink.chunks.length;
    vi.advanceTimersByTime(15_000);
    expect(sink.chunks).toHaveLength(written);
  });

  it('destroys a client that stays undrained for 30 s, and only that one', () => {
    const { events, list } = harness();
    const stuck = new FakeSink();
    const fine = new FakeSink();
    events.accept(stuck, 'cred-1');
    events.accept(fine, 'cred-2');
    stuck.blocked = true;
    list.change([sessionInfo()]);
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(29_000);
    expect(stuck.destroyed).toBe(0);
    vi.advanceTimersByTime(1_100);
    expect(stuck.destroyed).toBe(1);
    expect(fine.destroyed).toBe(0);
    expect(events.size).toBe(1);
  });

  it('does not destroy a client that drains in time', () => {
    const { events, list } = harness();
    const sink = new FakeSink();
    events.accept(sink, 'cred-1');
    sink.blocked = true;
    list.change([sessionInfo()]);
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(20_000);
    sink.release();
    vi.advanceTimersByTime(60_000);
    expect(sink.destroyed).toBe(0);
    expect(events.size).toBe(1);
  });

  it('drops a client whose sink throws on write, and keeps the others', () => {
    const { events, list } = harness();
    const broken = new FakeSink();
    const fine = new FakeSink();
    events.accept(broken, 'cred-1');
    events.accept(fine, 'cred-2');
    broken.throwOnWrite = true;
    list.change([sessionInfo()]);
    vi.advanceTimersByTime(50);
    expect(broken.destroyed).toBe(1);
    expect(events.size).toBe(1);
    expect(fine.of('sessions')).toHaveLength(2);
  });
});

describe('the heartbeat', () => {
  it('sends one every 15 s with the server time', () => {
    const { events } = harness();
    const sink = new FakeSink();
    events.accept(sink, 'cred-1');
    expect(sink.of('heartbeat')).toHaveLength(0);
    vi.advanceTimersByTime(14_999);
    expect(sink.of('heartbeat')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(15_000);
    const beats = sink.of('heartbeat').map((frame) => TerminalEventSchemas.heartbeat.parse(frame.data));
    expect(beats).toHaveLength(2);
    expect(beats[0]?.serverTime).toBe('2026-10-11T14:05:22.000Z');
    expect(beats[1]?.serverTime).toBe('2026-10-11T14:05:37.000Z');
  });

  it('stops with the client', () => {
    const { events } = harness();
    const sink = new FakeSink();
    const handle = events.accept(sink, 'cred-1');
    handle?.close();
    vi.advanceTimersByTime(60_000);
    expect(sink.of('heartbeat')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the subscription exists only while a client is connected', () => {
  it('subscribes on the first client, once for many, and lets go with the last', () => {
    const { events, list, access } = harness();
    expect(list.listeners.size).toBe(0);
    expect(access.listeners.size).toBe(0);
    const a = events.accept(new FakeSink(), 'cred-1');
    const b = events.accept(new FakeSink(), 'cred-2');
    expect(list.listeners.size).toBe(1);
    expect(list.subscribed).toBe(1);
    expect(access.listeners.size).toBe(1);
    a?.close();
    expect(list.listeners.size).toBe(1);
    b?.close();
    expect(list.listeners.size).toBe(0);
    expect(access.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds no timer after the last client was destroyed by a stall', () => {
    const { events, list } = harness();
    const sink = new FakeSink();
    events.accept(sink, 'cred-1');
    sink.blocked = true;
    list.change([sessionInfo()]);
    vi.advanceTimersByTime(40_000);
    expect(sink.destroyed).toBe(1);
    expect(list.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a window that was waiting when the last client left', () => {
    const { events, list } = harness();
    const handle = events.accept(new FakeSink(), 'cred-1');
    list.change([sessionInfo()]);
    handle?.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('subscribes again for a client that comes later and starts from the current list', () => {
    const { events, list } = harness();
    events.accept(new FakeSink(), 'cred-1')?.close();
    list.sessions = [sessionInfo({ name: 'late-1' })];
    const sink = new FakeSink();
    events.accept(sink, 'cred-2');
    expect(list.listeners.size).toBe(1);
    expect(TerminalEventSchemas.sessions.parse(sink.of('sessions')[0]?.data).sessions[0]?.name).toBe('late-1');
  });
});

describe('revocation (TC-SEC-08)', () => {
  it('destroys the streams of the revoked credential and no other', () => {
    const { events, access } = harness();
    const mine = new FakeSink();
    const mine2 = new FakeSink();
    const other = new FakeSink();
    events.accept(mine, 'cred-1');
    events.accept(mine2, 'cred-1');
    events.accept(other, 'cred-2');
    access.revoke('cred-1');
    expect(mine.destroyed).toBe(1);
    expect(mine2.destroyed).toBe(1);
    expect(other.destroyed).toBe(0);
    expect(events.size).toBe(1);
    access.revoke('unknown');
    expect(events.size).toBe(1);
  });
});

describe('the cap of streams', () => {
  it('refuses the ninth stream without writing a byte, and takes it again when one left', () => {
    const { events } = harness();
    const handles = Array.from({ length: 8 }, (_, i) => events.accept(new FakeSink(), `cred-${String(i)}`));
    expect(handles.every((handle) => handle !== null)).toBe(true);
    expect(events.hasCapacity()).toBe(false);
    const ninth = new FakeSink();
    expect(events.accept(ninth, 'cred-9')).toBeNull();
    expect(ninth.chunks).toEqual([]);
    handles[0]?.close();
    expect(events.hasCapacity()).toBe(true);
    expect(events.accept(new FakeSink(), 'cred-9')).not.toBeNull();
  });

  it('closeAll destroys every client and releases the subscriptions', () => {
    const { events, list } = harness();
    const sinks = [new FakeSink(), new FakeSink()];
    for (const sink of sinks) events.accept(sink, 'cred-1');
    events.closeAll();
    expect(sinks.map((s) => s.destroyed)).toEqual([1, 1]);
    expect(events.size).toBe(0);
    expect(list.listeners.size).toBe(0);
  });
});

describe('what the log may say (rule 7)', () => {
  it('logs counts and reasons only: never a session name, a folder or a credential', () => {
    const { events, list, logs, access } = harness();
    list.sessions = [sessionInfo({ name: 'secret-name-1', path: 'C:\\secret\\folder' })];
    const stuck = new FakeSink();
    events.accept(stuck, 'credential-secret');
    stuck.blocked = true;
    list.change([sessionInfo({ name: 'secret-name-2', path: 'C:\\secret\\other' })]);
    vi.advanceTimersByTime(40_000);
    const revoked = new FakeSink();
    events.accept(revoked, 'credential-secret');
    access.revoke('credential-secret');
    expect(logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs);
    expect(text).not.toContain('secret');
  });
});
