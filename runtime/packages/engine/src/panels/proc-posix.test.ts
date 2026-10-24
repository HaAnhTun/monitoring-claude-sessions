import { describe, expect, it } from 'vitest';

import type { ChildResult, ChildSpec } from '../platform/exec.ts';
import { createPosixLister, parsePsOutput, parseVmStat, readMacAvailableBytes, VM_STAT_PATH } from './proc-posix.ts';

const result = (over: Partial<ChildResult>): ChildResult => ({
  ok: over.error === undefined && (over.code ?? 0) === 0,
  code: 0,
  stdout: '',
  stderr: '',
  error: null,
  truncated: false,
  durationMs: 1,
  ...over,
});

function fakeExec(answer: Partial<ChildResult>, file: string | null = '/bin/ps') {
  const calls: ChildSpec[] = [];
  return {
    calls,
    exec: {
      resolveExecutable: () => Promise.resolve(file),
      execFileText: (spec: ChildSpec) => {
        calls.push(spec);
        return Promise.resolve(result(answer));
      },
    },
  };
}

const signal = new AbortController().signal;

describe('parsePsOutput', () => {
  it('uses the base name of the command and converts KiB to bytes', () => {
    const text = ['/usr/bin/node 20480', '  /sbin/launchd   1024  ', 'bash 512'].join('\n');
    expect(parsePsOutput(text)).toEqual([
      { name: 'node', workingSetBytes: 20_480 * 1024 },
      { name: 'launchd', workingSetBytes: 1024 * 1024 },
      { name: 'bash', workingSetBytes: 512 * 1024 },
    ]);
  });

  it('keeps spaces inside a path and inside the name', () => {
    const text = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome 300000\n/opt/my tool/bin/a b c 42\n';
    expect(parsePsOutput(text)).toEqual([
      { name: 'Google Chrome', workingSetBytes: 300_000 * 1024 },
      { name: 'a b c', workingSetBytes: 42 * 1024 },
    ]);
  });

  it('keeps a 15 character truncated command as it is', () => {
    expect(parsePsOutput('com.docker.back 2048\n')).toEqual([
      { name: 'com.docker.back', workingSetBytes: 2048 * 1024 },
    ]);
  });

  it('reads 5,000 processes', () => {
    const text = Array.from({ length: 5000 }, (_, i) => `/usr/bin/p${String(i)} ${String(i + 1)}`).join('\n');
    const entries = parsePsOutput(text);
    expect(entries).toHaveLength(5000);
    expect(entries[4999]).toEqual({ name: 'p4999', workingSetBytes: 5000 * 1024 });
  });

  it('reads CRLF lines and ignores lines without a numeric last token', () => {
    const text = ['node 100\r', 'oops', 'name notanumber', '', '   ', '100', 'x -5', 'y 1.5', 'z 7'].join('\n');
    expect(parsePsOutput(text)).toEqual([
      { name: 'node', workingSetBytes: 100 * 1024 },
      { name: 'z', workingSetBytes: 7 * 1024 },
    ]);
  });
});

describe('parseVmStat', () => {
  const SAMPLE = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               10000.',
    'Pages active:                             99999.',
    'Pages inactive:                            2000.',
    'Pages speculative:                          500.',
    'Pages throttled:                              0.',
    'Pages wired down:                         88888.',
  ].join('\n');

  it('adds free, inactive and speculative pages at the page size of the header', () => {
    expect(parseVmStat(SAMPLE)).toBe((10_000 + 2000 + 500) * 16_384);
  });

  it('uses 4096 bytes when the page size is 4096', () => {
    const text = SAMPLE.replace('16384', '4096');
    expect(parseVmStat(text)).toBe((10_000 + 2000 + 500) * 4096);
  });

  it('counts a missing speculative line as zero but needs free and inactive', () => {
    const noSpeculative = SAMPLE.split('\n')
      .filter((line) => !line.includes('speculative'))
      .join('\n');
    expect(parseVmStat(noSpeculative)).toBe((10_000 + 2000) * 16_384);
    const noFree = SAMPLE.split('\n')
      .filter((line) => !line.startsWith('Pages free'))
      .join('\n');
    expect(parseVmStat(noFree)).toBeNull();
  });

  it('is null for garbage and for a missing or absurd page size', () => {
    expect(parseVmStat('')).toBeNull();
    expect(parseVmStat('nothing useful here')).toBeNull();
    expect(parseVmStat(SAMPLE.replace('(page size of 16384 bytes)', ''))).toBeNull();
    expect(parseVmStat(SAMPLE.replace('16384', '0'))).toBeNull();
  });
});

describe('createPosixLister', () => {
  it('runs ps with fixed arguments and parses the output', async () => {
    const { exec, calls } = fakeExec({ stdout: '/usr/bin/node 1000\n' });
    const out = await createPosixLister({ exec, timeoutMs: 10_000 }).load(signal);
    expect(out).toEqual({ status: 'ok', value: [{ name: 'node', workingSetBytes: 1000 * 1024 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'ps',
      file: '/bin/ps',
      args: ['-A', '-o', 'comm=,rss='],
      timeoutMs: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
      encoding: 'utf8',
    });
  });

  it('is unavailable without ps and when the spawn fails with ENOENT', async () => {
    const missing = fakeExec({}, null);
    expect((await createPosixLister({ exec: missing.exec, timeoutMs: 1000 }).load(signal)).status).toBe('unavailable');
    expect(missing.calls).toHaveLength(0);
    const gone = fakeExec({ ok: false, code: null, error: 'ENOENT' });
    expect((await createPosixLister({ exec: gone.exec, timeoutMs: 1000 }).load(signal)).status).toBe('unavailable');
  });

  it('is an error on a timeout, an exit code, a cut output and an empty list', async () => {
    const timeout = fakeExec({ ok: false, code: null, error: 'TIMEOUT' });
    expect(await createPosixLister({ exec: timeout.exec, timeoutMs: 1000 }).load(signal)).toEqual({
      status: 'error',
      message: 'the process list timed out',
    });
    const exit = fakeExec({ ok: false, code: 1, error: 'NONZERO_EXIT', stderr: 'ps: illegal option\nusage' });
    expect(await createPosixLister({ exec: exit.exec, timeoutMs: 1000 }).load(signal)).toEqual({
      status: 'error',
      message: 'ps: illegal option',
    });
    const cut = fakeExec({ ok: false, code: null, error: 'OUTPUT_LIMIT', truncated: true });
    expect((await createPosixLister({ exec: cut.exec, timeoutMs: 1000 }).load(signal)).status).toBe('error');
    const empty = fakeExec({ stdout: 'garbage\n' });
    expect(await createPosixLister({ exec: empty.exec, timeoutMs: 1000 }).load(signal)).toEqual({
      status: 'error',
      message: 'process list was empty',
    });
  });
});

describe('readMacAvailableBytes', () => {
  it('spawns vm_stat by absolute path with kind ps and parses it', async () => {
    const { exec, calls } = fakeExec({
      stdout: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 5.\n',
    });
    expect(await readMacAvailableBytes(exec, signal)).toBe(15 * 16_384);
    expect(VM_STAT_PATH).toBe('/usr/bin/vm_stat');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'ps', file: '/usr/bin/vm_stat', args: [], encoding: 'utf8' });
  });

  it('is null when vm_stat fails or prints nothing useful', async () => {
    expect(await readMacAvailableBytes(fakeExec({ ok: false, code: null, error: 'ENOENT' }).exec, signal)).toBeNull();
    expect(await readMacAvailableBytes(fakeExec({ stdout: 'x' }).exec, signal)).toBeNull();
  });
});
