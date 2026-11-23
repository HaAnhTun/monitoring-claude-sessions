// Helpers of the workspace scenarios (`specs/workspace-ui.spec.ts`; design 04 section 12.4), on the fixture and the DOM helper of
// the acceptance suite. Nothing here reads the screen or spells a label: that is `dom.ts`.
//
//   proxySockets   stands between a page and the terminal socket of the real server (`page.routeWebSocket`, which connects to the
//                  server from inside the browser, so the cookie and the Origin are the real ones): it records the close code the
//                  server sent, can cut the page side like a lost connection, and can keep a new connection from reaching the
//                  server for a while. This is the `dropSockets()` of design 04, done in the browser as design 08 section 3.8 says.
//   stubOutdated   answers `GET /health` with the real answer of the server, `runtime.outdated` set to true.
//   stubExchange   answers `POST /auth/exchange` with a success that sets no cookie.
//   openTerminal   a signed-in page with a session that the harness started and whose terminal is live.
import type { Page, WebSocketRoute } from '@playwright/test';

import { focusTerminal, openSession, signIn } from './dom.ts';
import type { TerminalApp, Watch } from './fixture.ts';

const SOCKET_PATH = /^\/api\/v3\/terminal\/sessions\/[^/]+\/socket$/;

export interface SocketProxy {
  /** How many terminal sockets the page has opened so far. */
  opened(): number;
  /** The close codes the server sent, in order. */
  serverCloses(): readonly number[];
  /** Cuts the page side of every open socket, as a connection that broke does (the server side is closed too). */
  drop(): Promise<void>;
  /** From now on a new socket of the page is held back: the page sees an open connection on which nothing arrives. */
  hold(): void;
  /** Connects the held sockets to the server and stops holding. */
  release(): void;
}

interface OpenSocket {
  readonly page: WebSocketRoute;
  server: WebSocketRoute | null;
}

/** Routes the terminal sockets of `page` through the test. Call it before the page opens a terminal. */
export async function proxySockets(page: Page): Promise<SocketProxy> {
  const open = new Set<OpenSocket>();
  const held: OpenSocket[] = [];
  const closes: number[] = [];
  let count = 0;
  let holding = false;

  const connect = (socket: OpenSocket): void => {
    // without message handlers Playwright forwards every frame both ways; the close is forwarded here so that its code is seen
    const server = socket.page.connectToServer();
    socket.server = server;
    server.onClose((code, reason) => {
      closes.push(code ?? 1005);
      open.delete(socket);
      void socket.page.close({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
    });
    socket.page.onClose((code, reason) => {
      open.delete(socket);
      void server.close({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
    });
  };

  await page.routeWebSocket(
    (url) => SOCKET_PATH.test(url.pathname),
    (route) => {
      count += 1;
      const socket: OpenSocket = { page: route, server: null };
      open.add(socket);
      if (holding) held.push(socket);
      else connect(socket);
    },
  );

  return {
    opened: () => count,
    serverCloses: () => [...closes],
    drop: async () => {
      for (const socket of [...open]) {
        open.delete(socket);
        // 1011 is "internal error": a code that is neither an exit, a stop nor a sign-out, so the page takes it for a lost connection
        await socket.page.close({ code: 1011, reason: 'FIXTURE dropped' });
        await socket.server?.close({ code: 1000, reason: 'FIXTURE dropped' });
      }
    },
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const socket of held.splice(0)) connect(socket);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Makes `GET /health` of `page` say that newer code is installed; everything else of the answer is the server's own. */
export async function stubOutdated(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/v3/health',
    async (route) => {
      const response = await route.fetch();
      const body: unknown = await response.json();
      if (!isRecord(body) || !isRecord(body['runtime'])) throw new Error('the health answer has no runtime block');
      await route.fulfill({ response, json: { ...body, runtime: { ...body['runtime'], outdated: true } } });
    },
  );
}

/**
 * Makes `POST /auth/exchange` of `page` answer "accepted" without a cookie, as a browser that refuses cookies would leave it. The
 * request never reaches the server, so the code that was sent stays unspent. Resolves to the function that takes the stub away.
 */
export async function stubExchange(page: Page): Promise<() => Promise<void>> {
  const matches = (url: URL): boolean => url.pathname === '/api/v3/auth/exchange';
  await page.route(matches, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true }) }),
  );
  return () => page.unroute(matches);
}

export interface OpenTerminal {
  readonly page: Page;
  /** The name of the session the harness started. */
  readonly session: string;
}

/** A page of a new browser, signed in, on a new session in `folder` whose terminal is live and has the keyboard. */
export async function openTerminal(
  app: TerminalApp,
  watch: Watch,
  folder: string,
  viewport?: { readonly width: number; readonly height: number },
): Promise<OpenTerminal> {
  const page = await watch.page(viewport === undefined ? {} : { viewport });
  await signIn(page, await app.instance.accessUrl());
  const session = (await app.instance.createSession(folder)).name;
  await openSession(page, app.origin, session);
  await focusTerminal(page);
  return { page, session };
}

/** The names of the live sessions of an instance, as its server lists them. */
export async function liveSessionNames(app: TerminalApp): Promise<string[]> {
  const reply = await app.instance.api(await app.instance.cookie()).get('/api/v3/terminal/state');
  const sessions = isRecord(reply.json) && Array.isArray(reply.json['sessions']) ? reply.json['sessions'] : [];
  return sessions
    .flatMap((session: unknown) => (isRecord(session) && typeof session['name'] === 'string' ? [session['name']] : []))
    .sort();
}

/** Ends every live session of an instance, so that a scenario starts from an empty list. */
export async function endAllSessions(app: TerminalApp): Promise<void> {
  for (const name of await liveSessionNames(app)) await app.instance.killSession(name);
}
