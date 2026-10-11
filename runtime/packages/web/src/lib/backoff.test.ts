// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKOFF_CAP_MS, createPoller, nextDelay } from './backoff.ts';

describe('backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('legacy: backoff: doubles, capped at 30 s, normal interval when healthy', () => {
    expect(BACKOFF_CAP_MS).toBe(30000);
    expect(nextDelay(1500, 0)).toBe(1500);
    expect(nextDelay(1500, 1)).toBe(3000);
    expect(nextDelay(1500, 2)).toBe(6000);
    expect(nextDelay(1500, 4)).toBe(24000);
    expect(nextDelay(1500, 5)).toBe(30000);
    expect(nextDelay(1500, 50)).toBe(30000);
    expect(nextDelay(6000, 1)).toBe(12000);
    expect(nextDelay(200, 1)).toBe(2000); // never faster than a 1 s base when failing
    expect(nextDelay(60000, 1, 30000)).toBe(30000);
  });

  it('stream reconnect delays: 2000, 4000, 8000, 16000, 30000, 30000', () => {
    const delays = [1, 2, 3, 4, 5, 6].map((attempt) => nextDelay(1000, attempt));
    expect(delays).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('a zero, negative or invalid interval falls back to the one second base', () => {
    expect(nextDelay(0, 0)).toBe(1000);
    expect(nextDelay(-5, 0)).toBe(1000);
    expect(nextDelay(Number.NaN, 2)).toBe(4000);
    expect(nextDelay(1500, -1)).toBe(1500);
  });

  it('legacy: poller: failure schedules backoff and success resumes the normal interval', async () => {
    const delays: [number, number][] = [];
    const errors: [string, number][] = [];
    let n = 0;
    const p = createPoller({
      name: 't',
      getInterval: () => 10,
      run: () => {
        n += 1;
        return n <= 2 ? Promise.reject(new Error('boom')) : Promise.resolve();
      },
      onError: (e, f) => {
        errors.push([e instanceof Error ? e.message : 'other', f]);
      },
      delayFn: (iv, f) => {
        delays.push([iv, f]);
        return 1;
      },
    });
    p.start();
    await vi.advanceTimersByTimeAsync(80);
    p.stop();
    expect(errors.slice(0, 2)).toEqual([
      ['boom', 1],
      ['boom', 2],
    ]);
    expect(delays.slice(0, 3)).toEqual([
      [10, 1],
      [10, 2],
      [10, 0],
    ]);
    expect(p.state.failures).toBe(0);
  });

  it('poller: a trigger during a run is coalesced into one more run', async () => {
    let runs = 0;
    let release: () => void = () => undefined;
    const p = createPoller({
      name: 'c',
      getInterval: () => 60000,
      run: () => {
        runs += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    p.start();
    expect(runs).toBe(1);
    expect(p.running).toBe(true);
    p.trigger();
    p.trigger();
    expect(runs).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(2);
    p.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('poller: stop prevents the next run and a throwing onError never breaks the loop', async () => {
    let runs = 0;
    const p = createPoller({
      name: 's',
      getInterval: () => 1000,
      run: () => {
        runs += 1;
        return Promise.reject(new Error('x'));
      },
      onError: () => {
        throw new Error('handler failed');
      },
    });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    expect(p.state.failures).toBe(1);
    p.stop();
    await vi.advanceTimersByTimeAsync(120000);
    expect(runs).toBe(1);
  });
});
