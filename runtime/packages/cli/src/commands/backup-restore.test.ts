// `backup restore` (01 5.5, 6.3): the option table and the rendering of `ops.backup.restore`; without --yes it is a dry run.
import type { BackupRestoreInput, OpContext } from '@mcs/engine';
import type { BackupRestoreResult } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './backup-restore.ts';

type Typed = Record<string, string | boolean>;

function contextOf(values: Typed): CommandContext {
  const text = (name: string): string | undefined => {
    const v = values[name];
    return typeof v === 'string' ? v : undefined;
  };
  return {
    op: { repo: 'R' } as unknown as OpContext,
    args: {
      positionals: [],
      string: text,
      strings: (name) => {
        const v = text(name);
        return v === undefined ? [] : [v];
      },
      flag: (name) => values[name] === true,
      int: () => undefined,
    },
    deps: {},
    json: false,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

function resultOf(applied: boolean): BackupRestoreResult {
  return {
    task: 'demo',
    id: '20261020T101500Z-manual',
    applied,
    dbCopy: 'online',
    dbSchemaVersion: 1,
    runtimeVersion: '4.0.0',
    restores: ['data/monitor.db'],
    preRestoreBackup: applied ? '20261020T101600Z-pre-restore' : null,
    upgradeNeeded: applied,
    pruned: [],
  };
}

describe('backup restore command', () => {
  it('takes --task and --id (required), --include-runtime-config and --yes', () => {
    expect(command.name).toBe('backup restore');
    expect(Object.keys(command.options)).toEqual(['task', 'id', 'include-runtime-config', 'yes']);
    expect(command.options['task']).toMatchObject({ required: true });
    expect(command.options['id']).toMatchObject({ required: true });
  });

  it('without --yes it asks for a dry run and warns', async () => {
    const seen: BackupRestoreInput[] = [];
    const cmd = makeCommand({
      restore: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(resultOf(false));
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo', id: '20261020T101500Z-manual' }));
    expect(seen).toEqual([{ task: 'demo', id: '20261020T101500Z-manual', includeRuntimeConfig: false, yes: false }]);
    expect(out.warnings).toEqual(['dry run; pass --yes to apply']);
    expect(out.text?.[0]).toContain('dry run, nothing changed');
  });

  it('with --yes it applies, names the pre-restore backup and the follow-up', async () => {
    const seen: BackupRestoreInput[] = [];
    const cmd = makeCommand({
      restore: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(resultOf(true));
      },
    });
    const out = await cmd.run(
      contextOf({ task: 'demo', id: '20261020T101500Z-manual', yes: true, 'include-runtime-config': true }),
    );
    expect(seen[0]).toMatchObject({ yes: true, includeRuntimeConfig: true });
    expect(out.warnings).toEqual([]);
    expect(out.text?.[0]).toBe("restored backup 20261020T101500Z-manual into task 'demo' (database schema 1)");
    expect(out.text).toContain('pre-restore backup: 20261020T101600Z-pre-restore (restore it to undo this)');
    expect(out.text?.at(-1)).toBe('the restored database is older than this runtime: run `mcs upgrade --task demo`');
  });
});
