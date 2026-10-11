// Graceful shutdown (01 4.5): `control shutdown`, SIGINT, SIGTERM, SIGBREAK and SIGHUP all end in the same six steps inside
// `server.shutdownGraceMs` of the first trigger; a second trigger is ignored.
//   1. phase := stopping (`identify` keeps answering, with that phase)
//   2. stop accepting HTTP connections
//   3. `runtime.stop(deadline)`: watchdog, panels, maintenance timers, sweeper, then ingestion after its current batch
//   4. `PRAGMA wal_checkpoint(TRUNCATE)`, then close the database
//   5. delete `state.json` (compare-and-delete) and the token
//   6. close the control channel; exit 0
// If the deadline passes, the sequence ends with a log line naming the step and exit 0: the database is WAL-safe and the next
// boot recovers (01 4.13). This module is the order and the clock; what each step does is the caller's (`boot.ts`).
import type { Clock } from '@mcs/shared';
import type { ControlShutdownReason } from '@mcs/shared/protocol';
import type { Logger } from '@mcs/engine';

/** The reason of the first trigger (the vocabulary of the control protocol; a signal is `signal`). */
export type ShutdownReason = ControlShutdownReason;

// ---- the gate ---------------------------------------------------------------------------------------------------------------

/**
 * "Shutdown was asked for": the control channel, the signal handlers and the boot all hold this one object. The first
 * request wins and tells the listeners once, synchronously; every later request is ignored. A listener that registers after
 * the request is told at once, so a request that arrives while the server is still booting is not lost.
 */
export interface ShutdownGate {
  /** `true` for the first request, `false` for any later one. */
  request(reason: ShutdownReason): boolean;
  /** The reason of the first request, or `null`. */
  readonly reason: ShutdownReason | null;
  onRequest(listener: (reason: ShutdownReason) => void): void;
}

export function createShutdownGate(): ShutdownGate {
  let first: ShutdownReason | null = null;
  const listeners: ((reason: ShutdownReason) => void)[] = [];
  const tell = (listener: (reason: ShutdownReason) => void, reason: ShutdownReason): void => {
    try {
      listener(reason);
    } catch {
      // a listener that fails must not keep the others (or the process) from stopping
    }
  };
  return {
    request(reason) {
      if (first !== null) return false;
      first = reason;
      for (const listener of listeners) tell(listener, reason);
      return true;
    },
    get reason() {
      return first;
    },
    onRequest(listener) {
      listeners.push(listener);
      if (first !== null) tell(listener, first);
    },
  };
}

// ---- the sequence -------------------------------------------------------------------------------------------------------------

/** The names of the six steps, as they appear in the log (`phase` of `shutdown_step`). */
export const SHUTDOWN_STEP_NAMES = ['stopping', 'http', 'runtime', 'database', 'files', 'control'] as const;

export interface ShutdownSteps {
  /** Step 1. Runs before the first `await` of the sequence: `identify` says `stopping` from the moment of the trigger. */
  enterStopping(): void | Promise<void>;
  /** Step 2: stop accepting connections (and end the idle ones). */
  closeHttp(deadlineMs: number): Promise<void>;
  /** Step 3: `runtime.stop(deadlineMs)`. */
  stopRuntime(deadlineMs: number): Promise<{ completed: boolean; pendingComponent: string | null }>;
  /** Step 4: WAL checkpoint (TRUNCATE) and close. */
  closeDatabase(): void | Promise<void>;
  /** Step 5: `state.json`, `run/control.token`. */
  removeFiles(): Promise<void>;
  /** Step 6. */
  closeControl(): Promise<void>;
}

export interface ShutdownOptions {
  readonly clock: Clock;
  /** `server.shutdownGraceMs`: a finite number of milliseconds, at least 0. */
  readonly graceMs: number;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly reason: ShutdownReason;
  readonly steps: ShutdownSteps;
}

export interface ShutdownOutcome {
  readonly exitCode: 0;
  /** The step (1-6) that was running or about to start when the deadline passed, or `null`. */
  readonly deadlineExceededAtStep: number | null;
  /** The runtime component that missed the deadline (step 3), or `null`. */
  readonly pendingComponent: string | null;
  /** The steps that threw (the error is logged by code; the sequence went on). */
  readonly failedSteps: readonly number[];
  readonly durationMs: number;
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'INTERNAL';
}

/** Resolves `expired` when the deadline passes; created before the step it guards, so a tie goes to the deadline. */
function deadlineTimer(clock: Clock, deadlineMs: number): { expired: Promise<'expired'>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(
      () => {
        resolve('expired');
      },
      Math.max(0, Math.min(deadlineMs - clock.now(), 2 ** 31 - 1)),
    );
  });
  return {
    expired,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Calls `step` at once; a synchronous throw becomes a rejection, so both kinds of failure are handled in one place. */
function invoke(step: () => unknown): Promise<unknown> {
  try {
    return Promise.resolve(step());
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error('a shutdown step threw a value that is not an error'),
    );
  }
}

/**
 * Runs the six steps. It never rejects for a failing step or a missed deadline (both are logged); a `graceMs` that is not a
 * finite number of at least 0 is the caller's bug and throws `RangeError`.
 */
export function runShutdown(o: ShutdownOptions): Promise<ShutdownOutcome> {
  if (!Number.isFinite(o.graceMs) || o.graceMs < 0) {
    return Promise.reject(
      new RangeError(`runShutdown: graceMs must be a finite number of at least 0, got ${String(o.graceMs)}`),
    );
  }
  const startedAt = o.clock.now();
  const deadline = startedAt + o.graceMs;
  const failedSteps: number[] = [];
  let exceeded: number | null = null;
  let pendingComponent: string | null = null;
  o.logger.info('shutdown_begin', { code: o.reason });

  const steps: readonly (() => unknown)[] = [
    () => o.steps.enterStopping(),
    () => o.steps.closeHttp(deadline),
    async () => {
      const result = await o.steps.stopRuntime(deadline);
      if (!result.completed) {
        pendingComponent = result.pendingComponent;
        o.logger.warn('shutdown_component_pending', { phase: result.pendingComponent ?? 'unknown' });
      }
    },
    () => o.steps.closeDatabase(),
    () => o.steps.removeFiles(),
    () => o.steps.closeControl(),
  ];

  // Step 1 starts before the first await, so the phase is `stopping` as soon as `runShutdown` returns its promise.
  const run = async (): Promise<ShutdownOutcome> => {
    for (const [index, step] of steps.entries()) {
      const number = index + 1;
      const name = SHUTDOWN_STEP_NAMES[index] ?? 'unknown';
      if (index > 0 && o.clock.now() >= deadline) {
        exceeded = number;
        o.logger.warn('shutdown_deadline_exceeded', { count: number, phase: name });
        break;
      }
      const guard = deadlineTimer(o.clock, deadline);
      let outcome: 'done' | 'expired';
      try {
        // the step is called now, not in a later turn: step 1 must have run when `runShutdown` returns its promise
        outcome = await Promise.race([invoke(step).then(() => 'done' as const), guard.expired]);
      } catch (error) {
        failedSteps.push(number);
        o.logger.warn('shutdown_step_failed', { count: number, phase: name, code: codeOf(error) });
        guard.cancel();
        continue;
      }
      guard.cancel();
      if (outcome === 'expired') {
        exceeded = number;
        o.logger.warn('shutdown_deadline_exceeded', { count: number, phase: name });
        break;
      }
      o.logger.info('shutdown_step', { count: number, phase: name });
    }
    const durationMs = Math.max(0, o.clock.now() - startedAt);
    o.logger.info('shutdown_done', { status: exceeded === null ? 'complete' : 'deadline', durationMs });
    return { exitCode: 0, deadlineExceededAtStep: exceeded, pendingComponent, failedSteps, durationMs };
  };
  return run();
}
