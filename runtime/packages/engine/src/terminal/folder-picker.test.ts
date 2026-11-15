// The folder picker (CAW-31, design 02 section 8): the one constant PowerShell script, one dialog at a time, an abort that ends the
// child, and an answer that is checked before it is used. The unit cases script `execFileText`; the last block runs the real
// `fake-picker.mjs` of the testkit through the hook, with the real child runner (a Node process, no dialog).
import path from 'node:path';

import { fakeClaudeInvocation } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { execFileText, type ChildResult, type ChildSpec } from '../platform/exec.ts';
import {
  PICKER_OUTPUT_MAX_BYTES,
  PICKER_SCRIPT,
  PICKER_TIMEOUT_MS,
  createFolderPicker,
  parsePickedFolder,
  type FolderPickerPort,
} from './folder-picker.ts';
import { TerminalApiError } from './host.ts';

// FIXTURE: invented paths. The child runner is a script, so nothing starts in the unit cases.
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const FOLDER = 'D:\\FIXTURE-work\\proj';

function result(over: Partial<ChildResult> = {}): ChildResult {
  return { ok: true, code: 0, stdout: '', stderr: '', error: null, truncated: false, durationMs: 1, ...over };
}

interface Call {
  readonly spec: ChildSpec;
  readonly signal: AbortSignal | undefined;
}

interface Rig {
  readonly picker: FolderPickerPort;
  readonly calls: Call[];
}

function rig(
  o: {
    answers?: (ChildResult | Promise<ChildResult>)[];
    platform?: 'win32' | 'linux';
    powershell?: string | null;
    env?: Record<string, string | undefined>;
  } = {},
): Rig {
  const calls: Call[] = [];
  const answers = o.answers ?? [result({ stdout: `${FOLDER}\r\n` })];
  const picker = createFolderPicker({
    platform: o.platform ?? 'win32',
    env: o.env ?? {},
    exec: (spec, signal) => {
      calls.push({ spec, signal });
      // the last answer repeats
      return Promise.resolve(answers[Math.min(calls.length - 1, answers.length - 1)] ?? result());
    },
    resolvePowershell: () => Promise.resolve(o.powershell === undefined ? POWERSHELL : o.powershell),
  });
  if (picker === null) throw new Error('expected a picker');
  return { picker, calls };
}

async function failure(promise: Promise<unknown>): Promise<TerminalApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TerminalApiError) return error;
    throw error;
  }
  throw new Error('expected the call to reject with a TerminalApiError');
}

function decodedScript(spec: ChildSpec): string {
  const at = spec.args.indexOf('-EncodedCommand');
  const encoded = spec.args[at + 1];
  if (at < 0 || encoded === undefined) throw new Error('no -EncodedCommand');
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

describe('createFolderPicker: where there is a dialog', () => {
  it('has none on a platform without the Windows dialog, unless the test hook names a script', () => {
    expect(createFolderPicker({ platform: 'linux', env: {} })).toBeNull();
    expect(createFolderPicker({ platform: 'darwin', env: {} })).toBeNull();
    expect(createFolderPicker({ platform: 'win32', env: {} })).not.toBeNull();
    const hooked = { MCS_TEST: '1', MCS_TEST_FOLDER_PICKER: '/FIXTURE/fake-picker.mjs' };
    expect(createFolderPicker({ platform: 'linux', env: hooked })).not.toBeNull();
    expect(
      createFolderPicker({ platform: 'linux', env: { MCS_TEST_FOLDER_PICKER: '/FIXTURE/fake-picker.mjs' } }),
    ).toBeNull();
  });
});

describe('the constant script (kind powershell.picker)', () => {
  it('runs Windows PowerShell with -STA and one -EncodedCommand, in a hidden console, with a timeout and an output cap', async () => {
    const r = rig();
    expect(await r.picker.pick(new AbortController().signal)).toBe(FOLDER);
    const { spec } = r.calls[0] ?? { spec: undefined };
    expect(spec?.kind).toBe('powershell.picker');
    expect(spec?.file).toBe(POWERSHELL);
    expect(spec?.args[0]).toBe('-STA');
    expect(spec?.args.filter((arg) => arg === '-EncodedCommand')).toHaveLength(1);
    expect(spec?.timeoutMs).toBe(PICKER_TIMEOUT_MS);
    expect(spec?.maxOutputBytes).toBe(PICKER_OUTPUT_MAX_BYTES);
    expect(spec?.encoding).toBe('utf8');
    expect(spec?.extraEnv).toBeUndefined();
  });

  it('is the same script on every call: no path, name, key or answer is ever inside it', async () => {
    const r = rig({
      env: { MCS_TEST: '', FAKE_PICKER_RESULT: 'D:\\FIXTURE-secret\\answer', USERPROFILE: 'C:\\Users\\FIXTURE' },
    });
    await r.picker.pick(new AbortController().signal);
    await r.picker.pick(new AbortController().signal);
    const [first, second] = r.calls;
    if (first === undefined || second === undefined) throw new Error('two calls expected');
    expect(first.spec.args).toEqual(second.spec.args);
    const script = decodedScript(first.spec);
    expect(script).toBe(PICKER_SCRIPT);
    expect(script).not.toContain('FIXTURE');
    expect(script).not.toContain('D:\\');
  });

  it('shows the folder dialog of WinForms in front of other windows and loads the assembly only (no code is compiled)', () => {
    expect(PICKER_SCRIPT).toContain('Add-Type -AssemblyName System.Windows.Forms');
    expect(PICKER_SCRIPT).toContain('FolderBrowserDialog');
    expect(PICKER_SCRIPT).toContain('TopMost');
    expect(PICKER_SCRIPT.match(/Add-Type/g)).toHaveLength(1);
    expect(PICKER_SCRIPT).not.toMatch(/-(?:Type|Member)Definition/i);
  });

  it('writes the answer as UTF-8 without a byte order mark, so a folder with accents arrives intact', () => {
    expect(PICKER_SCRIPT).toContain('UTF8Encoding($false)');
    // the bytes go straight to the pipe: the code page of the hidden console is never consulted
    expect(PICKER_SCRIPT).toContain('OpenStandardOutput');
    expect(PICKER_SCRIPT).not.toContain('OutputEncoding');
  });

  it('is unavailable (terminal_unavailable) when Windows PowerShell cannot be found', async () => {
    const r = rig({ powershell: null });
    expect((await failure(r.picker.pick(new AbortController().signal))).code).toBe('terminal_unavailable');
    expect(r.calls).toHaveLength(0);
  });
});

describe('the answer', () => {
  it('is the folder on one line, normalised', async () => {
    const r = rig({ answers: [result({ stdout: 'd:/FIXTURE-work/proj/\r\n' })] });
    expect(await r.picker.pick(new AbortController().signal)).toBe('D:\\FIXTURE-work\\proj');
  });

  it('keeps accents and spaces', async () => {
    const r = rig({ answers: [result({ stdout: 'D:\\FIXTURE work\\R\u00e9sum\u00e9\n' })] });
    expect(await r.picker.pick(new AbortController().signal)).toBe('D:\\FIXTURE work\\R\u00e9sum\u00e9');
  });

  it('ignores a byte order mark in front of the line', async () => {
    const r = rig({ answers: [result({ stdout: `\ufeff${FOLDER}\r\n` })] });
    expect(await r.picker.pick(new AbortController().signal)).toBe(FOLDER);
  });

  it('is null when the dialog was closed (nothing, or only a line break, on stdout)', async () => {
    for (const stdout of ['', '\n', '\r\n', '  \r\n']) {
      const r = rig({ answers: [result({ stdout })] });
      expect(await r.picker.pick(new AbortController().signal), JSON.stringify(stdout)).toBeNull();
    }
  });

  it.each([
    ['two lines', `${FOLDER}\r\nD:\\FIXTURE-other\r\n`, 'not_one_line'],
    ['a line of junk before the answer', `junk\r\n${FOLDER}\r\n`, 'not_one_line'],
    ['a NUL in the line', 'D:\\FIXTURE\\with\u0000nul\r\n', 'control'],
    ['a UNC path of another machine', '\\\\attacker\\share\r\n', 'unc'],
    ['a UNC path with forward slashes', '//attacker/share\r\n', 'unc'],
    ['a device path', '\\\\?\\C:\\FIXTURE\r\n', 'device'],
    ['a relative path', 'FIXTURE\\proj\r\n', 'relative'],
    ['a drive-relative path', 'D:proj\r\n', 'relative'],
    ['an alternate data stream', 'D:\\FIXTURE:evil\r\n', 'stream'],
    ['a reserved device name', 'D:\\FIXTURE\\NUL\r\n', 'reserved_name'],
    ['a path longer than a Windows path', `D:\\${'a'.repeat(300)}\r\n`, 'too_long'],
  ])('refuses %s with folder_invalid and the reason, never the text', async (_name, stdout, issue) => {
    const r = rig({ answers: [result({ stdout })] });
    const error = await failure(r.picker.pick(new AbortController().signal));
    expect(error.code).toBe('folder_invalid');
    expect(error.details).toEqual([{ path: 'path', issue }]);
    expect(error.message).not.toContain('FIXTURE');
    expect(error.message).not.toContain('attacker');
  });

  it('refuses an output that hit the cap (a runaway dialog) with folder_invalid', async () => {
    const r = rig({
      answers: [result({ ok: false, code: null, error: 'OUTPUT_LIMIT', truncated: true, stdout: 'x'.repeat(10) })],
    });
    const error = await failure(r.picker.pick(new AbortController().signal));
    expect(error.code).toBe('folder_invalid');
    expect(error.details).toEqual([{ path: 'path', issue: 'too_long' }]);
  });

  it.each([
    ['a failed dialog (exit 1)', result({ ok: false, code: 1, error: 'NONZERO_EXIT', stderr: 'boom' })],
    ['a dialog nobody answered (timeout)', result({ ok: false, code: null, error: 'TIMEOUT' })],
    ['a program that cannot start', result({ ok: false, code: null, error: 'ENOENT' })],
    ['a full queue of children', result({ ok: false, code: null, error: 'QUEUE_FULL' })],
  ])('is terminal_unavailable for %s, and says nothing of what the child wrote', async (_name, answer) => {
    const r = rig({ answers: [answer] });
    const error = await failure(r.picker.pick(new AbortController().signal));
    expect(error.code).toBe('terminal_unavailable');
    expect(error.message).not.toContain('boom');
  });
});

describe('parsePickedFolder', () => {
  it('answers a path, a cancel or an issue', () => {
    expect(parsePickedFolder(`${FOLDER}\r\n`)).toEqual({ kind: 'path', path: FOLDER });
    expect(parsePickedFolder('')).toEqual({ kind: 'cancelled' });
    expect(parsePickedFolder('\\\\h\\s\n')).toEqual({ kind: 'invalid', issue: 'unc' });
    expect(parsePickedFolder('a\nb\n')).toEqual({ kind: 'invalid', issue: 'not_one_line' });
  });
});

describe('one dialog at a time (picker_busy)', () => {
  it('refuses a second pick while the first waits, and works again once it has settled', async () => {
    let finish: (value: ChildResult) => void = () => undefined;
    const waiting = new Promise<ChildResult>((resolve) => {
      finish = resolve;
    });
    const r = rig({ answers: [waiting, result({ stdout: `${FOLDER}\n` })] });
    const first = r.picker.pick(new AbortController().signal);
    const second = failure(r.picker.pick(new AbortController().signal));
    expect((await second).code).toBe('picker_busy');
    expect(r.calls).toHaveLength(1);
    finish(result({ stdout: `${FOLDER}\n` }));
    expect(await first).toBe(FOLDER);
    expect(await r.picker.pick(new AbortController().signal)).toBe(FOLDER);
  });

  it('is busy from the very call, before any await (two calls in one tick)', async () => {
    const r = rig();
    const signal = new AbortController().signal;
    const results = await Promise.allSettled([r.picker.pick(signal), r.picker.pick(signal)]);
    expect(results.map((entry) => entry.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('frees the dialog after a failure too', async () => {
    const r = rig({
      answers: [result({ ok: false, code: 1, error: 'NONZERO_EXIT' }), result({ stdout: `${FOLDER}\n` })],
    });
    expect((await failure(r.picker.pick(new AbortController().signal))).code).toBe('terminal_unavailable');
    expect(await r.picker.pick(new AbortController().signal)).toBe(FOLDER);
  });
});

describe('abort', () => {
  it('hands the signal to the child runner, which ends the child, and answers null; the dialog is free again', async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const picker = createFolderPicker({
      platform: 'win32',
      env: {},
      resolvePowershell: () => Promise.resolve(POWERSHELL),
      exec: (_spec, signal) => {
        seen.push(signal);
        if (seen.length > 1)
          return Promise.resolve(
            result({
              stdout: `${FOLDER}
`,
            }),
          );
        return new Promise<ChildResult>((resolve) => {
          signal?.addEventListener('abort', () => {
            resolve(result({ ok: false, code: null, error: 'ABORTED' }));
          });
        });
      },
    });
    if (picker === null) throw new Error('expected a picker');
    const pending = picker.pick(controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen[0]).toBe(controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    expect(await picker.pick(new AbortController().signal)).toBe(FOLDER);
  });

  it('starts nothing when the signal was already aborted', async () => {
    const r = rig();
    const controller = new AbortController();
    controller.abort();
    expect(await r.picker.pick(controller.signal)).toBeNull();
    expect(r.calls).toHaveLength(0);
  });
});

describe('the test hook: the fake picker of the testkit instead of PowerShell', () => {
  const SCRIPT = '/FIXTURE/testkit/assets/fake-picker.mjs';

  it('runs Node on the script, gives it the answer variable and nothing else, and never PowerShell', async () => {
    const r = rig({
      platform: 'linux',
      env: { MCS_TEST: '1', MCS_TEST_FOLDER_PICKER: SCRIPT, FAKE_PICKER_RESULT: FOLDER, SECRET_TOKEN: 'FIXTURE-token' },
    });
    expect(await r.picker.pick(new AbortController().signal)).toBe(FOLDER);
    const spec = r.calls[0]?.spec;
    expect(spec?.kind).toBe('powershell.picker');
    expect(spec?.file).toBe(process.execPath);
    expect(spec?.args).toEqual([SCRIPT]);
    expect(spec?.extraEnv).toEqual({ FAKE_PICKER_RESULT: FOLDER });
  });

  it('is ignored outside test mode: the real dialog is used', async () => {
    const r = rig({ env: { MCS_TEST_FOLDER_PICKER: SCRIPT, FAKE_PICKER_RESULT: FOLDER } });
    await r.picker.pick(new AbortController().signal);
    expect(r.calls[0]?.spec.file).toBe(POWERSHELL);
  });
});

describe('the real fake picker through the hook (a Node process, no dialog)', () => {
  const invocation = fakeClaudeInvocation();
  const script = path.join(path.dirname(invocation.args[0] ?? ''), 'fake-picker.mjs');

  function real(answer: string | undefined): FolderPickerPort {
    const picker = createFolderPicker({
      platform: 'linux',
      env: {
        MCS_TEST: '1',
        MCS_TEST_FOLDER_PICKER: script,
        ...(answer === undefined ? {} : { FAKE_PICKER_RESULT: answer }),
      },
      exec: execFileText,
    });
    if (picker === null) throw new Error('expected a picker');
    return picker;
  }

  it('returns the folder it printed', async () => {
    expect(await real('D:\\FIXTURE-projects\\alpha').pick(new AbortController().signal)).toBe(
      'D:\\FIXTURE-projects\\alpha',
    );
  });

  it('returns null for a cancel (nothing printed, or no answer variable at all)', async () => {
    expect(await real('').pick(new AbortController().signal)).toBeNull();
    expect(await real(undefined).pick(new AbortController().signal)).toBeNull();
  });

  it('is terminal_unavailable when the dialog fails (exit 1, junk on stderr)', async () => {
    const error = await failure(real('!error').pick(new AbortController().signal));
    expect(error.code).toBe('terminal_unavailable');
    expect(error.message).not.toContain('FAKE-PICKER');
  });

  it('refuses junk output (several lines, a NUL, a line of 100 KB) without using any of it', async () => {
    const error = await failure(real('!junk').pick(new AbortController().signal));
    expect(error.code).toBe('folder_invalid');
  });

  it('refuses a UNC path of another machine', async () => {
    const error = await failure(real('!unc').pick(new AbortController().signal));
    expect(error.code).toBe('folder_invalid');
    expect(error.details).toEqual([{ path: 'path', issue: 'unc' }]);
  });

  it('ends a dialog nobody answers when the client leaves, and the next pick works', async () => {
    const picker = real('!hang');
    const controller = new AbortController();
    const pending = picker.pick(controller.signal);
    const busy = await failure(picker.pick(new AbortController().signal));
    expect(busy.code).toBe('picker_busy');
    controller.abort();
    expect(await pending).toBeNull();
  });
});
