// `restart` (01 6.3, 4.10; 06 2.3): `stop`, then, only if it succeeded, `start` with the same options. For the app the stop is the
// guarded one (`--force` ends live terminals) and the start opens the browser the way `start` does. Option table and rendering
// only; the operations are `opsApp.restartUser` and `ops.lifecycle.restart`.
import { opsApp, opsLifecycle } from '@mcs/engine';

import type { CommandDefinition, OptionTable } from '../main.ts';
import { START_OPTIONS, START_SYNOPSIS, startInputOf, userRestartResult, userStartInputOf } from './start.ts';

/** The options of `start`, and `--force`, which only the app knows (the kernel refuses it in a task call). */
const RESTART_OPTIONS: OptionTable = {
  ...START_OPTIONS,
  force: {
    type: 'boolean',
    scope: 'user',
    description: 'end the live terminal sessions instead of refusing with exit 3',
  },
};

export function makeCommand(
  ops: Pick<typeof opsLifecycle, 'restart'> = opsLifecycle,
  app: Pick<typeof opsApp, 'restartUser'> = opsApp,
): CommandDefinition {
  return {
    name: 'restart',
    summary:
      'stop the app and start it again (loads new code; it refuses while terminals are live unless --force); with --task, restart the monitor of a task',
    synopsis: `${START_SYNOPSIS} [--force]`,
    options: RESTART_OPTIONS,
    defaultScope: 'user',
    async run(ctx) {
      if (ctx.scope === 'user') {
        const result = await app.restartUser(ctx.op, {
          ...userStartInputOf(ctx.args),
          ...(ctx.args.flag('force') ? { force: true } : {}),
        });
        return userRestartResult(result, ctx.args.flag('print'));
      }
      const result = await ops.restart(ctx.op, startInputOf(ctx.args));
      return { data: result, text: result.message, warnings: result.warnings, exitCode: result.exitCode };
    },
  };
}

export const command: CommandDefinition = makeCommand();
