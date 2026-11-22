// The guards of the user-instance harness (see SAFETY in `user-instance.ts`). Nothing here starts a process: the guards are pure
// checks of an environment, a port and an argument list, and the proof is run against a scripted CLI.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CliEnvelope } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { terminalEnv } from '../fake-claude/install.ts';
import type { CliResult } from '../processes.ts';
import { useTempDirs } from '../temp.ts';
import {
  HERMETIC_PATH_VARIABLES,
  PRODUCT_DEFAULT_PORT,
  assertHermeticEnv,
  assertSafeCliArgs,
  assertTempRoot,
  assertTestPort,
  killOwned,
  mentionsProductPort,
  proveHermetic,
  realPerUserFolders,
  type CliJsonResult,
} from './user-instance.ts';

const makeTemp = useTempDirs();
const REFUSAL = /refusing to act/;

/** The environment the harness builds for a root: every home variable below it, test mode on, the recorder in place. */
function sandboxEnv(root: string): Record<string, string> {
  return terminalEnv(root, null, {
    APPDATA: path.join(root, 'home', 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'home', 'AppData', 'Local'),
    MCS_TEST_OPEN_FILE: path.join(root, 'opened-urls.txt'),
  });
}

describe('killOwned', () => {
  const MARKER = 'mcs-user-app-FIXTURE1';
  const owned = (pid: number): { pid: number; name: string; commandLine: string } => ({
    pid,
    name: 'node.exe',
    commandLine: `node main.js serve --instance-dir=/tmp/${MARKER}/mcs-home/instances/user`,
  });

  it('kills every process of a scan whose command line carries the marker of the harness', () => {
    const killed: number[] = [];
    killOwned([owned(2_000_000_001), owned(2_000_000_002)], MARKER, (pid) => killed.push(pid));
    expect(killed).toEqual([2_000_000_001, 2_000_000_002]);
  });

  it('kills nothing at all when one entry does not carry the marker: a process the harness did not start', () => {
    const killed: number[] = [];
    const foreign = {
      pid: 2_000_000_003,
      name: 'node.exe',
      commandLine: 'node main.js serve --instance-dir=/home/user',
    };
    expect(() => {
      killOwned([owned(2_000_000_001), foreign], MARKER, (pid) => killed.push(pid));
    }).toThrow(/does not carry the marker of this harness/);
    expect(killed).toEqual([]);
  });

  it('never kills the process of the test run or its parent, whatever their command lines say', () => {
    const killed: number[] = [];
    for (const pid of [process.pid, process.ppid]) {
      expect(() => {
        killOwned([owned(pid)], MARKER, (target) => killed.push(target));
      }).toThrow(/the process of the test run itself/);
    }
    expect(killed).toEqual([]);
  });

  it('refuses a marker that is too short to be the name of a temp root', () => {
    const killed: number[] = [];
    expect(() => {
      killOwned([{ pid: 2_000_000_001, name: 'node.exe', commandLine: 'node' }], 'node', (pid) => killed.push(pid));
    }).toThrow(/too short/);
    expect(killed).toEqual([]);
  });
});

describe('assertTestPort', () => {
  it('refuses port 7690, the port of a real app, by name', () => {
    expect(PRODUCT_DEFAULT_PORT).toBe(7690);
    expect(() => {
      assertTestPort(7690);
    }).toThrow(/7690 is the port of a person's real app/);
  });

  it('refuses every port outside 18000-18999 and anything that is not a whole number', () => {
    for (const port of [0, 80, 7691, 8765, 17999, 19000, 65535, 18000.5, Number.NaN, -1]) {
      expect(() => {
        assertTestPort(port);
      }, String(port)).toThrow(REFUSAL);
    }
  });

  it('accepts the ends and the middle of the test range', () => {
    for (const port of [18000, 18500, 18999]) {
      expect(() => {
        assertTestPort(port);
      }).not.toThrow();
    }
  });
});

describe('mentionsProductPort', () => {
  it('finds the port where it stands as a number of its own', () => {
    for (const text of [
      'http://127.0.0.1:7690/',
      '{"configured_port": 7690,',
      '7690 was busy; using 7691',
      '  url:        http://127.0.0.1:7690/',
      'port 7690',
    ]) {
      expect(mentionsProductPort(text), text).toBe(true);
    }
  });

  it('does not take the same digits inside an instance id, a folder name or a longer number for the port', () => {
    for (const text of [
      '"instance_id": "0a1b7690-4e5f-4a6b-8c7d-9e0f1a2b3c4d"',
      '"instance_id": "0a1b2c3d-7690-4a6b-8c7d-9e0f1a2b3c4d"',
      'mcs-user-app-7690ab',
      'mcs-user-app-a7690',
      'pid 176901',
      'http://127.0.0.1:18042/',
    ]) {
      expect(mentionsProductPort(text), text).toBe(false);
    }
  });
});

describe('assertSafeCliArgs', () => {
  it('refuses 7690 and any other port outside the range wherever a call can name a port', () => {
    const unsafe: string[][] = [
      ['start', '--user', '--port', '7690'],
      ['start', '--port=7690'],
      ['restart', '--user', '--force', '--port', '8765'],
      ['config', 'set', 'server.port', '7690'],
      ['configure', '--user', '--set', 'server.port=7690'],
      ['configure', '--user', '--set=server.port=7691'],
      ['init', '--slug', 'a', '--port', '80'],
    ];
    for (const args of unsafe) {
      expect(() => {
        assertSafeCliArgs(args);
      }, args.join(' ')).toThrow(REFUSAL);
    }
  });

  it('accepts ports of the test range, calls without a port and a value the CLI will refuse itself', () => {
    const safe: string[][] = [
      ['start', '--user', '--no-open', '--json', '--port', '18042'],
      ['config', 'set', 'server.port', '18999'],
      ['configure', '--user', '--set', 'server.port=18000'],
      ['stop', '--user', '--force'],
      ['status', '--user', '--json'],
      ['start', '--port', 'abc'],
      ['config', 'set', 'server.portScan', '0'],
    ];
    for (const args of safe) {
      expect(() => {
        assertSafeCliArgs(args);
      }, args.join(' ')).not.toThrow();
    }
  });
});

describe('assertTempRoot', () => {
  it('accepts a root of makeTempDir', () => {
    expect(() => {
      assertTempRoot(makeTemp('guard-root').path);
    }).not.toThrow();
  });

  it('refuses the temp folder itself, a folder outside it and a relative path', () => {
    for (const root of [tmpdir(), path.dirname(tmpdir()), process.cwd(), 'relative/root']) {
      expect(() => {
        assertTempRoot(root);
      }, root).toThrow(REFUSAL);
    }
  });

  it('refuses a temp folder that makeTempDir did not make (no FIXTURE.md)', () => {
    const made = makeTemp('guard-plain').path;
    const plain = path.join(made, 'inner');
    mkdirSync(plain);
    expect(() => {
      assertTempRoot(plain);
    }).toThrow(/no FIXTURE.md marker/);
  });

  it('refuses a root that overlaps a real per-user folder', () => {
    const root = makeTemp('guard-overlap').path;
    expect(() => {
      assertTempRoot(root, [path.join(root, 'mcs')]);
    }).toThrow(/overlaps a real per-user folder/);
    expect(() => {
      assertTempRoot(root, [path.dirname(root)]);
    }).toThrow(/overlaps a real per-user folder/);
  });
});

describe('assertHermeticEnv', () => {
  it('accepts the environment the harness builds and returns the instance folder below the root', () => {
    const root = makeTemp('guard-env').path;
    expect(assertHermeticEnv(sandboxEnv(root), root)).toBe(path.join(root, 'mcs-home', 'instances', 'user'));
  });

  it.each(HERMETIC_PATH_VARIABLES)('refuses an environment without %s', (name) => {
    const root = makeTemp('guard-env').path;
    const env: Record<string, string | undefined> = { ...sandboxEnv(root), [name]: undefined };
    expect(() => assertHermeticEnv(env, root)).toThrow(new RegExp(`${name} is not set to an absolute path`));
  });

  it.each(HERMETIC_PATH_VARIABLES)('refuses %s outside the temp root, also in another temp root', (name) => {
    const root = makeTemp('guard-env').path;
    const other = makeTemp('guard-other').path;
    for (const outside of [path.join(other, 'x'), path.dirname(root), root]) {
      const env = { ...sandboxEnv(root), [name]: outside };
      expect(() => assertHermeticEnv(env, root), outside).toThrow(new RegExp(`${name} is not below the temp root`));
    }
  });

  it('refuses the real environment of this process (the one a person runs the app with)', () => {
    const root = makeTemp('guard-env').path;
    expect(() => assertHermeticEnv(process.env, root)).toThrow(REFUSAL);
  });

  it('refuses an environment whose instance folder lies in a real per-user folder', () => {
    const root = makeTemp('guard-env').path;
    const env = sandboxEnv(root);
    const real = [path.join(root, 'mcs-home')];
    // the root itself is checked first: a real folder inside it is an overlap
    expect(() => assertHermeticEnv(env, root, real)).toThrow(REFUSAL);
  });

  it('refuses test mode off, hooks on and a missing or outside browser recorder', () => {
    const root = makeTemp('guard-env').path;
    const env = sandboxEnv(root);
    expect(() => assertHermeticEnv({ ...env, MCS_TEST: '' }, root)).toThrow(/MCS_TEST is not 1/);
    expect(() => assertHermeticEnv({ ...env, MCS_TEST: undefined }, root)).toThrow(/MCS_TEST is not 1/);
    expect(() => assertHermeticEnv({ ...env, MCS_HOOK_DISABLE: '0' }, root)).toThrow(/MCS_HOOK_DISABLE is not 1/);
    expect(() => assertHermeticEnv({ ...env, MCS_TEST_OPEN_FILE: undefined }, root)).toThrow(/MCS_TEST_OPEN_FILE/);
    expect(() => assertHermeticEnv({ ...env, MCS_TEST_OPEN_FILE: path.join(tmpdir(), 'x.txt') }, root)).toThrow(
      /MCS_TEST_OPEN_FILE/,
    );
  });
});

describe('realPerUserFolders', () => {
  it('names the folder the product resolves from each kind of environment', () => {
    const base = path.resolve('/fixture-profile');
    const local = path.join(base, 'AppData', 'Local');
    expect(realPerUserFolders({ LOCALAPPDATA: local })).toContain(path.join(local, 'mcs'));
    expect(realPerUserFolders({ USERPROFILE: base })).toContain(path.join(base, 'AppData', 'Local', 'mcs'));
    expect(realPerUserFolders({ HOME: base })).toContain(path.join(base, '.local', 'state', 'mcs'));
    expect(realPerUserFolders({ XDG_STATE_HOME: base })).toContain(path.join(base, 'mcs'));
    expect(realPerUserFolders({ MCS_HOME: base })).toContain(base);
    expect(realPerUserFolders({ LOCALAPPDATA: 'relative' })).not.toContain(path.join('relative', 'mcs'));
  });
});

// ---- the proof against a scripted CLI ---------------------------------------------------------------------------------------------

interface ScriptedStatus {
  readonly code: number;
  readonly stdout: string;
  readonly data: Record<string, unknown>;
}

function envelopeOf(data: unknown, exitCode: number): CliEnvelope<unknown> {
  return {
    schema: 'mcs.cli/1',
    command: 'status',
    ok: exitCode === 0,
    exitCode,
    data,
    error: null,
    warnings: [],
  } as CliEnvelope<unknown>;
}

function scriptedSandbox(root: string, status: ScriptedStatus) {
  const calls: string[][] = [];
  const text: CliResult = { code: status.code, stdout: status.stdout, stderr: '' };
  return {
    calls,
    root,
    runCli: (args: readonly string[]): Promise<CliResult> => {
      calls.push([...args]);
      return Promise.resolve(text);
    },
    runJson: (args: readonly string[]): Promise<CliJsonResult> => {
      calls.push([...args]);
      return Promise.resolve({
        code: status.code,
        stdout: JSON.stringify(status.data),
        stderr: '',
        envelope: envelopeOf(status.data, status.code),
      });
    },
  };
}

function stoppedStatus(root: string): ScriptedStatus {
  const dir = path.join(root, 'mcs-home', 'instances', 'user');
  return {
    code: 1,
    stdout: [
      'Claude Agent Workspace: not running',
      '  hint:       never started: run `caw start`',
      '  autostart:  off',
      `  folder:     ${dir}`,
      `  logs:       ${path.join(dir, 'logs')}`,
      '',
    ].join('\n'),
    data: { scope: 'user', running: false, state_file: path.join(dir, 'state.json'), home: dir, configured_port: 7690 },
  };
}

describe('proveHermetic', () => {
  it('passes for a stopped instance below the root and only ever runs the read-only status', async () => {
    const root = makeTemp('guard-proof').path;
    const sandbox = scriptedSandbox(root, stoppedStatus(root));
    await expect(proveHermetic(sandbox)).resolves.toBeUndefined();
    expect(sandbox.calls).toEqual([
      ['status', '--user'],
      ['status', '--user', '--json'],
    ]);
  });

  it('refuses when the status says the app is running', async () => {
    const root = makeTemp('guard-proof').path;
    const good = stoppedStatus(root);
    const running = {
      ...good,
      code: 0,
      stdout: good.stdout.replace(': not running', ' 4.0.0: running'),
    };
    await expect(proveHermetic(scriptedSandbox(root, running))).rejects.toThrow(/does not say "not running"/);
  });

  it('refuses when the status mentions port 7690', async () => {
    const root = makeTemp('guard-proof').path;
    const good = stoppedStatus(root);
    const mentions = { ...good, stdout: `${good.stdout}  url:        http://127.0.0.1:7690/\n` };
    await expect(proveHermetic(scriptedSandbox(root, mentions))).rejects.toThrow(/mentions port 7690/);
  });

  it('refuses when the folder of the status is not below the root', async () => {
    const root = makeTemp('guard-proof').path;
    const elsewhere = makeTemp('guard-elsewhere').path;
    await expect(proveHermetic(scriptedSandbox(root, stoppedStatus(elsewhere)))).rejects.toThrow(
      /does not name a folder below the temp root/,
    );
  });

  it('refuses when the status names a real per-user folder', async () => {
    const root = makeTemp('guard-proof').path;
    const [real] = realPerUserFolders();
    if (real === undefined) throw new Error('this host resolves no per-user folder');
    const good = stoppedStatus(root);
    const names = { ...good, stdout: `${good.stdout}  folder:     ${path.join(real, 'instances', 'user')}\n` };
    await expect(proveHermetic(scriptedSandbox(root, names))).rejects.toThrow(/names a real per-user folder/);
  });

  it('refuses when the JSON report has a pid, an address or a state file outside the root', async () => {
    const root = makeTemp('guard-proof').path;
    const good = stoppedStatus(root);
    const variants: Record<string, unknown>[] = [
      { ...good.data, pid: 4242 },
      { ...good.data, url: 'http://127.0.0.1:18001' },
      { ...good.data, running: true },
      { ...good.data, state_file: path.join(tmpdir(), 'state.json') },
      { ...good.data, home: path.dirname(root) },
    ];
    for (const data of variants) {
      await expect(proveHermetic(scriptedSandbox(root, { ...good, data }))).rejects.toThrow(
        /does not report a stopped instance below the temp root/,
      );
    }
  });
});
