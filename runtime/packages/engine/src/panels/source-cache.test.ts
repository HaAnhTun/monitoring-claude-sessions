import type { PanelSource } from '@mcs/shared';
import { FakeClock, FIXTURE_EPOCH_MS } from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createErrorRing } from '../runtime/error-ring.ts';
import { PANEL_SOURCE_TABLE } from './constants.ts';
import { panelStatus, sourceState, SourceCache, type SourceResult, type SourceSpec } from './source-cache.ts';

interface Harness {
  clock: FakeClock;
  errors: ReturnType<typeof createErrorRing>;
  calls: { count: number };
  cache: SourceCache<string>;
}

function harness(
  load: (signal: AbortSignal, call: number) => Promise<SourceResult<string>>,
  over: Partial<SourceSpec<string>> = {},
): Harness {
  const clock = new FakeClock(FIXTURE_EPOCH_MS);
  const errors = createErrorRing(clock);
  const calls = { count: 0 };
  const spec: SourceSpec<string> = {
    source: 'ledger',
    ttlMs: 5000,
    firstWaitMs: 1000,
    timeoutMs: 1000,
    retryAfterUnavailableMs: 300_000,
    load: (signal) => {
      calls.count += 1;
      return load(signal, calls.count);
    },
    ...over,
  };
  return { clock, errors, calls, cache: new SourceCache(spec, clock, errors) };
}

/** A promise that the test settles by hand, at a moment it chooses on the fake timeline. */
function deferred(): { promise: Promise<SourceResult<string>>; resolve: (r: SourceResult<string>) => void } {
  let resolve: (r: SourceResult<string>) => void = () => undefined;
  const promise = new Promise<SourceResult<string>>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (value: string): Promise<SourceResult<string>> => Promise.resolve({ status: 'ok', value });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SourceCache single flight and ttl', () => {
  it('gives 20 concurrent reads one load', async () => {
    const h = harness(() => ok('v'));
    const reads = await Promise.all(Array.from({ length: 20 }, () => h.cache.read()));
    expect(h.calls.count).toBe(1);
    for (const read of reads) expect(read).toMatchObject({ value: 'v', status: 'ok', message: null });
  });

  it('gives 200 concurrent reads of a slow loader one load and leaves no timer behind', async () => {
    let finish: (r: SourceResult<string>) => void = () => undefined;
    const h = harness(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      { firstWaitMs: 3000 },
    );
    const pending = Array.from({ length: 200 }, () => h.cache.read());
    await vi.advanceTimersByTimeAsync(10);
    finish({ status: 'ok', value: 'late' });
    const reads = await Promise.all(pending);
    expect(h.calls.count).toBe(1);
    expect(reads.every((r) => r.value === 'late')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('makes no call for a second read inside the ttl and reloads after it', async () => {
    const h = harness((_s, call) => ok(`v${String(call)}`));
    expect((await h.cache.read()).value).toBe('v1');
    h.clock.advance(4999);
    expect((await h.cache.read()).value).toBe('v1');
    expect(h.calls.count).toBe(1);
    h.clock.advance(1);
    // stale while revalidating: the old value is served at once, the new one is there for the next read
    expect((await h.cache.read()).value).toBe('v1');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.count).toBe(2);
    expect((await h.cache.read()).value).toBe('v2');
  });

  it('reports the time of the value being served as sampledAt', async () => {
    const h = harness(() => ok('v'));
    const first = await h.cache.read();
    expect(first.sampledAt).toBe(FIXTURE_EPOCH_MS);
    h.clock.advance(7000);
    const stale = await h.cache.read();
    expect(stale.sampledAt).toBe(FIXTURE_EPOCH_MS);
  });
});

describe('SourceCache failures', () => {
  it('serves the last good value with status error after a failing refresh and backs off ttl * 2^n capped at 300 s', async () => {
    let fail = false;
    const h = harness(() => (fail ? Promise.resolve({ status: 'error', message: 'boom' }) : ok('good')), {
      ttlMs: 10_000,
    });
    expect((await h.cache.read()).value).toBe('good');
    fail = true;
    h.clock.advance(10_000);
    await h.cache.read(); // stale value, starts the failing refresh
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.count).toBe(2);
    const afterFailure = await h.cache.read();
    expect(afterFailure).toMatchObject({ value: 'good', status: 'error', message: 'boom' });
    expect(afterFailure.sampledAt).toBe(FIXTURE_EPOCH_MS);

    // failure 1: retry after ttl * 2^0 = 10 s, failure 2: 20 s, failure 3: 40 s ...
    const delays: number[] = [];
    for (let n = 0; n < 7; n += 1) {
      const before = h.calls.count;
      let waited = 0;
      while (h.calls.count === before) {
        h.clock.advance(1000);
        waited += 1000;
        await h.cache.read();
        await vi.advanceTimersByTimeAsync(0);
        if (waited > 400_000) throw new Error('no retry within the cap');
      }
      delays.push(waited);
    }
    expect(delays).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  });

  it('resets the backoff after a success', async () => {
    let fail = true;
    const h = harness(() => (fail ? Promise.resolve({ status: 'error', message: 'boom' }) : ok('good')), {
      ttlMs: 1000,
      firstWaitMs: 100,
    });
    await h.cache.read();
    h.clock.advance(1000);
    await h.cache.read();
    h.clock.advance(2000);
    await h.cache.read();
    expect(h.calls.count).toBe(3);
    fail = false;
    h.clock.advance(4000);
    expect((await h.cache.read()).value).toBe('good');
    h.clock.advance(1000);
    fail = true;
    await h.cache.read();
    await vi.advanceTimersByTimeAsync(0);
    h.clock.advance(1000);
    await h.cache.read();
    await vi.advanceTimersByTimeAsync(0);
    // the first failure after a success waits ttl again, not 8 s
    expect(h.calls.count).toBe(6);
  });

  it('waits retryAfterUnavailableMs after an unavailable result', async () => {
    const h = harness(() => Promise.resolve({ status: 'unavailable', message: 'git is not installed' }), {
      ttlMs: 1000,
      retryAfterUnavailableMs: 300_000,
    });
    const first = await h.cache.read();
    expect(first).toMatchObject({
      value: null,
      sampledAt: null,
      status: 'unavailable',
      message: 'git is not installed',
    });
    h.clock.advance(299_999);
    expect(await h.cache.read()).toMatchObject({ status: 'unavailable' });
    expect(h.calls.count).toBe(1);
    h.clock.advance(1);
    await h.cache.read();
    expect(h.calls.count).toBe(2);
  });

  it('turns a throwing loader and a rejecting loader into an error result', async () => {
    const thrower = harness(() => {
      throw new Error('sync boom');
    });
    expect(await thrower.cache.read()).toMatchObject({ value: null, status: 'error', message: 'sync boom' });
    const rejecter = harness(() => Promise.reject(new Error('async boom\nsecond line')));
    expect(await rejecter.cache.read()).toMatchObject({ status: 'error', message: 'async boom' });
    const odd = harness(() => Promise.reject(new TypeError('x'.repeat(500))));
    const read = await odd.cache.read();
    expect(read.message).toHaveLength(200);
  });

  it('puts an error in the ring once per distinct message per 60 s', async () => {
    const h = harness(() => Promise.resolve({ status: 'error', message: 'same problem' }), { ttlMs: 1000 });
    await h.cache.read();
    expect(h.errors.list()).toHaveLength(1);
    expect(h.errors.list()[0]).toMatchObject({ source: 'panel', where: 'panel.ledger', message: 'same problem' });
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(20_000);
      await h.cache.read();
      await vi.advanceTimersByTimeAsync(0);
    }
    // 80 s passed: the message came back after 60 s
    expect(h.errors.list().length).toBe(2);
    expect(h.calls.count).toBeGreaterThan(2);
  });

  it('does not put unavailable results in the ring', async () => {
    const h = harness(() => Promise.resolve({ status: 'unavailable', message: 'nope' }));
    await h.cache.read();
    expect(h.errors.list()).toHaveLength(0);
  });
});

describe('SourceCache without requests', () => {
  it('makes no loader call and holds no timer after one simulated hour without reads', async () => {
    const h = harness(() => ok('v'));
    await h.cache.read();
    const resourcesBefore = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    h.clock.advance(3_600_000);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.calls.count).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length).toBe(resourcesBefore);
  });
});

describe('SourceCache first wait', () => {
  it('returns the value of a loader that finishes within firstWait', async () => {
    const slow = deferred();
    const h = harness(() => slow.promise, { firstWaitMs: 3000, timeoutMs: 10_000 });
    const read = h.cache.read();
    await vi.advanceTimersByTimeAsync(50);
    slow.resolve({ status: 'ok', value: 'quick' });
    expect(await read).toMatchObject({ value: 'quick', status: 'ok' });
  });

  it('answers pending when the loader needs longer than firstWait, then serves the value', async () => {
    const slow = deferred();
    const h = harness(() => slow.promise, { firstWaitMs: 3000, timeoutMs: 10_000 });
    const read = h.cache.read();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await read).toEqual({ value: null, sampledAt: null, status: 'pending', message: null });
    await vi.advanceTimersByTimeAsync(1000);
    slow.resolve({ status: 'ok', value: 'slow' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.cache.read()).toMatchObject({ value: 'slow', status: 'ok' });
    expect(h.calls.count).toBe(1);
  });

  it('waits for the load itself when firstWaitMs is 0', async () => {
    const slow = deferred();
    const h = harness(() => slow.promise, { firstWaitMs: 0 });
    const read = h.cache.read();
    await vi.advanceTimersByTimeAsync(20);
    slow.resolve({ status: 'ok', value: 'sync' });
    expect(await read).toMatchObject({ value: 'sync' });
  });
});

describe('SourceCache hung loaders and abort', () => {
  it('gives up on a loader that never settles: error after the hard deadline, then a new load', async () => {
    const signals: AbortSignal[] = [];
    const h = harness(
      (signal, call) => {
        signals.push(signal);
        return call === 1 ? new Promise<SourceResult<string>>(() => undefined) : ok('recovered');
      },
      { firstWaitMs: 500, timeoutMs: 1000, ttlMs: 1000 },
    );
    const first = h.cache.read();
    await vi.advanceTimersByTimeAsync(500);
    expect((await first).status).toBe('pending');
    await vi.advanceTimersByTimeAsync(5000);
    expect(signals[0]?.aborted).toBe(true);
    expect(await h.cache.read()).toMatchObject({ value: null, status: 'error' });
    expect(vi.getTimerCount()).toBe(0);
    h.clock.advance(1000);
    const again = h.cache.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(await again).toMatchObject({ value: 'recovered', status: 'ok' });
  });

  it('abort() aborts the running load and discards its result', async () => {
    let seen: AbortSignal | null = null;
    let finish: (r: SourceResult<string>) => void = () => undefined;
    const h = harness(
      (signal) => {
        seen = signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      { firstWaitMs: 100 },
    );
    const read = h.cache.read();
    await vi.advanceTimersByTimeAsync(100);
    await read;
    h.cache.abort();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    finish({ status: 'ok', value: 'ignored' });
    await vi.advanceTimersByTimeAsync(0);
    const next = h.cache.read();
    await vi.advanceTimersByTimeAsync(100);
    expect((await next).value).toBeNull();
    expect(h.calls.count).toBe(2);
  });
});

describe('SourceCache stats', () => {
  it('counts refreshes and failures and keeps the last duration and status', async () => {
    let fail = false;
    const h = harness(() => (fail ? Promise.resolve({ status: 'error', message: 'x' }) : ok('v')), { ttlMs: 1000 });
    expect(h.cache.stats()).toEqual({ refreshes: 0, failures: 0, lastDurationMs: null, lastStatus: null });
    await h.cache.read();
    fail = true;
    h.clock.advance(1000);
    await h.cache.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.cache.stats()).toMatchObject({ refreshes: 2, failures: 1, lastStatus: 'error' });
    expect(h.cache.stats().lastDurationMs).toBe(0);
  });
});

describe('panelStatus and sourceState', () => {
  const state = (status: 'ok' | 'pending' | 'disabled' | 'unavailable'): ReturnType<typeof sourceState> =>
    sourceState('ledger', { value: null, sampledAt: null, status, message: null });

  it('is error without data, ok when every source is ok or disabled, partial otherwise', () => {
    expect(panelStatus([state('ok')], false)).toBe('error');
    expect(panelStatus([], false)).toBe('error');
    expect(panelStatus([state('ok'), state('disabled')], true)).toBe('ok');
    expect(panelStatus([state('ok'), state('pending')], true)).toBe('partial');
    expect(panelStatus([state('unavailable')], true)).toBe('partial');
  });

  it('formats sampledAt as an ISO time and clips the message to 200 characters', () => {
    const s = sourceState('git.status', {
      value: 1,
      sampledAt: FIXTURE_EPOCH_MS,
      status: 'error',
      message: 'y'.repeat(300),
    });
    expect(s.source).toBe('git.status' satisfies PanelSource);
    expect(s.sampledAt).toBe('2026-01-01T00:00:00.000Z');
    expect(s.message).toHaveLength(200);
    expect(
      sourceState('logs', { value: null, sampledAt: null, status: 'pending', message: null }).sampledAt,
    ).toBeNull();
  });
});

describe('PANEL_SOURCE_TABLE', () => {
  it('has the eleven sources of the contract with the values of the design table', () => {
    expect(Object.keys(PANEL_SOURCE_TABLE).sort()).toEqual(
      [
        'attempts',
        'chainLog',
        'cpu',
        'docker',
        'git.log',
        'git.status',
        'ledger',
        'logs',
        'memory',
        'processes',
        'stopFile',
      ].sort(),
    );
    expect(PANEL_SOURCE_TABLE['git.status']).toMatchObject({ ttlMs: 15_000, firstWaitMs: 3000, timeoutMs: 10_000 });
    expect(PANEL_SOURCE_TABLE['git.status'].retryAfterUnavailableMs).toBe(300_000);
    expect(PANEL_SOURCE_TABLE['git.log'].ttlMs).toBe(120_000);
    expect(PANEL_SOURCE_TABLE.processes).toMatchObject({ ttlMs: 20_000, firstWaitMs: 3000, timeoutMs: 10_000 });
    expect(PANEL_SOURCE_TABLE.docker).toMatchObject({ ttlMs: 15_000, firstWaitMs: 3000, timeoutMs: 8000 });
    expect(PANEL_SOURCE_TABLE.memory.ttlMs).toBe(1800);
    expect(PANEL_SOURCE_TABLE.cpu.ttlMs).toBe(1800);
    expect(PANEL_SOURCE_TABLE.stopFile.ttlMs).toBe(2000);
    expect(PANEL_SOURCE_TABLE.ledger).toMatchObject({ ttlMs: 5000, firstWaitMs: 1000, timeoutMs: 1000 });
    expect(PANEL_SOURCE_TABLE.chainLog).toMatchObject({ ttlMs: 5000, firstWaitMs: 1000, timeoutMs: 1000 });
    expect(PANEL_SOURCE_TABLE.logs).toMatchObject({ ttlMs: 2000, firstWaitMs: 1000, timeoutMs: 2000 });
    expect(PANEL_SOURCE_TABLE.attempts).toMatchObject({ ttlMs: 2000, firstWaitMs: 1000, timeoutMs: 2000 });
  });
});
