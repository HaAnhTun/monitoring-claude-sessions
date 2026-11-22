// The L2 terminal harness on every OS (design 08 section 3.2): the production app and upgrade listener of a user instance over the
// real engine host and terminal service, with a scripted pseudo terminal. These tests prove the harness itself: that what it
// returns is the real stack, that nothing it starts is a process, and that `close()` finds what a test leaves behind.
import { connect, createServer, type Socket } from 'node:net';

import { FAKE_KILLED_EXIT_CODE } from '@mcs/engine/testing';
import { TERMINAL_CLOSE_CODES } from '@mcs/shared';
import { allocatePort, assertPortClosed, waitFor } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { postExchange } from './helpers/auth.ts';
import {
  FAKE_FIRST_PID,
  HARNESS_INSTANCE_ID,
  closeTerminalHarnesses,
  startTerminalHarness,
  type TerminalHarness,
} from './helpers/terminal-harness.ts';

afterEach(closeTerminalHarnesses);

const SESSIONS = '/api/v3/terminal/sessions';

function field(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

async function createSession(h: TerminalHarness, folder: string = h.work): Promise<string> {
  const made = await h.http('POST', SESSIONS, { body: { path: folder } });
  expect(made.status, made.body).toBe(200);
  const name = field(made.json, 'session', 'name');
  if (typeof name !== 'string') throw new Error('the create route answered no session name');
  return name;
}

describe('startTerminalHarness: the real stack', () => {
  it('serves a user instance, and its cookie came from a real code through the real exchange route', async () => {
    const h = await startTerminalHarness();
    const health = await h.http('GET', '/api/v3/health', { cookie: null });
    expect(health.status).toBe(200);
    expect(field(health.json, 'instanceId')).toBe(HARNESS_INSTANCE_ID);
    const instance = await h.http('GET', '/api/v3/instance');
    expect(instance.status, instance.body).toBe(200);
    expect(instance.json).toMatchObject({ instanceId: HARNESS_INSTANCE_ID, kind: 'user', slug: 'user' });

    expect(field((await h.http('GET', '/api/v3/auth/session')).json, 'authenticated')).toBe(true);
    expect(field((await h.http('GET', '/api/v3/auth/session', { cookie: null })).json, 'authenticated')).toBe(false);
    // the code is single use: the exchange that made the cookie spent it
    const again = await postExchange(h.port, h.code);
    expect(again.status).toBe(401);
    expect(field(JSON.parse(again.body), 'error', 'code')).toBe('access_code_invalid');
    // a fresh code of the same service works, and a session route without a cookie is refused
    expect((await postExchange(h.port, h.access.mint().code)).status).toBe(200);
    expect((await h.http('GET', '/api/v3/terminal/state', { cookie: null })).status).toBe(401);
  });

  it('reports the capabilities of the real host: terminals available, no folder dialog, no sessions', async () => {
    const h = await startTerminalHarness();
    const state = await h.http('GET', '/api/v3/terminal/state');
    expect(state.status).toBe(200);
    expect(field(state.json, 'capabilities')).toMatchObject({ available: true, reason: null, folderPicker: false });
    expect(field(state.json, 'sessions')).toEqual([]);
    // the folder dialog and the native terminal window are not part of the harness: the routes say so and start nothing
    const picked = await h.http('POST', '/api/v3/terminal/pick-folder');
    expect(field(picked.json, 'error', 'code')).toBe('terminal_unavailable');
    const native = await h.http('POST', '/api/v3/terminal/open-native', {
      body: { sessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', fork: false },
    });
    expect(native.status).not.toBe(200);
    expect(h.backend.spawns).toHaveLength(0);
  });

  it('a session lives in the real service: created by the route, seen on the socket, written, resized and killed', async () => {
    const h = await startTerminalHarness();
    const name = await createSession(h);
    expect(h.backend.spawns).toHaveLength(1);
    const spawn = h.backend.spawns[0];
    // nothing was started: the pid is the scripted one, a number that no operating system hands out
    expect(spawn?.pty.pid).toBe(FAKE_FIRST_PID);
    expect(spawn?.env['TERM']).toBe('xterm-256color');
    const pty = h.backend.last;
    if (pty === undefined) throw new Error('no scripted terminal');

    const listed = await h.http('GET', '/api/v3/terminal/state');
    expect(field(listed.json, 'sessions')).toMatchObject([{ name, viewers: 0 }]);
    expect(h.ports.census.count()).toBe(1);

    pty.emitData('banner\r\n');
    const { client, ready, replay } = await h.ws(name);
    expect(ready).toMatchObject({ type: 'ready', viewers: 1 });
    expect(replay.toString('utf8')).toBe('banner\r\n');
    pty.emitData('live output');
    await client.until('live output');

    client.sendBinary(Buffer.from('typed\r'));
    await waitFor(() => pty.writtenText === 'typed\r', { what: 'the input to reach the pseudo terminal' });
    client.sendText(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }));
    await waitFor(() => pty.sizes.some((size) => size.cols === 100 && size.rows === 40), {
      what: 'the resize to reach the pseudo terminal',
    });

    const killed = await h.http('POST', `${SESSIONS}/${name}/kill`);
    expect(killed.status, killed.body).toBe(200);
    expect(pty.killCalls).toBe(1);
    expect(pty.exitCode).toBe(FAKE_KILLED_EXIT_CODE);
    await waitFor(() => client.closeInfo() !== null, { what: 'the socket to close after the kill' });
    expect(client.closeInfo()?.code).toBe(TERMINAL_CLOSE_CODES.killed);
    expect(client.texts().map((message) => field(message, 'type'))).toContain('exit');
    expect(field((await h.http('GET', '/api/v3/terminal/state')).json, 'sessions')).toEqual([]);
    expect(h.ports.census.count()).toBe(0);
  });

  it('the limits are the real ones: a configured terminal.maxSessions refuses the next create', async () => {
    const h = await startTerminalHarness({ terminal: { maxSessions: 1 } });
    // a folder that does not exist is refused by the engine before anything is spawned
    const missing = await h.http('POST', SESSIONS, { body: { path: `${h.work}-missing` } });
    expect(field(missing.json, 'error', 'code')).toBe('folder_invalid');
    expect(h.backend.spawns).toHaveLength(0);
    await createSession(h);
    const second = await h.http('POST', SESSIONS, { body: { path: h.work } });
    expect(second.status).not.toBe(200);
    expect(field(second.json, 'error', 'code')).toBe('terminal_limit');
    expect(h.backend.spawns).toHaveLength(1);
  });

  it('the fake clock is the clock of the access service: a code that is older than its lifetime is refused', async () => {
    const h = await startTerminalHarness();
    const minted = h.access.mint();
    h.clock.advance(minted.ttlSeconds * 1000 + 1000);
    expect((await postExchange(h.port, minted.code)).status).toBe(401);
  });

  it('writes neither the access code nor the cookie into the log of the instance', async () => {
    const h = await startTerminalHarness();
    await createSession(h);
    await h.http('POST', '/api/v3/auth/exchange', { body: { code: h.code }, cookie: null });
    const { code, cookie } = h;
    await h.close();
    // after the close this is the complete log: every line the instance wrote
    const log = h.readLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log.includes(code)).toBe(false);
    expect(log.includes(cookie.slice(cookie.indexOf('=') + 1))).toBe(false);
  });
});

describe('close(): nothing is left behind', () => {
  it('closes the port, the sockets a test left open and the sessions that were still live', async () => {
    const h = await startTerminalHarness();
    const name = await createSession(h);
    const { client } = await h.ws(name);
    const pty = h.backend.last;
    await h.close();
    await assertPortClosed(h.port);
    expect(pty?.exited).toBe(true);
    expect(client.closeInfo()?.code ?? TERMINAL_CLOSE_CODES.shuttingDown).toBe(TERMINAL_CLOSE_CODES.shuttingDown);
    // a second close is the same promise: nothing runs twice
    await expect(h.close()).resolves.toBeUndefined();
  });

  it('two harnesses in a row use the handles of one: the second starts and closes clean', async () => {
    const first = await startTerminalHarness();
    await createSession(first);
    await first.close();
    const second = await startTerminalHarness();
    expect(await createSession(second)).toMatch(/^[A-Za-z0-9._-]+$/);
    await second.close();
  });

  it('throws when a timer that was started while the harness ran is still there', async () => {
    const h = await startTerminalHarness();
    const leaked = setInterval(() => undefined, 60_000);
    try {
      await expect(h.close()).rejects.toThrow(/close\(\) left handles behind: Timeout x1$/);
    } finally {
      clearInterval(leaked);
    }
    await assertPortClosed(h.port);
  }, 20_000);

  it('a timer that does not keep the process alive (unref) is not a leak, and one that was cleared is none either', async () => {
    const h = await startTerminalHarness();
    const background = setInterval(() => undefined, 60_000);
    background.unref();
    const cleared = setInterval(() => undefined, 60_000);
    clearInterval(cleared);
    try {
      await expect(h.close()).resolves.toBeUndefined();
    } finally {
      clearInterval(background);
    }
  });

  it('what a second harness started is its own: closing the first while the second runs finds no leak', async () => {
    const first = await startTerminalHarness();
    const second = await startTerminalHarness();
    const name = await createSession(second);
    const { client } = await second.ws(name);
    await expect(first.close()).resolves.toBeUndefined();
    // the second is untouched by the close of the first
    second.backend.last?.emitData('still here');
    await client.until('still here');
    await expect(second.close()).resolves.toBeUndefined();
  });

  it('throws when a socket that was opened while the harness ran is still there', async () => {
    const h = await startTerminalHarness();
    // a connection of the test's own, to a listener of its own: the harness cannot know it, the leak check still sees it
    const port = await allocatePort();
    const accepted: Socket[] = [];
    const listener = createServer((socket) => accepted.push(socket));
    await new Promise<void>((resolve) => {
      listener.listen(port, '127.0.0.1', resolve);
    });
    const socket = connect({ port, host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      socket.once('connect', resolve);
    });
    try {
      await expect(h.close()).rejects.toThrow(/close\(\) left handles behind: .*TCPWRAP x\d/);
    } finally {
      socket.destroy();
      for (const peer of accepted) peer.destroy();
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
      await assertPortClosed(port);
    }
  }, 20_000);
});
