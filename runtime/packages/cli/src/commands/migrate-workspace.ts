// `migrate-workspace` (ADR 0068): the one-time conversion of a pre-4.0 task workspace, a dry run unless `--apply` is given.
// Option table and rendering only. Exit 0 when the workspace is not blocked, 1 when it is, 2 for a usage error.
import { opsMigrate } from '@mcs/engine';

import type { CommandDefinition } from '../main.ts';

export const command: CommandDefinition = {
  name: 'migrate-workspace',
  summary: 'convert a pre-4.0 task workspace (Python regex syntax, no instance.json); a dry run unless --apply',
  synopsis: '--task SLUG [--apply]',
  options: {
    task: { type: 'string', valueName: 'SLUG', required: true, description: 'task workspace to convert' },
    apply: {
      type: 'boolean',
      description: 'write the conversion (a backup under data/backups/ comes first); default: dry run, nothing written',
    },
  },
  async run(ctx) {
    const input = { task: ctx.args.string('task') ?? '' };
    const report = ctx.args.flag('apply')
      ? await opsMigrate.apply(ctx.op, input)
      : await opsMigrate.plan(ctx.op, input);
    return {
      data: report,
      text: opsMigrate.reportLines(report),
      warnings: report.warnings,
      exitCode: report.verdict === 'blocked' ? 1 : 0,
    };
  },
};
