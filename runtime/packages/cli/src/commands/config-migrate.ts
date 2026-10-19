// `config migrate` (01 2.7): the explicit migration of the schema version of `config.json`, `runtime.json` and `instance.json`
// through the migration registry. A dry run unless `--yes`; the backup (reason `config-migrate`) is made before the first write.
// Option table and rendering only; the operation is `ops.config.migrate`. There is no step yet: the registry is empty in 4.0.
import { opsConfig } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsConfig, 'migrate'> = opsConfig): CommandDefinition {
  return {
    name: 'config migrate',
    summary: 'migrate config.json, runtime.json and instance.json to the newest schema version (dry run unless --yes)',
    synopsis: '--task SLUG [--dry-run] [--yes]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'task whose files to migrate' },
      'dry-run': { type: 'boolean', description: 'print the plan and change nothing (the default without --yes)' },
      yes: { type: 'boolean', description: 'back up and apply the plan' },
    },
    async run(ctx) {
      const result = await ops.migrate(
        ctx.op,
        {
          task: ctx.args.string('task') ?? '',
          yes: ctx.args.flag('yes'),
          dryRun: ctx.args.flag('dry-run'),
        },
        ctx.deps.isRunning === undefined ? {} : { isRunning: ctx.deps.isRunning },
      );
      return {
        data: result,
        text: opsConfig.migrateLines(result),
        warnings: result.outcome === 'dry-run' ? ['dry run; pass --yes to apply'] : [],
      };
    },
  };
}

export const command: CommandDefinition = makeCommand();
