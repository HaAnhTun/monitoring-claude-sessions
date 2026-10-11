import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { hermeticEnv, makeJunction, spawnImpostor, startArgs, startInstance } from './isolation.ts';
import { killAllTracked } from './processes.ts';
import { useTempDirs } from './temp.ts';
import { waitFor } from './wait.ts';

const tempDir = useTempDirs();

afterAll(async () => {
  await killAllTracked();
});

function commandLineOf(pid: number): string {
  if (process.platform === 'win32') {
    const run = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return run.stdout.trim();
  }
  return spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
}

describe('hermeticEnv', () => {
  it('puts every state folder under the root and disables hooks', () => {
    const root = join(tempDir('hermetic').path, 'root');
    const env = hermeticEnv(root);
    expect(env['MCS_HOME']).toBe(join(root, 'mcs-home'));
    expect(env['CLAUDE_CONFIG_DIR']).toBe(join(root, 'claude-home'));
    expect(env['HOME']).toBe(join(root, 'home'));
    expect(env['USERPROFILE']).toBe(join(root, 'home'));
    expect(env['MCS_HOOK_DISABLE']).toBe('1');
    expect(env['TZ']).toBe('UTC');
    expect(env['PATH']).toBeTypeOf('string');
  });

  it('inherits no MCS_* or CLAUDE_* variable of the parent', () => {
    vi.stubEnv('MCS_PORT', '1234');
    vi.stubEnv('MCS_E2E_CLAUDE', '1');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'C:/real/claude');
    const env = hermeticEnv(join(tempDir('hermetic2').path, 'root'));
    expect(
      Object.keys(env)
        .filter((k) => /^(MCS_|CLAUDE_)/.test(k))
        .sort(),
    ).toEqual(['CLAUDE_CONFIG_DIR', 'MCS_HOME', 'MCS_HOOK_DISABLE']);
    expect(env['CLAUDE_CONFIG_DIR']).not.toContain('real');
  });

  it('holds a minimal set of keys', () => {
    const keys = Object.keys(hermeticEnv(join(tempDir('hermetic3').path, 'root'))).sort();
    const base = ['CLAUDE_CONFIG_DIR', 'HOME', 'MCS_HOME', 'MCS_HOOK_DISABLE', 'PATH', 'TZ', 'USERPROFILE'];
    const win = ['SystemRoot', 'TEMP', 'TMP'];
    for (const key of base) expect(keys).toContain(key);
    if (process.platform === 'win32') for (const key of win) expect(keys).toContain(key);
    expect(keys.length).toBeLessThanOrEqual(base.length + win.length);
  });
});

describe('makeJunction', () => {
  it('creates a link that lstat sees and that resolves to the target', () => {
    const root = tempDir('junction').path;
    const target = join(root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'f.txt'), 'FIXTURE inside');
    const link = join(root, 'link');
    makeJunction(link, target);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, 'f.txt'), 'utf8')).toBe('FIXTURE inside');
  });

  it('refuses to replace an existing path', () => {
    const root = tempDir('junction2').path;
    const target = join(root, 'target');
    mkdirSync(target);
    const link = join(root, 'link');
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => {
      makeJunction(link, target);
    }).toThrow();
  });
});

describe('spawnImpostor', () => {
  it('is an idle Node process whose command line ends with its argv', async () => {
    const argv = ['--mcs-instance=FIXTURE-impostor', 'serve', '--task', 'a'];
    const impostor = spawnImpostor(argv);
    const line = await waitFor(
      () => {
        const text = commandLineOf(impostor.pid);
        return text === '' ? null : text;
      },
      { what: 'the impostor command line', timeoutMs: 15_000, intervalMs: 100 },
    );
    expect(line.replaceAll('"', '').trimEnd().endsWith(argv.join(' '))).toBe(true);
    expect(line.toLowerCase()).toContain('node');
    impostor.kill();
    await impostor.exited;
  });
});

describe('startInstance', () => {
  it('builds the real `$MCS start` call for one task and port', () => {
    expect(startArgs({ repo: 'R', slug: 's1' }, 18950)).toEqual([
      'start',
      '--task',
      's1',
      '--repo',
      'R',
      '--port',
      '18950',
    ]);
  });

  it('needs MCS_HOME in the environment of the workspace', async () => {
    await expect(startInstance({ repo: 'R', slug: 's1', env: {} }, { port: 18950 })).rejects.toThrow(/MCS_HOME/);
  });
});
