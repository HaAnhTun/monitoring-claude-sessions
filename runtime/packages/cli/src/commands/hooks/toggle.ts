// `hooks enable` and `hooks disable` (01 6.3, 6.4): switch whether the hook handler routes to a task. They write `instance.json`
// and the route file under the task mutex, audit `hooks-enable` or `hooks-disable`, and never touch a settings file. Option
// tables and rendering only; the operation is `ops.hooks.setEnabled`.
import { opsHooks, type HooksToggleResult } from '@mcs/engine';

import type { CommandDefinition, CommandResult } from '../../main.ts';

function resultOf(result: HooksToggleResult): CommandResult {
  const word = result.enabled ? 'enabled' : 'disabled';
  const text = [
    result.changed
      ? `hooks ${word} for task '${result.task}' (hooks.enabled: ${String(result.previous)} -> ${String(result.enabled)})`
      : `hooks were already ${word} for task '${result.task}'; nothing changed in instance.json`,
    `route file: ${result.routeFile}`,
  ];
  const warnings = result.running
    ? [
        `the monitor of task '${result.task}' is running: restart it (mcs restart --task ${result.task}) so that it keeps this change`,
      ]
    : [];
  return { data: result, text, warnings };
}

export function makeCommand(enabled: boolean, ops: Pick<typeof opsHooks, 'setEnabled'> = opsHooks): CommandDefinition {
  const verb = enabled ? 'enable' : 'disable';
  return {
    name: `hooks ${verb}`,
    summary: `${verb} hook routing for a task (writes instance.json and the route file, never a settings file)`,
    synopsis: '--task SLUG',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: `the task to ${verb} hooks for` },
    },
    async run(ctx) {
      return resultOf(await ops.setEnabled(ctx.op, { task: ctx.args.string('task') ?? '', enabled }));
    },
  };
}

export const enableCommand: CommandDefinition = makeCommand(true);
export const disableCommand: CommandDefinition = makeCommand(false);
