// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ANNOUNCE_DEDUPE_MS, ANNOUNCE_DELAY_MS, createAnnouncer } from './announce.ts';

describe('announcer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make() {
    const texts: string[] = [];
    const announcer = createAnnouncer({
      setText: (t) => {
        texts.push(t);
      },
    });
    return { texts, announcer };
  }

  it('clears the region, then sets the message after 30 ms', () => {
    expect(ANNOUNCE_DELAY_MS).toBe(30);
    const { texts, announcer } = make();
    expect(announcer.announce('Theme dark')).toBe(true);
    expect(texts).toEqual(['']);
    vi.advanceTimersByTime(29);
    expect(texts).toEqual(['']);
    vi.advanceTimersByTime(1);
    expect(texts).toEqual(['', 'Theme dark']);
  });

  it('drops an identical message within 500 ms unless forced', () => {
    expect(ANNOUNCE_DEDUPE_MS).toBe(500);
    const { texts, announcer } = make();
    expect(announcer.announce('Refreshing')).toBe(true);
    vi.advanceTimersByTime(100);
    expect(announcer.announce('Refreshing')).toBe(false);
    expect(announcer.announce('Refreshing', { force: true })).toBe(true);
    vi.advanceTimersByTime(40);
    expect(texts).toEqual(['', 'Refreshing', '', 'Refreshing']);
  });

  it('announces the same message again after the dedupe window', () => {
    const { texts, announcer } = make();
    announcer.announce('Copied');
    vi.advanceTimersByTime(600);
    expect(announcer.announce('Copied')).toBe(true);
    vi.advanceTimersByTime(40);
    expect(texts.filter((t) => t === 'Copied')).toHaveLength(2);
  });

  it('a different message is never deduplicated and the newest message wins', () => {
    const { texts, announcer } = make();
    announcer.announce('One');
    announcer.announce('Two');
    vi.advanceTimersByTime(40);
    expect(texts).toEqual(['', '', 'Two']);
  });

  it('ignores empty messages and dispose cancels the pending update', () => {
    const { texts, announcer } = make();
    expect(announcer.announce('')).toBe(false);
    expect(texts).toEqual([]);
    announcer.announce('Pending');
    announcer.dispose();
    vi.advanceTimersByTime(100);
    expect(texts).toEqual(['']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
