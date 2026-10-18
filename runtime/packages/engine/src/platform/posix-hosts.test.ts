// WP-87: the POSIX branches of the platform layer with an injected host, so they run on every OS (ADR 0065 items 4 and 5).
// The darwin and "other" rows stay UNVERIFIED on a real macOS host until its CI job has run (docs/platform-support.md).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveMcsHome } from '@mcs/shared/protocol';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { buildChildEnv, createResolver, spawnRefusal, type ChildResult, type ChildSpec } from './exec.ts';
import { classifyPlatform, isCaseInsensitive, type HostPlatform } from './host.ts';
import { createRuntimeLister, matchRuntimeMarker, runtimeDirOf } from './markers.ts';
import { computeMutexName, createLockFileBackend, socketAddress } from './mutex.ts';
import { createProcessHelpers } from './process.ts';
import { isNetworkRoot } from './watch-hint.ts';

const tempDir = useTempDirs();
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function ok(stdout: string): ChildResult {
  return { ok: true, code: 0, stdout, stderr: '', error: null, truncated: false, durationMs: 1 };
}

describe('host classification and case rules', () => {
  it('maps every Node platform string to one of four hosts and only win32 and darwin ignore case', () => {
    expect(classifyPlatform('linux')).toBe('linux');
    expect(classifyPlatform('darwin')).toBe('darwin');
    expect(classifyPlatform('freebsd')).toBe('other');
    expect(classifyPlatform('aix')).toBe('other');
    const table: [HostPlatform, boolean][] = [
      ['win32', true],
      ['darwin', true],
      ['linux', false],
      ['other', false],
    ];
    for (const [host, insensitive] of table) expect(isCaseInsensitive(host)).toBe(insensitive);
  });

  it('matches a runtime marker case-sensitively on linux and case-insensitively on darwin', () => {
    const line = `node /opt/Skill/runtime/packages/server/dist/main.js --mcs-instance=${ID}`;
    const upper = line.replace('/opt/Skill/', '/OPT/SKILL/');
    expect(runtimeDirOf(line, false)).toBe('/opt/Skill/runtime');
    expect(matchRuntimeMarker(line, ID, false)).toBe(true);
    expect(matchRuntimeMarker(line, ID.toUpperCase(), false)).toBe(false);
    expect(matchRuntimeMarker(upper, ID, true)).toBe(true);
    expect(runtimeDirOf(line.replace('/dist/main.js', '/DIST/MAIN.JS'), false)).toBeNull();
    expect(runtimeDirOf(line.replace('/dist/main.js', '/DIST/MAIN.JS'), true)).toBe('/opt/Skill/runtime');
  });
});

describe('mutex names and addresses per host', () => {
  it('folds case into the name on win32 only', () => {
    expect(computeMutexName('task', '/Work/A', 'linux')).not.toBe(computeMutexName('task', '/work/a', 'linux'));
    expect(computeMutexName('task', '/Work/A', 'darwin')).not.toBe(computeMutexName('task', '/work/a', 'darwin'));
    expect(computeMutexName('task', 'C:/Work/A', 'win32')).toBe(computeMutexName('task', 'c:/work/a', 'win32'));
    expect(computeMutexName('bootstrap', '/x', 'linux')).toMatch(/^mcs-bootstrap-[0-9a-f]{16}$/);
  });

  it('is an abstract socket on linux, a named pipe on win32 and no socket elsewhere (the lock-file backend)', () => {
    expect(socketAddress('linux', 'mcs-task-0123456789abcdef')).toBe('\u0000mcs-task-0123456789abcdef');
    expect(socketAddress('win32', 'mcs-task-0123456789abcdef')).toBe('\\\\.\\pipe\\mcs-task-0123456789abcdef');
    expect(socketAddress('darwin', 'mcs-task-0123456789abcdef')).toBeNull();
    expect(socketAddress('other', 'mcs-task-0123456789abcdef')).toBeNull();
  });
});

describe('the lock-file mutex backend (darwin and other hosts)', () => {
  it('takes over a lock left by a crashed holder (dead pid) and refuses one whose pid is alive', async () => {
    const dir = path.join(tempDir('posix-lock').path, 'mutex');
    const name = 'mcs-task-00000000000000aa';
    mkdirSync(dir);
    writeFileSync(path.join(dir, `${name}.lock`), JSON.stringify({ pid: 999_999, nonce: 'deadbeef', createdAt: 1 }));
    const backend = createLockFileBackend({ dir, pidAlive: (pid) => pid !== 999_999, pid: 4242 });
    const held = await backend.tryAcquire(name);
    expect(held).not.toBeNull();
    // The stale file is gone, the new lock names this holder.
    expect(readdirSync(dir)).toEqual([`${name}.lock`]);
    expect(await backend.tryAcquire(name)).toBeNull();
    await held?.release();
    expect(existsSync(path.join(dir, `${name}.lock`))).toBe(false);
  });

  it('treats a fresh unreadable lock as held and an old one as stale', async () => {
    const dir = path.join(tempDir('posix-lock').path, 'mutex');
    mkdirSync(dir);
    const name = 'mcs-task-00000000000000bb';
    writeFileSync(path.join(dir, `${name}.lock`), '{');
    let clock = Date.now();
    const backend = createLockFileBackend({ dir, pidAlive: () => true, now: () => clock });
    expect(await backend.tryAcquire(name)).toBeNull();
    clock += 60_000;
    const held = await backend.tryAcquire(name);
    expect(held).not.toBeNull();
    await held?.release();
  });
});

describe('process identity on darwin: the `ps` listing parser with hostile lines', () => {
  const runtime = '/opt/skill/runtime';
  const good = `${runtime}/packages/server/dist/main.js`;
  const listing = [
    '  PID COMMAND',
    `  101 node ${good} --mcs-instance=${ID} --instance-dir=/ws`,
    `  102 node /elsewhere/packages/server/dist/main.js --mcs-instance=${ID}`,
    `abc node ${good} --mcs-instance=${ID}`,
    `  12345678901 node ${good} --mcs-instance=${ID}`,
    `  103 echo ${good.slice(0, -3)} --mcs-instance=${ID}`,
    `-5 node ${good}`,
    '',
    `  104 node ${good} --mcs-instance=${ID}\\n  105 node ${good}`,
  ].join('\n');

  it('keeps only rows with a valid pid that run a server entry of the wanted folder', async () => {
    const calls: ChildSpec[] = [];
    const list = createRuntimeLister({
      platform: 'darwin',
      exec: (spec) => {
        calls.push(spec);
        return Promise.resolve(ok(listing));
      },
      resolve: (name) => Promise.resolve(name === 'ps' ? '/bin/ps' : null),
      scanProc: () => Promise.reject(new Error('not on darwin')),
    });
    const rows = await list(runtime);
    expect(rows.map((r) => r.pid).sort((a, b) => a - b)).toEqual([101, 104]);
    expect(rows.find((r) => r.pid === 101)).toMatchObject({ instanceId: ID, instanceDir: '/ws' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'ps', file: '/bin/ps', args: ['-axo', 'pid=,command='] });
  });

  it('is an error, never an empty list, when `ps` is missing', async () => {
    const list = createRuntimeLister({
      platform: 'other',
      exec: () => Promise.resolve(ok('')),
      resolve: () => Promise.resolve(null),
      scanProc: () => Promise.resolve([]),
    });
    await expect(list(runtime)).rejects.toThrow(/could not list runtime processes \(ps\)/);
  });

  it('reads the command line from /proc on linux and from `ps -o command=` elsewhere', async () => {
    const execs: ChildSpec[] = [];
    const base = {
      exec: (spec: ChildSpec) => {
        execs.push(spec);
        return Promise.resolve(ok('node x.js\n'));
      },
      resolve: () => Promise.resolve('/bin/ps'),
      now: () => 0,
      sleep: () => Promise.resolve(),
      kill: () => undefined,
      readCmdline: () => Promise.resolve('node\u0000x.js\u0000--a b\u0000'),
    };
    expect(await createProcessHelpers({ ...base, platform: 'linux' }).commandLineOf(77)).toBe('node x.js --a b');
    expect(execs).toHaveLength(0);
    expect(await createProcessHelpers({ ...base, platform: 'darwin' }).commandLineOf(77)).toBe('node x.js');
    expect(execs[0]).toMatchObject({ kind: 'ps', args: ['-o', 'command=', '-p', '77'] });
  });

  it('kills with SIGKILL off Windows and treats a vanished pid as done', async () => {
    const signals: (NodeJS.Signals | 0)[] = [];
    const helpers = createProcessHelpers({
      platform: 'linux',
      exec: () => Promise.reject(new Error('no exec on linux')),
      resolve: () => Promise.resolve(null),
      now: () => 0,
      sleep: () => Promise.resolve(),
      kill: (_pid, signal) => {
        signals.push(signal);
        if (signals.length > 1) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      },
      readCmdline: () => Promise.resolve(null),
    });
    await helpers.forceKill(10);
    await helpers.forceKill(10);
    expect(signals).toEqual(['SIGKILL', 'SIGKILL']);
  });
});

describe('executable lookup on POSIX hosts', () => {
  function resolver(platform: HostPlatform, pathValue: string | undefined, executables: string[]) {
    return createResolver({
      platform,
      env: (name) => (name === 'PATH' ? pathValue : undefined),
      execPath: '/usr/local/bin/node',
      exists: () => Promise.resolve(false),
      isExecutable: (file) => Promise.resolve(executables.includes(file)),
      now: () => 0,
    });
  }

  it('opens with xdg-open from PATH on linux and other hosts, /usr/bin/open on darwin', async () => {
    expect(await resolver('linux', '/usr/local/bin:/usr/bin', ['/usr/bin/xdg-open'])('opener')).toBe(
      '/usr/bin/xdg-open',
    );
    expect(await resolver('other', '/usr/bin', ['/usr/bin/xdg-open'])('opener')).toBe('/usr/bin/xdg-open');
    expect(await resolver('darwin', '/usr/bin', ['/usr/bin/open', '/usr/bin/xdg-open'])('opener')).toBe(
      '/usr/bin/open',
    );
    expect(await resolver('darwin', '/usr/bin', ['/usr/bin/xdg-open'])('opener')).toBeNull();
    expect(await resolver('linux', '/usr/bin', [])('opener')).toBeNull();
  });

  it('ignores relative and empty PATH entries and never resolves node from PATH', async () => {
    const r = resolver('linux', 'bin::./tools: /usr/bin ', ['bin/git', 'tools/git', '/usr/bin/git']);
    expect(await r('git')).toBe('/usr/bin/git');
    expect(await resolver('linux', 'bin:./tools', ['bin/ps', 'tools/ps'])('ps')).toBeNull();
    expect(await resolver('linux', undefined, ['/usr/bin/git'])('git')).toBeNull();
    expect(await r('node')).toBe('/usr/local/bin/node');
    expect(await r('powershell')).toBeNull();
    expect(await r('taskkill')).toBeNull();
  });

  it('refuses no plain POSIX executable (the batch-file refusal is win32 only)', () => {
    expect(spawnRefusal('/usr/bin/git', 'linux')).toBeNull();
    expect(spawnRefusal('/tmp/run.cmd', 'linux')).toBeNull();
    expect(spawnRefusal('C:\\tools\\run.cmd', 'win32')).not.toBeNull();
  });
});

describe('child environment on POSIX', () => {
  it('sets LC_ALL=C off Windows only and does not leak MCS_* or tokens', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      MCS_HOME: '/x',
      GITHUB_TOKEN: 'FIXTURE-not-a-token',
      LC_ALL: 'vi_VN',
    };
    const linux = buildChildEnv('git', undefined, source, 'linux');
    expect(linux['LC_ALL']).toBe('C');
    expect(buildChildEnv('ps', undefined, source, 'darwin')['LC_ALL']).toBe('C');
    expect(buildChildEnv('git', undefined, source, 'win32')['LC_ALL']).not.toBe('C');
    expect(linux['MCS_HOME']).toBeUndefined();
    expect(linux['GITHUB_TOKEN']).toBeUndefined();
    expect(linux['MCS_HOOK_DISABLE']).toBe('1');
  });
});

describe('watch-hint choices', () => {
  it('polls only UNC roots on win32; no POSIX root counts as a network root', () => {
    expect(isNetworkRoot('//server/share/ws', 'linux')).toBe(false);
    expect(isNetworkRoot('/mnt/nfs/ws', 'linux')).toBe(false);
    expect(isNetworkRoot('/Volumes/share/ws', 'darwin')).toBe(false);
    expect(isNetworkRoot('\\\\server\\share\\ws', 'win32')).toBe(true);
    expect(isNetworkRoot('\\\\?\\UNC\\server\\share', 'win32')).toBe(true);
    expect(isNetworkRoot('\\\\?\\C:\\ws', 'win32')).toBe(false);
  });
});

describe('resolveMcsHome per host (the hook stub and the server share it)', () => {
  const table: { name: string; env: Record<string, string>; win32: boolean; want: string | RegExp }[] = [
    { name: 'linux, no XDG_STATE_HOME', env: { HOME: '/home/u' }, win32: false, want: '/home/u/.local/state/mcs' },
    {
      name: 'linux, XDG_STATE_HOME set',
      env: { HOME: '/home/u', XDG_STATE_HOME: '/var/state/' },
      win32: false,
      want: '/var/state/mcs',
    },
    {
      name: 'linux, relative XDG_STATE_HOME is ignored',
      env: { HOME: '/home/u', XDG_STATE_HOME: 'state' },
      win32: false,
      want: '/home/u/.local/state/mcs',
    },
    {
      name: 'linux, XDG_DATA_HOME is not the state folder',
      env: { HOME: '/home/u', XDG_DATA_HOME: '/data' },
      win32: false,
      want: '/home/u/.local/state/mcs',
    },
    { name: 'darwin (same rule as linux)', env: { HOME: '/Users/u' }, win32: false, want: '/Users/u/.local/state/mcs' },
    {
      name: 'win32 with LOCALAPPDATA',
      env: { USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      win32: true,
      want: 'C:\\Users\\u\\AppData\\Local/mcs',
    },
    {
      name: 'win32 without LOCALAPPDATA',
      env: { USERPROFILE: 'C:\\Users\\u' },
      win32: true,
      want: 'C:\\Users\\u/AppData/Local/mcs',
    },
    { name: 'absolute MCS_HOME wins', env: { HOME: '/home/u', MCS_HOME: '/srv/mcs/' }, win32: false, want: '/srv/mcs' },
    {
      name: 'relative MCS_HOME is ignored',
      env: { HOME: '/home/u', MCS_HOME: 'mcs' },
      win32: false,
      want: '/home/u/.local/state/mcs',
    },
  ];
  for (const row of table) {
    it(row.name, () => {
      expect(resolveMcsHome(row.env, { win32: row.win32 })).toBe(row.want);
    });
  }

  it('throws on an unusable environment (no home, no MCS_HOME)', () => {
    expect(() => resolveMcsHome({}, { win32: false })).toThrow(/no home directory/);
    expect(() => resolveMcsHome({ HOME: '' }, { win32: false })).toThrow(/no home directory/);
    expect(() => resolveMcsHome({ MCS_HOME: 'relative' }, { win32: true })).toThrow(/no home directory/);
  });
});
