// `check` (01 6.3, 6.4): resolve and validate the configuration of a task and print the one-line summary. Option table and
// rendering only.
import { opsConfig } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export const command: CommandDefinition = {
  name: 'check',
  summary: 'validate the configuration (every file, every regex) and print a one-line summary',
  synopsis: '[--task SLUG]',
  options: {
    task: {
      type: 'string',
      valueName: 'SLUG',
      description: 'task to check (default: the task "default" when it exists, else the shared defaults)',
    },
  },
  async run(ctx) {
    const task = ctx.args.string('task');
    const result = await opsConfig.check(ctx.op, task === undefined ? {} : { task }, ctx.deps);
    return { data: result, text: [result.line] };
  },
};
