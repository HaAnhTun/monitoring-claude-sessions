import { join } from 'node:path';

import { ASYNC_HOOK_EVENTS, INSTALLED_HOOK_EVENTS } from '@mcs/shared/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  assertHandlerEntry,
  hookCommand,
  hookPayload,
  runHookHandler,
  type HookEventName,
  type RunHookOptions,
} from './hooks.ts';
import { skillRoot, runtimeRoot } from './processes.ts';
import { useTempDirs } from './temp.ts';

const tempDir = useTempDirs();
const BASE = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  cwd: 'C:/FIXTURE/repo',
  transcriptPath: 'C:/FIXTURE/t.jsonl',
};

describe('HookEventName', () => {
  it('has the 21 installed events (type test)', () => {
    expectTypeOf<HookEventName>().toEqualTypeOf<(typeof INSTALLED_HOOK_EVENTS)[number]>();
    expect(INSTALLED_HOOK_EVENTS).toHaveLength(21);
  });
});

describe('hookPayload', () => {
  it.each(INSTALLED_HOOK_EVENTS.map((event) => [event]))('%s carries the common fields and its own name', (event) => {
    const payload = hookPayload(event, BASE);
    expect(payload['hook_event_name']).toBe(event);
    expect(payload['session_id']).toBe(BASE.sessionId);
    expect(payload['transcript_path']).toBe(BASE.transcriptPath);
    expect(payload['cwd']).toBe(BASE.cwd);
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it('keeps every user-like string labelled FIXTURE', () => {
    const userContent: Record<string, string[]> = {
      UserPromptSubmit: ['prompt'],
      PermissionDenied: ['reason'],
      Notification: ['title', 'message'],
      SubagentStop: ['last_assistant_message'],
      Stop: ['last_assistant_message'],
      StopFailure: ['error_details', 'last_assistant_message'],
      TaskCreated: ['task_subject', 'task_description'],
      TaskCompleted: ['task_subject', 'task_description'],
      PreCompact: ['custom_instructions'],
      PostCompact: ['compact_summary'],
    };
    for (const [event, keys] of Object.entries(userContent)) {
      const payload = hookPayload(event as HookEventName, BASE);
      for (const key of keys) expect(String(payload[key]), `${event}.${key}`).toMatch(/^FIXTURE/);
    }
  });

  it('PostToolUse for Bash has the observed tool_response key set', () => {
    const payload = hookPayload('PostToolUse', BASE);
    expect(payload['tool_name']).toBe('Bash');
    expect(Object.keys(payload['tool_response'] as object).sort()).toEqual(
      ['interrupted', 'isImage', 'noOutputExpected', 'stderr', 'stdout'].sort(),
    );
    expect(payload['tool_use_id']).toMatch(/^toolu_/);
  });

  it('SubagentStop has exactly the documented key set plus the common fields', () => {
    const keys = Object.keys(hookPayload('SubagentStop', BASE)).sort();
    expect(keys).toEqual(
      [
        'session_id',
        'transcript_path',
        'cwd',
        'hook_event_name',
        'stop_hook_active',
        'agent_id',
        'agent_type',
        'agent_transcript_path',
        'last_assistant_message',
        'background_tasks',
        'session_crons',
      ].sort(),
    );
    expect(hookPayload('SubagentStop', BASE)['agent_id']).toMatch(/^[0-9a-f]{17}$/);
  });

  it('PermissionRequest has no tool_use_id, as observed', () => {
    expect('tool_use_id' in hookPayload('PermissionRequest', BASE)).toBe(false);
  });

  it('extra overlays the defaults and cannot change the event name', () => {
    const payload = hookPayload('PreToolUse', BASE, {
      tool_name: 'Agent',
      tool_use_id: 'toolu_custom',
      hook_event_name: 'Stop',
    });
    expect(payload['tool_name']).toBe('Agent');
    expect(payload['tool_use_id']).toBe('toolu_custom');
    expect(payload['hook_event_name']).toBe('PreToolUse');
  });

  it('is deterministic for the same inputs', () => {
    expect(hookPayload('SessionStart', BASE)).toEqual(hookPayload('SessionStart', BASE));
  });
});

describe('hookCommand', () => {
  it('spawns the installed stub scripts/mcs-hook.mjs of the skill by default (02 2.1)', () => {
    const cmd = hookCommand('SessionStart', {});
    expect(cmd.file).toBe(process.execPath);
    expect(cmd.args).toEqual([
      '--no-warnings',
      join(skillRoot(), 'scripts', 'mcs-hook.mjs'),
      '--mcs-hook',
      'SessionStart',
    ]);
  });

  it('appends --async for the async events and honours the override both ways', () => {
    for (const event of ASYNC_HOOK_EVENTS) expect(hookCommand(event, {}).args.at(-1)).toBe('--async');
    expect(hookCommand('Stop', {}).args).not.toContain('--async');
    expect(hookCommand('Stop', { async: true }).args.at(-1)).toBe('--async');
    expect(hookCommand('PreToolUse', { async: false }).args).not.toContain('--async');
  });

  it('direct runs runtime/packages/cli/dist/hook.js instead', () => {
    const cmd = hookCommand('Stop', { direct: true });
    expect(cmd.args).toEqual([
      '--no-warnings',
      join(runtimeRoot(), 'packages', 'cli', 'dist', 'hook.js'),
      '--mcs-hook',
      'Stop',
    ]);
  });
});

describe('assertHandlerEntry', () => {
  it('names the missing file and says to build', () => {
    const missing = join(tempDir('hooks').path, 'nope.js');
    expect(() => {
      assertHandlerEntry(missing);
    }).toThrow(/nope\.js/);
  });
});

describe('runHookHandler', () => {
  it('requires an event when raw stdin is sent', async () => {
    await expect(runHookHandler(undefined, { mcsHome: tempDir('hk1').path, rawStdin: '{broken' })).rejects.toThrow(
      /event/,
    );
  });

  it('runs the built handler with the payload on stdin and returns code, output and duration', async () => {
    const mcsHome = join(tempDir('hk2').path, 'mcs-home');
    const payload = hookPayload('SessionStart', BASE);
    const result = await runHookHandler(payload, { mcsHome, direct: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(typeof result.stderr).toBe('string');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('accepts malformed raw stdin without throwing in the harness', async () => {
    const mcsHome = join(tempDir('hk3').path, 'mcs-home');
    const result = await runHookHandler(undefined, { mcsHome, direct: true, event: 'Stop', rawStdin: '{broken' });
    expect(typeof result.code).toBe('number');
  });

  it('exposes the documented option names', () => {
    expectTypeOf<RunHookOptions>().toHaveProperty('mcsHome');
    expectTypeOf<RunHookOptions>().toHaveProperty('direct');
    expectTypeOf<RunHookOptions>().toHaveProperty('rawStdin');
  });
});
