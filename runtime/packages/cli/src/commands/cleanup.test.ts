// `cleanup` (01 6.4): the option table and the rendering of `ops.cleanup.run`; every scope is a dry run without --yes.
import type { CleanupInput, OpContext } from '@mcs/engine';
import type { CleanupResult } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './cleanup.ts';

type Typed = Record<string, string | boolean | number>;

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
        const v = values[name];
        return typeof v === 'number' ? v : undefined;
      },
    },
    deps: {},
    json: false,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

function resultOf(over: Partial<CleanupResult> = {}): CleanupResult {
  return {
    task: 'demo',
    scope: 'logs',
    applied: false,
    targets: [{ path: 'logs/runtime.log.1', bytes: 2048 }],
    skipped: [],
    count: 1,
    bytes: 2048,
    remaining: [],
    backup: null,
    data: null,
    pruned: [],
    note: null,
    ...over,
  };
}

describe('cleanup command', () => {
  it('takes --scope (required, six choices), --task, --older-than, --keep, --dry-run, --yes and --confirm', () => {
    expect(command.name).toBe('cleanup');
    expect(Object.keys(command.options)).toEqual(['scope', 'task', 'older-than', 'keep', 'dry-run', 'yes', 'confirm']);
    expect(command.options['scope']).toMatchObject({ required: true });
    expect(command.options['scope']?.choices).toEqual([
      'stale-state',
      'init-leftovers',
      'logs',
      'backups',
      'spool',
      'data',
    ]);
    expect(command.options['older-than']).toMatchObject({ integer: [1, 36500] });
    expect(command.options['keep']).toMatchObject({ integer: [0, 1000] });
  });

  it('a dry run passes only what was given, lists the targets and names --yes', async () => {
    const seen: CleanupInput[] = [];
    const cmd = makeCommand({
      run: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(resultOf());
      },
    });
    const out = await cmd.run(contextOf({ scope: 'logs', task: 'demo', 'older-than': 7 }));
    expect(seen).toEqual([{ scope: 'logs', task: 'demo', olderThanDays: 7, yes: false, dryRun: false }]);
    expect(out.warnings).toEqual(['dry run; pass --yes to apply']);
    expect(out.exitCode).toBe(0);
    expect(out.text?.[0]).toBe("cleanup --scope logs on task 'demo' (dry run, nothing deleted)");
    expect(out.text?.join('\n')).toContain('logs/runtime.log.1 (2.0 KiB)');
    expect(out.text?.at(-1)).toBe('run again with --yes to apply');
  });

  it('the data scope names --confirm with the task in the warning', async () => {
    const cmd = makeCommand({
      run: () =>
        Promise.resolve(
          resultOf({
            scope: 'data',
            targets: [],
            count: 3,
            bytes: 0,
            data: {
              sessions: 3,
              sessionsBefore: '2026-09-20T12:00:00Z',
              eventsBefore: null,
              rows: { events: 40, turns: 0 },
              reownedMessages: 0,
              freedBytes: null,
            },
          }),
        ),
    });
    const out = await cmd.run(contextOf({ scope: 'data', task: 'demo', 'older-than': 30 }));
    expect(out.warnings).toEqual(['dry run; pass --yes --confirm demo to apply']);
    const text = out.text?.join('\n') ?? '';
    expect(text).toContain('would delete 3 sessions with the last activity before 2026-09-20T12:00:00Z');
    expect(text).toContain('rows that go with them: events 40');
    expect(text).toContain('active and pinned sessions are never deleted');
    expect(text).toContain('run again with --yes --confirm demo to apply');
  });

  it('an applied run lists what was deleted and confirms that it is gone', async () => {
    const seen: CleanupInput[] = [];
    const cmd = makeCommand({
      run: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(resultOf({ applied: true }));
      },
    });
    const out = await cmd.run(contextOf({ scope: 'logs', task: 'demo', yes: true }));
    expect(seen[0]).toMatchObject({ yes: true });
    expect(out.warnings).toEqual([]);
    expect(out.exitCode).toBe(0);
    expect(out.text).toContain('  checked: none of the targets is still there');
  });

  it('a target that is still there after the deletion is exit code 1 and not confirmed', async () => {
    const cmd = makeCommand({
      run: () => Promise.resolve(resultOf({ applied: true, remaining: ['logs/runtime.log.1'] })),
    });
    const out = await cmd.run(contextOf({ scope: 'logs', task: 'demo', yes: true }));
    expect(out.exitCode).toBe(1);
    expect(out.text?.at(-1)).toContain('NOT confirmed: still present after the deletion: logs/runtime.log.1');
  });

  it('shows what was left alone, with the reason, and truncates a long list', async () => {
    const targets = Array.from({ length: 25 }, (_, i) => ({ path: `logs/runtime.log.${String(i)}`, bytes: 1 }));
    const cmd = makeCommand({
      run: () =>
        Promise.resolve(
          resultOf({
            targets,
            count: 25,
            bytes: 25,
            skipped: [{ path: 'logs/evil.log.1', reason: 'is a link; links are never followed or deleted' }],
          }),
        ),
    });
    const text = (await cmd.run(contextOf({ scope: 'logs', task: 'demo' }))).text?.join('\n') ?? '';
    expect(text).toContain('... and 5 more');
    expect(text).toContain('logs/evil.log.1 (is a link; links are never followed or deleted)');
  });

  it('init-leftovers names the tasks root and passes no task', async () => {
    const seen: CleanupInput[] = [];
    const cmd = makeCommand({
      run: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(resultOf({ task: null, scope: 'init-leftovers', targets: [], count: 0, bytes: 0 }));
      },
    });
    const out = await cmd.run(contextOf({ scope: 'init-leftovers' }));
    expect(seen).toEqual([{ scope: 'init-leftovers', yes: false, dryRun: false }]);
    expect(out.text?.[0]).toBe('cleanup --scope init-leftovers on the tasks root (dry run, nothing deleted)');
    expect(out.text).toContain('  nothing to delete');
    expect(out.warnings).toEqual([]);
  });
});
