// The pure parts of the server boot (01 4.1, 4.4, 4.11): the argv contract, the exit codes and the mapping of failures to them,
// the build stamp check, and the port scan. The boot itself, with a real workspace and database, is in test/boot.int.test.ts.
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';

import {
  DbError,
  EMPTY_CENSUS,
  EMPTY_USER_SERVICES,
  SpoolSegmentNotFoundError,
  execFileText,
  userRootOf,
  type ChildLogEntry,
  type ChildSpec,
  type TerminalCensus,
  type UserServices,
} from '@mcs/engine';
import { McsError, RUNTIME_VERSION, SERVER_EXIT_CODES as SharedExitCodes, serverExitNameOf } from '@mcs/shared';
import { CONTROL_TERMINAL_SESSIONS_MAX } from '@mcs/shared/protocol';
import { allocatePort, assertPortClosed, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  BIND_HOST,
  SERVER_EXIT_CODES,
  answerShutdown,
  assertUserLocation,
  bindFirstFreePort,
  censusOf,
  exitCodeOfError,
  exitNameOf,
  ingestReplayOutcome,
  mintOutcome,
  parseServeArgv,
  readBuildStamp,
  scanPorts,
  serveMain,
  terminalsOutcome,
  wireChildLog,
  type ShutdownWiring,
} from './boot.ts';
import type { ShutdownReason } from './shutdown.ts';

const makeTemp = useTempDirs();
const ID = 'abcdef01-abcd-4bcd-8bcd-abcdef012345';
const DIR = path.resolve('some', 'workspace');

describe('server exit codes (01 4.1, registry 7.3)', () => {
  // the table and its names are tested once, in packages/shared/src/server-exit.test.ts; this is the wrapper's consistency check
  it('re-exports the shared table and names a code, with INTERNAL for one it does not know', () => {
    expect(SERVER_EXIT_CODES).toBe(SharedExitCodes);
    expect(exitNameOf(13)).toBe(serverExitNameOf(13));
    expect(exitNameOf(0)).toBe('OK');
    expect(exitNameOf(99)).toBe('INTERNAL');
    expect(serverExitNameOf(99)).toBeNull();
  });
});

describe('exitCodeOfError', () => {
  const table: readonly (readonly [McsError['code'], number])[] = [
    ['CONFIG_INVALID', 10],
    ['CONFIG_SCHEMA_MISSING', 10],
    ['CONFIG_SCHEMA_UNSUPPORTED', 10],
    ['CONFIG_UNREADABLE', 10],
    ['REGEX_UNSUPPORTED', 10],
    ['IDENTITY_MISMATCH', 11],
    ['PORT_EXHAUSTED', 13],
    ['DB_ERROR', 14],
    ['DB_NEWER_THAN_RUNTIME', 15],
    ['DB_UPGRADE_REQUIRED', 16],
    ['WORKSPACE_INVALID', 17],
    ['SLUG_INVALID', 17],
    ['WORKSPACE_ESCAPE', 17],
    ['WORKSPACE_SYMLINK', 17],
    ['TASK_NOT_FOUND', 17],
    ['INSTANCE_NOT_INITIALIZED', 17],
    ['USAGE', 17],
    ['INTERNAL', 70],
    ['START_FAILED', 70],
  ];

  it.each(table)('maps the CLI error code %s to exit %i', (code, exit) => {
    expect(exitCodeOfError(new McsError(code, 'x'))).toBe(exit);
  });

  it('maps a database error to the exit code of its open failure (03 3.2)', () => {
    expect(exitCodeOfError(new DbError('db_identity_mismatch', 'x'))).toBe(11);
    expect(exitCodeOfError(new DbError('db_newer_than_runtime', 'x'))).toBe(15);
    expect(exitCodeOfError(new DbError('db_migration_required', 'x'))).toBe(16);
    expect(exitCodeOfError(new DbError('db_corrupt', 'x'))).toBe(14);
  });

  it('maps anything else to INTERNAL (70)', () => {
    expect(exitCodeOfError(new Error('boom'))).toBe(70);
    expect(exitCodeOfError('text')).toBe(70);
    expect(exitCodeOfError(null)).toBe(70);
  });
});

describe('parseServeArgv (01 4.1)', () => {
  it('accepts the documented command line', () => {
    expect(parseServeArgv(['serve', `--mcs-instance=${ID}`, `--instance-dir=${DIR}`])).toEqual({
      ok: true,
      args: { instanceId: ID, instanceDir: DIR },
    });
    expect(
      parseServeArgv(['serve', `--mcs-instance=${ID}`, `--instance-dir=${DIR}`, '--port=18123', '--log-level=debug']),
    ).toEqual({ ok: true, args: { instanceId: ID, instanceDir: DIR, port: 18123, logLevel: 'debug' } });
  });

  it('keeps a directory with spaces and equals signs whole, and takes --port=0 as not given (legacy)', () => {
    const odd = path.resolve('with space', 'a=b');
    expect(parseServeArgv(['serve', `--mcs-instance=${ID}`, `--instance-dir=${odd}`, '--port=0'])).toEqual({
      ok: true,
      args: { instanceId: ID, instanceDir: odd },
    });
  });

  it('refuses a bad command line with a message and no exception', () => {
    const good = [`--mcs-instance=${ID}`, `--instance-dir=${DIR}`];
    const bad: readonly (readonly string[])[] = [
      [],
      ['start', ...good],
      ['serve'],
      ['serve', `--instance-dir=${DIR}`],
      ['serve', `--mcs-instance=${ID}`],
      ['serve', '--mcs-instance=not-a-uuid', `--instance-dir=${DIR}`],
      ['serve', `--mcs-instance=${ID.toUpperCase()}`, `--instance-dir=${DIR}`],
      ['serve', `--mcs-instance=${ID}`, '--instance-dir=relative/dir'],
      ['serve', `--mcs-instance=${ID}`, '--instance-dir='],
      ['serve', ...good, '--port=abc'],
      ['serve', ...good, '--port=65536'],
      ['serve', ...good, '--port=-1'],
      ['serve', ...good, '--port=18000.5'],
      ['serve', ...good, '--log-level=loud'],
      ['serve', ...good, '--bind-host=0.0.0.0'],
      ['serve', ...good, '--port=18000', '--port=18001'],
      ['serve', ...good, 'extra'],
      ['serve', `--mcs-instance ${ID}`, `--instance-dir=${DIR}`],
      ['serve', `--mcs-instance=${ID}\0`, `--instance-dir=${DIR}`],
    ];
    for (const argv of bad) {
      const parsed = parseServeArgv(argv);
      expect(parsed.ok, JSON.stringify(argv)).toBe(false);
      if (!parsed.ok) {
        expect(parsed.message.length).toBeGreaterThan(0);
        expect(parsed.message).not.toContain('\n');
      }
    }
  });

  it('has no option for the bind host: 127.0.0.1 only (01 8.2)', () => {
    expect(BIND_HOST).toBe('127.0.0.1');
  });
});

describe('readBuildStamp (01 4.4 step 6)', () => {
  const stamp = {
    schemaVersion: 1,
    runtimeVersion: RUNTIME_VERSION,
    buildStamp: 'f'.repeat(64),
    codeStamp: 'abcdef0123',
  };

  async function readWith(content: string | null): Promise<Awaited<ReturnType<typeof readBuildStamp>>> {
    const dir = makeTemp('stamp').path;
    if (content !== null) writeFileSync(path.join(dir, '.mcs-build.json'), content);
    return readBuildStamp(dir);
  }

  it('reads the version and the code stamp of a good file', async () => {
    expect(await readWith(JSON.stringify(stamp))).toEqual({
      ok: true,
      stamp: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    });
  });

  it('fails BUILD_INVALID for a missing file, bad JSON, a bad shape, a bad code stamp and a version of another runtime', async () => {
    const cases: readonly (string | null)[] = [
      null,
      '',
      '{',
      '[]',
      JSON.stringify({ ...stamp, codeStamp: 'XYZ' }),
      JSON.stringify({ ...stamp, codeStamp: 'abcdef012' }),
      JSON.stringify({ runtimeVersion: RUNTIME_VERSION }),
      JSON.stringify({ ...stamp, runtimeVersion: '2.9.9' }),
      JSON.stringify({ ...stamp, runtimeVersion: 3 }),
    ];
    for (const content of cases) {
      const result = await readWith(content);
      expect(result.ok, String(content)).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/\.mcs-build\.json|build/i);
    }
  });
});

describe('bindFirstFreePort (01 4.11)', () => {
  const held: Server[] = [];
  const ports: number[] = [];
  afterEach(async () => {
    await Promise.all(held.splice(0).map(closeServer));
    for (const port of ports.splice(0)) await assertPortClosed(port);
  });

  function closeServer(server: Server): Promise<void> {
    return new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  function listenOn(port: number): Promise<Server> {
    const server = createServer();
    return new Promise<Server>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, host: BIND_HOST }, () => {
        resolve(server);
      });
    });
  }

  /**
   * `count` neighbouring ports, all taken by this test (index 0 is the base). Holding them, not probing them, leaves no
   * moment in which another test worker could take one; the caller closes the ones the scan should find free.
   */
  async function reserveRun(count: number): Promise<{ base: number; servers: Server[] }> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const base = await allocatePort();
      ports.push(base);
      const servers: Server[] = [];
      try {
        for (let offset = 0; offset < count; offset += 1) servers.push(await listenOn(base + offset));
        held.push(...servers);
        return { base, servers };
      } catch {
        await Promise.all(servers.map(closeServer));
      }
    }
    throw new Error('no run of free neighbouring ports in the test range');
  }

  /** Frees the port at `index` of a run again. */
  async function release(run: { servers: Server[] }, index: number): Promise<void> {
    const server = run.servers[index];
    if (server === undefined) throw new Error('no such port in the run');
    held.splice(held.indexOf(server), 1);
    await closeServer(server);
  }

  it('binds the base port when it is free, on 127.0.0.1 only', async () => {
    const run = await reserveRun(1);
    await release(run, 0);
    const server = createServer();
    held.push(server);
    expect(await bindFirstFreePort(server, run.base, 3)).toEqual({ ok: true, port: run.base });
    expect(server.address()).toMatchObject({ address: '127.0.0.1', port: run.base });
  });

  it('skips ports that are taken and binds the next free one within base..base+scan', async () => {
    const run = await reserveRun(3);
    await release(run, 2);
    const server = createServer();
    held.push(server);
    expect(await bindFirstFreePort(server, run.base, 3)).toEqual({ ok: true, port: run.base + 2 });
  });

  it('is exhausted, with the scanned range in the message, when every port of base..base+scan is taken', async () => {
    const run = await reserveRun(3);
    await release(run, 2);
    const server = createServer();
    const result = await bindFirstFreePort(server, run.base, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(String(run.base));
      expect(result.message).toContain(String(run.base + 1));
    }
    expect(server.listening).toBe(false);
  });

  it('scans only the base port when the scan is 0', async () => {
    const run = await reserveRun(2);
    await release(run, 1);
    const server = createServer();
    expect((await bindFirstFreePort(server, run.base, 0)).ok).toBe(false);
    expect(server.listening).toBe(false);
  });

  it('lists the candidates base..base+scan in order and stops at 65535', () => {
    expect(scanPorts(18000, 19)).toEqual(Array.from({ length: 20 }, (_unused, index) => 18000 + index));
    expect(scanPorts(18000, 0)).toEqual([18000]);
    expect(scanPorts(65534, 5)).toEqual([65534, 65535]);
    expect(scanPorts(65535, 99)).toEqual([65535]);
  });

  it('fails with the error code, and does not scan on, for an error that is not "address in use"', async () => {
    const server = createServer();
    const listen = vi.spyOn(server, 'listen');
    const result = await bindFirstFreePort(server, 18000, 5, '203.0.113.1');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toMatch(/EADDRNOTAVAIL|EINVAL/);
    expect(listen).toHaveBeenCalledTimes(1);
  });
});

describe('ingestReplayOutcome (01 4.3, 02 2.7)', () => {
  it('answers the segment count of the replay', async () => {
    const warn = vi.fn();
    const replay = vi.fn(() => Promise.resolve({ segments: 3 }));
    expect(await ingestReplayOutcome({ ingestReplay: replay }, 'hooks-20261012T08Z.ndjson', warn)).toEqual({
      ok: true,
      segments: 3,
    });
    expect(replay).toHaveBeenCalledWith('hooks-20261012T08Z.ndjson');
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers NOT_READY while the runtime does not exist yet', async () => {
    expect(await ingestReplayOutcome(undefined, null, vi.fn())).toEqual({ ok: false, error: 'NOT_READY' });
  });

  it('answers BAD_REQUEST for a segment that is not on disk, without a warning', async () => {
    const warn = vi.fn();
    const runtime = { ingestReplay: () => Promise.reject(new SpoolSegmentNotFoundError('hooks-20261012T08Z.ndjson')) };
    expect(await ingestReplayOutcome(runtime, 'hooks-20261012T08Z.ndjson', warn)).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers NOT_READY for any other error and logs its code only, never its message', async () => {
    const warn = vi.fn();
    const failure = Object.assign(new Error('cannot open /secret/place/hooks.ndjson'), { code: 'WRITER_CLOSED' });
    expect(await ingestReplayOutcome({ ingestReplay: () => Promise.reject(failure) }, null, warn)).toEqual({
      ok: false,
      error: 'NOT_READY',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('ingest_replay_failed', { code: 'WRITER_CLOSED' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    warn.mockClear();
    await ingestReplayOutcome({ ingestReplay: () => Promise.reject(new Error('plain')) }, null, warn);
    expect(warn).toHaveBeenCalledWith('ingest_replay_failed', { code: 'INTERNAL' });
  });
});

describe('assertUserLocation (06 1.3, ADR 0091 item 5)', () => {
  function env(): Record<string, string> {
    return { MCS_HOME: makeTemp('user-home').path };
  }

  it('accepts a user instance in the reserved user root', () => {
    const e = env();
    expect(() => {
      assertUserLocation('user', userRootOf(e), e);
    }).not.toThrow();
  });

  it('refuses a user instance anywhere else with WORKSPACE_INVALID (exit 17), naming no path', () => {
    const e = env();
    const elsewhere = path.join(makeTemp('some-repo').path, '.claude', 'monitor', 'tasks');
    let failure: unknown;
    try {
      assertUserLocation('user', elsewhere, e);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(McsError);
    expect(failure).toMatchObject({ code: 'WORKSPACE_INVALID' });
    expect(exitCodeOfError(failure)).toBe(17);
    expect((failure as McsError).message).not.toContain(elsewhere);
    expect((failure as McsError).message).not.toContain(e['MCS_HOME'] ?? 'unreachable');
  });

  it('refuses the user root of another MCS home, and a folder that only looks like it', () => {
    const e = env();
    const other = { MCS_HOME: makeTemp('other-home').path };
    expect(() => {
      assertUserLocation('user', userRootOf(other), e);
    }).toThrow(expect.objectContaining({ code: 'WORKSPACE_INVALID' }));
    expect(() => {
      assertUserLocation('user', path.join(userRootOf(e), 'user'), e);
    }).toThrow(expect.objectContaining({ code: 'WORKSPACE_INVALID' }));
  });

  it('leaves a task alone wherever it is, and does not read the home of a task', () => {
    const e = env();
    expect(() => {
      assertUserLocation('task', makeTemp('some-repo').path, e);
      assertUserLocation('task', userRootOf(e), e);
      assertUserLocation('task', makeTemp('no-home').path, {});
    }).not.toThrow();
  });

  it('is CONFIG_INVALID (exit 10) when the home of a user instance cannot be found', () => {
    let failure: unknown;
    try {
      assertUserLocation('user', makeTemp('some-repo').path, {});
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(exitCodeOfError(failure)).toBe(10);
  });
});

describe('the services behind the control channel are late-bound (06 1.7, 1.8)', () => {
  const MINT = { code: `Zq8-test_only_code-${'k'.repeat(24)}`, expiresAtMs: 1_800_000_000_000, ttlSeconds: 120 };
  const census: TerminalCensus = {
    count: () => 3,
    sessions: (limit) => [{ name: 'api-1', startedAt: '2026-11-15T10:00:00.000Z' }].slice(0, limit),
    beginDrain: () => undefined,
  };

  it('uses the empty census and no minter while there is no runtime, and for a task instance', () => {
    for (const runtime of [undefined, { user: null }, { user: EMPTY_USER_SERVICES }]) {
      expect(censusOf(runtime)).toBe(EMPTY_CENSUS);
      expect(mintOutcome(runtime)).toBeNull();
    }
  });

  it('reads the census and the minter of the user services at the time of the request', () => {
    const minter = { mint: vi.fn(() => MINT) };
    const runtime: { user: UserServices | null } = { user: null };
    expect(censusOf(runtime)).toBe(EMPTY_CENSUS);
    runtime.user = { census, access: minter, components: [] };
    expect(censusOf(runtime)).toBe(census);
    expect(mintOutcome(runtime)).toBe(MINT);
    expect(mintOutcome(runtime)).toBe(MINT);
    expect(minter.mint).toHaveBeenCalledTimes(2);
  });
});

describe('terminalsOutcome (06 1.8, A4)', () => {
  it('reports the count of starting, live and lost sessions, the limit and the sessions the census lists', () => {
    const sessions = vi.fn((limit: number) =>
      [{ name: 'api-1', startedAt: '2026-11-15T10:00:00.000Z' }].slice(0, limit),
    );
    const census: TerminalCensus = { count: () => 3, sessions, beginDrain: () => undefined };
    expect(terminalsOutcome(census, 8)).toEqual({
      live: 3,
      max: 8,
      sessions: [{ name: 'api-1', startedAt: '2026-11-15T10:00:00.000Z' }],
    });
    expect(sessions).toHaveBeenCalledWith(CONTROL_TERMINAL_SESSIONS_MAX);
  });

  it('is an empty census for the empty census', () => {
    expect(terminalsOutcome(EMPTY_CENSUS, 0)).toEqual({ live: 0, max: 0, sessions: [] });
  });
});

describe('answerShutdown: the server decides, and the drain starts on the allow decision only (06 3.2, A4)', () => {
  /** A census whose members are properties, so that the spies can be read without a method leaving its object. */
  interface RigCensus {
    readonly count: Mock<() => number>;
    readonly sessions: () => readonly never[];
    readonly beginDrain: Mock<() => void>;
  }

  interface Rig {
    readonly census: RigCensus;
    readonly order: string[];
    readonly trigger: ReturnType<typeof vi.fn<(reason: ShutdownReason) => void>>;
    readonly warn: ReturnType<typeof vi.fn<(event: string, fields: Readonly<Record<string, unknown>>) => void>>;
    readonly wiring: ShutdownWiring;
    stopping: boolean;
  }

  function rig(count: number, kind: 'task' | 'user' = 'user'): Rig {
    const order: string[] = [];
    const census: RigCensus = {
      count: vi.fn(() => count),
      sessions: () => [],
      beginDrain: vi.fn(() => {
        order.push('beginDrain');
      }),
    };
    const trigger = vi.fn((reason: ShutdownReason) => {
      order.push(`trigger:${reason}`);
    });
    const warn = vi.fn();
    const state = { stopping: false };
    const wiring: ShutdownWiring = {
      kind,
      census: () => census,
      stopping: () => state.stopping,
      trigger,
      warn,
    };
    return {
      census,
      order,
      trigger,
      warn,
      wiring,
      get stopping() {
        return state.stopping;
      },
      set stopping(value: boolean) {
        state.stopping = value;
      },
    };
  }

  it('answers TERMINALS_LIVE for live terminals, and neither starts the drain nor triggers the shutdown', () => {
    const r = rig(2);
    expect(answerShutdown(r.wiring, 'stop', false)).toEqual({ ok: false, error: 'TERMINALS_LIVE' });
    expect(r.census.beginDrain).not.toHaveBeenCalled();
    expect(r.trigger).not.toHaveBeenCalled();
    expect(r.order).toEqual([]);
  });

  it('counts a starting and a lost session: the census count decides, whatever the list shows', () => {
    const r = rig(1); // one session that is starting or lost: `sessions()` is empty, `count()` is 1
    expect(answerShutdown(r.wiring, 'restart', false)).toEqual({ ok: false, error: 'TERMINALS_LIVE' });
    expect(r.trigger).not.toHaveBeenCalled();
  });

  it('starts the drain first and triggers the shutdown right after, in the same tick, when it allows', async () => {
    const r = rig(0);
    const answer = answerShutdown(r.wiring, 'stop', false);
    r.order.push('returned');
    expect(answer).toEqual({ ok: true });
    expect(r.order).toEqual(['beginDrain', 'trigger:stop', 'returned']);
    await Promise.resolve(); // nothing is deferred to a later turn
    expect(r.order).toEqual(['beginDrain', 'trigger:stop', 'returned']);
  });

  it('allows force over live terminals, with the drain and the trigger', () => {
    const r = rig(2);
    expect(answerShutdown(r.wiring, 'stop', true)).toEqual({ ok: true });
    expect(r.order).toEqual(['beginDrain', 'trigger:stop']);
  });

  it('never guards the reason signal', () => {
    const r = rig(5);
    expect(answerShutdown(r.wiring, 'signal', false)).toEqual({ ok: true });
    expect(r.order).toEqual(['beginDrain', 'trigger:signal']);
    expect(r.census.count).not.toHaveBeenCalled();
  });

  it('never guards a task instance', () => {
    const r = rig(5, 'task');
    expect(answerShutdown(r.wiring, 'stop', false)).toEqual({ ok: true });
    expect(r.trigger).toHaveBeenCalledWith('stop');
  });

  it('lets a request through while the instance is already stopping, without a second drain', () => {
    const r = rig(2);
    r.stopping = true;
    expect(answerShutdown(r.wiring, 'stop', false)).toEqual({ ok: true });
    expect(r.census.beginDrain).not.toHaveBeenCalled();
    expect(r.trigger).toHaveBeenCalledTimes(1);
  });

  it('still triggers the shutdown when the drain fails, and logs that by phase, never by message', () => {
    const r = rig(0);
    r.census.beginDrain.mockImplementation(() => {
      throw new Error('drain failed at /secret/place');
    });
    expect(answerShutdown(r.wiring, 'stop', false)).toEqual({ ok: true });
    expect(r.trigger).toHaveBeenCalledWith('stop');
    expect(r.warn).toHaveBeenCalledTimes(1);
    expect(r.warn).toHaveBeenCalledWith('terminal_drain_failed', { phase: 'shutdown' });
    expect(JSON.stringify(r.warn.mock.calls)).not.toContain('secret');
  });

  it('reads the census when the request arrives: terminals that appear after the boot are seen', () => {
    let live = 0;
    const census: TerminalCensus = { count: () => live, sessions: () => [], beginDrain: () => undefined };
    const wiring: ShutdownWiring = {
      kind: 'user',
      census: () => census,
      stopping: () => false,
      trigger: () => undefined,
      warn: () => undefined,
    };
    live = 1;
    expect(answerShutdown(wiring, 'stop', false)).toEqual({ ok: false, error: 'TERMINALS_LIVE' });
    live = 0;
    expect(answerShutdown(wiring, 'stop', false)).toEqual({ ok: true });
  });
});

const NODE_CHILD: ChildSpec = {
  kind: 'node',
  file: process.execPath,
  args: ['-e', '0'],
  timeoutMs: 20_000,
  maxOutputBytes: 1_048_576,
  encoding: 'utf8',
};

describe('wireChildLog (06 3.6 rule 9, CR-WP-16-3)', () => {
  function harness(): {
    readonly lines: { event: string; fields: Readonly<Record<string, unknown>> | undefined }[];
    readonly sinks: (((entry: ChildLogEntry) => void) | null)[];
    readonly setSink: (sink: ((entry: ChildLogEntry) => void) | null) => void;
    readonly logger: { debug: (event: string, fields?: Readonly<Record<string, unknown>>) => void };
  } {
    const lines: { event: string; fields: Readonly<Record<string, unknown>> | undefined }[] = [];
    const sinks: (((entry: ChildLogEntry) => void) | null)[] = [];
    return {
      lines,
      sinks,
      setSink: (sink) => {
        sinks.push(sink);
      },
      logger: {
        debug: (event, fields) => {
          lines.push({ event, fields });
        },
      },
    };
  }

  it('logs child_run at debug with the kind, the duration and the numeric exit code, and nothing else', () => {
    const h = harness();
    wireChildLog(h.logger, h.setSink);
    const sink = h.sinks[0];
    expect(sink).toBeTypeOf('function');
    sink?.({ kind: 'git', durationMs: 12, code: 0, error: null });
    expect(h.lines).toEqual([{ event: 'child_run', fields: { kind: 'git', durationMs: 12, code: 0 } }]);
  });

  it('leaves the code out when the child did not exit with one, and never logs the error text', () => {
    const h = harness();
    wireChildLog(h.logger, h.setSink);
    h.sinks[0]?.({ kind: 'powershell.processes', durationMs: 30_000, code: null, error: 'TIMEOUT' });
    expect(h.lines).toEqual([{ event: 'child_run', fields: { kind: 'powershell.processes', durationMs: 30_000 } }]);
    expect(JSON.stringify(h.lines)).not.toContain('TIMEOUT');
  });

  it('wires once and undoes itself: the undo clears the sink, and a second undo does nothing', () => {
    const h = harness();
    const undo = wireChildLog(h.logger, h.setSink);
    expect(h.sinks).toHaveLength(1);
    undo();
    expect(h.sinks).toHaveLength(2);
    expect(h.sinks[1]).toBeNull();
    undo();
    expect(h.sinks).toHaveLength(2);
  });

  it('is wired to the real process-wide sink by default and cleared by the undo', async () => {
    const h = harness();
    const undo = wireChildLog(h.logger);
    try {
      const result = await execFileText(NODE_CHILD);
      expect(result.ok).toBe(true);
      expect(h.lines.map((line) => line.event)).toEqual(['child_run']);
      expect(h.lines[0]?.fields).toMatchObject({ kind: 'node', code: 0 });
    } finally {
      undo();
    }
    await execFileText(NODE_CHILD);
    expect(h.lines).toHaveLength(1);
  });
});

describe('serveMain', () => {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const;
  const fatal = ['uncaughtException', 'unhandledRejection'] as const;

  it('answers the exit code of a failed boot, prints it on stderr, and leaves no signal or error handler behind', async () => {
    const before = [...signals, ...fatal].map((name) => process.listenerCount(name));
    const stderr: string[] = [];
    const code = await serveMain({
      argv: ['serve'],
      env: {},
      runtimeDir: makeTemp('serve-main').path,
      stderr: (text) => stderr.push(text),
    });
    expect(code).toBe(17);
    expect(stderr.join('')).toContain('WORKSPACE_INVALID (17)');
    expect([...signals, ...fatal].map((name) => process.listenerCount(name))).toEqual(before);
  });
});
