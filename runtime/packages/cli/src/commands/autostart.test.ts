// `autostart enable|disable|status` (06 2.7): the three commands over the autostart operations of the engine (fake here; the
// shortcut itself is proven in the engine, ops/autostart.test.ts). The commands map the status to text lines and give the node
// that runs `enable`; they never build the shortcut.
import type { OpContext } from '@mcs/engine';
import { McsError, type AutostartStatus } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { autostartLines, disableCommand, enableCommand, makeCommands, statusCommand } from './autostart.ts';

function contextOf(): CommandContext {
  return {
    op: { repo: 'R', launcherPath: 'L' } as unknown as OpContext,
    args: {
      positionals: [],
      string: () => undefined,
      strings: () => [],
      flag: () => false,
      int: () => undefined,
    },
    scope: 'user',
    deps: {},
    json: false,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

// FIXTURE: invented data for tests
const SHORTCUT =
  'C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Claude Agent Workspace.lnk';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const ARGS = '"C:\\skills\\scripts\\caw.mjs" start --no-open';

const ON: AutostartStatus = {
  supported: true,
  enabled: true,
  shortcut: SHORTCUT,
  target: NODE,
  arguments: ARGS,
  targetExists: true,
  matchesLauncher: true,
  note: null,
};

const OFF: AutostartStatus = {
  supported: true,
  enabled: false,
  shortcut: null,
  target: null,
  arguments: null,
  targetExists: null,
  matchesLauncher: null,
  note: null,
};

const UNSUPPORTED: AutostartStatus = { ...OFF, supported: false, note: 'autostart is available on Windows only' };

describe('autostart commands: names and tables', () => {
  it('are three commands of the app, without options or arguments of their own', () => {
    expect(enableCommand.name).toBe('autostart enable');
    expect(disableCommand.name).toBe('autostart disable');
    expect(statusCommand.name).toBe('autostart status');
    for (const cmd of [enableCommand, disableCommand, statusCommand]) {
      expect(cmd.defaultScope).toBe('user');
      expect(cmd.userOnly).toBe(true);
      expect(cmd.options).toEqual({});
      expect(cmd.positionals).toBeUndefined();
      expect(cmd.synopsis).toBe('');
    }
  });
});

describe('autostartLines', () => {
  it('shows the state, the shortcut and what it runs (06 2.7)', () => {
    expect(autostartLines(ON)).toEqual(['autostart: on', `  shortcut: ${SHORTCUT}`, `  runs:     "${NODE}" ${ARGS}`]);
  });

  it('is one line when it is off', () => {
    expect(autostartLines(OFF)).toEqual(['autostart: off']);
  });

  it('says that the system is not supported', () => {
    expect(autostartLines(UNSUPPORTED)).toEqual(['autostart: not supported on this system']);
  });

  it('is on without a target when the shortcut could not be read', () => {
    expect(autostartLines({ ...ON, target: null, arguments: null })).toEqual([
      'autostart: on',
      `  shortcut: ${SHORTCUT}`,
    ]);
  });
});

describe('autostart status', () => {
  it('answers the status as data and as lines, exit 0', async () => {
    const seen: string[] = [];
    const cmds = makeCommands({
      autostartStatus: (_ctx, o) => {
        seen.push(o.launcherPath);
        return Promise.resolve(ON);
      },
      enableAutostart: () => Promise.reject(new Error('not called')),
      disableAutostart: () => Promise.reject(new Error('not called')),
    });
    const out = await cmds.status.run(contextOf());
    expect(seen).toEqual(['L']);
    expect(out.data).toEqual(ON);
    expect(out.text).toEqual(autostartLines(ON));
    expect(out.warnings ?? []).toEqual([]);
    expect(out.exitCode ?? 0).toBe(0);
  });

  it('turns the note of a stale shortcut into a warning line, not a failure', async () => {
    const note = 'the shortcut points to another launcher; run `caw autostart enable` to refresh it';
    const cmds = makeCommands({
      autostartStatus: () => Promise.resolve({ ...ON, matchesLauncher: false, note }),
      enableAutostart: () => Promise.reject(new Error('not called')),
      disableAutostart: () => Promise.reject(new Error('not called')),
    });
    const out = await cmds.status.run(contextOf());
    expect(out.warnings).toEqual([note]);
    expect(out.exitCode ?? 0).toBe(0);
  });

  it('answers exit 0 off Windows', async () => {
    const cmds = makeCommands({
      autostartStatus: () => Promise.resolve(UNSUPPORTED),
      enableAutostart: () => Promise.reject(new Error('not called')),
      disableAutostart: () => Promise.reject(new Error('not called')),
    });
    const out = await cmds.status.run(contextOf());
    expect(out.text).toEqual(['autostart: not supported on this system']);
    expect(out.exitCode ?? 0).toBe(0);
  });
});

describe('autostart enable', () => {
  it('gives the launcher of the call and the node that runs it, and says what happens at sign-in', async () => {
    const seen: { launcherPath: string; nodePath: string }[] = [];
    const cmds = makeCommands(
      {
        autostartStatus: () => Promise.reject(new Error('not called')),
        enableAutostart: (_ctx, o) => {
          seen.push(o);
          return Promise.resolve(ON);
        },
        disableAutostart: () => Promise.reject(new Error('not called')),
      },
      NODE,
    );
    const out = await cmds.enable.run(contextOf());
    expect(seen).toEqual([{ launcherPath: 'L', nodePath: NODE }]);
    expect(out.data).toEqual(ON);
    expect(out.text).toEqual([
      ...autostartLines(ON),
      'at sign-in the app starts in the background without a browser; run `caw open` for a login link',
    ]);
  });

  it('passes the refusal off Windows and the failure of the shortcut unchanged', async () => {
    const refusal = new McsError('UNSUPPORTED_PLATFORM', 'autostart is available on Windows only');
    const cmds = makeCommands({
      autostartStatus: () => Promise.reject(new Error('not called')),
      enableAutostart: () => Promise.reject(refusal),
      disableAutostart: () => Promise.reject(new Error('not called')),
    });
    await expect(cmds.enable.run(contextOf())).rejects.toBe(refusal);
  });
});

describe('autostart disable', () => {
  it('removes the shortcut and answers the status without one', async () => {
    const cmds = makeCommands({
      autostartStatus: () => Promise.reject(new Error('not called')),
      enableAutostart: () => Promise.reject(new Error('not called')),
      disableAutostart: () => Promise.resolve(OFF),
    });
    const out = await cmds.disable.run(contextOf());
    expect(out.data).toEqual(OFF);
    expect(out.text).toEqual(['autostart: off']);
  });
});
