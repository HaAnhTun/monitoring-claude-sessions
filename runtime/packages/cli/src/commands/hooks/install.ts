// `hooks install` (01 6.3, 6.4; 02 3.1; ADR 0014, ADR 0070): put our hook entries into one settings file. A dry run unless
// `--yes`; on a terminal it ends with a consent prompt. Option table and rendering only; the operation is `ops.hooks.install`.
import path from 'node:path';

import { opsHooks } from '@mcs/engine';

import type { CommandDefinition } from '../../main.ts';
import { realConsentIo, runChange, targetArgs, targetOptions, type ConsentIo } from './shared.ts';

export function makeCommand(
  ops: Pick<typeof opsHooks, 'install'> = opsHooks,
  consent: ConsentIo = realConsentIo,
): CommandDefinition {
  return {
    name: 'hooks install',
    summary: 'install the hook entries into a settings file (dry run unless --yes; asks on a terminal)',
    synopsis:
      '[--scope project-local|user | --settings-file FILE] [--task SLUG] [--sync-tool-events] [--dry-run] [--yes] [--no-prompt]',
    options: {
      ...targetOptions(false),
      'sync-tool-events': {
        type: 'boolean',
        description:
          'run the four tool events (PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch) synchronously',
      },
      'dry-run': { type: 'boolean', description: 'print the plan and write nothing (the default without --yes)' },
      yes: { type: 'boolean', description: 'apply the plan (only after the person agreed to it)' },
      'no-prompt': { type: 'boolean', description: 'never ask on a terminal; a dry run stays a dry run' },
    },
    run(ctx) {
      const target = targetArgs(ctx.args, (file) => path.resolve(file));
      const syncToolEvents = ctx.args.flag('sync-tool-events');
      return runChange('install', ctx, (yes) => ops.install(ctx.op, { ...target, yes, syncToolEvents }), consent);
    },
  };
}

export const command: CommandDefinition = makeCommand();
