// The server boot on a real workspace, a real database, real named pipes and real sockets (01 4.4, 4.11, 4.13):
// T-LC-03 (every boot exit code, crafted), the happy path (127.0.0.1 only, token and state after the bind, port scan),
// T-LC-14 boot part (a killed server leaves state.json behind; the next boot says so and the database is intact), and the
// command line of the real entry. The database is the real one: it is created by the first boot.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { defaultSkillDir, initWorkspace, openInstanceDb, openSqlite, pragmaValue } from '@mcs/engine';
import { RUNTIME_VERSION, StateFileSchema } from '@mcs/shared';
import {
  allocatePort,
  assertPortClosed,
  hermeticEnv,
  httpRequest,
  killAllTracked,
  makeJunction,
  spawnTracked,
  useTempDirs,
  waitFor,
} from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { bootServer, type BootInput, type BootResult, type RunningServer } from '../src/boot.ts';
import { controlAddress, requestControl } from '../src/control-channel.ts';

const makeTemp = useTempDirs();
const REAL_BOOT = fileURLToPath(new URL('../dist/boot.js', import.meta.url));
const REAL_MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const STAMP = {
  schemaVersion: 1,
  runtimeVersion: RUNTIME_VERSION,
  buildStamp: 'f'.repeat(64),
  codeStamp: 'abcdef0123',
  node: 'v24.0.0',
  builtAt: '2026-10-12T08:00:00.000Z',
};

interface Fixture {
  readonly root: string;
  readonly skillDir: string;
  readonly runtimeDir: string;
  readonly ws: string;
  readonly id: string;
  readonly env: Record<string, string>;
}

/** A skill folder (defaults and a build stamp), a repo with one initialised task, and a hermetic environment. */
async function fixture(
  o: { runtime?: Record<string, unknown>; stamp?: Record<string, unknown> | null } = {},
): Promise<Fixture> {
  const root = makeTemp('serve-boot').path;
  const skillDir = path.join(root, 'skill');
  const runtimeDir = path.join(skillDir, 'runtime');
  mkdirSync(path.join(skillDir, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skillDir, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  if (o.stamp !== null) writeFileSync(path.join(runtimeDir, '.mcs-build.json'), JSON.stringify(o.stamp ?? STAMP));
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const id = randomUUID();
  const { ws } = await initWorkspace({
    repo,
    name: 'Demo',
    slug: 'demo',
    description: 'A synthetic task.',
    newId: () => id,
  });
  if (o.runtime !== undefined) {
    writeFileSync(path.join(ws.dir, 'runtime.json'), JSON.stringify({ schema_version: 1, ...o.runtime }));
  }
  return { root, skillDir, runtimeDir, ws: ws.dir, id, env: hermeticEnv(root) };
}

function argvOf(f: Fixture, port: number, extra: readonly string[] = []): string[] {
  return ['serve', `--mcs-instance=${f.id}`, `--instance-dir=${f.ws}`, `--port=${String(port)}`, ...extra];
}

const running: { server: RunningServer; port: number | null }[] = [];
const holders: Server[] = [];
afterEach(async () => {
  for (const { server } of running.splice(0)) {
    server.requestShutdown('stop');
    await server.closed;
  }
  for (const holder of holders.splice(0))
    await new Promise<void>((resolve) =>
      holder.close(() => {
        resolve();
      }),
    );
  await killAllTracked();
});

interface Boot {
  readonly result: BootResult;
  readonly stderr: string[];
}

async function boot(f: Fixture, port: number, over: Partial<BootInput> = {}): Promise<Boot> {
  const stderr: string[] = [];
  const result = await bootServer({
    argv: argvOf(f, port),
    env: f.env,
    runtimeDir: f.runtimeDir,
    stderr: (text) => stderr.push(text),
    ...over,
  });
  if (result.ok) running.push({ server: result.server, port: result.server.port });
  return { result, stderr };
}

async function booted(f: Fixture, port: number, over: Partial<BootInput> = {}): Promise<RunningServer> {
  const { result, stderr } = await boot(f, port, over);
  if (!result.ok) throw new Error(`boot failed with ${String(result.exitCode)}: ${result.message} ${stderr.join('')}`);
  return result.server;
}

async function occupy(port: number): Promise<void> {
  const holder = createServer();
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.listen({ port, host: '127.0.0.1' }, () => {
      resolve();
    });
  });
  holders.push(holder);
}

function failed(boot: Boot): { exitCode: number; message: string } {
  if (boot.result.ok) throw new Error('the boot was expected to fail');
  return { exitCode: boot.result.exitCode, message: boot.result.message };
}

/** Nobody answers on the control address any more. */
async function expectChannelFree(f: Fixture): Promise<void> {
  await expect(requestControl(controlAddress(f.id), { v: 1, op: 'identify' }, { timeoutMs: 1500 })).rejects.toThrow();
}

/** The first non-loopback IPv4 address of this machine, when it has one. */
const FOREIGN_ADDRESS = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;

/** `connected`, or the error code of a connection attempt. */
function connectOutcome(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code ?? 'error');
    });
  });
}

function exists(f: Fixture, ...segments: string[]): boolean {
  return existsSync(path.join(f.ws, ...segments));
}

function runtimeLog(f: Fixture): { event: string; level: string; [key: string]: unknown }[] {
  const file = path.join(f.ws, 'logs', 'runtime.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { event: string; level: string });
}

describe('T-LC-03: every boot failure has its exit code (01 4.1, 4.4)', () => {
  it('17: a bad command line is a one-line message and nothing is started', async () => {
    const f = await fixture();
    const outcome = failed(await boot(f, 0, { argv: ['serve', `--mcs-instance=${f.id}`] }));
    expect(outcome.exitCode).toBe(17);
    expect(outcome.message).toContain('--instance-dir');
    await expectChannelFree(f);
    expect(exists(f, 'state.json')).toBe(false);
    expect(existsSync(path.join(f.ws, 'logs', 'runtime.log'))).toBe(false);
  });

  it('17: a folder without instance.json (a legacy-only workspace, or no workspace at all) is WORKSPACE_INVALID', async () => {
    const f = await fixture();
    rmSync(path.join(f.ws, 'instance.json'));
    expect(failed(await boot(f, await allocatePort())).exitCode).toBe(17);
    const missing = path.join(path.dirname(f.ws), 'no-such-task');
    const outcome = failed(await boot(f, await allocatePort(), { argv: argvOf({ ...f, ws: missing }, 18999) }));
    expect(outcome.exitCode).toBe(17);
  });

  it('17: a task folder that is a link is refused (a workspace never follows links)', async () => {
    const f = await fixture();
    const link = path.join(path.dirname(f.ws), 'linked');
    makeJunction(link, f.ws);
    expect(failed(await boot(f, 18999, { argv: argvOf({ ...f, ws: link }, 18999) })).exitCode).toBe(17);
  });

  it('11: the instance id of the command line is not the one of instance.json', async () => {
    const f = await fixture();
    const outcome = failed(await boot(f, 18999, { argv: argvOf({ ...f, id: randomUUID() }, 18999) }));
    expect(outcome.exitCode).toBe(11);
    expect(outcome.message.toLowerCase()).toContain('instance');
    await expectChannelFree(f);
    expect(exists(f, 'data', 'monitor.db')).toBe(false);
  });

  it('11: task.json names another folder than the one the server is asked to serve', async () => {
    const f = await fixture();
    const taskFile = path.join(f.ws, 'task.json');
    const task = JSON.parse(readFileSync(taskFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(taskFile, JSON.stringify({ ...task, id: 'someone-else' }, null, 2));
    expect(failed(await boot(f, 18999)).exitCode).toBe(11);
  });

  it('11: the database belongs to another instance; it is never opened for writing or fixed', async () => {
    const f = await fixture();
    const dbFile = path.join(f.ws, 'data', 'monitor.db');
    openInstanceDb({
      path: dbFile,
      expectedInstanceId: randomUUID(),
      mode: 'serve',
      runtimeVersion: RUNTIME_VERSION,
    }).close();
    const before = readFileSync(dbFile);
    const outcome = failed(await boot(f, await allocatePort()));
    expect(outcome.exitCode).toBe(11);
    expect(Buffer.compare(readFileSync(dbFile), before)).toBe(0);
    await expectChannelFree(f);
  });

  it('12: another runtime holds the control channel: exit at once, and nothing of the instance is touched', async () => {
    const f = await fixture();
    const first = await booted(f, await allocatePort());
    const state = readFileSync(path.join(f.ws, 'state.json'));
    const token = readFileSync(path.join(f.ws, 'run', 'control.token'));
    const log = readFileSync(path.join(f.ws, 'logs', 'runtime.log'));
    const second = failed(await boot(f, await allocatePort()));
    expect(second.exitCode).toBe(12);
    expect(second.message).toMatch(/control|running|lock/i);
    expect(Buffer.compare(readFileSync(path.join(f.ws, 'state.json')), state)).toBe(0);
    expect(Buffer.compare(readFileSync(path.join(f.ws, 'run', 'control.token')), token)).toBe(0);
    expect(Buffer.compare(readFileSync(path.join(f.ws, 'logs', 'runtime.log')), log)).toBe(0);
    // the first runtime did not notice
    expect(await requestControl(controlAddress(f.id), { v: 1, op: 'identify' })).toMatchObject({
      ok: true,
      pid: process.pid,
      phase: 'ready',
    });
    expect(first.port).not.toBeNull();
  });

  it('12: two boots that start together: exactly one runs and the other exits 12 (the OS decides, not a pre-check)', async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([boot(f, await allocatePort()), boot(f, await allocatePort())]);
    const outcomes = [first, second].map((boot) => (boot.result.ok ? 0 : boot.result.exitCode));
    expect(outcomes.sort()).toEqual([0, 12]);
  });

  it('13: no free port in base..base+portScan: the ports stay as they were, and no state or token is written', async () => {
    const f = await fixture({ runtime: { server: { portScan: 0 } } });
    const base = await allocatePort();
    await occupy(base);
    const outcome = failed(await boot(f, base));
    expect(outcome.exitCode).toBe(13);
    expect(outcome.message).toContain(String(base));
    expect(exists(f, 'state.json')).toBe(false);
    expect(exists(f, 'run', 'control.token')).toBe(false);
    await expectChannelFree(f);
    // the failed boot released the database: the next boot, on a free port, works
    const next = await allocatePort();
    expect((await booted(f, next)).port).toBe(next);
  });

  it('14: a database that cannot be opened is DB_ERROR, and the database is not replaced', async () => {
    const f = await fixture();
    const dbFile = path.join(f.ws, 'data', 'monitor.db');
    writeFileSync(
      dbFile,
      'this is not a database, only text that is long enough to look like a damaged file '.repeat(20),
    );
    const before = readFileSync(dbFile);
    expect(failed(await boot(f, await allocatePort())).exitCode).toBe(14);
    expect(Buffer.compare(readFileSync(dbFile), before)).toBe(0);
  });

  it('15: a database from a newer runtime is refused untouched', async () => {
    const f = await fixture();
    const dbFile = path.join(f.ws, 'data', 'monitor.db');
    openInstanceDb({ path: dbFile, expectedInstanceId: f.id, mode: 'serve', runtimeVersion: RUNTIME_VERSION }).close();
    const raw = openSqlite(dbFile, { readonly: false, fileMustExist: true, timeoutMs: 2000 });
    raw.exec(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at, runtime_version, duration_ms) VALUES (99, 'future', '${'a'.repeat(64)}', 1, '9.9.9', 0)`,
    );
    raw.pragma('user_version = 99');
    raw.pragma('wal_checkpoint(TRUNCATE)');
    raw.close();
    expect(failed(await boot(f, await allocatePort())).exitCode).toBe(15);
    await expectChannelFree(f);
  });

  it('16: a database older than this runtime says to run the upgrade, and nothing is migrated', async () => {
    const f = await fixture();
    const dbFile = path.join(f.ws, 'data', 'monitor.db');
    openInstanceDb({ path: dbFile, expectedInstanceId: f.id, mode: 'serve', runtimeVersion: RUNTIME_VERSION }).close();
    const raw = openSqlite(dbFile, { readonly: false, fileMustExist: true, timeoutMs: 2000 });
    raw.exec('DELETE FROM schema_migrations');
    raw.pragma('user_version = 0');
    raw.pragma('wal_checkpoint(TRUNCATE)');
    raw.close();
    const outcome = failed(await boot(f, await allocatePort()));
    expect(outcome.exitCode).toBe(16);
    expect(outcome.message.toLowerCase()).toMatch(/upgrade|older/);
    const check = openSqlite(dbFile, { readonly: true, fileMustExist: true, timeoutMs: 2000 });
    expect(check.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 0 });
    check.close();
  });

  it('18: a missing build stamp, a damaged one, and a stamp of another runtime version', async () => {
    for (const stamp of [null, { ...STAMP, runtimeVersion: '2.0.0' }]) {
      const f = await fixture({ stamp });
      const outcome = failed(await boot(f, await allocatePort()));
      expect(outcome.exitCode).toBe(18);
      expect(outcome.message).toContain('.mcs-build.json');
      await expectChannelFree(f);
      expect(exists(f, 'data', 'monitor.db')).toBe(false);
    }
    const damaged = await fixture();
    writeFileSync(path.join(damaged.runtimeDir, '.mcs-build.json'), '{ not json');
    expect(failed(await boot(damaged, await allocatePort())).exitCode).toBe(18);
  });

  it('10: a configuration that does not validate, with the reason on stderr and nothing started', async () => {
    const f = await fixture({ runtime: { server: { portScan: 1000 } } });
    const outcome = failed(await boot(f, await allocatePort()));
    expect(outcome.exitCode).toBe(10);
    expect(outcome.message).toMatch(/portScan|server/);
    await expectChannelFree(f);
    expect(exists(f, 'state.json')).toBe(false);
  });

  it('70: a failure while the runtime is created cleans up: no state, no token, no channel, the database is free', async () => {
    const f = await fixture();
    const outcome = failed(
      await boot(f, await allocatePort(), {
        factories: {
          createIngestService: () => {
            throw new Error('the ingest service could not be created');
          },
        },
      }),
    );
    expect(outcome.exitCode).toBe(70);
    await expectChannelFree(f);
    expect(exists(f, 'state.json')).toBe(false);
    expect(exists(f, 'run', 'control.token')).toBe(false);
    openInstanceDb({
      path: path.join(f.ws, 'data', 'monitor.db'),
      expectedInstanceId: f.id,
      mode: 'maintenance',
      runtimeVersion: RUNTIME_VERSION,
    }).close();
  });

  it('70: a component that fails to start stops the ones that started, and takes back state.json and the token', async () => {
    const f = await fixture();
    const stops: string[] = [];
    const outcome = failed(
      await boot(f, await allocatePort(), {
        factories: {
          createLifecycleSweeper: () => ({
            start: () => undefined,
            stop: () => {
              stops.push('sweeper');
              return Promise.resolve();
            },
            tickNow: () => Promise.resolve(),
          }),
          createDbScheduler: () => ({
            start: () => {
              throw new Error('the scheduler could not start');
            },
            stop: () => Promise.resolve(),
          }),
        },
      }),
    );
    expect(outcome.exitCode).toBe(70);
    expect(stops).toEqual(['sweeper']);
    expect(exists(f, 'state.json')).toBe(false);
    expect(exists(f, 'run', 'control.token')).toBe(false);
    await expectChannelFree(f);
  });
});

describe('a booted server (01 4.4 steps 9-11, 4.11)', () => {
  it('serves on the bound port, writes the token and state.json after the bind, and says ready', async () => {
    const f = await fixture();
    const base = await allocatePort();
    const server = await booted(f, base);
    expect(server.port).toBe(base);
    expect(server.url).toBe(`http://127.0.0.1:${String(base)}`);

    const health = await httpRequest(base, '/api/v3/health');
    expect(health.status).toBe(200);
    expect((JSON.parse(health.body) as { instanceId: string }).instanceId).toBe(f.id);
    expect((await httpRequest(base, '/api/health')).status).toBe(200);

    const token = readFileSync(path.join(f.ws, 'run', 'control.token'), 'utf8');
    expect(token).toMatch(/^[0-9a-f]{64}\n$/);

    const state = StateFileSchema.parse(JSON.parse(readFileSync(path.join(f.ws, 'state.json'), 'utf8')));
    expect(state).toMatchObject({
      pid: process.pid,
      port: base,
      url: `http://127.0.0.1:${String(base)}`,
      engine: 'node',
      instanceId: f.id,
      codeStamp: 'abcdef0123',
      runtimeVersion: RUNTIME_VERSION,
      task: 'demo',
      config: null,
      control: controlAddress(f.id),
    });
    expect(Object.keys(JSON.parse(readFileSync(path.join(f.ws, 'state.json'), 'utf8')) as object).slice(0, 7)).toEqual([
      'pid',
      'url',
      'port',
      'started',
      'version',
      'task',
      'config',
    ]);

    expect(await requestControl(controlAddress(f.id), { v: 1, op: 'identify' })).toEqual({
      v: 1,
      ok: true,
      op: 'identify',
      instanceId: f.id,
      pid: process.pid,
      phase: 'ready',
      runtimeVersion: RUNTIME_VERSION,
      codeStamp: 'abcdef0123',
      port: base,
      url: `http://127.0.0.1:${String(base)}`,
      startedAt: state.startedAt,
    });
    expect(runtimeLog(f).some((line) => line.event === 'runtime_ready' && line['port'] === base)).toBe(true);
    expect(server.ctx.process.phase()).toBe('ready');
  });

  it('passes --port and --log-level on: the configured level decides what the log keeps', async () => {
    const f = await fixture();
    const port = await allocatePort();
    const server = await booted(f, port, { argv: argvOf(f, port, ['--log-level=debug']) });
    expect(server.ctx.config.runtime.logLevel).toBe('debug');
    expect((await httpRequest(port, '/api/health')).status).toBe(200);
    await waitFor(() => runtimeLog(f).some((line) => line.event === 'http_request' && line.level === 'debug'), {
      what: 'a debug line of the access log',
    });
    expect(server.port).toBe(port);
  });

  it('scans upward from the configured port: base taken, the next free port within base+19 is used', async () => {
    const f = await fixture();
    const base = await allocatePort();
    await occupy(base);
    const server = await booted(f, base);
    expect(server.port).not.toBeNull();
    expect(server.port ?? 0).toBeGreaterThan(base);
    expect(server.port ?? 0).toBeLessThanOrEqual(base + 19);
    const state = JSON.parse(readFileSync(path.join(f.ws, 'state.json'), 'utf8')) as { port: number };
    expect(state.port).toBe(server.port);
  });

  it.skipIf(FOREIGN_ADDRESS === undefined)(
    'listens on 127.0.0.1 only: the same port on another address of this machine is refused',
    async () => {
      const server = await booted(await fixture(), await allocatePort());
      const port = server.port ?? 0;
      expect(await connectOutcome('127.0.0.1', port)).toBe('connected');
      expect(await connectOutcome(FOREIGN_ADDRESS ?? '', port)).toBe('ECONNREFUSED');
    },
  );

  it('answers a request for another Host name with a refusal (the guards of WP-17 are in front)', async () => {
    const f = await fixture();
    const server = await booted(f, await allocatePort());
    const reply = await httpRequest(server.port ?? 0, '/api/v3/health', { host: 'evil.example:80' });
    expect(reply.status).toBe(403);
    expect((JSON.parse(reply.body) as { error: { code: string } }).error.code).toBe('host_not_allowed');
  });

  it('says previousRunUnclean when state.json is left over from a run that died, and takes the file over', async () => {
    const f = await fixture();
    const leftover = {
      pid: 2_000_000_001,
      url: 'http://127.0.0.1:18000',
      port: 18000,
      started: 1_760_000_000.5,
      version: RUNTIME_VERSION,
      task: 'demo',
      config: null,
      schema_version: 1,
      engine: 'node',
      instanceId: f.id,
      runtimeVersion: RUNTIME_VERSION,
      codeStamp: 'abcdef0123',
    };
    writeFileSync(path.join(f.ws, 'state.json'), JSON.stringify(leftover));
    const server = await booted(f, await allocatePort());
    expect(server.ctx.process.previousRunUnclean).toBe(true);
    expect(runtimeLog(f).some((line) => line.event === 'previous_run_unclean')).toBe(true);
    expect((JSON.parse(readFileSync(path.join(f.ws, 'state.json'), 'utf8')) as { pid: number }).pid).toBe(process.pid);
  });

  it('says nothing unclean after a clean first start or a graceful stop', async () => {
    const f = await fixture();
    const first = await booted(f, await allocatePort());
    expect(first.ctx.process.previousRunUnclean).toBe(false);
    first.requestShutdown('stop');
    await first.closed;
    expect(exists(f, 'state.json')).toBe(false);
    const second = await booted(f, await allocatePort());
    expect(second.ctx.process.previousRunUnclean).toBe(false);
    expect(runtimeLog(f).filter((line) => line.event === 'previous_run_unclean')).toEqual([]);
  });
});

describe('T-LC-14 boot part: a server that was killed (01 4.13)', () => {
  /** A shim at `<runtime>/packages/server/dist/main.js` that runs the built boot with this fixture's runtime folder. */
  function shimFor(f: Fixture): string {
    const dist = path.join(f.runtimeDir, 'packages', 'server', 'dist');
    mkdirSync(dist, { recursive: true });
    const shim = path.join(dist, 'main.js');
    writeFileSync(
      shim,
      [
        `import { serveMain } from ${JSON.stringify(pathToFileURL(REAL_BOOT).href)};`,
        `process.exit(await serveMain({ argv: process.argv.slice(2), env: process.env, runtimeDir: ${JSON.stringify(f.runtimeDir)} }));`,
        '',
      ].join('\n'),
    );
    return shim;
  }

  it('leaves state.json and the token behind; the next boot reports it, takes the files over and finds the database intact', async () => {
    expect(existsSync(REAL_BOOT), 'build the runtime first (npm run build): the child runs dist/boot.js').toBe(true);
    const f = await fixture();
    const port = await allocatePort();
    const child = spawnTracked(process.execPath, [shimFor(f), ...argvOf(f, port)], { env: f.env });
    await waitFor(
      async () => {
        const reply = await requestControl(controlAddress(f.id), { v: 1, op: 'identify' }, { timeoutMs: 1000 });
        return reply.ok && reply.op === 'identify' && reply.phase === 'ready' ? reply : null;
      },
      { timeoutMs: 30_000, what: 'the child server to be ready' },
    );
    const live = JSON.parse(readFileSync(path.join(f.ws, 'state.json'), 'utf8')) as { pid: number };
    expect(live.pid).toBe(child.pid);

    child.kill();
    await child.exited;
    expect(exists(f, 'state.json'), 'a killed server cannot clean up').toBe(true);
    expect(exists(f, 'run', 'control.token')).toBe(true);
    await expectChannelFree(f);
    await assertPortClosed(port);

    const second = await booted(f, await allocatePort());
    expect(second.ctx.process.previousRunUnclean).toBe(true);
    expect(runtimeLog(f).some((line) => line.event === 'previous_run_unclean')).toBe(true);
    expect((JSON.parse(readFileSync(path.join(f.ws, 'state.json'), 'utf8')) as { pid: number }).pid).toBe(process.pid);
    expect(pragmaValue(second.ctx.db.driver, 'integrity_check')).toBe('ok');
  }, 90_000);
});

describe('the real entry (dist/main.js)', () => {
  it('prints the problem of a bad command line on stderr and exits 17', () => {
    expect(existsSync(REAL_MAIN), 'build the runtime first (npm run build)').toBe(true);
    const root = makeTemp('serve-main').path;
    const result = spawnSync(process.execPath, [REAL_MAIN, 'serve', '--bogus'], {
      cwd: root,
      env: hermeticEnv(root),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    });
    expect(result.status).toBe(17);
    expect(result.stderr).toContain('--mcs-instance');
    expect(result.stdout).toBe('');
  }, 30_000);
});
