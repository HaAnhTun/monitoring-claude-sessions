import { describe, expect, it } from 'vitest';

import {
  ASYNC_HOOK_EVENTS,
  HOOK_COMMON_POLICY,
  HOOK_EVENT_POLICY,
  HOOK_EVENT_RANK,
  INSTALLED_HOOK_EVENTS,
  UNKNOWN_HOOK_EVENT_POLICY,
  UNKNOWN_HOOK_EVENT_RANK,
  hookEventRank,
  isInstalledHookEvent,
} from './hook-events.ts';

// 98 11.5: the order of the installed set
const EXPECTED_ORDER = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'PreCompact',
  'PostCompact',
  'PostModelSwitch',
  'CwdChanged',
  'SessionEnd',
];

const NEVER_INSTALLED = [
  'WorktreeCreate',
  'WorktreeRemove',
  'MessageDisplay',
  'PreModelSwitch',
  'Elicitation',
  'ElicitationResult',
  'FileChanged',
  'Setup',
  'ConfigChange',
  'InstructionsLoaded',
  'UserPromptExpansion',
  'DirectoryAdded',
];

// 98 11.5 and 02 4.3
const EXPECTED_RANK: Record<string, number> = {
  SessionStart: 0,
  UserPromptSubmit: 10,
  PreToolUse: 20,
  PermissionRequest: 22,
  PermissionDenied: 24,
  PostToolUse: 30,
  PostToolUseFailure: 30,
  PostToolBatch: 34,
  SubagentStart: 40,
  SubagentStop: 44,
  TaskCreated: 46,
  TaskCompleted: 47,
  Notification: 50,
  PreCompact: 52,
  PostCompact: 53,
  PostModelSwitch: 54,
  CwdChanged: 55,
  TeammateIdle: 56,
  Stop: 60,
  StopFailure: 60,
  SessionEnd: 90,
};

// Free-text bodies that must never be a kept field of any event (02 2.4: "dropped, never stored").
const BODY_FIELDS = [
  'prompt',
  'tool_input',
  'tool_response',
  'last_assistant_message',
  'error_details',
  'task_description',
  'custom_instructions',
  'compact_summary',
  'session_title',
  'title',
  'message',
  'permission_suggestions',
  'scratchpad_dir',
  'pricing',
  'estimated_cache_write_usd',
  'seconds_since_last_response',
  'prompt_cache_likely_expired',
];

describe('installed hook events', () => {
  it('are exactly the 21 events of 98 11.5, in that order', () => {
    expect(INSTALLED_HOOK_EVENTS).toHaveLength(21);
    expect([...INSTALLED_HOOK_EVENTS]).toEqual(EXPECTED_ORDER);
    expect(new Set(INSTALLED_HOOK_EVENTS).size).toBe(21);
  });

  it('never include an event of the never-installed list', () => {
    for (const name of NEVER_INSTALLED) {
      expect(isInstalledHookEvent(name)).toBe(false);
      expect(INSTALLED_HOOK_EVENTS.some((e) => e === name)).toBe(false);
    }
  });

  it('isInstalledHookEvent is case sensitive and rejects prototype names', () => {
    expect(isInstalledHookEvent('PreToolUse')).toBe(true);
    expect(isInstalledHookEvent('pretooluse')).toBe(false);
    expect(isInstalledHookEvent('toString')).toBe(false);
    expect(isInstalledHookEvent('__proto__')).toBe(false);
    expect(isInstalledHookEvent('')).toBe(false);
  });

  it('marks exactly the four tool events async (ADR 0013)', () => {
    expect([...ASYNC_HOOK_EVENTS].sort()).toEqual(
      ['PostToolBatch', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse'].sort(),
    );
  });
});

describe('HOOK_EVENT_POLICY', () => {
  it('has one row per installed event and no other row', () => {
    expect(Object.keys(HOOK_EVENT_POLICY).sort()).toEqual([...EXPECTED_ORDER].sort());
    for (const event of INSTALLED_HOOK_EVENTS) {
      expect(HOOK_EVENT_POLICY[event].event).toBe(event);
    }
  });

  it('mode is async exactly for ASYNC_HOOK_EVENTS and the settings timeout is 5 s (SessionEnd 2 s)', () => {
    for (const event of INSTALLED_HOOK_EVENTS) {
      const policy = HOOK_EVENT_POLICY[event];
      expect(policy.mode).toBe(ASYNC_HOOK_EVENTS.some((a) => a === event) ? 'async' : 'sync');
      expect(policy.timeoutSeconds).toBe(event === 'SessionEnd' ? 2 : 5);
    }
  });

  it('keeps no free-text body, and no kept field is also dropped', () => {
    for (const event of INSTALLED_HOOK_EVENTS) {
      const policy = HOOK_EVENT_POLICY[event];
      const kept = policy.kept.map((k) => k.name);
      for (const name of kept) {
        expect(BODY_FIELDS, `${event} keeps ${name}`).not.toContain(name);
        expect(policy.dropped, `${event} keeps and drops ${name}`).not.toContain(name);
      }
    }
  });

  it('every summarized output is a derived value, never a verbatim copy of its source', () => {
    for (const event of INSTALLED_HOOK_EVENTS) {
      for (const summary of HOOK_EVENT_POLICY[event].summarized) {
        expect(summary.into.length, `${event} ${summary.from}`).toBeGreaterThan(0);
        for (const out of summary.into) {
          expect(out, `${event} output ${out} copies its source`).not.toBe(summary.from);
        }
      }
    }
  });

  it('every kept string field has a cap, and no cap exceeds the path cap', () => {
    for (const event of INSTALLED_HOOK_EVENTS) {
      for (const field of HOOK_EVENT_POLICY[event].kept) {
        if (field.kind === 'string' || field.kind === 'path') {
          expect(field.maxChars, `${event}.${field.name}`).toBeGreaterThan(0);
          expect(field.maxChars ?? 0, `${event}.${field.name}`).toBeLessThanOrEqual(1024);
        }
      }
    }
  });

  it('dedupe keys follow 02 2.4 (N = natural key, C = content window)', () => {
    const natural: Record<string, string> = {
      PreToolUse: 'tool_use_id',
      PermissionDenied: 'tool_use_id',
      PostToolUse: 'tool_use_id',
      PostToolUseFailure: 'tool_use_id',
      PostToolBatch: 'ids_hash',
      TaskCreated: 'task_id',
      TaskCompleted: 'task_id',
    };
    for (const event of INSTALLED_HOOK_EVENTS) {
      const dedupe = HOOK_EVENT_POLICY[event].dedupe;
      const key = natural[event];
      if (key === undefined) {
        expect(dedupe, event).toEqual({ mode: 'content' });
      } else {
        expect(dedupe, event).toEqual({ mode: 'natural', key });
      }
    }
  });

  it('spot checks of the table rows', () => {
    const pre = HOOK_EVENT_POLICY.PreToolUse;
    expect(pre.kept.map((k) => k.name)).toEqual(['tool_name', 'mcp_server_name']);
    expect(pre.summarized.find((s) => s.from === 'tool_input' && s.when === undefined)?.into).toEqual([
      'tool_summary',
      'tool_input_hash',
      'tool_input_bytes',
      'tool_input_keys',
    ]);
    expect(HOOK_EVENT_POLICY.UserPromptSubmit.kept).toEqual([]);
    expect(HOOK_EVENT_POLICY.UserPromptSubmit.summarized.find((s) => s.from === 'prompt')?.into).toEqual([
      'prompt_len',
      'prompt_slash',
    ]);
    expect(HOOK_EVENT_POLICY.PostToolUseFailure.summarized.find((s) => s.from === 'error')?.into).toEqual([
      'exit_code',
      'error_len',
    ]);
    expect(HOOK_EVENT_POLICY.SessionEnd.kept).toEqual([{ name: 'reason', kind: 'string', maxChars: 32 }]);
    expect(HOOK_EVENT_POLICY.PostModelSwitch.kept.map((k) => k.name)).toEqual([
      'from_model',
      'to_model',
      'requested_model',
      'source',
      'context_tokens',
      'prompt_cache_warm',
      'cache_ttl',
    ]);
  });

  it('an unknown event keeps nothing and only reports its top-level key names', () => {
    expect(UNKNOWN_HOOK_EVENT_POLICY.kept).toEqual([]);
    expect(UNKNOWN_HOOK_EVENT_POLICY.summarized).toEqual([
      { from: '*', into: ['data_keys'], note: 'top-level key names, at most 32' },
    ]);
    expect(UNKNOWN_HOOK_EVENT_POLICY.dedupe).toEqual({ mode: 'content' });
  });

  it('common fields: effort.level goes to effort_level, scratchpad_dir is dropped', () => {
    expect(HOOK_COMMON_POLICY.summarized).toEqual([
      { from: 'effort.level', into: ['effort_level'], note: 'at most 16 chars' },
    ]);
    expect(HOOK_COMMON_POLICY.dropped).toEqual(['scratchpad_dir']);
  });
});

describe('HOOK_EVENT_RANK', () => {
  it('equals 98 11.5 for every installed event', () => {
    for (const event of INSTALLED_HOOK_EVENTS) {
      expect(HOOK_EVENT_RANK[event], event).toBe(EXPECTED_RANK[event]);
    }
  });

  it('ranks an unknown event 70, between Notification-class and Stop-class events', () => {
    expect(UNKNOWN_HOOK_EVENT_RANK).toBe(70);
    expect(HOOK_EVENT_RANK.unknown).toBe(70);
    expect(hookEventRank('SomethingNew')).toBe(70);
    expect(hookEventRank('toString')).toBe(70);
    expect(hookEventRank('__proto__')).toBe(70);
    expect(hookEventRank('SessionEnd')).toBe(90);
    expect(hookEventRank('Stop')).toBe(60);
  });

  it('PostToolUse and PostToolUseFailure share a rank, Stop and StopFailure share a rank', () => {
    expect(HOOK_EVENT_RANK.PostToolUse).toBe(HOOK_EVENT_RANK.PostToolUseFailure);
    expect(HOOK_EVENT_RANK.Stop).toBe(HOOK_EVENT_RANK.StopFailure);
  });
});
