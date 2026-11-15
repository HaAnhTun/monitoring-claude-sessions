// `serve` (01 6.3, 4.10; 06 2.3): the server of the app (the default) or of a task in the foreground of this terminal. Option table and
// rendering only; the operations are `opsApp.serveUser` and `ops.lifecycle.serveForeground`, which forward Ctrl+C (SIGINT, SIGBREAK,
// SIGHUP) to the server as a graceful shutdown. The app is never guarded here: a `signal` shutdown is never refused (06 3.1).
import { opsApp, opsLifecycle, type ServeInput, type UserServeInput } from '@mcs/engine';

import type { CommandDefinition, OptionTable } from '../main.ts';
import { START_OPTIONS, startInputOf } from './start.ts';

/**
 * The options of `start` that make sense for a server that is not waited for: everything but `--timeout-ms`, and nothing about a
 * login (`--window`, `--tab`, `--print`): a foreground server blocks, so it cannot show a code afterwards, and the person gets one
 * with `caw open` in another terminal. `--open` opens the dashboard of a task; the app opens nothing, so it is a task option here.
 */
const SERVE_OPTIONS: OptionTable = {
  ...Object.fromEntries(
    Object.entries(START_OPTIONS).filter(([name]) => !['timeout-ms', 'window', 'tab', 'print'].includes(name)),
  ),
  open: {
    type: 'boolean',
    scope: 'task',
    conflictsWith: ['no-open'],
    description: 'open the dashboard of the task in the browser once it is up',
  },
  'state-file': {
    type: 'string',
    valueName: 'FILE',
    description: 'legacy flag: accepted and ignored (the Node runtime always uses <workspace>/state.json)',
  },
};

const STATE_FILE_IGNORED = '--state-file is ignored: the app always uses its own state.json';

export function makeCommand(
  ops: Pick<typeof opsLifecycle, 'serveForeground'> = opsLifecycle,
  app: Pick<typeof opsApp, 'serveUser'> = opsApp,
): CommandDefinition {
  return {
    name: 'serve',
    summary: 'run the app in the foreground (Ctrl+C stops it gracefully); with --task, run the monitor of a task',
    synopsis: '[--task SLUG] [--port N] [--log-level LEVEL] [--open] [--state-file FILE]',
    options: SERVE_OPTIONS,
    defaultScope: 'user',
    // Ctrl+C is forwarded to the server as a graceful shutdown: on Windows a server that is a child of this process dies with it,
    // so the kernel's exit 130 would cut the shutdown short (01 6.2, CR-WP-19-4).
    interruptible: 'command',
    async run(ctx) {
      const stateFile = ctx.args.string('state-file');
      const { task, port, logLevel, open } = startInputOf(ctx.args);
      if (ctx.scope === 'user') {
        const input: UserServeInput = {
          ...(port === undefined ? {} : { port }),
          ...(logLevel === undefined ? {} : { logLevel }),
        };
        const result = await app.serveUser(ctx.op, input);
        const warnings = stateFile === undefined ? result.warnings : [...result.warnings, STATE_FILE_IGNORED];
        return { data: result, text: result.message, warnings, exitCode: result.exitCode };
      }
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
