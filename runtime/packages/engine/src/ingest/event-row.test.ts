import { EVENT_KINDS, type EventKind } from '@mcs/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { EventInsert } from '../db/repos/events.ts';
import {
  ROW_LIMITS,
  eventRow,
  permissionDeniedKey,
  promptKey,
  severityOfKind,
  taskKey,
  toolBatchKey,
  toolCallKey,
  toolEndKey,
  type EventRowWrite,
} from './event-row.ts';

const SESSION = '22222222-2222-4222-8222-222222222222';
const STAMP = { at: 1_700_000_000_000, rank: 20, tie: 't' };

describe('severityOfKind (02 4.1.2)', () => {
  const two: readonly EventKind[] = ['tool.failure', 'turn.failure', 'api.error', 'hook.handler_error'];
  const one: readonly EventKind[] = [
    'permission.denied',
    'turn.interrupt',
    'hook.unknown',
    'monitor.gap',
    'monitor.reconcile',
  ];

  it('is 2 for failures, 1 for warnings and 0 for every other stored kind', () => {
    for (const kind of EVENT_KINDS) {
      const expected = two.includes(kind) ? 2 : one.includes(kind) ? 1 : 0;
      expect(severityOfKind(kind), kind).toBe(expected);
    }
  });
});

describe('eventRow', () => {
  it('fills every column the caller did not name with null and derives the severity from the kind', () => {
    const row = eventRow({
      sessionUid: SESSION,
      kind: 'tool.failure',
      sources: 1,
      stamp: STAMP,
      tsSource: 'hook_received',
      receivedAt: STAMP.at,
      eventUid: '44444444-4444-4444-8444-444444444444',
    });
    expect(row.severity).toBe(2);
    expect(row.flags).toEqual([]);
    const nulls = Object.entries(row)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    expect(nulls).toEqual(
      expect.arrayContaining(['agentUid', 'entryKind', 'naturalKey', 'recordUuid', 'fileId', 'summary', 'detail']),
    );
    expect(row.eventUid).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('is accepted by EventsRepo.insert as it is (the shape of 03 3.6)', () => {
    expectTypeOf<EventRowWrite>().toExtend<EventInsert>();
    expectTypeOf<EventInsert>().toExtend<EventRowWrite>();
  });
});

describe('eventRow column limits (03 3.5 CHECKs)', () => {
  const base = {
    sessionUid: SESSION,
    kind: 'tool.call',
    sources: 2,
    stamp: STAMP,
    tsSource: 'record',
    receivedAt: STAMP.at,
  } as const;

  it('cuts the strings a provider controls to the column limits and drops an id that is too long', () => {
    const row = eventRow({
      ...base,
      toolName: 't'.repeat(500),
      subtype: 's'.repeat(100),
      recordType: 'r'.repeat(100),
      hookEvent: 'h'.repeat(100),
      summary: 'm'.repeat(1000),
      messageId: 'i'.repeat(129),
      recordUuid: 'u'.repeat(81),
    });
    expect(row.toolName).toHaveLength(ROW_LIMITS.toolName);
    expect(row.subtype).toHaveLength(ROW_LIMITS.subtype);
    expect(row.recordType).toHaveLength(ROW_LIMITS.recordType);
    expect(row.hookEvent).toHaveLength(ROW_LIMITS.hookEvent);
    expect(row.summary).toHaveLength(ROW_LIMITS.summary);
    expect(row.messageId).toBeNull();
    expect(row.recordUuid).toBeNull();
  });

  it('keeps values at the limit as they are and counts code points, not UTF-16 units', () => {
    const row = eventRow({
      ...base,
      messageId: 'i'.repeat(128),
      recordUuid: 'u'.repeat(80),
      toolName: '😀'.repeat(200),
    });
    expect(row.messageId).toHaveLength(128);
    expect(row.recordUuid).toHaveLength(80);
    expect(Array.from(row.toolName ?? '')).toHaveLength(200);
  });
});

describe('natural keys (02 4.1.1)', () => {
  it('build the documented spellings', () => {
    expect(toolCallKey('toolu_1')).toBe('tool.call:toolu_1');
    expect(toolEndKey('toolu_1')).toBe('tool.end:toolu_1');
    expect(permissionDeniedKey('toolu_1')).toBe('permission.denied:toolu_1');
    expect(promptKey(SESSION, 'p-1')).toBe(`prompt:${SESSION}:p-1`);
    expect(toolBatchKey(SESSION, 'abc')).toBe(`tool.batch:${SESSION}:abc`);
    expect(taskKey('created', SESSION, 't1')).toBe(`task.created:${SESSION}:t1`);
    expect(taskKey('completed', SESSION, 't1')).toBe(`task.completed:${SESSION}:t1`);
  });

  it('are null when the id is missing or not usable', () => {
    expect(toolCallKey(null)).toBeNull();
    expect(toolEndKey(undefined)).toBeNull();
    expect(toolEndKey('has space')).toBeNull();
    expect(permissionDeniedKey('')).toBeNull();
    expect(promptKey(SESSION, null)).toBeNull();
    expect(toolBatchKey(SESSION, null)).toBeNull();
    expect(taskKey('created', SESSION, '')).toBeNull();
    expect(taskKey('created', SESSION, 'x'.repeat(129))).toBeNull();
  });

  it('stay inside the 3 to 300 character CHECK of the events table', () => {
    const longest = toolBatchKey(SESSION, 'f'.repeat(32));
    expect(longest?.length).toBeLessThanOrEqual(300);
    expect(taskKey('completed', SESSION, 'x'.repeat(128))?.length).toBeLessThanOrEqual(300);
  });
});
