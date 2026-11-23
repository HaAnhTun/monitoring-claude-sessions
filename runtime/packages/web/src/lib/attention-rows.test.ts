import { describe, expect, it } from 'vitest';

import { makeSession, makeState, makeTerminalLink, makeTerminalSession, sessionId } from '../test/fixtures/index.ts';
import { buildAttentionRows, effectiveScope, itemsOf, selectedKeyOf } from './attention-rows.ts';
import { liveSessionOf, type LiveSession } from './workspace-view.ts';

const SINCE = '2026-01-01T00:00:05.000Z';

function terminal(n: number, link: Parameters<typeof makeTerminalLink>[0]): LiveSession {
  return liveSessionOf(makeTerminalSession(n, { folderKey: `folder-${String(n)}`, link: makeTerminalLink(link) }));
}

const tracked = (n: number): LiveSession =>
  terminal(n, { status: 'linked', sessionId: sessionId(n), transcript: 'tracked', registryStatus: 'busy' });

const needsYou = makeSession({
  id: sessionId(1),
  label: 'FIXTURE title',
  labelSource: 'custom_title',
  state: makeState('waiting_input', { rule: 'S-6a', waitReason: 'permission', since: SINCE }),
});
const working = makeSession({ id: sessionId(2), state: makeState('working', { rule: 'S-7a' }) });
const elsewhere = makeSession({ id: sessionId(3), state: makeState('failed', { rule: 'S-3a' }) });

describe('buildAttentionRows', () => {
  it('here: one row per live terminal, the monitor row when there is one, never a session started elsewhere', () => {
    const rows = buildAttentionRows({
      sessions: [elsewhere, working, needsYou],
      terminals: [tracked(1), tracked(2)],
      scope: 'here',
    });
    expect(rows[0]).toEqual({
      key: `s:${sessionId(1)}`,
      sessionId: sessionId(1),
      terminal: 'fixture-term-1',
      folderKey: 'folder-1',
      cls: { posture: 'needs_you', reason: 'permission', family: 'S-6' },
      since: SINCE,
      label: 'FIXTURE title',
      labelSource: 'custom_title',
    });
    expect(rows.map((row) => [row.key, row.terminal, row.cls.posture])).toEqual([
      [`s:${sessionId(1)}`, 'fixture-term-1', 'needs_you'],
      [`s:${sessionId(2)}`, 'fixture-term-2', 'working'],
    ]);
  });

  it('all: the other sessions follow, and a session that is a terminal appears once with its terminal name', () => {
    const rows = buildAttentionRows({
      sessions: [needsYou, elsewhere, needsYou],
      terminals: [tracked(1)],
      scope: 'all',
    });
    expect(rows.map((row) => [row.key, row.terminal, row.folderKey, row.cls.posture])).toEqual([
      [`s:${sessionId(1)}`, 'fixture-term-1', 'folder-1', 'needs_you'],
      [`s:${sessionId(3)}`, null, null, 'failed'],
    ]);
  });

  it.each([
    [
      'not linked after the 30 s of the server',
      { status: 'pending', reason: 'no_registry' },
      't:fixture-term-4',
      'needs_you',
    ],
    ['still starting', { status: 'pending', reason: null }, 't:fixture-term-4', 'unknown'],
    [
      'the registry says waiting, no transcript yet',
      { status: 'linked', sessionId: sessionId(4), transcript: 'none', registryStatus: 'waiting' },
      `s:${sessionId(4)}`,
      'needs_you',
    ],
    [
      'tracked, the monitor row is not loaded',
      { status: 'linked', sessionId: sessionId(4), transcript: 'tracked', registryStatus: 'waiting' },
      `s:${sessionId(4)}`,
      'unknown',
    ],
  ] as const)('a terminal without a monitor row: %s', (_title, link, key, posture) => {
    const [row] = buildAttentionRows({ sessions: [needsYou], terminals: [terminal(4, link)], scope: 'here' });
    expect(row).toMatchObject({ key, terminal: 'fixture-term-4', since: null, label: null, labelSource: null });
    expect(row?.cls).toMatchObject({ posture, family: 'link' });
  });

  it('a terminal that is gone leaves no row behind, so nothing can fire for it', () => {
    const before = buildAttentionRows({ sessions: [needsYou], terminals: [tracked(1), tracked(2)], scope: 'here' });
    const after = buildAttentionRows({ sessions: [needsYou], terminals: [tracked(2)], scope: 'here' });
    expect(before).toHaveLength(2);
    expect(after.map((row) => row.terminal)).toEqual(['fixture-term-2']);
  });

  it('the scope is the preference on a user instance and always all on a task instance', () => {
    expect(effectiveScope(undefined, 'user')).toBe('here');
    expect(effectiveScope('all', 'user')).toBe('all');
    expect(effectiveScope('here', 'task')).toBe('all');
    expect(effectiveScope('here', undefined)).toBe('here');
  });

  it('selectedKeyOf reads the selected terminal first, then the open session page', () => {
    const rows = buildAttentionRows({ sessions: [needsYou], terminals: [tracked(1)], scope: 'here' });
    expect(selectedKeyOf(rows, { terminal: 'fixture-term-1', sessionId: null })).toBe(`s:${sessionId(1)}`);
    expect(selectedKeyOf(rows, { terminal: 'gone', sessionId: sessionId(7) })).toBe(`s:${sessionId(7)}`);
    expect(selectedKeyOf(rows, { terminal: null, sessionId: null })).toBeNull();
  });

  it('itemsOf adds the level and keeps the order', () => {
    const rows = buildAttentionRows({ sessions: [elsewhere, needsYou], terminals: [], scope: 'all' });
    expect(itemsOf(rows, () => true).map((item) => item.level)).toEqual(['failed', 'needs_you']);
    expect(itemsOf(rows, () => false).map((item) => [item.level, item.unseen])).toEqual([
      ['idle', false],
      ['needs_you', false],
    ]);
  });
});
