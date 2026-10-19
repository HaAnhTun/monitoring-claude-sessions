// `serve` (01 6.3, 4.10): the server in the foreground of this terminal. Option table and rendering only; the operation is
// `ops.lifecycle.serveForeground`, which forwards Ctrl+C (SIGINT, SIGBREAK, SIGHUP) to the server as a graceful shutdown.
import { opsLifecycle, type ServeInput } from '@mcs/engine';

import type { CommandDefinition, OptionTable } from '../main.ts';
import { START_OPTIONS, startInputOf } from './start.ts';

/** The options of `start` that make sense for a server that is not waited for: everything but `--timeout-ms`. */
const SERVE_OPTIONS: OptionTable = {
  ...Object.fromEntries(Object.entries(START_OPTIONS).filter(([name]) => name !== 'timeout-ms')),
  'state-file': {
    type: 'string',
    valueName: 'FILE',
    description: 'legacy flag: accepted and ignored (the Node runtime always uses <workspace>/state.json)',
  },
};

export function makeCommand(ops: Pick<typeof opsLifecycle, 'serveForeground'> = opsLifecycle): CommandDefinition {
  return {
    name: 'serve',
    summary: 'run the monitor of a task in the foreground (Ctrl+C stops it gracefully)',
    synopsis: '[--task SLUG] [--port N] [--log-level LEVEL] [--open] [--state-file FILE]',
    options: SERVE_OPTIONS,
    // Ctrl+C is forwarded to the server as a graceful shutdown: on Windows a server that is a child of this process dies with it,
    // so the kernel's exit 130 would cut the shutdown short (01 6.2, CR-WP-19-4).
    interruptible: 'command',
    async run(ctx) {
      const stateFile = ctx.args.string('state-file');
      const { task, port, logLevel, open } = startInputOf(ctx.args);
      const input: ServeInput = {
        ...(task === undefined ? {} : { task }),
        ...(port === undefined ? {} : { port }),
        ...(logLevel === undefined ? {} : { logLevel }),
        ...(open === true ? { open: true } : {}),
        ...(stateFile === undefined ? {} : { stateFile }),
      };
      const result = await ops.serveForeground(ctx.op, input);
      return { data: result, text: result.message, warnings: result.warnings, exitCode: result.exitCode };
    },
  };
}

export const command: CommandDefinition = makeCommand();
