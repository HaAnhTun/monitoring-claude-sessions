// The kernel of the CLI (01 6.2): Ctrl+C ends a command with exit code 130 unless the command owns the signal itself
// (`interruptible: 'command'`, the way `serve` forwards it to the server).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main, type CommandDefinition, type MainPaths } from './main.ts';

const probe = vi.hoisted(() => ({
  /** The SIGINT listeners that were added since the test started, as seen from inside each fake command. */
  inside: new Map<string, NodeJS.SignalsListener[]>(),
  baseline: [] as NodeJS.SignalsListener[],
}));

function listenersAddedSince(): NodeJS.SignalsListener[] {
  return process.listeners('SIGINT').filter((listener) => !probe.baseline.includes(listener));
}

vi.mock('./commands/serve.ts', () => ({
  command: {
    name: 'serve',
    summary: 'fake serve',
    synopsis: '',
    options: {},
    interruptible: 'command',
    run: () => {
      probe.inside.set('serve', listenersAddedSince());
      return Promise.resolve({ data: {}, text: [] });
    },
  } satisfies CommandDefinition,
}));

vi.mock('./commands/discover.ts', () => ({
  command: {
    name: 'discover',
    summary: 'fake discover',
    synopsis: '',
    options: {},
    run: () => {
      probe.inside.set('discover', listenersAddedSince());
      return Promise.resolve({ data: {}, text: [] });
    },
  } satisfies CommandDefinition,
}));

const PATHS: MainPaths = { launcherPath: 'launcher', skillDir: 'skill', runtimeDir: 'runtime' };

afterEach(() => {
  probe.inside.clear();
  vi.restoreAllMocks();
});

function begin(): void {
  probe.baseline = process.listeners('SIGINT');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

describe('main: who owns Ctrl+C', () => {
  it('registers the kernel listener for a command that does not say otherwise, and exits 130 on SIGINT', async () => {
    begin();
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
    expect(await main(['discover', '--json'], PATHS)).toBe(0);
    const inside = probe.inside.get('discover') ?? [];
    expect(inside).toHaveLength(1);
    inside[0]?.('SIGINT');
    expect(exit).toHaveBeenCalledWith(130);
    expect(listenersAddedSince()).toEqual([]);
  });

  it("leaves SIGINT to a command that declares interruptible 'command'", async () => {
    begin();
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
    expect(await main(['serve', '--json'], PATHS)).toBe(0);
    expect(probe.inside.get('serve')).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
    expect(listenersAddedSince()).toEqual([]);
  });

  it('does not touch the listeners that were there before the call', async () => {
    const other = (): void => undefined;
    process.on('SIGINT', other);
    try {
      begin();
      await main(['serve', '--json'], PATHS);
      expect(process.listeners('SIGINT')).toContain(other);
    } finally {
      process.off('SIGINT', other);
    }
  });
});
