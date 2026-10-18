// Atomic replace over a file another process holds open (06 4.3, ADR 0058, E10). On Windows a rename onto an open target
// fails with EPERM, so the write must retry until the holder lets go, and give up cleanly after the 3000 ms budget.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { holdFileOpen, useTempDirs, type FileHolder } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { AtomicWriteError, atomicWriteFile } from '../../src/platform/fsx.ts';

const isWin = process.platform === 'win32';
const makeTemp = useTempDirs();
const holders: ChildProcess[] = [];
const foreign: FileHolder[] = [];

afterEach(async () => {
  for (const holder of foreign.splice(0)) await holder.stop();
  for (const holder of holders.splice(0)) {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill();
      await once(holder, 'exit');
    }
  }
});

/** Starts a child that opens `file` for reading, prints `held`, keeps it open for `holdMs` and then closes it. */
async function holdOpen(command: string, args: readonly string[]): Promise<ChildProcess> {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  holders.push(child);
  await new Promise<void>((resolve, reject) => {
    let seen = '';
    child.stdout.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8');
      if (seen.includes('held')) resolve();
    });
    child.once('error', reject);
    child.once('exit', () => {
      reject(new Error(`the holder exited before it held the file (stdout: ${seen})`));
    });
  });
  return child;
}

function nodeHolder(file: string, holdMs: number): Promise<ChildProcess> {
  const code =
    'const fs = require("node:fs"); const fd = fs.openSync(process.argv[1], "r"); process.stdout.write("held\\n");' +
    ' setTimeout(() => { fs.closeSync(fd); }, Number(process.argv[2]));';
  return holdOpen(process.execPath, ['-e', code, '--', file, String(holdMs)]);
}

function setup(): { dir: string; target: string } {
  const dir = path.join(makeTemp('fsx-int').path, 'work');
  mkdirSync(dir);
  const target = path.join(dir, 'state.json');
  writeFileSync(target, 'old');
  return { dir, target };
}

describe.runIf(isWin)('atomicWriteFile over an open target (Windows sharing semantics)', () => {
  it('waits for a Node holder of 600 ms, then replaces the file: final content new, no temp file', async () => {
    const { dir, target } = setup();
    await nodeHolder(target, 600);
    const started = performance.now();
    await atomicWriteFile(target, 'new');
    const waited = performance.now() - started;
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['state.json']);
    // The first rename had to fail: the write really waited for the holder (otherwise this platform does not block).
    expect(waited).toBeGreaterThanOrEqual(300);
    expect(waited).toBeLessThan(3000);
  }, 30_000);

  it('waits for a holder of 600 ms without FILE_SHARE_DELETE (holdFileOpen) and then replaces the file', async () => {
    const { dir, target } = setup();
    const holder = await holdFileOpen(target, 600);
    if (holder === null) throw new Error('holdFileOpen: not supported on this platform');
    foreign.push(holder);
    await atomicWriteFile(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['state.json']);
  }, 30_000);

  it('gives up after the 3000 ms budget when the holder stays for 4 s: E_ATOMIC_WRITE_BUSY, old content intact, no .tmp', async () => {
    const { dir, target } = setup();
    const holder = await nodeHolder(target, 4000);
    const started = performance.now();
    const error = await atomicWriteFile(target, 'new').catch((caught: unknown) => caught);
    const waited = performance.now() - started;
    expect(error).toBeInstanceOf(AtomicWriteError);
    expect(error).toMatchObject({ code: 'E_ATOMIC_WRITE_BUSY', path: target });
    expect(waited).toBeGreaterThanOrEqual(2900);
    expect(waited).toBeLessThan(3900);
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['state.json']);

    // After the holder lets go the next write works (nothing is left in a bad state).
    await once(holder, 'exit');
    await atomicWriteFile(target, 'after');
    expect(readFileSync(target, 'utf8')).toBe('after');
  }, 30_000);

  it('a shorter budget gives up earlier', async () => {
    const { dir, target } = setup();
    await nodeHolder(target, 3000);
    const started = performance.now();
    const error = await atomicWriteFile(target, 'new', { budgetMs: 400 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'E_ATOMIC_WRITE_BUSY' });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(readdirSync(dir)).toEqual(['state.json']);
  }, 30_000);
});

describe('atomicWriteFile on every platform', () => {
  it('replaces a file that nobody holds, repeatedly, and always leaves exactly one file', async () => {
    const { dir, target } = setup();
    for (let i = 0; i < 20; i += 1) await atomicWriteFile(target, `value-${String(i)}`);
    expect(readFileSync(target, 'utf8')).toBe('value-19');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('survives many concurrent writers: the file is always one complete value, never a mix', async () => {
    const { dir, target } = setup();
    const values = Array.from({ length: 12 }, (_, i) => `${String(i)}:`.padEnd(2000, String(i)));
    await Promise.all(values.map((value) => atomicWriteFile(target, value)));
    expect(values).toContain(readFileSync(target, 'utf8'));
    expect(readdirSync(dir)).toEqual(['state.json']);
  }, 30_000);
});
