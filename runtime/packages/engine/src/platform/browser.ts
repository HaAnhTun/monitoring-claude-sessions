// Opening the login page (06 2.5; MTOP `find_browser` and `open_window`). Two ways: a tab of the default browser (through the
// desktop opener, `explorer.exe` on Windows) or an Edge or Chrome app window with a profile of its own. The URL must have the
// exact shape of a login URL before any program sees it, so nothing from a file or the network ever reaches an argument list.
// The URL can carry the one-time access code: it is never logged and never part of an error.
import { appendFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { LOGIN_URL_RE } from '@mcs/shared/protocol';

import { testHook } from '../runtime/test-hooks.ts';
import { execFileText, resolveExecutable, spawnDetachedVisible } from './exec.ts';
import { hostPlatform, type HostPlatform } from './host.ts';

/** The child of an app window, as `spawnDetachedVisible` returns it (this module never imports `node:child_process`). */
type VisibleChild = ReturnType<typeof spawnDetachedVisible>;

export type BrowserKind = 'edge' | 'chrome';

export interface AppBrowser {
  readonly kind: BrowserKind;
  /** Absolute path of the `.exe`. */
  readonly file: string;
}

/** The ways a call can fail to show the page: the URL is not a login URL, there is nothing to open it with, or it did not start. */
export type OpenFailure = 'no-browser' | 'spawn-failed' | 'unsupported' | 'bad-url';

export type OpenOutcome =
  | {
      readonly opened: true;
      readonly how: 'app-window' | 'default-browser' | 'test-file';
      /** A window was asked for and the page opened as a tab instead; the caller prints a warning. */
      readonly fallback?: 'no-browser' | 'spawn-failed';
    }
  | { readonly opened: false; readonly reason: OpenFailure };

/** Everything that touches the machine, replaceable in tests. */
export interface BrowserSeams {
  readonly platform?: HostPlatform;
  /** Default: the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** True when the path is a file. */
  readonly isFile?: (file: string) => Promise<boolean>;
  readonly resolveExecutable?: typeof resolveExecutable;
  readonly execFileText?: typeof execFileText;
  readonly spawnVisible?: typeof spawnDetachedVisible;
  readonly appendFile?: (file: string, text: string) => Promise<void>;
}

const APP_BROWSERS: readonly { readonly kind: BrowserKind; readonly relative: string; readonly onPath: string }[] = [
  { kind: 'edge', relative: path.win32.join('Microsoft', 'Edge', 'Application', 'msedge.exe'), onPath: 'msedge.exe' },
  { kind: 'chrome', relative: path.win32.join('Google', 'Chrome', 'Application', 'chrome.exe'), onPath: 'chrome.exe' },
];
const ROOT_VARIABLES = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'] as const;
const OPEN_TIMEOUT_MS = 10_000;

async function realIsFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Edge first, then Chrome; the install folders `%ProgramFiles(x86)%`, `%ProgramFiles%` and `%LOCALAPPDATA%` in that order, then
 * `msedge.exe` and `chrome.exe` on `PATH` (absolute entries only). Windows only: `null` elsewhere and when neither is found.
 */
export async function findAppBrowser(seams: BrowserSeams = {}): Promise<AppBrowser | null> {
  if ((seams.platform ?? hostPlatform) !== 'win32') return null;
  const env = seams.env ?? process.env;
  const isFile = seams.isFile ?? realIsFile;
  const roots: string[] = [];
  for (const name of ROOT_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value !== '' && path.win32.isAbsolute(value)) roots.push(value);
  }
  for (const { kind, relative } of APP_BROWSERS) {
    for (const root of roots) {
      const file = path.win32.join(root, relative);
      if (await isFile(file)) return { kind, file };
    }
  }
  const searchPath = (env['PATH'] ?? '').split(path.win32.delimiter);
  for (const { kind, onPath } of APP_BROWSERS) {
    for (const entry of searchPath) {
      const dir = entry.trim().replace(/^"+|"+$/g, '');
      if (dir === '' || !path.win32.isAbsolute(dir)) continue;
      const file = path.win32.join(dir, onPath);
      if (await isFile(file)) return { kind, file };
    }
  }
  return null;
}

/** The arguments of the app window: the page, a profile of its own, a size and no first-run pages. */
export function appWindowArgs(url: string, profileDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

/** True for `http://127.0.0.1:<port>/` with an optional `#code=<code>` and a port that exists. */
function isLoginUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !LOGIN_URL_RE.test(url)) return false;
  const port = Number(/^http:\/\/127\.0\.0\.1:([0-9]+)\//.exec(url)?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * The environment of the browser: the one of the caller without the settings of this product (`MCS_*`, `CAW_*`), which a
 * browser has no use for. The browser needs the rest (`LOCALAPPDATA`, `USERPROFILE`, `PATH`, ...) to find its own files.
 */
function browserEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || /^(?:MCS|CAW)_/i.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/** True when the child has a process id (Node assigns it when the program started); the `error` event is swallowed here. */
function started(child: VisibleChild): boolean {
  child.once('error', () => undefined);
  return child.pid !== undefined;
}

async function openTab(url: string, seams: BrowserSeams): Promise<OpenOutcome> {
  const opener = await (seams.resolveExecutable ?? resolveExecutable)('opener');
  if (opener === null) return { opened: false, reason: 'unsupported' };
  const result = await (seams.execFileText ?? execFileText)({
    kind: 'opener',
    file: opener,
    args: [url],
    timeoutMs: OPEN_TIMEOUT_MS,
    maxOutputBytes: 4096,
    encoding: 'utf8',
  });
  // The exit code of the desktop opener is advisory: `explorer.exe` answers 1 when the page opened.
  return result.ok || result.code === 1
    ? { opened: true, how: 'default-browser' }
    : { opened: false, reason: 'spawn-failed' };
}

/**
 * Shows `url`, which must be a login URL (`bad-url` otherwise, before anything else happens). `mode: 'window'` starts an Edge
 * or Chrome app window with `profileDir` and falls back to a tab, saying why in `fallback`, when there is no such browser or it
 * did not start; `mode: 'tab'` asks the desktop opener. With the test hook `OPEN_FILE` of `runtime/test-hooks.ts` (test mode only) the URL is
 * appended to that file instead and nothing is started.
 */
export async function openLoginUrl(
  input: { readonly url: string; readonly mode: 'window' | 'tab'; readonly profileDir: string },
  seams: BrowserSeams = {},
): Promise<OpenOutcome> {
  const { url, mode, profileDir } = input;
  if (!isLoginUrl(url)) return { opened: false, reason: 'bad-url' };
  const env = seams.env ?? process.env;

  const recorder = testHook('OPEN_FILE', env);
  if (recorder !== undefined) {
    if (!path.isAbsolute(recorder)) return { opened: false, reason: 'spawn-failed' };
    try {
      await (seams.appendFile ?? ((file, text) => appendFile(file, text, 'utf8')))(recorder, `${url}\n`);
    } catch {
      return { opened: false, reason: 'spawn-failed' };
    }
    return { opened: true, how: 'test-file' };
  }

  if (mode === 'tab') return openTab(url, seams);

  if (!path.isAbsolute(profileDir) || profileDir.includes('\u0000')) {
    throw new RangeError('profileDir must be an absolute path');
  }
  const browser = await findAppBrowser(seams);
  if (browser === null) return withFallback(await openTab(url, seams), 'no-browser');
  const child = (seams.spawnVisible ?? spawnDetachedVisible)(browser.file, appWindowArgs(url, profileDir), {
    env: browserEnv(env),
  });
  if (started(child)) return { opened: true, how: 'app-window' };
  return withFallback(await openTab(url, seams), 'spawn-failed');
}

function withFallback(outcome: OpenOutcome, fallback: 'no-browser' | 'spawn-failed'): OpenOutcome {
  return outcome.opened ? { ...outcome, fallback } : outcome;
}
