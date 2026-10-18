// `status` (01 6.3, 4.10): the legacy JSON of the monitor with the new keys; exit 0 iff it runs. Option table and rendering
// only; the operation is `ops.lifecycle.status`.
import { opsLifecycle } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsLifecycle, 'status'> = opsLifecycle): CommandDefinition {
  return {
    name: 'status',
    summary: 'show whether the monitor of a task runs: url, pid, uptime, sessions by state, recent errors (JSON)',
    synopsis: '[--task SLUG]',
    options: {
      task: {
        type: 'string',
        valueName: 'SLUG',
        description: 'task to look at (default: the task "default" when it exists)',
      },
    },
    async run(ctx) {
      const task = ctx.args.string('task');
      const result = await ops.status(ctx.op, task === undefined ? {} : { task });
      return { data: result.report, legacy: result.report, exitCode: result.exitCode };
    },
  };
}

export const command: CommandDefinition = makeCommand();
