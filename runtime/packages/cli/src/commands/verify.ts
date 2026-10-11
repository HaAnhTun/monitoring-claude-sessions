// `verify` (01 6.3, 4.10): the running server answers its five endpoints with bodies that match the shared schemas. Option
// table and rendering only; the operation is `ops.lifecycle.verify`.
import { opsLifecycle } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsLifecycle, 'verify'> = opsLifecycle): CommandDefinition {
  return {
    name: 'verify',
    summary:
      'check that the running monitor of a task answers health, instance, sessions and overview with valid bodies',
    synopsis: '[--task SLUG]',
    options: {
      task: {
        type: 'string',
        valueName: 'SLUG',
        description: 'task to verify (default: the task "default" when it exists)',
      },
    },
    async run(ctx) {
      const task = ctx.args.string('task');
      const result = await ops.verify(ctx.op, task === undefined ? {} : { task });
      return { data: result, text: result.message, exitCode: result.exitCode };
    },
  };
}

export const command: CommandDefinition = makeCommand();
