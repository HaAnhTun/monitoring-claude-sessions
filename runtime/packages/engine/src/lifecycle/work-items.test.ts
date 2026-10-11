// T-LF-52: work items of the board (02 7.11): rules W-DECL, W-ATT, W-LBL and the seven board-state rules.
import type { LifecycleState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import {
  deriveWorkItems,
  type DerivedWorkItem,
  type WorkItemAttempt,
  type WorkItemInput,
  type WorkItemSession,
} from './work-items.ts';

let counter = 0;

function session(id: string, state: LifecycleState, over: Partial<WorkItemSession> = {}): WorkItemSession {
  counter += 1;
  return {
    sessionId: id,
    label: null,
    matched: true,
    ruleIndex: 0,
    state,
    ruleId: 'S-7e',
    startedAt: 1_000_000 + counter * 1000,
    lastActivityAt: 1_000_000 + counter * 1000 + 500,
    ...over,
  };
}

function attempt(part: string, startedAt: number, over: Partial<WorkItemAttempt> = {}): WorkItemAttempt {
  return { part, startedAt, endReason: 'open', state: 'RUNNING', sessionId: null, ...over };
}

function derive(over: Partial<WorkItemInput>): DerivedWorkItem[] {
  return deriveWorkItems({ sessions: [], attempts: [], declared: [], labelPrefix: '', ...over });
}

function byKey(items: readonly DerivedWorkItem[], key: string): DerivedWorkItem {
  const item = items.find((candidate) => candidate.key === key);
  if (item === undefined) throw new Error(`no work item ${key} in ${JSON.stringify(items.map((i) => i.key))}`);
  return item;
}

describe('T-LF-52 W-LBL: matched sessions grouped by exact label', () => {
  it('groups by label, keeps one member groups, and leaves unmatched sessions out', () => {
    const items = derive({
      sessions: [
        session('s1', 'working', { label: 'build' }),
        session('s2', 'completed', { label: 'build' }),
        session('s3', 'completed', { label: 'docs' }),
        session('s4', 'working', { label: 'orphan', matched: false }),
        session('s5', 'working', { label: null }),
      ],
    });
    expect(items.map((i) => i.key)).toEqual(['label:build', 'label:docs']);
    const build = byKey(items, 'label:build');
    expect(build).toMatchObject({ rule: 'W-LBL', source: 'label', title: 'build', state: 'working' });
    expect([...build.sessionIds].sort()).toEqual(['s1', 's2']);
    expect(build.evidence.map((e) => [e.sessionId, e.state, e.ruleId]).sort()).toEqual([
      ['s1', 'working', 'S-7e'],
      ['s2', 'completed', 'S-7e'],
    ]);
    expect(byKey(items, 'label:docs')).toMatchObject({ state: 'completed', sessionIds: ['s3'] });
  });
});

describe('T-LF-52 W-DECL: declared items in declaration order', () => {
  const declared = [
    { key: 'ship', title: 'Ship it', match: { sessionIds: ['s9'] } },
    { key: 'build-all', title: 'Build everything', match: { labels: ['build'], labelPrefix: 'build-' } },
    { key: 'docs', title: 'Docs', match: { labels: ['build'] } },
  ];

  it('matches by session id, exact label and label prefix; the first declaration claims the session', () => {
    const items = derive({
      declared,
      sessions: [
        session('s9', 'completed', { label: 'whatever' }),
        session('s1', 'working', { label: 'build' }),
        session('s2', 'completed', { label: 'build-x' }),
        session('s3', 'working', { label: 'other' }),
      ],
    });
    expect(items.map((i) => i.key)).toEqual(['ship', 'build-all', 'docs', 'label:other']);
    expect(byKey(items, 'ship')).toMatchObject({
      rule: 'W-DECL',
      source: 'declared',
      title: 'Ship it',
      sessionIds: ['s9'],
      state: 'completed',
    });
    expect([...byKey(items, 'build-all').sessionIds].sort()).toEqual(['s1', 's2']);
    // s1 was claimed by the earlier declaration: the later one is empty
    expect(byKey(items, 'docs')).toMatchObject({
      sessionIds: [],
      evidence: [],
      state: 'unknown',
      boardReason: 'no member session',
    });
    // a claimed session is not a member of the label group either
    expect(byKey(items, 'label:other').sessionIds).toEqual(['s3']);
  });

  it('an explicit session id needs no match; labels do', () => {
    const items = derive({
      declared: [
        { key: 'a', title: 'A', match: { sessionIds: ['s1'] } },
        { key: 'b', title: 'B', match: { labels: ['x'] } },
      ],
      sessions: [
        session('s1', 'working', { matched: false }),
        session('s2', 'working', { label: 'x', matched: false }),
      ],
    });
    expect(byKey(items, 'a').sessionIds).toEqual(['s1']);
    expect(byKey(items, 'b').sessionIds).toEqual([]);
  });

  it('attemptParts take the sessions matched to the rows of those parts', () => {
    const items = derive({
      declared: [{ key: 'p', title: 'Part p', match: { attemptParts: ['p1'] } }],
      sessions: [session('s1', 'working', { label: 'x' }), session('s2', 'completed', { label: 'x' })],
      attempts: [attempt('p1', 1000, { sessionId: 's1' }), attempt('p2', 2000, { sessionId: 's2' })],
    });
    expect(byKey(items, 'p').sessionIds).toEqual(['s1']);
    // the rows of a declared part do not make an attempt item of their own; claimed sessions leave no label group
    expect(items.map((i) => i.key)).toEqual(['p', 'attempt:p2']);
  });
});

describe('T-LF-52 W-ATT: attempts rows grouped by part', () => {
  it('builds attempt:<part> with the title <label_prefix><part> and the sessions matched to its rows', () => {
    const items = derive({
      labelPrefix: 'Task ',
      sessions: [session('s1', 'working', { label: 'L' }), session('s2', 'working', { label: 'L' })],
      attempts: [attempt('alpha', 1000, { sessionId: 's1' }), attempt('beta', 2000, { sessionId: 's2' })],
    });
    expect(items.map((i) => i.key)).toEqual(['attempt:alpha', 'attempt:beta']);
    expect(byKey(items, 'attempt:alpha')).toMatchObject({
      rule: 'W-ATT',
      source: 'attempts',
      title: 'Task alpha',
      sessionIds: ['s1'],
      state: 'working',
    });
    expect(byKey(items, 'attempt:beta').sessionIds).toEqual(['s2']);
  });

  it('a retry: attempt 1 failed, attempt 2 still running is working (board rule 2, not rule 1)', () => {
    const items = derive({
      sessions: [session('s1', 'failed'), session('s2', 'working')],
      attempts: [
        attempt('p', 1000, { endReason: 'ended', state: 'FAILED', sessionId: 's1' }),
        attempt('p', 5000, { endReason: 'open', state: 'RUNNING', sessionId: 's2' }),
      ],
    });
    const item = byKey(items, 'attempt:p');
    expect(item.state).toBe('working');
    expect(item.boardRule).toBe(2);
    expect([...item.sessionIds].sort()).toEqual(['s1', 's2']);
  });

  it.each([
    ['COMPLETED', 'completed'],
    ['FAILED', 'failed'],
    ['UNKNOWN', 'unknown'],
  ] as const)('the latest row ended %s gives %s whatever the members say (board rule 1)', (rowState, boardState) => {
    const items = derive({
      sessions: [session('s1', 'working')],
      attempts: [
        attempt('p', 1000, { endReason: 'ended', state: 'FAILED', sessionId: 's1' }),
        attempt('p', 5000, { endReason: 'ended', state: rowState, sessionId: 's1' }),
      ],
    });
    const item = byKey(items, 'attempt:p');
    expect(item).toMatchObject({ state: boardState, boardRule: 1 });
    expect(item.boardReason).toContain(rowState);
  });

  it('a superseded latest row is not an ended one', () => {
    const items = derive({
      sessions: [session('s1', 'working')],
      attempts: [attempt('p', 5000, { endReason: 'superseded', state: 'UNKNOWN', sessionId: 's1' })],
    });
    expect(byKey(items, 'attempt:p')).toMatchObject({ state: 'working', boardRule: 2 });
  });

  it('rows without a session still make the item; an item without members and an open row is unknown', () => {
    const items = derive({ attempts: [attempt('lonely', 1000)] });
    expect(byKey(items, 'attempt:lonely')).toMatchObject({ state: 'unknown', sessionIds: [], boardRule: 7 });
  });

  it('the sessions of a declared item are not members of attempt items', () => {
    const items = derive({
      declared: [{ key: 'd', title: 'D', match: { sessionIds: ['s1'] } }],
      sessions: [session('s1', 'working')],
      attempts: [attempt('p', 1000, { sessionId: 's1' })],
    });
    expect(byKey(items, 'd').sessionIds).toEqual(['s1']);
    expect(byKey(items, 'attempt:p').sessionIds).toEqual([]);
  });
});

describe('T-LF-52 the board states (02 7.11 table)', () => {
  const label = (id: string, state: LifecycleState, over: Partial<WorkItemSession> = {}): WorkItemSession =>
    session(id, state, { label: 'g', ...over });
  const stateOf = (sessions: readonly WorkItemSession[]): DerivedWorkItem => byKey(derive({ sessions }), 'label:g');

  it.each(['working', 'running', 'waiting_tool', 'waiting_agent'] as const)(
    'rule 2: a %s member makes the item working',
    (state) => {
      expect(stateOf([label('a', state), label('b', 'completed')])).toMatchObject({ state: 'working', boardRule: 2 });
    },
  );

  it('rule 2 comes before rule 3: working beats waiting_input', () => {
    expect(stateOf([label('a', 'waiting_input'), label('b', 'working')]).state).toBe('working');
  });

  it('rule 3: a waiting_input member makes the item waiting', () => {
    expect(stateOf([label('a', 'waiting_input'), label('b', 'completed')])).toMatchObject({
      state: 'waiting',
      boardRule: 3,
    });
  });

  it('rule 4: the most recently started member decides when it is completed or failed', () => {
    const older = label('old', 'failed', { startedAt: 1000 });
    const newer = label('new', 'completed', { startedAt: 9000 });
    expect(stateOf([older, newer])).toMatchObject({ state: 'completed', boardRule: 4 });
    expect(
      stateOf([label('old', 'completed', { startedAt: 1000 }), label('new', 'failed', { startedAt: 9000 })]),
    ).toMatchObject({
      state: 'failed',
      boardRule: 4,
    });
  });

  it('rule 5: a stale member needs investigation', () => {
    expect(
      stateOf([label('a', 'stale', { startedAt: 9000 }), label('b', 'completed', { startedAt: 1000 })]),
    ).toMatchObject({
      state: 'stale',
      boardRule: 5,
    });
  });

  it('rule 6: all open members at a turn end read as waiting (finished or waiting cannot be told)', () => {
    expect(
      stateOf([label('a', 'turn_ended', { startedAt: 9000 }), label('b', 'turn_ended', { startedAt: 8000 })]),
    ).toMatchObject({
      state: 'waiting',
      boardRule: 6,
    });
    expect(
      stateOf([label('a', 'turn_ended', { startedAt: 9000 }), label('b', 'completed', { startedAt: 1000 })]),
    ).toMatchObject({
      state: 'waiting',
      boardRule: 6,
    });
  });

  it('rule 7: anything else is unknown', () => {
    expect(stateOf([label('a', 'unknown')])).toMatchObject({ state: 'unknown', boardRule: 7 });
    expect(stateOf([label('a', 'turn_ended'), label('b', 'unknown')])).toMatchObject({
      state: 'unknown',
      boardRule: 7,
    });
  });

  it('every item says why it sits in its column', () => {
    const item = stateOf([label('a', 'waiting_input')]);
    expect(item.boardReason.length).toBeGreaterThan(0);
    expect(item.evidence).toEqual([{ sessionId: 'a', state: 'waiting_input', ruleId: 'S-7e' }]);
  });
});

describe('item fields and determinism', () => {
  it('since is the earliest start of a member or a row, lastActivityAt the newest activity of the members', () => {
    const items = derive({
      sessions: [
        session('s1', 'working', { label: 'g', startedAt: 5000, lastActivityAt: 9000 }),
        session('s2', 'completed', { label: 'g', startedAt: 3000, lastActivityAt: 4000 }),
      ],
    });
    expect(byKey(items, 'label:g')).toMatchObject({ since: 3000, lastActivityAt: 9000 });
    const withRows = derive({
      sessions: [session('s1', 'working', { startedAt: 5000 })],
      attempts: [attempt('p', 1000, { sessionId: 's1' })],
    });
    expect(byKey(withRows, 'attempt:p').since).toBe(1000);
  });

  it('the result does not depend on the order of the inputs', () => {
    const sessions = [
      session('s1', 'working', { label: 'a' }),
      session('s2', 'completed', { label: 'a' }),
      session('s3', 'waiting_input', { label: 'b' }),
      session('s4', 'failed'),
    ];
    const attempts = [
      attempt('p', 1000, { endReason: 'ended', state: 'FAILED', sessionId: 's4' }),
      attempt('p', 2000, { sessionId: 's1' }),
      attempt('q', 3000, { sessionId: 's3' }),
    ];
    const declared = [{ key: 'd', title: 'D', match: { labels: ['b'] } }];
    const normal = derive({ sessions, attempts, declared });
    const reversed = derive({ sessions: [...sessions].reverse(), attempts: [...attempts].reverse(), declared });
    const sorted = (items: readonly DerivedWorkItem[]): unknown =>
      items.map((item) => ({
        ...item,
        sessionIds: [...item.sessionIds].sort(),
        evidence: [...item.evidence].sort((x, y) => (x.sessionId < y.sessionId ? -1 : 1)),
      }));
    expect(sorted(reversed)).toEqual(sorted(normal));
  });
});
