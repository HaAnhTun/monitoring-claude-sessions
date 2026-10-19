// `backup restore` (01 5.5, 6.3): put the database of a backup back. A dry run (the backup is checked, nothing changes)
// unless `--yes`; the instance must be stopped and a verified `pre-restore` backup is made first.
// Option table and rendering only; the operation is `ops.backup.restore`.
import { opsBackup } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsBackup, 'restore'> = opsBackup): CommandDefinition {
  return {
    name: 'backup restore',
    summary: 'restore the database from a backup (dry run unless --yes; the instance must be stopped)',
    synopsis: '--task SLUG --id BACKUP_ID [--include-runtime-config] [--yes]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'task to restore' },
      id: { type: 'string', valueName: 'BACKUP_ID', required: true, description: 'the backup (see backup list)' },
      'include-runtime-config': {
        type: 'boolean',
        description: 'also restore runtime.json and the engine and hooks fields of instance.json',
      },
      yes: { type: 'boolean', description: 'apply (without it the backup is checked and nothing is changed)' },
    },
    async run(ctx) {
      const result = await ops.restore(ctx.op, {
        task: ctx.args.string('task') ?? '',
        id: ctx.args.string('id') ?? '',
        includeRuntimeConfig: ctx.args.flag('include-runtime-config'),
        yes: ctx.args.flag('yes'),
      });
      return {
        data: result,
        text: opsBackup.restoreLines(result),
        warnings: result.applied ? [] : ['dry run; pass --yes to apply'],
      };
    },
  };
}

export const command: CommandDefinition = makeCommand();
