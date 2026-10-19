// `db migrate` (01 5.4, 6.3, ADR 0021): apply the pending database migrations of a stopped instance after a verified backup.
// A dry run unless `--yes`. Option table and rendering only; the operation is `ops.instanceUpgrade.migrateDb`.
import { opsInstanceUpgrade } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsInstanceUpgrade, 'migrateDb'> = opsInstanceUpgrade): CommandDefinition {
  return {
    name: 'db migrate',
    summary:
      'apply the pending database migrations after a backup (dry run unless --yes; the instance must be stopped)',
    synopsis: '--task SLUG [--dry-run] [--yes]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'task whose database to migrate' },
      'dry-run': { type: 'boolean', description: 'print the plan and change nothing (the default without --yes)' },
      yes: { type: 'boolean', description: 'apply the plan' },
    },
    async run(ctx) {
      const result = await ops.migrateDb(ctx.op, {
        task: ctx.args.string('task') ?? '',
        yes: ctx.args.flag('yes'),
        dryRun: ctx.args.flag('dry-run'),
      });
      return {
        data: result,
        text: opsInstanceUpgrade.migrateLines(result),
        warnings: result.outcome === 'dry-run' ? ['dry run; pass --yes to apply'] : [],
      };
    },
  };
}

export const command: CommandDefinition = makeCommand();
