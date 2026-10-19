// `upgrade` (01 5.4, 6.3, ADR 0009): bring an existing instance to this runtime: backup first, then the database
// migrations, then `instance.json`. A dry run unless `--yes`. Option table and rendering only; the operation is
// `ops.instanceUpgrade.run`. A workspace from before 4.0 is converted by `migrate-workspace`, not by this command.
import { opsInstanceUpgrade } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsInstanceUpgrade, 'run'> = opsInstanceUpgrade): CommandDefinition {
  return {
    name: 'upgrade',
    summary: 'upgrade a task to this runtime: backup, database migrations, instance.json (dry run unless --yes)',
    synopsis: '--task SLUG [--dry-run] [--yes] [--restart]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'task to upgrade' },
      'dry-run': { type: 'boolean', description: 'print the plan and change nothing (the default without --yes)' },
      yes: { type: 'boolean', description: 'apply the plan' },
      restart: {
        type: 'boolean',
        description: 'stop a running server before the backup and start it again at the end',
      },
    },
    async run(ctx) {
      const result = await ops.run(ctx.op, {
        task: ctx.args.string('task') ?? '',
        yes: ctx.args.flag('yes'),
        dryRun: ctx.args.flag('dry-run'),
        restart: ctx.args.flag('restart'),
      });
      return {
        data: result,
        text: opsInstanceUpgrade.runLines(result),
        warnings: result.outcome === 'dry-run' ? ['dry run; pass --yes to apply'] : [],
        exitCode: result.exitCode,
      };
    },
  };
}

export const command: CommandDefinition = makeCommand();
