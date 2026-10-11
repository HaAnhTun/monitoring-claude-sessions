// `audit` (01 6.3, 6.4): static checks of one or every task workspace; exit 1 when any problem is found. Option table and
// rendering only.
import { opsAudit } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export const command: CommandDefinition = {
  name: 'audit',
  summary:
    'check task workspaces (identity, schema, configuration, audit trail, links, transcript copies); exit 1 on problems',
  synopsis: '[--task SLUG]',
  options: {
    task: { type: 'string', valueName: 'SLUG', description: 'task to check (default: every task)' },
  },
  async run(ctx) {
    const task = ctx.args.string('task');
    const report = await opsAudit.check(ctx.op, task === undefined ? {} : { task });
    return { data: report, legacy: report, exitCode: report.every((item) => item.ok) ? 0 : 1 };
  },
};
