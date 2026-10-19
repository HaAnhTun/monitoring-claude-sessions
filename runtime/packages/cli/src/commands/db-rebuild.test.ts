// `db rebuild` (01 5.4, 6.3): the option table and the rendering of `ops.instanceUpgrade.rebuildDb`; it needs --yes and --confirm.
import type { DbRebuildInput, OpContext } from '@mcs/engine';
import type { DbRebuildResult } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './db-rebuild.ts';

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

const FILES = [
  { path: 'data/monitor.db', bytes: 405_504 },
  { path: 'data/monitor.db-wal', bytes: 0 },
];

describe('db rebuild command', () => {
  it('takes --task (required), --yes and --confirm', () => {
    expect(command.name).toBe('db rebuild');
    expect(Object.keys(command.options)).toEqual(['task', 'yes', 'confirm']);
    expect(command.options['task']).toMatchObject({ required: true });
    expect(command.options['confirm']).toMatchObject({ type: 'string' });
  });

  it('a dry run lists the files, what is lost, and names the flags that apply it', async () => {
    const seen: DbRebuildInput[] = [];
    const cmd = makeCommand({
      rebuildDb: (_ctx, input) => {
        seen.push(input);
        const result: DbRebuildResult = { task: 'demo', applied: false, files: FILES, backup: null, pruned: [] };
        return Promise.resolve(result);
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo' }));
    expect(seen).toEqual([{ task: 'demo', yes: false }]);
    expect(out.warnings).toEqual(['dry run; pass --yes --confirm demo to apply']);
    expect(out.text?.[0]).toBe("task 'demo': db rebuild plan (dry run, nothing moved)");
    expect(out.text?.join('\n')).toContain('data/monitor.db (396.0 KiB), data/monitor.db-wal (0 B)');
  });

  it('passes --yes and --confirm on and names the backup of an applied rebuild', async () => {
    const seen: DbRebuildInput[] = [];
    const cmd = makeCommand({
      rebuildDb: (_ctx, input) => {
        seen.push(input);
        const result: DbRebuildResult = {
          task: 'demo',
          applied: true,
          files: FILES,
          backup: '20261020T101500Z-db-rebuild',
          pruned: [],
        };
        return Promise.resolve(result);
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo', yes: true, confirm: 'demo' }));
    expect(seen).toEqual([{ task: 'demo', yes: true, confirm: 'demo' }]);
    expect(out.warnings).toEqual([]);
    expect(out.text?.[0]).toContain('moved the database to data/backups/20261020T101500Z-db-rebuild/');
    expect(out.text).toContain(
      'the next mcs start creates a new database and re-imports (this can take minutes for large transcripts)',
    );
    expect(out.text?.at(-1)).toBe(
      'the old database comes back with: mcs backup restore --task demo --id 20261020T101500Z-db-rebuild --yes',
    );
  });

  it('a task without a database has nothing to move and no warning', async () => {
    const result: DbRebuildResult = { task: 'demo', applied: false, files: [], backup: null, pruned: [] };
    const out = await makeCommand({ rebuildDb: () => Promise.resolve(result) }).run(
      contextOf({ task: 'demo', yes: true, confirm: 'demo' }),
    );
    expect(out.warnings).toEqual([]);
    expect(out.text?.[0]).toContain('has no database');
  });
});
