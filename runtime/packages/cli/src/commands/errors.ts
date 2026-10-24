// `errors` (01 6.3, 6.4): the recent errors of a task, newest first. A running instance adds the entries of its own error ring; a
// stopped one has only the stored ingestion errors. Option table and rendering only; the operation is `ops.data.recentErrors`.
import { opsData } from '@mcs/engine';
import type { ErrorsResult } from '@mcs/shared';

import type { CommandDefinition } from '../main.ts';
import { cell, isoShort, modeNote } from './sessions-list.ts';

/** One line per error: time, source, code, where, then the message. */
export function errorsLines(result: ErrorsResult): string[] {
  if (result.items.length === 0) return ['no errors recorded', `(${modeNote(result.mode)})`];
  const lines = result.items.map((item) => {
    const where = item.where === null ? '' : ` ${cell(item.where, 80)}`;
    const session = item.sessionId === null ? '' : ` session ${item.sessionId.slice(0, 8)}`;
    return `${isoShort(item.at)}  ${cell(item.source, 20)}  ${cell(item.code, 40)}${where}${session}  ${cell(item.message, 200)}`;
  });
  return [...lines, '', `${String(result.items.length)} errors, newest first (${modeNote(result.mode)})`];
}

export function makeCommand(ops: Pick<typeof opsData, 'recentErrors'> = opsData): CommandDefinition {
  return {
    name: 'errors',
    summary: 'show the recent errors of a task, newest first (ingestion errors; a running monitor adds its own)',
    synopsis: '--task SLUG [--since 24h|ISO-TIME] [--limit N]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the task to read' },
      since: {
        type: 'string',
        valueName: 'WHEN',
        description: 'only errors since 1h, 6h, 24h, 7d, 30d, or an ISO-8601 time (default: all the stored ones)',
      },
      limit: {
        type: 'string',
        valueName: 'N',
        integer: [1, 200],
        description: 'at most this many errors (default 50)',
      },
    },
    async run(ctx) {
      const since = ctx.args.string('since');
      const limit = ctx.args.int('limit');
      const result = await ops.recentErrors(ctx.op, {
        task: ctx.args.string('task') ?? '',
        ...(since === undefined ? {} : { since }),
        ...(limit === undefined ? {} : { limit }),
      });
      return { data: result, text: errorsLines(result) };
    },
  };
}

export const command: CommandDefinition = makeCommand();
