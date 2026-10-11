import { join } from 'node:path';

import { EVENT_KINDS, TranscriptRecordShape } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs, type TranscriptBuilder } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb, type RepoContext } from '../../db/open.ts';
import { EventsRepo } from '../../db/repos/events.ts';
import { withWriteTx } from '../../db/write.ts';
import {
  FIXTURE_AGENT,
  FIXTURE_RUN,
  FIXTURE_SESSION,
  SENTINEL,
  builder,
  journalRecord,
  notificationSession,
  ordinarySession,
  parsedRecords,
  sentinelSession,
  sessionFile,
  subagentFile,
} from '../../../test/fixtures/transcripts.ts';
import type { EventRowWrite, LogicalEvent } from '../event-row.ts';
import type { RawLine } from '../tail/line-splitter.ts';
import {
  createNormalizerState,
  eventKindOfRecord,
  normalizeRecord,
  normalizeRecords,
  type NormalizeOptions,
  type TrackedFile,
} from './normalize-record.ts';

const S = FIXTURE_SESSION;
const AT = { offset: 1000, length: 200, lineNo: 9 };
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

function shape(obj: Record<string, unknown>): ReturnType<typeof TranscriptRecordShape.parse> {
  return TranscriptRecordShape.parse(obj);
}

function run(
  obj: Record<string, unknown>,
  file: TrackedFile = sessionFile(),
  opts: NormalizeOptions = {},
): ReturnType<typeof normalizeRecord> {
  return normalizeRecord(shape(obj), file, AT, opts);
}

const ks = (events: readonly LogicalEvent[]): string[] => events.map((e) => e.k);
const first = (b: TranscriptBuilder, pick: (r: Record<string, unknown>) => boolean): Record<string, unknown> => {
  const found = parsedRecords(b).find(pick);
  if (found === undefined) throw new Error('fixture record not found');
  return found;
};
const typed =
  (type: string, subtype?: string) =>
  (r: Record<string, unknown>): boolean =>
    r['type'] === type && (subtype === undefined || r['subtype'] === subtype);
const without = (rec: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));
const ts = (rec: Record<string, unknown>): number => Date.parse(String(rec['timestamp']));
const one = <K extends LogicalEvent['k']>(events: readonly LogicalEvent[], k: K): Extract<LogicalEvent, { k: K }> => {
  const found = events.find((e): e is Extract<LogicalEvent, { k: K }> => e.k === k);
  if (found === undefined) throw new Error(`no ${k} in ${ks(events).join(',')}`);
  return found;
};
const rowOf = (rows: readonly EventRowWrite[], index = 0): EventRowWrite => {
  const row = rows[index];
  if (row === undefined) throw new Error('no row');
  return row;
};
const hasToolUse = (r: Record<string, unknown>): boolean =>
  typed('assistant')(r) && JSON.stringify(r['message']).includes('"tool_use"');
const hasToolResult = (r: Record<string, unknown>): boolean =>
  typed('user')(r) && JSON.stringify(r['message']).includes('"tool_result"');

describe('normalizeRecord: user records (02 5.6)', () => {
  it('a prompt is turn.prompt and activity(user), and a prompt row without its text', () => {
    const rec = first(builder().user('FIXTURE hello'), typed('user'));
    const out = run(rec);
    expect(ks(out.events)).toEqual(['turn.prompt', 'activity']);
    expect(one(out.events, 'turn.prompt')).toMatchObject({
      sessionId: S,
      agentId: null,
      promptId: rec['promptId'],
      origin: 'unknown',
      promptLen: 'FIXTURE hello'.length,
    });
    expect(one(out.events, 'activity')).toMatchObject({ via: 'user', agentId: null });
    const row = rowOf(out.rows);
    expect(row).toMatchObject({
      sessionUid: S,
      agentUid: 'main',
      kind: 'prompt.submit',
      entryKind: 'prompt',
      severity: 0,
      sources: 2,
      tsSource: 'record',
      recordUuid: rec['uuid'],
      naturalKey: `prompt:${S}:${String(rec['promptId'])}`,
      eventUid: null,
      fileId: 7,
      byteOffset: 1000,
      byteLength: 200,
      lineNo: 9,
      recordType: 'user',
      textLen: 'FIXTURE hello'.length,
      summary: null,
      detail: null,
      hookEvent: null,
    });
    expect(row.stamp).toEqual({ at: ts(rec), rank: 10, tie: 't:7:1000' });
    expect(out.rows).toHaveLength(1);
  });

  it('a prompt without a prompt id has no natural key; the origin comes from origin.kind or promptSource', () => {
    const rec = first(builder().user(), typed('user'));
    expect(rowOf(run(without(rec, 'promptId')).rows).naturalKey).toBeNull();
    const withOrigin = run({ ...rec, origin: { kind: 'channel' } });
    expect(one(withOrigin.events, 'turn.prompt').origin).toBe('channel');
    const withSource = run({ ...rec, promptSource: 'slash' });
    expect(one(withSource.events, 'turn.prompt').origin).toBe('slash');
  });

  it('a prompt in a subagent file belongs to that agent', () => {
    const rec = first(builder().user(), typed('user'));
    const out = run(rec, subagentFile());
    expect(one(out.events, 'turn.prompt').agentId).toBe(FIXTURE_AGENT);
    expect(rowOf(out.rows)).toMatchObject({ agentUid: FIXTURE_AGENT, fileId: 8 });
  });

  it('a prompt given as a list with a text block is a prompt; a list without text or tool result is only activity', () => {
    const base = first(builder().user(), typed('user'));
    const blocks = run({ ...base, message: { role: 'user', content: [{ type: 'text', text: 'FIXTURE list' }] } });
    expect(ks(blocks.events)).toEqual(['turn.prompt', 'activity']);
    const images = run({ ...base, message: { role: 'user', content: [{ type: 'image', source: 'x' }] } });
    expect(ks(images.events)).toEqual(['activity']);
    expect(images.rows).toEqual([]);
  });

  it('a task-notification prompt is also agent.notification, stored as agent.notification without a prompt key', () => {
    const rec = first(notificationSession(), (r) => typed('user')(r) && JSON.stringify(r).includes('task_fixture_a'));
    const out = run(rec);
    expect(ks(out.events)).toEqual(['turn.prompt', 'activity', 'agent.notification']);
    expect(one(out.events, 'turn.prompt').origin).toBe('task-notification');
    expect(one(out.events, 'agent.notification')).toMatchObject({
      taskId: 'task_fixture_a',
      status: 'completed',
      toolUseId: expect.stringMatching(/^toolu_fixture_/) as string,
    });
    expect(rowOf(out.rows)).toMatchObject({ kind: 'agent.notification', entryKind: 'prompt', naturalKey: null });
  });

  it('an interrupt marker is interrupt(user_marker) with a turn.interrupt row flagged interrupt', () => {
    for (const forToolUse of [false, true]) {
      const rec = first(builder().interrupt({ forToolUse }), typed('user'));
      const out = run(rec);
      expect(ks(out.events)).toEqual(['interrupt', 'activity']);
      expect(one(out.events, 'interrupt').via).toBe('user_marker');
      expect(rowOf(out.rows)).toMatchObject({
        kind: 'turn.interrupt',
        severity: 1,
        entryKind: 'prompt',
        flags: ['interrupt'],
        naturalKey: null,
      });
    }
  });

  it('a meta record and a compact summary are activity only and have no row', () => {
    const rec = first(builder().user(), typed('user'));
    for (const flag of ['isMeta', 'isCompactSummary']) {
      const out = run({ ...rec, [flag]: true });
      expect(ks(out.events)).toEqual(['activity']);
      expect(out.rows).toEqual([]);
    }
  });
});

describe('normalizeRecord: tool results', () => {
  function result(opts: Parameters<TranscriptBuilder['toolResult']>[1] = {}): Record<string, unknown> {
    const b = builder().user();
    const id = b.toolUse('Bash', { command: 'echo FIXTURE' });
    b.toolResult(id, opts);
    return first(b, hasToolResult);
  }

  it.each([
    ['ok', {}, 'ok', 'tool.result', 0],
    ['error', { isError: true }, 'error', 'tool.failure', 2],
    ['denied', { denial: true }, 'denied', 'tool.failure', 2],
  ] as const)('%s result: tool.end(%s), activity(tool_result) and a %s row', (_n, opts, outcome, kind, severity) => {
    const rec = result(opts);
    const out = run(rec);
    expect(ks(out.events)).toEqual(['tool.end', 'activity']);
    const end = one(out.events, 'tool.end');
    expect(end.outcome).toBe(outcome);
    expect(one(out.events, 'activity').via).toBe('tool_result');
    const row = rowOf(out.rows);
    expect(row).toMatchObject({
      kind,
      severity,
      entryKind: 'result',
      toolUseId: end.toolUseId,
      naturalKey: `tool.end:${end.toolUseId}`,
      recordUuid: rec['uuid'],
      recordType: 'user',
    });
    expect(row.stamp.rank).toBe(30);
    expect(row.textLen).toBeGreaterThan(0);
  });

  it('several blocks: one tool.end and row each, only the first row carries the record uuid', () => {
    const rec = first(builder().user(), typed('user'));
    const out = run({
      ...rec,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_a', content: 'x', is_error: false },
          { type: 'tool_result', tool_use_id: 'toolu_b', content: 'y', is_error: true },
        ],
      },
    });
    expect(ks(out.events)).toEqual(['tool.end', 'tool.end', 'activity']);
    expect(out.rows.map((r) => [r.kind, r.naturalKey, r.recordUuid === null])).toEqual([
      ['tool.result', 'tool.end:toolu_a', false],
      ['tool.failure', 'tool.end:toolu_b', true],
    ]);
  });

  it('a block without a usable tool use id gives no tool.end and no natural key', () => {
    const rec = first(builder().user(), typed('user'));
    const out = run({
      ...rec,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'has space', content: 'x' }] },
    });
    expect(ks(out.events)).toEqual(['activity']);
    expect(rowOf(out.rows).naturalKey).toBeNull();
    expect(rowOf(out.rows).recordUuid).toBe(rec['uuid']);
  });

  it('an Agent launch result links the agent with its status', () => {
    const b = builder().user();
    const id = b.agentLaunch({ agentId: FIXTURE_AGENT, background: true });
    const out = run(first(b, hasToolResult));
    expect(one(out.events, 'agent.link')).toMatchObject({
      agentId: FIXTURE_AGENT,
      toolUseId: id,
      status: 'async_launched',
    });
  });

  it('a result with an agent id that is not an id gives no link; a null status stays null', () => {
    const rec = result();
    const bad = run({ ...rec, toolUseResult: { agentId: 'no way!', status: 'x' } });
    expect(ks(bad.events)).not.toContain('agent.link');
    const nullStatus = run({ ...rec, toolUseResult: { agentId: FIXTURE_AGENT } });
    expect(one(nullStatus.events, 'agent.link').status).toBeNull();
  });

  it('a Workflow launch result starts the run', () => {
    const rec = result();
    const out = run({ ...rec, toolUseResult: { runId: FIXTURE_RUN, workflowName: 'fixture-flow', taskId: 't' } });
    expect(one(out.events, 'workflow.launch')).toMatchObject({ runId: FIXTURE_RUN, name: 'fixture-flow' });
    expect(ks(run({ ...rec, toolUseResult: { runId: 'nope' } }).events)).not.toContain('workflow.launch');
  });

  it('toolEndsTurn in an agent file is the final answer of that agent; elsewhere it is nothing', () => {
    const b = builder({ agentId: FIXTURE_AGENT }).user();
    b.endTurnTool('SubagentHandback');
    const rec = first(b, (r) => hasToolResult(r) && r['toolEndsTurn'] === true);
    const inAgent = run(rec, subagentFile());
    expect(one(inAgent.events, 'agent.final')).toMatchObject({ agentId: FIXTURE_AGENT, via: 'tool_ends_turn' });
    expect(ks(run(rec, sessionFile()).events)).not.toContain('agent.final');
  });
});

describe('normalizeRecord: assistant records', () => {
  it('a text answer is activity, assistant.ok and a say row', () => {
    const b = builder().user().assistant({ messageId: 'msg_fixture_say', stop: 'tool_use' });
    const rec = first(b, typed('assistant'));
    const out = run(rec);
    expect(ks(out.events)).toEqual(['activity', 'assistant.ok']);
    expect(one(out.events, 'activity').via).toBe('assistant');
    expect(rowOf(out.rows)).toMatchObject({
      kind: 'assistant.message',
      entryKind: 'say',
      severity: 0,
      messageId: 'msg_fixture_say',
      recordUuid: rec['uuid'],
      naturalKey: null,
      toolUseId: null,
      textLen: expect.any(Number) as number,
    });
    expect(rowOf(out.rows).stamp.rank).toBe(20);
  });

  it('end_turn adds turn.end(end_turn)', () => {
    const rec = first(
      builder().user().assistant({ messageId: 'msg_fixture_end', stop: 'end_turn' }),
      typed('assistant'),
    );
    expect(ks(run(rec).events)).toEqual(['activity', 'assistant.ok', 'turn.end']);
    expect(one(run(rec).events, 'turn.end').kind).toBe('end_turn');
  });

  it('a tool_use block starts the tool with a redacted 160 cp summary and an input hash; the row has the natural key', () => {
    const b = builder().user();
    const id = b.toolUse('Bash', { command: 'echo FIXTURE ' + 'x'.repeat(300) });
    const out = run(first(b, hasToolUse));
    expect(ks(out.events)).toEqual(['activity', 'assistant.ok', 'tool.start']);
    const start = one(out.events, 'tool.start');
    expect(start).toMatchObject({ toolUseId: id, name: 'Bash' });
    expect(Array.from(start.summary ?? '').length).toBeLessThanOrEqual(160 + 40);
    expect(start.inputHash).toMatch(/^[0-9a-f]{32}$/);
    expect(rowOf(out.rows)).toMatchObject({
      kind: 'tool.call',
      entryKind: 'tool',
      toolUseId: id,
      toolName: 'Bash',
      naturalKey: `tool.call:${id}`,
      summary: start.summary,
    });
  });

  it('a secret in a tool input is redacted in the summary', () => {
    const b = builder().user();
    b.toolUse('Bash', { command: 'curl -H "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123456789" x' });
    const out = run(first(b, hasToolUse));
    expect(rowOf(out.rows).summary).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('a thinking block is a think row that stores neither the text nor the signature', () => {
    const rec = first(sentinelSession(), (r) => JSON.stringify(r).includes('"thinking"'));
    const out = run(rec);
    expect(rowOf(out.rows)).toMatchObject({ kind: 'assistant.thinking', entryKind: 'think' });
    expect(JSON.stringify(out)).not.toContain('SENTINEL');
  });

  it('an API error record is api_error (not assistant.ok) and an api.error row of severity 2', () => {
    const rec = first(builder().user().apiError(529), typed('assistant'));
    const out = run(rec);
    expect(ks(out.events)).toContain('api_error');
    expect(ks(out.events)).not.toContain('assistant.ok');
    expect(one(out.events, 'api_error')).toMatchObject({ status: 529, error: 'server_error' });
    expect(rowOf(out.rows)).toMatchObject({ kind: 'api.error', severity: 2, entryKind: 'say' });
  });

  it('a synthetic model is no assistant.ok; an aborted stream is an interrupt', () => {
    const rec = first(
      builder().user().assistant({ messageId: 'msg_fixture_a', abortedMidStream: true }),
      typed('assistant'),
    );
    const aborted = run(rec);
    expect(one(aborted.events, 'interrupt').via).toBe('aborted_mid_stream');
    const synthetic = run({ ...rec, message: { ...(rec['message'] as object), model: '<synthetic>' } });
    expect(ks(synthetic.events)).not.toContain('assistant.ok');
  });
});

describe('normalizeRecord: system and attachment records', () => {
  it('turn_duration ends the turn with the pending counts, rank 61, stored as turn.duration', () => {
    const b = builder().user().turnEnd({ pendingBackgroundAgentCount: 2, pendingWorkflowCount: 1 });
    const rec = first(b, typed('system', 'turn_duration'));
    const out = run(rec);
    expect(ks(out.events)).toEqual(['turn.end']);
    expect(one(out.events, 'turn.end')).toMatchObject({
      kind: 'turn_duration',
      pendingBackgroundAgents: 2,
      pendingWorkflows: 1,
    });
    expect(rowOf(out.rows)).toMatchObject({ kind: 'turn.duration', entryKind: 'system' });
    expect(rowOf(out.rows).stamp.rank).toBe(61);
  });

  it('compact_boundary is a compaction with the trigger and token counts, rank 52, stored as context.compact', () => {
    const rec = first(builder().user().compact(), typed('system', 'compact_boundary'));
    const out = run(rec);
    expect(one(out.events, 'compaction')).toMatchObject({ trigger: 'auto', preTokens: 900_000, postTokens: 20_000 });
    expect(rowOf(out.rows)).toMatchObject({ kind: 'context.compact', entryKind: 'system' });
    expect(rowOf(out.rows).stamp.rank).toBe(52);
  });

  it('away_summary and local_command are info events and system.info rows without content; other subtypes only a row', () => {
    const rec = first(builder().user(), typed('user'));
    const base = { ...rec, type: 'system', message: undefined, promptId: undefined };
    for (const [subtype, what] of [
      ['away_summary', 'away_summary'],
      ['local_command', 'local_command'],
    ] as const) {
      const out = run({ ...base, subtype, content: SENTINEL.awaySummary });
      expect(one(out.events, 'info').what).toBe(what);
      expect(rowOf(out.rows)).toMatchObject({ kind: 'system.info', entryKind: 'system', subtype });
      expect(rowOf(out.rows).stamp.rank).toBe(58);
      expect(JSON.stringify(out)).not.toContain('SENTINEL');
    }
    const other = run({ ...base, subtype: 'informational', content: SENTINEL.localCommand });
    expect(other.events).toEqual([]);
    expect(rowOf(other.rows)).toMatchObject({ kind: 'system.info', subtype: 'informational' });
  });

  function attachment(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'attachment',
      uuid: 'bbbbbbbb-0000-4000-8000-000000000001',
      timestamp: new Date(FIXTURE_EPOCH_MS).toISOString(),
      attachment: { type, ...extra },
    };
  }

  it('our own hook error is hook.handler_error (severity 2, flag ours); another command is not stored', () => {
    const ours = run(
      attachment('hook_non_blocking_error', {
        hookEvent: 'PostToolUse',
        command: 'node mcs.mjs --mcs-hook PostToolUse',
        exitCode: 1,
        stderr: SENTINEL.attachment,
      }),
    );
    expect(one(ours.events, 'hook.handler_error')).toMatchObject({ hookEvent: 'PostToolUse', exitCode: 1 });
    expect(rowOf(ours.rows)).toMatchObject({
      kind: 'hook.handler_error',
      severity: 2,
      entryKind: 'attachment',
      flags: ['ours'],
    });
    expect(rowOf(ours.rows).stamp.rank).toBe(50);
    expect(JSON.stringify(ours)).not.toContain('SENTINEL');

    const foreign = run(
      attachment('hook_non_blocking_error', { hookEvent: 'PostToolUse', command: 'some-other-tool', exitCode: 1 }),
    );
    expect(foreign.events).toEqual([]);
    expect(foreign.rows).toEqual([]);
    expect(foreign.ignoredAttachment).toBe('hook_non_blocking_error');
  });

  it('queued_command is info(queued_command) stored as prompt.queued; task_status only a system.info row', () => {
    const queued = run(attachment('queued_command', { prompt: SENTINEL.queued }));
    expect(one(queued.events, 'info').what).toBe('queued_command');
    expect(rowOf(queued.rows)).toMatchObject({ kind: 'prompt.queued', entryKind: 'attachment' });
    const status = run(attachment('task_status', { deltaSummary: SENTINEL.attachment }));
    expect(status.events).toEqual([]);
    expect(rowOf(status.rows)).toMatchObject({ kind: 'system.info', entryKind: 'attachment' });
    expect(JSON.stringify([queued, status])).not.toContain('SENTINEL');
  });

  it('structured_output ends a workflow agent; in any other file it is an ignored attachment', () => {
    const rec = attachment('structured_output', { data: { ok: true } });
    const workflowAgent = subagentFile({ kind: 'workflow_agent', runId: FIXTURE_RUN });
    const out = run(rec, workflowAgent);
    expect(one(out.events, 'agent.final')).toMatchObject({ agentId: FIXTURE_AGENT, via: 'structured_output' });
    expect(rowOf(out.rows)).toMatchObject({ kind: 'agent.final', entryKind: 'attachment' });
    const elsewhere = run(rec, sessionFile());
    expect(elsewhere.events).toEqual([]);
    expect(elsewhere.rows).toEqual([]);
    expect(elsewhere.ignoredAttachment).toBe('structured_output');
  });

  it('every other attachment type is counted by type and not stored', () => {
    for (const type of ['hook_success', 'total_tokens_reminder', 'date', 'environment', 'compact_file_reference']) {
      const out = run(attachment(type, { content: SENTINEL.attachment }));
      expect(out.events, type).toEqual([]);
      expect(out.rows, type).toEqual([]);
      expect(out.ignoredAttachment, type).toBe(type);
    }
  });
});

describe('normalizeRecord: bookkeeping, titles, state records', () => {
  it('bookkeeping records never produce activity, a row or a stamped event (T-TR-15, fixture 14)', () => {
    const b = builder().user();
    for (const kind of [
      'last-prompt',
      'mode',
      'permission-mode',
      'atis-latch',
      'queue-operation',
      'file-history-snapshot',
      'file-history-delta',
      'bridge-session',
    ] as const) {
      b.bookkeeping(kind);
    }
    const rows = parsedRecords(b).filter((r) => !typed('user')(r));
    expect(rows).toHaveLength(8);
    for (const rec of rows) {
      const out = run(rec);
      expect(out.events, String(rec['type'])).toEqual([]);
      expect(out.rows, String(rec['type'])).toEqual([]);
      expect(out.unknownType, String(rec['type'])).toBeNull();
    }
  });

  it('ai-title, custom-title and agent-name are title events clipped to 120 code points; a repeat of the same value is dropped', () => {
    const state = createNormalizerState();
    const cases = [
      ['ai-title', 'aiTitle', 'ai'],
      ['custom-title', 'customTitle', 'custom'],
      ['agent-name', 'agentName', 'agent_name'],
    ] as const;
    for (const [type, field, source] of cases) {
      const rec = { type, sessionId: S, [field]: 'FIXTURE title ' + 'y'.repeat(200) };
      const out = run(rec, sessionFile(), { state });
      const title = one(out.events, 'title');
      expect(title.source).toBe(source);
      expect(Array.from(title.value).length).toBeLessThanOrEqual(120 + 40);
      expect(title.order).toBe(AT.offset);
      expect(out.rows).toEqual([]);
      expect(run(rec, sessionFile(), { state }).events).toEqual([]);
    }
    const changed = run({ type: 'ai-title', aiTitle: 'FIXTURE another' }, sessionFile(), { state });
    expect(one(changed.events, 'title').value).toBe('FIXTURE another');
  });

  it('a title is redacted', () => {
    const out = run({ type: 'custom-title', customTitle: 'key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(one(out.events, 'title').value).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('titles of different files do not share state', () => {
    const rec = { type: 'ai-title', aiTitle: 'FIXTURE same' };
    expect(run(rec, sessionFile(), { state: createNormalizerState() }).events).toHaveLength(1);
    expect(run(rec, sessionFile(), { state: createNormalizerState() }).events).toHaveLength(1);
  });

  it('continued-in names the target session; an invalid target is dropped', () => {
    const target = '66666666-6666-4666-8666-666666666666';
    expect(one(run({ type: 'continued-in', continuedInSessionId: target }).events, 'session.continued_in').target).toBe(
      target,
    );
    expect(run({ type: 'continued-in', continuedInSessionId: 'not a session id' }).events).toEqual([]);
  });

  it('cost-state keeps numbers only, with the file and the offset', () => {
    const rec = first(builder().user().bookkeeping('cost-state'), typed('cost-state'));
    const out = run({ ...rec, extra: SENTINEL.account });
    const cost = one(out.events, 'cost_state');
    expect(cost).toMatchObject({ fileId: 7, byteOffset: 1000, totalCostUsd: 0 });
    expect(cost.modelUsage['claude-sonnet-5-5']).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    const dirty = run({
      type: 'cost-state',
      totalCostUSD: 'free',
      modelUsage: { m: { inputTokens: 3, name: SENTINEL.account, nested: { a: 1 } }, bad: 'x' },
    });
    expect(one(dirty.events, 'cost_state')).toMatchObject({
      totalCostUsd: null,
      modelUsage: { m: { inputTokens: 3 } },
    });
    expect(JSON.stringify(dirty)).not.toContain('SENTINEL');
  });

  it('an unknown type is reported by name and stores nothing', () => {
    const out = run({ type: 'something-new', payload: SENTINEL.attachment });
    expect(out.unknownType).toBe('something-new');
    expect(out.events).toEqual([]);
    expect(out.rows).toEqual([]);
  });
});

describe('normalizeRecord: stamps and time', () => {
  it('a record without a valid timestamp produces no stamped event and no row', () => {
    const rec = first(builder().user(), typed('user'));
    for (const candidate of [without(rec, 'timestamp'), { ...rec, timestamp: 'not a time' }]) {
      const out = run(candidate);
      expect(out.events).toEqual([]);
      expect(out.rows).toEqual([]);
    }
  });

  it('the tie of the stamp names the file and the offset', () => {
    const rec = first(builder().user(), typed('user'));
    const out = normalizeRecord(shape(rec), sessionFile({ fileId: 31 }), { offset: 4096, length: 10, lineNo: 2 }, {});
    expect(rowOf(out.rows).stamp.tie).toBe('t:31:4096');
    expect(one(out.events, 'activity').stamp.tie).toBe('t:31:4096');
  });

  it('received_at is the given now, or the record time without one', () => {
    const rec = first(builder().user(), typed('user'));
    expect(rowOf(run(rec, sessionFile(), { nowMs: 123 }).rows).receivedAt).toBe(123);
    expect(rowOf(run(rec).rows).receivedAt).toBe(ts(rec));
  });
});

describe('normalizeRecord: workflow journal', () => {
  const journal = (): TrackedFile => sessionFile({ fileId: 9, kind: 'workflow_journal', runId: FIXTURE_RUN });

  it('counts started, result and failed agents of the run by key and never reads a result body', () => {
    const state = createNormalizerState();
    const file = journal();
    const feed = (rec: Record<string, unknown>): LogicalEvent[] => run(rec, file, { state }).events;
    const status = (events: LogicalEvent[]): { started: number; results: number; failed: number } => {
      const e = one(events, 'workflow.status');
      return { started: e.started, results: e.results, failed: e.failed };
    };
    expect(status(feed(journalRecord('started', { agentId: 'a1', key: 'k1', label: 'l', phase: 'p' })))).toEqual({
      started: 1,
      results: 0,
      failed: 0,
    });
    expect(status(feed(journalRecord('started', { agentId: 'a2', key: 'k2' })))).toEqual({
      started: 2,
      results: 0,
      failed: 0,
    });
    expect(status(feed(journalRecord('result', { agentId: 'a1', key: 'k1', result: SENTINEL.journalResult })))).toEqual(
      { started: 2, results: 1, failed: 0 },
    );
    expect(status(feed(journalRecord('result', { agentId: 'a1', key: 'k1' })))).toEqual({
      started: 2,
      results: 1,
      failed: 0,
    });
    const failed = feed(journalRecord('failed', { agentId: 'a2', key: 'k2' }));
    expect(status(failed)).toEqual({ started: 2, results: 1, failed: 1 });
    const e = one(failed, 'workflow.status');
    expect(e).toMatchObject({ sessionId: S, runId: FIXTURE_RUN, fileStatus: null });
    expect(e.observedAt).toBe(FIXTURE_EPOCH_MS);
    expect(JSON.stringify(failed)).not.toContain('SENTINEL');
  });

  it('stores no row and ignores launched', () => {
    const out = run(journalRecord('launched', { name: 'fx' }), journal());
    expect(out.events).toEqual([]);
    expect(out.rows).toEqual([]);
    const started = run(journalRecord('started', { agentId: 'a1', key: 'k1' }), journal());
    expect(started.rows).toEqual([]);
  });

  it('uses the given now when the record has no time, and nothing when neither is there', () => {
    const rec = { type: 'started', agentId: 'a1', key: 'k1' };
    expect(one(run(rec, journal(), { nowMs: 777 }).events, 'workflow.status').observedAt).toBe(777);
    expect(run(rec, journal()).events).toEqual([]);
  });
});

describe('eventKindOfRecord (02 4.1.2)', () => {
  const kindOf = (
    rec: Record<string, unknown>,
    block: Record<string, unknown> | null = null,
    file = sessionFile(),
  ): string | null =>
    eventKindOfRecord(shape(rec), block === null ? null : { type: String(block['type']), ...block }, file);

  it('returns the stored kind of each record and block, always a member of EVENT_KINDS or null', () => {
    const b = builder().user();
    const id = b.toolUse('Bash', { command: 'echo FIXTURE' });
    b.toolResult(id);
    b.toolResult(b.toolUse('Bash', { command: 'false' }), { isError: true });
    b.assistant({ messageId: 'msg_fixture_k' }).apiError().turnEnd();
    const records = parsedRecords(b);
    const observed = new Set<string>();
    for (const rec of records) {
      const content = (rec['message'] as { content?: unknown } | undefined)?.content;
      const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [null];
      for (const block of blocks) {
        const kind = kindOf(rec, block);
        if (kind !== null) {
          expect(EVENT_KINDS as readonly string[]).toContain(kind);
          observed.add(kind);
        }
      }
    }
    expect([...observed].sort()).toEqual(
      [
        'api.error',
        'assistant.message',
        'prompt.submit',
        'tool.call',
        'tool.failure',
        'tool.result',
        'turn.duration',
      ].sort(),
    );
  });

  it('maps the cases of the table that have no row to null', () => {
    const user = first(builder().user(), typed('user'));
    expect(kindOf({ ...user, isMeta: true })).toBeNull();
    expect(kindOf({ type: 'ai-title', aiTitle: 'x' })).toBeNull();
    expect(kindOf({ type: 'last-prompt' })).toBeNull();
    expect(kindOf({ type: 'attachment', attachment: { type: 'date' } })).toBeNull();
    expect(kindOf({ type: 'unknown-thing' })).toBeNull();
  });

  it('maps a denial or an error flag of a result to tool.failure', () => {
    const user = first(builder().user(), typed('user'));
    const block = { type: 'tool_result', tool_use_id: 'toolu_a', content: 'x' };
    expect(kindOf(user, block)).toBe('tool.result');
    expect(kindOf(user, { ...block, is_error: true })).toBe('tool.failure');
    expect(kindOf({ ...user, toolDenialKind: 'user-rejected' }, block)).toBe('tool.failure');
  });
});

describe('normalizeRecords (lines to items)', () => {
  function rawLines(b: TranscriptBuilder): RawLine[] {
    let offset = 0;
    return b.lines().map((text, i) => {
      const bytes = Buffer.from(text, 'utf8');
      const line = { offset, length: bytes.length, lineNo: i + 1, bytes };
      offset += bytes.length + 1;
      return line;
    });
  }

  it('parses each line, gives one item per record that yields something, and passes offsets through', () => {
    const lines = rawLines(ordinarySession());
    const batch = normalizeRecords(lines, sessionFile(), createNormalizerState());
    expect(batch.items.length).toBeGreaterThan(0);
    for (const item of batch.items) {
      expect(item.kind).toBe('record');
      expect(item.events.length + item.rows.length).toBeGreaterThan(0);
    }
    const prompt = batch.items[0];
    expect(prompt?.offset).toBe(lines[0]?.offset);
    expect(rowOf(prompt?.rows ?? [])).toMatchObject({
      byteOffset: lines[0]?.offset,
      byteLength: lines[0]?.length,
      lineNo: 1,
    });
    expect(batch.counters).toMatchObject({ invalidJson: 0, notObject: 0, shapeInvalid: 0 });
  });

  it('counts a line that is not JSON, a JSON value that is not an object and a record of the wrong shape', () => {
    const b = ordinarySession();
    b.invalidLine();
    b.raw({ type: 5 });
    const lines = [...rawLines(b)];
    const extra = (text: string): RawLine => ({ offset: 0, length: text.length, lineNo: 99, bytes: Buffer.from(text) });
    lines.push(extra('[1,2,3]'), extra('42'), extra('null'), extra('"text"'));
    const batch = normalizeRecords(lines, sessionFile(), createNormalizerState());
    expect(batch.counters).toMatchObject({ invalidJson: 1, notObject: 4, shapeInvalid: 1 });
  });

  it('counts unknown record types and ignored attachment types by name', () => {
    const b = builder().user();
    b.raw({ type: 'mystery', timestamp: new Date(FIXTURE_EPOCH_MS).toISOString() });
    b.raw({ type: 'mystery', timestamp: new Date(FIXTURE_EPOCH_MS).toISOString() });
    b.attachment('date');
    b.attachment('environment');
    b.attachment('date');
    const batch = normalizeRecords(rawLines(b), sessionFile(), createNormalizerState());
    expect(batch.counters.unknownTypes).toBe(2);
    expect(batch.counters.unknownRecordTypes).toEqual({ mystery: 2 });
    expect(batch.counters.ignoredAttachments).toEqual({ date: 2, environment: 1 });
  });

  it('keeps the title state across calls (a title is emitted once per change)', () => {
    const state = createNormalizerState();
    const b = builder().user().bookkeeping('ai-title');
    const lines = rawLines(b);
    const a = normalizeRecords(lines, sessionFile(), state);
    const again = normalizeRecords(lines, sessionFile(), state);
    const titles = (batch: ReturnType<typeof normalizeRecords>): number =>
      batch.items.flatMap((i) => i.events).filter((e) => e.k === 'title').length;
    expect(titles(a)).toBe(1);
    expect(titles(again)).toBe(0);
  });

  function textLine(text: string, lineNo: number): RawLine {
    const bytes = Buffer.from(text, 'utf8');
    return { offset: lineNo * 100_000, length: bytes.length, lineNo, bytes };
  }

  function deepToolUseLine(depth: number, lineNo: number): RawLine {
    const input = '['.repeat(depth) + ']'.repeat(depth);
    const at = new Date(FIXTURE_EPOCH_MS + 1000).toISOString();
    return textLine(
      `{"type":"assistant","uuid":"deep-1","timestamp":"${at}","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_deep","name":"Bash","input":${input}}]}}`,
      lineNo,
    );
  }

  it('a tool input nested 5000 levels deep does not lose the lines around it (no hash, the tool still starts)', () => {
    const userLine = (text: string, lineNo: number): RawLine =>
      textLine(JSON.stringify(first(builder().user(text), typed('user'))), lineNo);
    const before = userLine('FIXTURE before', 1);
    const after = userLine('FIXTURE after', 3);
    const hostile = deepToolUseLine(5000, 2);
    const batch = normalizeRecords([before, hostile, after], sessionFile(), createNormalizerState());
    expect(batch.items.map((i) => i.offset)).toEqual([before.offset, hostile.offset, after.offset]);
    const start = batch.items[1]?.events.find((e) => e.k === 'tool.start');
    expect(start).toMatchObject({ k: 'tool.start', toolUseId: 'toolu_deep', name: 'Bash' });
    expect(start).not.toHaveProperty('inputHash');
    expect(rowOf(batch.items[1]?.rows ?? [])).toMatchObject({ kind: 'tool.call', toolUseId: 'toolu_deep' });
    expect(batch.counters.normalizeFailed).toBe(0);
  });

  it('a line whose normalization throws is counted in normalizeFailed and skipped, the other lines survive', () => {
    const b = builder().user('FIXTURE one').bookkeeping('ai-title').user('FIXTURE two');
    const lines = rawLines(b);
    const title = lines.find((l) => l.bytes.toString('utf8').includes('"ai-title"'));
    expect(title).toBeDefined();
    const hostileState = createNormalizerState();
    Object.defineProperty(hostileState, 'titles', {
      get(): never {
        throw new Error('hostile state');
      },
    });
    const batch = normalizeRecords(lines, sessionFile(), hostileState);
    expect(batch.counters.normalizeFailed).toBe(1);
    expect(batch.items.length).toBe(lines.length - 1);
    expect(batch.items.map((i) => i.offset)).not.toContain(title?.offset);
  });

  it('a record of a workflow status file yields no event and no row, like eventKindOfRecord says', () => {
    const file = sessionFile({ kind: 'workflow_status', runId: FIXTURE_RUN });
    const assistant = first(ordinarySession(), typed('assistant'));
    const out = run(assistant, file);
    expect(out).toEqual({ events: [], rows: [], unknownType: null, ignoredAttachment: null });
    expect(eventKindOfRecord(shape(assistant), null, file)).toBeNull();
  });

  it('T-TR-15: bookkeeping lines never count as activity', () => {
    const b = builder();
    for (const kind of ['last-prompt', 'mode', 'permission-mode', 'file-history-snapshot', 'bridge-session'] as const) {
      b.bookkeeping(kind);
    }
    const batch = normalizeRecords(rawLines(b), sessionFile(), createNormalizerState());
    expect(batch.items.flatMap((i) => i.events).filter((e) => e.k === 'activity')).toEqual([]);
  });

  it('T-TR-16: a sentinel in every field that is never persisted does not reach an event or a row', () => {
    const lines = rawLines(sentinelSession());
    const batch = normalizeRecords(lines, sessionFile(), createNormalizerState());
    const dump = JSON.stringify(batch);
    expect(batch.items.length).toBeGreaterThan(5);
    expect(dump).not.toContain('SENTINEL');
    // the placeholders that are allowed to be stored are still there
    expect(dump).toContain('FIXTURE/out.txt');
    // the same holds for a subagent file and for a file read with a record cap far below the sentinel size
    expect(JSON.stringify(normalizeRecords(lines, subagentFile(), createNormalizerState()))).not.toContain('SENTINEL');
  });
});

describe('normalizeRecords: rows are accepted by EventsRepo (CHECKs of 03 3.5)', () => {
  const makeTemp = useTempDirs();
  const ctx: RepoContext = { instanceId: INSTANCE_ID };
  const opened: InstanceDb[] = [];
  afterEach(() => {
    for (const db of opened.splice(0)) db.close();
  });

  it('inserts rows built from provider strings longer than the columns (clipped or dropped, never a CHECK failure)', () => {
    const db = openInstanceDb({
      path: join(makeTemp('record-hostile-db').path, 'monitor.db'),
      expectedInstanceId: INSTANCE_ID,
      mode: 'serve',
      runtimeVersion: '3.0.0',
      clock: new FakeClock(FIXTURE_EPOCH_MS),
    });
    opened.push(db);
    const t = FIXTURE_EPOCH_MS;
    const { lastInsertRowid: sessionId } = db.driver
      .prepare(
        'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run([S, t, t, t, t]);
    db.driver
      .prepare(
        "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'main', NULL, 'main', 0, ?, ?, ?, ?)",
      )
      .run([sessionId, t, t, t, t]);
    const { lastInsertRowid: fileId } = db.driver
      .prepare(
        "INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at) VALUES ('f.jsonl', 'f.jsonl', 'session', ?, ?, ?)",
      )
      .run([S, t, t]);
    const repo = new EventsRepo(db);
    const at = (n: number): string => new Date(FIXTURE_EPOCH_MS + n * 1000).toISOString();
    const records: Record<string, unknown>[] = [
      {
        type: 'assistant',
        uuid: 'u'.repeat(200),
        timestamp: at(1),
        message: {
          id: 'm'.repeat(300),
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_long', name: 'N'.repeat(500), input: { a: 1 } }],
        },
      },
      { type: 'system', uuid: 'sys-1', subtype: 's'.repeat(100), timestamp: at(2) },
      {
        type: 'user',
        uuid: 'usr-1',
        timestamp: at(3),
        origin: { kind: 'o'.repeat(100) },
        message: { role: 'user', content: 'FIXTURE hello' },
      },
    ];
    const first = rows(records);
    expect(first.length).toBeGreaterThanOrEqual(3);
    for (const row of first) {
      const result = withWriteTx(db, ctx, (tx) => repo.insert(ctx, tx, row));
      expect(result.outcome).toBe('inserted');
    }
    // the long uuid fell back to the file and offset key; the long message id and the long subtype did not survive
    expect(first[0]?.recordUuid).toMatch(new RegExp(`^f${String(fileId)}:`));
    expect(first[0]?.messageId).toBeNull();
    expect(first[0]?.toolName).toHaveLength(128);
    expect(first.find((r) => r.recordType === 'system')?.subtype).toHaveLength(40);

    function rows(recs: Record<string, unknown>[]): EventRowWrite[] {
      const lines: RawLine[] = recs.map((r, i) => {
        const bytes = Buffer.from(JSON.stringify(r), 'utf8');
        return { offset: i * 10_000, length: bytes.length, lineNo: i + 1, bytes };
      });
      const batch = normalizeRecords(lines, sessionFile({ fileId }), createNormalizerState());
      const turn = batch.items.flatMap((i) => i.events).find((e) => e.k === 'turn.prompt');
      expect(turn).toMatchObject({ origin: 'o'.repeat(32) });
      return batch.items.flatMap((i) => i.rows);
    }
  });

  it('inserts every row of a session with tools, a failure, notifications and a sentinel set', () => {
    const db = openInstanceDb({
      path: join(makeTemp('record-db').path, 'monitor.db'),
      expectedInstanceId: INSTANCE_ID,
      mode: 'serve',
      runtimeVersion: '3.0.0',
      clock: new FakeClock(FIXTURE_EPOCH_MS),
    });
    opened.push(db);
    const t = FIXTURE_EPOCH_MS;
    const { lastInsertRowid: sessionId } = db.driver
      .prepare(
        'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run([S, t, t, t, t]);
    db.driver
      .prepare(
        "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'main', NULL, 'main', 0, ?, ?, ?, ?)",
      )
      .run([sessionId, t, t, t, t]);
    const { lastInsertRowid: fileId } = db.driver
      .prepare(
        "INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at) VALUES ('f.jsonl', 'f.jsonl', 'session', ?, ?, ?)",
      )
      .run([S, t, t]);
    const repo = new EventsRepo(db);

    const rows: EventRowWrite[] = [];
    for (const b of [ordinarySession(), notificationSession(), sentinelSession()]) {
      let offset = 0;
      const lines = b.lines().map((text, i) => {
        const bytes = Buffer.from(text, 'utf8');
        const line: RawLine = { offset, length: bytes.length, lineNo: i + 1, bytes };
        offset += bytes.length + 1;
        return line;
      });
      const batch = normalizeRecords(lines, sessionFile({ fileId }), createNormalizerState());
      rows.push(...batch.items.flatMap((i) => i.rows));
    }
    expect(rows.length).toBeGreaterThan(20);
    let inserted = 0;
    for (const row of rows) {
      const result = withWriteTx(db, ctx, (tx) => repo.insert(ctx, tx, row));
      if (result.outcome === 'inserted') inserted += 1;
    }
    // the three sessions share record uuids, so part of the later rows are duplicates: only a CHECK failure would throw
    expect(inserted).toBeGreaterThan(10);
    const kinds = db.driver
      .prepare<{ kind: string }>('SELECT DISTINCT kind FROM events')
      .all()
      .map((r) => r.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['prompt.submit', 'tool.call', 'tool.result', 'tool.failure', 'agent.notification']),
    );
  });
});
