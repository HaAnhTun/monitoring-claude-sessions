// The pure parts of the handler (02 2.3, 2.4) and the whole run with injected dependencies. The real process, the stub and
// the spool on disk are covered by packages/cli/test/hook.int.test.ts.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';

import {
  HOOK_EVENT_POLICY,
  INSTALLED_HOOK_EVENTS,
  STDIN_MAX_BYTES,
  routeKey,
  type HookEnvelopeV1,
  type HookRouteV1,
} from '@mcs/shared/protocol';
import { buildRepo, buildTaskWorkspace, hookPayload, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import {
  buildEnvelope,
  extractIds,
  handleHook,
  parseArgv,
  readStdin,
  sanitizeEventData,
  type HookDeps,
} from './main.ts';

const makeTemp = useTempDirs();
const LF = String.fromCharCode(10);
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
/** A preview without the ` ... [truncated N chars]` note that `clip` appends: the part the 160 code point cap is about. */
const previewBody = (value: unknown): string => asText(value).split(' ... [truncated ')[0] ?? '';
const SID = '11111111-2222-4333-8444-555555555555';
const INSTANCE = '6a0f3c1e-1b2c-4d3e-8f40-0123456789ab';
const BASE = { sessionId: SID, cwd: 'C:/FIXTURE/repo', transcriptPath: 'C:/FIXTURE/projects/p/' + SID + '.jsonl' };

describe('parseArgv', () => {
  it('reads the event after --mcs-hook and the async flag', () => {
    expect(parseArgv(['--mcs-hook', 'PreToolUse', '--async'])).toEqual({
      hookMode: true,
      event: 'PreToolUse',
      async: true,
    });
    expect(parseArgv(['--mcs-hook'])).toEqual({ hookMode: true, event: '', async: false });
    expect(parseArgv(['--mcs-hook', '--async'])).toEqual({ hookMode: true, event: '', async: true });
    expect(parseArgv(['--mcs-hook', 'bad event!'])).toMatchObject({ event: '' });
    expect(parseArgv(['--version'])).toEqual({ hookMode: false, event: '', async: false });
  });
});

describe('readStdin', () => {
  it('keeps the first bytes, counts all of them and resolves on end', async () => {
    const result = await readStdin(Readable.from([Buffer.from('abcdef'), Buffer.from('ghij')]), 7);
    expect(result.kept.toString()).toBe('abcdefg');
    expect(result.total).toBe(10);
  });

  it('keeps nothing with a cap of 0', async () => {
    const result = await readStdin(Readable.from([Buffer.from('abc')]), 0);
    expect(result).toEqual({ kept: Buffer.alloc(0), total: 3 });
  });
});

describe('extractIds', () => {
  it('accepts valid ids and normalizes paths', () => {
    const { ids, flags } = extractIds({
      session_id: SID,
      transcript_path: 'C:' + String.fromCharCode(92) + 'p' + String.fromCharCode(92) + 'x.jsonl',
      cwd: 'D:/repo/',
      agent_id: 'a1b2c3d4e5',
      tool_use_id: 'toolu_01',
      permission_mode: 'default',
    });
    expect(flags).toEqual([]);
    expect(ids).toMatchObject({
      session_id: SID,
      transcript_path: 'C:/p/x.jsonl',
      cwd: 'D:/repo',
      agent_id: 'a1b2c3d4e5',
    });
    expect(ids.prompt_id).toBeNull();
  });

  it('turns invalid fields into null plus invalid_<field>, and treats absence as valid', () => {
    const { ids, flags } = extractIds({
      session_id: 'NOT-A-UUID',
      transcript_path: 'x'.repeat(2000),
      cwd: 12,
      agent_type: 'a' + String.fromCharCode(0) + 'b',
      permission_mode: 'y'.repeat(65),
    });
    expect(flags).toEqual([
      'invalid_session_id',
      'invalid_transcript_path',
      'invalid_cwd',
      'invalid_agent_type',
      'invalid_permission_mode',
    ]);
    expect(Object.values(ids).every((value) => value === null)).toBe(true);
  });
});

describe('sanitizeEventData', () => {
  it('stores no dropped field raw, for all 21 policies (WP-101 privacy property)', () => {
    // The sentinel carries a secret in front and a unique tail far past every cap: a raw copy would show the tail, an
    // unredacted preview would show the secret, and a preview longer than its cap would show more than 160 code points.
    const SECRET = 'password=hunter2hunter2';
    const sentinel = (field: string): string => `${SECRET} ${'word '.repeat(80)} SENTINEL_RAW_${field}`;
    for (const event of INSTALLED_HOOK_EVENTS) {
      const policy = HOOK_EVENT_POLICY[event];
      const payload: Record<string, unknown> = {};
      for (const field of [...policy.dropped, ...policy.summarized.map((s) => s.from.split('.')[0] ?? '')]) {
        payload[field] = sentinel(field);
      }
      const { data } = sanitizeEventData(event, payload);
      const allowed = new Set([
        ...policy.kept.map((k) => k.name),
        ...policy.summarized.flatMap((s) => s.into),
        'effort_level',
      ]);
      for (const [key, value] of Object.entries(data)) {
        expect(allowed.has(key), `${event} stores the key ${key}, which the policy does not list`).toBe(true);
        expect(policy.dropped, `${event} stores a dropped field under its own name: ${key}`).not.toContain(key);
        if (key.endsWith('_preview')) {
          expect(
            Array.from(previewBody(value)).length,
            `${event} ${key} is longer than 160 code points`,
          ).toBeLessThanOrEqual(160);
        }
      }
      const stored = JSON.stringify(data);
      expect(stored, `${event} stored a raw dropped field`).not.toContain('SENTINEL_RAW_');
      expect(stored, `${event} stored an unredacted secret`).not.toContain('hunter2hunter2');
    }
  });

  it('StopFailure keeps a redacted error_preview of error_details (at most 160 code points) and no error_details', () => {
    const { data, flags } = sanitizeEventData('StopFailure', {
      error: 'rate_limit',
      error_details: `password=hunter2hunter2 ${'word '.repeat(80)}`,
      last_assistant_message: 'SENTINEL_RAW_message',
    });
    expect(data['error']).toBe('rate_limit');
    expect(asText(data['error_preview']).startsWith('password=[redacted] word word')).toBe(true);
    expect(asText(data['error_preview'])).toContain(' ... [truncated ');
    expect(Array.from(previewBody(data['error_preview'])).length).toBeLessThanOrEqual(160);
    expect(flags).toEqual(['redacted']);
    expect(Object.keys(data)).not.toContain('error_details');
    expect(JSON.stringify(data)).not.toContain('SENTINEL_RAW_');
    expect(data['last_message_len']).toBe(20);
  });

  it('keeps the policy fields verbatim and capped, and nothing else', () => {
    const { data } = sanitizeEventData('SessionStart', {
      source: 'x'.repeat(40),
      model: 'claude-test',
      context_tokens: 12,
      session_title: 'SENTINEL title',
      unrelated: 'SENTINEL other',
    });
    expect(data).toEqual({ source: 'x'.repeat(16), model: 'claude-test', context_tokens: 12, session_title_len: 14 });
  });

  it('summarizes a tool call: redacted summary, hash, bytes and key names', () => {
    const { data, flags } = sanitizeEventData('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"', description: 'd' },
    });
    expect(flags).toEqual(['redacted']);
    expect(data['tool_name']).toBe('Bash');
    expect(asText(data['tool_summary'])).toContain('[redacted]');
    expect(asText(data['tool_summary'])).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(data['tool_input_hash']).toMatch(/^[0-9a-f]{32}$/);
    expect(data['tool_input_keys']).toBe('command,description');
    expect(data['tool_input_bytes']).toBeGreaterThan(10);
  });

  it('adds the Agent and Workflow fields of PreToolUse and PostToolUse', () => {
    expect(
      sanitizeEventData('PreToolUse', {
        tool_name: 'Agent',
        tool_input: { subagent_type: 'explore', run_in_background: true },
      }).data,
    ).toMatchObject({ subagent_type: 'explore', run_in_background: true });
    expect(
      sanitizeEventData('PreToolUse', { tool_name: 'Workflow', tool_input: { name: 'build' } }).data['workflow_name'],
    ).toBe('build');
    expect(
      sanitizeEventData('PostToolUse', {
        tool_name: 'Agent',
        duration_ms: 5,
        tool_response: {
          agentId: 'a1b2c3d4',
          status: 'completed',
          totalTokens: 9,
          totalDurationMs: 3,
          totalToolUseCount: 2,
        },
      }).data,
    ).toMatchObject({
      agent_link_id: 'a1b2c3d4',
      agent_status: 'completed',
      agent_total_tokens: 9,
      agent_tool_use_count: 2,
    });
    expect(
      sanitizeEventData('PostToolUse', {
        tool_name: 'Workflow',
        tool_response: { runId: 'wf_abc', status: 'done', taskId: 't1' },
      }).data,
    ).toMatchObject({ run_id: 'wf_abc', run_status: 'done', task_id: 't1' });
    expect(
      sanitizeEventData('PostToolUse', { tool_name: 'Workflow', tool_response: { runId: 'not valid' } }).data['run_id'],
    ).toBeUndefined();
    expect(
      sanitizeEventData('PostToolUse', { tool_name: 'Bash', tool_response: { interrupted: true, stdout: 'SENTINEL' } })
        .data,
    ).toMatchObject({ interrupted: true });
  });

  it('derives the exit code only from a first line of the form "Exit code N"', () => {
    expect(
      sanitizeEventData('PostToolUseFailure', { tool_name: 'Bash', error: 'Exit code 127' + LF + 'body' }).data,
    ).toMatchObject({
      exit_code: 127,
      error_len: 18,
    });
    expect(
      sanitizeEventData('PostToolUseFailure', { error: 'Something Exit code 2' }).data['exit_code'],
    ).toBeUndefined();
    expect(sanitizeEventData('PostToolUseFailure', { error: 'Exit code 123456' }).data['exit_code']).toBeUndefined();
  });

  it('lists tool calls of a batch, cut at 64 with the truncation flag', () => {
    const calls = Array.from({ length: 70 }, (_unused, i) => ({
      tool_use_id: `toolu_${String(i)}`,
      tool_name: 'Bash',
      tool_input: 'SENTINEL',
    }));
    const { data, flags } = sanitizeEventData('PostToolBatch', { tool_calls: calls });
    expect(data['calls']).toHaveLength(64);
    expect(flags).toEqual(['data_truncated:calls']);
    expect(JSON.stringify(data)).not.toContain('SENTINEL');
  });

  it('previews notification text with redaction and keeps the length', () => {
    const { data, flags } = sanitizeEventData('Notification', {
      notification_type: 'permission_prompt',
      title: 'word '.repeat(40),
      message: 'password=hunter2hunter2 is here',
    });
    expect(asText(data['title_preview']).startsWith('word '.repeat(16))).toBe(true);
    expect(asText(data['title_preview'])).toContain('truncated');
    expect(data['message_preview']).toBe('password=[redacted] is here');
    expect(data['message_len']).toBe(31);
    expect(flags).toEqual(['redacted']);
  });

  it('counts code points of a prompt and flags a slash command', () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(sanitizeEventData('UserPromptSubmit', { prompt: '  /compact now' + emoji }).data).toEqual({
      prompt_len: 15,
      prompt_slash: true,
    });
    expect(sanitizeEventData('UserPromptSubmit', { prompt: 'hello' }).data['prompt_slash']).toBe(false);
  });

  it('counts the lists of Stop and SubagentStop and keeps their stop flag', () => {
    expect(
      sanitizeEventData('Stop', {
        stop_hook_active: true,
        last_assistant_message: 'abc',
        background_tasks: [1, 2],
        session_crons: [],
      }).data,
    ).toEqual({ stop_hook_active: true, last_message_len: 3, background_task_count: 2, cron_count: 0 });
  });

  it('keeps only the key names of an unknown event, at most 32', () => {
    const payload = Object.fromEntries(Array.from({ length: 40 }, (_unused, i) => [`key${String(i)}`, 'SENTINEL']));
    const { data, flags } = sanitizeEventData('NoSuchEvent', payload);
    expect(Object.keys(data)).toEqual(['data_keys']);
    expect(asText(data['data_keys']).split(',')).toHaveLength(32);
    expect(flags).toEqual(['data_truncated:data_keys']);
    expect(JSON.stringify(data)).not.toContain('SENTINEL');
  });

  it('keeps the effort level of any event', () => {
    expect(sanitizeEventData('Stop', { effort: { level: 'high' } }).data['effort_level']).toBe('high');
  });

  it.each(INSTALLED_HOOK_EVENTS.map((event) => [event]))('%s: no dropped field survives', (event) => {
    const dropped = HOOK_EVENT_POLICY[event].dropped;
    const previewed = HOOK_EVENT_POLICY[event].summarized.filter((rule) =>
      rule.into.some((key) => key.endsWith('_preview')),
    );
    const payload = hookPayload(
      event,
      BASE,
      Object.fromEntries(
        dropped
          .filter((field) => !previewed.some((rule) => rule.from === field))
          .map((field) => [field, `SENTINEL_DROP_${field}`]),
      ),
    );
    expect(JSON.stringify(sanitizeEventData(event, payload).data)).not.toContain('SENTINEL_DROP_');
  });
});

describe('buildEnvelope', () => {
  const base = {
    kind: 'hook' as const,
    eventUid: '0f8b5e2a-7c41-4e0b-9d3a-2b1c0d9e8f7a',
    receivedAt: 1,
    event: 'Stop',
    argvEvent: 'Stop',
    ids: extractIds({}).ids,
    claudePid: null,
    payloadBytes: 2,
    contentHash: '0123456789abcdef0123456789abcdef',
    handler: { version: '3.0.0', pid: 1, async: false },
    flags: ['redacted'],
    data: {},
  };

  it('adds the routed_by flag of how the route matched, once, and the instance id', () => {
    expect(buildEnvelope(base, INSTANCE, 'transcript').flags).toEqual(['redacted']);
    expect(buildEnvelope(base, INSTANCE, 'session_pin').flags).toEqual(['redacted', 'routed_by_session_pin']);
    expect(buildEnvelope(base, INSTANCE, 'cwd')).toMatchObject({
      flags: ['redacted', 'routed_by_cwd'],
      instance_id: INSTANCE,
    });
  });

  it('caps the flags at 32', () => {
    const flags = Array.from({ length: 40 }, (_unused, i) => `invalid_f${'a'.repeat(i + 1)}`);
    expect(buildEnvelope({ ...base, flags }, INSTANCE, 'cwd').flags).toHaveLength(32);
  });
});

describe('handleHook with injected dependencies', () => {
  function world(): {
    home: string;
    spoolDir: string;
    deps: (stdin: string, env?: Record<string, string>) => HookDeps;
  } {
    const root = makeTemp('hookrun').path;
    const { repo } = buildRepo(join(root, 'repo'));
    const workspace = buildTaskWorkspace(repo, { slug: 'task-a', config: {}, instance: { instanceId: INSTANCE } })
      .split(sep)
      .join('/');
    const transcripts = join(root, 'projects', 'p').split(sep).join('/');
    const home = join(root, 'home');
    mkdirSync(join(home, 'routes'), { recursive: true });
    const route: HookRouteV1 = {
      v: 1,
      instanceId: INSTANCE,
      workspace,
      spoolDir: `${workspace}/data/spool`,
      stateFile: `${workspace}/state.json`,
      enabled: true,
      match: { transcriptsDirs: [routeKey(transcripts)], sessionIds: [] },
      stoppedAt: null,
      spoolUntil: null,
      updatedAt: 1,
    };
    writeFileSync(join(home, 'routes', `${INSTANCE}.json`), JSON.stringify(route));
    const payload = hookPayload('Stop', { ...BASE, transcriptPath: `${transcripts}/${SID}.jsonl` });
    expect(payload['session_id']).toBe(SID);
    return {
      home,
      spoolDir: route.spoolDir,
      deps: (stdin, env = {}) => ({
        env: { MCS_HOME: home, CLAUDE_PID: '4242', ...env },
        now: () => Date.UTC(2026, 9, 11, 14, 5),
        pid: 99,
        stdinIsTty: false,
        readStdin: (maxBytes) => {
          const bytes = Buffer.from(stdin);
          return Promise.resolve({ kept: bytes.subarray(0, maxBytes), total: bytes.length });
        },
      }),
    };
  }

  function stopPayload(w: ReturnType<typeof world>): string {
    const transcripts = JSON.parse(readFileSync(join(w.home, 'routes', `${INSTANCE}.json`), 'utf8')) as HookRouteV1;
    return JSON.stringify(
      hookPayload('Stop', {
        ...BASE,
        transcriptPath: `${transcripts.match.transcriptsDirs[0] ?? ''}/${SID}.jsonl`,
      }),
    );
  }

  it('writes one stamped line for a routed event', async () => {
    const w = world();
    await handleHook(['--mcs-hook', 'Stop'], w.deps(stopPayload(w)));
    const [name] = readdirSync(w.spoolDir);
    expect(name).toBe('hooks-20261011T14Z.ndjson');
    const line = JSON.parse(readFileSync(join(w.spoolDir, name ?? ''), 'utf8').trim()) as HookEnvelopeV1;
    expect(line).toMatchObject({
      v: 1,
      kind: 'hook',
      instance_id: INSTANCE,
      received_at: Date.UTC(2026, 9, 11, 14, 5),
      event: 'Stop',
      argv_event: 'Stop',
      session_id: SID,
      claude_pid: 4242,
      handler: { pid: 99, async: false },
    });
  });

  it('does nothing without --mcs-hook, with the guard variable, or on a terminal', async () => {
    const w = world();
    const input = stopPayload(w);
    await handleHook([], w.deps(input));
    await handleHook(['--mcs-hook', 'Stop'], w.deps(input, { MCS_HOOK_DISABLE: '1' }));
    await handleHook(['--mcs-hook', 'Stop'], { ...w.deps(input), stdinIsTty: true });
    expect(() => readdirSync(w.spoolDir)).toThrow();
  });

  it('flags a stdin over the cap as truncated (the line is cut, so it logs a parse error)', async () => {
    const w = world();
    const deps = w.deps('');
    await handleHook(['--mcs-hook', 'Stop'], {
      ...deps,
      readStdin: () => Promise.resolve({ kept: Buffer.from('{"a":'), total: STDIN_MAX_BYTES + 1 }),
    });
    const log = readFileSync(join(w.home, 'logs', 'hook-handler.jsonl'), 'utf8');
    expect(log).toContain('STDIN_PARSE_ERROR');
  });
});
