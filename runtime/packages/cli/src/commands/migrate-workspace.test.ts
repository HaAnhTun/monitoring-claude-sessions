// `migrate-workspace` (ADR 0068, WP-140): the option table, what reaches the engine and the rendering, with a stub engine.
// The real command runs against workspaces in `test/migrate-workspace.int.test.ts`.
import type { OpContext, opsMigrate } from '@mcs/engine';
import { McsError } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './migrate-workspace.ts';

type Typed = Record<string, string | boolean>;
type Ops = Pick<typeof opsMigrate, 'plan' | 'apply'>;

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

type Report = opsMigrate.WorkspaceMigrationReport;

function report(slug: string, verdict: Report['verdict'], over: Partial<Report> = {}): Report {
  return {
    slug,
    verdict,
    mode: 'dry-run',
    actions: [],
    patterns: [],
    blockers: [],
    warnings: [],
    backup: null,
    ...over,
  };
}

function sweepOf(workspaces: Report[]): opsMigrate.MigrationSweep {
  const of = (verdict: Report['verdict']): number => workspaces.filter((w) => w.verdict === verdict).length;
  return {
    mode: 'dry-run',
    workspaces,
    skipped: [],
    counts: {
      total: workspaces.length,
      current: of('current'),
      needsMigration: of('needs-migration'),
      blocked: of('blocked'),
    },
  };
}

interface Seen {
  readonly op: 'plan' | 'apply';
  readonly input: unknown;
}

/** A stub engine: records the calls and answers with the given report and sweep. */
function stub(answer: { one?: Report; all?: opsMigrate.MigrationSweep }): { ops: Ops; seen: Seen[] } {
  const seen: Seen[] = [];
  const make = (op: 'plan' | 'apply') =>
    ((_ctx: OpContext, input: opsMigrate.MigrateInput) => {
      seen.push({ op, input });
      return Promise.resolve(
        input.all === true ? (answer.all ?? sweepOf([])) : (answer.one ?? report('demo', 'current')),
      );
    }) as unknown as Ops['plan'];
  return { ops: { plan: make('plan'), apply: make('apply') }, seen };
}

describe('migrate-workspace command', () => {
  it('takes --task, --all, --apply and --yes, none of them required', () => {
    expect(command.name).toBe('migrate-workspace');
    expect(Object.keys(command.options)).toEqual(['task', 'all', 'apply', 'yes']);
    for (const spec of Object.values(command.options)) expect(spec).not.toHaveProperty('required', true);
    expect(command.synopsis).toBe('(--task SLUG | --all) [--apply [--yes]]');
  });

  it('a single task: the dry run calls plan, --apply calls apply, the exit code follows the verdict', async () => {
    const { ops, seen } = stub({
      one: report('demo', 'blocked', { blockers: ['CONFIG_INVALID: x'], warnings: ['w'] }),
    });
    const cmd = makeCommand(ops);
    const dry = await cmd.run(contextOf({ task: 'demo' }));
    const applied = await cmd.run(contextOf({ task: 'demo', apply: true }));
    expect(seen).toEqual([
      { op: 'plan', input: { task: 'demo' } },
      { op: 'apply', input: { task: 'demo' } },
    ]);
    expect(dry.exitCode).toBe(1);
    expect(dry.warnings).toEqual(['w']);
    expect(dry.text).toEqual(["task 'demo': blocked (dry run, nothing written)", '  blocked: CONFIG_INVALID: x']);
    expect(applied.exitCode).toBe(1);
    const ok = await makeCommand(stub({ one: report('demo', 'current') }).ops).run(contextOf({ task: 'demo' }));
    expect(ok.exitCode).toBe(0);
  });

  it('without --task and without --all the engine is asked for an empty task, which it refuses as a usage error', async () => {
    const { ops, seen } = stub({});
    await makeCommand(ops).run(contextOf({}));
    expect(seen).toEqual([{ op: 'plan', input: { task: '' } }]);
  });

  it('--all calls the sweep, prints its lines and takes the exit code from the blocked count', async () => {
    const sweep = sweepOf([report('a', 'needs-migration'), report('b', 'blocked', { warnings: ['kept it'] })]);
    const { ops, seen } = stub({ all: sweep });
    const out = await makeCommand(ops).run(contextOf({ all: true }));
    expect(seen).toEqual([{ op: 'plan', input: { all: true } }]);
    expect(out.data).toBe(sweep);
    expect(out.exitCode).toBe(1);
    expect(out.warnings).toEqual(["task 'b': kept it"]);
    expect(out.text?.at(-2)).toBe(
      '2 task workspaces: 1 needing migration, 0 current, 1 blocked (dry run, nothing written)',
    );
    const clean = await makeCommand(stub({ all: sweepOf([report('a', 'current')]) }).ops).run(contextOf({ all: true }));
    expect(clean.exitCode).toBe(0);
  });

  it('--all --apply needs --yes: without it nothing reaches the engine and the error is a usage error with a hint', async () => {
    const { ops, seen } = stub({});
    const error = await makeCommand(ops)
      .run(contextOf({ all: true, apply: true }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McsError);
    expect((error as McsError).code).toBe('USAGE');
    expect((error as McsError).message).toBe(
      'migrate-workspace --all --apply converts every workspace and needs --yes',
    );
    expect((error as McsError).hint).toContain('--task SLUG --apply');
    expect(seen).toEqual([]);
  });

  it('--all --apply --yes calls apply for the sweep', async () => {
    const { ops, seen } = stub({});
    await makeCommand(ops).run(contextOf({ all: true, apply: true, yes: true }));
    expect(seen).toEqual([{ op: 'apply', input: { all: true } }]);
  });

  it('--all together with --task is a usage error and calls nothing', async () => {
    const { ops, seen } = stub({});
    for (const values of [
      { all: true, task: 'demo' },
      { all: true, task: 'demo', apply: true, yes: true },
    ]) {
      const error = await makeCommand(ops)
        .run(contextOf(values))
        .catch((e: unknown) => e);
      expect((error as McsError).code).toBe('USAGE');
    }
    expect(seen).toEqual([]);
  });

  it('--yes without --all changes nothing about a single-task call', async () => {
    const { ops, seen } = stub({});
    await makeCommand(ops).run(contextOf({ task: 'demo', apply: true, yes: true }));
    expect(seen).toEqual([{ op: 'apply', input: { task: 'demo' } }]);
  });
});
