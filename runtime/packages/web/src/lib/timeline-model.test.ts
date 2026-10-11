// @vitest-environment node
import type { TranscriptEntry } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import {
  atLatestEdge,
  followReducer,
  initialFollow,
  isErrorUnit,
  mergeEvents,
  pairEvents,
  parseJump,
  stepError,
  toolDurationSec,
  unitSig,
  type FollowAction,
} from './timeline-model.ts';

const T = '2026-10-11T10:00:00Z';

function ev(i: number, k: TranscriptEntry['k'], extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { i, t: T, k, ...extra };
}

const sample: TranscriptEntry[] = [
  ev(0, 'prompt', { text: 'Do the thing' }),
  ev(1, 'say', { text: 'Sure, running ls' }),
  ev(2, 'tool', { id: 'a', name: 'Bash', summary: 'ls -la', input: '{"command":"ls -la"}' }),
  ev(3, 'tool', { id: 'b', name: 'Read', summary: 'file.txt', input: '{}' }),
  { ...ev(4, 'result', { id: 'a', text: 'total 0', err: false }), t: '2026-10-11T10:00:05Z' },
  ev(5, 'think', { text: 'hmm' }),
  ev(6, 'result', { id: 'zzz', text: 'orphan error', err: true }),
];

describe('timeline model', () => {
  it('legacy: pairEvents nests results in tools and classifies status', () => {
    const units = pairEvents(sample);
    expect(units.map((u) => u.key)).toEqual(['e0', 'e1', 'e2', 'e3', 'e5', 'e6']);
    const a = units.find((u) => u.key === 'e2');
    const b = units.find((u) => u.key === 'e3');
    expect(a?.status).toBe('completed');
    expect(a?.result?.i).toBe(4);
    expect(b?.status).toBe('active'); // no result yet
    expect(b?.result).toBeNull();
    const orphan = units.find((u) => u.key === 'e6');
    expect(orphan?.orphan).toBe(true);
    expect(orphan !== undefined && isErrorUnit(orphan)).toBe(true);
  });

  it('legacy: failed tool when result has err; sig changes when result arrives', () => {
    const before = pairEvents(sample.slice(0, 4));
    const after = pairEvents([...sample.slice(0, 4), ev(4, 'result', { id: 'b', text: 'nope', err: true })]);
    const ub = before.find((u) => u.key === 'e3');
    const ua = after.find((u) => u.key === 'e3');
    expect(ua?.status).toBe('failed');
    expect(ub !== undefined && ua !== undefined && unitSig(ub) !== unitSig(ua)).toBe(true);
    expect(ua !== undefined && isErrorUnit(ua)).toBe(true);
  });

  it('legacy: orphan result is dropped once its tool is loaded (older events arrive later)', () => {
    const onlyResult = pairEvents([ev(4, 'result', { id: 'a', text: 'x' })]);
    expect(onlyResult).toHaveLength(1);
    const both = pairEvents([ev(2, 'tool', { id: 'a', name: 'Bash' }), ev(4, 'result', { id: 'a', text: 'x' })]);
    expect(both).toHaveLength(1);
    expect(both[0]?.kind).toBe('tool');
  });

  it('pairEvents: a tool without an id never pairs and keeps the first result of a duplicated id', () => {
    const units = pairEvents([
      ev(0, 'tool', { name: 'Bash' }),
      ev(1, 'tool', { id: 'x', name: 'Read' }),
      ev(2, 'result', { id: 'x', text: 'first' }),
      ev(3, 'result', { id: 'x', text: 'second' }),
    ]);
    expect(units.find((u) => u.key === 'e0')?.status).toBe('active');
    expect(units.find((u) => u.key === 'e1')?.result?.i).toBe(2);
    expect(units.map((u) => u.key)).toEqual(['e0', 'e1']);
  });

  it('legacy: tool duration: running uses now, finished uses result time', () => {
    const units = pairEvents(sample);
    const done = units.find((u) => u.key === 'e2');
    expect(done !== undefined && toolDurationSec(done, Date.now())).toBe(5);
    const active = units.find((u) => u.key === 'e3');
    expect(active !== undefined && toolDurationSec(active, Date.parse(T) + 12000)).toBe(12);
  });

  it('tool duration is null when a timestamp is missing and never negative', () => {
    const noTime = pairEvents([{ i: 0, t: '', k: 'tool', id: 'a', name: 'Bash' }]);
    expect(noTime[0] !== undefined && toolDurationSec(noTime[0], 1000)).toBeNull();
    const early = pairEvents([ev(0, 'tool', { id: 'a', name: 'Bash' })]);
    expect(early[0] !== undefined && toolDurationSec(early[0], Date.parse(T) - 5000)).toBe(0);
  });

  it('legacy: mergeEvents appends, dedupes and reports older additions', () => {
    const a = [ev(5, 'say'), ev(6, 'say')];
    expect(mergeEvents(a, [ev(7, 'say')]).events.map((e) => e.i)).toEqual([5, 6, 7]);
    const r = mergeEvents(a, [ev(3, 'say'), ev(4, 'say')]);
    expect(r.events.map((e) => e.i)).toEqual([3, 4, 5, 6]);
    expect(r.olderAdded).toBe(2);
    const d = mergeEvents(a, [ev(6, 'say'), ev(7, 'say')]);
    expect(d.events.map((e) => e.i)).toEqual([5, 6, 7]);
    expect(d.added).toBe(1);
    expect(mergeEvents(a, []).added).toBe(0);
    expect(mergeEvents(a, []).events).toBe(a);
  });

  it('mergeEvents: incoming wins on a conflicting index', () => {
    const a = [ev(5, 'say', { text: 'old' })];
    const merged = mergeEvents(a, [ev(5, 'say', { text: 'new' })]);
    expect(merged.events[0]?.text).toBe('new');
    expect(merged.added).toBe(0);
  });

  it('legacy: follow state machine', () => {
    let s = initialFollow();
    expect(s).toEqual({ follow: true, unseen: 0, away: false });
    s = followReducer(s, { type: 'events', count: 3 });
    expect(s.unseen).toBe(0); // following: nothing unseen
    s = followReducer(s, { type: 'scroll', atEdge: false });
    expect(s.follow).toBe(false);
    s = followReducer(s, { type: 'events', count: 4 });
    s = followReducer(s, { type: 'events', count: 2 });
    expect(s.unseen).toBe(6);
    const back = followReducer(s, { type: 'scroll', atEdge: true }); // user scrolled back to the edge
    expect(back).toEqual({ follow: true, unseen: 0, away: false });
    s = followReducer(s, { type: 'resume' });
    expect(s).toEqual({ follow: true, unseen: 0, away: false });
    // explicit off does not auto-resume when the user wiggles at the edge
    s = followReducer(s, { type: 'toggle' });
    expect(s.follow).toBe(false);
    s = followReducer(s, { type: 'scroll', atEdge: true });
    expect(s.follow).toBe(false);
    s = followReducer(s, { type: 'toggle' });
    expect(s.follow).toBe(true);
    s = followReducer(followReducer(s, { type: 'scroll', atEdge: false }), { type: 'reset' });
    expect(s).toEqual(initialFollow());
    // same state object when nothing changes
    const same = initialFollow();
    expect(followReducer(same, { type: 'scroll', atEdge: true })).toBe(same);
  });

  it('followReducer returns the same object for every no-op action (React bail-out)', () => {
    const following = initialFollow();
    const noops: FollowAction[] = [
      { type: 'scroll', atEdge: true },
      { type: 'events', count: 5 },
      { type: 'events', count: 0 },
    ];
    for (const action of noops) expect(followReducer(following, action)).toBe(following);
    const off = followReducer(following, { type: 'off' });
    expect(off).toEqual({ follow: false, unseen: 0, away: false });
    expect(followReducer(off, { type: 'off' })).toBe(off);
    expect(followReducer(off, { type: 'events', count: 0 })).toBe(off);
    expect(followReducer(off, { type: 'scroll', atEdge: false })).toBe(off);
    expect(followReducer(following, { type: 'bogus' } as unknown as FollowAction)).toBe(following);
  });

  it('legacy: atLatestEdge respects direction', () => {
    expect(atLatestEdge({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }, true)).toBe(true);
    expect(atLatestEdge({ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 }, true)).toBe(false);
    expect(atLatestEdge({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }, false)).toBe(true);
    expect(atLatestEdge({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }, false)).toBe(false);
    expect(atLatestEdge({ scrollTop: 24, scrollHeight: 1000, clientHeight: 400 }, true)).toBe(true);
    expect(atLatestEdge({ scrollTop: 25, scrollHeight: 1000, clientHeight: 400 }, true)).toBe(false);
  });

  it('legacy: stepError walks forward and backward without wrapping', () => {
    const keys = ['e2', 'e5', 'e9'];
    expect(stepError(keys, null, 1)).toBe('e2');
    expect(stepError(keys, null, -1)).toBe('e9');
    expect(stepError(keys, 'e2', 1)).toBe('e5');
    expect(stepError(keys, 'e9', 1)).toBeNull();
    expect(stepError(keys, 'e2', -1)).toBeNull();
    expect(stepError(keys, 'gone', 1)).toBe('e2');
    expect(stepError([], null, 1)).toBeNull();
  });

  it('legacy: parseJump', () => {
    const now = new Date(2026, 9, 11, 15, 0, 0);
    expect(parseJump('#42')).toEqual({ type: 'index', i: 42 });
    expect(parseJump(' 7 ')).toEqual({ type: 'index', i: 7 });
    const t = parseJump('12:30', now);
    expect(t?.type).toBe('time');
    const ts = new Date(t?.type === 'time' ? t.ts : '');
    expect(ts.getHours()).toBe(12);
    expect(ts.getMinutes()).toBe(30);
    expect(parseJump('25:00', now)).toBeNull();
    expect(parseJump('2026-10-11T10:00:00Z')).toEqual({ type: 'time', ts: '2026-10-11T10:00:00.000Z' });
    expect(parseJump('hello')).toBeNull();
    expect(parseJump('')).toBeNull();
  });

  it('parseJump: local time of day follows the process time zone, seconds and bounds are checked', () => {
    const now = new Date(2026, 0, 5, 3, 0, 0);
    const withSeconds = parseJump('01:02:03', now);
    expect(withSeconds?.type === 'time' && new Date(withSeconds.ts).getSeconds()).toBe(3);
    const expected = new Date(2026, 0, 5, 1, 2, 3).toISOString();
    expect(withSeconds).toEqual({ type: 'time', ts: expected });
    expect(parseJump('12:60', now)).toBeNull();
    expect(parseJump('12:30:61', now)).toBeNull();
    expect(parseJump('2026-13-45', now)).toBeNull();
    expect(parseJump('1234567890', now)).toBeNull();
  });
});
