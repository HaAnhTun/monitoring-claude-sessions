// Graceful shutdown (01 4.5): one trigger wins, the six steps run in order inside the grace period, a failing step does not
// stop the others, a step that outlives the deadline ends the sequence with exit 0 and a log line naming the step.
import { systemClock, type Clock } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { SHUTDOWN_STEP_NAMES, createShutdownGate, runShutdown, type ShutdownSteps } from './shutdown.ts';

interface LogLine {
  readonly level: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

function recorder(): { logs: LogLine[]; logger: Parameters<typeof runShutdown>[0]['logger'] } {
  const logs: LogLine[] = [];
  const log = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    logs.push({ level, event, fields });
  };
  return { logs, logger: { info: log('info'), warn: log('warn'), error: log('error') } };
}

interface Trace {
  readonly order: string[];
  readonly deadlines: Record<string, number>;
  readonly steps: ShutdownSteps;
}

/** Steps that finish at once and record their order and the deadline they were given. */
function trace(over: Partial<ShutdownSteps> | ((order: string[]) => Partial<ShutdownSteps>) = {}): Trace {
  const order: string[] = [];
  const deadlines: Record<string, number> = {};
  const steps: ShutdownSteps = {
    enterStopping: () => {
      order.push('enterStopping');
    },
    closeHttp: (deadlineMs) => {
      order.push('closeHttp');
      deadlines['closeHttp'] = deadlineMs;
      return Promise.resolve();
    },
    stopRuntime: (deadlineMs) => {
      order.push('stopRuntime');
      deadlines['stopRuntime'] = deadlineMs;
      return Promise.resolve({ completed: true, pendingComponent: null });
    },
    closeDatabase: () => {
      order.push('closeDatabase');
      return Promise.resolve();
    },
    removeFiles: () => {
      order.push('removeFiles');
      return Promise.resolve();
    },
    closeControl: () => {
      order.push('closeControl');
      return Promise.resolve();
    },
    ...(typeof over === 'function' ? over(order) : over),
  };
  return { order, deadlines, steps };
}

describe('createShutdownGate: the first trigger wins, a second one is ignored', () => {
  it('records the first reason, answers true once, and tells the listeners once', () => {
    const gate = createShutdownGate();
    const heard: string[] = [];
    gate.onRequest((reason) => heard.push(`a:${reason}`));
    gate.onRequest((reason) => heard.push(`b:${reason}`));
    expect(gate.reason).toBeNull();
    expect(gate.request('stop')).toBe(true);
    expect(gate.request('signal')).toBe(false);
    expect(gate.reason).toBe('stop');
    expect(heard).toEqual(['a:stop', 'b:stop']);
  });

  it('tells a listener that registers late at once, with the reason of the first request', () => {
    const gate = createShutdownGate();
    gate.request('restart');
    gate.request('stop');
    const heard: string[] = [];
    gate.onRequest((reason) => heard.push(reason));
    expect(heard).toEqual(['restart']);
  });

  it('survives a listener that throws: the others are still told and the request still counts', () => {
    const gate = createShutdownGate();
    const heard: string[] = [];
    gate.onRequest(() => {
      throw new Error('listener failed');
    });
    gate.onRequest((reason) => heard.push(reason));
    expect(gate.request('upgrade')).toBe(true);
    expect(heard).toEqual(['upgrade']);
  });
});

describe('runShutdown: the six steps of 01 4.5 (T-LC-05)', () => {
  it('runs the steps in order, logs one line per step, and answers exit 0', async () => {
    const { order, steps } = trace();
    const { logs, logger } = recorder();
    const outcome = await runShutdown({ clock: systemClock, graceMs: 5000, logger, reason: 'stop', steps });
    expect(order).toEqual([
      'enterStopping',
      'closeHttp',
      'stopRuntime',
      'closeDatabase',
      'removeFiles',
      'closeControl',
    ]);
    expect(outcome).toMatchObject({
      exitCode: 0,
      deadlineExceededAtStep: null,
      pendingComponent: null,
      failedSteps: [],
    });
    const stepLines = logs.filter((line) => line.event === 'shutdown_step');
    expect(stepLines.map((line) => line.fields?.['count'])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stepLines.map((line) => line.fields?.['phase'])).toEqual([...SHUTDOWN_STEP_NAMES]);
    expect(logs[0]).toMatchObject({ level: 'info', event: 'shutdown_begin', fields: { code: 'stop' } });
    expect(logs.at(-1)).toMatchObject({ event: 'shutdown_done', fields: { status: 'complete' } });
  });

  it('enters the stopping phase before the first await, so identify says stopping at once', () => {
    const { order, steps } = trace();
    const { logger } = recorder();
    const running = runShutdown({ clock: systemClock, graceMs: 5000, logger, reason: 'signal', steps });
    expect(order).toEqual(['enterStopping']);
    return running;
  });

  it('gives the HTTP and runtime steps the absolute deadline: now plus the grace period', async () => {
    const clock: Clock = { now: () => 1_000_000 };
    const { deadlines, steps } = trace();
    const { logger } = recorder();
    await runShutdown({ clock, graceMs: 7000, logger, reason: 'stop', steps });
    expect(deadlines).toEqual({ closeHttp: 1_007_000, stopRuntime: 1_007_000 });
  });

  it('keeps going after a failing step and names the step and the error code, never the message', async () => {
    const { order, steps } = trace({
      closeDatabase: () => Promise.reject(Object.assign(new Error('secret text of the failure'), { code: 'db_busy' })),
    });
    const { logs, logger } = recorder();
    const outcome = await runShutdown({ clock: systemClock, graceMs: 5000, logger, reason: 'stop', steps });
    expect(order.slice(-2)).toEqual(['removeFiles', 'closeControl']);
    expect(outcome.failedSteps).toEqual([4]);
    expect(outcome.exitCode).toBe(0);
    const failed = logs.find((line) => line.event === 'shutdown_step_failed');
    expect(failed).toMatchObject({ level: 'warn', fields: { count: 4, phase: 'database', code: 'db_busy' } });
    expect(JSON.stringify(logs)).not.toContain('secret text');
  });

  it('survives a step that throws synchronously, and an error without a code', async () => {
    const { order, steps } = trace({
      closeHttp: () => {
        throw new Error('sync failure');
      },
    });
    const { logs, logger } = recorder();
    const outcome = await runShutdown({ clock: systemClock, graceMs: 5000, logger, reason: 'stop', steps });
    expect(outcome.failedSteps).toEqual([2]);
    expect(order).toContain('closeControl');
    expect(logs.find((line) => line.event === 'shutdown_step_failed')?.fields?.['code']).toBe('INTERNAL');
  });

  it('reports a runtime component that missed the deadline and still runs the remaining steps', async () => {
    const { order, steps } = trace({
      stopRuntime: () => Promise.resolve({ completed: false, pendingComponent: 'ingest' }),
    });
    const { logs, logger } = recorder();
    const outcome = await runShutdown({ clock: systemClock, graceMs: 5000, logger, reason: 'stop', steps });
    expect(outcome.pendingComponent).toBe('ingest');
    expect(order.slice(-3)).toEqual(['closeDatabase', 'removeFiles', 'closeControl']);
    expect(logs.find((line) => line.event === 'shutdown_component_pending')).toMatchObject({
      level: 'warn',
      fields: { phase: 'ingest' },
    });
  });

  it('ends the sequence with exit 0 when a step outlives the deadline, and names that step', async () => {
    const { order, steps } = trace((order) => ({
      stopRuntime: () => {
        order.push('stopRuntime');
        return new Promise(() => undefined);
      },
    }));
    const { logs, logger } = recorder();
    const started = Date.now();
    const outcome = await runShutdown({ clock: systemClock, graceMs: 120, logger, reason: 'stop', steps });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome).toMatchObject({ exitCode: 0, deadlineExceededAtStep: 3 });
    expect(order).toEqual(['enterStopping', 'closeHttp', 'stopRuntime']);
    expect(logs.find((line) => line.event === 'shutdown_deadline_exceeded')).toMatchObject({
      level: 'warn',
      fields: { count: 3, phase: 'runtime' },
    });
    expect(logs.at(-1)).toMatchObject({ event: 'shutdown_done', fields: { status: 'deadline' } });
  });

  it('does not start a step once the deadline has passed, and names the first step that did not run', async () => {
    let now = 0;
    const clock: Clock = { now: () => now };
    const { steps } = trace({
      closeHttp: () => {
        now = 100; // the whole grace period went by inside step 2
        return Promise.resolve();
      },
    });
    const { logger } = recorder();
    const outcome = await runShutdown({ clock, graceMs: 100, logger, reason: 'stop', steps });
    expect(outcome.deadlineExceededAtStep).toBe(3);
  });

  it('refuses a grace period that is not a finite number of at least 0', async () => {
    const { steps } = trace();
    const { logger } = recorder();
    for (const graceMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      await expect(runShutdown({ clock: systemClock, graceMs, logger, reason: 'stop', steps })).rejects.toBeInstanceOf(
        RangeError,
      );
    }
  });
});
