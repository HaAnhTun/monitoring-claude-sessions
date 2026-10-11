import { describe, expect, it } from 'vitest';

import {
  EXPORT_FORMAT,
  EXPORT_INCLUDES,
  EXPORT_RECORD_TYPES,
  ExportLineSchema,
  ExportLineSchemas,
  ExportQuerySchema,
  ExportSummarySchema,
} from './export.ts';
import { fromQuery } from './filters.ts';

const AT = '2026-10-11T10:00:00.000Z';
const SID = '0b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d11';
const IID = '3f2b8c1e-0d4a-4b7e-9c11-5a6d7e8f9a0b';

const header = {
  type: 'header',
  format: 'mcs.export/1',
  instanceId: IID,
  slug: 'demo',
  exportedAt: AT,
  runtimeVersion: '3.0.0',
  dbSchemaVersion: 1,
  scope: { from: null, to: AT, sessions: [SID] },
  include: ['sessions', 'events'],
  redaction: 'standard',
  includeContent: false,
  privacyNote: 'Metadata only: no prompt, reply, thinking or tool result text.',
};

const trailer = { type: 'trailer', counts: { session: 1, event: 4 }, missingTranscripts: [], sha256: 'a'.repeat(64) };

describe('export query (03 11.1)', () => {
  it('parses every parameter from the URL form', () => {
    expect(
      fromQuery(ExportQuerySchema, {
        session: SID,
        workItem: '3',
        range: '7d',
        include: 'sessions,events,usage',
        redaction: 'standard',
        includeContent: '1',
      }),
    ).toEqual({
      session: [SID],
      workItem: 3,
      range: '7d',
      include: ['sessions', 'events', 'usage'],
      redaction: 'standard',
      includeContent: true,
    });
    expect(fromQuery(ExportQuerySchema, { redaction: 'strict' })).toEqual({ redaction: 'strict' });
    expect(fromQuery(ExportQuerySchema, {})).toEqual({});
  });

  it('refuses unknown includes, redactions and more than 500 sessions', () => {
    expect(ExportQuerySchema.safeParse({ include: 'sessions,everything' }).success).toBe(false);
    expect(ExportQuerySchema.safeParse({ redaction: 'none' }).success).toBe(false);
    // strict redaction refuses content (03 11.1)
    expect(ExportQuerySchema.safeParse({ redaction: 'strict', includeContent: '1' }).success).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`).join(
      ',',
    );
    expect(ExportQuerySchema.safeParse({ session: many }).success).toBe(false);
    expect(ExportQuerySchema.safeParse({ nope: '1' }).success).toBe(false);
  });

  it('lists the ten includes of the format', () => {
    expect([...EXPORT_INCLUDES]).toEqual([
      'sessions',
      'agents',
      'workflows',
      'work_items',
      'events',
      'tool_calls',
      'turns',
      'usage',
      'transitions',
      'alerts',
    ]);
  });

  it('ExportSummary has lines, bytes, sha256, counts, includeContent', () => {
    const summary = { lines: 10, bytes: 1000, sha256: 'b'.repeat(64), counts: { session: 1 }, includeContent: false };
    expect(ExportSummarySchema.parse(summary)).toEqual(summary);
    expect(ExportSummarySchema.safeParse({ ...summary, sha256: 'xyz' }).success).toBe(false);
  });
});

describe('export lines (mcs.export/1)', () => {
  it('format name is mcs.export/1', () => {
    expect(EXPORT_FORMAT).toBe('mcs.export/1');
  });

  it('header and trailer parse and are strict', () => {
    expect(ExportLineSchema.parse(header)).toEqual(header);
    expect(ExportLineSchema.parse(trailer)).toEqual(trailer);
    expect(ExportLineSchema.safeParse({ ...header, format: 'mcs.export/2' }).success).toBe(false);
    expect(ExportLineSchema.safeParse({ ...header, extra: 1 }).success).toBe(false);
    expect(ExportLineSchema.safeParse({ ...trailer, sha256: 'a' }).success).toBe(false);
  });

  it('record lines wrap their data under data and only add the type discriminator', () => {
    const usage = {
      messageKey: 'm:abc',
      sessionId: SID,
      agentId: 'main',
      model: 'm-1',
      ts: AT,
      input: 1,
      output: 2,
      cacheRead: null,
      cacheCreation: 4,
      cacheCreation5m: 4,
      cacheCreation1h: null,
      thinking: null,
      finalized: true,
      synthetic: false,
      usageSource: 'transcript',
      files: 1,
    };
    expect(ExportLineSchema.parse({ type: 'usage', data: usage })).toEqual({ type: 'usage', data: usage });
    expect(ExportLineSchema.safeParse({ type: 'usage', data: { ...usage, extra: 1 } }).success).toBe(false);
    expect(ExportLineSchema.safeParse({ type: 'usage', ...usage }).success).toBe(false);
    const turn = {
      sessionId: SID,
      agentId: 'main',
      promptId: null,
      startedAt: AT,
      endedAt: null,
      endKind: null,
      origin: 'user',
      toolCount: 2,
    };
    expect(ExportLineSchema.safeParse({ type: 'turn', data: turn }).success).toBe(true);
    const alert = {
      id: 1,
      seq: 1,
      ruleId: 'hook_gap',
      rule: 'hook_gap',
      severity: 'warning',
      status: 'open',
      title: 'Hooks missed 3 tool calls in this session',
      scope: { kind: 'session', key: SID },
      sessionId: SID,
      since: AT,
      lastFiredAt: AT,
      fireCount: 1,
      resolvedAt: null,
      resolvedReason: null,
      detail: {},
    };
    expect(ExportLineSchema.safeParse({ type: 'alert', data: alert }).success).toBe(true);
    const transition = {
      id: 1,
      at: AT,
      agentId: null,
      from: null,
      to: 'working',
      rule: 'S-1',
      basis: 'observed',
      confidence: 'high',
      evidence: [],
      sessionId: SID,
    };
    expect(ExportLineSchema.safeParse({ type: 'transition', data: transition }).success).toBe(true);
    expect(
      ExportLineSchema.safeParse({ type: 'transition', data: { ...transition, sessionId: undefined } }).success,
    ).toBe(false);
  });

  it('transcript lines hold at most 500 entries', () => {
    const entry = { i: 0, t: AT, k: 'say', text: 'x' };
    const line = (n: number) => ({
      type: 'transcript',
      sessionId: SID,
      agentId: 'main',
      entries: Array.from({ length: n }, () => entry),
    });
    expect(ExportLineSchema.safeParse(line(500)).success).toBe(true);
    expect(ExportLineSchema.safeParse(line(501)).success).toBe(false);
  });

  it('unknown line types are refused and every record type has a schema (JSON Schema generation input)', () => {
    expect(ExportLineSchema.safeParse({ type: 'attempt', data: {} }).success).toBe(false);
    expect([...EXPORT_RECORD_TYPES]).toEqual([
      'session',
      'agent',
      'workflow',
      'work_item',
      'turn',
      'event',
      'tool_call',
      'usage',
      'transition',
      'alert',
    ]);
    expect(Object.keys(ExportLineSchemas).sort()).toEqual(
      ['header', 'trailer', 'transcript', ...EXPORT_RECORD_TYPES].sort(),
    );
  });

  it('event lines carry no label fields (the labels are resolved from the session lines)', () => {
    const event = {
      id: 1,
      seq: 1,
      key: 'h:1',
      sessionId: SID,
      agentId: 'main',
      at: AT,
      atSource: 'record',
      receivedAt: AT,
      sources: ['hook'],
      source: 'hook',
      type: 'turn.stop',
      category: 'lifecycle',
      severity: 'info',
      hookEvent: 'Stop',
      entryKind: null,
      toolName: null,
      toolUseId: null,
      toolStatus: null,
      durationMs: null,
      summary: '',
      details: {},
      transcriptRef: null,
    };
    expect(ExportLineSchema.safeParse({ type: 'event', data: event }).success).toBe(true);
    expect(
      ExportLineSchema.safeParse({ type: 'event', data: { ...event, sessionLabel: 'x', agentLabel: null } }).success,
    ).toBe(false);
  });
});
