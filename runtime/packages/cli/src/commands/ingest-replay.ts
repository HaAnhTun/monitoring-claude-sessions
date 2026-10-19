// `ingest replay` (01 6.3, 6.4, I-29; behaviour owned by 02 2.7): read the spool segments of a task again. A dry run unless
// `--yes`. Option table and rendering only; the operation is `ops.ingest.replay`.
import { opsIngest } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsIngest, 'replay'> = opsIngest): CommandDefinition {
  return {
    name: 'ingest replay',
    summary: 'read the spool segments of a task again (dry run unless --yes; duplicates are ignored by event_uid)',
    synopsis: '--task SLUG [--from SEGMENT] [--yes]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task whose spool is read again' },
      from: {
        type: 'string',
        valueName: 'SEGMENT',
        description:
          'the first segment to read again, like hooks-20261011T08Z.ndjson (default: every retained segment)',
      },
      yes: { type: 'boolean', description: 'reset the cursors of the selected segments' },
    },
    async run(ctx) {
      const from = ctx.args.string('from');
      const result = await ops.replay(ctx.op, {
        task: ctx.args.string('task') ?? '',
        yes: ctx.args.flag('yes'),
        ...(from === undefined ? {} : { from }),
      });
      return {
        data: result,
        text: opsIngest.replayLines(result),
        warnings: result.mode === 'dry-run' && result.segments.length > 0 ? ['dry run; pass --yes to apply'] : [],
      };
    },
  };
}

export const command: CommandDefinition = makeCommand();
