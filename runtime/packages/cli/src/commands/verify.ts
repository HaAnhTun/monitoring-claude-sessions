// `verify` (01 6.3, 4.10; 06 2.3): the running server answers its five endpoints with bodies that match the shared schemas. Option
// table and rendering only; the operations are `opsApp.verifyUser` and `ops.lifecycle.verify`.
import { opsApp, opsLifecycle } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(
  ops: Pick<typeof opsLifecycle, 'verify'> = opsLifecycle,
  app: Pick<typeof opsApp, 'verifyUser'> = opsApp,
): CommandDefinition {
  return {
    name: 'verify',
    summary:
      'check that the running app answers health, instance, sessions and overview with valid bodies; with --task, the monitor of a task',
    synopsis: '[--task SLUG]',
    options: {
      task: {
        type: 'string',
        valueName: 'SLUG',
        description: 'task to verify (task scope; default: the task "default" when it exists)',
      },
    },
    defaultScope: 'user',
    async run(ctx) {
      if (ctx.scope === 'user') {
        const result = await app.verifyUser(ctx.op);
        return { data: result, text: result.message, exitCode: result.exitCode };
      }
      const task = ctx.args.string('task');
      const result = await ops.verify(ctx.op, task === undefined ? {} : { task });
      return { data: result, text: result.message, exitCode: result.exitCode };
    },
  };
}

export const command: CommandDefinition = makeCommand();
