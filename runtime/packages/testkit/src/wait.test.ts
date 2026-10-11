import { describe, expect, it } from 'vitest';

import { eventLoopLagProbe, waitFor } from './wait.ts';

describe('waitFor', () => {
  it('returns the first value that is neither null, undefined nor false', async () => {
    let calls = 0;
    const value = await waitFor(
      () => {
        calls += 1;
        return calls < 3 ? null : 'ready';
      },
      { intervalMs: 1 },
    );
    expect(value).toBe('ready');
    expect(calls).toBe(3);
  });

  it('accepts an async probe and keeps 0 and empty strings as values', async () => {
    await expect(waitFor(() => Promise.resolve(0), { intervalMs: 1 })).resolves.toBe(0);
    await expect(waitFor(() => Promise.resolve(''), { intervalMs: 1 })).resolves.toBe('');
  });

  it('treats false and undefined as not ready', async () => {
    let calls = 0;
    const value = await waitFor(
      () => {
        calls += 1;
        if (calls === 1) return false;
        if (calls === 2) return undefined;
        return 42;
      },
      { intervalMs: 1 },
    );
    expect(value).toBe(42);
  });

  it('survives a probe that throws until it works', async () => {
    let calls = 0;
    const value = await waitFor(
      () => {
        calls += 1;
        if (calls < 3) throw new Error('not yet');
        return 'ok';
      },
      { intervalMs: 1 },
    );
    expect(value).toBe('ok');
  });

  it('names what it waited for, the budget and the last value on timeout', async () => {
    await expect(waitFor(() => null, { timeoutMs: 30, intervalMs: 5, what: 'the spool line' })).rejects.toThrow(
      /30 ms.*the spool line.*null/s,
    );
  });

  it('reports the last error of a probe that kept throwing', async () => {
    await expect(
      waitFor(
        () => {
          throw new Error('boom 17');
        },
        { timeoutMs: 30, intervalMs: 5, what: 'a thing' },
      ),
    ).rejects.toThrow(/boom 17/);
  });

  it('honours the timeout when a probe never settles', async () => {
    const started = Date.now();
    await expect(
      waitFor(() => new Promise<never>(() => undefined), { timeoutMs: 100, what: 'a hung probe' }),
    ).rejects.toThrow(/100 ms.*a hung probe/s);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps the last value in the error when a later probe hangs', async () => {
    let calls = 0;
    const probe = (): Promise<string | null> => {
      calls += 1;
      return calls === 1 ? Promise.resolve(null) : new Promise<never>(() => undefined);
    };
    await expect(waitFor(probe, { timeoutMs: 120, intervalMs: 5, what: 'x' })).rejects.toThrow(/null/);
  });

  it('rejects a non-positive interval or timeout', async () => {
    await expect(waitFor(() => 1, { intervalMs: 0 })).rejects.toThrow(RangeError);
    await expect(waitFor(() => 1, { timeoutMs: -1 })).rejects.toThrow(RangeError);
  });
});

describe('eventLoopLagProbe', () => {
  it('measures a blocked event loop', async () => {
    const probe = eventLoopLagProbe();
    // The recorder needs two quiet ticks before it can see a stall.
    const warm = Date.now() + 60;
    await waitFor(() => Date.now() > warm, { intervalMs: 5 });
    const end = Date.now() + 120;
    while (Date.now() < end) {
      // busy loop: blocks the event loop on purpose
    }
    for (let i = 0; i < 8; i += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    const result = probe.stop();
    expect(result.maxMs).toBeGreaterThanOrEqual(60);
    expect(result.p99Ms).toBeGreaterThan(0);
    expect(result.p99Ms).toBeLessThanOrEqual(result.maxMs);
  });

  it('returns finite numbers when stopped before any sample', () => {
    const probe = eventLoopLagProbe();
    const result = probe.stop();
    expect(Number.isFinite(result.maxMs)).toBe(true);
    expect(Number.isFinite(result.p99Ms)).toBe(true);
  });
});
