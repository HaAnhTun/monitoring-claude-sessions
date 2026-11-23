// A page of another origin against the terminals (design 08 section 3.8, TC-SEC-15 to 17). The other page lives on a second
// loopback port (`evil-origin.ts`) and is opened in the browser that holds the session cookie of the app; the two origins are one
// site, so the cookie travels with everything that page asks. Every attempt is made by the real browser: a socket, credentialed
// posts, image GETs of every GET route, a frame. The verdict is never what the attacking script could see but what the app did:
// its sessions, its processes and its folders before and after, and the real exchanges as the network layer of the browser saw
// them (`tapWire`: the status the server answered with and whether the cookie was sent, also for an answer the browser blocked).
//
// `POST /terminal/open-native` is deliberately not among the attempts: on a host that has Windows Terminal a success would open a
// real window on the desktop of the person who runs the tests.
import { routes } from '@mcs/shared';
import { TERMINAL_SUBPROTOCOL_V1 } from '@mcs/testkit';

import type { Page } from '@playwright/test';

import { expectLive, focusTerminal, openSession, signIn, typeLine, waitForRow, workspace } from '../dom.ts';
import {
  startEvilOrigin,
  tapWire,
  tryFrame,
  tryImages,
  tryPost,
  trySocket,
  type EvilOrigin,
  type Wire,
  type WireAnswer,
} from '../evil-origin.ts';
import { SESSION_RESUMABLE, expect, test, type TerminalApp, type Watch } from '../fixture.ts';

test.use({ appPurpose: 'e2e-cross-origin' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function namesOf(value: unknown, list: string, field: string): string[] {
  const items = isRecord(value) && Array.isArray(value[list]) ? value[list] : [];
  return items
    .flatMap((item: unknown) => (isRecord(item) && typeof item[field] === 'string' ? [item[field]] : []))
    .sort();
}

/** How many windows watch each session, by name. */
function viewersOf(value: unknown): Record<string, number> {
  const items = isRecord(value) && Array.isArray(value['sessions']) ? value['sessions'] : [];
  const viewers: Record<string, number> = {};
  for (const item of items) {
    if (isRecord(item) && typeof item['name'] === 'string') viewers[item['name']] = Number(item['viewers']);
  }
  return viewers;
}

/** What a request of another origin must not change: the terminals, the processes that ever started or ended, the folders. */
async function stateOf(app: TerminalApp): Promise<Record<string, unknown>> {
  const api = app.instance.api(await app.instance.cookie());
  const terminals = await api.get('/api/v3/terminal/state');
  const folders = await api.get('/api/v3/folders');
  const log = app.instance.fakeLog();
  return {
    terminalStatus: terminals.status,
    sessions: namesOf(terminals.json, 'sessions', 'name'),
    viewers: viewersOf(terminals.json),
    folderStatus: folders.status,
    folders: namesOf(folders.json, 'folders', 'key'),
    started: log.count('start'),
    exited: log.count('exit'),
    typedBytes: log.stdin().length,
  };
}

interface Scene {
  /** The page of the app: signed in, with the terminal of `session` live. */
  readonly page: Page;
  /** The page of the other origin, in the same browser. */
  readonly attacker: Page;
  /** What the attacker page really exchanged with servers. */
  readonly wire: Wire;
  readonly session: string;
}

/** The app with a live terminal in one tab and the page of the other origin in the next, sharing the cookie jar. */
async function openScene(app: TerminalApp, watch: Watch, evil: EvilOrigin, folder: string): Promise<Scene> {
  watch.foreign(evil.origin);
  const page = await watch.page();
  await signIn(page, await app.instance.accessUrl());
  const session = (await app.instance.createSession(folder)).name;
  await openSession(page, app.origin, session);
  const attacker = await watch.sibling(page);
  await attacker.goto(evil.pageUrl);
  const wire = await tapWire(attacker);
  return { page, attacker, wire, session };
}

/** The exchanges of the attacker page with the app, once `count` of this kind have an answer. */
async function exchanges(
  scene: Scene,
  origin: string,
  select: (answer: WireAnswer) => boolean,
  count: number,
  what: string,
): Promise<WireAnswer[]> {
  const matching = (): WireAnswer[] =>
    scene.wire.answers().filter((answer) => answer.origin === origin && select(answer));
  await expect.poll(() => matching().length, `${what} that reached the app`).toBe(count);
  return matching();
}

const PARAMETER = /:([A-Za-z]+)/g;

test.describe('a page of another origin in the browser that holds the cookie', () => {
  let evil: EvilOrigin;

  test.beforeAll(async () => {
    evil = await startEvilOrigin();
  });

  test.afterAll(async () => {
    await evil.close();
  });

  test('TC-SEC-15 its socket, its create, kill, resume, add-folder and logout are refused and change nothing', async ({
    app,
    watch,
  }) => {
    const { origin, world } = app;
    const scene = await openScene(app, watch, evil, world.folders.alpha);
    const before = await stateOf(app);

    // the socket: with the subprotocol of the app and without one
    const socketUrl = `${origin.replace(/^http/, 'ws')}/api/v3/terminal/sessions/${scene.session}/socket`;
    for (const protocol of [TERMINAL_SUBPROTOCOL_V1, null]) {
      const attempt = await trySocket(scene.attacker, socketUrl, protocol);
      expect(attempt, `a socket with ${protocol ?? 'no subprotocol'}`).toEqual({ opened: false, closeCode: 1006 });
    }
    const handshakes = await exchanges(scene, origin, (answer) => answer.kind === 'websocket', 2, 'socket handshakes');
    expect(
      handshakes.map((answer) => answer.status),
      'no handshake was accepted (101)',
    ).toEqual([0, 0]);
    // the browser shows nobody the headers of a refused handshake; the same address asked as a plain GET shows that the cookie
    // goes to it from this page, and how the app answers a request for the socket that is not an upgrade
    expect(await tryImages(scene.attacker, [socketUrl.replace(/^ws/, 'http')], [])).toBe(0);
    const plainGet = await exchanges(
      scene,
      origin,
      (answer) => answer.kind === 'http' && answer.method === 'GET',
      1,
      'GETs',
    );
    expect(plainGet.map((answer) => ({ cookieSent: answer.cookieSent, refused: answer.status >= 400 }))).toEqual([
      { cookieSent: true, refused: true },
    ]);

    // posts the browser sends without asking (a "simple" content type), with the cookie
    const create = `${origin}/api/v3/terminal/sessions`;
    const simple = [
      { url: create, contentType: 'text/plain', body: JSON.stringify({ path: world.folders.beta }) },
      {
        url: create,
        contentType: 'application/x-www-form-urlencoded',
        body: `path=${encodeURIComponent(world.folders.beta)}`,
      },
      { url: `${origin}/api/v3/terminal/sessions/${scene.session}/kill`, contentType: 'text/plain', body: '{}' },
      {
        url: `${origin}/api/v3/terminal/resume`,
        contentType: 'text/plain',
        body: JSON.stringify({ sessionId: SESSION_RESUMABLE }),
      },
      {
        url: `${origin}/api/v3/folders`,
        contentType: 'text/plain',
        body: JSON.stringify({ path: world.folders.picked }),
      },
      { url: `${origin}/api/v3/auth/logout`, contentType: 'text/plain', body: '{}' },
    ];
    for (const attempt of simple) {
      expect(await tryPost(scene.attacker, attempt.url, attempt), 'what the attacking script saw').toEqual({
        readable: false,
        status: 0,
      });
    }
    const posts = await exchanges(scene, origin, (answer) => answer.method === 'POST', simple.length, 'posts');
    expect(
      posts.map((answer) => ({
        path: answer.pathname,
        cookieSent: answer.cookieSent,
        refused: answer.status === 403 || answer.status === 415,
      })),
      'every post carried the cookie and was refused',
    ).toEqual(simple.map((attempt) => ({ path: new URL(attempt.url).pathname, cookieSent: true, refused: true })));

    // the post as the app itself sends it (JSON and the request header): the browser asks first, and the app does not allow it
    const asked = await tryPost(scene.attacker, create, {
      contentType: 'application/json',
      body: JSON.stringify({ path: world.folders.beta }),
      headers: { 'X-MCS-Request': '1' },
    });
    expect(asked).toEqual({ readable: false, status: 0 });
    const preflights = await exchanges(scene, origin, (answer) => answer.method === 'OPTIONS', 1, 'preflights');
    expect(preflights[0]?.corsHeaders, 'the answer to the preflight allows nothing').toEqual([]);
    expect(
      scene.wire.answers().filter((answer) => answer.origin === origin && answer.method === 'POST').length,
      'the JSON post was never sent',
    ).toBe(simple.length);

    expect(await stateOf(app), 'the terminals, processes and folders of the app').toEqual(before);
    // the browser of the person is still signed in and its terminal still answers
    await focusTerminal(scene.page);
    await typeLine(scene.page, 'still here');
    await waitForRow(scene.page, 'ECHO:still here');
    await scene.page.reload();
    await expectLive(scene.page, scene.session);
    await expect(workspace(scene.page).sidebar).toBeVisible();
  });

  test('TC-SEC-16 TC-SEC-18 no answer carries a CORS header, and an image GET of every GET route changes nothing', async ({
    app,
    watch,
  }) => {
    const { origin, world } = app;
    const scene = await openScene(app, watch, evil, world.folders.beta);
    const before = await stateOf(app);

    const values: Readonly<Record<string, string>> = {
      sessionId: SESSION_RESUMABLE,
      name: scene.session,
      key: 'machine',
    };
    const gets = Object.values(routes).filter((route) => route.method === 'GET');
    const urlOf = (route: { path: string }): string =>
      `${origin}${route.path.replace(PARAMETER, (_match, name: string) => encodeURIComponent(values[name] ?? '1'))}`;
    const streams = gets.filter((route) => route.contentType === 'text/event-stream').map(urlOf);
    const plain = gets.filter((route) => route.contentType !== 'text/event-stream').map(urlOf);
    expect(plain.length, 'the GET routes of the contract').toBeGreaterThan(30);
    expect(streams.length).toBe(2);

    expect(await tryImages(scene.attacker, plain, streams), 'answers that loaded as a picture').toBe(0);
    const answers = await exchanges(
      scene,
      origin,
      (answer) => answer.method === 'GET',
      plain.length + streams.length,
      'GETs',
    );
    expect(answers.filter((answer) => !answer.cookieSent).length, 'GETs that went without the cookie').toBe(0);
    expect(answers.filter((answer) => answer.status === 200).length, 'GETs the app answered with data').toBeGreaterThan(
      10,
    );
    expect(await stateOf(app), 'the terminals, processes and folders of the app').toEqual(before);

    // TC-SEC-16: whatever either page received from the app, refusals included, allows no other origin anything
    const seenByAttacker = scene.wire.answers().filter((answer) => answer.origin === origin);
    const seenByApp = watch.responses().filter((answer) => answer.origin === origin);
    expect(new Set(seenByAttacker.map((answer) => answer.status)).size, 'kinds of answers seen').toBeGreaterThan(2);
    expect(seenByApp.length).toBeGreaterThan(20);
    expect(
      [...seenByAttacker, ...seenByApp]
        .filter((answer) => answer.corsHeaders.length > 0)
        .map((answer) => `${answer.method} ${answer.pathname} ${answer.corsHeaders.join(',')}`),
      'answers with an Access-Control header',
    ).toEqual([]);
  });

  test('TC-SEC-17 the app cannot be put into a frame, and its page answers carry the policy with a nonce', async ({
    app,
    watch,
  }) => {
    const { origin, world } = app;
    const scene = await openScene(app, watch, evil, world.folders.gamma);

    const shown = await tryFrame(scene.attacker, `${origin}/`);
    expect(shown.startsWith(origin), 'the frame shows a document of the app').toBe(false);
    await expect(scene.attacker.frameLocator('iframe').locator('#root')).toHaveCount(0);
    expect(
      watch.foreignConsole().some((line) => line.includes('frame')),
      'the browser said that it refused the frame',
    ).toBe(true);

    const documents = watch
      .responses()
      .filter((answer) => answer.origin === origin && answer.pathname === '/' && answer.method === 'GET');
    expect(documents.length, 'page answers: the app tab and the frame').toBeGreaterThanOrEqual(2);
    for (const answer of documents) {
      expect(answer.frameOptions).toBe('DENY');
      expect(answer.csp).toContain("frame-ancestors 'none'");
      expect(answer.csp).toMatch(/style-src-elem 'self' 'nonce-[A-Za-z0-9+/_=-]{16,}'/);
      expect(answer.csp).toContain("script-src 'self'");
      expect(answer.csp).not.toContain('unsafe-inline');
      expect(answer.csp).not.toContain('unsafe-eval');
    }
  });

  test('TC-SEC-17 a page of the app reports no CSP violation while a terminal runs', async ({ app, watch }) => {
    test.fail(
      true,
      'product defect: zod probes `new Function` once per page load and the page policy reports it; needs z.config({ jitless: true })',
    );
    const { instance, origin, world } = app;
    const page = await watch.page();
    await signIn(page, await instance.accessUrl());
    const session = (await instance.createSession(world.folders.hostile)).name;
    await openSession(page, origin, session);
    await focusTerminal(page);
    await typeLine(page, '/colors');
    await waitForRow(page, 'COLORS-DONE');
    expect(watch.violations(), 'securitypolicyviolation events of the app page').toEqual([]);
  });
});
