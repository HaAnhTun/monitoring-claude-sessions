// `wait` (ADR 0108): blocks until a session reaches a condition, so a script never polls. The command only reads (the change
// stream of the instance and two open reads); it never writes and never touches a terminal. The exit code says how the wait
// ended: 0 the condition was met, 4 the timeout passed, 5 the session is over and the condition can no longer come true, 6 there
// is no such session (1, 2 and 130 keep their meaning; 3 is never used). `completed` is decided by the completion check alone:
// a transcript that went quiet is `turn_ended`, never `completed`. Option table and rendering only; the operation is
// `ops.watch.waitFor`.
import { opsWatch } from '@mcs/engine';
import {
  CLI_NAME,
  McsError,
  WAIT_APPEAR_DEFAULT_MS,
  WAIT_HOLD_DEFAULT_MS,
  WAIT_TIMEOUT_DEFAULT_MS,
  WAIT_UNTILS,
  waitExitCode,
  parseDuration,
  type WaitResult,
} from '@mcs/shared';

import type { CommandDefinition } from '../main.ts';

/** `--hold` and `--appear` are whole seconds, at most a day. */
const MAX_SECONDS = 86_400;

/** After a timeout of `--until completed` without proof: what was missing and what to do instead. */
export const NOT_TERMINAL_HINT = `hint: no SessionEnd hook, daemon job state or attempts row was observed, so the session is not proven complete; wait for --until turn_ended, or install the hooks (${CLI_NAME} help hooks install)`;

const seconds = (ms: number): string => `${String(Math.round(ms / 1000))}s`;

/** The result as text: one line, and the hint after a timeout that the completion check could not decide. */
export function waitLines(result: WaitResult): string[] {
  const subject = result.sessionId === null ? 'session -' : `session ${result.sessionId.slice(0, 8)}`;
  const words: Record<WaitResult['outcome'], string> = {
    met: `met: ${subject} reached ${result.until}`,
    timeout: `timeout: ${subject} did not reach ${result.until}`,
    ended: `ended: ${subject} is over and can no longer reach ${result.until}`,
    missing: `missing: no such ${subject}`,
  };
  const parts = [words[result.outcome]];
  if (result.state !== null) parts.push(`state ${result.state.state} (${result.state.rule})`);
  if (result.attention !== null) {
    const reason = result.attention.reason === null ? '' : `(${result.attention.reason})`;
    parts.push(`attention ${result.attention.posture}${reason}`);
  }
  if (result.completion !== null) parts.push(`completion ${result.completion.outcome} (${result.completion.ruleId})`);
  parts.push(result.alreadyTrue ? 'already true' : `waited ${seconds(result.waitedMs)}`);
  const lines = [parts.join(', ')];
  if (result.outcome === 'timeout' && result.until === 'completed' && result.completion?.outcome === 'not_terminal') {
    lines.push(NOT_TERMINAL_HINT);
  }
  return lines;
}

export function makeCommand(ops: Pick<typeof opsWatch, 'waitFor'> = opsWatch): CommandDefinition {
  return {
    name: 'wait',
    summary: 'wait until a session reaches a condition (exit 0 met, 4 timeout, 5 ended another way, 6 no such session)',
    synopsis: `[--task SLUG] --session ID --until ${WAIT_UNTILS.join('|')} [--timeout DURATION] [--hold SECONDS] [--next] [--appear SECONDS]`,
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task to read (task scope)' },
      session: { type: 'string', valueName: 'ID', required: true, description: 'the full session id' },
      until: {
        type: 'string',
        valueName: 'CONDITION',
        required: true,
        choices: WAIT_UNTILS,
        description:
          'needs_you, turn_ended, completed (proven by the completion check, never by a quiet transcript), failed or ended',
      },
      timeout: {
        type: 'string',
        valueName: 'DURATION',
        description: 'how long to wait: 45, 45s, 30m, 2h, up to 7d (default 30m); 0 checks once and does not wait',
      },
      hold: {
        type: 'string',
        valueName: 'SECONDS',
        integer: [0, MAX_SECONDS],
        description: 'how long the condition must keep holding before it counts (default 3 for needs_you, else 0)',
      },
      next: {
        type: 'boolean',
        description:
          'the condition must become true after the wait began; a condition that already holds does not count',
      },
      appear: {
        type: 'string',
        valueName: 'SECONDS',
        integer: [0, MAX_SECONDS],
        description: 'how long the session may take to appear before the wait ends with exit code 6 (default 30)',
      },
    },
    defaultScope: 'user',
    async run(ctx) {
      const until = WAIT_UNTILS.find((value) => value === ctx.args.string('until'));
      if (until === undefined) throw new McsError('INTERNAL', 'wait was run without a condition');
      const timeoutText = ctx.args.string('timeout');
      const timeoutMs = timeoutText === undefined ? WAIT_TIMEOUT_DEFAULT_MS : parseDuration(timeoutText);
      if (timeoutMs === null) {
        throw new McsError('USAGE', `--timeout expects a duration from 0 to 7d such as 45, 45s, 30m or 2h`, {
          hint: `usage: ${CLI_NAME} wait --session ID --until ${until} --timeout 30m (${CLI_NAME} help wait)`,
          details: { reason: 'validation_failed', flag: '--timeout' },
        });
      }
      const hold = ctx.args.int('hold');
      const appear = ctx.args.int('appear');
      const result = await ops.waitFor(ctx.op, {
        task: ctx.args.string('task') ?? '',
        sessionId: ctx.args.string('session') ?? '',
        until,
        timeoutMs,
        holdMs: hold === undefined ? (until === 'needs_you' ? WAIT_HOLD_DEFAULT_MS : 0) : hold * 1000,
        next: ctx.args.flag('next'),
        appearMs: appear === undefined ? WAIT_APPEAR_DEFAULT_MS : appear * 1000,
      });
      return { data: result, text: waitLines(result), exitCode: waitExitCode(result.outcome) };
    },
  };
}

export const command: CommandDefinition = makeCommand();
