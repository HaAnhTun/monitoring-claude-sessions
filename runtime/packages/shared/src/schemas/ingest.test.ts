import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { HookEnvelopeV1 } from '../protocol/hook-envelope.ts';
import type { HookRouteV1 } from '../protocol/routes.ts';
import {
  HookEnvelopeV1Schema,
  HookRouteV1Schema,
  IngestHealthSchema,
  NudgeBodySchema,
  TranscriptRecordShape,
  type IngestHealth,
} from './ingest.ts';

const UUID = '6a0f3c1e-1b2c-4d3e-8f40-0123456789ab';
const SID = '11111111-2222-4333-8444-555555555555';

// The example line of 02 2.3.1 (placeholders only).
function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'hook',
    instance_id: UUID,
    event_uid: '0f8b5e2a-7c41-4e0b-9d3a-2b1c0d9e8f7a',
    received_at: 1791727200123,
    event: 'PreToolUse',
    argv_event: 'PreToolUse',
    session_id: SID,
    transcript_path: 'C:/Users/<user>/.claude/projects/D--repo/' + SID + '.jsonl',
    cwd: 'D:/repo',
    prompt_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    agent_id: null,
    agent_type: null,
    tool_use_id: 'toolu_PLACEHOLDER',
    permission_mode: 'default',
    claude_pid: 18380,
    payload_bytes: 512,
    content_hash: '0123456789abcdef0123456789abcdef',
    handler: { version: '3.0.0', pid: 20112, async: true },
    flags: [],
    data: {
      tool_name: 'Bash',
      tool_summary: 'npm test',
      tool_input_hash: 'fedcba9876543210fedcba9876543210',
      tool_input_bytes: 61,
      tool_input_keys: 'command,description',
    },
    ...over,
  };
}

function accepts(value: unknown): boolean {
  return HookEnvelopeV1Schema.safeParse(value).success;
}

describe('HookEnvelopeV1Schema', () => {
  it('accepts the example line of 02 2.3.1', () => {
    expect(HookEnvelopeV1Schema.safeParse(envelope()).success).toBe(true);
  });

  it('is the same type as HookEnvelopeV1 (compile-time check)', () => {
    expectTypeOf<z.infer<typeof HookEnvelopeV1Schema>>().toEqualTypeOf<HookEnvelopeV1>();
  });

  it('round trips through JSON text exactly (the spool line)', () => {
    const line = JSON.stringify(envelope());
    const parsed = HookEnvelopeV1Schema.parse(JSON.parse(line));
    expect(JSON.stringify(parsed)).toBe(line);
  });

  it('accepts a probe and every nullable id as null', () => {
    expect(
      accepts(
        envelope({
          kind: 'probe',
          session_id: null,
          transcript_path: null,
          cwd: null,
          prompt_id: null,
          agent_id: null,
          agent_type: null,
          tool_use_id: null,
          permission_mode: null,
          claude_pid: null,
        }),
      ),
    ).toBe(true);
  });

  it('accepts an empty argv_event, the Unknown event and flags of the closed set', () => {
    expect(accepts(envelope({ argv_event: '', event: 'Unknown' }))).toBe(true);
    expect(
      accepts(
        envelope({
          flags: [
            'stdin_truncated',
            'invalid_session_id',
            'event_mismatch',
            'minimal',
            'redacted',
            'routed_by_cwd',
            'routed_by_session_pin',
            'data_truncated:calls',
          ],
        }),
      ),
    ).toBe(true);
  });

  it('accepts the calls list of PostToolBatch', () => {
    const calls = Array.from({ length: 64 }, (_v, i) => ({ tool_use_id: 'toolu_' + String(i), tool_name: 'Read' }));
    expect(accepts(envelope({ event: 'PostToolBatch', data: { calls, calls_extra: null } }))).toBe(true);
  });

  it('accepts every data scalar kind', () => {
    expect(accepts(envelope({ data: { s: 'x', n: 1.5, i: 0, b: false, z: null, empty: '' } }))).toBe(true);
    expect(accepts(envelope({ data: {} }))).toBe(true);
  });

  it('rejects an unknown top-level key (strict object), including the key of the hook payload', () => {
    expect(accepts(envelope({ extra: 1 }))).toBe(false);
    expect(accepts(envelope({ hook_event_name: 'PreToolUse' }))).toBe(false);
    expect(accepts(envelope({ prompt: 'a full prompt body' }))).toBe(false);
  });

  it('rejects an envelope with any required field removed', () => {
    for (const key of Object.keys(envelope())) {
      const copy = envelope();
      Reflect.deleteProperty(copy, key);
      expect(accepts(copy), `without ${key}`).toBe(false);
    }
  });

  it.each([
    ['version 2', { v: 2 }],
    ['version string', { v: '1' }],
    ['unknown kind', { kind: 'other' }],
    ['instance id not a uuid', { instance_id: 'not-a-uuid' }],
    ['instance id upper case', { instance_id: UUID.toUpperCase() }],
    ['instance id null', { instance_id: null }],
    ['event uid empty', { event_uid: '' }],
    ['received_at negative', { received_at: -1 }],
    ['received_at float', { received_at: 1.5 }],
    ['received_at string', { received_at: '1791727200123' }],
    ['received_at NaN', { received_at: Number.NaN }],
    ['event empty', { event: '' }],
    ['event too long', { event: 'A'.repeat(65) }],
    ['argv_event too long', { argv_event: 'A'.repeat(65) }],
    ['argv_event null', { argv_event: null }],
    ['session id upper case', { session_id: 'ABCDEF01-2345-6789-ABCD-EF0123456789' }],
    ['session id empty', { session_id: '' }],
    ['session id trailing newline', { session_id: SID + String.fromCharCode(10) }],
    ['agent id too short', { agent_id: 'ab' }],
    ['agent id with a slash', { agent_id: 'abc/def' }],
    ['tool use id with a space', { tool_use_id: 'tool use' }],
    ['tool use id too long', { tool_use_id: 'x'.repeat(129) }],
    ['prompt id empty', { prompt_id: '' }],
    ['agent type too long', { agent_type: 'x'.repeat(65) }],
    ['agent type with a control character', { agent_type: 'a' + String.fromCharCode(7) + 'b' }],
    ['permission mode with a newline', { permission_mode: 'a' + String.fromCharCode(10) }],
    ['transcript path too long', { transcript_path: 'x'.repeat(1025) }],
    ['cwd too long', { cwd: 'x'.repeat(1025) }],
    ['cwd number', { cwd: 5 }],
    ['pid negative', { claude_pid: -1 }],
    ['pid float', { claude_pid: 1.5 }],
    ['pid beyond 10 digits', { claude_pid: 10_000_000_000 }],
    ['pid string', { claude_pid: '18380' }],
    ['payload bytes negative', { payload_bytes: -1 }],
    ['payload bytes float', { payload_bytes: 0.5 }],
    ['content hash upper case', { content_hash: '0123456789ABCDEF0123456789ABCDEF' }],
    ['content hash too short', { content_hash: '0123456789abcdef' }],
    ['content hash too long', { content_hash: '0123456789abcdef0123456789abcdef0' }],
    ['handler not an object', { handler: 'x' }],
    ['handler without pid', { handler: { version: '3.0.0', async: true } }],
    ['handler with an extra key', { handler: { version: '3.0.0', pid: 1, async: true, cwd: 'x' } }],
    ['handler async string', { handler: { version: '3.0.0', pid: 1, async: 'true' } }],
    ['flag outside the closed set', { flags: ['unknown_flag'] }],
    ['flag not a string', { flags: [1] }],
    ['33 flags', { flags: Array.from({ length: 33 }, () => 'redacted') }],
    ['flags not a list', { flags: 'redacted' }],
    ['data null', { data: null }],
    ['data a list', { data: [] }],
    ['data value an object', { data: { nested: { a: 1 } } }],
    ['data value a list of numbers', { data: { calls: [1, 2] } }],
    ['data list element holding a number', { data: { calls: [{ a: 1 }] } }],
    ['data list element holding a nested object', { data: { calls: [{ a: { b: 'c' } }] } }],
    ['data list of lists', { data: { calls: [['a']] } }],
    ['data string beyond the envelope size', { data: { big: 'x'.repeat(16 * 1024 + 1) } }],
    ['65 data keys', { data: Object.fromEntries(Array.from({ length: 65 }, (_v, i) => ['k' + String(i), i])) }],
    ['data key too long', { data: { ['k'.repeat(65)]: 1 } }],
    ['data number infinite', { data: { n: Number.POSITIVE_INFINITY } }],
  ])('rejects %s', (_label, over) => {
    expect(accepts(envelope(over))).toBe(false);
  });

  it('accepts exactly 64 data keys and exactly 32 flags', () => {
    expect(
      accepts(envelope({ data: Object.fromEntries(Array.from({ length: 64 }, (_v, i) => ['k' + String(i), i])) })),
    ).toBe(true);
    expect(accepts(envelope({ flags: Array.from({ length: 32 }, () => 'redacted') }))).toBe(true);
  });

  it('accepts boundary lengths of every capped field', () => {
    expect(
      accepts(
        envelope({
          event: 'A'.repeat(64),
          argv_event: 'A'.repeat(64),
          agent_id: 'a'.repeat(64),
          tool_use_id: 'x'.repeat(128),
          prompt_id: 'x'.repeat(128),
          agent_type: 'x'.repeat(64),
          permission_mode: 'x'.repeat(64),
          transcript_path: 'x'.repeat(1024),
          cwd: 'x'.repeat(1024),
          claude_pid: 9_999_999_999,
          payload_bytes: 0,
        }),
      ),
    ).toBe(true);
  });

  it('rejects non-objects without throwing', () => {
    for (const value of [null, undefined, 1, 'x', [], true]) {
      expect(accepts(value)).toBe(false);
    }
  });

  it('error issues name the path but never repeat the rejected value (privacy: no values in logs)', () => {
    const secret = 'SENTINEL_SECRET_VALUE_' + 'z'.repeat(30);
    const result = HookEnvelopeV1Schema.safeParse(envelope({ session_id: secret, cwd: 5, extra_key: secret }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const text = JSON.stringify(result.error.issues);
      expect(text).toContain('session_id');
      expect(text).not.toContain(secret);
    }
  });

  it('does not accept a prototype pollution style key in data', () => {
    const parsed = HookEnvelopeV1Schema.safeParse(JSON.parse('{"x":1}'));
    expect(parsed.success).toBe(false);
    const line = '{"v":1,"data":{"__proto__":{"polluted":true}}}';
    expect(accepts(JSON.parse(line))).toBe(false);
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
  });
});

function routeFile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    instanceId: UUID,
    workspace: 'D:/work/task-a',
    spoolDir: 'D:/work/task-a/data/spool',
    stateFile: 'D:/work/task-a/state.json',
    enabled: true,
    match: { transcriptsDirs: ['c:/users/me/.claude/projects/d--repo'], sessionIds: [SID] },
    stoppedAt: null,
    spoolUntil: null,
    updatedAt: 1791727200123,
    ...over,
  };
}

describe('HookRouteV1Schema', () => {
  it('accepts a route file and is the same type as HookRouteV1', () => {
    expect(HookRouteV1Schema.safeParse(routeFile()).success).toBe(true);
    expectTypeOf<z.infer<typeof HookRouteV1Schema>>().toEqualTypeOf<HookRouteV1>();
  });

  it('accepts a stopped route and the limits (8 folders, 256 pinned sessions)', () => {
    expect(HookRouteV1Schema.safeParse(routeFile({ stoppedAt: 5, spoolUntil: 10 })).success).toBe(true);
    const dirs = Array.from({ length: 8 }, (_v, i) => 'c:/p/' + String(i));
    const sessions = Array.from({ length: 256 }, (_v, i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0'));
    expect(
      HookRouteV1Schema.safeParse(routeFile({ match: { transcriptsDirs: dirs, sessionIds: sessions } })).success,
    ).toBe(true);
  });

  it('round trips a route through JSON', () => {
    const text = JSON.stringify(routeFile());
    expect(HookRouteV1Schema.parse(JSON.parse(text))).toEqual(routeFile());
  });

  it.each([
    ['version 2', { v: 2 }],
    ['instance id not a uuid', { instanceId: 'abc' }],
    ['workspace empty', { workspace: '' }],
    ['workspace too long', { workspace: 'x'.repeat(1025) }],
    ['spoolDir missing', { spoolDir: undefined }],
    ['stateFile number', { stateFile: 1 }],
    ['enabled string', { enabled: 'true' }],
    ['match missing', { match: undefined }],
    [
      '9 transcript folders',
      { match: { transcriptsDirs: Array.from({ length: 9 }, (_v, i) => 'c:/p/' + String(i)), sessionIds: [] } },
    ],
    ['257 pinned sessions', { match: { transcriptsDirs: [], sessionIds: Array.from({ length: 257 }, () => SID) } }],
    ['pinned session not an id', { match: { transcriptsDirs: [], sessionIds: ['nope'] } }],
    ['folder not a string', { match: { transcriptsDirs: [1], sessionIds: [] } }],
    ['stoppedAt float', { stoppedAt: 1.5 }],
    ['stoppedAt undefined', { stoppedAt: undefined }],
    ['spoolUntil string', { spoolUntil: 'never' }],
    ['updatedAt negative', { updatedAt: -1 }],
  ])('rejects %s', (_label, over) => {
    expect(HookRouteV1Schema.safeParse(routeFile(over)).success).toBe(false);
  });

  it('tolerates unknown keys and drops them (a newer writer must not break an older reader)', () => {
    const parsed = HookRouteV1Schema.safeParse(routeFile({ future: 1 }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty('future');
  });

  it('does not enforce the workspace relations (matchRoutes does, so a bad file is skipped, not a crash)', () => {
    expect(HookRouteV1Schema.safeParse(routeFile({ spoolDir: 'D:/elsewhere' })).success).toBe(true);
  });
});

describe('NudgeBodySchema', () => {
  it('is a strict object holding one instanceId uuid', () => {
    expect(NudgeBodySchema.safeParse({ instanceId: UUID }).success).toBe(true);
    expect(NudgeBodySchema.safeParse({ instanceId: UUID, extra: 1 }).success).toBe(false);
    expect(NudgeBodySchema.safeParse({}).success).toBe(false);
    expect(NudgeBodySchema.safeParse({ instanceId: 'x' }).success).toBe(false);
    expect(NudgeBodySchema.safeParse({ instanceId: 5 }).success).toBe(false);
    expect(NudgeBodySchema.safeParse(null).success).toBe(false);
  });
});

describe('TranscriptRecordShape (loose)', () => {
  const ok = (value: unknown): boolean => TranscriptRecordShape.safeParse(value).success;

  it('needs only a string type', () => {
    expect(ok({ type: 'user' })).toBe(true);
    expect(ok({ type: 'some-future-type', anything: [1, { a: 2 }] })).toBe(true);
    expect(ok({})).toBe(false);
    expect(ok({ type: 5 })).toBe(false);
    expect(ok({ type: null })).toBe(false);
    expect(ok(null)).toBe(false);
    expect(ok('user')).toBe(false);
    expect(ok([])).toBe(false);
  });

  it('keeps unknown keys (loose)', () => {
    const parsed = TranscriptRecordShape.parse({ type: 'user', gitBranch: 'main', nested: { a: 1 } });
    expect(parsed).toMatchObject({ type: 'user', gitBranch: 'main', nested: { a: 1 } });
  });

  it('accepts the optional fields in the shapes of 4.2', () => {
    expect(
      ok({
        type: 'assistant',
        uuid: '00000000-0000-4000-8000-000000000001',
        parentUuid: null,
        timestamp: '2026-10-11T14:00:00.000Z',
        sessionId: SID,
        agentId: 'abc123',
        isSidechain: false,
        isMeta: false,
        promptId: 'p1',
        subtype: 'turn_duration',
        message: {
          id: 'msg_1',
          model: 'model-x',
          role: 'assistant',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 3 } },
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        toolUseResult: { anything: [1, 2] },
        attachment: { type: 'hook_non_blocking_error', command: 'x' },
        origin: { kind: 'task-notification' },
        toolDenialKind: 'user',
        toolEndsTurn: true,
        isApiErrorMessage: false,
        isAbortedMidStream: false,
        isCompactSummary: false,
        compactMetadata: { trigger: 'auto', preTokens: 100 },
      }),
    ).toBe(true);
  });

  it('accepts a string message content, a null stop reason and a parentUuid string', () => {
    expect(ok({ type: 'user', parentUuid: 'abc', message: { role: 'user', content: 'plain text' } })).toBe(true);
    expect(ok({ type: 'assistant', message: { stop_reason: null, content: [] } })).toBe(true);
  });

  it('accepts a toolUseResult of any shape', () => {
    for (const toolUseResult of ['text', 5, null, [1], { a: { b: 1 } }]) {
      expect(ok({ type: 'user', toolUseResult }), JSON.stringify(toolUseResult)).toBe(true);
    }
  });

  it.each([
    ['uuid number', { uuid: 5 }],
    ['parentUuid number', { parentUuid: 5 }],
    ['timestamp number', { timestamp: 1791727200123 }],
    ['sessionId object', { sessionId: {} }],
    ['agentId number', { agentId: 7 }],
    ['isSidechain string', { isSidechain: 'false' }],
    ['isMeta number', { isMeta: 0 }],
    ['promptId list', { promptId: [] }],
    ['subtype number', { subtype: 1 }],
    ['message a string', { message: 'text' }],
    ['message null', { message: null }],
    ['message content a number', { message: { content: 5 } }],
    ['message content element without type', { message: { content: [{ text: 'x' }] } }],
    ['message content element a string', { message: { content: ['x'] } }],
    ['message role number', { message: { role: 1 } }],
    ['message usage a string', { message: { usage: 'x' } }],
    ['attachment without type', { attachment: { command: 'x' } }],
    ['attachment a string', { attachment: 'x' }],
    ['origin kind number', { origin: { kind: 5 } }],
    ['toolEndsTurn string', { toolEndsTurn: 'yes' }],
    ['isApiErrorMessage number', { isApiErrorMessage: 1 }],
    ['isAbortedMidStream string', { isAbortedMidStream: 'x' }],
    ['isCompactSummary null', { isCompactSummary: null }],
    ['compactMetadata a string', { compactMetadata: 'x' }],
  ])('rejects %s', (_label, over) => {
    expect(ok({ type: 'user', ...over })).toBe(false);
  });

  it('parses a large content list without trouble', () => {
    const content = Array.from({ length: 2000 }, (_v, i) => ({ type: 'text', text: 'line ' + String(i) }));
    expect(ok({ type: 'assistant', message: { content } })).toBe(true);
  });
});

function health(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evaluatedAt: 1791727200123,
    provider: { lastActivityAt: 1791727199000, source: 'hook', status: 'active' },
    receiving: {
      hooks: {
        installed: [{ scope: 'user', settingsPath: 'C:/Users/me/.claude/settings.json', verifiedAt: null, ok: null }],
        lastEnvelopeAt: 1791727199000,
        envelopes1h: 10,
        duplicates1h: 1,
        invalid1h: 0,
        handlerErrors: [{ code: 'SPOOL_FULL', count: 2, lastAt: 1791727100000 }],
        transcriptHookFailures: 0,
        coverage: { full: 1, partial: 0, none: 0 },
        status: 'ok',
      },
      spool: {
        segments: 2,
        bytes: 1024,
        bytesBehind: 0,
        oldestPendingReceivedAt: null,
        lastNudgeAt: null,
        lastDrainAt: 1791727199500,
        foreignFiles: 0,
      },
      transcripts: {
        dir: 'C:/Users/me/.claude/projects/D--repo',
        dirFound: true,
        filesTracked: 3,
        filesMissing: 0,
        filesUnreadable: 0,
        bytesBehind: 0,
        maxLagMs: 12,
        backfillRemainingBytes: 0,
        lastScanAt: 1791727199000,
        lastSyncAt: 1791727199000,
        errors: { invalid_json: 1 },
        status: 'ok',
      },
    },
    persisted: {
      lastCommitAt: 1791727199900,
      queueItems: 0,
      queueBytes: 0,
      commitP95Ms: 4.5,
      failures1h: 0,
      lastError: null,
      status: 'ok',
    },
    display: { headSeq: 42, serverTime: 1791727200123 },
    runtime: { startedAt: 1791727000000, eventLoopDelayP99Ms: 3.2 },
    status: 'ok',
    reasons: [{ code: 'BACKFILLING', severity: 'info', since: 1791727000000 }],
    ...over,
  };
}

describe('IngestHealthSchema', () => {
  it('accepts a complete report and exposes its type', () => {
    const parsed = IngestHealthSchema.safeParse(health());
    expect(parsed.success).toBe(true);
    const typed: IngestHealth | null = parsed.success ? parsed.data : null;
    expect(typed?.status).toBe('ok');
  });

  it('accepts the all-null report of a fresh install', () => {
    const fresh = health({
      provider: { lastActivityAt: null, source: null, status: 'none' },
      persisted: {
        lastCommitAt: null,
        queueItems: 0,
        queueBytes: 0,
        commitP95Ms: 0,
        failures1h: 0,
        lastError: null,
        status: 'ok',
      },
      reasons: [],
    });
    expect(IngestHealthSchema.safeParse(fresh).success).toBe(true);
  });

  it('accepts a persisted failure with its last error', () => {
    const failing = health({
      persisted: {
        lastCommitAt: null,
        queueItems: 3,
        queueBytes: 100,
        commitP95Ms: 0,
        failures1h: 2,
        lastError: { code: 'SQLITE_FULL', at: 1791727199000 },
        status: 'db_error',
      },
      status: 'down',
    });
    expect(IngestHealthSchema.safeParse(failing).success).toBe(true);
  });

  it.each([
    ['unknown overall status', { status: 'broken' }],
    ['negative evaluatedAt', { evaluatedAt: -1 }],
    ['provider status unknown', { provider: { lastActivityAt: null, source: null, status: 'asleep' } }],
    ['provider source unknown', { provider: { lastActivityAt: 1, source: 'other', status: 'active' } }],
    ['reason severity unknown', { reasons: [{ code: 'X', severity: 'fatal', since: 1 }] }],
    ['reason without since', { reasons: [{ code: 'X', severity: 'info' }] }],
    ['display headSeq negative', { display: { headSeq: -1, serverTime: 1 } }],
    ['display missing', { display: undefined }],
    ['runtime missing', { runtime: undefined }],
    ['receiving missing', { receiving: undefined }],
    [
      'persisted status unknown',
      {
        persisted: {
          lastCommitAt: null,
          queueItems: 0,
          queueBytes: 0,
          commitP95Ms: 0,
          failures1h: 0,
          lastError: null,
          status: 'meh',
        },
      },
    ],
  ])('rejects %s', (_label, over) => {
    expect(IngestHealthSchema.safeParse(health(over)).success).toBe(false);
  });

  it('rejects a report whose hooks block has an unknown status or a bad coverage count', () => {
    const base = health();
    const receiving = base['receiving'] as Record<string, Record<string, unknown>>;
    const withHooks = (hooks: Record<string, unknown>): Record<string, unknown> =>
      health({ receiving: { ...receiving, hooks: { ...receiving['hooks'], ...hooks } } });
    expect(IngestHealthSchema.safeParse(withHooks({ status: 'weird' })).success).toBe(false);
    expect(IngestHealthSchema.safeParse(withHooks({ coverage: { full: -1, partial: 0, none: 0 } })).success).toBe(
      false,
    );
    expect(
      IngestHealthSchema.safeParse(withHooks({ installed: [{ scope: 'user', settingsPath: 'x', verifiedAt: null }] }))
        .success,
    ).toBe(false);
    expect(IngestHealthSchema.safeParse(withHooks({ envelopes1h: 1.5 })).success).toBe(false);
    expect(IngestHealthSchema.safeParse(withHooks({ status: 'not_installed' })).success).toBe(true);
    expect(IngestHealthSchema.safeParse(withHooks({ status: 'failing' })).success).toBe(true);
  });

  it('rejects a transcripts block with an unknown status and accepts every documented one', () => {
    const base = health();
    const receiving = base['receiving'] as Record<string, Record<string, unknown>>;
    const withTranscripts = (status: string): Record<string, unknown> =>
      health({ receiving: { ...receiving, transcripts: { ...receiving['transcripts'], status } } });
    for (const status of ['ok', 'backfilling', 'lagging', 'errors', 'not_found']) {
      expect(IngestHealthSchema.safeParse(withTranscripts(status)).success, status).toBe(true);
    }
    expect(IngestHealthSchema.safeParse(withTranscripts('stuck')).success).toBe(false);
  });
});

// 03 5.1 and 13 item 1: response schemas are strict objects all the way down, so that an undocumented field anywhere in
// the report is a contract failure (CR-WP-03-7). Every object of a complete report is named by its path from the root.
describe('IngestHealthSchema is strict at every nesting level', () => {
  const OBJECT_PATHS: readonly (readonly (string | number)[])[] = [
    [],
    ['provider'],
    ['receiving'],
    ['receiving', 'hooks'],
    ['receiving', 'hooks', 'installed', 0],
    ['receiving', 'hooks', 'handlerErrors', 0],
    ['receiving', 'hooks', 'coverage'],
    ['receiving', 'spool'],
    ['receiving', 'transcripts'],
    ['persisted'],
    ['persisted', 'lastError'],
    ['display'],
    ['runtime'],
    ['reasons', 0],
  ];

  /** A report in which every object of OBJECT_PATHS exists (the sample of `health()` has `lastError: null`). */
  function complete(): Record<string, unknown> {
    const base = health();
    const persisted = base['persisted'] as Record<string, unknown>;
    return health({
      persisted: { ...persisted, lastError: { code: 'SQLITE_FULL', at: 1791727199000 }, status: 'db_error' },
    });
  }

  function child(node: unknown, key: string | number): unknown {
    if (Array.isArray(node) && typeof key === 'number') return node[key];
    if (typeof node === 'object' && node !== null && typeof key === 'string') return Reflect.get(node, key);
    throw new Error(`no ${String(key)} in the sample report`);
  }

  function objectAt(root: unknown, path: readonly (string | number)[]): Record<string, unknown> {
    let node = root;
    for (const key of path) node = child(node, key);
    if (typeof node !== 'object' || node === null || Array.isArray(node)) throw new Error('not an object');
    return node as Record<string, unknown>;
  }

  const label = (path: readonly (string | number)[]): string => (path.length === 0 ? '(root)' : path.join('.'));

  it('accepts the complete report the probes start from', () => {
    expect(IngestHealthSchema.safeParse(complete()).success).toBe(true);
    for (const path of OBJECT_PATHS)
      expect(Object.keys(objectAt(complete(), path)).length, label(path)).toBeGreaterThan(0);
  });

  it.each(OBJECT_PATHS.map((path) => [label(path), path] as const))(
    'rejects an undocumented key in %s',
    (_label, path) => {
      const report = complete();
      objectAt(report, path)['undocumented'] = 1;
      const parsed = IngestHealthSchema.safeParse(report);
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues).toHaveLength(1);
      expect(parsed.error.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['undocumented'], path });
    },
  );

  it('keeps accepting arbitrary keys of the transcripts error counters, which are a record and not an object', () => {
    const report = complete();
    objectAt(report, ['receiving', 'transcripts'])['errors'] = { invalid_json: 1, some_future_code: 2 };
    expect(IngestHealthSchema.safeParse(report).success).toBe(true);
  });

  it('has additionalProperties: false on every object of the generated JSON Schema, and the list above names them all', () => {
    const json = z.toJSONSchema(IngestHealthSchema, { io: 'input' });
    const open: string[] = [];
    let objects = 0;
    const visit = (node: unknown, where: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => {
          visit(item, `${where}[${String(index)}]`);
        });
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      if (record['type'] === 'object' && 'properties' in record) {
        objects += 1;
        if (record['additionalProperties'] !== false) open.push(where);
      }
      for (const [key, value] of Object.entries(record)) visit(value, `${where}.${key}`);
    };
    visit(json, '$');
    expect(open).toEqual([]);
    expect(objects).toBe(OBJECT_PATHS.length);
  });
});
