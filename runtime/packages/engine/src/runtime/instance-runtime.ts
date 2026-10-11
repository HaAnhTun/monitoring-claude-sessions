// The composition root of the server-side services (01 4.4a, slice S8; registry 2.2): `createInstanceRuntime(ctx)` creates the
// ingest service, the lifecycle sweeper, the database scheduler, the panel service and the state watchdog, starts them in that
// order and stops them in reverse. It also owns three things no service owns: the `ingestUntilIdle` mapping of
// `IngestIdleTimeoutError` (registry C06), the serialized 2 s attempts timer of the panel component (C57, N-01) and the late
// bindings of `ctx` (panel statistics, ownership flag).
//
// The factories of the other owners do not exist yet. Until their work packages land, `STUB_FACTORIES` below holds stubs with
// the owners' signatures (02 4.6 and 4.10, 03 11.4, 06 3.4); the marked blocks at the end of the file are empty and are where
// WP-35 (ingest service, sweeper, scheduler, route file), WP-41 (panel service) and WP-59 (alerts) register their real
// factories: an import of the real module, then `registeredFactories.<name> = <name>;`. The assignment is checked against the
// signatures below, so a real factory that differs from its owner's contract does not compile. A stub that is still in use
// is logged as `runtime_stub_service` when the runtime is created. `IngestIdleTimeoutError` is recognised by its name, so
// that two copies of the class (source and build) both map to `idle: false`; the real class must carry that name.
import { McsError, type HealthReport, type PanelKey, type PanelResponse, type PanelStats } from '@mcs/shared';

import { bindOwnershipConflict, bindPanelStats, type InstanceContext } from './context.ts';
import { createStateWatchdog } from './state-watchdog.ts';

export interface RuntimeComponent {
  readonly name: string;
  start(): Promise<void> | void;
  /** `deadlineMs` is an absolute `clock.now()` value. */
  stop(deadlineMs: number): Promise<void> | void;
}

export interface InstanceRuntime {
  /** Idempotent: a second call is a no-op. A failure stops the components that started and rejects. */
  start(): Promise<void>;
  /** `deadlineMs` is an absolute `clock.now()` value. Never rejects; stopping twice gives the first answer. */
  stop(deadlineMs: number): Promise<{ completed: boolean; pendingComponent: string | null }>;
  /** Never rejects for a timeout: `idle: false` says the work was not finished within `timeoutMs`. */
  ingestUntilIdle(o: { timeoutMs: number }): Promise<{ idle: boolean; waitedMs: number; stats: IngestStats }>;
  /** Control op `ingest-replay` (01 4.3): the number of segments reset. */
  ingestReplay(fromSegment: string | null): Promise<{ segments: number }>;
  /** `ctx.queries.health(ctx.scope)` (03 6.2). */
  health(): HealthReport;
  /** The panel service, created with the one writer of the ingest service (06 3.4); the panels route uses it. */
  readonly panels: PanelService;
}

/** The services of the runtime as the extension factory of the alerts receives them (plan section 4.2, WP-59). */
export interface RuntimeServices {
  readonly ingest: IngestService;
  readonly sweeper: LifecycleSweeper;
  readonly scheduler: DbScheduler;
  readonly panels: PanelService;
}

/** Every factory the runtime calls, with the signature of its owner. */
export interface RuntimeFactories {
  /** 02 4.10. */
  readonly createIngestService: (ctx: InstanceContext) => IngestService;
  /** 02 4.10: the sweeper submits through the one writer of the ingest service. */
  readonly createLifecycleSweeper: (ctx: InstanceContext, deps: { writer: IngestWriter }) => LifecycleSweeper;
  /** 03 11.4. */
  readonly createDbScheduler: (ctx: InstanceContext) => DbScheduler;
  /** 06 3.4: the panel service submits attempts evidence through the one writer of the ingest service (N-01). */
  readonly createPanelService: (ctx: InstanceContext, deps: { writer: IngestWriter }) => PanelService;
  /** Component 6 of 01 4.4a: `writeRouteFile(instance, { stoppedAt: null })` (02 2.6.2) once everything started. */
  readonly publishRouteFile: (ctx: InstanceContext) => Promise<void>;
  /** Components added after the panel service, before the state watchdog (WP-59). */
  readonly createAlertComponents: (ctx: InstanceContext, services: RuntimeServices) => readonly RuntimeComponent[];
}

export interface InstanceRuntimeOptions {
  /**
   * The bytes of this process's `state.json` (01 4.4 step 10), for the watchdog of 01 4.6; null while there are none. Absent:
   * the runtime has no state file (an in-process runtime) and the watchdog does nothing.
   */
  readonly stateFileBytes?: () => Uint8Array | null;
  /** Test seam: replaces the factories one by one. */
  readonly factories?: Partial<RuntimeFactories>;
}

// ---- the contracts of the other owners, and stubs of them ----------------------------------------------------------------------

/** 02 4.10. */
export interface IngestStats {
  queued: number;
  queuedBytes: number;
  lastCommitAt: number | null;
  failures: number;
  spoolBytesBehind: number;
  transcriptBytesBehind: number;
  backfillRemainingBytes: number;
  filesTracked: number;
}

/** 02 4.6 (the batch type is left open here: the writer module of 02 owns it). */
export interface IngestWriter {
  submit(batch: unknown): boolean;
  onDrain(cb: () => void): void;
  flushNow(): Promise<void>;
  readonly stats: { queued: number; queuedBytes: number; lastCommitAt: number | null; failures: number };
}

/** 02 4.10. */
export interface IngestService {
  readonly writer: IngestWriter;
  start(): Promise<void>;
  stop(deadlineMs: number): Promise<void>;
  untilIdle(o: { timeoutMs: number }): Promise<void>;
  nudge(): void;
  replay(fromSegment: string | null): Promise<{ segmentsReset: number }>;
  stats(): IngestStats;
}

/** 02 4.10. */
export interface LifecycleSweeper {
  start(): void;
  stop(deadlineMs: number): Promise<void>;
  tickNow(): Promise<void>;
}

/** 03 11.4. */
export interface DbScheduler {
  start(): void;
  stop(): Promise<void>;
}

/** 06 3.4. */
export interface AttemptsTickResult {
  state: 'ok' | 'not_configured' | 'missing' | 'error';
  linesRead: number;
  rowsChanged: number;
  eventsSubmitted: number;
}

/** 06 3.4. */
export interface PanelService {
  get<K extends PanelKey>(key: K, opts?: { limit?: number }): Promise<PanelResponse<K>>;
  tickAttempts(): Promise<AttemptsTickResult>;
  stats(): PanelStats;
  close(): void;
}

const NO_STATS: IngestStats = {
  queued: 0,
  queuedBytes: 0,
  lastCommitAt: null,
  failures: 0,
  spoolBytesBehind: 0,
  transcriptBytesBehind: 0,
  backfillRemainingBytes: 0,
  filesTracked: 0,
};

// a writer that always answers "queue full": nothing is accepted, nothing is lost silently
const closedWriter: IngestWriter = {
  submit: () => false,
  onDrain: () => undefined,
  flushNow: () => Promise.resolve(),
  stats: { queued: 0, queuedBytes: 0, lastCommitAt: null, failures: 0 },
};

/** Stubs with the owners' signatures: what the runtime uses until the real factories are registered. */
export const STUB_FACTORIES: RuntimeFactories = {
  createIngestService: () => ({
    writer: closedWriter,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    untilIdle: () => Promise.resolve(),
    nudge: () => undefined,
    replay: () => Promise.resolve({ segmentsReset: 0 }),
    stats: () => NO_STATS,
  }),
  createLifecycleSweeper: () => ({
    start: () => undefined,
    stop: () => Promise.resolve(),
    tickNow: () => Promise.resolve(),
  }),
  createDbScheduler: () => ({ start: () => undefined, stop: () => Promise.resolve() }),
  createPanelService: () => ({
    get: () => Promise.reject(new McsError('INTERNAL', 'the panel service is not built yet (WP-41)')),
    tickAttempts: () => Promise.resolve({ state: 'not_configured', linesRead: 0, rowsChanged: 0, eventsSubmitted: 0 }),
    stats: () => ({}),
    close: () => undefined,
  }),
  publishRouteFile: () => Promise.resolve(),
  createAlertComponents: () => [],
};

/** Where the work packages of the other owners register their real factories (the blocks at the end of this file). */
export const registeredFactories: { -readonly [K in keyof RuntimeFactories]?: RuntimeFactories[K] } = {};

/** The services whose stub is worth a warning: a runtime that still uses one is not the real thing. */
const STUB_SERVICES = [
  ['ingest', 'createIngestService'],
  ['lifecycle-sweeper', 'createLifecycleSweeper'],
  ['db-scheduler', 'createDbScheduler'],
  ['panels', 'createPanelService'],
  ['route-file', 'publishRouteFile'],
] as const;

/** The attempts tick of 06 3.10 runs this long after the previous one finished (01 4.4a component 4). */
const ATTEMPTS_TICK_MS = 2000;
/** The deadline of the components that already started when a start fails (01 4.4a `start()`). */
const START_FAILURE_STOP_MS = 2000;
/** The largest delay of a timer; a longer one would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const IDLE_TIMEOUT_ERROR = 'IngestIdleTimeoutError';

interface StopOutcome {
  completed: boolean;
  pendingComponent: string | null;
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return 'INTERNAL';
}

function isIdleTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === IDLE_TIMEOUT_ERROR || error.constructor.name === IDLE_TIMEOUT_ERROR);
}

export function createInstanceRuntime(ctx: InstanceContext, options: InstanceRuntimeOptions = {}): InstanceRuntime {
  const factories: RuntimeFactories = { ...STUB_FACTORIES, ...registeredFactories, ...options.factories };
  for (const [name, factory] of STUB_SERVICES) {
    if (factories[factory] === STUB_FACTORIES[factory]) ctx.logger.warn('runtime_stub_service', { phase: name });
  }

  // creation order = start order = reverse stop order (01 4.4a)
  const ingest = factories.createIngestService(ctx);
  const sweeper = factories.createLifecycleSweeper(ctx, { writer: ingest.writer });
  const scheduler = factories.createDbScheduler(ctx);
  const panels = factories.createPanelService(ctx, { writer: ingest.writer });
  bindPanelStats(ctx, () => panels.stats());
  const watchdog = createStateWatchdog(ctx, { stateFileBytes: options.stateFileBytes ?? ((): null => null) });
  bindOwnershipConflict(ctx, () => watchdog.ownershipConflict());
  const services: RuntimeServices = { ingest, sweeper, scheduler, panels };

  // ---- component 4: the attempts timer (registry C57) -------------------------------------------------------------------

  let tickInFlight: Promise<void> | null = null;
  let attemptsArmed = false;
  let attemptsTimer: ReturnType<typeof setTimeout> | null = null;

  function reportTickFailure(error: unknown): void {
    ctx.logger.warn('attempts_tick_failed', { code: codeOf(error) });
    ctx.errors.push({
      source: 'panels',
      code: 'ATTEMPTS_TICK_FAILED',
      where: 'panel.attempts',
      message: error instanceof Error ? error.message : 'the attempts tick failed',
    });
  }

  /** The one serializer: a call while a tick runs returns that tick; a rejection is reported, never thrown. */
  function tickAttemptsOnce(): Promise<void> {
    if (tickInFlight !== null) return tickInFlight;
    const current = Promise.resolve()
      .then(() => panels.tickAttempts())
      .then(
        () => undefined,
        (error: unknown) => {
          reportTickFailure(error);
        },
      )
      .finally(() => {
        tickInFlight = null;
      });
    tickInFlight = current;
    return current;
  }

  const isArmed = (): boolean => attemptsArmed;

  function armAttempts(): void {
    if (attemptsTimer !== null) clearTimeout(attemptsTimer);
    attemptsTimer = setTimeout(() => {
      attemptsTimer = null;
      void tickAttemptsOnce().then(() => {
        if (attemptsArmed) armAttempts();
      });
    }, ATTEMPTS_TICK_MS);
    attemptsTimer.unref();
  }

  const panelsComponent: RuntimeComponent = {
    name: 'panels',
    start: async () => {
      attemptsArmed = true;
      await tickAttemptsOnce();
      if (isArmed()) armAttempts(); // a stop during the first tick wins
    },
    stop: async (deadlineMs) => {
      attemptsArmed = false;
      if (attemptsTimer !== null) {
        clearTimeout(attemptsTimer);
        attemptsTimer = null;
      }
      if (tickInFlight !== null) {
        const guard = deadlineGuard(deadlineMs);
        try {
          await Promise.race([tickInFlight, guard.expired]);
        } finally {
          guard.cancel();
        }
      }
      panels.close();
    },
  };

  const components: readonly RuntimeComponent[] = [
    { name: 'ingest', start: () => ingest.start(), stop: (deadlineMs) => ingest.stop(deadlineMs) },
    {
      name: 'lifecycle-sweeper',
      start: () => {
        sweeper.start();
      },
      stop: (deadlineMs) => sweeper.stop(deadlineMs),
    },
    {
      name: 'db-scheduler',
      start: () => {
        scheduler.start();
      },
      stop: () => scheduler.stop(),
    },
    panelsComponent,
    ...factories.createAlertComponents(ctx, services),
    watchdog,
  ];

  // ---- deadlines --------------------------------------------------------------------------------------------------------

  /**
   * A timer for an absolute deadline. It is created before the work it guards, so that when both fall on the same
   * instant the guard fires first: a component that finishes exactly at the deadline has missed it.
   */
  function deadlineGuard(deadlineMs: number): { expired: Promise<'expired'>; cancel(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      const delay = Math.min(Math.max(0, deadlineMs - ctx.clock.now()), MAX_TIMER_MS);
      timer = setTimeout(() => {
        resolve('expired');
      }, delay);
    });
    return {
      expired,
      cancel: () => {
        if (timer !== undefined) clearTimeout(timer);
      },
    };
  }

  // ---- start and stop (01 4.4a algorithms) ------------------------------------------------------------------------------

  const started: RuntimeComponent[] = [];
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<StopOutcome> | null = null;

  function logStopFailure(component: RuntimeComponent): void {
    ctx.logger.warn('component_stop_failed', { phase: component.name });
  }

  /** Calls `stop` at once and never throws or rejects: a failure is logged by component name only. */
  function stopQuietly(component: RuntimeComponent, deadlineMs: number): Promise<void> {
    let result: Promise<void> | void;
    try {
      result = component.stop(deadlineMs);
    } catch {
      logStopFailure(component);
      return Promise.resolve();
    }
    return Promise.resolve(result).then(
      () => undefined,
      () => {
        logStopFailure(component);
      },
    );
  }

  /** In the order given; the first component that misses the deadline is reported and the rest are stopped without waiting. */
  async function stopAll(order: readonly RuntimeComponent[], deadlineMs: number): Promise<StopOutcome> {
    let pending: string | null = null;
    for (const component of order) {
      if (pending !== null) {
        void stopQuietly(component, deadlineMs);
        continue;
      }
      const guard = deadlineGuard(deadlineMs);
      const stopping = stopQuietly(component, deadlineMs);
      const outcome = await Promise.race([stopping.then(() => 'stopped' as const), guard.expired]);
      guard.cancel();
      if (outcome === 'expired') pending = component.name;
    }
    return { completed: pending === null, pendingComponent: pending };
  }

  async function doStart(): Promise<void> {
    let current = 'runtime';
    try {
      for (const component of components) {
        current = component.name;
        await component.start();
        started.push(component);
      }
      current = 'route-file';
      await factories.publishRouteFile(ctx);
    } catch (error) {
      ctx.logger.error('runtime_start_failed', { phase: current });
      const order = started.splice(0).reverse();
      await stopAll(order, ctx.clock.now() + START_FAILURE_STOP_MS);
      throw error;
    }
  }

  function start(): Promise<void> {
    if (stopPromise !== null)
      return Promise.reject(new McsError('INTERNAL', 'the runtime was stopped; create a new one'));
    startPromise ??= doStart();
    return startPromise;
  }

  async function doStop(deadlineMs: number): Promise<StopOutcome> {
    // a start in progress finishes first, so that nothing is stopped half started
    if (startPromise !== null)
      await startPromise.then(
        () => undefined,
        () => undefined,
      );
    return stopAll(started.splice(0).reverse(), deadlineMs);
  }

  function stop(deadlineMs: number): Promise<StopOutcome> {
    if (!Number.isFinite(deadlineMs)) {
      return Promise.reject(new RangeError(`stop: deadlineMs must be a finite number, got ${String(deadlineMs)}`));
    }
    stopPromise ??= doStop(deadlineMs);
    return stopPromise;
  }

  // ---- ingestUntilIdle (registry C06) -----------------------------------------------------------------------------------

  /** A tick that started after this call: waits for one that is running, then runs another (01 4.4a, N-01). */
  async function freshAttemptsTick(): Promise<void> {
    const shared = tickInFlight !== null;
    await tickAttemptsOnce();
    if (shared) await tickAttemptsOnce();
  }

  async function ingestUntilIdle(o: { timeoutMs: number }): ReturnType<InstanceRuntime['ingestUntilIdle']> {
    if (!Number.isFinite(o.timeoutMs) || o.timeoutMs < 0) {
      throw new RangeError(
        `ingestUntilIdle: timeoutMs must be a finite number of at least 0, got ${String(o.timeoutMs)}`,
      );
    }
    const startedAt = ctx.clock.now();
    const deadline = startedAt + o.timeoutMs;
    const notIdle = (): { idle: false; waitedMs: number; stats: IngestStats } => ({
      idle: false,
      waitedMs: ctx.clock.now() - startedAt,
      stats: ingest.stats(),
    });
    for (;;) {
      const remaining = deadline - ctx.clock.now();
      if (remaining <= 0) return notIdle();
      try {
        await ingest.untilIdle({ timeoutMs: remaining });
      } catch (error) {
        if (isIdleTimeout(error)) return notIdle();
        throw error;
      }
      await sweeper.tickNow(); // derives that became due
      await freshAttemptsTick(); // external attempts events
      try {
        await ingest.untilIdle({ timeoutMs: 0 });
      } catch (error) {
        if (isIdleTimeout(error)) continue;
        throw error;
      }
      return { idle: true, waitedMs: ctx.clock.now() - startedAt, stats: ingest.stats() };
    }
  }

  return {
    start,
    stop,
    ingestUntilIdle,
    ingestReplay: async (fromSegment) => ({ segments: (await ingest.replay(fromSegment)).segmentsReset }),
    health: () => ctx.queries.health(ctx.scope),
    panels,
  };
}

// The blocks of the owners of the real factories (see the header). They are empty until those work packages land.
// @wp-begin WP-35
import { createIngestService, publishRouteFile } from '../ingest/service.ts';
import { createLifecycleSweeper } from '../lifecycle/sweeper.ts';
import { createDbScheduler } from '../maintenance/schedule.ts';

registeredFactories.createIngestService = createIngestService;
registeredFactories.createLifecycleSweeper = createLifecycleSweeper;
registeredFactories.createDbScheduler = createDbScheduler;
registeredFactories.publishRouteFile = publishRouteFile;
// @wp-end WP-35

// @wp-begin WP-41
// @wp-end WP-41

// @wp-begin WP-59
// @wp-end WP-59
