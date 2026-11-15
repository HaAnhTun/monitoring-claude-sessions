// Opening the login page (06 2.5): the search order of the browsers, the exact argument lists, the refusal of anything that is not
// a login URL, the spawn flags, the fallback to a tab and the test hook. Every program is a seam: no browser is ever started.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it, vi } from 'vitest';

import { appWindowArgs, findAppBrowser, openLoginUrl, type BrowserSeams } from './browser.ts';
import type { ChildResult, ChildSpec } from './exec.ts';

const makeTemp = useTempDirs();

const CODE = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
const LOGIN = `http://127.0.0.1:7690/#code=${CODE}`;
const PLAIN = 'http://127.0.0.1:7690/';
const PROFILE = 'C:\\Users\\sample\\AppData\\Local\\mcs\\instances\\user\\run\\browser-profile';
const EDGE_X86 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_PF = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PF = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_LOCAL = 'C:\\Users\\sample\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const EXPLORER = 'C:\\Windows\\explorer.exe';

const WIN_ENV = {
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\sample\\AppData\\Local',
  PATH: 'C:\\Windows\\System32',
  USERPROFILE: 'C:\\Users\\sample',
};

function result(over: Partial<ChildResult> = {}): ChildResult {
  return { ok: true, code: 0, stdout: '', stderr: '', error: null, truncated: false, durationMs: 1, ...over };
}

function fakeChild(pid: number | undefined): ChildProcess {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { pid }) as unknown as ChildProcess;
}

interface Calls {
  spawned: { file: string; args: readonly string[]; env: Record<string, string> }[];
  executed: ChildSpec[];
  checked: string[];
  appended: { file: string; text: string }[];
}

/** Seams for a Windows machine that has `installed` and whose opener answers `exec`. */
function seams(
  installed: readonly string[],
  over: { exec?: ChildResult; pid?: number | undefined; opener?: string | null; env?: BrowserSeams['env'] } = {},
): { seams: BrowserSeams; calls: Calls } {
  const calls: Calls = { spawned: [], executed: [], checked: [], appended: [] };
  const present = new Set(installed.map((file) => file.toLowerCase()));
  return {
    calls,
    seams: {
      platform: 'win32',
      env: over.env ?? WIN_ENV,
      isFile: (file) => {
        calls.checked.push(file);
        return Promise.resolve(present.has(file.toLowerCase()));
      },
      resolveExecutable: (name) =>
        Promise.resolve(name === 'opener' ? (over.opener === undefined ? EXPLORER : over.opener) : null),
      execFileText: (spec) => {
        calls.executed.push(spec);
        return Promise.resolve(over.exec ?? result());
      },
      spawnVisible: (file, args, options) => {
        calls.spawned.push({ file, args: [...args], env: options.env });
        return fakeChild('pid' in over ? over.pid : 4242);
      },
      appendFile: (file, text) => {
        calls.appended.push({ file, text });
        return Promise.resolve();
      },
    },
  };
}

describe('findAppBrowser: the search order (TC-LIF-browser-order)', () => {
  it('prefers Edge to Chrome whichever folder holds which, and the folders in the order x86, program files, local', async () => {
    expect(await findAppBrowser(seams([EDGE_X86, EDGE_PF, CHROME_PF]).seams)).toEqual({ kind: 'edge', file: EDGE_X86 });
    expect(await findAppBrowser(seams([EDGE_PF, CHROME_PF]).seams)).toEqual({ kind: 'edge', file: EDGE_PF });
    expect(await findAppBrowser(seams([CHROME_LOCAL, CHROME_PF, EDGE_PF]).seams)).toEqual({
      kind: 'edge',
      file: EDGE_PF,
    });
    expect(await findAppBrowser(seams([CHROME_LOCAL, CHROME_PF]).seams)).toEqual({ kind: 'chrome', file: CHROME_PF });
    expect(await findAppBrowser(seams([CHROME_LOCAL]).seams)).toEqual({ kind: 'chrome', file: CHROME_LOCAL });
  });

  it('looks for msedge.exe and then chrome.exe on PATH when no install folder has one', async () => {
    const env = { ...WIN_ENV, PATH: 'C:\\tools;C:\\more' };
    const onPath = await findAppBrowser(seams(['C:\\more\\msedge.exe', 'C:\\tools\\chrome.exe'], { env }).seams);
    expect(onPath).toEqual({ kind: 'edge', file: 'C:\\more\\msedge.exe' });
    const chrome = await findAppBrowser(seams(['C:\\tools\\chrome.exe'], { env }).seams);
    expect(chrome).toEqual({ kind: 'chrome', file: 'C:\\tools\\chrome.exe' });
  });

  it('ignores a relative or empty entry of PATH and a relative or empty root', async () => {
    const env = { ...WIN_ENV, PATH: 'tools;;"C:\\quoted"', LOCALAPPDATA: 'relative', ProgramFiles: '' };
    const { seams: s, calls } = seams(['tools\\msedge.exe', 'C:\\quoted\\chrome.exe'], { env });
    expect(await findAppBrowser(s)).toEqual({ kind: 'chrome', file: 'C:\\quoted\\chrome.exe' });
    expect(calls.checked.every((file) => path.win32.isAbsolute(file))).toBe(true);
  });

  it('is null when there is none, and always null off Windows', async () => {
    expect(await findAppBrowser(seams([]).seams)).toBeNull();
    expect(await findAppBrowser(seams([], { env: {} }).seams)).toBeNull();
    for (const platform of ['linux', 'darwin', 'other'] as const) {
      const { seams: s, calls } = seams([EDGE_PF]);
      expect(await findAppBrowser({ ...s, platform })).toBeNull();
      expect(calls.checked).toEqual([]);
    }
  });
});

describe('appWindowArgs', () => {
  it('is exactly the page, the profile, the size and the two no-first-run flags, in that order', () => {
    expect(appWindowArgs(LOGIN, PROFILE)).toEqual([
      `--app=${LOGIN}`,
      `--user-data-dir=${PROFILE}`,
      '--window-size=1440,900',
      '--no-first-run',
      '--no-default-browser-check',
    ]);
  });
});

describe('openLoginUrl: only a login URL reaches a program (TC-LIF-browser-url)', () => {
  const BAD: readonly string[] = [
    '',
    'http://localhost:7690/',
    'http://127.0.0.1:7690',
    'http://127.0.0.1:7690/index.html',
    'http://127.0.0.1:7690/?x=1',
    'http://127.0.0.1:7690/#access=' + CODE,
    `http://127.0.0.1:7690/#code=${CODE}&x=1`,
    'http://127.0.0.1:7690/#code=short',
    `http://127.0.0.1:7690/#code=${CODE.slice(0, 20)}!${CODE.slice(21)}`,
    `https://127.0.0.1:7690/#code=${CODE}`,
    `http://127.0.0.1:70000/#code=${CODE}`,
    `http://127.0.0.1:0/#code=${CODE}`,
    `http://127.0.0.1:7690/#code=${CODE}\n`,
    `http://127.0.0.1:7690/#code=${CODE} --disable-web-security`,
    `${PLAIN} --user-data-dir=C:\\x`,
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'http://evil.example/',
    'http://127.0.0.1@evil.example:7690/',
    'C:\\Windows\\System32\\calc.exe',
  ];

  it.each(BAD)('refuses %j with bad-url before any program, probe or file is touched', async (url) => {
    for (const mode of ['window', 'tab'] as const) {
      const { seams: s, calls } = seams([EDGE_PF]);
      expect(await openLoginUrl({ url, mode, profileDir: PROFILE }, s)).toEqual({ opened: false, reason: 'bad-url' });
      expect(calls.spawned).toEqual([]);
      expect(calls.executed).toEqual([]);
      expect(calls.checked).toEqual([]);
      expect(calls.appended).toEqual([]);
    }
  });

  it('refuses a value that is not a string', async () => {
    const outcome = await openLoginUrl(
      { url: undefined as unknown as string, mode: 'tab', profileDir: PROFILE },
      seams([]).seams,
    );
    expect(outcome).toEqual({ opened: false, reason: 'bad-url' });
  });

  it('accepts the page with a code and the page without one, and any real port', async () => {
    for (const url of [LOGIN, PLAIN, 'http://127.0.0.1:1/', 'http://127.0.0.1:65535/']) {
      const { seams: s, calls } = seams([]);
      expect(await openLoginUrl({ url, mode: 'tab', profileDir: PROFILE }, s)).toEqual({
        opened: true,
        how: 'default-browser',
      });
      expect(calls.executed.map((spec) => spec.args)).toEqual([[url]]);
    }
  });
});

describe('openLoginUrl: the app window (TC-LIF-browser-window)', () => {
  it('starts Edge with the exact arguments, as an app window, and says so', async () => {
    const { seams: s, calls } = seams([EDGE_PF, CHROME_PF]);
    expect(await openLoginUrl({ url: LOGIN, mode: 'window', profileDir: PROFILE }, s)).toEqual({
      opened: true,
      how: 'app-window',
    });
    expect(calls.spawned).toHaveLength(1);
    expect(calls.spawned[0]?.file).toBe(EDGE_PF);
    expect(calls.spawned[0]?.args).toEqual(appWindowArgs(LOGIN, PROFILE));
    expect(calls.executed).toEqual([]);
  });

  it('starts Chrome when Edge is not there', async () => {
    const { seams: s, calls } = seams([CHROME_PF]);
    await openLoginUrl({ url: PLAIN, mode: 'window', profileDir: PROFILE }, s);
    expect(calls.spawned.map((call) => call.file)).toEqual([CHROME_PF]);
  });

  it('gives the browser the environment of the caller without the settings of this product', async () => {
    const env = { ...WIN_ENV, MCS_HOME: 'C:\\somewhere', CAW_HOME: 'C:\\other', mcs_test: '1', UNSET: undefined };
    const { seams: s, calls } = seams([EDGE_PF], { env });
    await openLoginUrl({ url: LOGIN, mode: 'window', profileDir: PROFILE }, s);
    const passed = calls.spawned[0]?.env ?? {};
    expect(passed['USERPROFILE']).toBe(WIN_ENV.USERPROFILE);
    expect(passed['LOCALAPPDATA']).toBe(WIN_ENV.LOCALAPPDATA);
    expect(Object.keys(passed).filter((name) => /^(mcs|caw)_/i.test(name))).toEqual([]);
    expect('UNSET' in passed).toBe(false);
  });

  it('falls back to a tab, naming the reason, when there is no Edge or Chrome', async () => {
    const { seams: s, calls } = seams([]);
    expect(await openLoginUrl({ url: LOGIN, mode: 'window', profileDir: PROFILE }, s)).toEqual({
      opened: true,
      how: 'default-browser',
      fallback: 'no-browser',
    });
    expect(calls.spawned).toEqual([]);
    expect(calls.executed.map((spec) => spec.args)).toEqual([[LOGIN]]);
  });

  it('falls back to a tab when the window did not start (no process id)', async () => {
    const { seams: s, calls } = seams([EDGE_PF], { pid: undefined });
    expect(await openLoginUrl({ url: LOGIN, mode: 'window', profileDir: PROFILE }, s)).toEqual({
      opened: true,
      how: 'default-browser',
      fallback: 'spawn-failed',
    });
    expect(calls.executed).toHaveLength(1);
  });

  it('the failure of the tab after a fallback is the failure of the call', async () => {
    const { seams: s } = seams([], { exec: result({ ok: false, code: 5, error: 'NONZERO_EXIT' }) });
    expect(await openLoginUrl({ url: LOGIN, mode: 'window', profileDir: PROFILE }, s)).toEqual({
      opened: false,
      reason: 'spawn-failed',
    });
  });

  it('a window off Windows is a tab with the reason no-browser', async () => {
    const { seams: s } = seams([EDGE_PF], { opener: '/usr/bin/xdg-open' });
    expect(
      await openLoginUrl(
        { url: PLAIN, mode: 'window', profileDir: '/home/sample/profile' },
        { ...s, platform: 'linux' },
      ),
    ).toEqual({
      opened: true,
      how: 'default-browser',
      fallback: 'no-browser',
    });
  });

  it('a profile folder that is not absolute is a programming error, not a fallback', async () => {
    await expect(
      openLoginUrl({ url: LOGIN, mode: 'window', profileDir: 'relative\\profile' }, seams([EDGE_PF]).seams),
    ).rejects.toThrow(RangeError);
  });

  it('swallows the error event of a child that never started, so the process does not end', async () => {
    const child = fakeChild(undefined);
    const s: BrowserSeams = { ...seams([EDGE_PF]).seams, spawnVisible: () => child };
    await openLoginUrl({ url: LOGIN, mode: 'window', profileDir: PROFILE }, s);
    expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow();
  });
});

describe('openLoginUrl: the tab (TC-LIF-browser-tab)', () => {
  it('asks the desktop opener with the whole URL, fragment included, as one argument', async () => {
    const { seams: s, calls } = seams([EDGE_PF]);
    expect(await openLoginUrl({ url: LOGIN, mode: 'tab', profileDir: PROFILE }, s)).toEqual({
      opened: true,
      how: 'default-browser',
    });
    expect(calls.executed).toHaveLength(1);
    expect(calls.executed[0]).toMatchObject({
      kind: 'opener',
      file: EXPLORER,
      args: [LOGIN],
      timeoutMs: 10_000,
      encoding: 'utf8',
    });
    expect(calls.executed[0]?.extraEnv).toBeUndefined();
    expect(calls.spawned).toEqual([]);
    expect(calls.checked).toEqual([]);
  });

  it('counts exit code 1 as success, like explorer.exe answers when the page opened', async () => {
    const { seams: s } = seams([], { exec: result({ ok: false, code: 1, error: 'NONZERO_EXIT' }) });
    expect(await openLoginUrl({ url: PLAIN, mode: 'tab', profileDir: PROFILE }, s)).toEqual({
      opened: true,
      how: 'default-browser',
    });
  });

  it('any other failure of the opener is spawn-failed', async () => {
    for (const exec of [
      result({ ok: false, code: 2, error: 'NONZERO_EXIT' }),
      result({ ok: false, code: null, error: 'TIMEOUT' }),
      result({ ok: false, code: null, error: 'ENOENT' }),
      result({ ok: false, code: null, error: 'SPAWN_FAILED' }),
    ]) {
      expect(await openLoginUrl({ url: PLAIN, mode: 'tab', profileDir: PROFILE }, seams([], { exec }).seams)).toEqual({
        opened: false,
        reason: 'spawn-failed',
      });
    }
  });

  it('is unsupported where there is no desktop opener', async () => {
    const { seams: s, calls } = seams([], { opener: null });
    expect(await openLoginUrl({ url: PLAIN, mode: 'tab', profileDir: PROFILE }, s)).toEqual({
      opened: false,
      reason: 'unsupported',
    });
    expect(calls.executed).toEqual([]);
  });
});

describe('openLoginUrl: the test hook MCS_TEST_OPEN_FILE', () => {
  const hookEnv = (file: string, test = '1'): Record<string, string> => ({
    ...WIN_ENV,
    MCS_TEST: test,
    MCS_TEST_OPEN_FILE: file,
  });

  it('appends the URL and a newline to the file and starts nothing, in both modes', async () => {
    const dir = makeTemp('browser-hook').path;
    const file = path.join(dir, 'opened.txt');
    for (const mode of ['window', 'tab'] as const) {
      const { seams: s, calls } = seams([EDGE_PF], { env: hookEnv(file) });
      // the real append of the module writes the file: leave that seam out
      const withoutAppend = Object.fromEntries(
        Object.entries(s).filter(([name]) => name !== 'appendFile'),
      ) as BrowserSeams;
      expect(await openLoginUrl({ url: LOGIN, mode, profileDir: PROFILE }, withoutAppend)).toEqual({
        opened: true,
        how: 'test-file',
      });
      expect(calls.spawned).toEqual([]);
      expect(calls.executed).toEqual([]);
      expect(calls.checked).toEqual([]);
    }
    expect(readFileSync(file, 'utf8')).toBe(`${LOGIN}\n${LOGIN}\n`);
  });

  it('is inert unless MCS_TEST is exactly 1: the real way of opening is used', async () => {
    const dir = makeTemp('browser-hook').path;
    const { seams: s, calls } = seams([], { env: hookEnv(path.join(dir, 'opened.txt'), 'true') });
    await openLoginUrl({ url: PLAIN, mode: 'tab', profileDir: PROFILE }, s);
    expect(calls.appended).toEqual([]);
    expect(calls.executed).toHaveLength(1);
  });

  it('a relative path or an unwritable file is spawn-failed, and never a real browser', async () => {
    const relative = seams([EDGE_PF], { env: hookEnv('opened.txt') });
    expect(await openLoginUrl({ url: PLAIN, mode: 'window', profileDir: PROFILE }, relative.seams)).toEqual({
      opened: false,
      reason: 'spawn-failed',
    });
    expect(relative.calls.spawned).toEqual([]);
    expect(relative.calls.executed).toEqual([]);

    const failing = seams([EDGE_PF], { env: hookEnv(path.join(makeTemp('browser-hook').path, 'opened.txt')) });
    const append = vi.fn(() => Promise.reject(new Error('disk full')));
    expect(
      await openLoginUrl({ url: PLAIN, mode: 'window', profileDir: PROFILE }, { ...failing.seams, appendFile: append }),
    ).toEqual({
      opened: false,
      reason: 'spawn-failed',
    });
    expect(failing.calls.spawned).toEqual([]);
  });

  it('a bad URL never reaches the file', async () => {
    const file = path.join(makeTemp('browser-hook').path, 'opened.txt');
    const { seams: s, calls } = seams([], { env: hookEnv(file) });
    expect(await openLoginUrl({ url: 'http://evil.example/', mode: 'tab', profileDir: PROFILE }, s)).toEqual({
      opened: false,
      reason: 'bad-url',
    });
    expect(calls.appended).toEqual([]);
  });
});
