// The pure parts of the server boot (01 4.1, 4.4, 4.11): the argv contract, the exit codes and the mapping of failures to them,
// the build stamp check, and the port scan. The boot itself, with a real workspace and database, is in test/boot.int.test.ts.
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';

import { DbError } from '@mcs/engine';
import { McsError, RUNTIME_VERSION } from '@mcs/shared';
import { allocatePort, assertPortClosed, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BIND_HOST,
  SERVER_EXIT_CODES,
  bindFirstFreePort,
  exitCodeOfError,
  exitNameOf,
  parseServeArgv,
  readBuildStamp,
  scanPorts,
  serveMain,
} from './boot.ts';

const makeTemp = useTempDirs();
const ID = 'abcdef01-abcd-4bcd-8bcd-abcdef012345';
const DIR = path.resolve('some', 'workspace');

describe('server exit codes (01 4.1, registry 7.3)', () => {
  it('has exactly the documented table', () => {
    expect(SERVER_EXIT_CODES).toEqual({
      OK: 0,
      CONFIG_INVALID: 10,
      IDENTITY_MISMATCH: 11,
      INSTANCE_LOCKED: 12,
      PORT_EXHAUSTED: 13,
      DB_ERROR: 14,
      DB_NEWER_THAN_RUNTIME: 15,
      DB_UPGRADE_REQUIRED: 16,
      WORKSPACE_INVALID: 17,
      BUILD_INVALID: 18,
      INTERNAL: 70,
    });
  });

  it('never uses 1, which is what Windows reports for a forced termination', () => {
    expect(Object.values(SERVER_EXIT_CODES)).not.toContain(1);
  });

  it('names a code, and says INTERNAL for one it does not know', () => {
    expect(exitNameOf(13)).toBe('PORT_EXHAUSTED');
    expect(exitNameOf(0)).toBe('OK');
    expect(exitNameOf(99)).toBe('INTERNAL');
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
