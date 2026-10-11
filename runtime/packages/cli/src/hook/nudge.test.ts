import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, sep } from 'node:path';

import type { HookRouteV1 } from '@mcs/shared/protocol';
import { allocatePort, useTempDirs, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { nudge, nudgeAll, readNudgeTarget } from './nudge.ts';

const makeTemp = useTempDirs();
const ID = '6a0f3c1e-1b2c-4d3e-8f40-0123456789ab';
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

function routeWithState(state: unknown, overrides: Partial<HookRouteV1> = {}): HookRouteV1 {
  const dir = makeTemp('nudge').path.split(sep).join('/');
  writeFileSync(join(dir, 'state.json'), typeof state === 'string' ? state : JSON.stringify(state));
  return {
    v: 1,
    instanceId: ID,
    workspace: dir,
    spoolDir: `${dir}/data/spool`,
    stateFile: `${dir}/state.json`,
    enabled: true,
    match: { transcriptsDirs: [], sessionIds: [] },
    stoppedAt: null,
    spoolUntil: null,
    updatedAt: 1,
    ...overrides,
  };
}

describe('readNudgeTarget', () => {
  it('accepts a node state of this instance with a valid port', () => {
    expect(readNudgeTarget(routeWithState({ engine: 'node', instanceId: ID, port: 18950 }))).toEqual({
      instanceId: ID,
      port: 18950,
    });
  });

  it.each([
    ['legacy engine', { instanceId: ID, port: 18950 }],
    ['another instance', { engine: 'node', instanceId: 'other', port: 18950 }],
    ['port 0', { engine: 'node', instanceId: ID, port: 0 }],
    ['port 65536', { engine: 'node', instanceId: ID, port: 65536 }],
    ['a fractional port', { engine: 'node', instanceId: ID, port: 80.5 }],
    ['a string port', { engine: 'node', instanceId: ID, port: '80' }],
    ['not an object', 'null'],
    ['invalid JSON', '{'],
  ])('rejects %s', (_name, state) => {
    expect(readNudgeTarget(routeWithState(state))).toBeNull();
  });

  it('rejects a stopped route and a state file over 4 KiB', () => {
    const state = { engine: 'node', instanceId: ID, port: 18950 };
    expect(readNudgeTarget(routeWithState(state, { stoppedAt: 5 }))).toBeNull();
    expect(readNudgeTarget(routeWithState({ ...state, pad: 'x'.repeat(5000) }))).toBeNull();
  });
});

describe('nudge', () => {
  it('posts only the instance id and settles on the answer', async () => {
    const port = await allocatePort();
    const seen: { method: string | undefined; url: string | undefined; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
        res.statusCode = 204;
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    await nudge({ instanceId: ID, port });
    await waitFor(() => seen.length === 1, { what: 'the request' });
    expect(seen[0]).toEqual({ method: 'POST', url: '/api/v3/ingest/nudge', body: JSON.stringify({ instanceId: ID }) });
  });

  it('settles within the timeout when the server never answers, and when nothing listens', async () => {
    const port = await allocatePort();
    const server = createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const started = performance.now();
    await nudgeAll([{ instanceId: ID, port }], 100);
    expect(performance.now() - started).toBeLessThan(2000);
    const closed = await allocatePort();
    await expect(nudge({ instanceId: ID, port: closed }, 300)).resolves.toBeUndefined();
  });
});
