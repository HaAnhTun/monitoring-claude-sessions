/**
 * The 21 installed hook events, their sync/async mode, ranks and the per-event field policy (02 2.4, 4.3;
 * 98 11.5; ADR 0013). Data only: the handler applies the policy, the installer reads the event list and modes.
 */

/** Order of installation (98 11.5). */
export const INSTALLED_HOOK_EVENTS = [
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
] as const;

export type InstalledHookEvent = (typeof INSTALLED_HOOK_EVENTS)[number];

/** Registered with `async: true` (ADR 0013). */
export const ASYNC_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch'] as const;

const INSTALLED_SET: ReadonlySet<string> = new Set(INSTALLED_HOOK_EVENTS);

export function isInstalledHookEvent(name: string): name is InstalledHookEvent {
  return INSTALLED_SET.has(name);
}

// ---- ranks (02 4.3, 98 11.5) -------------------------------------------------------------------------------------
export const UNKNOWN_HOOK_EVENT_RANK = 70;

export const HOOK_EVENT_RANK: Readonly<Record<InstalledHookEvent | 'unknown', number>> = {
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
  unknown: UNKNOWN_HOOK_EVENT_RANK,
};

/** Rank of any event name; a name that is not installed ranks as `unknown` (70). */
export function hookEventRank(event: string): number {
  return isInstalledHookEvent(event) ? HOOK_EVENT_RANK[event] : UNKNOWN_HOOK_EVENT_RANK;
}

// ---- field policy (02 2.4) ---------------------------------------------------------------------------------------
export type KeptFieldKind = 'string' | 'int' | 'bool' | 'path';

/** A payload field copied verbatim into `data`, capped. */
export interface KeptField {
  readonly name: string;
  readonly kind: KeptFieldKind;
  /** Chars for `string` and `path`. */
  readonly maxChars?: number;
}

/** A payload field that is stored only as derived values (length, hash, preview, count, flag). */
export interface SummarizedField {
  /** Payload field (dotted for a nested one); `*` stands for the top-level key names. */
  readonly from: string;
  /** `data` keys written from it. */
  readonly into: readonly string[];
  /** Restricts the rule to payloads of one tool, for example `tool_name = Agent`. */
  readonly when?: string;
  readonly note?: string;
}

/** `natural`: the exact key the dedupe rules use; `content`: the content-hash window (02 4.4). */
export type HookDedupe = { readonly mode: 'natural'; readonly key: string } | { readonly mode: 'content' };

interface PolicyBody {
  readonly kept: readonly KeptField[];
  readonly summarized: readonly SummarizedField[];
  /**
   * Payload fields whose raw value is never stored. A field that is also listed under `summarized` is stored only as the
   * derived values of that rule (a length, a hash, a count, a flag or a redacted preview of at most 160 code points);
   * a field that is not listed there leaves no trace at all.
   */
  readonly dropped: readonly string[];
  readonly dedupe: HookDedupe;
}

export interface HookEventPolicy extends PolicyBody {
  readonly event: InstalledHookEvent;
  readonly mode: 'sync' | 'async';
  /** `timeout` of the settings entry, seconds (02 2.1). */
  readonly timeoutSeconds: number;
}

/** Policy of a name that is not installed (02 2.4 last row). */
export type UnknownHookEventPolicy = PolicyBody;

const str = (name: string, maxChars: number): KeptField => ({ name, kind: 'string', maxChars });
const int = (name: string): KeptField => ({ name, kind: 'int' });
const bool = (name: string): KeptField => ({ name, kind: 'bool' });
const path = (name: string): KeptField => ({ name, kind: 'path', maxChars: 1024 });

const NATURAL = (key: string): HookDedupe => ({ mode: 'natural', key });
const CONTENT: HookDedupe = { mode: 'content' };

const TOOL_NAMES: readonly KeptField[] = [str('tool_name', 128), str('mcp_server_name', 128)];
const DEFAULT_TIMEOUT_S = 5;
const SESSION_END_TIMEOUT_S = 2;

function policy(event: InstalledHookEvent, mode: 'sync' | 'async', body: PolicyBody): HookEventPolicy {
  return { event, mode, timeoutSeconds: event === 'SessionEnd' ? SESSION_END_TIMEOUT_S : DEFAULT_TIMEOUT_S, ...body };
}

const TASK_POLICY: PolicyBody = {
  kept: [str('task_id', 128), str('teammate_name', 64), str('team_name', 64)],
  summarized: [
    { from: 'task_subject', into: ['subject_preview'], note: 'at most 160 code points, redacted' },
    { from: 'task_description', into: ['description_len'] },
  ],
  dropped: ['task_description'],
  dedupe: NATURAL('task_id'),
};

const STOP_SUMMARY: readonly SummarizedField[] = [
  { from: 'last_assistant_message', into: ['last_message_len'] },
  { from: 'background_tasks', into: ['background_task_count'] },
  { from: 'session_crons', into: ['cron_count'] },
];

export const HOOK_EVENT_POLICY: Readonly<Record<InstalledHookEvent, HookEventPolicy>> = {
  SessionStart: policy('SessionStart', 'sync', {
    kept: [str('source', 16), str('model', 128), int('context_tokens')],
    summarized: [{ from: 'session_title', into: ['session_title_len'] }],
    dropped: [
      'session_title',
      'seconds_since_last_response',
      'prompt_cache_likely_expired',
      'estimated_cache_write_usd',
    ],
    dedupe: CONTENT,
  }),
  UserPromptSubmit: policy('UserPromptSubmit', 'sync', {
    kept: [],
    summarized: [
      {
        from: 'prompt',
        into: ['prompt_len', 'prompt_slash'],
        note: 'length in code points; slash = the first non-space character is /',
      },
      { from: 'session_title', into: ['session_title_len'] },
    ],
    dropped: ['prompt', 'session_title'],
    dedupe: CONTENT,
  }),
  PreToolUse: policy('PreToolUse', 'async', {
    kept: TOOL_NAMES,
    summarized: [
      {
        from: 'tool_input',
        into: ['tool_summary', 'tool_input_hash', 'tool_input_bytes', 'tool_input_keys'],
        note: 'summary by summarizeToolInput, hash by canonicalJsonHash, keys = top-level names, comma-joined, at most 16',
      },
      {
        from: 'tool_input.subagent_type',
        into: ['subagent_type'],
        when: 'tool_name = Agent',
        note: 'at most 64 chars',
      },
      { from: 'tool_input.run_in_background', into: ['run_in_background'], when: 'tool_name = Agent' },
      {
        from: 'tool_input.name',
        into: ['workflow_name'],
        when: 'tool_name = Workflow',
        note: 'string, at most 128 chars',
      },
    ],
    dropped: ['tool_input'],
    dedupe: NATURAL('tool_use_id'),
  }),
  PermissionRequest: policy('PermissionRequest', 'sync', {
    kept: TOOL_NAMES,
    summarized: [
      { from: 'tool_input', into: ['tool_summary', 'tool_input_hash'] },
      { from: 'permission_suggestions', into: ['suggestion_count'] },
    ],
    dropped: ['tool_input', 'permission_suggestions'],
    dedupe: CONTENT,
  }),
  PermissionDenied: policy('PermissionDenied', 'sync', {
    kept: [str('tool_name', 128)],
    summarized: [{ from: 'reason', into: ['reason_preview'], note: 'at most 160 code points, redacted' }],
    dropped: ['tool_input'],
    dedupe: NATURAL('tool_use_id'),
  }),
  PostToolUse: policy('PostToolUse', 'async', {
    kept: [str('tool_name', 128), int('duration_ms')],
    summarized: [
      { from: 'tool_response', into: ['response_bytes'] },
      {
        from: 'tool_response.agentId',
        into: ['agent_link_id'],
        when: 'tool_name = Agent',
        note: 'must match AGENT_RE',
      },
      { from: 'tool_response.status', into: ['agent_status'], when: 'tool_name = Agent', note: 'at most 32 chars' },
      {
        from: 'tool_response.totalTokens',
        into: ['agent_total_tokens'],
        when: 'tool_name = Agent',
        note: 'informational, never summed',
      },
      { from: 'tool_response.totalDurationMs', into: ['agent_total_duration_ms'], when: 'tool_name = Agent' },
      { from: 'tool_response.totalToolUseCount', into: ['agent_tool_use_count'], when: 'tool_name = Agent' },
      { from: 'tool_response.runId', into: ['run_id'], when: 'tool_name = Workflow', note: 'must match RUN_ID_RE' },
      { from: 'tool_response.status', into: ['run_status'], when: 'tool_name = Workflow', note: 'at most 32 chars' },
      { from: 'tool_response.taskId', into: ['task_id'], when: 'tool_name = Workflow', note: 'at most 128 chars' },
      { from: 'tool_response.interrupted', into: ['interrupted'], when: 'tool_name = Bash' },
    ],
    dropped: ['tool_input', 'tool_response'],
    dedupe: NATURAL('tool_use_id'),
  }),
  PostToolUseFailure: policy('PostToolUseFailure', 'async', {
    kept: [str('tool_name', 128), bool('is_interrupt'), int('duration_ms')],
    summarized: [
      {
        from: 'error',
        into: ['exit_code', 'error_len'],
        note: 'exit_code only when the first line matches "Exit code" followed by 1 to 5 digits',
      },
    ],
    dropped: ['error', 'tool_input'],
    dedupe: NATURAL('tool_use_id'),
  }),
  PostToolBatch: policy('PostToolBatch', 'async', {
    kept: [],
    summarized: [
      {
        from: 'tool_calls',
        into: ['calls'],
        note: '[{tool_use_id, tool_name}], at most 64, flag data_truncated:calls when cut',
      },
    ],
    dropped: ['tool_input', 'tool_response'],
    dedupe: NATURAL('ids_hash'),
  }),
  Notification: policy('Notification', 'sync', {
    kept: [str('notification_type', 64)],
    summarized: [
      { from: 'title', into: ['title_preview'], note: 'at most 80 code points, redacted' },
      { from: 'message', into: ['message_preview', 'message_len'], note: 'preview at most 160 code points, redacted' },
    ],
    dropped: [],
    dedupe: CONTENT,
  }),
  SubagentStart: policy('SubagentStart', 'sync', { kept: [], summarized: [], dropped: [], dedupe: CONTENT }),
  SubagentStop: policy('SubagentStop', 'sync', {
    kept: [path('agent_transcript_path'), bool('stop_hook_active')],
    summarized: STOP_SUMMARY,
    dropped: ['last_assistant_message'],
    dedupe: CONTENT,
  }),
  TaskCreated: policy('TaskCreated', 'sync', TASK_POLICY),
  TaskCompleted: policy('TaskCompleted', 'sync', TASK_POLICY),
  Stop: policy('Stop', 'sync', {
    kept: [bool('stop_hook_active')],
    summarized: STOP_SUMMARY,
    dropped: ['last_assistant_message'],
    dedupe: CONTENT,
  }),
  StopFailure: policy('StopFailure', 'sync', {
    kept: [str('error', 64)],
    summarized: [
      { from: 'error_details', into: ['error_preview'], note: 'at most 160 code points, redacted' },
      { from: 'last_assistant_message', into: ['last_message_len'] },
    ],
    dropped: ['error_details', 'last_assistant_message'],
    dedupe: CONTENT,
  }),
  TeammateIdle: policy('TeammateIdle', 'sync', {
    kept: [str('teammate_name', 64), str('team_name', 64)],
    summarized: [],
    dropped: [],
    dedupe: CONTENT,
  }),
  PreCompact: policy('PreCompact', 'sync', {
    kept: [str('trigger', 16)],
    summarized: [{ from: 'custom_instructions', into: ['custom_instructions_len'] }],
    dropped: ['custom_instructions'],
    dedupe: CONTENT,
  }),
  PostCompact: policy('PostCompact', 'sync', {
    kept: [str('trigger', 16)],
    summarized: [{ from: 'compact_summary', into: ['compact_summary_len'] }],
    dropped: ['compact_summary'],
    dedupe: CONTENT,
  }),
  PostModelSwitch: policy('PostModelSwitch', 'sync', {
    kept: [
      str('from_model', 128),
      str('to_model', 128),
      str('requested_model', 128),
      str('source', 32),
      int('context_tokens'),
      bool('prompt_cache_warm'),
      str('cache_ttl', 16),
    ],
    summarized: [],
    dropped: ['pricing', 'estimated_cache_write_usd'],
    dedupe: CONTENT,
  }),
  CwdChanged: policy('CwdChanged', 'sync', {
    kept: [path('old_cwd'), path('new_cwd')],
    summarized: [],
    dropped: [],
    dedupe: CONTENT,
  }),
  SessionEnd: policy('SessionEnd', 'sync', {
    kept: [str('reason', 32)],
    summarized: [],
    dropped: [],
    dedupe: CONTENT,
  }),
};

/** Any other event name: only the top-level key names are kept (02 2.4 last row). */
export const UNKNOWN_HOOK_EVENT_POLICY: UnknownHookEventPolicy = {
  kept: [],
  summarized: [{ from: '*', into: ['data_keys'], note: 'top-level key names, at most 32' }],
  dropped: [],
  dedupe: CONTENT,
};

/** Fields common to every event that are not lifted to the envelope's top level (02 2.4 closing paragraph). */
export const HOOK_COMMON_POLICY: Pick<PolicyBody, 'summarized' | 'dropped'> = {
  summarized: [{ from: 'effort.level', into: ['effort_level'], note: 'at most 16 chars' }],
  dropped: ['scratchpad_dir'],
};
