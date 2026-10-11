// The server error ring (01 4.4a, 03 6.2): newest first, capacity 20, one clipped line per message.
import { ErrorItemSchema, isoMsZ } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { createErrorRing } from './error-ring.ts';

function entry(n: number): { source: string; code: string; where: string | null; message: string } {
  return { source: 'server', code: 'INTERNAL', where: `route.${String(n)}`, message: `failure ${String(n)}` };
}

describe('createErrorRing', () => {
  it('lists the newest error first with the push time as an ISO time with milliseconds', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const ring = createErrorRing(clock);
    ring.push(entry(1));
    clock.advance(1500);
    ring.push({ ...entry(2), sessionId: 'session-a' });

    const items = ring.list();
    expect(items.map((item) => item.message)).toEqual(['failure 2', 'failure 1']);
    expect(items[0]).toEqual({
      at: isoMsZ(FIXTURE_EPOCH_MS + 1500),
      source: 'server',
      code: 'INTERNAL',
      where: 'route.2',
      message: 'failure 2',
      sessionId: 'session-a',
    });
    expect(items[1]?.at).toBe(isoMsZ(FIXTURE_EPOCH_MS));
    expect(items[1]?.sessionId).toBeNull();
  });

  it('produces items that match the API schema of an error item', () => {
    const ring = createErrorRing(new FakeClock(FIXTURE_EPOCH_MS));
    ring.push({ source: 'panels', code: 'ATTEMPTS_TICK_FAILED', where: null, message: 'boom' });
    for (const item of ring.list()) expect(ErrorItemSchema.safeParse(item).success).toBe(true);
  });

  it('keeps the last 20 errors by default and drops the oldest', () => {
    const ring = createErrorRing(new FakeClock(FIXTURE_EPOCH_MS));
    for (let n = 1; n <= 25; n += 1) ring.push(entry(n));
    const items = ring.list();
    expect(items).toHaveLength(20);
    expect(items[0]?.message).toBe('failure 25');
    expect(items[19]?.message).toBe('failure 6');
  });

  it('honours a smaller capacity', () => {
    const ring = createErrorRing(new FakeClock(FIXTURE_EPOCH_MS), 3);
    for (let n = 1; n <= 5; n += 1) ring.push(entry(n));
    expect(ring.list().map((item) => item.message)).toEqual(['failure 5', 'failure 4', 'failure 3']);
  });

  it('returns at most `limit` items and nothing for a limit of 0', () => {
    const ring = createErrorRing(new FakeClock(FIXTURE_EPOCH_MS));
    for (let n = 1; n <= 5; n += 1) ring.push(entry(n));
    expect(ring.list(2).map((item) => item.message)).toEqual(['failure 5', 'failure 4']);
    expect(ring.list(0)).toEqual([]);
    expect(ring.list(100)).toHaveLength(5);
  });

  it('keeps only the first line of a message, clipped to 200 code points', () => {
    const ring = createErrorRing(new FakeClock(FIXTURE_EPOCH_MS));
    ring.push({ source: 's', code: 'c', where: null, message: 'first line\nsecond line with a path C:/private' });
    ring.push({ source: 's', code: 'c', where: null, message: 'x'.repeat(300) });
    // an emoji is one code point: the cut must not split its surrogate pair
    ring.push({
      source: 's',
      code: 'c',
      where: null,
      message: `${'y'.repeat(199)}${String.fromCodePoint(0x1f600)}tail`,
    });
    const [emoji, long, multi] = ring.list();
    expect(multi?.message).toBe('first line');
    expect(long?.message).toBe('x'.repeat(200));
    expect(emoji?.message).toBe(`${'y'.repeat(199)}${String.fromCodePoint(0x1f600)}`);
  });

  it('hands out copies: changing a listed item does not change the ring', () => {
    const ring = createErrorRing(new FakeClock(FIXTURE_EPOCH_MS));
    ring.push(entry(1));
    const first = ring.list();
    const item = first[0];
    if (item === undefined) throw new Error('expected an item');
    item.message = 'changed';
    first.pop();
    expect(ring.list()).toHaveLength(1);
    expect(ring.list()[0]?.message).toBe('failure 1');
  });

  it('refuses a capacity or a limit that is not a sensible integer', () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    expect(() => createErrorRing(clock, 0)).toThrow(RangeError);
    expect(() => createErrorRing(clock, 1.5)).toThrow(RangeError);
    expect(() => createErrorRing(clock, Number.NaN)).toThrow(RangeError);
    const ring = createErrorRing(clock);
    expect(() => ring.list(-1)).toThrow(RangeError);
    expect(() => ring.list(1.5)).toThrow(RangeError);
  });
});
