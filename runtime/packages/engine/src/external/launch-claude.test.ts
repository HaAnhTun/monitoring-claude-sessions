// T-HK-15 (02 2.12): child Claude sessions started by monitor tooling are never observed by the monitor itself.
import { describe, expect, it } from 'vitest';

import { DISABLE_ALL_HOOKS_SETTINGS, claudeArgsWithoutHooks } from './launch-claude.ts';

describe('claudeArgsWithoutHooks (T-HK-15)', () => {
  it('prepends --settings with disableAllHooks:true and keeps the caller arguments in order', () => {
    const { args } = claudeArgsWithoutHooks(['-p', 'hello', '--output-format', 'json']);
    expect(args.slice(0, 2)).toEqual(['--settings', DISABLE_ALL_HOOKS_SETTINGS]);
    expect(args.slice(2)).toEqual(['-p', 'hello', '--output-format', 'json']);
    expect(JSON.parse(args[1] ?? '')).toEqual({ disableAllHooks: true });
  });

  it('returns MCS_HOOK_DISABLE=1 as the environment to merge over the child environment', () => {
    expect(claudeArgsWithoutHooks([]).env).toEqual({ MCS_HOOK_DISABLE: '1' });
  });

  it('does not change the input and returns fresh arrays and objects', () => {
    const input = ['-p', 'x'] as const;
    const first = claudeArgsWithoutHooks(input);
    const second = claudeArgsWithoutHooks(input);
    expect([...input]).toEqual(['-p', 'x']);
    expect(first.args).not.toBe(second.args);
    expect(first.env).not.toBe(second.env);
    first.env['MCS_HOOK_DISABLE'] = '0';
    expect(claudeArgsWithoutHooks([]).env['MCS_HOOK_DISABLE']).toBe('1');
  });

  it('is idempotent: arguments that already carry the setting are not prefixed twice', () => {
    const once = claudeArgsWithoutHooks(['-p', 'x']);
    const twice = claudeArgsWithoutHooks(once.args);
    expect(twice.args).toEqual(once.args);
  });

  it('keeps a caller-owned --settings argument after ours', () => {
    const { args } = claudeArgsWithoutHooks(['--settings', 'other.json', '-p', 'x']);
    expect(args).toEqual(['--settings', DISABLE_ALL_HOOKS_SETTINGS, '--settings', 'other.json', '-p', 'x']);
  });
});
