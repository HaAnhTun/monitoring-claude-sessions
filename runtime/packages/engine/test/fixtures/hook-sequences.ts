// Hook sequences for the writer and the hook-to-database tests (02 9.1): the 21 installed events of ONE session in the order a
// real session produces them, with unique envelope uids, strictly increasing `received_at` and the ids that tie the events
// together (prompt, tool calls, agent). Envelopes only (what the spool holds); placeholder values.
import type { HookEnvelopeV1 } from '@mcs/shared/protocol';

import { Prng } from '../support/prng.ts';
import { FIXTURE_INSTANCE_ID, FIXTURE_SESSION_ID, fixtureEnvelope } from './hooks.ts';

export { FIXTURE_INSTANCE_ID, FIXTURE_SESSION_ID };

/** A started-at moment that is safely in the past of the clock the tests use. */
export const SEQUENCE_START = Date.UTC(2026, 0, 2, 3, 0, 0, 0);

export const PROMPT_ID = '33333333-3333-4333-8333-333333333333';
export const TOOL_BASH = 'toolu_seq_bash_001';
export const TOOL_AGENT = 'toolu_seq_agent_002';
export const TOOL_READ = 'toolu_seq_read_003';
export const TOOL_DENIED = 'toolu_seq_denied_004';
export const TOOL_FAILED = 'toolu_seq_failed_005';
export const SUBAGENT_ID = 'a1b2c3d4e5f6a7b8c';

/** `00000000-0000-4000-8000-<12 hex digits of n>`: a valid, unique envelope uid per step. */
export function uidOf(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** A content hash that differs per step, so that the D-3 window never sees two steps as one. */
export function hashOf(n: number): string {
  return n.toString(16).padStart(32, '0');
}

interface Step {
  readonly event: string;
  readonly top?: Partial<HookEnvelopeV1>;
  readonly data?: Record<string, string | number | boolean | null | Record<string, string | null>[]>;
}

const STEPS: readonly Step[] = [
  { event: 'SessionStart', data: { source: 'startup', model: 'claude-sonnet-5-5' } },
  { event: 'UserPromptSubmit', top: { prompt_id: PROMPT_ID }, data: { prompt_len: 21 } },
  {
    event: 'PreToolUse',
    top: { tool_use_id: TOOL_BASH, prompt_id: PROMPT_ID },
    data: { tool_name: 'Bash', tool_summary: 'echo FIXTURE', tool_input_hash: 'a'.repeat(32) },
  },
  {
    event: 'PermissionRequest',
    top: { prompt_id: PROMPT_ID },
    data: { tool_name: 'Bash', tool_summary: 'echo FIXTURE', tool_input_hash: 'a'.repeat(32) },
  },
  {
    event: 'PostToolUse',
    top: { tool_use_id: TOOL_BASH },
    data: { tool_name: 'Bash', duration_ms: 12, interrupted: false },
  },
  {
    event: 'PreToolUse',
    top: { tool_use_id: TOOL_AGENT, prompt_id: PROMPT_ID },
    data: { tool_name: 'Agent', tool_summary: 'run a helper', tool_input_hash: 'b'.repeat(32) },
  },
  { event: 'SubagentStart', top: { agent_id: SUBAGENT_ID, agent_type: 'general-purpose' } },
  {
    event: 'PreToolUse',
    top: { tool_use_id: TOOL_READ, prompt_id: PROMPT_ID, agent_id: SUBAGENT_ID },
    data: { tool_name: 'Read', tool_summary: 'read FIXTURE', tool_input_hash: 'c'.repeat(32) },
  },
  {
    event: 'PostToolUse',
    top: { tool_use_id: TOOL_READ, agent_id: SUBAGENT_ID },
    data: { tool_name: 'Read', duration_ms: 5 },
  },
  {
    event: 'SubagentStop',
    top: { agent_id: SUBAGENT_ID, agent_type: 'general-purpose' },
    data: { last_message_len: 10 },
  },
  {
    event: 'PostToolUse',
    top: { tool_use_id: TOOL_AGENT },
    data: { tool_name: 'Agent', duration_ms: 400, agent_link_id: SUBAGENT_ID, agent_status: 'completed' },
  },
  {
    event: 'PostToolBatch',
    top: { prompt_id: PROMPT_ID },
    data: {
      calls: [
        { tool_use_id: TOOL_BASH, tool_name: 'Bash' },
        { tool_use_id: TOOL_AGENT, tool_name: 'Agent' },
      ],
    },
  },
  { event: 'Notification', data: { notification_type: 'idle_prompt', message_preview: 'FIXTURE message' } },
  { event: 'TaskCreated', data: { task_id: 'task_seq_1', subject_preview: 'FIXTURE subject' } },
  { event: 'TaskCompleted', data: { task_id: 'task_seq_1', subject_preview: 'FIXTURE subject' } },
  { event: 'PreCompact', data: { trigger: 'manual' } },
  { event: 'PostCompact', data: { trigger: 'manual' } },
  { event: 'PostModelSwitch', data: { from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5' } },
  { event: 'CwdChanged', data: { old_cwd: 'FIXTURE/project', new_cwd: 'FIXTURE/project/sub' } },
  { event: 'TeammateIdle', data: { teammate_name: 'FIXTURE-mate' } },
  {
    event: 'PreToolUse',
    top: { tool_use_id: TOOL_DENIED, prompt_id: PROMPT_ID },
    data: { tool_name: 'Bash', tool_summary: 'rm FIXTURE', tool_input_hash: 'd'.repeat(32) },
  },
  {
    event: 'PermissionDenied',
    top: { tool_use_id: TOOL_DENIED },
    data: { tool_name: 'Bash', reason_preview: 'denied' },
  },
  {
    event: 'PreToolUse',
    top: { tool_use_id: TOOL_FAILED, prompt_id: PROMPT_ID },
    data: { tool_name: 'Bash', tool_summary: 'false', tool_input_hash: 'e'.repeat(32) },
  },
  {
    event: 'PostToolUseFailure',
    top: { tool_use_id: TOOL_FAILED },
    data: { tool_name: 'Bash', is_interrupt: false, duration_ms: 3, exit_code: 1 },
  },
  {
    event: 'Stop',
    top: { prompt_id: PROMPT_ID },
    data: { stop_hook_active: false, last_message_len: 20, background_task_count: 0 },
  },
  {
    event: 'StopFailure',
    top: { prompt_id: PROMPT_ID },
    data: { error: 'rate_limit', error_preview: 'FIXTURE error' },
  },
  { event: 'SessionEnd', data: { reason: 'other' } },
];

export interface SequenceOptions {
  readonly startAt?: number;
  /** Milliseconds between two steps (default 1000: far outside the D-3 window). */
  readonly stepMs?: number;
  readonly sessionId?: string;
  readonly instanceId?: string;
  /** First envelope number (the uid and the hash are derived from it). */
  readonly firstNumber?: number;
}

/** The lab sequence: every one of the 21 installed events at least once, in a realistic order. */
export function labSequence(opts: SequenceOptions = {}): HookEnvelopeV1[] {
  const start = opts.startAt ?? SEQUENCE_START;
  const stepMs = opts.stepMs ?? 1000;
  const first = opts.firstNumber ?? 1;
  return STEPS.map((step, index) =>
    fixtureEnvelope(step.event, {
      eventUid: uidOf(first + index),
      receivedAt: start + index * stepMs,
      top: {
        content_hash: hashOf(first + index),
        session_id: opts.sessionId ?? FIXTURE_SESSION_ID,
        instance_id: opts.instanceId ?? FIXTURE_INSTANCE_ID,
        ...(step.top ?? {}),
      },
      data: step.data ?? {},
    }),
  );
}

/** A seeded Fisher-Yates shuffle (the order of arrival is the only thing that changes). */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const prng = new Prng(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = prng.int(i + 1);
    const a = copy[i];
    const b = copy[j];
    if (a === undefined || b === undefined) continue;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}
