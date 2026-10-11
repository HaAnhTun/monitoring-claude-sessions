// `configure` (01 6.3, 6.4): change configuration keys of one task, audited, validated before anything is written.
// Option table and rendering only.
import { opsConfig, type ConfigureInput } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export const command: CommandDefinition = {
  name: 'configure',
  summary: 'change the configuration of a task (validated as a whole, written atomically, audited)',
  synopsis: '--task SLUG [--set KEY=JSON]... [--unset KEY]... [--reason TEXT] [--decision TEXT] [--dry-run]',
  options: {
    task: { type: 'string', valueName: 'SLUG', required: true, description: 'task to change' },
    set: {
      type: 'string',
      valueName: 'KEY=JSON',
      multiple: true,
      description: 'set a dotted key to a JSON value (a value that is not JSON is kept as text)',
    },
    unset: {
      type: 'string',
      valueName: 'KEY',
      multiple: true,
      description: 'remove a dotted key (the default applies)',
    },
    reason: { type: 'string', valueName: 'TEXT', description: 'reason recorded in the audit trail' },
    decision: { type: 'string', valueName: 'TEXT', description: 'also record a decision titled "configuration"' },
    'dry-run': { type: 'boolean', description: 'report what would change and write nothing' },
  },
  async run(ctx) {
    const { args } = ctx;
    const reason = args.string('reason');
    const decision = args.string('decision');
    const input: ConfigureInput = {
      task: args.string('task') ?? '',
      set: args.strings('set'),
      unset: args.strings('unset'),
      ...(reason === undefined ? {} : { reason }),
      ...(decision === undefined ? {} : { decision }),
      ...(args.flag('dry-run') ? { dryRun: true } : {}),
    };
    const report = await opsConfig.configure(ctx.op, input, ctx.deps);
    return { data: report, legacy: report };
  },
};
