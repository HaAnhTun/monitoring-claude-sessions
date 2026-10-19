// `backup` (01 5.5, 6.3): the option table and the rendering of `ops.backup.create`.
import type { BackupCreateInput, OpContext } from '@mcs/engine';
import type { BackupCreateResult } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './backup.ts';

type Typed = Record<string, string | boolean>;

/** The context a command gets from the kernel: the values are the text typed on the command line. */
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
      int: (name) => {
        const v = text(name);
        return v === undefined ? undefined : Number(v);
      },
    },
    deps: {},
    json: false,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

const RESULT: BackupCreateResult = {
  task: 'demo',
  id: '20261020T101500Z-manual',
  reason: 'manual',
  folder: 'data/backups/20261020T101500Z-manual/',
  dbCopy: 'online',
  dbSchemaVersion: 1,
  files: 4,
  bytes: 2048,
  dbCopiedBy: 'server',
  pruned: ['20260101T000000Z-manual'],
};

describe('backup command', () => {
  it('is `backup` with the alias `backup create`, and takes --task (required) and --label', () => {
    expect(command.name).toBe('backup');
    expect(command.aliases).toEqual(['backup create']);
    expect(Object.keys(command.options)).toEqual(['task', 'label']);
    expect(command.options['task']).toMatchObject({ type: 'string', required: true });
    expect(command.options['label']).toMatchObject({ type: 'string' });
  });

  it('passes the options on and renders the result', async () => {
    const seen: BackupCreateInput[] = [];
    const cmd = makeCommand({
      create: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(RESULT);
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo', label: 'before the change' }));
    expect(seen).toEqual([{ task: 'demo', label: 'before the change' }]);
    expect(out.data).toBe(RESULT);
    expect(out.exitCode ?? 0).toBe(0);
    expect(out.text?.[0]).toBe('created backup 20261020T101500Z-manual (manual): 4 files, 2.0 KiB');
    expect(out.text).toContain('folder: data/backups/20261020T101500Z-manual/');
    expect(out.text).toContain('the database was copied by the running server');
    expect(out.text?.at(-1)).toBe('removed 1 older backups: 20260101T000000Z-manual');
  });

  it('passes no label when none was typed', async () => {
    const seen: BackupCreateInput[] = [];
    await makeCommand({
      create: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(RESULT);
      },
    }).run(contextOf({ task: 'demo' }));
    expect(seen).toEqual([{ task: 'demo' }]);
  });
});
