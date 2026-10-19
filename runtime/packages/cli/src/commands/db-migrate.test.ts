// `db migrate` (01 5.4, 6.3): the option table and the rendering of `ops.instanceUpgrade.migrateDb`; without --yes it is a dry run.
import type { DbMigrateInput, OpContext } from '@mcs/engine';
import type { DbMigrateResult } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './db-migrate.ts';

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

const PLAN = { from: 1, to: 2, steps: [{ version: 2, name: 'probe_table' }] };

describe('db migrate command', () => {
  it('takes --task (required), --dry-run and --yes', () => {
    expect(command.name).toBe('db migrate');
    expect(Object.keys(command.options)).toEqual(['task', 'dry-run', 'yes']);
    expect(command.options['task']).toMatchObject({ required: true });
  });

  it('a dry run lists the steps and warns', async () => {
    const seen: DbMigrateInput[] = [];
    const cmd = makeCommand({
      migrateDb: (_ctx, input) => {
        seen.push(input);
        const result: DbMigrateResult = {
          task: 'demo',
          outcome: 'dry-run',
          db: PLAN,
          backup: null,
          integrity: null,
          pruned: [],
        };
        return Promise.resolve(result);
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo' }));
    expect(seen).toEqual([{ task: 'demo', yes: false, dryRun: false }]);
    expect(out.warnings).toEqual(['dry run; pass --yes to apply']);
    expect(out.text?.[0]).toBe("task 'demo': db migrate plan (dry run, nothing written)");
    expect(out.text?.[1]).toBe('  database: schema 1 -> 2 (0002 probe_table)');
  });

  it('an applied migration names the backup and the integrity check', async () => {
    const result: DbMigrateResult = {
      task: 'demo',
      outcome: 'migrated',
      db: PLAN,
      backup: '20261020T101500Z-upgrade',
      integrity: 'ok',
      pruned: [],
    };
    const out = await makeCommand({ migrateDb: () => Promise.resolve(result) }).run(
      contextOf({ task: 'demo', yes: true }),
    );
    expect(out.warnings).toEqual([]);
    expect(out.text).toEqual([
      "migrated task 'demo': db schema 1 -> 2 (0002 probe_table)",
      'backup: data/backups/20261020T101500Z-upgrade/',
      'integrity: ok',
    ]);
  });

  it('says so when there is nothing to migrate', async () => {
    const none: DbMigrateResult = {
      task: 'demo',
      outcome: 'no-database',
      db: null,
      backup: null,
      integrity: null,
      pruned: [],
    };
    const current: DbMigrateResult = {
      task: 'demo',
      outcome: 'current',
      db: { from: 2, to: 2, steps: [] },
      backup: null,
      integrity: null,
      pruned: [],
    };
    expect(
      (await makeCommand({ migrateDb: () => Promise.resolve(none) }).run(contextOf({ task: 'demo' }))).text,
    ).toEqual(["task 'demo' has no database yet; the first start creates it at the current schema"]);
    expect(
      (await makeCommand({ migrateDb: () => Promise.resolve(current) }).run(contextOf({ task: 'demo' }))).text,
    ).toEqual(['already current: db schema 2']);
  });
});
