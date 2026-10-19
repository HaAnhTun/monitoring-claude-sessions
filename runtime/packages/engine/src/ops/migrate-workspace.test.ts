// `ops.migrate` units (WP-140): the input rule of plan and apply, the text of a sweep and the doctor check without a task.
// The sweep itself, the single-task path and the doctor check on real workspaces run in `test/migrate-workspace.int.test.ts`.
import { McsError } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { OpContext } from './workspace.ts';
import {
  apply,
  plan,
  sweepLines,
  workspaceFormatCheck,
  type MigrateInput,
  type MigrationSweep,
  type WorkspaceMigrationReport,
} from './migrate-workspace.ts';

/** Never reached: the input rule fails before any file is looked at. */
const NO_CONTEXT = {} as unknown as OpContext;

function report(
  slug: string,
  verdict: WorkspaceMigrationReport['verdict'],
  mode: WorkspaceMigrationReport['mode'],
  over: Partial<WorkspaceMigrationReport> = {},
): WorkspaceMigrationReport {
  return { slug, verdict, mode, actions: [], patterns: [], blockers: [], warnings: [], backup: null, ...over };
}

function sweepOf(
  mode: MigrationSweep['mode'],
  workspaces: WorkspaceMigrationReport[],
  skipped: MigrationSweep['skipped'] = [],
): MigrationSweep {
  const of = (verdict: WorkspaceMigrationReport['verdict']): number =>
    workspaces.filter((w) => w.verdict === verdict).length;
  return {
    mode,
    workspaces,
    skipped,
    counts: {
      total: workspaces.length,
      current: of('current'),
      needsMigration: of('needs-migration'),
      blocked: of('blocked'),
    },
  };
}

describe('the input of plan and apply', () => {
  it('needs a task or --all, never both', async () => {
    const inputs = [{}, { task: '' }, { all: false }, { all: true, task: 'a' }, { all: true, task: '' }];
    for (const input of inputs) {
      for (const op of [plan, apply]) {
        const error = await op(NO_CONTEXT, input as MigrateInput as never).catch((e: unknown) => e);
        expect(error, JSON.stringify(input)).toBeInstanceOf(McsError);
        expect((error as McsError).code).toBe('USAGE');
      }
    }
  });

  it('names the two choices in the message', async () => {
    const none = await plan(NO_CONTEXT, {}).catch((e: unknown) => e);
    expect((none as McsError).message).toBe('migrate-workspace needs --task SLUG or --all');
    const both = await apply(NO_CONTEXT, { all: true, task: 'a' } as never).catch((e: unknown) => e);
    expect((both as McsError).message).toBe('migrate-workspace takes --task SLUG or --all, not both');
  });
});

describe('sweepLines', () => {
  it('prints each workspace without the single-task hint, the skipped folders, the tally and one closing hint (dry run)', () => {
    const lines = sweepLines(
      sweepOf(
        'dry-run',
        [
          report('a', 'needs-migration', 'dry-run', { actions: ['write config.json'] }),
          report('b', 'blocked', 'dry-run', {
            blockers: ['REGEX_UNSUPPORTED: attempts.start cannot be translated exactly'],
          }),
          report('c', 'current', 'dry-run'),
        ],
        [{ slug: 'linked', reason: 'a link, not a folder; links are never followed or written through' }],
      ),
    );
    expect(lines).toEqual([
      "task 'a': needs-migration (dry run, nothing written)",
      '  would write config.json',
      "task 'b': blocked (dry run, nothing written)",
      '  blocked: REGEX_UNSUPPORTED: attempts.start cannot be translated exactly',
      "task 'c': current (dry run, nothing written)",
      "skipped 'linked': a link, not a folder; links are never followed or written through",
      '3 task workspaces: 1 needing migration, 1 current, 1 blocked (dry run, nothing written)',
      'run `mcs migrate-workspace --all --apply --yes` to convert them (a backup is written first)',
    ]);
  });

  it('counts what was converted when applied, and has no closing hint', () => {
    const lines = sweepLines(
      sweepOf('applied', [
        report('a', 'needs-migration', 'applied', { backup: 'data/backups/pre-migrate-20261019T101500Z/' }),
        report('b', 'current', 'applied'),
      ]),
    );
    expect(lines).toEqual([
      "task 'a': needs-migration (applied)",
      '  backup: data/backups/pre-migrate-20261019T101500Z/',
      "task 'b': current (applied)",
      '2 task workspaces: 1 migrated, 1 already current, 0 blocked',
    ]);
  });

  it('has no closing hint when nothing needs migration, and says so for zero workspaces', () => {
    expect(sweepLines(sweepOf('dry-run', [report('a', 'current', 'dry-run')])).at(-1)).toBe(
      '1 task workspace: 0 needing migration, 1 current, 0 blocked (dry run, nothing written)',
    );
    expect(sweepLines(sweepOf('applied', []))).toEqual(['no task workspaces found in the tasks root']);
    expect(sweepLines(sweepOf('dry-run', [], [{ slug: 'linked', reason: 'a link' }]))).toEqual([
      "skipped 'linked': a link",
      'no task workspaces found in the tasks root',
    ]);
  });
});

describe('workspaceFormatCheck', () => {
  it('is ok and skipped without a task', async () => {
    expect(await workspaceFormatCheck(NO_CONTEXT, null)).toEqual({
      id: 'workspace.format',
      ok: true,
      level: 'warn',
      detail: 'no task selected (skipped)',
    });
  });
});
