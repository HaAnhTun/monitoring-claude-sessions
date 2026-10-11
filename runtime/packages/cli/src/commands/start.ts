// `start` (01 6.3, 4.7): start the detached server of a task (or report the one that runs). Option table and rendering only;
// the operation is `ops.lifecycle.start`. `restart` takes the same options, so the table and the input mapping live here.
import { opsLifecycle, type LogLevel, type StartInput } from '@mcs/engine';

import type { CommandDefinition, OptionTable, ParsedArgs } from '../main.ts';

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

export const START_OPTIONS: OptionTable = {
  task: {
    type: 'string',
    valueName: 'SLUG',
    description: 'task to start (default: the task "default", created on demand)',
  },
  port: {
    type: 'string',
    valueName: 'N',
    integer: [1, 65535],
    description: 'first port to try (default: the port of the configuration); the next free one is used',
  },
  'log-level': {
    type: 'string',
    valueName: 'LEVEL',
    choices: LOG_LEVELS,
    description: 'log level of the server (default: the configuration)',
  },
  open: { type: 'boolean', description: 'open the dashboard in the browser once the server is up' },
  'timeout-ms': {
    type: 'string',
    valueName: 'MS',
    integer: [1000, 300_000],
    description: 'how long to wait for a healthy server (default: process.startTimeoutMs)',
  },
};

function logLevelOf(text: string | undefined): LogLevel | undefined {
  return LOG_LEVELS.find((level) => level === text);
}

/** The options as typed, without the ones that were not given (exactOptionalPropertyTypes). */
export function startInputOf(args: ParsedArgs): StartInput {
  const task = args.string('task');
  const port = args.int('port');
  const logLevel = logLevelOf(args.string('log-level'));
  const timeoutMs = args.int('timeout-ms');
  return {
    ...(task === undefined ? {} : { task }),
    ...(port === undefined ? {} : { port }),
    ...(logLevel === undefined ? {} : { logLevel }),
    ...(args.flag('open') ? { open: true } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

export function makeCommand(ops: Pick<typeof opsLifecycle, 'start'> = opsLifecycle): CommandDefinition {
  return {
    name: 'start',
    summary: 'start the monitor of a task in the background (or report the one that already runs)',
    synopsis: '[--task SLUG] [--port N] [--log-level LEVEL] [--open] [--timeout-ms MS]',
    options: START_OPTIONS,
    async run(ctx) {
      const result = await ops.start(ctx.op, startInputOf(ctx.args));
      return { data: result, text: result.message, warnings: result.warnings, exitCode: result.exitCode };
    },
  };
}

export const command: CommandDefinition = makeCommand();
