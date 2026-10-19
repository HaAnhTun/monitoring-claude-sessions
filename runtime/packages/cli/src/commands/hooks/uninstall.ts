// `hooks uninstall` (01 6.3, 6.4; 02 3.1; ADR 0070 item 4): remove every hook entry of ours from one settings file, and the stable
// copy of the script when no install is left. A dry run unless `--yes`; on a terminal it ends with a consent prompt.
// Option table and rendering only; the operation is `ops.hooks.uninstall`.
import path from 'node:path';

import { opsHooks } from '@mcs/engine';

import type { CommandDefinition } from '../../main.ts';
import { realConsentIo, runChange, targetArgs, targetOptions, type ConsentIo } from './shared.ts';

export function makeCommand(
  ops: Pick<typeof opsHooks, 'uninstall'> = opsHooks,
  consent: ConsentIo = realConsentIo,
): CommandDefinition {
  return {
    name: 'hooks uninstall',
    summary: 'remove the hook entries from a settings file (dry run unless --yes; asks on a terminal)',
    synopsis: '[--scope project-local|user | --settings-file FILE] [--task SLUG] [--dry-run] [--yes] [--no-prompt]',
    options: {
      ...targetOptions(false),
      'dry-run': { type: 'boolean', description: 'print the plan and write nothing (the default without --yes)' },
      yes: { type: 'boolean', description: 'apply the plan' },
      'no-prompt': { type: 'boolean', description: 'never ask on a terminal; a dry run stays a dry run' },
    },
    run(ctx) {
      const target = targetArgs(ctx.args, (file) => path.resolve(file));
      return runChange('uninstall', ctx, (yes) => ops.uninstall(ctx.op, { ...target, yes }), consent);
    },
  };
}

export const command: CommandDefinition = makeCommand();
