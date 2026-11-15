// The upgrade registry (CAW-25, design 02 5.2) on a real Node HTTP server and plain `node:net` clients, with a bare request
// listener instead of Express: what is proved is the mechanism (head bytes, a response object on the upgrade socket, the close
// after an answer, an empty body for a write that says `Upgrade`, a listener that cannot crash the process). The guards, the
// envelope and the hand-over to the gateway are `terminal-upgrade.int.test.ts` (risk R1, first), over the real app.
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';

import { allocatePort, assertPortClosed, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createUpgradeRegistry } from './upgrade.ts';

interface Started {
  readonly port: number;
  readonly server: Server;
}

const started: Started[] = [];
/** Sockets a test handler took over: `closeAllConnections` does not know them (design 02 5.5), so the test ends them itself. */
const detached: Socket[] = [];

async function start(
  app: RequestListener,
  registry = createUpgradeRegistry(),
): Promise<Started & { registry: typeof registry }> {
  const port = await allocatePort();
  const server = createServer(app);
  server.on('upgrade', registry.listener(app));
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  const entry = { port, server };
  started.push(entry);
  return { ...entry, registry };
}

afterEach(async () => {
  for (const socket of detached.splice(0)) socket.destroy();
  for (const { port, server } of started.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    await assertPortClosed(port);
  }
});

const UPGRADE_HEADERS = ['Connection: Upgrade', 'Upgrade: websocket'];

function requestText(method: string, headers: readonly string[], body = ''): string {
  return [`${method} /x HTTP/1.1`, 'Host: 127.0.0.1', ...headers, '', body].join('\r\n');
}

interface Exchange {
  readonly text: string;
  readonly socket: Socket;
  /** Resolves when the server ended the connection. */
  readonly closed: Promise<void>;
}

/** Connects, writes `request` and collects what the server sends until it closes the connection (or the test stops). */
function exchange(port: number, request: string | Buffer): Exchange {
  const socket = connect({ port, host: '127.0.0.1' });
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('error', () => undefined);
  socket.once('connect', () => {
    socket.write(request);
  });
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      resolve();
    });
  });
  return {
    socket,
    closed,
    get text(): string {
      return Buffer.concat(chunks).toString('latin1');
    },
  };
}

describe('upgrade registry: take', () => {
  it('gives the head bytes of an upgrade request once', async () => {
    const seen: (Buffer | undefined)[] = [];
    const holder: { registry?: ReturnType<typeof createUpgradeRegistry> } = {};
    const app: RequestListener = (req, res) => {
      seen.push(holder.registry?.take(req));
      seen.push(holder.registry?.take(req));
      res.end('ok');
    };
    const registry = createUpgradeRegistry();
    holder.registry = registry;
    const { port } = await start(app, registry);
    const first = exchange(
      port,
      Buffer.concat([Buffer.from(requestText('GET', UPGRADE_HEADERS)), Buffer.from('HEAD-BYTES')]),
    );
    await first.closed;
    expect(first.text).toContain('200 OK');
    expect(seen[0]?.toString('latin1')).toBe('HEAD-BYTES');
    expect(seen[1]).toBeUndefined();
  });

  it('gives nothing for a plain GET', async () => {
    const seen: (Buffer | undefined)[] = [];
    const holder: { registry?: ReturnType<typeof createUpgradeRegistry> } = {};
    const app: RequestListener = (req: IncomingMessage, res) => {
      seen.push(holder.registry?.take(req));
      res.end('ok');
    };
    const registry = createUpgradeRegistry();
    holder.registry = registry;
    const { port } = await start(app, registry);
    const plain = exchange(port, requestText('GET', ['Connection: close']));
    await plain.closed;
    expect(plain.text).toContain('200 OK');
    expect(seen).toEqual([undefined]);
  });

  it('gives an empty head when nothing follows the request', async () => {
    const seen: (Buffer | undefined)[] = [];
    const holder: { registry?: ReturnType<typeof createUpgradeRegistry> } = {};
    const app: RequestListener = (req, res) => {
      seen.push(holder.registry?.take(req));
      res.end('ok');
    };
    const registry = createUpgradeRegistry();
    holder.registry = registry;
    const { port } = await start(app, registry);
    await exchange(port, requestText('GET', UPGRADE_HEADERS)).closed;
    expect(seen[0]?.length).toBe(0);
  });
});

describe('upgrade registry: the response on the upgrade socket', () => {
  it('writes an answer with Connection close and ends the connection once it is flushed', async () => {
    const app: RequestListener = (_req, res) => {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"error":{"code":"x"}}');
    };
    const { port } = await start(app);
    const refused = exchange(port, requestText('GET', UPGRADE_HEADERS));
    await refused.closed;
    expect(refused.text.startsWith('HTTP/1.1 403 Forbidden\r\n')).toBe(true);
    expect(refused.text.toLowerCase()).toContain('connection: close');
    expect(refused.text.endsWith('{"error":{"code":"x"}}')).toBe(true);
  });

  it('closes the connection after an answer that says Connection: Upgrade as well (the 426 headers)', async () => {
    const app: RequestListener = (_req, res) => {
      res.statusCode = 426;
      res.setHeader('Upgrade', 'websocket');
      res.setHeader('Connection', 'Upgrade');
      res.end('{}');
    };
    const { port } = await start(app);
    const refused = exchange(port, requestText('GET', UPGRADE_HEADERS));
    await refused.closed;
    expect(refused.text.startsWith('HTTP/1.1 426 ')).toBe(true);
  });

  it('answers a write that says Upgrade with an empty body instead of waiting for bytes that never come', async () => {
    const lengths: number[] = [];
    const app: RequestListener = (req, res) => {
      void (async () => {
        let length = 0;
        for await (const chunk of req) length += (chunk as Buffer).length;
        lengths.push(length);
        res.statusCode = 400;
        res.end('empty');
      })();
    };
    const { port } = await start(app);
    const post = exchange(
      port,
      requestText('POST', [...UPGRADE_HEADERS, 'Content-Length: 5', 'Content-Type: application/json'], '{"a":'),
    );
    await post.closed;
    expect(post.text).toContain('400 Bad Request');
    expect(lengths).toEqual([0]);
  });

  it("lets the handler take the socket over: after detachSocket the connection stays open and is the handler's", async () => {
    const taken: Socket[] = [];
    const app: RequestListener = (req, res) => {
      res.detachSocket(req.socket);
      taken.push(req.socket);
      detached.push(req.socket);
      // what the owner of an upgraded socket does: answer the end of the peer
      req.socket.on('end', () => {
        req.socket.end();
      });
      req.socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello');
    };
    const { port } = await start(app);
    const open = exchange(port, requestText('GET', UPGRADE_HEADERS));
    await waitFor(() => open.text.endsWith('hello'));
    expect(open.text.startsWith('HTTP/1.1 101 ')).toBe(true);
    expect(taken[0]?.destroyed).toBe(false);
    open.socket.destroy();
    await open.closed;
    await waitFor(() => taken[0]?.destroyed === true);
  });

  it('survives a reset of the upgrade socket (no uncaught error)', async () => {
    const reached: string[] = [];
    const app: RequestListener = (_req, res) => {
      reached.push('handler');
      // never answers: the client resets the connection
      res.once('close', () => {
        reached.push('closed');
      });
    };
    const { port } = await start(app);
    const client = exchange(port, requestText('GET', UPGRADE_HEADERS));
    await waitFor(() => reached.includes('handler'));
    client.socket.resetAndDestroy();
    await waitFor(() => reached.includes('closed'));
  });

  it('destroys the socket when the app throws synchronously', async () => {
    const app: RequestListener = () => {
      throw new Error('boom');
    };
    const { port } = await start(app);
    const client = exchange(port, requestText('GET', UPGRADE_HEADERS));
    await client.closed;
    expect(client.text).toBe('');
  });
});

describe('upgrade registry: a connection that is not a net.Socket', () => {
  it('is destroyed and never reaches the app', () => {
    const registry = createUpgradeRegistry();
    let reached = false;
    const listener = registry.listener(() => {
      reached = true;
    });
    const stream = new PassThrough();
    listener({} as IncomingMessage, stream, Buffer.alloc(0));
    expect(stream.destroyed).toBe(true);
    expect(reached).toBe(false);
  });
});
