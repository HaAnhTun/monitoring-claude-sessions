// `stop` (01 6.3, 4.9): stop the server of a task, gracefully first; a process is killed only after its command line proves
// that it is the runtime of this instance. Option table and rendering only; the operation is `ops.lifecycle.stop`.
import { opsLifecycle, type StopInput } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsLifecycle, 'stop'> = opsLifecycle): CommandDefinition {
  return {
    name: 'stop',
    summary: 'stop the monitor of a task (graceful; a process is killed only after its identity is verified)',
    synopsis: '[--task SLUG] [--timeout-ms MS]',
    options: {
      task: {
        type: 'string',
        valueName: 'SLUG',
        description: 'task to stop (default: the task "default" when it exists)',
      },
      'timeout-ms': {
        type: 'string',
        valueName: 'MS',
        integer: [1000, 300_000],
        description: 'how long to wait for the server to exit (default: process.stopTimeoutMs)',
      },
    },
    async run(ctx) {
      const task = ctx.args.string('task');
      const timeoutMs = ctx.args.int('timeout-ms');
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
