// Hook payloads as Claude Code sends them on stdin, and the runner that feeds them to the real handler (05 4.4).
// Payload shapes: docs/research/claude-code-hooks.md sections 2 and 11. The event list and the async set are 02's
// (`@mcs/shared/protocol`); the testkit never lists the events itself.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ASYNC_HOOK_EVENTS, type INSTALLED_HOOK_EVENTS } from '@mcs/shared/protocol';

import { baseEnv, runProcess, runtimeRoot, skillRoot } from './processes.ts';

/** The 21 installed events (02 2.4). */
export type HookEventName = (typeof INSTALLED_HOOK_EVENTS)[number];

export interface HookBase {
  sessionId: string;
  cwd: string;
  transcriptPath: string;
}

const AGENT_ID = 'a1b2c3d4e5f6a7b8c';
const TOOL_USE_ID = 'toolu_fixture_hook_001';
const BASH_INPUT = { command: 'echo FIXTURE', description: 'FIXTURE description' };

function eventFields(event: HookEventName, base: HookBase): Record<string, unknown> {
  switch (event) {
    case 'SessionStart':
      return { source: 'startup' };
    case 'UserPromptSubmit':
      return { prompt: 'FIXTURE prompt' };
    case 'PreToolUse':
      return { tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: TOOL_USE_ID };
    case 'PermissionRequest':
      return { tool_name: 'Bash', tool_input: BASH_INPUT, permission_suggestions: [] };
    case 'PermissionDenied':
      return { tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: TOOL_USE_ID, reason: 'FIXTURE denied' };
    case 'PostToolUse':
      return {
        tool_name: 'Bash',
        tool_input: BASH_INPUT,
        tool_response: {
          stdout: 'FIXTURE output',
          stderr: '',
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
        tool_use_id: TOOL_USE_ID,
      };
    case 'PostToolUseFailure':
      return {
        tool_name: 'Bash',
        tool_input: BASH_INPUT,
        tool_use_id: TOOL_USE_ID,
        error: 'Exit code 1\nFIXTURE failure',
        is_interrupt: false,
      };
    case 'PostToolBatch':
      return {
        tool_calls: [
          { tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: TOOL_USE_ID, tool_response: 'FIXTURE output' },
        ],
      };
    case 'Notification':
      return { notification_type: 'permission_prompt', title: 'FIXTURE title', message: 'FIXTURE message' };
    case 'SubagentStart':
      return { agent_id: AGENT_ID, agent_type: 'general-purpose' };
    case 'SubagentStop':
      return {
        stop_hook_active: false,
        agent_id: AGENT_ID,
        agent_type: 'general-purpose',
        agent_transcript_path: `${base.transcriptPath.replace(/\.jsonl$/, '')}/subagents/agent-${AGENT_ID}.jsonl`,
        last_assistant_message: 'FIXTURE last message',
        background_tasks: [],
        session_crons: [],
      };
    case 'TaskCreated':
    case 'TaskCompleted':
      return {
        task_id: 'task_fixture_1',
        task_subject: 'FIXTURE task subject',
        task_description: 'FIXTURE task description',
        teammate_name: 'FIXTURE-mate',
        team_name: 'FIXTURE-team',
      };
    case 'Stop':
      return {
        stop_hook_active: false,
        last_assistant_message: 'FIXTURE last message',
        background_tasks: [],
        session_crons: [],
      };
    case 'StopFailure':
      return {
        error: 'rate_limit',
        error_details: 'FIXTURE error details',
        last_assistant_message: 'FIXTURE last message',
      };
    case 'TeammateIdle':
      return { teammate_name: 'FIXTURE-mate', team_name: 'FIXTURE-team' };
    case 'PreCompact':
      return { trigger: 'manual', custom_instructions: 'FIXTURE instructions' };
    case 'PostCompact':
      return { trigger: 'auto', compact_summary: 'FIXTURE compaction summary' };
    case 'PostModelSwitch':
      return {
        from_model: 'claude-sonnet-5-5',
        to_model: 'claude-opus-5',
        requested_model: 'opus',
        source: 'user',
        context_tokens: 1000,
        prompt_cache_warm: true,
        cache_ttl: '5m',
      };
    case 'CwdChanged':
      return { old_cwd: base.cwd, new_cwd: `${base.cwd}/FIXTURE-sub` };
    case 'SessionEnd':
      return { reason: 'other' };
  }
}

/**
 * The raw stdin payload of one event: the common fields, the documented keys of the event with synthetic values, then
 * `extra` over them. `hook_event_name` is always `event`.
 */
export function hookPayload(
  event: HookEventName,
  base: HookBase,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    session_id: base.sessionId,
    transcript_path: base.transcriptPath,
    cwd: base.cwd,
    hook_event_name: event,
    ...eventFields(event, base),
    ...extra,
  };
  payload['hook_event_name'] = event;
  return payload;
}

export interface RunHookOptions {
  /** Temp per-user state folder; the handler reads routes from `<mcsHome>/routes`. */
  mcsHome: string;
  /** Argv event; default `payload.hook_event_name` (required when `rawStdin` is used). */
  event?: HookEventName;
  /** Append `--async`; default: the event is in `ASYNC_HOOK_EVENTS`. */
  async?: boolean;
  /** Spawn `runtime/packages/cli/dist/hook.js` directly (the handler unit of 02) instead of the installed stub. */
  direct?: boolean;
  /** Merged over a minimal environment; `MCS_HOOK_DISABLE` is not set unless it is given here. */
  env?: Record<string, string>;
  /** Sent instead of `JSON.stringify(payload)` (malformed-input cases). */
  rawStdin?: string;
}

/** Program and arguments that run the handler for `event` (02 2.1): the installed command, or the built handler with `direct`. */
export function hookCommand(
  event: string,
  opts: { async?: boolean; direct?: boolean },
): { file: string; args: string[] } {
  const entry =
    opts.direct === true
      ? join(runtimeRoot(), 'packages', 'cli', 'dist', 'hook.js')
      : join(skillRoot(), 'scripts', 'mcs-hook.mjs');
  const isAsync = opts.async ?? ASYNC_HOOK_EVENTS.some((name) => name === event);
  return {
    file: process.execPath,
    args: ['--no-warnings', entry, '--mcs-hook', event, ...(isAsync ? ['--async'] : [])],
  };
}

/** Throws a clear error when the handler file is not there (the runtime was not built, or the stub is not installed yet). */
export function assertHandlerEntry(entry: string): void {
  if (!existsSync(entry))
    throw new Error(`runHookHandler: ${entry} is missing; build the runtime first (npm run build)`);
}

function eventOf(payload: unknown): string | undefined {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'hook_event_name' in payload &&
    typeof payload.hook_event_name === 'string'
  ) {
    return payload.hook_event_name;
  }
  return undefined;
}

/**
 * Runs the real handler with the payload on stdin, as Claude Code does. The default spawns the installed command of 02 2.1
 * (`<skill>/scripts/mcs-hook.mjs --mcs-hook <event>`), `direct` spawns `dist/hook.js`. Both need a built runtime.
 */
export async function runHookHandler(
  payload: unknown,
  opts: RunHookOptions,
): Promise<{ code: number; stdout: string; stderr: string; durationMs: number }> {
  const event = opts.event ?? eventOf(payload);
  if (event === undefined) throw new Error('runHookHandler: event is required when the payload has no hook_event_name');
  const command = hookCommand(event, {
    ...(opts.async === undefined ? {} : { async: opts.async }),
    ...(opts.direct === undefined ? {} : { direct: opts.direct }),
  });
  const entry = command.args[1];
  if (entry !== undefined) assertHandlerEntry(entry);
  mkdirSync(opts.mcsHome, { recursive: true });
  const env: Record<string, string> = {
    ...baseEnv(),
    MCS_HOME: opts.mcsHome,
    CLAUDE_CONFIG_DIR: join(opts.mcsHome, 'claude-home'),
    HOME: join(opts.mcsHome, 'home'),
    USERPROFILE: join(opts.mcsHome, 'home'),
    ...opts.env,
  };
  return runProcess(command.file, command.args, {
    cwd: opts.mcsHome,
    env,
    stdin: opts.rawStdin ?? JSON.stringify(payload),
    timeoutMs: 20_000,
  });
}
