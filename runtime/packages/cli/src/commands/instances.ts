// `instances list` and `instances repair` (01 6.4, 3.4). Option tables and rendering only; the operations are
// `ops.instances.list` and `ops.instances.repairIdentity`.
import { opsInstances } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export function makeListCommand(ops: Pick<typeof opsInstances, 'list'> = opsInstances): CommandDefinition {
  return {
    name: 'instances list',
    summary:
      'list the tasks of the repository with their identity, state, url, pid, version and whether they are outdated',
    synopsis: '[--no-probe]',
    options: {
      'no-probe': {
        type: 'boolean',
        description: 'read state.json and the process table only (no control or HTTP query)',
      },
    },
    async run(ctx) {
      const result = await ops.list(ctx.op, { probe: !ctx.args.flag('no-probe') });
      return { data: result.instances, text: opsInstances.listLines(result) };
    },
  };
}

export function makeRepairCommand(ops: Pick<typeof opsInstances, 'repairIdentity'> = opsInstances): CommandDefinition {
  return {
    name: 'instances repair',
    summary: 'give a copied or renamed workspace a new identity (dry run without --yes)',
    synopsis: '--task SLUG [--yes]',
    options: {
      task: { type: 'string', valueName: 'SLUG', required: true, description: 'the workspace to repair' },
      yes: { type: 'boolean', description: 'apply the plan (refused while a runtime of the task runs)' },
    },
    async run(ctx) {
      const result = await ops.repairIdentity(ctx.op, {
        task: ctx.args.string('task') ?? '',
        yes: ctx.args.flag('yes'),
      });
      return { data: result, text: opsInstances.repairLines(result) };
    },
  };
}

export const listCommand: CommandDefinition = makeListCommand();
export const repairCommand: CommandDefinition = makeRepairCommand();
