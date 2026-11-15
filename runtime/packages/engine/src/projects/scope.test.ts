// The scope helpers (CAW design 03 2.1, 2.6, D11): which projects an instance reads, whether the sessions that no rule matched
// are listed, which panels are on. The kind is a plain parameter, tested with literals; `instanceKindOfConfig` reads it from the
// `instance.json` next to the resolved configuration.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { InstanceKind } from '@mcs/shared';
import { PANEL_CONFIG_KEY } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { initWorkspace } from '../workspace/init.ts';
import {
  effectivePanels,
  instanceKindOfConfig,
  isAllScope,
  projectsRootOf,
  unmatchedVisible,
  type ScopeConfig,
} from './scope.ts';

const makeTemp = useTempDirs();
const KINDS: readonly InstanceKind[] = ['task', 'user'];

function config(scope: ScopeConfig['runtime']['projects']['scope'], includeUnmatched: boolean): ScopeConfig {
  return { monitor: { include_unmatched: includeUnmatched }, runtime: { projects: { scope } } };
}

describe('isAllScope', () => {
  it('reads every project when the key says all, whatever the kind', () => {
    for (const kind of KINDS) expect(isAllScope('all', kind)).toBe(true);
  });

  it('reads the repository when the key says repo, whatever the kind', () => {
    for (const kind of KINDS) expect(isAllScope('repo', kind)).toBe(false);
  });

  it('follows the kind for auto: all projects for the user instance, the repository for a task', () => {
    expect(isAllScope('auto', 'user')).toBe(true);
    expect(isAllScope('auto', 'task')).toBe(false);
  });
});

describe('projectsRootOf', () => {
  it('is the projects folder of the Claude home', () => {
    const home = path.join(path.sep, 'home', 'me', '.claude');
    expect(projectsRootOf(home)).toBe(path.join(home, 'projects'));
  });
});

describe('unmatchedVisible', () => {
  it('hides the sessions no rule matched on a task instance, as before', () => {
    expect(unmatchedVisible(config('auto', false), 'task', {})).toBe(false);
    expect(unmatchedVisible(config('repo', false), 'task', {})).toBe(false);
    expect(unmatchedVisible(config('repo', false), 'user', {})).toBe(false);
    expect(unmatchedVisible(config('auto', false), 'task', { includeUnmatched: false })).toBe(false);
  });

  it('shows them when the monitor setting or the request says so', () => {
    expect(unmatchedVisible(config('auto', true), 'task', {})).toBe(true);
    expect(unmatchedVisible(config('repo', false), 'task', { includeUnmatched: true })).toBe(true);
    expect(unmatchedVisible(config('repo', true), 'task', { includeUnmatched: false })).toBe(true);
  });

  it('shows them in the scope all, which has no rules for most of its projects', () => {
    expect(unmatchedVisible(config('all', false), 'task', {})).toBe(true);
    expect(unmatchedVisible(config('auto', false), 'user', {})).toBe(true);
    expect(unmatchedVisible(config('auto', false), 'user', { includeUnmatched: false })).toBe(true);
  });
});

describe('effectivePanels', () => {
  const ALL_ON: Record<string, boolean> = {
    [PANEL_CONFIG_KEY.git]: true,
    [PANEL_CONFIG_KEY.machine]: true,
    [PANEL_CONFIG_KEY.attempts]: true,
    [PANEL_CONFIG_KEY.ledger]: true,
    [PANEL_CONFIG_KEY.chainLog]: true,
    [PANEL_CONFIG_KEY.logs]: true,
  };

  it('leaves the panels of a task instance as configured', () => {
    expect(effectivePanels(ALL_ON, 'task')).toEqual(ALL_ON);
    expect(effectivePanels({ git: false, machine: true }, 'task')).toEqual({ git: false, machine: true });
  });

  it('turns the per-repository panels off for the user instance and keeps machine and logs', () => {
    expect(effectivePanels(ALL_ON, 'user')).toEqual({
      git: false,
      machine: true,
      attempts: false,
      ledger: false,
      chain_log: false,
      logs: true,
    });
  });

  it('keeps a panel that is off, off, and does not touch the configuration it was given', () => {
    const given = { git: true, machine: false, logs: false };
    expect(effectivePanels(given, 'user')).toEqual({
      git: false,
      machine: false,
      logs: false,
      attempts: false,
      ledger: false,
      chain_log: false,
    });
    expect(given).toEqual({ git: true, machine: false, logs: false });
  });
});

describe('instanceKindOfConfig', () => {
  async function workspace(kind: InstanceKind | undefined): Promise<string> {
    const root = makeTemp('scope-kind').path;
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    const { ws } = await initWorkspace({
      repo,
      name: 'Demo',
      slug: 'demo',
      clock: new FakeClock(Date.UTC(2026, 10, 15)),
      ...(kind === undefined ? {} : { kind }),
    });
    return ws.dir;
  }

  const filesOf = (dir: string): { name: string; path: string }[] => [
    { name: 'defaults.json', path: path.join(dir, '..', 'defaults.json') },
    { name: 'config.json', path: path.join(dir, 'config.json') },
  ];

  it('reads the kind of the workspace next to config.json', async () => {
    expect(instanceKindOfConfig({ files: filesOf(await workspace('user')) })).toBe('user');
    expect(instanceKindOfConfig({ files: filesOf(await workspace('task')) })).toBe('task');
    expect(instanceKindOfConfig({ files: filesOf(await workspace(undefined)) })).toBe('task');
  });

  it('is a task without a workspace file, without instance.json or with a damaged one', () => {
    expect(instanceKindOfConfig({ files: [] })).toBe('task');
    const dir = makeTemp('scope-kind-none').path;
    expect(instanceKindOfConfig({ files: [{ name: 'config.json', path: path.join(dir, 'config.json') }] })).toBe(
      'task',
    );
    const damaged = makeTemp('scope-kind-bad').path;
    writeFileSync(path.join(damaged, 'instance.json'), '{"kind": "user"');
    expect(instanceKindOfConfig({ files: [{ name: 'config.json', path: path.join(damaged, 'config.json') }] })).toBe(
      'task',
    );
  });

  it('answers again from memory for the same configuration object', async () => {
    const dir = await workspace('user');
    const resolved = { files: filesOf(dir) };
    expect(instanceKindOfConfig(resolved)).toBe('user');
    // the answer of one configuration does not change under it: the kind of an instance is fixed for the life of the process
    writeFileSync(path.join(dir, 'instance.json'), '{}');
    expect(instanceKindOfConfig(resolved)).toBe('user');
    expect(instanceKindOfConfig({ files: filesOf(dir) })).toBe('task');
  });
});
