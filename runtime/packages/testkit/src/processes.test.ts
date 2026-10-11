import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { baseEnv, cliEntryPath, killAllTracked, runCli, runNodeEntry, spawnTracked } from './processes.ts';
import { useTempDirs } from './temp.ts';

const tempDir = useTempDirs();

afterAll(async () => {
  await killAllTracked();
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const IDLE = 'setInterval(() => {}, 60000)';

describe('spawnTracked', () => {
  it('reports the pid and resolves exited with the exit code', async () => {
    const child = spawnTracked(process.execPath, ['-e', 'process.exit(3)']);
    expect(child.pid).toBeGreaterThan(0);
    await expect(child.exited).resolves.toBe(3);
  });

  it('kill stops a running process', async () => {
    const child = spawnTracked(process.execPath, ['-e', IDLE]);
    expect(isAlive(child.pid)).toBe(true);
    child.kill();
    await child.exited;
    expect(isAlive(child.pid)).toBe(false);
  });

  it('throws for a program that does not exist', () => {
    expect(() => spawnTracked(join(tempDir('missing').path, 'no-such-program'), [])).toThrow(/no-such-program/);
  });

  async function childEnv(extra?: Record<string, string>): Promise<Record<string, string>> {
    const dir = tempDir('proc-env');
    const script = join(dir.path, 'env.mjs');
    writeFileSync(
      script,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify(process.env));",
    );
    const out = join(dir.path, 'env.json');
    const child = spawnTracked(process.execPath, [script, out], extra === undefined ? {} : { env: extra });
    await expect(child.exited).resolves.toBe(0);
    return JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
  }

  it('starts from a minimal environment: nothing of the parent leaks, hooks are disabled', async () => {
    vi.stubEnv('MCS_TESTKIT_LEAK', 'parent');
    vi.stubEnv('CLAUDE_TESTKIT_LEAK', 'parent');
    const env = await childEnv({ EXTRA: 'yes' });
    expect(env['EXTRA']).toBe('yes');
    expect(env['MCS_HOOK_DISABLE']).toBe('1');
    expect(env['TZ']).toBe('UTC');
    expect(env['MCS_TESTKIT_LEAK']).toBeUndefined();
    expect(env['CLAUDE_TESTKIT_LEAK']).toBeUndefined();
  });

  it('lets the caller override MCS_HOOK_DISABLE', async () => {
    const env = await childEnv({ MCS_HOOK_DISABLE: '0' });
    expect(env['MCS_HOOK_DISABLE']).toBe('0');
  });
});

describe('killAllTracked', () => {
  it('kills every tracked process and waits for them', async () => {
    const a = spawnTracked(process.execPath, ['-e', IDLE]);
    const b = spawnTracked(process.execPath, ['-e', IDLE]);
    await killAllTracked();
    expect(isAlive(a.pid)).toBe(false);
    expect(isAlive(b.pid)).toBe(false);
    await killAllTracked();
  });

  it('runs the cleanups other helpers registered, once', async () => {
    const { onKillAll } = await import('./processes.ts');
    let calls = 0;
    onKillAll(() => {
      calls += 1;
      return Promise.resolve();
    });
    await killAllTracked();
    await killAllTracked();
    expect(calls).toBe(1);
  });

  it('a throwing cleanup neither stops the other cleanups nor leaves a tracked child alive', async () => {
    const { onKillAll } = await import('./processes.ts');
    const child = spawnTracked(process.execPath, ['-e', IDLE]);
    let laterRan = false;
    onKillAll(() => Promise.reject(new Error('stop failed')));
    onKillAll(() => {
      laterRan = true;
      return Promise.resolve();
    });
    await expect(killAllTracked()).rejects.toThrow(/stop failed/);
    expect(laterRan).toBe(true);
    expect(isAlive(child.pid)).toBe(false);
    // The failed cleanup is gone: the next call is clean.
    await expect(killAllTracked()).resolves.toBeUndefined();
  });

  it('reports every failing cleanup, not only the first', async () => {
    const { onKillAll } = await import('./processes.ts');
    onKillAll(() => Promise.reject(new Error('first failure')));
    onKillAll(() => Promise.reject(new Error('second failure')));
    await expect(killAllTracked()).rejects.toThrow(/first failure[\s\S]*second failure/);
  });
});

describe('runNodeEntry', () => {
  function envProbe(): { script: string; mcsHome: string } {
    const dir = tempDir('proc-cli');
    const script = join(dir.path, 'probe.mjs');
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd(), argv: process.argv.slice(2) }));' +
        "process.stderr.write('warn');process.exitCode = 4;",
    );
    return { script, mcsHome: join(dir.path, 'mcs-home') };
  }

  it('returns code, stdout and stderr', async () => {
    const { script, mcsHome } = envProbe();
    const result = await runNodeEntry(script, ['a', '--b'], { mcsHome });
    expect(result.code).toBe(4);
    expect(result.stderr).toBe('warn');
    const seen = JSON.parse(result.stdout) as { argv: string[] };
    expect(seen.argv).toEqual(['a', '--b']);
  });

  it('points MCS_HOME, CLAUDE_CONFIG_DIR and HOME into the temp state and disables hooks', async () => {
    vi.stubEnv('MCS_TESTKIT_LEAK', 'parent');
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'C:/real/claude');
    const { script, mcsHome } = envProbe();
    const result = await runNodeEntry(script, [], { mcsHome });
    const seen = JSON.parse(result.stdout) as { env: Record<string, string>; cwd: string };
    expect(seen.env['MCS_HOME']).toBe(mcsHome);
    expect(seen.env['CLAUDE_CONFIG_DIR']?.startsWith(mcsHome)).toBe(true);
    expect(seen.env['HOME']?.startsWith(mcsHome)).toBe(true);
    expect(seen.env['USERPROFILE']?.startsWith(mcsHome)).toBe(true);
    expect(seen.env['MCS_HOOK_DISABLE']).toBe('1');
    expect(seen.env['MCS_LAUNCHER_NO_BOOTSTRAP']).toBe('1');
    expect(seen.env['MCS_TESTKIT_LEAK']).toBeUndefined();
    expect(seen.cwd.toLowerCase()).toBe(mcsHome.toLowerCase());
  });

  it('applies caller env and cwd but keeps MCS_HOOK_DISABLE=1 always', async () => {
    const { script, mcsHome } = envProbe();
    const cwd = tempDir('proc-cwd').path;
    const result = await runNodeEntry(script, [], {
      mcsHome,
      cwd,
      env: { CLAUDE_CONFIG_DIR: join(cwd, 'claude'), MCS_HOOK_DISABLE: '0', X_CASE: '1' },
    });
    const seen = JSON.parse(result.stdout) as { env: Record<string, string>; cwd: string };
    expect(seen.env['MCS_HOOK_DISABLE']).toBe('1');
    expect(seen.env['CLAUDE_CONFIG_DIR']).toBe(join(cwd, 'claude'));
    expect(seen.env['X_CASE']).toBe('1');
    expect(seen.cwd.toLowerCase()).toBe(cwd.toLowerCase());
  });
});

describe('runCli', () => {
  it('runs packages/cli/dist/main.js of this runtime', async () => {
    expect(cliEntryPath().replaceAll('\\', '/')).toMatch(/runtime\/packages\/cli\/dist\/main\.js$/);
    expect(existsSync(cliEntryPath())).toBe(true);
    const result = await runCli([], { mcsHome: join(tempDir('proc-run').path, 'mcs-home') });
    expect(typeof result.code).toBe('number');
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
  });
});

describe('baseEnv', () => {
  it('holds PATH and UTC and nothing of MCS_* or CLAUDE_*', () => {
    vi.stubEnv('MCS_TESTKIT_LEAK', 'parent');
    const env = baseEnv();
    expect(env['PATH']).toBeTypeOf('string');
    expect(env['TZ']).toBe('UTC');
    expect(Object.keys(env).filter((k) => /^(MCS_|CLAUDE_)/.test(k))).toEqual([]);
  });
});
