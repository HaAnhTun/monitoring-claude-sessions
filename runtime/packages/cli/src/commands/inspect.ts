// `inspect` (01 6.3, 6.4): the effective configuration of a task, or the list of tasks. Option table and rendering only.
import { opsConfig } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export const command: CommandDefinition = {
  name: 'inspect',
  summary:
    'show the effective configuration, provenance, recent audit and runtime state of a task (without --task: list tasks)',
  synopsis: '[--task SLUG]',
  options: {
    task: { type: 'string', valueName: 'SLUG', description: 'task to inspect (default: list the tasks)' },
  },
  async run(ctx) {
    const task = ctx.args.string('task');
    if (task === undefined) {
      const list = await opsConfig.inspect(ctx.op, {}, ctx.deps);
      return { data: list, text: [list.line] };
    }
    const { report, inspection } = await opsConfig.inspect(ctx.op, { task }, ctx.deps);
    return { data: { ...report, inspection }, legacy: report };
  },
};
