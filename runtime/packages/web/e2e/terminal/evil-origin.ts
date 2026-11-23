// The second origin of the cross-origin tests (design 08 section 3.8, TC-SEC-15 to 17): a page of somebody else on another
// loopback port. It is another ORIGIN but the same SITE as the app (a site ignores the port), so the browser sends the session
// cookie of the app, `SameSite=Strict` and all, with every request this page makes. That is the attack worth proving: the cookie
// rides along, and the app must refuse because of where the request comes from.
//
// The server answers one blank page and nothing else; the attacks are functions that run inside that page (`page.evaluate`), so
// they are made by the browser with the rules of a real cross-origin page: a socket, a `fetch` with credentials, images, a frame.
// What each attempt reports is what a script of that page could see; what really happened is asserted by the spec on the app.
import { createServer, type Server } from 'node:http';

import { expect, type Page } from '@playwright/test';

import { allocatePort, assertPortClosed } from '@mcs/testkit';

import { TERMINAL_E2E_PORTS } from './playwright.config.ts';

const BLANK_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FIXTURE second origin</title></head>' +
  '<body><p>FIXTURE page of another origin</p></body></html>';

export interface EvilOrigin {
  /** `http://127.0.0.1:<port>`: never the origin of an instance. */
  readonly origin: string;
  readonly port: number;
  /** The blank page of the origin. */
  readonly pageUrl: string;
  /** Closes the server and asserts that its port is free again. */
  close(): Promise<void>;
}

/** Starts the second origin on a port of the suite. */
export async function startEvilOrigin(): Promise<EvilOrigin> {
  const port = await allocatePort(TERMINAL_E2E_PORTS);
  const server: Server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(BLANK_PAGE);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('FIXTURE not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
  const origin = `http://127.0.0.1:${String(port)}`;
  return {
    origin,
    port,
    pageUrl: `${origin}/`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      await assertPortClosed(port);
    },
  };
}

// ---- the attempts (they run inside the page of the second origin) -----------------------------------------------------------------
//
// The code that runs inside the page is text (this project is checked without the types of a browser); a value goes in as JSON.

function call(body: string, argument: unknown): string {
  return `(${body})(${JSON.stringify(argument)})`;
}

export interface SocketAttempt {
  /** The `open` event fired: the server accepted the handshake. */
  readonly opened: boolean;
  /** The close code the browser reported (1006 for a handshake that was refused). */
  readonly closeCode: number;
}

/** `new WebSocket(url, protocol)` from the page; resolves when the socket has closed (it is closed at once when it opens). */
export function trySocket(page: Page, url: string, protocol: string | null): Promise<SocketAttempt> {
  return page.evaluate<SocketAttempt>(
    call(
      `(args) =>
        new Promise((resolve) => {
          const socket = args.protocol === null ? new WebSocket(args.url) : new WebSocket(args.url, args.protocol);
          let opened = false;
          socket.addEventListener('open', () => {
            opened = true;
            socket.close();
          });
          socket.addEventListener('close', (event) => {
            resolve({ opened, closeCode: event.code });
          });
        })`,
      { url, protocol },
    ),
  );
}

export interface PostAttempt {
  /** The page could read an answer (it never can: the app sends no CORS header). */
  readonly readable: boolean;
  /** The status the page saw; 0 when it saw none. */
  readonly status: number;
}

export interface PostOptions {
  readonly contentType: string;
  readonly body: string;
  /** Further request headers. A header outside the safe list makes the browser ask first (a preflight). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A `fetch` POST with the cookies of the app (`credentials: 'include'`), as a script of another origin would send it. */
export function tryPost(page: Page, url: string, options: PostOptions): Promise<PostAttempt> {
  return page.evaluate<PostAttempt>(
    call(
      `async (args) => {
        try {
          const reply = await fetch(args.url, {
            method: 'POST',
            mode: 'cors',
            credentials: 'include',
            headers: { 'Content-Type': args.contentType, ...args.headers },
            body: args.body,
          });
          return { readable: true, status: reply.status };
        } catch {
          return { readable: false, status: 0 };
        }
      }`,
      { url, contentType: options.contentType, body: options.body, headers: options.headers ?? {} },
    ),
  );
}

/**
 * Asks for every URL as an image (a GET with the cookies of the app that no CORS rule stops) and resolves to the number that
 * loaded as a picture. A URL of `streams` answers with a stream that never ends: it is asked too, and dropped once the others
 * have answered.
 */
export function tryImages(page: Page, urls: readonly string[], streams: readonly string[]): Promise<number> {
  return page.evaluate<number>(
    call(
      `async (args) => {
        const ask = (url) => {
          const image = new Image();
          const done = new Promise((resolve) => {
            image.addEventListener('load', () => resolve(true));
            image.addEventListener('error', () => resolve(false));
          });
          image.src = url;
          return { image, done };
        };
        const open = args.streams.map(ask);
        const answers = await Promise.all(args.urls.map((url) => ask(url).done));
        for (const entry of open) entry.image.src = '';
        return answers.filter(Boolean).length;
      }`,
      { urls, streams },
    ),
  );
}

/**
 * Puts `url` into a frame of the page and resolves, once the frame shows a document, to the address the browser gives that
 * document: the address of its own error page when the target forbids framing.
 */
export async function tryFrame(page: Page, url: string): Promise<string> {
  await page.evaluate(
    call(
      `(target) => {
        const frame = document.createElement('iframe');
        frame.title = 'FIXTURE frame of the app';
        frame.src = target;
        document.body.append(frame);
      }`,
      url,
    ),
  );
  let shown = '';
  await expect
    .poll(
      () => {
        shown =
          page
            .frames()
            .find((frame) => frame.parentFrame() === page.mainFrame())
            ?.url() ?? '';
        return shown !== '' && shown !== 'about:blank';
      },
      { message: 'the frame shows a document' },
    )
    .toBe(true);
  return shown;
}

// ---- what really went over the wire ------------------------------------------------------------------------------------------------

/** One exchange between a page and a server as the network layer of the browser saw it. */
export interface WireAnswer {
  /** `websocket` for the handshake of a socket, else `http`. */
  readonly kind: 'http' | 'websocket';
  readonly method: string;
  readonly origin: string;
  readonly pathname: string;
  /**
   * The status the server answered with, also when the browser kept the answer from the page. 0 for the handshake of a socket
   * that closed without an accepted handshake (the browser reports no status for a handshake the server refused).
   */
  readonly status: number;
  /** The request carried a `Cookie` header (its value is never kept). */
  readonly cookieSent: boolean;
  /** The names of the `Access-Control-*` headers of the answer. */
  readonly corsHeaders: readonly string[];
}

export interface Wire {
  /** The exchanges that have an answer so far, in the order the requests were made. */
  answers(): readonly WireAnswer[];
}

function hasHeader(headers: Readonly<Record<string, string>> | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name);
}

function corsNames(headers: Readonly<Record<string, string>> | undefined): string[] {
  return Object.keys(headers ?? {})
    .map((key) => key.toLowerCase())
    .filter((key) => key.startsWith('access-control-'));
}

/**
 * Listens to the network layer of the browser for `page` (the DevTools protocol of Chrome). A script of another origin never sees
 * the answer to a request the browser blocks for it, and neither does Playwright's `response` event; the network layer does, with
 * the real status and the real headers of both directions. Call it before the page makes the requests.
 */
export async function tapWire(page: Page): Promise<Wire> {
  const session = await page.context().newCDPSession(page);
  interface Entry {
    kind: 'http' | 'websocket';
    method?: string;
    url?: string;
    status?: number;
    cookieSent: boolean;
    corsHeaders: string[];
  }
  const entries = new Map<string, Entry>();
  const entryOf = (id: string): Entry => {
    let entry = entries.get(id);
    if (entry === undefined) {
      entry = { kind: 'http', cookieSent: false, corsHeaders: [] };
      entries.set(id, entry);
    }
    return entry;
  };
  session.on('Network.requestWillBeSent', (event) => {
    const entry = entryOf(event.requestId);
    entry.method = event.request.method;
    entry.url = event.request.url;
    if (hasHeader(event.request.headers, 'cookie')) entry.cookieSent = true;
  });
  session.on('Network.requestWillBeSentExtraInfo', (event) => {
    if (hasHeader(event.headers, 'cookie')) entryOf(event.requestId).cookieSent = true;
  });
  session.on('Network.responseReceivedExtraInfo', (event) => {
    const entry = entryOf(event.requestId);
    entry.status = event.statusCode;
    entry.corsHeaders = corsNames(event.headers);
  });
  session.on('Network.webSocketCreated', (event) => {
    const entry = entryOf(event.requestId);
    entry.kind = 'websocket';
    entry.method = 'GET';
    entry.url = event.url;
  });
  session.on('Network.webSocketWillSendHandshakeRequest', (event) => {
    if (hasHeader(event.request.headers, 'cookie')) entryOf(event.requestId).cookieSent = true;
  });
  session.on('Network.webSocketHandshakeResponseReceived', (event) => {
    const entry = entryOf(event.requestId);
    entry.status = event.response.status;
    entry.corsHeaders = corsNames(event.response.headers);
  });
  session.on('Network.webSocketClosed', (event) => {
    const entry = entryOf(event.requestId);
    entry.status ??= 0;
  });
  await session.send('Network.enable');
  return {
    answers: () =>
      [...entries.values()].flatMap((entry) => {
        if (entry.url === undefined || entry.method === undefined || entry.status === undefined) return [];
        let target: URL;
        try {
          target = new URL(entry.url);
        } catch {
          return [];
        }
        return [
          {
            kind: entry.kind,
            method: entry.method,
            origin: target.origin.replace(/^ws/, 'http'),
            pathname: target.pathname,
            status: entry.status,
            cookieSent: entry.cookieSent,
            corsHeaders: entry.corsHeaders,
          },
        ];
      }),
  };
}
