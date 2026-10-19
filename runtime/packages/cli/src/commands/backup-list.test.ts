// `backup list` (01 5.5, 6.3): the option table and the rendering of `ops.backup.list`; a backup that fails `--verify` is exit 1.
import type { BackupListInput, OpContext } from '@mcs/engine';
import type { BackupListResult } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './backup-list.ts';

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

function resultOf(verified: boolean | null): BackupListResult {
  return {
    task: 'demo',
    verify: verified !== null,
    backups: [
      {
        id: '20261020T101500Z-manual',
        reason: 'manual',
        createdAt: '2026-10-20T10:15:00Z',
        runtimeVersion: '4.0.0',
        dbSchemaVersion: 1,
        dbCopy: 'online',
        files: 4,
        bytes: 4096,
        verified,
        problems: verified === false ? ['monitor.db is missing'] : [],
      },
    ],
  };
}

describe('backup list command', () => {
  it('takes --task (required) and --verify', () => {
    expect(command.name).toBe('backup list');
    expect(Object.keys(command.options)).toEqual(['task', 'verify']);
    expect(command.options['task']).toMatchObject({ required: true });
    expect(command.options['verify']).toMatchObject({ type: 'boolean' });
  });

  it('passes the options on and renders the table', async () => {
    const seen: BackupListInput[] = [];
    const cmd = makeCommand({
      list: (_ctx, input) => {
        seen.push(input);
        return Promise.resolve(resultOf(null));
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo' }));
    expect(seen).toEqual([{ task: 'demo', verify: false }]);
    expect(out.exitCode).toBe(0);
    expect(out.text?.[0]).toMatch(/^id\s+reason\s+created\s+db\s+runtime\s+files\s+size$/);
    expect(out.text?.[1]).toMatch(
      /^20261020T101500Z-manual\s+manual\s+2026-10-20T10:15:00Z\s+v1 online\s+4\.0\.0\s+4\s+4\.0 KiB$/,
    );
  });

  it('--verify adds the column and a backup that fails it makes the exit code 1', async () => {
    const ok = await makeCommand({ list: () => Promise.resolve(resultOf(true)) }).run(
      contextOf({ task: 'demo', verify: true }),
    );
    expect(ok.exitCode).toBe(0);
    expect(ok.text?.[0]).toMatch(/verified$/);
    const bad = await makeCommand({ list: () => Promise.resolve(resultOf(false)) }).run(
      contextOf({ task: 'demo', verify: true }),
    );
    expect(bad.exitCode).toBe(1);
    expect(bad.text?.join('\n')).toContain('FAILED: monitor.db is missing');
  });
});
