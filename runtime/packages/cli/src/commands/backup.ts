// `backup` / `backup create` (01 5.5, 6.3): copy the database and the reference files of a task into `data/backups/`.
// Option table and rendering only; the operation is `ops.backup.create`. A running instance copies its own database.
import { opsBackup } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsBackup, 'create'> = opsBackup): CommandDefinition {
  return {
    name: 'backup',
    aliases: ['backup create'],
    summary: 'back up the database and the reference files of a task into data/backups/ (works while it runs)',
    synopsis: '--task SLUG [--label TEXT]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'task to back up' },
      label: {
        type: 'string',
        valueName: 'TEXT',
        description: 'a note for the audit entry (the manifest has no field for it)',
      },
    },
    async run(ctx) {
      const label = ctx.args.string('label');
      const result = await ops.create(ctx.op, {
        task: ctx.args.string('task') ?? '',
        ...(label === undefined ? {} : { label }),
      });
      return { data: result, text: opsBackup.createLines(result) };
    },
  };
}

export const command: CommandDefinition = makeCommand();
