// `backup list` (01 5.5, 6.3): the backups of a task that have a valid manifest, newest first; `--verify` reads every file again.
// Option table and rendering only; the operation is `ops.backup.list`.
import { opsBackup } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsBackup, 'list'> = opsBackup): CommandDefinition {
  return {
    name: 'backup list',
    summary: 'list the backups of a task (id, reason, time, versions, size); --verify re-checks every sha256',
    synopsis: '--task SLUG [--verify]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'task whose backups to list' },
      verify: { type: 'boolean', description: 'read every file of every backup again and compare size and sha256' },
    },
    async run(ctx) {
      const result = await ops.list(ctx.op, { task: ctx.args.string('task') ?? '', verify: ctx.args.flag('verify') });
      const failed = result.backups.some((b) => b.verified === false);
      return { data: result, text: opsBackup.listLines(result), exitCode: failed ? 1 : 0 };
    },
  };
}

export const command: CommandDefinition = makeCommand();
