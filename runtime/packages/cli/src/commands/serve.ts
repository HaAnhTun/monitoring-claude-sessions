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

/**
 * The kernel ends the CLI with exit code 130 on SIGINT (01 6.2). While the server runs in the foreground that would end the
 * CLI first, and on Windows the server dies with it (a child of this process is killed when the parent exits), so the
 * shutdown that Ctrl+C asks for would never finish. For the length of the server's life the operation owns the signal;
 * the kernel's listeners are put back afterwards, also after a failure.
 */
async function withSigintOwnedByServe<T>(work: () => Promise<T>): Promise<T> {
  const kernel = process.listeners('SIGINT');
  for (const listener of kernel) process.off('SIGINT', listener);
  try {
    return await work();
  } finally {
    for (const listener of kernel) process.on('SIGINT', listener);
  }
}

export function makeCommand(ops: Pick<typeof opsLifecycle, 'serveForeground'> = opsLifecycle): CommandDefinition {
  return {
    name: 'serve',
    summary: 'run the monitor of a task in the foreground (Ctrl+C stops it gracefully)',
    synopsis: '[--task SLUG] [--port N] [--log-level LEVEL] [--open] [--state-file FILE]',
    options: SERVE_OPTIONS,
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
      const result = await withSigintOwnedByServe(() => ops.serveForeground(ctx.op, input));
      return { data: result, text: result.message, warnings: result.warnings, exitCode: result.exitCode };
    },
  };
}

export const command: CommandDefinition = makeCommand();
