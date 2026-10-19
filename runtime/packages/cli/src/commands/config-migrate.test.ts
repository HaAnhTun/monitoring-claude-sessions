// `config migrate` (01 2.7): the option table and the rendering of `ops.config.migrate`; without --yes it is a dry run.
import type { ConfigMigrateInput, OpContext } from '@mcs/engine';
import type { ConfigMigrateResult } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './config-migrate.ts';

type Typed = Record<string, string | boolean>;

function contextOf(values: Typed, deps: CommandContext['deps'] = {}): CommandContext {
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
    deps,
    json: false,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

const FILES: ConfigMigrateResult['files'] = [
  { file: 'config.json', version: 1 },
  { file: 'instance.json', version: 1 },
];

function resultOf(over: Partial<ConfigMigrateResult>): ConfigMigrateResult {
  return {
    task: 'demo',
    outcome: 'current',
    files: FILES,
    steps: [],
    backup: null,
    restartNeeded: false,
    pruned: [],
    ...over,
  };
}

const STEP = { file: 'config.json', from: 1, to: 2, describe: 'FIXTURE step' } as const;

describe('config migrate command', () => {
  it('takes --task (required), --dry-run and --yes', () => {
    expect(command.name).toBe('config migrate');
    expect(Object.keys(command.options)).toEqual(['task', 'dry-run', 'yes']);
    expect(command.options['task']).toMatchObject({ required: true });
  });

  it('nothing pending says already current', async () => {
    const seen: ConfigMigrateInput[] = [];
    const cmd = makeCommand({
      migrate: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(resultOf({}));
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo' }));
    expect(seen).toEqual([{ task: 'demo', yes: false, dryRun: false }]);
    expect(out.warnings).toEqual([]);
    expect(out.text).toEqual(['already current: nothing to migrate (config.json v1, instance.json v1)']);
  });

  it('a dry run lists the steps, the backup and the flag that applies them', async () => {
    const cmd = makeCommand({ migrate: () => Promise.resolve(resultOf({ outcome: 'dry-run', steps: [STEP] })) });
    const out = await cmd.run(contextOf({ task: 'demo' }));
    expect(out.warnings).toEqual(['dry run; pass --yes to apply']);
    expect(out.text).toEqual([
      "task 'demo': config migrate plan (dry run, nothing written)",
      '  config.json: v1 -> v2 (FIXTURE step)',
      '  backup first: data/backups/<UTC stamp>-config-migrate/',
      'run again with --yes to apply',
    ]);
  });

  it('an applied run names the backup and hands the running check of the process on', async () => {
    const seen: ConfigMigrateInput[] = [];
    let asked = 0;
    const cmd = makeCommand({
      migrate: (_ctx, input, deps) => {
        seen.push(input);
        if (deps?.isRunning !== undefined) asked += 1;
        return Promise.resolve(
          resultOf({
            outcome: 'migrated',
            steps: [STEP],
            backup: '20261020T101500Z-config-migrate',
            restartNeeded: true,
          }),
        );
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo', yes: true }, { isRunning: () => Promise.resolve(true) }));
    expect(seen).toEqual([{ task: 'demo', yes: true, dryRun: false }]);
    expect(asked).toBe(1);
    expect(out.warnings).toEqual([]);
    expect(out.text).toContain('backup: data/backups/20261020T101500Z-config-migrate/');
    expect(out.text).toContain('restart the server (mcs restart) to read the migrated files');
  });
});
