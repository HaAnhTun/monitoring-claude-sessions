// `restart` (01 6.3, 4.10): `stop`, then, only if it succeeded, `start` with the same options. Option table and rendering
// only; the operation is `ops.lifecycle.restart`.
import { opsLifecycle } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';
import { START_OPTIONS, startInputOf } from './start.ts';

export function makeCommand(ops: Pick<typeof opsLifecycle, 'restart'> = opsLifecycle): CommandDefinition {
  return {
    name: 'restart',
    summary: 'stop the monitor of a task and start it again (loads new code)',
    synopsis: '[--task SLUG] [--port N] [--log-level LEVEL] [--open] [--timeout-ms MS]',
    options: START_OPTIONS,
    async run(ctx) {
      const result = await ops.restart(ctx.op, startInputOf(ctx.args));
      return { data: result, text: result.message, warnings: result.warnings, exitCode: result.exitCode };
    },
  };
}

export const command: CommandDefinition = makeCommand();
