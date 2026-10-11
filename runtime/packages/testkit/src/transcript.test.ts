import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { useTempDirs } from './temp.ts';
import { bigTranscript, detUuid, projectDirName, TranscriptBuilder, type JsonRecord } from './transcript.ts';

const tempDir = useTempDirs();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const START = Date.UTC(2026, 0, 1, 12, 0, 0);
const SID = '11111111-1111-4111-8111-111111111111';

function builder(extra: { agentId?: string; uuidSeed?: string; stepMs?: number } = {}): TranscriptBuilder {
  return new TranscriptBuilder({ sessionId: SID, cwd: 'C:/FIXTURE/cwd', startMs: START, ...extra });
}

function records(b: TranscriptBuilder): JsonRecord[] {
  return b.lines().map((line) => JSON.parse(line) as JsonRecord);
}

/** Reads a nested value without assuming its shape. */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

describe('detUuid and projectDirName', () => {
  it('derives stable v4-shaped uuids from a seed and a counter', () => {
    expect(detUuid('seed', 1)).toBe(detUuid('seed', 1));
    expect(detUuid('seed', 1)).not.toBe(detUuid('seed', 2));
    expect(detUuid('seed', 1)).not.toBe(detUuid('other', 1));
    expect(detUuid('seed', 1)).toMatch(UUID_V4);
  });

  it('replaces every non-alphanumeric character like Claude Code does (survey 25)', () => {
    expect(projectDirName('C:\\Users\\FIXTURE.name\\my repo')).toBe('C--Users-FIXTURE-name-my-repo');
    expect(projectDirName('/home/fixture/.claude/x')).toBe('-home-fixture--claude-x');
  });
});

describe('records in general', () => {
  it('emits valid JSON per line, deterministic for the same inputs', () => {
    const make = (): string[] => builder().user().assistant({ messageId: 'msg_1' }).lines();
    expect(make()).toEqual(make());
    for (const line of make()) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });

  it('labels user-like text FIXTURE and never uses real data', () => {
    const b = builder().user().assistant({ messageId: 'msg_1' });
    const [user, assistant] = records(b);
    expect(at(user!, 'message', 'content')).toMatch(/^FIXTURE /);
    expect(at(assistant!, 'message', 'content', 0, 'text')).toMatch(/^FIXTURE /);
  });

  it('chains parentUuid, advances timestamps and carries the session fields', () => {
    const [a, b2, c] = records(builder({ stepMs: 2000 }).user().assistant({ messageId: 'm1' }).user('FIXTURE again'));
    expect(a!['parentUuid']).toBeNull();
    expect(b2!['parentUuid']).toBe(a!['uuid']);
    expect(c!['parentUuid']).toBe(b2!['uuid']);
    expect(a!['sessionId']).toBe(SID);
    expect(a!['cwd']).toBe('C:/FIXTURE/cwd');
    expect(a!['isSidechain']).toBe(false);
    expect(a!['timestamp']).toBe('2026-01-01T12:00:00.000Z');
    expect(b2!['timestamp']).toBe('2026-01-01T12:00:02.000Z');
    expect(a!['uuid']).toMatch(UUID_V4);
    expect(a!['promptId']).toMatch(UUID_V4);
  });

  it('cwd moves the working folder of every later record into a subfolder (shape 25)', () => {
    const recs = records(
      builder().user().assistant({ messageId: 'm1' }).cwd('C:/FIXTURE/cwd/sub').user('FIXTURE moved'),
    );
    expect(recs.map((r) => r['cwd'])).toEqual(['C:/FIXTURE/cwd', 'C:/FIXTURE/cwd', 'C:/FIXTURE/cwd/sub']);
    expect(recs[2]!['parentUuid']).toBe(recs[1]!['uuid']);
  });

  it('cwd rejects an empty folder', () => {
    expect(() => builder().cwd('')).toThrow(RangeError);
  });

  it('advance moves the clock, also backwards (order anomaly, shape 22)', () => {
    const recs = records(builder().user().advance(-5000).user('FIXTURE earlier'));
    expect(Date.parse(recs[1]!['timestamp'] as string)).toBeLessThan(Date.parse(recs[0]!['timestamp'] as string));
  });

  it('detach gives the next record parentUuid null in the middle of a file (shape 22)', () => {
    const recs = records(builder().user().assistant({ messageId: 'm1' }).detach().user('FIXTURE root again'));
    expect(recs[2]!['parentUuid']).toBeNull();
  });

  it('raw adds a record exactly as given and invalidLine adds a line that is not JSON', () => {
    const b = builder().raw({ type: 'FIXTURE-custom', n: 1 }).invalidLine().invalidLine('FIXTURE broken {');
    const lines = b.lines();
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'FIXTURE-custom', n: 1 });
    expect(() => JSON.parse(lines[1]!) as unknown).toThrow();
    expect(lines[2]).toBe('FIXTURE broken {');
  });
});

describe('assistant records (shapes 1-6)', () => {
  it('writes one content block per record with the id, model and default usage', () => {
    const [r] = records(builder().assistant({ messageId: 'msg_a', text: 'FIXTURE hello' }));
    expect(r!['type']).toBe('assistant');
    expect(at(r!, 'message', 'id')).toBe('msg_a');
    expect(at(r!, 'message', 'content')).toEqual([{ type: 'text', text: 'FIXTURE hello' }]);
    expect(at(r!, 'message', 'stop_reason')).toBe('end_turn');
    expect(at(r!, 'message', 'usage')).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    });
    expect(r!['requestId']).toMatch(/^req_/);
  });

  it('shape 1: streaming snapshots repeat the id with growing output and a final stop', () => {
    const recs = records(
      builder().assistant({
        messageId: 'msg_s',
        snapshots: 3,
        stop: 'tool_use',
        usage: { input_tokens: 3, output_tokens: 412, cache_read_input_tokens: 9000, cache_creation_input_tokens: 700 },
      }),
    );
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => at(r, 'message', 'id'))).toEqual(['msg_s', 'msg_s', 'msg_s']);
    expect(new Set(recs.map((r) => r['requestId'])).size).toBe(1);
    expect(recs.map((r) => at(r, 'message', 'stop_reason'))).toEqual([null, null, 'tool_use']);
    expect(recs.map((r) => at(r, 'message', 'usage', 'output_tokens'))).toEqual([8, 8, 412]);
    expect(recs.map((r) => at(r, 'message', 'usage', 'cache_read_input_tokens'))).toEqual([9000, 9000, 9000]);
    expect(new Set(recs.map((r) => r['uuid'])).size).toBe(3);
  });

  it('shape 3: an unfinalized id keeps stop_reason null on every snapshot', () => {
    const recs = records(builder().assistant({ messageId: 'msg_u', snapshots: 2, stop: null }));
    expect(recs.map((r) => at(r, 'message', 'stop_reason'))).toEqual([null, null]);
    expect(recs.map((r) => at(r, 'message', 'usage', 'output_tokens'))).toEqual([5, 5]);
  });

  it('outputPerRecord sets the output tokens of each snapshot (06 request)', () => {
    const recs = records(builder().assistant({ messageId: 'msg_o', snapshots: 3, outputPerRecord: [8, 40, 400] }));
    expect(recs.map((r) => at(r, 'message', 'usage', 'output_tokens'))).toEqual([8, 40, 400]);
  });

  it('shape 4: zeroTopLevel zeroes the top-level counters and fills iterations[0]', () => {
    const [r] = records(
      builder().assistant({
        messageId: 'msg_z',
        zeroTopLevel: true,
        usage: { input_tokens: 4, output_tokens: 60, cache_read_input_tokens: 800, cache_creation_input_tokens: 90 },
      }),
    );
    const usage = at(r!, 'message', 'usage');
    expect(usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(at(usage, 'iterations', 0)).toMatchObject({
      input_tokens: 4,
      output_tokens: 60,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 90,
    });
  });

  it('final adds iterations to the last snapshot only (06 request)', () => {
    const recs = records(builder().assistant({ messageId: 'msg_f', snapshots: 2, final: true }));
    expect(at(recs[0]!, 'message', 'usage', 'iterations')).toBeUndefined();
    expect(at(recs[1]!, 'message', 'usage', 'iterations')).toHaveLength(1);
  });

  it('booleanUsageField replaces one counter by a boolean (06 request, D13)', () => {
    const [r] = records(builder().assistant({ messageId: 'msg_b', booleanUsageField: 'output_tokens' }));
    expect(at(r!, 'message', 'usage', 'output_tokens')).toBe(true);
    expect(at(r!, 'message', 'usage', 'input_tokens')).toBe(10);
  });

  it('shape 6: abortedMidStream marks the record and leaves stop_reason null', () => {
    const [r] = records(builder().assistant({ messageId: 'msg_x', abortedMidStream: true }));
    expect(r!['isAbortedMidStream']).toBe(true);
    expect(at(r!, 'message', 'stop_reason')).toBeNull();
  });

  it('shape 5: apiError is a synthetic error record with zero usage and a non-msg id', () => {
    const [r] = records(builder().apiError());
    expect(r!['isApiErrorMessage']).toBe(true);
    expect(r!['apiErrorStatus']).toBe(529);
    expect(r!['error']).toBe('server_error');
    expect(at(r!, 'message', 'model')).toBe('<synthetic>');
    expect(at(r!, 'message', 'id')).not.toMatch(/^msg_/);
    expect(at(r!, 'message', 'id')).toHaveLength(36);
    expect(at(r!, 'message', 'stop_reason')).toBe('stop_sequence');
    expect(at(r!, 'message', 'usage')).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      service_tier: null,
      output_tokens_details: null,
    });
    expect(records(builder().apiError(500))[0]!['apiErrorStatus']).toBe(500);
  });

  it('shape 2: the same message id in two files is possible (global dedupe input)', () => {
    const one = records(builder().assistant({ messageId: 'msg_same' }));
    const two = records(
      new TranscriptBuilder({
        sessionId: '22222222-2222-4222-8222-222222222222',
        cwd: 'C:/FIXTURE/cwd',
        startMs: START,
      }).assistant({
        messageId: 'msg_same',
      }),
    );
    expect(at(one[0]!, 'message', 'id')).toBe(at(two[0]!, 'message', 'id'));
    expect(at(one[0]!, 'message', 'usage')).toEqual(at(two[0]!, 'message', 'usage'));
  });
});

describe('tools (shapes 7-11)', () => {
  it('shape 7: a tool pair links by id and by assistant uuid', () => {
    const b = builder();
    const id = b.toolUse('Bash', { command: 'echo FIXTURE' });
    b.toolResult(id, { content: 'FIXTURE output' });
    const [use, result] = records(b);
    const block = at(use!, 'message', 'content', 0);
    expect(block).toMatchObject({ type: 'tool_use', id, name: 'Bash', input: { command: 'echo FIXTURE' } });
    expect(at(block, 'caller')).toBeDefined();
    expect(at(use!, 'message', 'stop_reason')).toBe('tool_use');
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(at(result!, 'message', 'content')).toEqual([
      { type: 'tool_result', tool_use_id: id, content: 'FIXTURE output', is_error: false },
    ]);
    expect(result!['sourceToolAssistantUUID']).toBe(use!['uuid']);
    expect(result!['parentUuid']).toBe(use!['uuid']);
    expect(result!['toolUseResult']).toBeTypeOf('object');
  });

  it('shape 7: variants with list content, no is_error, null and string toolUseResult', () => {
    const b = builder();
    const a = b.toolUse('Bash');
    b.toolResult(a, { contentBlocks: true });
    const c = b.toolUse('Bash');
    b.toolResult(c, { omitIsError: true, toolUseResult: null });
    const d = b.toolUse('Bash');
    b.toolResult(d, { toolUseResult: 'FIXTURE plain string' });
    const results = records(b).filter((r) => r['type'] === 'user');
    expect(at(results[0]!, 'message', 'content', 0, 'content')).toEqual([{ type: 'text', text: 'FIXTURE result' }]);
    expect(at(results[1]!, 'message', 'content', 0)).not.toHaveProperty('is_error');
    expect(results[1]!['toolUseResult']).toBeNull();
    expect(results[2]!['toolUseResult']).toBe('FIXTURE plain string');
  });

  it('shape 8: parallel calls share one message id, results are separate records', () => {
    const b = builder();
    const first = b.toolUse('Read', {}, { messageId: 'msg_par' });
    const second = b.toolUse('Read', {}, { messageId: 'msg_par' });
    b.toolResult(first).toolResult(second);
    const recs = records(b);
    expect(recs.map((r) => r['type'])).toEqual(['assistant', 'assistant', 'user', 'user']);
    expect(at(recs[0]!, 'message', 'id')).toBe('msg_par');
    expect(at(recs[1]!, 'message', 'id')).toBe('msg_par');
    expect(recs[2]!['parentUuid']).toBe(recs[0]!['uuid']);
    expect(recs[3]!['parentUuid']).toBe(recs[1]!['uuid']);
    expect(at(recs[2]!, 'message', 'content')).toHaveLength(1);
  });

  it('shape 9: a pending tool_use is just a tool_use without a result, ids are unique', () => {
    const b = builder();
    const a = b.toolUse('Bash');
    const c = b.toolUse('Bash');
    expect(a).not.toBe(c);
    expect(records(b)).toHaveLength(2);
  });

  it('refuses a result for an unknown tool_use id', () => {
    expect(() => builder().toolResult('toolu_nope')).toThrow(/toolu_nope/);
  });

  it('shape 10: interrupts, plain and for tool use', () => {
    const b = builder().assistant({ messageId: 'msg_i', stop: 'tool_use' }).interrupt().interrupt({ forToolUse: true });
    const [, plain, forTool] = records(b);
    expect(at(plain!, 'message', 'content', 0, 'text')).toBe('[Request interrupted by user]');
    expect(at(forTool!, 'message', 'content', 0, 'text')).toBe('[Request interrupted by user for tool use]');
    expect(plain!['interruptedMessageId']).toBe('msg_i');
  });

  it('shape 11: a denial is an error result with the denial kind and decision', () => {
    const b = builder();
    const id = b.toolUse('Bash');
    b.toolResult(id, { denial: true });
    const result = records(b)[1]!;
    expect(at(result, 'message', 'content', 0, 'is_error')).toBe(true);
    expect(result['toolDenialKind']).toBe('user-rejected');
    expect(result['permissionDecision']).toMatchObject({ decision: 'reject' });
    const failing = builder();
    failing.toolResult(failing.toolUse('Bash'), { isError: true });
    expect(at(records(failing)[1]!, 'message', 'content', 0, 'is_error')).toBe(true);
  });
});

describe('turns, compaction, bookkeeping (shapes 12-16)', () => {
  it('shape 12: turnEnd writes end_turn then turn_duration with and without pending counts', () => {
    const recs = records(builder().turnEnd({ pendingBackgroundAgentCount: 2, pendingWorkflowCount: 1 }).turnEnd());
    expect(at(recs[0]!, 'message', 'stop_reason')).toBe('end_turn');
    expect(recs[1]).toMatchObject({
      type: 'system',
      subtype: 'turn_duration',
      parentUuid: recs[0]!['uuid'],
      pendingBackgroundAgentCount: 2,
      pendingWorkflowCount: 1,
    });
    expect(recs[1]!['durationMs']).toBeTypeOf('number');
    expect(recs[1]!['messageCount']).toBeTypeOf('number');
    expect(recs[1]!['isMeta']).toBe(false);
    expect('pendingBackgroundAgentCount' in recs[3]!).toBe(false);
    expect('pendingWorkflowCount' in recs[3]!).toBe(false);
  });

  it('shape 13: compact writes the boundary, the summary and resets the cache of the next answer', () => {
    const b = builder().user().assistant({ messageId: 'm1' }).compact().assistant({ messageId: 'm2' });
    const recs = records(b);
    const boundary = recs[2]!;
    expect(boundary).toMatchObject({ type: 'system', subtype: 'compact_boundary', parentUuid: null, level: 'info' });
    expect(boundary['logicalParentUuid']).toBe(recs[1]!['uuid']);
    expect(Object.keys(boundary['compactMetadata'] as object)).toEqual(
      expect.arrayContaining(['trigger', 'preTokens', 'postTokens', 'preservedSegment', 'preservedMessages']),
    );
    expect(recs[3]).toMatchObject({
      type: 'user',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      parentUuid: boundary['uuid'],
    });
    expect(at(recs[4]!, 'message', 'usage', 'cache_read_input_tokens')).toBe(0);
    expect(at(recs[4]!, 'message', 'usage', 'cache_creation_input_tokens')).toBeGreaterThan(20);
  });

  it('shape 13: the attachment variant follows the boundary with an attachment record', () => {
    const recs = records(builder().user().compact({ attachment: true }));
    expect(recs[2]!['type']).toBe('attachment');
    expect(recs[2]!['parentUuid']).toBe(recs[1]!['uuid']);
  });

  it('shape 14: every bookkeeping kind is one record that carries no chain fields', () => {
    const kinds = [
      'last-prompt',
      'ai-title',
      'custom-title',
      'agent-name',
      'mode',
      'permission-mode',
      'atis-latch',
      'queue-operation',
      'file-history-snapshot',
      'file-history-delta',
      'bridge-session',
      'cost-state',
      'continued-in',
    ] as const;
    const b = builder().user();
    for (const kind of kinds) b.bookkeeping(kind);
    const recs = records(b).slice(1);
    expect(recs.map((r) => r['type'])).toEqual([...kinds]);
    for (const r of recs) {
      expect('uuid' in r && r['type'] !== 'file-history-snapshot').toBe(false);
      expect(r['parentUuid']).toBeUndefined();
    }
    const next = records(b.user('FIXTURE after'));
    expect(next.at(-1)!['parentUuid']).toBe(next[0]!['uuid']);
  });

  it('shape 15: cost-state with two models (one with a [1m] suffix) and with an empty modelUsage', () => {
    const recs = records(builder().bookkeeping('cost-state').bookkeeping('cost-state', { emptyModelUsage: true }));
    const models = Object.keys(recs[0]!['modelUsage'] as object);
    expect(models).toHaveLength(2);
    expect(models.some((m) => m.endsWith('[1m]'))).toBe(true);
    expect(recs[1]!['modelUsage']).toEqual({});
  });

  it('shape 15 and 21: continued-in names the next session', () => {
    const [r] = records(
      builder().bookkeeping('continued-in', { continuedInSessionId: '33333333-3333-4333-8333-333333333333' }),
    );
    expect(r!['continuedInSessionId']).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('shape 16: attachment kinds', () => {
    const types = [
      'hook_success',
      'queued_command',
      'task_status',
      'structured_output',
      'total_tokens_reminder',
      'date',
      'environment',
    ] as const;
    const b = builder().user();
    for (const type of types) b.attachment(type);
    b.attachment('queued_command', { commandMode: 'task-notification' });
    const recs = records(b).slice(1);
    expect(recs.map((r) => (r['attachment'] as JsonRecord)['type'])).toEqual([...types, 'queued_command']);
    expect(recs[1]!['attachment']).toMatchObject({ commandMode: 'prompt' });
    expect(recs[7]!['attachment']).toMatchObject({ commandMode: 'task-notification' });
    expect(recs[0]!['attachment']).toMatchObject({ hookEvent: 'PostToolUse', exitCode: 0 });
    expect(JSON.stringify(recs[4]).length).toBeGreaterThan(2000);
    for (const r of recs) expect(r['parentUuid']).toBeTypeOf('string');
  });
});

describe('agents (shapes 17-20)', () => {
  it('shape 17: a background launch, its async result and a later notification', () => {
    const b = builder();
    const toolUseId = b.agentLaunch({ agentId: 'abc123def4567890a', background: true });
    b.taskNotification({ taskId: 'task_1', toolUseId, status: 'completed' });
    b.taskNotification({ taskId: 'task_1', toolUseId });
    const [use, result, done, event] = records(b);
    expect(at(use!, 'message', 'content', 0)).toMatchObject({ name: 'Agent', input: { run_in_background: true } });
    expect(result!['toolUseResult']).toMatchObject({
      agentId: 'abc123def4567890a',
      status: 'async_launched',
      isAsync: true,
    });
    expect(done!['origin']).toMatchObject({ kind: 'task-notification' });
    const text = at(done!, 'message', 'content') as string;
    expect(text).toContain('<task-id>task_1</task-id>');
    expect(text).toContain(`<tool-use-id>${toolUseId}</tool-use-id>`);
    expect(text).toContain('<status>completed</status>');
    expect(text).toContain('<usage>');
    expect(at(event!, 'message', 'content') as string).not.toContain('<status>');
  });

  it('a foreground launch completes synchronously', () => {
    const b = builder();
    b.agentLaunch({ agentId: 'abc123def4567890a', background: false });
    expect(records(b)[1]!['toolUseResult']).toMatchObject({ status: 'completed', isAsync: false });
  });

  it('shape 18: a subagent file starts with a string prompt and ends with a handback that ends the turn', () => {
    const b = builder({ agentId: 'abc123def4567890a' })
      .user('FIXTURE sub prompt')
      .assistant({ messageId: 'ag_1' })
      .endTurnTool('SubagentHandback');
    const recs = records(b);
    expect(recs[0]).toMatchObject({ parentUuid: null, isSidechain: true, agentId: 'abc123def4567890a' });
    expect(at(recs[0]!, 'message', 'content')).toBe('FIXTURE sub prompt');
    const last = recs.at(-1)!;
    expect(last['toolEndsTurn']).toBe(true);
    expect(at(last, 'message', 'content', 0, 'type')).toBe('tool_result');
    expect(at(recs.at(-2)!, 'message', 'content', 0, 'name')).toBe('SubagentHandback');
    for (const r of recs) expect(r['agentId']).toBe('abc123def4567890a');
  });

  it('shape 20: a workflow agent ends with StructuredOutput', () => {
    const recs = records(builder({ agentId: 'abc123def4567890a' }).user().endTurnTool('StructuredOutput'));
    expect(at(recs.at(-2)!, 'message', 'content', 0, 'name')).toBe('StructuredOutput');
    expect(recs.at(-1)!['toolEndsTurn']).toBe(true);
  });

  it('shape 21: a resume copy shares uuids and message ids under another session id', () => {
    const make = (sessionId: string): TranscriptBuilder =>
      new TranscriptBuilder({ sessionId, cwd: 'C:/FIXTURE/cwd', startMs: START, uuidSeed: 'resume' })
        .user()
        .assistant({ messageId: 'msg_r' });
    const older = make('11111111-1111-4111-8111-111111111111').bookkeeping('continued-in', {
      continuedInSessionId: '44444444-4444-4444-8444-444444444444',
    });
    const newer = make('44444444-4444-4444-8444-444444444444');
    const a = records(older);
    const b = records(newer);
    expect(a[0]!['uuid']).toBe(b[0]!['uuid']);
    expect(a[1]!['uuid']).toBe(b[1]!['uuid']);
    expect(a[0]!['sessionId']).not.toBe(b[0]!['sessionId']);
    expect(at(a[1]!, 'message', 'id')).toBe(at(b[1]!, 'message', 'id'));
    expect(a.at(-1)!['type']).toBe('continued-in');
  });
});

describe('files (shape 23)', () => {
  it('write puts one JSON per line with a trailing newline by default', () => {
    const file = join(tempDir('tr').path, 'sub', 's.jsonl');
    builder().user().assistant({ messageId: 'm1' }).write(file);
    const text = readFileSync(file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(3);
  });

  it('supports no final newline, CRLF and a BOM', () => {
    const dir = tempDir('tr2').path;
    const b = builder().user().assistant({ messageId: 'm1' });
    b.write(join(dir, 'a'), { newlineAtEnd: false });
    expect(readFileSync(join(dir, 'a'), 'utf8').endsWith('}')).toBe(true);
    b.write(join(dir, 'b'), { crlf: true });
    expect(readFileSync(join(dir, 'b'), 'utf8').split('\r\n')).toHaveLength(3);
    b.write(join(dir, 'c'), { bom: true });
    expect(readFileSync(join(dir, 'c')).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('partialLastBytes cuts the last line short without a newline', () => {
    const dir = tempDir('tr3').path;
    const b = builder().user().assistant({ messageId: 'm1' });
    b.write(join(dir, 'p'), { partialLastBytes: 20 });
    const lines = readFileSync(join(dir, 'p'), 'utf8').split('\n');
    expect(lines).toHaveLength(2);
    expect(Buffer.byteLength(lines[1]!)).toBe(20);
    expect(() => JSON.parse(lines[1]!) as unknown).toThrow();
  });

  it('appendTo grows a file in place from a line number', () => {
    const file = join(tempDir('tr4').path, 'g.jsonl');
    const b = builder().user();
    b.write(file);
    const before = statSync(file).size;
    b.assistant({ messageId: 'm1' }).user('FIXTURE third');
    b.appendTo(file, 1);
    expect(statSync(file).size).toBeGreaterThan(before);
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toEqual(b.lines());
  });

  it('write creates parent folders and never touches paths outside the given file', () => {
    const dir = tempDir('tr5').path;
    mkdirSync(join(dir, 'x'));
    builder()
      .user()
      .write(join(dir, 'x', 'y', 'z.jsonl'));
    expect(existsSync(join(dir, 'x', 'y', 'z.jsonl'))).toBe(true);
    writeFileSync(join(dir, 'keep'), 'k');
    expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('k');
  });
});

describe('bigTranscript', () => {
  it('reaches the target size with valid lines', () => {
    const b = bigTranscript({ sessionId: SID, targetBytes: 200_000 });
    const lines = b.lines();
    const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    expect(bytes).toBeGreaterThanOrEqual(200_000);
    expect(bytes).toBeLessThan(200_000 + 20_000);
    for (const line of lines.slice(0, 50)) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });

  it('includes one very long line when maxLineBytes is given (shape 23)', () => {
    const b = bigTranscript({ sessionId: SID, targetBytes: 50_000, maxLineBytes: 300_000 });
    const longest = Math.max(...b.lines().map((line) => Buffer.byteLength(line)));
    expect(longest).toBeGreaterThan(290_000);
    expect(longest).toBeLessThanOrEqual(300_000);
  });

  it('is deterministic', () => {
    const make = (): string[] => bigTranscript({ sessionId: SID, targetBytes: 30_000 }).lines();
    expect(make()).toEqual(make());
  });
});
