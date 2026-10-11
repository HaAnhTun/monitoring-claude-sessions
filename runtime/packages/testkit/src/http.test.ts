import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { httpRequest, readSse } from './http.ts';
import { allocatePort, assertPortClosed } from './ports.ts';

let server: Server | undefined;
let port = 0;

async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<number> {
  port = await allocatePort([18600, 18699]);
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      handler(req, res, body);
    });
  });
  const listening = server;
  await new Promise<void>((resolve) => {
    listening.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
  return port;
}

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current !== undefined) {
    current.closeAllConnections();
    await new Promise<void>((resolve) => {
      current.close(() => {
        resolve();
      });
    });
    await assertPortClosed(port);
  }
});

describe('httpRequest', () => {
  it('returns status, lower-cased headers and the body', async () => {
    const p = await serve((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'text/plain', 'X-Multi': ['a', 'b'] });
      res.end('FIXTURE body');
    });
    const reply = await httpRequest(p, '/x');
    expect(reply.status).toBe(201);
    expect(reply.body).toBe('FIXTURE body');
    expect(reply.headers['content-type']).toBe('text/plain');
    expect(reply.headers['x-multi']).toBe('a, b');
  });

  it('sends method, body, Host, Origin and custom headers', async () => {
    const p = await serve((req, res, body) => {
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          origin: req.headers.origin,
          custom: req.headers['x-custom'],
          body,
        }),
      );
    });
    const reply = await httpRequest(p, '/api/v3/thing?q=1', {
      method: 'POST',
      host: 'evil.example:80',
      origin: 'http://evil.example',
      headers: { 'X-Custom': 'yes' },
      body: '{"a":1}',
    });
    expect(JSON.parse(reply.body)).toEqual({
      method: 'POST',
      url: '/api/v3/thing?q=1',
      host: 'evil.example:80',
      origin: 'http://evil.example',
      custom: 'yes',
      body: '{"a":1}',
    });
  });

  it('uses a fresh connection for every request (agent: false)', async () => {
    const connections = new Set<unknown>();
    const p = await serve((req, res) => {
      connections.add(req.socket);
      res.end(String(req.headers.connection));
    });
    const first = await httpRequest(p, '/');
    await httpRequest(p, '/');
    expect(connections.size).toBe(2);
    expect(first.body).toBe('close');
  });

  it('defaults to GET on 127.0.0.1 with a loopback Host', async () => {
    const p = await serve((req, res) => {
      res.end(`${String(req.method)} ${String(req.headers.host)}`);
    });
    expect((await httpRequest(p, '/')).body).toBe(`GET 127.0.0.1:${String(p)}`);
  });

  it('rejects when the server never answers within the budget', async () => {
    const p = await serve(() => {
      // never answers
    });
    await expect(httpRequest(p, '/', { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });

  it('rejects when nothing listens', async () => {
    const free = await allocatePort([18700, 18710]);
    await expect(httpRequest(free, '/')).rejects.toThrow();
    await assertPortClosed(free);
  });
});

describe('readSse', () => {
  function frames(res: ServerResponse, lines: string[]): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    for (const line of lines) res.write(line);
  }

  it('parses ids, events and multi-line data and ignores comments', async () => {
    const p = await serve((_req, res) => {
      frames(res, [
        ': heartbeat\n\n',
        'id: 7\nevent: hello\ndata: {"a":1}\n\n',
        'data: line one\ndata: line two\n\n',
        'event: change\r\nid: 8\r\ndata: x\r\n\r\n',
      ]);
    });
    const events = await readSse(p, '/api/v3/stream', { maxEvents: 3, timeoutMs: 5000 });
    expect(events).toEqual([
      { id: '7', event: 'hello', data: '{"a":1}' },
      { data: 'line one\nline two' },
      { id: '8', event: 'change', data: 'x' },
    ]);
  });

  it('stops after maxEvents and closes the connection', async () => {
    let closed = false;
    const p = await serve((req, res) => {
      req.socket.once('close', () => {
        closed = true;
      });
      frames(res, ['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n']);
    });
    const events = await readSse(p, '/s', { maxEvents: 2, timeoutMs: 5000 });
    expect(events.map((e) => e.data)).toEqual(['1', '2']);
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (closed) resolve();
        else setImmediate(poll);
      };
      poll();
    });
    expect(closed).toBe(true);
  });

  it('sends Last-Event-ID, Accept and the optional Origin-free request', async () => {
    const p = await serve((req, res) => {
      frames(res, [`data: ${String(req.headers['last-event-id'])}|${String(req.headers.accept)}\n\n`]);
    });
    const events = await readSse(p, '/s', { lastEventId: '41', maxEvents: 1, timeoutMs: 5000 });
    expect(events[0]?.data).toBe('41|text/event-stream');
  });

  it('returns what arrived when the timeout ends first', async () => {
    const p = await serve((_req, res) => {
      frames(res, ['data: only\n\n']);
    });
    const events = await readSse(p, '/s', { maxEvents: 5, timeoutMs: 300 });
    expect(events).toEqual([{ data: 'only' }]);
  });

  it('throws on a non-200 answer', async () => {
    const p = await serve((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    await expect(readSse(p, '/s', { maxEvents: 1, timeoutMs: 2000 })).rejects.toThrow(/404/);
  });
});
