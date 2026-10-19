// The composition root (01 4.4a, slice S8): component order, start and stop algorithms, the serialized 2 s attempts timer
// (registry C57), the `ingestUntilIdle` mapping (C06) and the late bindings. The services are fakes handed in through the
// factories seam; the context is a real one over a temp workspace (nothing here touches the real services).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUNTIME_VERSION } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { LogFields, LogLevel, Logger } from '../log/logger.ts';
import { initWorkspace } from '../workspace/init.ts';
import { buildInstanceContext, panelStatsOf, type InstanceContext } from './context.ts';
import {
  STUB_FACTORIES,
  createInstanceRuntime,
  registeredFactories,
  type InstanceRuntime,
  type InstanceRuntimeOptions,
  type RuntimeComponent,
  type RuntimeFactories,
} from './instance-runtime.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';
const OWN_PID = 4_000_001;
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');

const ZERO_STATS = {
  queued: 0,
  queuedBytes: 0,
  lastCommitAt: null,
  failures: 0,
  spoolBytesBehind: 0,
  transcriptBytesBehind: 0,
  backfillRemainingBytes: 0,
  filesTracked: 0,
};
const TICK_OK = { state: 'ok', linesRead: 0, rowsChanged: 0, eventsSubmitted: 0 } as const;

type Ingest = ReturnType<RuntimeFactories['createIngestService']>;
type Sweeper = ReturnType<RuntimeFactories['createLifecycleSweeper']>;
type Scheduler = ReturnType<RuntimeFactories['createDbScheduler']>;
type Panels = ReturnType<RuntimeFactories['createPanelService']>;

const contexts: InstanceContext[] = [];
const runtimes: InstanceRuntime[] = [];

// registered after useTempDirs(): afterEach hooks run in reverse order, so runtimes stop and databases close before the folders go
afterEach(async () => {
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.stop(Number.MAX_SAFE_INTEGER);
  for (const ctx of contexts.splice(0)) ctx.db.close();
});

interface LoggedCall {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: LogFields;
}

function fakeLogger(): { logger: Logger; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const record =
    (level: LogLevel) =>
    (event: string, fields?: LogFields): void => {
      calls.push({ level, event, fields: fields ?? {} });
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
  return { logger, calls };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The error 02 4.10 `untilIdle` rejects with; the runtime recognises it by class or by name. */
function idleTimeout(): Error {
  return Object.assign(new Error('ingestion did not become idle'), {
    name: 'IngestIdleTimeoutError',
    pending: ZERO_STATS,
  });
}

interface Env {
  readonly root: string;
  readonly ws: string;
  readonly clock: FakeClock;
  readonly ctx: InstanceContext;
  readonly calls: LoggedCall[];
}

async function makeEnv(): Promise<Env> {
  const root = makeTemp('runtime').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => ID });
  const { logger, calls } = fakeLogger();
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger,
    processInfo: { pid: OWN_PID }, // not a live process: "us" is never the test process itself
  });
  contexts.push(ctx);
  return { root, ws: ws.dir, clock, ctx, calls };
}

interface Mocks {
  readonly ingestStart: Mock<() => Promise<void>>;
  readonly ingestStop: Mock<(deadlineMs: number) => Promise<void>>;
  readonly ingestUntilIdle: Mock<(o: { timeoutMs: number }) => Promise<void>>;
  readonly ingestReplay: Mock<(from: string | null) => Promise<{ segmentsReset: number }>>;
  readonly ingestNudge: Mock<() => void>;
  readonly ingestStats: Mock<() => ReturnType<Ingest['stats']>>;
  readonly sweeperStart: Mock<() => void>;
  readonly sweeperStop: Mock<(deadlineMs: number) => Promise<void>>;
  readonly sweeperTickNow: Mock<() => Promise<void>>;
  readonly schedulerStart: Mock<() => void>;
  readonly schedulerStop: Mock<(...args: unknown[]) => Promise<void>>;
  readonly panelsTick: Mock<() => ReturnType<Panels['tickAttempts']>>;
  readonly panelsStats: Mock<() => ReturnType<Panels['stats']>>;
  readonly panelsClose: Mock<() => void>;
}

interface Fakes {
  readonly log: string[];
  /** The mocks behind the service methods, standalone so that no test reads a method off an interface. */
  readonly m: Mocks;
  readonly ingest: Ingest;
  readonly panels: Panels;
  readonly factories: RuntimeFactories;
  readonly writerSeenBySweeper: unknown[];
  readonly writerSeenByPanels: unknown[];
  readonly contextsSeen: InstanceContext[];
}

function makeFakes(): Fakes {
  const log: string[] = [];
  const writer = {
    submit: () => true,
    onDrain: () => undefined,
    flushNow: () => Promise.resolve(),
    stats: { queued: 0, queuedBytes: 0, lastCommitAt: null, failures: 0 },
  };
  const m: Mocks = {
    ingestStart: vi.fn(() => {
      log.push('ingest.start');
      return Promise.resolve();
    }),
    ingestStop: vi.fn((deadlineMs: number) => {
      log.push(`ingest.stop:${String(deadlineMs)}`);
      return Promise.resolve();
    }),
    ingestUntilIdle: vi.fn(() => Promise.resolve()),
    ingestReplay: vi.fn(() => Promise.resolve({ segmentsReset: 3 })),
    ingestNudge: vi.fn(() => undefined),
    ingestStats: vi.fn(() => ZERO_STATS),
    sweeperStart: vi.fn(() => {
      log.push('sweeper.start');
    }),
    sweeperStop: vi.fn((deadlineMs: number) => {
      log.push(`sweeper.stop:${String(deadlineMs)}`);
      return Promise.resolve();
    }),
    sweeperTickNow: vi.fn(() => Promise.resolve()),
    schedulerStart: vi.fn(() => {
      log.push('db-scheduler.start');
    }),
    schedulerStop: vi.fn((...args: unknown[]) => {
      log.push(`db-scheduler.stop:${String(args.length)}`);
      return Promise.resolve();
    }),
    panelsTick: vi.fn(() => {
      log.push('panels.tick');
      return Promise.resolve(TICK_OK);
    }),
    panelsStats: vi.fn(() => ({})),
    panelsClose: vi.fn(() => {
      log.push('panels.close');
    }),
  };
  const ingest: Ingest = {
    writer,
    start: (...args) => m.ingestStart(...args),
    stop: (deadlineMs) => m.ingestStop(deadlineMs),
    untilIdle: (o) => m.ingestUntilIdle(o),
    nudge: () => {
      m.ingestNudge();
    },
    replay: (from) => m.ingestReplay(from),
    stats: () => m.ingestStats(),
  };
  const sweeper: Sweeper = {
    start: () => {
      m.sweeperStart();
    },
    stop: (deadlineMs) => m.sweeperStop(deadlineMs),
    tickNow: () => m.sweeperTickNow(),
  };
  const scheduler: Scheduler = {
    start: () => {
      m.schedulerStart();
    },
    stop: (...args) => m.schedulerStop(...args),
  };
  const panels: Panels = {
    get: () => Promise.reject(new Error('not used')),
    tickAttempts: () => m.panelsTick(),
    stats: () => m.panelsStats(),
    close: () => {
      m.panelsClose();
    },
  };
  const writerSeenBySweeper: unknown[] = [];
  const writerSeenByPanels: unknown[] = [];
  const contextsSeen: InstanceContext[] = [];
  const factories: RuntimeFactories = {
    createIngestService: vi.fn((ctx: InstanceContext) => {
      contextsSeen.push(ctx);
      log.push('create.ingest');
      return ingest;
    }),
    createLifecycleSweeper: vi.fn((ctx: InstanceContext, deps: { writer: unknown }) => {
      contextsSeen.push(ctx);
      writerSeenBySweeper.push(deps.writer);
      log.push('create.sweeper');
      return sweeper;
    }),
    createDbScheduler: vi.fn((ctx: InstanceContext) => {
      contextsSeen.push(ctx);
      log.push('create.db-scheduler');
      return scheduler;
    }),
    createPanelService: vi.fn((ctx: InstanceContext, deps: { writer: unknown }) => {
      contextsSeen.push(ctx);
      writerSeenByPanels.push(deps.writer);
      log.push('create.panels');
      return panels;
    }),
    publishRouteFile: vi.fn(() => {
      log.push('route-file');
      return Promise.resolve();
    }),
    createAlertComponents: vi.fn(() => []),
  };
  return { log, m, ingest, panels, factories, writerSeenBySweeper, writerSeenByPanels, contextsSeen };
}

function make(env: Env, fakes: Fakes, options: Omit<InstanceRuntimeOptions, 'factories'> = {}): InstanceRuntime {
  const runtime = createInstanceRuntime(env.ctx, { ...options, factories: fakes.factories });
  runtimes.push(runtime);
  return runtime;
}

function fakeComponent(
  name: string,
  log: string[],
  o: { start?: () => Promise<void>; stop?: () => Promise<void> } = {},
): RuntimeComponent {
  return {
    name,
    start:
      o.start ??
      ((): Promise<void> => {
        log.push(`${name}.start`);
        return Promise.resolve();
      }),
    stop:
      o.stop ??
      ((deadlineMs: number): Promise<void> => {
        log.push(`${name}.stop:${String(deadlineMs)}`);
        return Promise.resolve();
      }),
  };
}

describe('createInstanceRuntime: creation (01 4.4a component order)', () => {
  it('creates ingest, sweeper, scheduler and panels in that order and gives one writer to sweeper and panels', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    make(env, fakes);
    expect(fakes.log).toEqual(['create.ingest', 'create.sweeper', 'create.db-scheduler', 'create.panels']);
    expect(fakes.writerSeenBySweeper).toEqual([fakes.ingest.writer]);
    expect(fakes.writerSeenByPanels).toEqual([fakes.ingest.writer]);
    for (const seen of fakes.contextsSeen) expect(seen).toBe(env.ctx);
  });

  it('starts the services in order, runs one attempts tick, then writes the route file', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    const runtime = make(env, fakes);
    fakes.log.length = 0;
    await runtime.start();
    expect(fakes.log).toEqual(['ingest.start', 'sweeper.start', 'db-scheduler.start', 'panels.tick', 'route-file']);
  });

  it('stops them in reverse order, passing the absolute deadline (the scheduler takes none) and closing the panels last of its own', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    const runtime = make(env, fakes);
    await runtime.start();
    fakes.log.length = 0;
    const deadline = NOW + 5000;
    await expect(runtime.stop(deadline)).resolves.toEqual({ completed: true, pendingComponent: null });
    expect(fakes.log).toEqual([
      'panels.close',
      'db-scheduler.stop:0',
      `sweeper.stop:${String(deadline)}`,
      `ingest.stop:${String(deadline)}`,
    ]);
  });

  it('puts the components of the alert extension after the panels and before the route file, and stops them first', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    vi.mocked(fakes.factories.createAlertComponents).mockReturnValue([fakeComponent('alerts', fakes.log)]);
    const runtime = make(env, fakes);
    fakes.log.length = 0;
    await runtime.start();
    expect(fakes.log).toEqual([
      'ingest.start',
      'sweeper.start',
      'db-scheduler.start',
      'panels.tick',
      'alerts.start',
      'route-file',
    ]);
    fakes.log.length = 0;
    await runtime.stop(NOW + 1000);
    expect(fakes.log).toEqual([
      `alerts.stop:${String(NOW + 1000)}`,
      'panels.close',
      'db-scheduler.stop:0',
      `sweeper.stop:${String(NOW + 1000)}`,
      `ingest.stop:${String(NOW + 1000)}`,
    ]);
    expect(fakes.factories.createAlertComponents).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fakes.factories.createAlertComponents).mock.calls[0]?.[0]).toBe(env.ctx);
  });

  it('forwards nudge to the ingest service, once per call, without waiting (CR-WP-17-4, CR-WP-18-3)', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    const runtime = createInstanceRuntime(env.ctx, { factories: fakes.factories });
    runtimes.push(runtime);
    expect(fakes.m.ingestNudge).not.toHaveBeenCalled();
    runtime.nudge();
    expect(fakes.m.ingestNudge).toHaveBeenCalledTimes(1);
    runtime.nudge();
    runtime.nudge();
    expect(fakes.m.ingestNudge).toHaveBeenCalledTimes(3);
  });

  it('exposes the panel service and delegates ingestReplay and health', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    const health = { checkedAt: 'x' };
    const healthQuery = vi.fn(() => health);
    const queries = { health: healthQuery } as unknown as InstanceContext['queries'];
    const byHand: InstanceContext = { ...env.ctx, queries };
    const runtime = createInstanceRuntime(byHand, { factories: fakes.factories });
    runtimes.push(runtime);
    expect(runtime.panels).toBe(fakes.panels);
    expect(runtime.health()).toBe(health);
    expect(healthQuery).toHaveBeenCalledWith(env.ctx.scope);
    await expect(runtime.ingestReplay('hooks-20260101T00Z.ndjson')).resolves.toEqual({ segments: 3 });
    expect(fakes.m.ingestReplay).toHaveBeenCalledWith('hooks-20260101T00Z.ndjson');
    await runtime.ingestReplay(null);
    expect(fakes.m.ingestReplay).toHaveBeenLastCalledWith(null);
  });
});

describe('createInstanceRuntime: start', () => {
  it('is idempotent: a second call, also a concurrent one, is a no-op', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    const runtime = make(env, fakes);
    const first = runtime.start();
    const second = runtime.start();
    await Promise.all([first, second]);
    await runtime.start();
    expect(fakes.m.ingestStart).toHaveBeenCalledTimes(1);
    expect(fakes.m.sweeperStart).toHaveBeenCalledTimes(1);
  });

  it('refuses to start again after stop', async () => {
    const env = await makeEnv();
    const runtime = make(env, makeFakes());
    await runtime.start();
    await runtime.stop(NOW + 1000);
    await expect(runtime.start()).rejects.toThrow(/stopped/);
  });

  it('stops the services that already started, in reverse order with a 2 s deadline, when one throws; the rest never start', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    fakes.m.schedulerStart.mockImplementation(() => {
      fakes.log.push('db-scheduler.start');
      throw new Error('scheduler could not start');
    });
    const runtime = make(env, fakes);
    fakes.log.length = 0;
    await expect(runtime.start()).rejects.toThrow('scheduler could not start');
    expect(fakes.log).toEqual([
      'ingest.start',
      'sweeper.start',
      'db-scheduler.start',
      `sweeper.stop:${String(NOW + 2000)}`,
      `ingest.stop:${String(NOW + 2000)}`,
    ]);
    expect(fakes.m.panelsTick).not.toHaveBeenCalled();
    expect(fakes.factories.publishRouteFile).not.toHaveBeenCalled();
    // the runtime is unusable afterwards: starting again gives the same failure, stopping is harmless
    await expect(runtime.start()).rejects.toThrow('scheduler could not start');
    await expect(runtime.stop(NOW + 1000)).resolves.toEqual({ completed: true, pendingComponent: null });
  });

  it('treats a failing route file like a failing component', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    vi.mocked(fakes.factories.publishRouteFile).mockRejectedValue(new Error('route file not writable'));
    const runtime = make(env, fakes);
    await expect(runtime.start()).rejects.toThrow('route file not writable');
    expect(fakes.log).toContain(`ingest.stop:${String(NOW + 2000)}`);
    expect(fakes.m.panelsClose).toHaveBeenCalledTimes(1);
  });

  it('does not let a failing first attempts tick fail the start', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    fakes.m.panelsTick.mockRejectedValue(new Error('chain log unreadable'));
    const runtime = make(env, fakes);
    await expect(runtime.start()).resolves.toBeUndefined();
    expect(env.ctx.errors.list()[0]).toMatchObject({ code: 'ATTEMPTS_TICK_FAILED', where: 'panel.attempts' });
  });
});

describe('createInstanceRuntime: stop', () => {
  it('reports the first component that misses the deadline and still stops the later ones without waiting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await makeEnv();
    const fakes = makeFakes();
    const never = deferred<undefined>();
    fakes.m.schedulerStop.mockImplementation(() => {
      fakes.log.push('db-scheduler.stop');
      return never.promise;
    });
    const runtime = make(env, fakes);
    await runtime.start();
    fakes.log.length = 0;
    const deadline = NOW + 500;
    const result = runtime.stop(deadline);
    await vi.advanceTimersByTimeAsync(499);
    expect(fakes.log).not.toContain(`sweeper.stop:${String(deadline)}`); // still waiting for the scheduler
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ completed: false, pendingComponent: 'db-scheduler' });
    expect(fakes.log).toContain(`sweeper.stop:${String(deadline)}`);
    expect(fakes.log).toContain(`ingest.stop:${String(deadline)}`);
    never.resolve(undefined);
  });

  it('logs a failing stop by component name only and carries on; stop never throws', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    fakes.m.sweeperStop.mockRejectedValue(new Error('secret detail C:/private/path'));
    const runtime = make(env, fakes);
    await runtime.start();
    await expect(runtime.stop(NOW + 1000)).resolves.toEqual({ completed: true, pendingComponent: null });
    expect(fakes.m.ingestStop).toHaveBeenCalledTimes(1);
    const failed = env.calls.filter((call) => call.event === 'component_stop_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.fields).toEqual({ phase: 'lifecycle-sweeper' });
  });

  it('is harmless before start, and a second stop returns the first answer without stopping anything twice', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    const runtime = make(env, fakes);
    await expect(runtime.stop(NOW + 1000)).resolves.toEqual({ completed: true, pendingComponent: null });
    expect(fakes.m.ingestStop).not.toHaveBeenCalled();
    const other = make(await makeEnv(), makeFakes());
    await other.start();
    const first = await other.stop(NOW + 1000);
    expect(await other.stop(NOW + 9999)).toEqual(first);
  });
});

describe('createInstanceRuntime: the attempts timer (registry C57)', () => {
  it('ticks at start and then 2000 ms after each tick finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await makeEnv();
    const fakes = makeFakes();
    const runtime = make(env, fakes);
    await runtime.start();
    const ticks = fakes.m.panelsTick;
    expect(ticks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(ticks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ticks).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks).toHaveBeenCalledTimes(8);
  });

  it('never runs two ticks at once and re-arms only after the running one finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await makeEnv();
    const fakes = makeFakes();
    const ticks = fakes.m.panelsTick;
    const second = deferred<typeof TICK_OK>();
    ticks.mockImplementationOnce(() => Promise.resolve(TICK_OK)).mockImplementationOnce(() => second.promise);
    const runtime = make(env, fakes);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks).toHaveBeenCalledTimes(2); // the second tick is now running
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks).toHaveBeenCalledTimes(2); // nothing else started while it runs
    second.resolve(TICK_OK);
    await vi.advanceTimersByTimeAsync(1999);
    expect(ticks).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ticks).toHaveBeenCalledTimes(3);
  });

  it('does not tick after stop, and stop waits for a running tick before it closes the panels', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await makeEnv();
    const fakes = makeFakes();
    const ticks = fakes.m.panelsTick;
    const running = deferred<typeof TICK_OK>();
    ticks.mockImplementationOnce(() => Promise.resolve(TICK_OK)).mockImplementationOnce(() => running.promise);
    const runtime = make(env, fakes);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(2000);
    const stopped = runtime.stop(NOW + 10_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fakes.m.panelsClose).not.toHaveBeenCalled(); // the tick is still running
    running.resolve(TICK_OK);
    await vi.advanceTimersByTimeAsync(0);
    await expect(stopped).resolves.toEqual({ completed: true, pendingComponent: null });
    expect(fakes.m.panelsClose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up waiting for a running tick at the deadline, closes the panels and reports them as pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await makeEnv();
    const fakes = makeFakes();
    const ticks = fakes.m.panelsTick;
    ticks
      .mockImplementationOnce(() => Promise.resolve(TICK_OK))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const runtime = make(env, fakes);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(2000);
    const stopped = runtime.stop(NOW + 300);
    await vi.advanceTimersByTimeAsync(300);
    await expect(stopped).resolves.toEqual({ completed: false, pendingComponent: 'panels' });
    expect(fakes.m.panelsClose).toHaveBeenCalledTimes(1);
  });

  it('logs a failing tick as attempts_tick_failed, keeps it in the error ring, never throws and keeps ticking', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await makeEnv();
    const fakes = makeFakes();
    const ticks = fakes.m.panelsTick;
    ticks
      .mockImplementationOnce(() => Promise.resolve(TICK_OK))
      .mockImplementationOnce(() => Promise.reject(new Error('chain log unreadable')));
    const runtime = make(env, fakes);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(2000);
    const failed = env.calls.filter((call) => call.event === 'attempts_tick_failed');
    expect(failed).toHaveLength(1);
    expect(env.ctx.errors.list()).toHaveLength(1);
    expect(env.ctx.errors.list()[0]).toMatchObject({
      source: 'panels',
      code: 'ATTEMPTS_TICK_FAILED',
      where: 'panel.attempts',
      message: 'chain log unreadable',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(ticks).toHaveBeenCalledTimes(3);
  });
});

describe('createInstanceRuntime: late bindings and the state watchdog', () => {
  it('binds the panel statistics to the panel service when the runtime is created, before start', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    const stats = { 'git.status': { refreshes: 2, failures: 0, lastDurationMs: 7, lastStatus: 'ok' } } as const;
    fakes.m.panelsStats.mockReturnValue(stats);
    expect(panelStatsOf(env.ctx)).toEqual({});
    make(env, fakes);
    expect(panelStatsOf(env.ctx)).toEqual(stats);
  });

  it('restores state.json after stateWatchdogMs when the server hands in its bytes, and not otherwise', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await makeEnv();
    const state = path.join(env.ws, 'state.json');
    const bytes = Buffer.from('{"pid":4000001}\n');

    const quiet = make(env, makeFakes());
    await quiet.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await quiet.stop(NOW + 1000);
    expect(existsSync(state)).toBe(false);

    const second = await makeEnv(); // one runtime per context: the late bindings are made once
    const watched = make(second, makeFakes(), { stateFileBytes: () => bytes });
    await watched.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await watched.stop(NOW + 1000); // waits for the tick that is running
    expect(existsSync(path.join(second.ws, 'state.json'))).toBe(true);
  });

  it('feeds the ownership flag of ctx.process from the watchdog', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await makeEnv();
    const state = path.join(env.ws, 'state.json');
    const legacy = {
      pid: process.pid,
      url: 'http://127.0.0.1:8765',
      port: 8765,
      started: 1.5,
      version: '2.0.2',
      task: 'demo',
      config: null,
    };
    writeFileSync(state, `${JSON.stringify(legacy)}\n`);
    const runtime = make(env, makeFakes(), { stateFileBytes: () => Buffer.from('{"pid":4000001}\n') });
    expect(env.ctx.process.ownershipConflict()).toBe(false);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await runtime.stop(NOW + 1000);
    expect(env.ctx.process.ownershipConflict()).toBe(true);
  });
});

describe('createInstanceRuntime: ingestUntilIdle (registry C06)', () => {
  it('asks the service, then the sweeper once, then the attempts tick once, then asks again with no time left to wait', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    const order: string[] = [];
    fakes.m.ingestUntilIdle.mockImplementation((o: { timeoutMs: number }) => {
      order.push(`untilIdle:${String(o.timeoutMs)}`);
      return Promise.resolve();
    });
    fakes.m.sweeperTickNow.mockImplementation(() => {
      order.push('tickNow');
      return Promise.resolve();
    });
    fakes.m.panelsTick.mockImplementation(() => {
      order.push('tick');
      return Promise.resolve(TICK_OK);
    });
    const runtime = make(env, fakes);
    await expect(runtime.ingestUntilIdle({ timeoutMs: 5000 })).resolves.toEqual({
      idle: true,
      waitedMs: 0,
      stats: ZERO_STATS,
    });
    expect(order).toEqual(['untilIdle:5000', 'tickNow', 'tick', 'untilIdle:0']);
  });

  it('maps IngestIdleTimeoutError to idle: false with the elapsed time and the service statistics', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    const stats = { ...ZERO_STATS, queued: 7 };
    fakes.m.ingestStats.mockReturnValue(stats);
    fakes.m.ingestUntilIdle.mockImplementation(() => {
      env.clock.advance(300);
      return Promise.reject(idleTimeout());
    });
    const runtime = make(env, fakes);
    await expect(runtime.ingestUntilIdle({ timeoutMs: 300 })).resolves.toEqual({ idle: false, waitedMs: 300, stats });
    expect(fakes.m.sweeperTickNow).not.toHaveBeenCalled();
    expect(fakes.m.panelsTick).not.toHaveBeenCalled();
  });

  it('rethrows every other error of the service', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    fakes.m.ingestUntilIdle.mockRejectedValue(new Error('database is gone'));
    const runtime = make(env, fakes);
    await expect(runtime.ingestUntilIdle({ timeoutMs: 100 })).rejects.toThrow('database is gone');
    fakes.m.ingestUntilIdle.mockResolvedValue(undefined);
    fakes.m.sweeperTickNow.mockRejectedValue(new Error('sweeper failed'));
    await expect(runtime.ingestUntilIdle({ timeoutMs: 100 })).rejects.toThrow('sweeper failed');
  });

  it('goes round again while the final check finds work, with the time that is left', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    const waits: number[] = [];
    let calls = 0;
    fakes.m.ingestUntilIdle.mockImplementation((o: { timeoutMs: number }) => {
      calls += 1;
      waits.push(o.timeoutMs);
      env.clock.advance(100);
      // second call of the first round is the final check: the attempts tick submitted events, so it is not idle yet
      return calls === 2 ? Promise.reject(idleTimeout()) : Promise.resolve();
    });
    const runtime = make(env, fakes);
    const result = await runtime.ingestUntilIdle({ timeoutMs: 1000 });
    expect(result).toEqual({ idle: true, waitedMs: 400, stats: ZERO_STATS });
    expect(waits).toEqual([1000, 0, 800, 0]);
    expect(fakes.m.sweeperTickNow).toHaveBeenCalledTimes(2);
    expect(fakes.m.panelsTick).toHaveBeenCalledTimes(2);
  });

  it('answers idle: false once no time is left, without waiting any longer', async () => {
    const env = await makeEnv();
    const fakes = makeFakes();
    let calls = 0;
    fakes.m.ingestUntilIdle.mockImplementation(() => {
      calls += 1;
      env.clock.advance(600);
      return calls % 2 === 0 ? Promise.reject(idleTimeout()) : Promise.resolve();
    });
    const runtime = make(env, fakes);
    const result = await runtime.ingestUntilIdle({ timeoutMs: 1000 });
    expect(result).toMatchObject({ idle: false, waitedMs: 1200 });
    expect(calls).toBe(2);
  });

  it('runs a fresh attempts tick even when the timer had one running at the time of the call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await makeEnv();
    const fakes = makeFakes();
    const ticks = fakes.m.panelsTick;
    const timerTick = deferred<typeof TICK_OK>();
    const freshTick = deferred<typeof TICK_OK>();
    ticks
      .mockImplementationOnce(() => Promise.resolve(TICK_OK))
      .mockImplementationOnce(() => timerTick.promise)
      .mockImplementationOnce(() => freshTick.promise);
    const runtime = make(env, fakes);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(2000); // the timer's tick is running
    expect(ticks).toHaveBeenCalledTimes(2);

    let settled = false;
    const idle = runtime.ingestUntilIdle({ timeoutMs: 1000 }).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toHaveBeenCalledTimes(2); // it shares the running tick instead of starting a second one at once
    timerTick.resolve(TICK_OK);
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toHaveBeenCalledTimes(3); // and then runs one that started after its own request
    expect(settled).toBe(false);
    freshTick.resolve(TICK_OK);
    await expect(idle).resolves.toMatchObject({ idle: true });
  });

  it('refuses a timeout that is not a finite number of milliseconds of at least 0', async () => {
    const runtime = make(await makeEnv(), makeFakes());
    await expect(runtime.ingestUntilIdle({ timeoutMs: -1 })).rejects.toThrow(RangeError);
    await expect(runtime.ingestUntilIdle({ timeoutMs: Number.NaN })).rejects.toThrow(RangeError);
    await expect(runtime.ingestUntilIdle({ timeoutMs: Number.POSITIVE_INFINITY })).rejects.toThrow(RangeError);
  });
});

describe('createInstanceRuntime: stubs and the registration of the real factories', () => {
  // the real owners register their factories at import time; a test restores the table it touched
  afterEach(() => {
    delete registeredFactories.createDbScheduler;
    delete registeredFactories.createIngestService;
  });

  function stubWarnings(env: Env): unknown[] {
    return env.calls.filter((call) => call.event === 'runtime_stub_service').map((call) => call.fields['phase']);
  }

  it('warns once for every stub it uses, except the empty alert extension', async () => {
    const env = await makeEnv();
    make(env, makeFakes(), {});
    expect(stubWarnings(env)).toEqual([]); // every factory came from the test

    const other = await makeEnv();
    const runtime = createInstanceRuntime(other.ctx, { factories: STUB_FACTORIES });
    runtimes.push(runtime);
    expect(stubWarnings(other)).toEqual(['ingest', 'lifecycle-sweeper', 'db-scheduler', 'panels', 'route-file']);
  });

  it('runs a whole runtime on the stubs: start, an idle ingestUntilIdle, replay, stop', async () => {
    const env = await makeEnv();
    const runtime = createInstanceRuntime(env.ctx, { factories: STUB_FACTORIES });
    runtimes.push(runtime);
    await runtime.start();
    await expect(runtime.ingestUntilIdle({ timeoutMs: 1000 })).resolves.toMatchObject({
      idle: true,
      stats: { queued: 0 },
    });
    await expect(runtime.ingestReplay(null)).resolves.toEqual({ segments: 0 });
    await expect(runtime.panels.get('git')).rejects.toThrow(/not built yet/);
    await expect(runtime.stop(NOW + 1000)).resolves.toEqual({ completed: true, pendingComponent: null });
  });

  it('uses a factory that its owner registered, and lets the factories of the options win over it', async () => {
    const registered = makeFakes();
    const wanted = makeFakes();
    registeredFactories.createDbScheduler = registered.factories.createDbScheduler;
    registeredFactories.createIngestService = registered.factories.createIngestService;

    const env = await makeEnv();
    const { createIngestService, createLifecycleSweeper, createPanelService, publishRouteFile, createAlertComponents } =
      wanted.factories;
    const runtime = createInstanceRuntime(env.ctx, {
      factories: {
        createIngestService,
        createLifecycleSweeper,
        createPanelService,
        publishRouteFile,
        createAlertComponents,
      },
    });
    runtimes.push(runtime);
    await runtime.start();
    expect(registered.m.schedulerStart).toHaveBeenCalledTimes(1); // the registered scheduler, not a stub
    expect(registered.m.ingestStart).not.toHaveBeenCalled(); // the options replaced the registered ingest service
    expect(wanted.m.ingestStart).toHaveBeenCalledTimes(1);
    expect(stubWarnings(env)).not.toContain('db-scheduler');
  });
});
