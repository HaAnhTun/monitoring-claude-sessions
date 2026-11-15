// `stop` (01 6.3, 4.9; 06 2.3, 3): stop the server of the app (the default) or of a task, gracefully first; a process is killed only
// after its command line proves that it is the runtime of this instance. Option table and rendering only; the operations are
// `opsApp.stopUser` (the guarded stop: live terminals refuse with `TERMINALS_LIVE`, exit 3, unless `--force`) and
// `ops.lifecycle.stop` for a task.
import { opsApp, opsLifecycle, type StopInput, type UserStopInput } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(
  ops: Pick<typeof opsLifecycle, 'stop'> = opsLifecycle,
  app: Pick<typeof opsApp, 'stopUser'> = opsApp,
): CommandDefinition {
  return {
    name: 'stop',
    summary:
      'stop the app (graceful; it refuses while terminals are live unless --force); with --task, stop the monitor of a task',
    synopsis: '[--task SLUG] [--timeout-ms MS] [--force]',
    options: {
      task: {
        type: 'string',
        valueName: 'SLUG',
        description: 'task to stop (task scope; default: the task "default" when it exists)',
      },
      'timeout-ms': {
        type: 'string',
        valueName: 'MS',
        integer: [1000, 300_000],
        description: 'how long to wait for the server to exit (default: process.stopTimeoutMs)',
      },
      force: {
        type: 'boolean',
        scope: 'user',
        description: 'end the live terminal sessions instead of refusing with exit 3',
      },
    },
    defaultScope: 'user',
    async run(ctx) {
      const timeoutMs = ctx.args.int('timeout-ms');
      if (ctx.scope === 'user') {
        const input: UserStopInput = {
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(ctx.args.flag('force') ? { force: true } : {}),
        };
        const result = await app.stopUser(ctx.op, input);
        return { data: result, text: result.message, exitCode: result.exitCode };
      }
      const task = ctx.args.string('task');
      const input: StopInput = {
        ...(task === undefined ? {} : { task }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
      const result = await ops.stop(ctx.op, input);
      return { data: result, text: result.message, exitCode: result.exitCode };
    },
  };
}

export const command: CommandDefinition = makeCommand();
