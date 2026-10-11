// `decide` (01 6.3, 6.4): append a decision to the audit trail of a task. Option table and rendering only.
import { opsAudit, type DecisionInput } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export const command: CommandDefinition = {
  name: 'decide',
  summary: 'record a decision (and the alternatives rejected) in audit/decisions.md of a task',
  synopsis: '--task SLUG --title TEXT --decision TEXT [--rejected TEXT]',
  options: {
    task: { type: 'string', valueName: 'SLUG', required: true, description: 'task the decision belongs to' },
    title: { type: 'string', valueName: 'TITLE', required: true, description: 'short title of the decision' },
    decision: { type: 'string', valueName: 'TEXT', required: true, description: 'what was decided' },
    rejected: {
      type: 'string',
      valueName: 'TEXT',
      description: 'alternatives that were rejected (default: none recorded)',
    },
  },
  async run(ctx) {
    const { args } = ctx;
    const rejected = args.string('rejected');
    const input: DecisionInput = {
      task: args.string('task') ?? '',
      title: args.string('title') ?? '',
      decision: args.string('decision') ?? '',
      ...(rejected === undefined ? {} : { rejected }),
    };
    const result = await opsAudit.recordDecision(ctx.op, input);
    return { data: result, text: [result.message] };
  },
};
