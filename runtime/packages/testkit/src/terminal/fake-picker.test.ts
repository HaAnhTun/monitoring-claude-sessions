import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { baseEnv } from '../processes.ts';

const SCRIPT = fileURLToPath(new URL('../../assets/fake-picker.mjs', import.meta.url));

interface Ran {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

const live: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of live.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

function start(result: string | undefined, extraArgs: string[] = []): ReturnType<typeof spawn> {
  const env: Record<string, string> = { ...baseEnv() };
  if (result !== undefined) env['FAKE_PICKER_RESULT'] = result;
  const child = spawn(process.execPath, [SCRIPT, ...extraArgs], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  live.push(child);
  return child;
}

function run(result: string | undefined, extraArgs: string[] = []): Promise<Ran> {
  const child = start(result, extraArgs);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

describe('assets/fake-picker.mjs (TC-FAKE-23)', () => {
  it('is a single self-contained module that exists next to the fake claude', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('prints the path of FAKE_PICKER_RESULT on one line and exits 0', async () => {
    const ran = await run('D:\\FIXTURE-projects\\alpha');
    expect(ran.code).toBe(0);
    expect(ran.stdout.toString()).toBe('D:\\FIXTURE-projects\\alpha\n');
    expect(ran.stderr).toHaveLength(0);
  });

  it('prints nothing and exits 0 for an empty result (the user cancelled)', async () => {
    const ran = await run('');
    expect(ran.code).toBe(0);
    expect(ran.stdout).toHaveLength(0);
    expect(ran.stderr).toHaveLength(0);
  });

  it('treats a missing FAKE_PICKER_RESULT as a cancel', async () => {
    const ran = await run(undefined);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toHaveLength(0);
  });

  it('ignores its arguments (the server passes the picker options)', async () => {
    const ran = await run('/work/FIXTURE-x', ['--title', 'Pick a folder', '-NoProfile']);
    expect(ran.code).toBe(0);
    expect(ran.stdout.toString()).toBe('/work/FIXTURE-x\n');
  });

  it('!error exits 1 with junk on stderr and nothing on stdout', async () => {
    const ran = await run('!error');
    expect(ran.code).toBe(1);
    expect(ran.stdout).toHaveLength(0);
    expect(ran.stderr.length).toBeGreaterThan(0);
  });

  it('!hang never exits until it is killed', async () => {
    const child = start('!hang');
    const stderr: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    await new Promise<void>((resolve) => {
      child.stderr?.once('data', () => {
        resolve();
      });
    });
    expect(Buffer.concat(stderr).toString()).toContain('hang');
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => {
        resolve();
      });
    });
    child.kill();
    await closed;
  });

  it('!junk prints several lines, a path with a NUL and a line of 100 KB, and exits 0', async () => {
    const ran = await run('!junk');
    expect(ran.code).toBe(0);
    const lines = ran.stdout.toString('latin1').split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(ran.stdout.includes(0)).toBe(true);
    expect(lines.some((line) => line.length >= 100 * 1024)).toBe(true);
    expect(ran.stdout.length).toBeGreaterThan(100 * 1024);
  });

  it('!unc prints a UNC path of another machine', async () => {
    const ran = await run('!unc');
    expect(ran.code).toBe(0);
    expect(ran.stdout.toString()).toBe('\\\\attacker\\share\n');
  });

  it('prints an unknown ! value literally: only the listed modes are special', async () => {
    const ran = await run('!nothing');
    expect(ran.code).toBe(0);
    expect(ran.stdout.toString()).toBe('!nothing\n');
  });
});
