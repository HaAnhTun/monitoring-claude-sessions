// `check` (01 6.3, 6.4; 06 2.3, 2.6): for a task, resolve and validate its configuration and print the one-line summary; for the app,
// the prerequisite checks: the doctor pipeline limited to the machine-level checks and the `app.*` family (`userCheckIds`), exit 1
// iff an error-level check failed. Option table and rendering only.
import { opsApp, opsConfig, opsDoctor, userCheckIds } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';
import { runForApp } from './doctor.ts';

export function makeCommand(
  config: Pick<typeof opsConfig, 'check'> = opsConfig,
  doctor: Pick<typeof opsDoctor, 'run'> = opsDoctor,
  app: Pick<typeof opsApp, 'userInstanceExists'> = opsApp,
): CommandDefinition {
  return {
    name: 'check',
    summary:
      'check what the app needs to run (Node, the runtime, claude, the terminal, the port); with --task, validate the configuration of a task (every file, every regex) and print a one-line summary',
    synopsis: '[--task SLUG]',
    options: {
      task: {
        type: 'string',
        valueName: 'SLUG',
        description: 'task to check (task scope; default: the task "default" when it exists, else the shared defaults)',
      },
    },
    defaultScope: 'user',
    async run(ctx) {
      if (ctx.scope === 'user') {
        const { report, absent } = await runForApp(ctx, doctor, app, userCheckIds);
        const note = absent
          ? [
              'note: the app was never started (run `caw start`), so its own configuration does not exist yet: the defaults were checked',
            ]
          : [];
        return { data: report, text: [...opsDoctor.doctorLines(report), ...note], exitCode: report.ok ? 0 : 1 };
      }
      const task = ctx.args.string('task');
      const result = await config.check(ctx.op, task === undefined ? {} : { task }, ctx.deps);
      return { data: result, text: [result.line] };
    },
  };
}

export const command: CommandDefinition = makeCommand();
