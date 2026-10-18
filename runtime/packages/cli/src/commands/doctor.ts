// `doctor` (01 6.4, V4): the portability checks of the machine, the runtime and, with a task, its workspace. Option table and
// rendering only; the operation is `ops.doctor.run`. Exit 1 iff an error-level check failed.
import { opsDoctor } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsDoctor, 'run'> = opsDoctor): CommandDefinition {
  return {
    name: 'doctor',
    summary:
      'check Node, the runtime, the Claude home, and with --task the workspace, configuration, database and port',
    synopsis: '[--task SLUG]',
    options: {
      task: { type: 'string', valueName: 'SLUG', description: 'also run the checks of this task' },
    },
    async run(ctx) {
      const task = ctx.args.string('task');
      const report = await ops.run(ctx.op, task === undefined ? {} : { task }, ctx.deps);
      return { data: report, text: opsDoctor.doctorLines(report), exitCode: report.ok ? 0 : 1 };
    },
  };
}

export const command: CommandDefinition = makeCommand();
