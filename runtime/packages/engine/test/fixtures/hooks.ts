// Hook envelope fixtures (02 9.1): one builder per installed event with the keys the handler keeps (02 2.4), plus a
// name that is not installed and a probe. These are ENVELOPES (what the spool holds), built directly; the real handler
// produces the same shapes and is tested elsewhere (T-HK-*). Placeholder values only.
import { INSTALLED_HOOK_EVENTS, type EnvelopeDataValue, type HookEnvelopeV1 } from '@mcs/shared/protocol';

export const FIXTURE_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_SESSION_ID = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_AGENT_ID = 'a1b2c3d4e5f6a7b8c';
export const FIXTURE_TOOL_USE_ID = 'toolu_fixture_hook_001';
export const FIXTURE_PROMPT_ID = '33333333-3333-4333-8333-333333333333';
export const FIXTURE_RECEIVED_AT = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
export const FIXTURE_HASH = '0123456789abcdef0123456789abcdef';

type Data = Record<string, EnvelopeDataValue>;

interface EventTemplate {
  /** Top-level fields beyond the common ones. */
  readonly top: Partial<HookEnvelopeV1>;
  readonly data: Data;
}

const CALLS = [
  { tool_use_id: 'toolu_fixture_hook_002', tool_name: 'Bash' },
  { tool_use_id: 'toolu_fixture_hook_001', tool_name: 'Read' },
];

/** The documented keys of each installed event (02 2.4), with the ids the event needs at the top level. */
const TEMPLATES: Readonly<Record<string, EventTemplate>> = {
  SessionStart: { top: {}, data: { source: 'startup', model: 'claude-sonnet-5-5', context_tokens: 1000 } },
  UserPromptSubmit: {
    top: { prompt_id: FIXTURE_PROMPT_ID },
    data: { prompt_len: 14, prompt_slash: false },
  },
  PreToolUse: {
    top: { tool_use_id: FIXTURE_TOOL_USE_ID, prompt_id: FIXTURE_PROMPT_ID },
    data: {
      tool_name: 'Bash',
      tool_summary: 'echo FIXTURE',
      tool_input_hash: FIXTURE_HASH,
      tool_input_bytes: 30,
      tool_input_keys: 'command,description',
    },
  },
  PermissionRequest: {
    top: { prompt_id: FIXTURE_PROMPT_ID },
    data: { tool_name: 'Bash', tool_summary: 'echo FIXTURE', tool_input_hash: FIXTURE_HASH, suggestion_count: 0 },
  },
  PermissionDenied: {
    top: { tool_use_id: FIXTURE_TOOL_USE_ID },
    data: { tool_name: 'Bash', reason_preview: 'FIXTURE denied' },
  },
  PostToolUse: {
    top: { tool_use_id: FIXTURE_TOOL_USE_ID },
    data: { tool_name: 'Bash', duration_ms: 12, response_bytes: 20, interrupted: false },
  },
  PostToolUseFailure: {
    top: { tool_use_id: FIXTURE_TOOL_USE_ID },
    data: { tool_name: 'Bash', is_interrupt: false, duration_ms: 15, exit_code: 1, error_len: 18 },
  },
  PostToolBatch: { top: { prompt_id: FIXTURE_PROMPT_ID }, data: { calls: CALLS } },
  Notification: {
    top: {},
    data: {
      notification_type: 'idle_prompt',
      title_preview: 'FIXTURE title',
      message_preview: 'FIXTURE message',
      message_len: 15,
    },
  },
  SubagentStart: { top: { agent_id: FIXTURE_AGENT_ID, agent_type: 'general-purpose' }, data: {} },
  SubagentStop: {
    top: { agent_id: FIXTURE_AGENT_ID, agent_type: 'general-purpose' },
    data: {
      agent_transcript_path: 'FIXTURE/projects/agent-a1b2c3d4e5f6a7b8c.jsonl',
      stop_hook_active: false,
      last_message_len: 10,
      background_task_count: 0,
      cron_count: 0,
    },
  },
  TaskCreated: {
    top: {},
    data: {
      task_id: 'task_fixture_1',
      teammate_name: 'FIXTURE-mate',
      subject_preview: 'FIXTURE subject',
      description_len: 4,
    },
  },
  TaskCompleted: {
    top: {},
    data: {
      task_id: 'task_fixture_1',
      teammate_name: 'FIXTURE-mate',
      subject_preview: 'FIXTURE subject',
      description_len: 4,
    },
  },
  Stop: {
    top: { prompt_id: FIXTURE_PROMPT_ID },
    data: { stop_hook_active: false, last_message_len: 20, background_task_count: 2, cron_count: 0 },
  },
  StopFailure: {
    top: { prompt_id: FIXTURE_PROMPT_ID },
    data: { error: 'rate_limit', error_preview: 'FIXTURE error', last_message_len: 0 },
  },
  TeammateIdle: { top: {}, data: { teammate_name: 'FIXTURE-mate', team_name: 'FIXTURE-team' } },
  PreCompact: { top: {}, data: { trigger: 'manual', custom_instructions_len: 10 } },
  PostCompact: { top: {}, data: { trigger: 'auto', compact_summary_len: 400 } },
  PostModelSwitch: {
    top: {},
    data: {
      from_model: 'claude-sonnet-5-5',
      to_model: 'claude-opus-5',
      requested_model: 'opus',
      source: 'user',
      context_tokens: 1000,
      prompt_cache_warm: true,
      cache_ttl: '5m',
    },
  },
  CwdChanged: { top: {}, data: { old_cwd: 'FIXTURE/project', new_cwd: 'FIXTURE/project/sub' } },
  SessionEnd: { top: {}, data: { reason: 'other' } },
};

export interface EnvelopeOptions {
  /** Fields merged over the event's `data`. */
  data?: Data;
  /** Top-level fields merged over the common ones. */
  top?: Partial<HookEnvelopeV1>;
  /** Makes `event_uid` unique per delivery (default: derived from the event name). */
  eventUid?: string;
  receivedAt?: number;
}

function uidOf(event: string): string {
  let sum = 0;
  for (const ch of event) sum = (sum * 31 + ch.charCodeAt(0)) % 0xffffff;
  return `44444444-4444-4444-8444-${sum.toString(16).padStart(12, '0')}`;
}

/** One envelope of `event` for `FIXTURE_SESSION_ID`; a name outside the installed set gets the unknown-event shape. */
export function fixtureEnvelope(event: string, opts: EnvelopeOptions = {}): HookEnvelopeV1 {
  const template = TEMPLATES[event];
  const data: Data = template === undefined ? { data_keys: 'alpha,beta' } : { ...template.data };
  return {
    v: 1,
    kind: 'hook',
    instance_id: FIXTURE_INSTANCE_ID,
    event_uid: opts.eventUid ?? uidOf(event),
    received_at: opts.receivedAt ?? FIXTURE_RECEIVED_AT,
    event,
    argv_event: event,
    session_id: FIXTURE_SESSION_ID,
    transcript_path: 'FIXTURE/projects/FIXTURE-session.jsonl',
    cwd: 'FIXTURE/project',
    prompt_id: null,
    agent_id: null,
    agent_type: null,
    tool_use_id: null,
    permission_mode: 'default',
    claude_pid: 4242,
    payload_bytes: 120,
    content_hash: FIXTURE_HASH,
    handler: { version: '3.0.0', pid: 100, async: false },
    flags: [],
    ...(template?.top ?? {}),
    ...(opts.top ?? {}),
    data: { ...data, ...(opts.data ?? {}) },
  };
}

/** The probe envelope of `hooks verify` (02 3.7): a Notification of type `mcs_probe` in a probe session. */
export function fixtureProbeEnvelope(): HookEnvelopeV1 {
  return fixtureEnvelope('Notification', {
    top: { kind: 'probe', session_id: '00000000-0000-4000-8000-000000000001' },
    data: { notification_type: 'mcs_probe' },
  });
}

/** One envelope for each of the 21 installed events, in installation order. */
export function allInstalledEnvelopes(): HookEnvelopeV1[] {
  return INSTALLED_HOOK_EVENTS.map((event) => fixtureEnvelope(event));
}
