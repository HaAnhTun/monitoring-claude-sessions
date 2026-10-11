import { describe, expect, it, vi } from 'vitest';

import { createFakeEventSources, FAKE_CLOSED, FAKE_CONNECTING, FAKE_OPEN } from './fake-event-source.ts';

describe('FakeEventSource', () => {
  it('starts connecting, opens, and records its url', () => {
    const sources = createFakeEventSources();
    const es = sources.factory('/s?since=1');
    expect(es.readyState).toBe(FAKE_CONNECTING);
    const onopen = vi.fn();
    es.onopen = onopen;
    es.open();
    expect(es.readyState).toBe(FAKE_OPEN);
    expect(onopen).toHaveBeenCalledTimes(1);
    expect(sources.urls()).toEqual(['/s?since=1']);
    expect(sources.last()).toBe(es);
  });

  it('delivers objects as JSON text and strings as is, to the listeners of that event name only', () => {
    const es = createFakeEventSources().factory('/s');
    const change = vi.fn();
    const heartbeat = vi.fn();
    es.addEventListener('change', change);
    es.addEventListener('heartbeat', heartbeat);
    es.emit('change', { seq: 1 });
    es.emit('change', 'not json');
    expect(change.mock.calls.map(([e]) => (e as MessageEvent<string>).data)).toEqual(['{"seq":1}', 'not json']);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(es.eventNames.sort()).toEqual(['change', 'heartbeat']);
  });

  it('delivers nothing after close unless forced, and counts closes', () => {
    const es = createFakeEventSources().factory('/s');
    const change = vi.fn();
    const onerror = vi.fn();
    es.addEventListener('change', change);
    es.onerror = onerror;
    es.close();
    expect(es.readyState).toBe(FAKE_CLOSED);
    expect(es.closeCount).toBe(1);
    es.emit('change', { seq: 1 });
    es.fail();
    es.open();
    expect(change).not.toHaveBeenCalled();
    expect(onerror).not.toHaveBeenCalled();
    expect(es.readyState).toBe(FAKE_CLOSED);
    es.emit('change', { seq: 2 }, { force: true });
    es.fail({ force: true });
    expect(change).toHaveBeenCalledTimes(1);
    expect(onerror).toHaveBeenCalledTimes(1);
  });

  it('throws from last() before the first source exists', () => {
    expect(() => createFakeEventSources().last()).toThrow(/no EventSource/);
  });
});
