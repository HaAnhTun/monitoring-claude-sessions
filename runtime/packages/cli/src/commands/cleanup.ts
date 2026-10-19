// `cleanup` (01 6.4): remove what a task no longer needs, one scope at a time. Every scope is a dry run until `--yes`;
// `--scope data` also needs the task name again in `--confirm`. Option table and rendering only; the operation is
// `ops.cleanup.run`, which holds every rule (stopped instance through the probe, contained paths, links skipped, backup first).
import { opsCleanup } from '@mcs/engine';
import { CLEANUP_SCOPES } from '@mcs/shared';

import type { CommandDefinition } from '../main.ts';

export function makeCommand(ops: Pick<typeof opsCleanup, 'run'> = opsCleanup): CommandDefinition {
  return {
    name: 'cleanup',
    summary:
      'delete stale state, init leftovers, old logs, old backups, drained spool segments or old data (dry run unless --yes)',
    synopsis:
      '--scope stale-state|init-leftovers|logs|backups|spool|data [--task SLUG] [--older-than DAYS] [--keep N] [--dry-run] [--yes [--confirm SLUG]]',
    options: {
      scope: {
        type: 'string',
        required: true,
        valueName: 'SCOPE',
        choices: CLEANUP_SCOPES,
        description:
          'what to clean: stale-state (state.json of a gone monitor, tokens, *.tmp), init-leftovers (tasks root), logs, backups, spool (drained segments), data (old sessions, needs --confirm)',
      },
      task: {
        type: 'string',
        valueName: 'SLUG',
        description: 'the task (every scope except init-leftovers)',
      },
      'older-than': {
        type: 'string',
        valueName: 'DAYS',
        integer: [1, 36500],
        description:
          'logs: age of rotated logs and diagnostics (default 30); spool: age of drained segments (default spool.retainHours); data: sessions with no activity for this long (default: the retention policy)',
      },
      keep: {
        type: 'string',
        valueName: 'N',
        integer: [0, 1000],
        description: 'backups: how many of the newest backups stay (default backup.keep)',
      },
      'dry-run': { type: 'boolean', description: 'print the plan and delete nothing (the default without --yes)' },
      yes: { type: 'boolean', description: 'delete what the plan lists' },
      confirm: {
        type: 'string',
        valueName: 'SLUG',
        description: 'the task name again, as a typed confirmation (--scope data)',
      },
    },
    async run(ctx) {
      const scope = CLEANUP_SCOPES.find((s) => s === ctx.args.string('scope'));
      const task = ctx.args.string('task');
      const olderThanDays = ctx.args.int('older-than');
      const keep = ctx.args.int('keep');
      const confirm = ctx.args.string('confirm');
      if (scope === undefined) return Promise.reject(new Error('cleanup: the scope option was not validated'));
      const result = await ops.run(ctx.op, {
        scope,
        yes: ctx.args.flag('yes'),
        dryRun: ctx.args.flag('dry-run'),
        ...(task === undefined ? {} : { task }),
        ...(olderThanDays === undefined ? {} : { olderThanDays }),
        ...(keep === undefined ? {} : { keep }),
        ...(confirm === undefined ? {} : { confirm }),
      });
      const planned = result.count > 0 && !result.applied;
      return {
        data: result,
        text: opsCleanup.lines(result),
        warnings: planned
          ? [`dry run; pass --yes${scope === 'data' ? ` --confirm ${result.task ?? ''}` : ''} to apply`]
          : [],
        exitCode: result.remaining.length > 0 ? 1 : 0,
      };
    },
  };
}

export const command: CommandDefinition = makeCommand();
