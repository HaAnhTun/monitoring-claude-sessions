// `doctor` (01 6.4, V4; 06 2.3, 2.6): the portability checks of the machine, the runtime and, with a task, its workspace; for the app
// the workspace of the app (when it was made) and the `app.*` checks, which `main.ts` wires in as `extraChecks` and which answer
// nothing outside the app. Option table and rendering only; the operation is `ops.doctor.run`. Exit 1 iff an error-level check
// failed.
import { USER_INSTANCE_SLUG, opsApp, opsDoctor, type DoctorInput } from '@mcs/engine';
import type { DoctorReport } from '@mcs/shared';

import type { CommandContext, CommandDefinition } from '../main.ts';

/**
 * Runs the doctor for the app. The workspace of the app is made by `start`, so before the first start there is none: its checks are
 * left out (the machine-wide and `app.*` checks do not need one) and `absent` says so. `only` limits the checks (`caw check`).
 */
export async function runForApp(
  ctx: CommandContext,
  ops: Pick<typeof opsDoctor, 'run'>,
  app: Pick<typeof opsApp, 'userInstanceExists'>,
  only?: readonly string[],
): Promise<{ readonly report: DoctorReport; readonly absent: boolean }> {
  const absent = !(await app.userInstanceExists(ctx.op));
  const input: DoctorInput = {
    ...(absent ? {} : { task: USER_INSTANCE_SLUG }),
    ...(only === undefined ? {} : { only }),
  };
  return { report: await ops.run(ctx.op, input, ctx.deps), absent };
}

export function makeCommand(
  ops: Pick<typeof opsDoctor, 'run'> = opsDoctor,
  app: Pick<typeof opsApp, 'userInstanceExists'> = opsApp,
): CommandDefinition {
  return {
    name: 'doctor',
    summary:
      'check Node, the runtime, the Claude home, the app prerequisites and its workspace; with --task, the workspace, configuration, database and port of a task',
    synopsis: '[--task SLUG]',
    options: {
      task: {
        type: 'string',
        valueName: 'SLUG',
        description: 'task scope: also run the checks of this task (without it the checks of the app run)',
      },
    },
    defaultScope: 'user',
    async run(ctx) {
      if (ctx.scope === 'user') {
        const { report, absent } = await runForApp(ctx, ops, app);
        const note = absent
          ? ['note: the app was never started (run `caw start`), so the checks of its workspace were skipped']
          : [];
        return { data: report, text: [...opsDoctor.doctorLines(report), ...note], exitCode: report.ok ? 0 : 1 };
      }
      const task = ctx.args.string('task');
      const report = await ops.run(ctx.op, task === undefined ? {} : { task }, ctx.deps);
      return { data: report, text: opsDoctor.doctorLines(report), exitCode: report.ok ? 0 : 1 };
    },
  };
}

export const command: CommandDefinition = makeCommand();
