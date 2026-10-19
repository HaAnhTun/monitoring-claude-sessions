// `hooks status` (01 6.3; 02 3.1): which settings files carry our entries, whether the stable copy of the hook script is
// current, what the handler's own log says, and when each instance last received an envelope. It reads and writes nothing.
// Option table and rendering only; the operation is `ops.hooks.status`.
import { opsHooks } from '@mcs/engine';
import type { HooksStatusResult } from '@mcs/shared';

import type { CommandDefinition } from '../../main.ts';

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The text of the status; consent rule 6 (02 3.8): an uninstall is offered whenever an install exists. */
export function statusLines(result: HooksStatusResult): string[] {
  const lines: string[] = [];
  if (result.installs.length === 0) {
    lines.push('hooks: not installed (they are opt-in: mcs hooks install shows what would be written)');
  } else {
    const count = result.installs.length;
    lines.push(`hooks: installed in ${String(count)} settings file${count === 1 ? '' : 's'}`);
    for (const install of result.installs) {
      const when = install.at > 0 ? `, installed ${iso(install.at)}` : '';
      lines.push(
        `  ${install.settingsPath} (scope ${install.scope}, ${String(install.events)} events, handler ${install.handlerVersion}${when})`,
      );
    }
  }
  lines.push(`script copy: ${result.script.state} (${result.script.path})`);
  if (result.handlerLog.length === 0) {
    lines.push('handler log: no problems recorded');
  } else {
    lines.push('handler log:');
    for (const entry of result.handlerLog) {
      lines.push(`  ${entry.code} x${String(entry.count)} (last ${iso(entry.lastAt)})`);
    }
  }
  const ids = Object.keys(result.lastEnvelopeAt).sort();
  if (ids.length === 0) {
    lines.push('last envelope: no instance has a route file');
  } else {
    for (const id of ids) {
      const at = result.lastEnvelopeAt[id];
      lines.push(
        `last envelope of instance ${id.slice(0, 8)}: ${at === null || at === undefined ? 'none yet' : iso(at)}`,
      );
    }
  }
  if (result.installs.length > 0) {
    lines.push(
      'to remove the hooks: mcs hooks uninstall [--scope user | --settings-file FILE] (a dry run; add --yes to apply)',
    );
  }
  return lines;
}

export function makeCommand(ops: Pick<typeof opsHooks, 'status'> = opsHooks): CommandDefinition {
  return {
    name: 'hooks status',
    summary: 'show where the hooks are installed, the state of the script copy and the handler log (writes nothing)',
    synopsis: '[--task SLUG]',
    options: {
      task: { type: 'string', valueName: 'SLUG', description: 'report the last envelope of this task only' },
    },
    async run(ctx) {
      const task = ctx.args.string('task');
      const result = await ops.status(ctx.op, task === undefined ? {} : { task });
      return { data: result, text: statusLines(result) };
    },
  };
}

export const command: CommandDefinition = makeCommand();
