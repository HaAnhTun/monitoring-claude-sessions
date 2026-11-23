// The fixture of the terminal browser tests (design 08 section 3.8). `test` of this file gives a spec:
//
//   app      one real app instance per spec file (worker scope; a spec names itself with `test.use({ appPurpose: '...' })`, which
//            is also what gives every spec file its own instance): `createUserSandbox` of the testkit in a hermetic temp root on a
//            port of 18500-18599, the fake claude, a fixed world of folders and monitored sessions, the fake folder picker. After
//            the last test of the file it is stopped with `--force` and the leak checks run: the port is closed, no process of
//            the root is left, the temp tree is gone.
//   launch   one more instance for a test that restarts or stops its own (test scope, same checks).
//   watch    the browser side: `watch.page()` opens a page in a new context (a fresh profile every time, never a person's
//            browser), and everything every page of the test does is recorded. When the test ends the fixture fails it for any
//            `console.error`, uncaught error or `securitypolicyviolation` of a page of the app, for a dialog or a popup, and for
//            a request of an app page that left the origin of the instance. No spec has to ask for this, and none can forget.
//
// One known defect of the product is pinned in the guard, see `KNOWN_EVAL_PROBE` below.
//
// A login link, an access code and a cookie value never reach a title, a message, a log or a file here: a request is recorded
// without its fragment (a fragment is never sent anyway) and a problem line carries the path of a URL, never its query.
import { existsSync } from 'node:fs';
import path from 'node:path';

import { expect, test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';

import {
  assertPortClosed,
  assertTestPort,
  buildClaudeHome,
  createUserSandbox,
  daMemoryDir,
  daVariantFolders,
  fakeClaudeScriptPath,
  writeDaMemory,
  type TranscriptBuilder,
  type UserInstance,
  type UserSandbox,
} from '@mcs/testkit';

import { PREFS_KEY, type PrefsData } from '../../src/lib/prefs.ts';
import { TERMINAL_E2E_PORTS } from './playwright.config.ts';

// ---- the world of an instance ------------------------------------------------------------------------------------------------------

/** Ids of the monitored sessions of the world: uuid-shaped and obviously synthetic. */
export const SESSION_RESUMABLE = '7e570000-0000-4000-8000-000000000001';
export const SESSION_ELSEWHERE = '7e570000-0000-4000-8000-000000000002';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** What an instance of this suite finds when it starts. Every path is a real folder below the temp root. */
export interface TerminalWorld {
  /**
   * `alpha`: in the DA memory, active five minutes ago, a plain summary and counts. `beta`: in the DA memory, three days old, with
   * the monitored session {@link SESSION_RESUMABLE} (its turn ended three hours ago). `gamma`: known only through the monitored
   * session {@link SESSION_ELSEWHERE} (four hours ago), which a test may declare open in another program. `hostile`: in the DA
   * memory, four days old, with markup and control characters in its summary. `picked`: known to nothing; it is what the fake
   * folder picker answers.
   */
  readonly folders: Readonly<Record<'alpha' | 'beta' | 'gamma' | 'hostile' | 'picked', string>>;
  /** The summary of `alpha`, as written. */
  readonly alphaSummary: string;
  /** The counts of `alpha`. */
  readonly alphaCounts: { readonly brain: number; readonly action: number };
  /** The markup the summary of `hostile` starts with, as written (the reader keeps it as text). */
  readonly hostileMarkup: string;
  /** The first prompts of the monitored sessions: what their rows are labelled with. */
  readonly labels: Readonly<Record<'resumable' | 'elsewhere', string>>;
}

function turn(prompt: string, messageId: string): (b: TranscriptBuilder) => void {
  return (b) => {
    b.user(prompt);
    b.assistant({
      messageId,
      text: 'FIXTURE answer',
      stop: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    b.turnEnd();
  };
}

/** The folder name Claude Code gives a project: every character that is not a letter or a digit becomes a dash. */
function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function writeWorld(sandbox: UserSandbox): TerminalWorld {
  const nowMs = Date.now();
  const folders = {
    alpha: sandbox.project('alpha'),
    beta: sandbox.project('beta'),
    gamma: sandbox.project('gamma'),
    hostile: sandbox.project('hostile'),
    picked: sandbox.project('picked'),
  };
  const alphaSummary = 'FIXTURE summary of alpha';
  const alphaCounts = { brain: 4, action: 9 };
  const hostileSummary = daVariantFolders('hostile-summary')[0]?.summary ?? '';
  const hostileMarkup = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
  if (!hostileSummary.startsWith(hostileMarkup)) {
    throw new Error('the hostile summary of the testkit no longer starts with the markup this suite looks for');
  }
  writeDaMemory(daMemoryDir(sandbox.paths.home), {
    nowMs,
    folders: [
      { path: folders.alpha, ageMs: 5 * MINUTE, summary: alphaSummary, counts: alphaCounts },
      { path: folders.beta, ageMs: 3 * DAY, summary: 'FIXTURE summary of beta' },
      { path: folders.hostile, ageMs: 4 * DAY, summary: hostileSummary },
    ],
  });
  const labels = {
    resumable: 'FIXTURE resumable: tidy the changelog',
    elsewhere: 'FIXTURE elsewhere: sort the imports',
  };
  buildClaudeHome(sandbox.paths.claudeHome, {
    nowMs,
    sessions: [
      {
        id: SESSION_RESUMABLE,
        project: projectDirName(folders.beta),
        cwd: folders.beta,
        build: turn(labels.resumable, 'msg_e2e_resumable_1'),
        mtimeAgeMs: 3 * 60 * MINUTE,
      },
      {
        id: SESSION_ELSEWHERE,
        project: projectDirName(folders.gamma),
        cwd: folders.gamma,
        build: turn(labels.elsewhere, 'msg_e2e_elsewhere_1'),
        mtimeAgeMs: 4 * 60 * MINUTE,
      },
    ],
  });
  return { folders, alphaSummary, alphaCounts, hostileMarkup, labels };
}

/** A running instance with its world. */
export interface TerminalApp {
  /** The harness object: the only way a spec stops, restarts or asks the CLI of this instance. */
  readonly instance: UserInstance;
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  readonly world: TerminalWorld;
}

function fakePickerScript(): string {
  return path.join(path.dirname(fakeClaudeScriptPath()), 'fake-picker.mjs');
}

/** Starts an instance of this suite. Throws, having removed everything, when a step fails. */
export async function launchTerminalApp(purpose: string): Promise<TerminalApp> {
  const sandbox = await createUserSandbox({ purpose, portRange: TERMINAL_E2E_PORTS });
  try {
    const world = writeWorld(sandbox);
    const picker = fakePickerScript();
    if (!existsSync(picker)) throw new Error('the fake folder picker of the testkit is missing');
    const instance = await sandbox.start({
      env: { MCS_TEST_FOLDER_PICKER: picker, FAKE_PICKER_RESULT: world.folders.picked },
    });
    assertTestPort(instance.port);
    const [min, max] = TERMINAL_E2E_PORTS;
    if (instance.port < min || instance.port > max) {
      throw new Error(`the instance listens outside the ports of this suite (${String(min)}-${String(max)})`);
    }
    return { instance, origin: instance.baseUrl, world };
  } catch (error) {
    await sandbox.destroy().catch(() => undefined);
    throw error;
  }
}

/**
 * Stops an instance (with `--force`: its terminals end with it) and runs the leak checks. An instance that a test already stopped
 * is only cleaned up and checked.
 */
export async function closeTerminalApp(app: TerminalApp): Promise<void> {
  const { instance } = app;
  const port = instance.port;
  try {
    if (existsSync(instance.root) && instance.statePid() !== null) await instance.stop({ force: true });
  } finally {
    // idempotent: removes what a failed or an earlier stop left (processes with the marker of the root, the temp tree)
    await instance.destroy();
  }
  await assertPortClosed(port);
  if (existsSync(instance.root)) throw new Error('the temp tree of the instance is still there');
  const left = await instance.processes();
  if (left.length > 0) throw new Error(`${String(left.length)} process(es) of the instance are still running`);
}

// ---- the browser side --------------------------------------------------------------------------------------------------------------

/** One request a page made. */
export interface SeenRequest {
  /** The origin of the page that made it (`null`: a page without one, such as `about:blank`). */
  readonly from: string | null;
  /** The origin and the path of the target; the query is kept apart and a fragment is never part of a request. */
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
  readonly method: string;
  /** `websocket` for a socket, else the resource type Playwright reports (`fetch`, `eventsource`, `document`, ...). */
  readonly kind: string;
}

/** One answer a page received (the real one, also when the browser kept it from the scripts of the page). */
export interface SeenResponse {
  readonly from: string | null;
  readonly origin: string;
  readonly pathname: string;
  readonly method: string;
  readonly status: number;
  /** The request carried a `Cookie` header (the value is never kept). */
  readonly withCookie: boolean;
  /** The names of its `Access-Control-*` headers (the app sends none). */
  readonly corsHeaders: readonly string[];
  /** Its `X-Frame-Options` and `Content-Security-Policy` headers, `null` when absent. */
  readonly frameOptions: string | null;
  readonly csp: string | null;
}

/** One `securitypolicyviolation` event of a page. */
export interface SeenViolation {
  readonly from: string | null;
  readonly directive: string;
  /** What was blocked: a URL, or a word such as `eval` or `inline`. */
  readonly blocked: string;
  /** The path of the script that caused it; '' when the browser named none. */
  readonly source: string;
}

/** The long-lived streams a page holds right now. */
export interface OpenStreams {
  /** The paths of the `EventSource` requests that are still open. */
  readonly eventSources: readonly string[];
  /** The paths of the sockets that are still open. */
  readonly sockets: readonly string[];
}

export interface PageOptions {
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Stored display preferences of the first load (the theme, the language). The DOM renderer is always preset: see `watch.page`. */
  readonly prefs?: Partial<PrefsData>;
}

export interface Watch {
  /**
   * A page in a new browser context: a fresh profile without cookies, at 1440 x 900 unless told otherwise. The terminal
   * preference "renderer" is stored as `dom` before the app starts (the choice a person has in Settings), because the DOM
   * renderer is the one whose screen can be read as text (`dom.ts`); a preference the page stores later is kept. No permission
   * is granted: the clipboard of headless Chrome is its own (it never touches the clipboard of the desktop), a copy after a key
   * press needs no permission, and reading the clipboard stays forbidden (the app forbids it itself).
   */
  page(options?: PageOptions): Promise<Page>;
  /** One more page in the context of `page` (the same cookies). */
  sibling(page: Page): Promise<Page>;
  /** Closes the context of `page`: its streams and sockets end. */
  close(page: Page): Promise<void>;
  /**
   * Declares a response the test provokes on purpose: Chrome writes "Failed to load resource" to the console for every 4xx and 5xx
   * answer, and that line counts as an error unless the test said beforehand that this path (a text, or a pattern for a family
   * of paths) answers this status. An allowance that nothing used fails the test too.
   */
  allowFailedLoad(pathname: string | RegExp, status: number): void;
  /**
   * Declares that the test takes the server away (a restart): the lines Chrome writes for a connection that was refused, reset or
   * cut count as expected from then on. An allowance that nothing used fails the test too.
   */
  allowLostConnection(): void;
  /**
   * Declares that the server cuts a stream of the page in mid-answer (Chrome writes "net::ERR_INCOMPLETE_CHUNKED_ENCODING" for
   * it). Only for a cut that is a known defect, named where this is called. An allowance that nothing used fails the test too.
   */
  allowCutStream(pathname: string): void;
  /**
   * Names a second origin of the test (an attacker's page). What its pages write to the console is evidence, not a problem of the
   * app, and its own requests are not held to the instance origin.
   */
  foreign(origin: string): void;
  /** Names the origin of an instance of the test: its pages are held to the rules of {@link verify}. */
  appOrigin(origin: string): void;
  /** The problems of the app pages so far: console errors, uncaught errors, CSP violations, dialogs and popups. */
  problems(): readonly string[];
  /** Every CSP violation of an app page so far, the pinned ones included. */
  violations(): readonly SeenViolation[];
  /** The console errors of the pages of a foreign origin so far. */
  foreignConsole(): readonly string[];
  /** Every request so far, in order. */
  requests(): readonly SeenRequest[];
  /** Every answer so far, in order of arrival. */
  responses(): readonly SeenResponse[];
  /** The streams `page` holds open now. */
  streams(page: Page): OpenStreams;
  /** How often `page` finished loading a document (a reload counts, a route change inside the app does not). */
  documentLoads(page: Page): number;
  /** The guard the fixture runs after every test; a flow may call it earlier, as a step of its own. */
  verify(): void;
}

/**
 * A known defect of the product, pinned (not excused). The first time a schema of the API contracts is used, zod probes whether it
 * may compile code (`new Function('')`). The policy of the page forbids that; zod catches the refusal and goes on without, and the
 * browser still reports one `securitypolicyviolation` event (`script-src`, `eval`, from a script under `/assets/`) per loaded
 * document. ADR 0086 and TC-SEC-17 ask for zero such events; the cure is `z.config({ jitless: true })` before the first parse.
 *
 * The guard accepts exactly this event, at most once per document; a second one in a document, another directive or another
 * source is a problem like any other. The strict assertion (zero events) is the test "TC-SEC-17 ... reports no CSP violation" of
 * `cross-origin.spec.ts`, marked as an expected failure: it turns red the day the product is fixed, so this pin cannot outlive
 * the defect.
 */
export const KNOWN_EVAL_PROBE = { directive: 'script-src', blocked: 'eval', sourcePrefix: '/assets/' } as const;

interface PageRecord {
  readonly eventSources: Map<object, string>;
  readonly sockets: Map<object, string>;
  /** The documents of the page that already reported the pinned violation. */
  readonly probed: Set<string>;
  documentLoads: number;
  /** The main frame asked for a new document that has not taken over yet. */
  leaving: boolean;
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
}

/** The path of a URL for a problem line: never its query or fragment. '' for a text that is not a URL. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/**
 * A text of the page for a problem line: anything in it that has the shape of an access code or a credential (32 or more
 * characters of the base64url alphabet) is taken out, so that a line the page wrote can never carry one into a report.
 */
function scrub(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
}

const FAILED_LOAD = /^Failed to load resource: the server responded with a status of (\d{3})\b/;
/** What Chrome writes when a server ends a chunked answer without its last chunk. */
const CUT_STREAM = 'Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING';
/** What Chrome writes when the server is not there: a refused, reset or cut connection of a request, a stream or a socket. */
const LOST_CONNECTION =
  /net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING|FAILED)\b|^WebSocket connection to .* failed/;

// The two scripts below run in every page before its own scripts. They are text: this project is checked without the types of a
// browser, and a value goes in as JSON.

/** Stores the preset preferences unless the page already holds a value for them. */
function presetPrefsScript(key: string, preset: Readonly<Record<string, unknown>>): string {
  return `(() => {
    try {
      const args = ${JSON.stringify({ key, preset })};
      const raw = globalThis.localStorage.getItem(args.key);
      const stored = raw === null || raw === '' ? {} : JSON.parse(raw);
      const data = typeof stored === 'object' && stored !== null ? { ...stored } : {};
      let changed = false;
      for (const [name, value] of Object.entries(args.preset)) {
        if (!(name in data)) {
          data[name] = value;
          changed = true;
        }
      }
      if (changed) globalThis.localStorage.setItem(args.key, JSON.stringify(data));
    } catch (error) {
      void error; // a page without storage keeps none
    }
  })()`;
}

/** Reports every CSP violation of the document to the test through the binding of the context. */
function reportViolationsScript(binding: string): string {
  return `document.addEventListener('securitypolicyviolation', (event) => {
    const report = globalThis[${JSON.stringify(binding)}];
    if (typeof report !== 'function') return;
    void report(JSON.stringify({
      directive: event.violatedDirective,
      blocked: event.blockedURI,
      source: event.sourceFile || '',
      document: String(performance.timeOrigin),
    }));
  });`;
}

const VIOLATION_BINDING = '__cawE2eViolation';
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

function textField(value: unknown, name: string): string {
  if (typeof value !== 'object' || value === null) return '';
  const field: unknown = Reflect.get(value, name);
  return typeof field === 'string' ? field : '';
}

function createWatch(browser: Browser): { watch: Watch; closeAll: () => Promise<void> } {
  const contexts = new Set<BrowserContext>();
  const opened = new Set<Page>();
  const records = new Map<Page, PageRecord>();
  const problems: string[] = [];
  const violations: SeenViolation[] = [];
  const foreignConsole: string[] = [];
  const foreignOrigins = new Set<string>();
  const appOrigins = new Set<string>();
  const seen: SeenRequest[] = [];
  const answers: SeenResponse[] = [];
  /** What the test declared beforehand: each must be used at least once. */
  const allowances: { what: string; matches: (text: string, where: string) => boolean; used: number }[] = [];

  const isForeign = (page: Page | null): boolean => {
    const origin = page === null ? null : originOf(page.url());
    return origin !== null && foreignOrigins.has(origin);
  };

  function recordOf(page: Page): PageRecord {
    let record = records.get(page);
    if (record === undefined) {
      record = { eventSources: new Map(), sockets: new Map(), probed: new Set(), documentLoads: 0, leaving: false };
      records.set(page, record);
    }
    return record;
  }

  function onViolation(page: Page | null, detail: unknown): void {
    let parsed: unknown;
    try {
      parsed = typeof detail === 'string' ? JSON.parse(detail) : null;
    } catch {
      parsed = null;
    }
    const violation: SeenViolation = {
      from: page === null ? null : originOf(page.url()),
      directive: textField(parsed, 'directive'),
      blocked: textField(parsed, 'blocked'),
      source: pathOf(textField(parsed, 'source')),
    };
    const line = `securitypolicyviolation: ${violation.directive} blocked ${pathOf(violation.blocked) || violation.blocked} from ${violation.source || 'an unnamed source'}`;
    if (isForeign(page)) {
      foreignConsole.push(line);
      return;
    }
    violations.push(violation);
    const document = textField(parsed, 'document');
    const probed = page === null ? null : recordOf(page).probed;
    const pinned =
      violation.directive === KNOWN_EVAL_PROBE.directive &&
      violation.blocked === KNOWN_EVAL_PROBE.blocked &&
      violation.source.startsWith(KNOWN_EVAL_PROBE.sourcePrefix) &&
      probed !== null &&
      !probed.has(document);
    if (pinned) probed.add(document);
    else problems.push(line);
  }

  function track(page: Page): void {
    const record = recordOf(page);
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const where = pathOf(message.location().url);
      if (isForeign(page)) {
        foreignConsole.push(`${scrub(message.text())} @ ${where}`);
        return;
      }
      const allowed = allowances.find((entry) => entry.matches(message.text(), where));
      if (allowed !== undefined) {
        allowed.used += 1;
        return;
      }
      problems.push(`console.error: ${scrub(message.text())} @ ${where}`);
    });
    page.on('pageerror', (error) => {
      if (isForeign(page)) foreignConsole.push(`pageerror: ${error.name}`);
      else problems.push(`pageerror: ${error.name}: ${scrub(error.message)}`);
    });
    page.on('dialog', (dialog) => {
      problems.push(`dialog: a ${dialog.type()} dialog opened on ${pathOf(page.url())}`);
      void dialog.dismiss().catch(() => undefined);
    });
    page.on('popup', (popup) => {
      if (!opened.has(popup)) problems.push(`popup: a window opened from ${pathOf(page.url())}`);
    });
    page.on('load', () => {
      record.documentLoads += 1;
    });
    // A new document replaces the old one: the streams and sockets of the old document end with it, without an event of their
    // own. They are forgotten when the new document takes over (not when it is asked for: until then the old one may still open
    // a stream). A route change inside the app is a navigation of the frame without a request, and forgets nothing.
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || !record.leaving) return;
      record.leaving = false;
      record.eventSources.clear();
      record.sockets.clear();
    });
    page.on('request', (request) => {
      let target: URL;
      try {
        target = new URL(request.url());
      } catch {
        return;
      }
      const kind = request.resourceType();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) record.leaving = true;
      seen.push({
        from: originOf(page.url()),
        origin: target.origin,
        pathname: target.pathname,
        search: target.search,
        method: request.method(),
        kind,
      });
      if (kind === 'eventsource') record.eventSources.set(request, target.pathname);
    });
    page.on('response', (response) => {
      let target: URL;
      try {
        target = new URL(response.url());
      } catch {
        return;
      }
      const from = originOf(page.url());
      const headers = response.headers();
      const request = response.request();
      void request
        .allHeaders()
        .catch(() => ({}))
        .then((sent: Record<string, string>) => {
          answers.push({
            from,
            origin: target.origin,
            pathname: target.pathname,
            method: request.method(),
            status: response.status(),
            withCookie: typeof sent['cookie'] === 'string' && sent['cookie'] !== '',
            corsHeaders: Object.keys(headers).filter((name) => name.startsWith('access-control-')),
            frameOptions: headers['x-frame-options'] ?? null,
            csp: headers['content-security-policy'] ?? null,
          });
        });
    });
    const ended = (request: object): void => {
      record.eventSources.delete(request);
    };
    page.on('requestfinished', ended);
    page.on('requestfailed', ended);
    page.on('websocket', (socket) => {
      let target: URL;
      try {
        target = new URL(socket.url());
      } catch {
        return;
      }
      seen.push({
        from: originOf(page.url()),
        origin: target.origin.replace(/^ws/, 'http'),
        pathname: target.pathname,
        search: target.search,
        method: 'GET',
        kind: 'websocket',
      });
      record.sockets.set(socket, target.pathname);
      socket.on('close', () => {
        record.sockets.delete(socket);
      });
    });
    page.on('close', () => {
      record.eventSources.clear();
      record.sockets.clear();
    });
  }

  const watch: Watch = {
    async page(options = {}) {
      const context = await browser.newContext({
        viewport: options.viewport ?? DEFAULT_VIEWPORT,
        locale: 'en-US',
      });
      contexts.add(context);
      await context.exposeBinding(VIOLATION_BINDING, (source, detail: unknown) => {
        onViolation(source.page, detail);
      });
      await context.addInitScript(reportViolationsScript(VIOLATION_BINDING));
      await context.addInitScript(presetPrefsScript(PREFS_KEY, { terminalRenderer: 'dom', ...options.prefs }));
      context.on('page', (page) => {
        if (!records.has(page)) track(page);
      });
      const page = await context.newPage();
      opened.add(page);
      return page;
    },
    async sibling(page) {
      const next = await page.context().newPage();
      opened.add(next);
      return next;
    },
    async close(page) {
      const context = page.context();
      contexts.delete(context);
      await context.close();
    },
    allowFailedLoad(pathname, status) {
      allowances.push({
        what: `nothing answered ${String(status)} on ${String(pathname)}`,
        matches: (text, where) =>
          FAILED_LOAD.exec(text)?.[1] === String(status) &&
          (typeof pathname === 'string' ? pathname === where : pathname.test(where)),
        used: 0,
      });
    },
    allowLostConnection() {
      allowances.push({ what: 'no connection was lost', matches: (text) => LOST_CONNECTION.test(text), used: 0 });
    },
    allowCutStream(pathname) {
      allowances.push({
        what: `no stream was cut on ${pathname}`,
        matches: (text, where) => text === CUT_STREAM && where === pathname,
        used: 0,
      });
    },
    foreign(origin) {
      foreignOrigins.add(origin);
    },
    appOrigin(origin) {
      appOrigins.add(origin);
    },
    problems: () => [...problems],
    violations: () => [...violations],
    foreignConsole: () => [...foreignConsole],
    requests: () => [...seen],
    responses: () => [...answers],
    streams(page) {
      const record = records.get(page);
      return {
        eventSources: [...(record?.eventSources.values() ?? [])],
        sockets: [...(record?.sockets.values() ?? [])],
      };
    },
    documentLoads: (page) => records.get(page)?.documentLoads ?? 0,
    verify() {
      const strayed = seen
        .filter((request) => request.from !== null && appOrigins.has(request.from) && request.origin !== request.from)
        .map((request) => `request: an app page asked ${request.origin}${request.pathname}`);
      const unused = allowances.filter((entry) => entry.used === 0).map((entry) => `allowance: ${entry.what}`);
      expect([...problems, ...strayed, ...unused], 'problems of the app pages in this test').toEqual([]);
    },
  };

  return {
    watch,
    closeAll: async () => {
      for (const context of contexts) await context.close().catch(() => undefined);
      contexts.clear();
    },
  };
}

// ---- the test object ---------------------------------------------------------------------------------------------------------------

interface WorkerFixtures {
  /** A word for the temp root of the instance; every spec file sets its own, which also gives it its own instance. */
  appPurpose: string;
  app: TerminalApp;
}

interface TestFixtures {
  watch: Watch;
  /** Starts one more instance for this test; it is stopped and checked when the test ends. */
  launch: (purpose: string) => Promise<TerminalApp>;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  appPurpose: ['e2e-terminal', { option: true, scope: 'worker' }],

  app: [
    async ({ appPurpose }, use) => {
      const app = await launchTerminalApp(appPurpose);
      try {
        await use(app);
      } finally {
        // a leak check that fails is the error of the run, also after a failed test
        await closeTerminalApp(app);
      }
    },
    // starting an instance runs the CLI several times; stopping scans the processes of the machine
    { scope: 'worker', timeout: 300_000 },
  ],

  watch: async ({ browser, app }, use, testInfo) => {
    const { watch, closeAll } = createWatch(browser);
    watch.appOrigin(app.origin);
    try {
      await use(watch);
      // a test that failed against its expectation keeps its own error; the guard speaks for every other test
      if (testInfo.status === 'passed' || testInfo.status === testInfo.expectedStatus) watch.verify();
    } finally {
      await closeAll();
    }
  },

  launch: async ({ watch }, use) => {
    const launched: TerminalApp[] = [];
    const closeLaunched = async (): Promise<string[]> => {
      const failures: string[] = [];
      for (const app of launched.splice(0)) {
        await closeTerminalApp(app).catch((error: unknown) => {
          failures.push(error instanceof Error ? error.message : String(error));
        });
      }
      return failures;
    };
    try {
      await use(async (purpose) => {
        const app = await launchTerminalApp(purpose);
        launched.push(app);
        watch.appOrigin(app.origin);
        return app;
      });
    } catch (error) {
      await closeLaunched();
      throw error;
    }
    const failures = await closeLaunched();
    if (failures.length > 0) throw new Error(`an instance of the test did not close cleanly: ${failures.join('; ')}`);
  },
});

export { expect };
