import { describe, expect, it } from 'vitest';

import type { ChildResult, ChildSpec } from '../platform/exec.ts';
import { createWin32Lister, parseProcLines, PROC_SCRIPT_CLM, PROC_SCRIPT_NET } from './proc-win32.ts';

const POWERSHELL = 'C:\\fixture\\powershell.exe';

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

function fakeExec(
  answers: Partial<ChildResult>[],
  file: string | null = POWERSHELL,
): { exec: Parameters<typeof createWin32Lister>[0]['exec']; calls: ChildSpec[] } {
  const calls: ChildSpec[] = [];
  return {
    calls,
    exec: {
      resolveExecutable: () => Promise.resolve(file),
      execFileText: (spec) => {
        calls.push(spec);
        return Promise.resolve(result(answers[Math.min(calls.length - 1, answers.length - 1)] ?? {}));
      },
    },
  };
}

const signal = new AbortController().signal;
const decodeScript = (spec: ChildSpec | undefined): string =>
  Buffer.from(spec?.args[spec.args.length - 1] ?? '', 'base64').toString('utf16le');

describe('parseProcLines', () => {
  it('reads CRLF output into name and working set', () => {
    const text = 'chrome\t100\t1048576\r\nnode\t200\t2097152\r\n';
    expect(parseProcLines(text)).toEqual([
      { name: 'chrome', workingSetBytes: 1_048_576 },
      { name: 'node', workingSetBytes: 2_097_152 },
    ]);
  });

  it('reads LF output and a last line without a newline', () => {
    expect(parseProcLines('a\t1\t10\nb\t2\t20')).toEqual([
      { name: 'a', workingSetBytes: 10 },
      { name: 'b', workingSetBytes: 20 },
    ]);
  });

  it('ignores garbage lines', () => {
    const text = ['', 'just words', 'one\ttwo', 'a\t1\t2\t3', '\t5\t6', 'ok\t7\t8', '   ', '#< CLIXML'].join('\n');
    expect(parseProcLines(text)).toEqual([{ name: 'ok', workingSetBytes: 8 }]);
  });

  it('ignores a non-numeric pid or working set', () => {
    const text = ['a\tx\t10', 'b\t2\tten', 'c\t-3\t10', 'd\t4\t-10', 'e\t5\t1.5', 'f\t6\t60'].join('\n');
    expect(parseProcLines(text)).toEqual([{ name: 'f', workingSetBytes: 60 }]);
  });

  it('reads 5,000 processes', () => {
    const text = Array.from(
      { length: 5000 },
      (_, i) => `p${String(i)}\t${String(i + 1)}\t${String((i + 1) * 4096)}`,
    ).join('\r\n');
    const entries = parseProcLines(text);
    expect(entries).toHaveLength(5000);
    expect(entries[4999]).toEqual({ name: 'p4999', workingSetBytes: 5000 * 4096 });
  });

  it('drops a byte order mark in front of the first line', () => {
    expect(parseProcLines('\uFEFFa\t1\t10\n')).toEqual([{ name: 'a', workingSetBytes: 10 }]);
  });
});

describe('the scripts', () => {
  it('are constants without any interpolation hole', () => {
    for (const script of [PROC_SCRIPT_NET, PROC_SCRIPT_CLM]) {
      expect(script).not.toContain('${');
      expect(script).toContain('WorkingSet64');
    }
    expect(PROC_SCRIPT_NET).toContain('GetProcesses()');
    expect(PROC_SCRIPT_CLM).toContain('Get-Process');
  });
});

describe('createWin32Lister', () => {
  it('runs the .NET script as an encoded command and parses the rows', async () => {
    const { exec, calls } = fakeExec([{ stdout: 'node\t1\t1048576\r\nCode\t2\t2097152\r\n' }]);
    const lister = createWin32Lister({ exec, timeoutMs: 10_000 });
    const out = await lister.load(signal);
    expect(out).toEqual({
      status: 'ok',
      value: [
        { name: 'node', workingSetBytes: 1_048_576 },
        { name: 'Code', workingSetBytes: 2_097_152 },
      ],
    });
    expect(calls).toHaveLength(1);
    const spec = calls[0];
    expect(spec?.kind).toBe('powershell.processes');
    expect(spec?.file).toBe(POWERSHELL);
    expect(spec?.args.slice(0, 5)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    expect(spec?.args[5]).toBe('-EncodedCommand');
    expect(decodeScript(spec)).toBe(PROC_SCRIPT_NET);
    expect(spec?.timeoutMs).toBe(10_000);
    expect(spec?.maxOutputBytes).toBe(2 * 1024 * 1024);
    expect(spec?.encoding).toBe('utf8');
    expect(lister.mode()).toBe('net');
  });

  it('switches to the Constrained Language script when stderr says core types too, and stays there', async () => {
    const { exec, calls } = fakeExec([
      { stdout: '', stderr: 'Method invocation is supported only on core types in this language mode.' },
      { stdout: 'node\t1\t100\n' },
    ]);
    const lister = createWin32Lister({ exec, timeoutMs: 10_000 });
    expect(await lister.load(signal)).toEqual({ status: 'ok', value: [{ name: 'node', workingSetBytes: 100 }] });
    expect(calls).toHaveLength(2);
    expect(decodeScript(calls[1])).toBe(PROC_SCRIPT_CLM);
    expect(calls[1]?.encoding).toBe('latin1');
    expect(lister.mode()).toBe('clm');
    await lister.load(signal);
    expect(calls).toHaveLength(3);
    expect(decodeScript(calls[2])).toBe(PROC_SCRIPT_CLM);
  });

  it('recognises the language mode wording in any letter case, also on a failed run', async () => {
    const { exec, calls } = fakeExec([
      { ok: false, code: 1, error: 'NONZERO_EXIT', stderr: 'Cannot use a Constrained LANGUAGE MODE here' },
      { stdout: 'a\t1\t5\n' },
    ]);
    const lister = createWin32Lister({ exec, timeoutMs: 10_000 });
    expect((await lister.load(signal)).status).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(lister.mode()).toBe('clm');
  });

  it('switches to the Constrained Language script when the real failure shape has no stderr at all', async () => {
    // Real PowerShell in Constrained Language Mode: SilentlyContinue hides the error, nothing is printed, the exit code is 1.
    const { exec, calls } = fakeExec([
      { ok: false, code: 1, error: 'NONZERO_EXIT', stderr: '', stdout: '' },
      { stdout: 'node\t1\t100\r\n' },
    ]);
    const lister = createWin32Lister({ exec, timeoutMs: 10_000 });
    expect(await lister.load(signal)).toEqual({ status: 'ok', value: [{ name: 'node', workingSetBytes: 100 }] });
    expect(calls).toHaveLength(2);
    expect(decodeScript(calls[0])).toBe(PROC_SCRIPT_NET);
    expect(decodeScript(calls[1])).toBe(PROC_SCRIPT_CLM);
    expect(lister.mode()).toBe('clm');
    await lister.load(signal);
    expect(calls).toHaveLength(3);
    expect(decodeScript(calls[2])).toBe(PROC_SCRIPT_CLM);
  });

  it('latches the fallback when a clean run lists nothing and the other script lists rows', async () => {
    const { exec, calls } = fakeExec([{ stdout: '' }, { stdout: 'a\t1\t5\n' }]);
    const lister = createWin32Lister({ exec, timeoutMs: 10_000 });
    expect((await lister.load(signal)).status).toBe('ok');
    expect(lister.mode()).toBe('clm');
    await lister.load(signal);
    expect(decodeScript(calls[2])).toBe(PROC_SCRIPT_CLM);
  });

  it('does not latch the fallback while neither script lists anything, and tries .NET again next time', async () => {
    const { exec, calls } = fakeExec([{ ok: false, code: 1, error: 'NONZERO_EXIT', stderr: '' }]);
    const lister = createWin32Lister({ exec, timeoutMs: 10_000 });
    expect((await lister.load(signal)).status).toBe('error');
    expect(lister.mode()).toBe('net');
    await lister.load(signal);
    expect(calls).toHaveLength(4);
    expect(decodeScript(calls[2])).toBe(PROC_SCRIPT_NET);
  });

  it('is an error with an empty list after both scripts', async () => {
    const { exec, calls } = fakeExec([{ stdout: 'garbage only\n' }]);
    const out = await createWin32Lister({ exec, timeoutMs: 10_000 }).load(signal);
    expect(out).toEqual({ status: 'error', message: 'process list was empty' });
    expect(calls).toHaveLength(2);
  });

  it.each(['ENOENT', 'EACCES'] as const)('is unavailable when PowerShell fails with %s', async (code) => {
    const { exec, calls } = fakeExec([{ ok: false, code: null, error: code }]);
    const out = await createWin32Lister({ exec, timeoutMs: 10_000 }).load(signal);
    expect(out).toEqual({
      status: 'unavailable',
      message: 'PowerShell is not available; per-process memory is disabled',
    });
    expect(calls).toHaveLength(1);
  });

  it('is unavailable when PowerShell cannot be resolved, without a spawn', async () => {
    const { exec, calls } = fakeExec([], null);
    const out = await createWin32Lister({ exec, timeoutMs: 10_000 }).load(signal);
    expect(out.status).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['TIMEOUT', 'the process list timed out'],
    ['OUTPUT_LIMIT', 'the process list output is too large'],
    ['QUEUE_FULL', 'too many child processes are running'],
    ['ABORTED', 'the process list was cancelled'],
  ] as const)('is an error on %s', async (code, message) => {
    const { exec, calls } = fakeExec([{ ok: false, code: null, error: code }]);
    const out = await createWin32Lister({ exec, timeoutMs: 10_000 }).load(signal);
    expect(out).toEqual({ status: 'error', message });
    expect(calls).toHaveLength(1);
  });

  it('reports a failed run with the first line of stderr only', async () => {
    const { exec } = fakeExec([
      { ok: false, code: 1, error: 'NONZERO_EXIT', stderr: '\r\nboom happened\r\nsecond line' },
    ]);
    const out = await createWin32Lister({ exec, timeoutMs: 10_000 }).load(signal);
    expect(out).toEqual({ status: 'error', message: 'boom happened' });
  });
});
