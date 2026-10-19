// `migrate-workspace` (ADR 0068): the one-time conversion of pre-4.0 task workspaces, a dry run unless `--apply` is given.
// `--task SLUG` converts one workspace; `--all` visits every workspace of the tasks root, and `--all --apply` needs `--yes`
// because it writes into all of them. Option table and rendering only. Exit 0 when no workspace is blocked, 1 when one is,
// 2 for a usage error.
import { opsMigrate } from '@mcs/engine';
import { McsError } from '@mcs/shared';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsMigrate, 'plan' | 'apply'> = opsMigrate): CommandDefinition {
  return {
    name: 'migrate-workspace',
    summary:
      'convert pre-4.0 task workspaces (Python regex syntax, no instance.json), one with --task or all with --all; a dry run unless --apply',
    synopsis: '(--task SLUG | --all) [--apply [--yes]]',
    options: {
      task: { type: 'string', valueName: 'SLUG', description: 'task workspace to convert' },
      all: {
        type: 'boolean',
        description:
          'every workspace of the tasks root, one after the other; a blocked one is reported and left untouched, the others are converted',
      },
      apply: {
        type: 'boolean',
        description:
          'write the conversion (a backup under data/backups/ comes first); default: dry run, nothing written',
      },
      yes: { type: 'boolean', description: 'confirm --all --apply, which converts every workspace of the tasks root' },
    },
    async run(ctx) {
      const task = ctx.args.string('task');
      const apply = ctx.args.flag('apply');
      if (!ctx.args.flag('all')) {
        const input = { task: task ?? '' };
        const report = apply ? await ops.apply(ctx.op, input) : await ops.plan(ctx.op, input);
        return {
          data: report,
          text: opsMigrate.reportLines(report),
          warnings: report.warnings,
          exitCode: report.verdict === 'blocked' ? 1 : 0,
        };
      }
      if (task !== undefined) throw new McsError('USAGE', 'migrate-workspace takes --task SLUG or --all, not both');
      if (apply && !ctx.args.flag('yes')) {
        throw new McsError('USAGE', 'migrate-workspace --all --apply converts every workspace and needs --yes', {
          hint: 'run without --apply for the dry run, add --yes to convert all, or convert one task with --task SLUG --apply',
        });
      }
      const sweep = apply ? await ops.apply(ctx.op, { all: true }) : await ops.plan(ctx.op, { all: true });
      return {
        data: sweep,
        text: opsMigrate.sweepLines(sweep),
        warnings: sweep.workspaces.flatMap((w) => w.warnings.map((warning) => `task '${w.slug}': ${warning}`)),
        exitCode: sweep.counts.blocked > 0 ? 1 : 0,
      };
    },
  };
}

export const command: CommandDefinition = makeCommand();
