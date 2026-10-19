// `upgrade` (01 5.4, 6.3): the option table and the rendering of `ops.instanceUpgrade.run`; without --yes it is a dry run.
import type { OpContext, UpgradeInput } from '@mcs/engine';
import type { UpgradeResult } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './upgrade.ts';

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

function resultOf(outcome: UpgradeResult['outcome'], over: Partial<UpgradeResult> = {}): UpgradeResult {
  return {
    task: 'demo',
    outcome,
    plan: {
      runtimeFrom: '3.0.0',
      runtimeTo: '4.0.0',
      db: { from: 1, to: 2, steps: [{ version: 2, name: 'probe_table' }] },
      files: [],
      needed: outcome !== 'current',
      backup: outcome === 'current' ? null : 'data/backups/20261020T101500Z-upgrade/',
    },
    backup: outcome === 'upgraded' ? '20261020T101500Z-upgrade' : null,
    integrity: outcome === 'upgraded' ? 'ok' : null,
    restart: null,
    pruned: [],
    exitCode: 0,
    ...over,
  };
}

describe('upgrade command', () => {
  it('takes --task (required), --dry-run, --yes and --restart', () => {
    expect(command.name).toBe('upgrade');
    expect(Object.keys(command.options)).toEqual(['task', 'dry-run', 'yes', 'restart']);
    expect(command.options['task']).toMatchObject({ required: true });
  });

  it('a dry run prints the plan and warns', async () => {
    const seen: UpgradeInput[] = [];
    const cmd = makeCommand({
      run: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(resultOf('dry-run'));
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo' }));
    expect(seen).toEqual([{ task: 'demo', yes: false, dryRun: false, restart: false }]);
    expect(out.warnings).toEqual(['dry run; pass --yes to apply']);
    expect(out.exitCode).toBe(0);
    expect(out.text).toEqual([
      "task 'demo': upgrade plan (dry run, nothing written)",
      '  runtime: 3.0.0 -> 4.0.0',
      '  database: schema 1 -> 2 (0002 probe_table)',
      '  files: none',
      '  backup first: data/backups/20261020T101500Z-upgrade/',
    ]);
  });

  it('an applied upgrade names the backup and the integrity check; --restart shows what happened to the server', async () => {
    const seen: UpgradeInput[] = [];
    const cmd = makeCommand({
      run: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(
          resultOf('upgraded', { restart: { stopped: true, started: true, url: 'http://127.0.0.1:18002', pid: 5151 } }),
        );
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo', yes: true, restart: true }));
    expect(seen).toEqual([{ task: 'demo', yes: true, dryRun: false, restart: true }]);
    expect(out.warnings).toEqual([]);
    expect(out.text).toEqual([
      "upgraded task 'demo': runtime 3.0.0 -> 4.0.0; database: schema 1 -> 2 (0002 probe_table)",
      'backup: data/backups/20261020T101500Z-upgrade/',
      'integrity: ok',
      'stopped the running server first',
      'started: http://127.0.0.1:18002 (pid 5151)',
    ]);
  });

  it('already current is one line; a start that did not come up is exit code 1', async () => {
    const current = await makeCommand({ run: () => Promise.resolve(resultOf('current')) }).run(
      contextOf({ task: 'demo' }),
    );
    expect(current.text).toEqual(['already current: runtime 4.0.0, db schema 2']);
    const failed = await makeCommand({
      run: () =>
        Promise.resolve(
          resultOf('upgraded', { exitCode: 1, restart: { stopped: false, started: false, url: null, pid: null } }),
        ),
    }).run(contextOf({ task: 'demo', yes: true, restart: true }));
    expect(failed.exitCode).toBe(1);
    expect(failed.text?.at(-1)).toBe('the server was not started');
  });
});
