// `db rebuild` (01 5.4, 6.3): move the database of a stopped instance into a `db-rebuild` backup so that the next start
// creates a new one and imports again. Needs `--yes` and `--confirm <task>`. Option table and rendering only; the operation is
// `ops.instanceUpgrade.rebuildDb`.
import { opsInstanceUpgrade } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsInstanceUpgrade, 'rebuildDb'> = opsInstanceUpgrade): CommandDefinition {
  return {
    name: 'db rebuild',
    summary:
      'move the database aside so that the next start rebuilds it from the sources on disk (needs --yes --confirm)',
    synopsis: '--task SLUG [--yes --confirm SLUG]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'task whose database to move away' },
      yes: { type: 'boolean', description: 'apply (together with --confirm)' },
      confirm: { type: 'string', valueName: 'SLUG', description: 'the task slug again, as a typed confirmation' },
    },
    async run(ctx) {
      const confirm = ctx.args.string('confirm');
      const task = ctx.args.string('task') ?? '';
      const result = await ops.rebuildDb(ctx.op, {
        task,
        yes: ctx.args.flag('yes'),
        ...(confirm === undefined ? {} : { confirm }),
      });
      return {
        data: result,
        text: opsInstanceUpgrade.rebuildLines(result),
        warnings: result.applied || result.files.length === 0 ? [] : [`dry run; pass --yes --confirm ${task} to apply`],
      };
    },
  };
}

export const command: CommandDefinition = makeCommand();
