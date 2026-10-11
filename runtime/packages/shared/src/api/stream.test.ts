import { describe, expect, it } from 'vitest';

import {
  CHANGE_KINDS,
  CHANGE_OPS,
  STREAM_EVENT_NAMES,
  STREAM_HEARTBEAT_MS,
  STREAM_RESET_REASONS,
  STREAM_RETRY_MS,
  StreamChangeSchema,
  safeParseStreamChange,
  StreamEventSchemas,
  StreamHeartbeatSchema,
  StreamHelloSchema,
  StreamResetSchema,
  WorkflowRunItemSchema,
} from './stream.ts';

/** A copy of `value` without the key `omit` (the tests need an object with a missing field). */
function without(value: object, omit: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omit));
}

const AT = '2026-10-11T10:00:00.000Z';
const IID = '3f2b8c1e-0d4a-4b7e-9c11-5a6d7e8f9a0b';
const SID = '0b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d11';

function change(kind: string, op: string, data: unknown, sessionId: string | null = SID) {
  return { seq: 5, at: AT, instanceId: IID, kind, op, sessionId, data };
}

describe('stream frames (03 9.2)', () => {
  it('names the four SSE events and the constants of the protocol', () => {
    expect([...STREAM_EVENT_NAMES]).toEqual(['hello', 'change', 'heartbeat', 'reset']);
    expect(STREAM_RETRY_MS).toBe(3000);
    expect(STREAM_HEARTBEAT_MS).toBe(15000);
    expect(Object.keys(StreamEventSchemas).sort()).toEqual([...STREAM_EVENT_NAMES].sort());
  });

  it('hello carries identity, epoch, head and the build', () => {
    const hello = {
      instanceId: IID,
      epoch: 'deadbeef',
      headSeq: 7,
      heartbeatMs: 15000,
      serverTime: AT,
      runtimeVersion: '3.0.0',
      codeStamp: 'abc',
    };
    expect(StreamHelloSchema.parse(hello)).toEqual(hello);
    expect(StreamHelloSchema.safeParse({ ...hello, epoch: 'nothex!!' }).success).toBe(false);
    expect(StreamHelloSchema.safeParse({ ...hello, extra: 1 }).success).toBe(false);
    expect(StreamHelloSchema.safeParse(without(hello, 'codeStamp')).success).toBe(false);
  });

  it('heartbeat carries head, epoch and time', () => {
    expect(StreamHeartbeatSchema.safeParse({ headSeq: 7, epoch: 'deadbeef', serverTime: AT }).success).toBe(true);
    expect(StreamHeartbeatSchema.safeParse({ headSeq: 7, serverTime: AT }).success).toBe(false);
  });

  it('reset has the four reasons', () => {
    expect([...STREAM_RESET_REASONS]).toEqual(['cursor_too_old', 'cursor_ahead', 'epoch_changed', 'cursor_invalid']);
    for (const reason of STREAM_RESET_REASONS) {
      expect(StreamResetSchema.safeParse({ headSeq: 3, reason }).success).toBe(true);
    }
    expect(StreamResetSchema.safeParse({ headSeq: 3, reason: 'cursor_expired' }).success).toBe(false);
  });
});

describe('StreamChange (03 9.1, 9.2; registry section 4)', () => {
  it('has the eleven kinds and four ops', () => {
    expect([...CHANGE_KINDS]).toEqual([
      'session',
      'agent',
      'workflow',
      'tool_call',
      'event',
      'transcript',
      'work_item',
      'usage',
      'alert',
      'health',
      'attempt',
    ]);
    expect([...CHANGE_OPS]).toEqual(['upsert', 'delete', 'append', 'invalidate']);
  });

  it('accepts exactly the twelve kind/op pairs with their data shape', () => {
    const valid: [string, string, unknown][] = [
      ['session', 'upsert', null],
      ['session', 'delete', null],
      ['agent', 'upsert', null],
      ['workflow', 'upsert', null],
      ['tool_call', 'upsert', { items: [], truncated: false }],
      ['event', 'append', { items: [], count: 0, truncated: false }],
      ['transcript', 'append', { agentId: 'main', sizeBytes: 10 }],
      ['transcript', 'append', null],
      ['work_item', 'upsert', null],
      ['usage', 'invalidate', { sessionId: SID }],
      ['alert', 'upsert', null],
      ['attempt', 'upsert', { ids: [1, 2], truncated: false }],
    ];
    for (const [kind, op, data] of valid) {
      expect(StreamChangeSchema.safeParse(change(kind, op, data)).success, `${kind}/${op}`).toBe(true);
    }
  });

  it('rejects a pair with the wrong op or the wrong data', () => {
    const invalid: [string, string, unknown][] = [
      ['session', 'append', null],
      ['session', 'delete', { id: 1 }],
      ['event', 'upsert', { items: [], count: 0, truncated: false }],
      ['event', 'append', null],
      ['usage', 'invalidate', null],
      ['attempt', 'upsert', null],
      ['tool_call', 'upsert', null],
      ['transcript', 'append', { agentId: 'main' }],
      ['usage', 'invalidate', { sessionId: 'not-a-session' }],
      ['task', 'upsert', null],
      ['config', 'upsert', null],
    ];
    for (const [kind, op, data] of invalid) {
      expect(StreamChangeSchema.safeParse(change(kind, op, data)).success, `${kind}/${op}`).toBe(false);
    }
  });

  it('checks the envelope: seq, instance id, strictness', () => {
    expect(StreamChangeSchema.safeParse({ ...change('session', 'delete', null), seq: 0 }).success).toBe(false);
    expect(StreamChangeSchema.safeParse({ ...change('session', 'delete', null), instanceId: 'x' }).success).toBe(false);
    expect(StreamChangeSchema.safeParse({ ...change('session', 'delete', null), extra: 1 }).success).toBe(false);
    expect(StreamChangeSchema.safeParse(change('alert', 'upsert', null, null)).success).toBe(true);
  });

  it('safeParseStreamChange dispatches on kind and op, with the error of that one pair', () => {
    const ok = safeParseStreamChange(change('usage', 'invalidate', { sessionId: SID }));
    expect(ok.success).toBe(true);
    const bad = safeParseStreamChange(change('usage', 'invalidate', null));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues.every((issue) => issue.path[0] === 'data')).toBe(true);
    for (const value of [null, 3, 'x', [], {}, change('session', 'append', null), change('nope', 'upsert', null)]) {
      expect(safeParseStreamChange(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it('data null is the way to say the entity is gone (clients invalidate it)', () => {
    const parsed = StreamChangeSchema.parse(change('work_item', 'upsert', null));
    expect(parsed.data).toBeNull();
  });
});

describe('WorkflowRunItem', () => {
  it('parses a run', () => {
    const run = {
      runId: 'wf_abc',
      seq: 2,
      sessionId: SID,
      name: null,
      state: {
        state: 'working',
        presence: 'open',
        waitReason: null,
        staleKind: null,
        endReason: null,
        turnOutcome: null,
        basis: 'observed',
        confidence: 'high',
        rule: 'S-1',
        evidence: [],
        since: null,
        evaluatedAt: null,
        legacyState: 'RUNNING',
      },
      agentCount: null,
      started: 2,
      results: 1,
      failed: 0,
      startedAt: AT,
      endedAt: null,
    };
    expect(WorkflowRunItemSchema.parse(run)).toEqual(run);
    expect(WorkflowRunItemSchema.safeParse({ ...run, runId: 'abc' }).success).toBe(false);
  });
});
