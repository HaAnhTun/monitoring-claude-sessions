// Risk R1 of design 02 (CAW-25): the upgrade runs through the Express chain on a `ServerResponse` that writes to the upgrade
// socket. This suite proves it FIRST, over a real HTTP server on a loopback port with the real app, the real access service and
// a fake terminal host: a refused upgrade (bad Host, bad Origin, no cookie, an unknown name, a handshake that cannot be used)
// is the normal JSON envelope and the SERVER closes the connection; a plain GET is `426` with the Upgrade headers; the success
// path hands the socket to the gateway (101, the accept key, the subprotocol, no compression, `ready` first); and an upgraded
// socket survives a shortened `requestTimeoutMs`, while an ordinary connection stalled inside a request does not (the control
// that shows the timeout was armed). The protocol itself is `terminal-socket.int.test.ts`.
// Ids: TC-SEC-03, 11, 12, 13, 16, 19 and TC-WS-01 of design 08. Every name, folder and host here is invented.
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';

import { ErrorEnvelopeSchema, type ErrorCode } from '@mcs/shared';
import { RawWsClient, TERMINAL_SUBPROTOCOL_V1, httpRequest, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { mintAndExchange, pageOrigin, writeHeaders } from './helpers/auth.ts';
import {
  FakeTerminalPorts,
  startTerminalApp,
  stopTerminalApps,
  unavailableCapabilities,
  type TerminalApp,
} from './helpers/fake-terminal.ts';

afterEach(stopTerminalApps);

const SOCKET_PATH = (name: string): string => `/api/v3/terminal/sessions/${name}/socket`;
// the example key of RFC 6455 1.3
const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

interface RawUpgrade {
  readonly path?: string;
  /** The whole `Host` value; default `127.0.0.1:<port>`. */
  readonly host?: string;
  /** `null` sends no Origin; default the page origin. */
  readonly origin?: string | null;
  readonly cookie?: string;
  readonly method?: string;
  readonly upgrade?: string | null;
  readonly connection?: string | null;
  readonly key?: string | null;
  readonly version?: string | null;
  /** `null` sends no subprotocol header. */
  readonly protocols?: string | null;
  readonly extra?: readonly string[];
  readonly body?: string;
}

function upgradeText(port: number, o: RawUpgrade): string {
  const origin = o.origin === undefined ? pageOrigin(port) : o.origin;
  const lines = [
    `${o.method ?? 'GET'} ${o.path ?? SOCKET_PATH('demo-1')} HTTP/1.1`,
    `Host: ${o.host ?? `127.0.0.1:${String(port)}`}`,
  ];
  if (o.upgrade !== null) lines.push(`Upgrade: ${o.upgrade ?? 'websocket'}`);
  if (o.connection !== null) lines.push(`Connection: ${o.connection ?? 'Upgrade'}`);
  if (o.key !== null) lines.push(`Sec-WebSocket-Key: ${o.key ?? KEY}`);
  if (o.version !== null) lines.push(`Sec-WebSocket-Version: ${o.version ?? '13'}`);
  if (o.protocols !== null) lines.push(`Sec-WebSocket-Protocol: ${o.protocols ?? TERMINAL_SUBPROTOCOL_V1}`);
  if (origin !== null) lines.push(`Origin: ${origin}`);
  if (o.cookie !== undefined) lines.push(`Cookie: ${o.cookie}`);
  lines.push(...(o.extra ?? []), '', o.body ?? '');
  return lines.join('\r\n');
}

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  /** True once the SERVER ended the connection (the client never closes it). */
  readonly serverClosed: () => boolean;
}

/** Writes `text` on a fresh connection, reads until the server ends the connection and parses the answer. */
async function raw(port: number, text: string): Promise<Answer> {
  const socket: Socket = connect({ port, host: '127.0.0.1' });
  const chunks: Buffer[] = [];
  let closed = false;
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('error', () => undefined);
  socket.once('close', () => {
    closed = true;
  });
  socket.once('connect', () => {
    socket.write(text);
  });
  await waitFor(() => closed, { timeoutMs: 8000, what: 'the server to close the connection' });
  const all = Buffer.concat(chunks).toString('latin1');
  const end = all.indexOf('\r\n\r\n');
  const head = end < 0 ? all : all.slice(0, end);
  const lines = head.split('\r\n');
  const status = Number.parseInt(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? '')?.[1] ?? '0', 10);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers, body: end < 0 ? '' : all.slice(end + 4), serverClosed: () => closed };
}

function codeOf(answer: Answer): string | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(answer.body));
  return parsed.success ? parsed.data.error.code : undefined;
}

async function started(
  options: Parameters<typeof startTerminalApp>[0] = {},
): Promise<{ app: TerminalApp; ports: FakeTerminalPorts; cookie: string }> {
  const ports = options.ports ?? new FakeTerminalPorts();
  ports.addSession({ name: 'demo-1' });
  const app = await startTerminalApp({ ...options, ports, socket: options.socket ?? {} });
  const cookie = await mintAndExchange(app.port, app.access);
  return { app, ports, cookie };
}

function viewersOf(ports: FakeTerminalPorts): number {
  return [...ports.sessions.byName.values()].reduce((total, session) => total + session.viewers.size, 0);
}

/** What a refused upgrade must be: the JSON envelope of `code` and `status`, no 101, `Connection: close`, ended by the server. */
function expectRefused(answer: Answer, status: number, code: ErrorCode): void {
  expect(answer.status).toBe(status);
  expect(answer.headers['content-type']).toContain('application/json');
  expect(answer.headers['connection']).toBe('close');
  expect(codeOf(answer)).toBe(code);
  expect(answer.serverClosed()).toBe(true);
  expect(answer.headers['sec-websocket-accept']).toBeUndefined();
  // TC-SEC-16: not one CORS header on a refusal either
  expect(Object.keys(answer.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
}

describe('R1: a refused upgrade is the JSON envelope on the socket, and the socket closes', () => {
  it('TC-SEC-03 no cookie: 401 access_required with the challenge, no 101, no viewer', async () => {
    const { app, ports } = await started();
    const answer = await raw(app.port, upgradeText(app.port, {}));
    expectRefused(answer, 401, 'access_required');
    expect(answer.headers['www-authenticate']).toBe('CAW-Access');
    expect(viewersOf(ports)).toBe(0);
  });

  it('TC-SEC-03 a garbage cookie is refused the same way', async () => {
    const { app, ports } = await started();
    const answer = await raw(app.port, upgradeText(app.port, { cookie: 'caw_11111111=junk' }));
    expectRefused(answer, 401, 'access_required');
    expect(viewersOf(ports)).toBe(0);
  });

  it('TC-SEC-11 a foreign Host is host_not_allowed, with a valid cookie', async () => {
    const { app, ports, cookie } = await started();
    for (const host of ['evil.invalid', `evil.invalid:${String(app.port)}`, `127.0.0.1:${String(app.port + 1)}`]) {
      const answer = await raw(app.port, upgradeText(app.port, { host, cookie }));
      expectRefused(answer, 403, 'host_not_allowed');
    }
    expect(viewersOf(ports)).toBe(0);
  });

  it('TC-SEC-19 a DNS rebinding name that resolves to the loopback with a valid cookie is refused', async () => {
    const { app, ports, cookie } = await started();
    const answer = await raw(
      app.port,
      upgradeText(app.port, { host: `rebind.example.invalid:${String(app.port)}`, cookie }),
    );
    expectRefused(answer, 403, 'host_not_allowed');
    expect(viewersOf(ports)).toBe(0);
  });

  it('TC-SEC-12 a foreign, null, empty, https or other-port Origin is origin_not_allowed', async () => {
    const { app, ports, cookie } = await started();
    const origins = [
      'http://evil.invalid',
      'null',
      '',
      `https://127.0.0.1:${String(app.port)}`,
      'http://127.0.0.1:1',
      `http://127.0.0.1:${String(app.port)}.evil.invalid`,
    ];
    for (const origin of origins) {
      const answer = await raw(app.port, upgradeText(app.port, { origin, cookie }));
      expectRefused(answer, 403, 'origin_not_allowed');
    }
    expect(viewersOf(ports)).toBe(0);
  });

  it('TC-SEC-12 a socket without an Origin header is origin_not_allowed (a page always sends one)', async () => {
    const { app, ports, cookie } = await started();
    const answer = await raw(app.port, upgradeText(app.port, { origin: null, cookie }));
    expectRefused(answer, 403, 'origin_not_allowed');
    expect(viewersOf(ports)).toBe(0);
  });

  it('TC-SEC-13 Sec-Fetch-Site cross-site is refused on the socket', async () => {
    const { app, ports, cookie } = await started();
    const answer = await raw(app.port, upgradeText(app.port, { cookie, extra: ['Sec-Fetch-Site: cross-site'] }));
    expectRefused(answer, 403, 'cross_site_request');
    expect(viewersOf(ports)).toBe(0);
  });

  it('an unknown session name is terminal_not_found', async () => {
    const { app, ports, cookie } = await started();
    const answer = await raw(app.port, upgradeText(app.port, { cookie, path: SOCKET_PATH('nobody-9') }));
    expectRefused(answer, 404, 'terminal_not_found');
    expect(viewersOf(ports)).toBe(0);
  });

  it('a name that is not a session name never reaches the host (400 validation_failed)', async () => {
    const { app, ports, cookie } = await started();
    for (const name of ['a'.repeat(65), '%2e%2e', 'a%20b']) {
      const answer = await raw(app.port, upgradeText(app.port, { cookie, path: SOCKET_PATH(name) }));
      expectRefused(answer, 400, 'validation_failed');
    }
    expect(viewersOf(ports)).toBe(0);
  });

  it('a host that cannot run a terminal answers terminal_unavailable', async () => {
    const ports = new FakeTerminalPorts();
    ports.capabilitiesValue = unavailableCapabilities('addon_missing');
    const { app, cookie } = await started({ ports });
    const answer = await raw(app.port, upgradeText(app.port, { cookie }));
    expectRefused(answer, 503, 'terminal_unavailable');
  });

  it('a handshake without the subprotocol is validation_failed, naming the header and not its value', async () => {
    const { app, ports, cookie } = await started();
    for (const protocols of [null, 'chat', 'caw.terminal.v2']) {
      const answer = await raw(app.port, upgradeText(app.port, { cookie, protocols }));
      expectRefused(answer, 400, 'validation_failed');
      expect(JSON.parse(answer.body)).toMatchObject({
        error: { details: [{ path: 'Sec-WebSocket-Protocol', issue: 'invalid_value' }] },
      });
      expect(answer.body).not.toContain('chat');
    }
    expect(viewersOf(ports)).toBe(0);
  });

  it('the subprotocol is compared as written (exact case), as the gateway selects it: a name that differs in case is refused', async () => {
    const { app, ports, cookie } = await started();
    for (const protocols of ['CAW.TERMINAL.V1', 'Caw.Terminal.v1', 'chat, CAW.TERMINAL.V1']) {
      const answer = await raw(app.port, upgradeText(app.port, { cookie, protocols }));
      expectRefused(answer, 400, 'validation_failed');
      expect(JSON.parse(answer.body)).toMatchObject({
        error: { details: [{ path: 'Sec-WebSocket-Protocol', issue: 'invalid_value' }] },
      });
    }
    expect(viewersOf(ports)).toBe(0);
  });

  it('a subprotocol list the library cannot parse is the JSON envelope too, never its own raw 400', async () => {
    const { app, ports, cookie } = await started();
    const malformed = [
      // a duplicate, in the same or in the most-sent shape
      'caw.terminal.v1, caw.terminal.v1',
      'caw.terminal.v1,caw.terminal.v1',
      // a space inside a token, an empty element, a character that is not a token character
      'caw.terminal.v1 chat',
      'caw.terminal.v1,',
      ',caw.terminal.v1',
      'caw.terminal.v1,,chat',
      'caw terminal',
      'caw.terminal.v1;q=1',
      '"caw.terminal.v1"',
      'caw.terminal.v1, chat/1',
      // a header that is present and empty
      '',
    ];
    for (const protocols of malformed) {
      const answer = await raw(app.port, upgradeText(app.port, { cookie, protocols }));
      expectRefused(answer, 400, 'validation_failed');
      expect(JSON.parse(answer.body)).toMatchObject({
        error: { details: [{ path: 'Sec-WebSocket-Protocol', issue: 'invalid_format' }] },
      });
      expect(answer.body).not.toContain('chat');
    }
    expect(viewersOf(ports)).toBe(0);
  });

  it('a duplicate that arrives as two header lines is refused the same way', async () => {
    const { app, ports, cookie } = await started();
    const answer = await raw(
      app.port,
      upgradeText(app.port, {
        cookie,
        protocols: null,
        extra: ['Sec-WebSocket-Protocol: caw.terminal.v1', 'Sec-WebSocket-Protocol: caw.terminal.v1'],
      }),
    );
    expectRefused(answer, 400, 'validation_failed');
    expect(viewersOf(ports)).toBe(0);
  });

  it('a bad key or a version other than 13 is validation_failed', async () => {
    const { app, ports, cookie } = await started();
    for (const o of [{ key: 'short' }, { key: null }, { version: '8' }, { version: null }] as const) {
      const answer = await raw(app.port, upgradeText(app.port, { cookie, ...o }));
      expectRefused(answer, 400, 'validation_failed');
    }
    expect(viewersOf(ports)).toBe(0);
  });

  it('Upgrade: h2c is 426 upgrade_required, with the headers of that code', async () => {
    const { app, ports, cookie } = await started();
    const answer = await raw(app.port, upgradeText(app.port, { cookie, upgrade: 'h2c' }));
    expect(answer.status).toBe(426);
    expect(codeOf(answer)).toBe('upgrade_required');
    expect(answer.headers['upgrade']).toBe('websocket');
    expect(answer.serverClosed()).toBe(true);
    expect(viewersOf(ports)).toBe(0);
  });

  it('an Upgrade that is not exactly websocket is 426 as well: the library would answer a raw 400 to a list', async () => {
    const { app, ports, cookie } = await started();
    for (const upgrade of ['websocket, h2c', 'h2c, websocket', 'websocket2', '']) {
      const answer = await raw(app.port, upgradeText(app.port, { cookie, upgrade }));
      expect(answer.status).toBe(426);
      expect(answer.headers['content-type']).toContain('application/json');
      expect(codeOf(answer)).toBe('upgrade_required');
      expect(answer.headers['upgrade']).toBe('websocket');
      expect(answer.serverClosed()).toBe(true);
    }
    expect(viewersOf(ports)).toBe(0);
  });

  it('a path that is not the socket is answered by the app as any GET (404) and the connection closes', async () => {
    const { app, cookie } = await started();
    const answer = await raw(app.port, upgradeText(app.port, { cookie, path: '/api/v3/nothing-here' }));
    expectRefused(answer, 404, 'route_not_found');
  });

  it('a write that says Upgrade is answered, not left waiting for a body that never comes', async () => {
    const { app, ports, cookie } = await started();
    const answer = await raw(
      app.port,
      upgradeText(app.port, {
        method: 'POST',
        path: '/api/v3/terminal/sessions',
        cookie,
        extra: ['Content-Type: application/json', 'X-MCS-Request: 1', 'Content-Length: 5'],
        body: '{"a":',
      }),
    );
    expect(answer.status).toBe(400);
    expect(codeOf(answer)).toBe('body_invalid_json');
    expect(answer.serverClosed()).toBe(true);
    expect(ports.sessions.created).toEqual([]);
  });

  it('refusals leave no connection behind on the server', async () => {
    const { app } = await started();
    await raw(app.port, upgradeText(app.port, {}));
    await raw(app.port, upgradeText(app.port, { host: 'evil.invalid' }));
    await waitFor(
      () =>
        new Promise<boolean>((resolve) => {
          app.server.getConnections((_error, count) => {
            resolve(count === 0);
          });
        }),
      { what: 'the server to hold no connection' },
    );
  });
});

describe('R1: a plain GET', () => {
  it('is 426 upgrade_required with the Upgrade headers when the cookie is valid', async () => {
    const { app, cookie } = await started();
    const reply = await httpRequest(app.port, SOCKET_PATH('demo-1'), {
      origin: pageOrigin(app.port),
      headers: { Cookie: cookie },
    });
    expect(reply.status).toBe(426);
    expect(reply.headers['upgrade']).toBe('websocket');
    expect(reply.headers['connection']?.toLowerCase()).toContain('upgrade');
    expect(ErrorEnvelopeSchema.parse(JSON.parse(reply.body)).error.code).toBe('upgrade_required');
  });

  it('is 426 for a GET that names the Upgrade header without the Connection token', async () => {
    const { app, cookie } = await started();
    const reply = await httpRequest(app.port, SOCKET_PATH('demo-1'), {
      origin: pageOrigin(app.port),
      headers: { Cookie: cookie, Upgrade: 'websocket' },
    });
    expect(reply.status).toBe(426);
  });

  it('still meets the guards first: no cookie is 401, a foreign Origin is 403', async () => {
    const { app, cookie } = await started();
    const noCookie = await httpRequest(app.port, SOCKET_PATH('demo-1'), { origin: pageOrigin(app.port) });
    expect(noCookie.status).toBe(401);
    const foreign = await httpRequest(app.port, SOCKET_PATH('demo-1'), {
      origin: 'http://evil.invalid',
      headers: { Cookie: cookie },
    });
    expect(foreign.status).toBe(403);
  });

  it('is not allowed as a POST (405 with the Allow header)', async () => {
    const { app, cookie } = await started();
    const reply = await httpRequest(app.port, SOCKET_PATH('demo-1'), {
      method: 'POST',
      origin: pageOrigin(app.port),
      headers: writeHeaders(cookie),
      body: '{}',
    });
    expect(reply.status).toBe(405);
  });
});

describe('R1: the success path hands the socket over', () => {
  it('TC-WS-01 101 with the accept key and the subprotocol, no compression, `ready` first, then `live`', async () => {
    const { app, ports, cookie } = await started();
    const client = await RawWsClient.connect(app.port, { path: SOCKET_PATH('demo-1'), cookie });
    try {
      expect(client.status).toBe(101);
      expect(client.acceptOk).toBe(true);
      expect(client.headers['sec-websocket-protocol']).toBe(TERMINAL_SUBPROTOCOL_V1);
      expect(client.headers['sec-websocket-extensions']).toBeUndefined();
      expect(client.headers['upgrade']?.toLowerCase()).toBe('websocket');
      expect(Object.keys(client.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
      const first = await client.next();
      expect(first.opcode).toBe(1);
      expect(JSON.parse(first.payload.toString('utf8'))).toMatchObject({ type: 'ready', v: 1 });
      expect(JSON.parse((await client.next()).payload.toString('utf8'))).toEqual({ type: 'live' });
      expect(viewersOf(ports)).toBe(1);
    } finally {
      await client.close();
    }
    await waitFor(() => viewersOf(ports) === 0, { what: 'the viewer to detach' });
  });

  it('TC-WS-01 the subprotocol is selected from a list that offers others, whatever the spacing and the order', async () => {
    // every token character the grammar allows, in a name of its own
    const tchars = "!#$%&'*+-.^_`|~09azAZ";
    const { app, ports, cookie } = await started();
    for (const protocols of [
      `chat, ${TERMINAL_SUBPROTOCOL_V1}`,
      `${TERMINAL_SUBPROTOCOL_V1},chat`,
      `${tchars} ,\t${TERMINAL_SUBPROTOCOL_V1}\t, chat`,
    ]) {
      const client = await RawWsClient.connect(app.port, {
        path: SOCKET_PATH('demo-1'),
        cookie,
        protocols: [protocols],
      });
      try {
        expect(client.status).toBe(101);
        expect(client.headers['sec-websocket-protocol']).toBe(TERMINAL_SUBPROTOCOL_V1);
        expect(JSON.parse((await client.next()).payload.toString('utf8'))).toMatchObject({ type: 'ready' });
      } finally {
        await client.close();
      }
      await waitFor(() => viewersOf(ports) === 0, { what: 'the viewer to detach' });
    }
  });

  it('a successful upgrade is not a failed route: no route_failed line, no error in the ring', async () => {
    // the route marks the response as handled when it gives the socket away; without it the adapter finds no answer after the
    // handler and reports an INTERNAL failure for every good upgrade
    const { app, cookie } = await started();
    const client = await RawWsClient.connect(app.port, { path: SOCKET_PATH('demo-1'), cookie });
    try {
      expect(client.status).toBe(101);
      await client.next();
      await client.next();
    } finally {
      await client.close();
    }
    // the close line of the gateway is written after anything the adapter wrote for this request
    await waitFor(() => readFileSync(app.logFile, 'utf8').includes('terminal_socket_close'), {
      what: 'the close line of the gateway',
    });
    const log = readFileSync(app.logFile, 'utf8');
    expect(log).toContain('terminal_socket_open');
    expect(log).not.toContain('route_failed');
    expect(app.ctx.errors.list()).toEqual([]);
  });

  it("the connection of the socket is the gateway's: the server counts it and the gateway frees it on close", async () => {
    const { app, cookie } = await started();
    const client = await RawWsClient.connect(app.port, { path: SOCKET_PATH('demo-1'), cookie });
    await client.next();
    expect(app.gateway?.size).toBe(1);
    await waitFor(
      () =>
        new Promise<boolean>((resolve) => {
          app.server.getConnections((_error, count) => {
            resolve(count === 1);
          });
        }),
      { what: 'one open connection' },
    );
    await client.close();
    await waitFor(() => app.gateway?.size === 0, { what: 'the gateway to free the socket' });
  });
});

describe('R1: an upgraded socket and the request timeout', () => {
  it('an idle upgraded socket outlives requestTimeoutMs and the keep-alive timeout, and still carries data', async () => {
    const { app, ports, cookie } = await started({
      requestTimeoutMs: 200,
      timing: { headersTimeoutMs: 100, keepAliveTimeoutMs: 100, checkIntervalMs: 20 },
    });
    const client = await RawWsClient.connect(app.port, { path: SOCKET_PATH('demo-1'), cookie });
    try {
      await client.next();
      await client.next();
      // a connection that stalls inside a request IS cut by the shortened timeout: the control that shows it is armed. The
      // request passes every guard (cookie, Origin, JSON, the custom header), so only the timeout can end it.
      const stalled = connect({ port: app.port, host: '127.0.0.1' });
      let stalledClosed = false;
      // a connection nobody reads never sees the end of the server's side: read it
      stalled.resume();
      stalled.on('error', () => undefined);
      stalled.once('close', () => {
        stalledClosed = true;
      });
      stalled.once('connect', () => {
        stalled.write(
          [
            'POST /api/v3/terminal/sessions HTTP/1.1',
            `Host: 127.0.0.1:${String(app.port)}`,
            'Content-Type: application/json',
            'X-MCS-Request: 1',
            `Origin: ${pageOrigin(app.port)}`,
            `Cookie: ${cookie}`,
            'Content-Length: 100',
            '',
            '{',
          ].join('\r\n'),
        );
      });
      await waitFor(() => stalledClosed, { timeoutMs: 5000, what: 'the stalled request to be cut' });
      // the upgraded socket has now seen several multiples of both timeouts
      const idleUntil = Date.now() + 1000;
      await waitFor(() => Date.now() >= idleUntil, { timeoutMs: 4000, intervalMs: 50, what: 'one idle second' });
      expect(client.isClosed()).toBe(false);
      expect(app.gateway?.size).toBe(1);
      ports.sessions.byName.get('demo-1')?.emit(Buffer.from('still-here'));
      await client.until('still-here');
      client.sendBinary(Buffer.from('typed'));
      await waitFor(() => (ports.sessions.byName.get('demo-1')?.written.length ?? 0) === 1, {
        what: 'the input to arrive',
      });
    } finally {
      await client.close();
    }
  });
});
