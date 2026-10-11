// Regression test for CR-WP-08-1. Vitest turns `ssr.resolve.conditions` into `node --conditions ...` flags for its
// workers. With `import` among them, Node's require() of a dual package (is-promise, used by Express 5's router after every
// handler call) returns the ES module namespace instead of the function, so every handler that answers after it has
// returned ends in a 500. The root config must therefore pass only the custom `@mcs/source` condition.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { allocatePort, assertPortClosed } from '@mcs/testkit';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import config from '../../vitest.config.ts';

let server: Server | undefined;
let port = 0;

function listen(app: express.Express): Promise<void> {
  return new Promise((resolve, reject) => {
    allocatePort().then((free) => {
      port = free;
      const started = app.listen(free, '127.0.0.1', () => {
        server = started;
        resolve();
      });
      started.once('error', reject);
    }, reject);
  });
}

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running === undefined) return;
  await new Promise<void>((resolve, reject) => {
    running.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    running.closeAllConnections();
  });
  await assertPortClosed(port);
});

describe('vitest conditions and Express 5 (CR-WP-08-1)', () => {
  it('passes only the @mcs/source condition to the workers', () => {
    expect(config.ssr?.resolve?.conditions).toEqual(['@mcs/source']);
  });

  it('does not hand import or default to the worker as a --conditions flag', () => {
    const conditions: string[] = [];
    process.execArgv.forEach((arg, index) => {
      if (arg === '--conditions' || arg === '-C') conditions.push(process.execArgv[index + 1] ?? '');
      else if (arg.startsWith('--conditions=')) conditions.push(arg.slice('--conditions='.length));
    });
    expect(conditions).not.toContain('import');
    expect(conditions).not.toContain('default');
  });

  it('answers 200 from an async handler that reads the request body before it responds', async () => {
    const app = express();
    app.post('/echo', async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      await nextTurn();
      res.status(200).json({ bytes: Buffer.concat(chunks).length });
    });
    await listen(app);
    const response = await fetch(`http://127.0.0.1:${String(port)}/echo`, { method: 'POST', body: 'payload' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: 7 });
  });

  it('answers 200 through an async middleware that awaits before it calls next', async () => {
    const app = express();
    app.use(async (_req, _res, next) => {
      await nextTurn();
      next();
    });
    app.get('/guarded', (_req, res) => {
      res.status(204).end();
    });
    await listen(app);
    const address = server?.address() as AddressInfo | null;
    expect(address?.port).toBe(port);
    const response = await fetch(`http://127.0.0.1:${String(port)}/guarded`);
    expect(response.status).toBe(204);
  });
});
