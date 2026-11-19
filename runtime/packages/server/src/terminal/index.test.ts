// `createTerminalServer` (CAW-32, design 02 section 9): which routes its modules mount, what the upgrade registry is, and that
// `close()` ends the sockets and the streams once. The chain of the whole app, the real access service and the boot are covered by
// `test/terminal/terminal-security.int.test.ts` and `test/boot.int.test.ts`.
import type { FolderService, Logger } from '@mcs/engine';
import { ACCESS_POLICY, routes, type RouteId } from '@mcs/shared';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { FakeTerminalPorts } from '../../test/terminal/helpers/fake-terminal.ts';
import { createAccessVerifier } from '../http/access-guard.ts';
import { bindRouteServices, mountedRoutes, type RouteDeps } from '../route-adapter.ts';
import { createTerminalServer, type TerminalAccess, type TerminalServerOptions } from './index.ts';

const silent = (): void => undefined;
const logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: silent,
  info: silent,
  warn: silent,
  error: silent,
};

// FIXTURE: invented data for tests
const INSTANCE = '0b6f0f4e-6c1e-4a46-9d0a-0a5b3f7c9e11';
const EPOCH = 'a1b2c3d4';
const NOW = Date.UTC(2026, 10, 14, 10, 0, 0);

interface FakeAccess extends TerminalAccess {
  readonly listeners: Set<(credentialId: string) => void>;
}

function fakeAccess(): FakeAccess {
  const listeners = new Set<(credentialId: string) => void>();
  return {
    listeners,
    exchange: () => ({ ok: false, reason: 'invalid' }),
    verify: () => null,
    verifyBearer: () => false,
    revoke: silent,
    onRevoked: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const folders = {
  list: () => ({ folders: [], generatedAt: '2026-11-14T10:00:00.000Z' }),
  add: () => Promise.reject(new Error('unused')),
  remove: () => Promise.reject(new Error('unused')),
  resumeEligibility: () => Promise.reject(new Error('unused')),
} as unknown as Pick<FolderService, 'list' | 'add' | 'remove' | 'resumeEligibility'>;

function options(over: Partial<TerminalServerOptions> = {}): TerminalServerOptions {
  return {
    ctx: { instanceId: INSTANCE, clock: { now: () => NOW }, db: { epoch: EPOCH } } as TerminalServerOptions['ctx'],
    ports: new FakeTerminalPorts(),
    access: fakeAccess(),
    logger,
    ...over,
  };
}

/** The ids of the routes the modules register on an app bound to a verifier. */
function mountedIds(server: ReturnType<typeof createTerminalServer>, access: TerminalAccess): RouteId[] {
  const app = express();
  bindRouteServices(app, {
    errors: { push: silent },
    logger,
    validateResponses: true,
    access: { verifier: createAccessVerifier(access, INSTANCE), port: () => 1 },
  });
  const deps = { ctx: { logger }, nudge: silent, task: null } as unknown as RouteDeps;
  for (const mount of server.modules) mount(app, deps);
  const known = (id: string): id is RouteId => id in routes;
  return mountedRoutes(app)
    .map((route) => route.id)
    .filter(known);
}

describe('createTerminalServer: the routes', () => {
  it('mounts the auth, terminal, event and socket routes, and no folder route without a folder service', () => {
    const o = options();
    const ids = mountedIds(createTerminalServer(o), o.access);
    expect(ids).toEqual(
      expect.arrayContaining([
        'authSession',
        'authExchange',
        'authLogout',
        'terminalState',
        'terminalEvents',
        'terminalCreateSession',
        'terminalKillSession',
        'terminalSocket',
        'terminalPickFolder',
        'terminalResume',
      ]),
    );
    expect(ids).not.toContain('listFolders');
    expect(ids).not.toContain('sessionResume');
  });

  it('adds the four folder routes beside a folder service', () => {
    const o = options({ folders });
    const ids = mountedIds(createTerminalServer(o), o.access);
    expect(ids).toEqual(expect.arrayContaining(['listFolders', 'addFolder', 'removeFolder', 'sessionResume']));
  });

  it('mounts nothing twice and nothing that is open besides the session probe: every other route needs a credential', () => {
    const o = options({ folders });
    const ids = mountedIds(createTerminalServer(o), o.access);
    expect(new Set(ids).size).toBe(ids.length);
    const open = ids.filter((id) => ACCESS_POLICY[id] === 'open');
    expect(open).toEqual(['authSession']);
    expect(ids.every((id) => id in routes)).toBe(true);
  });

  it('still mounts every route for an instance without a host: the routes answer terminal_unavailable themselves', () => {
    const o = options({ ports: null });
    expect(mountedIds(createTerminalServer(o), o.access)).toContain('terminalSocket');
  });
});

describe('createTerminalServer: the upgrade registry and close()', () => {
  it('hands out the registry the socket route reads the head bytes from, as an upgrade listener factory', () => {
    const server = createTerminalServer(options());
    expect(typeof server.upgrades.listener(() => undefined)).toBe('function');
    expect(server.upgrades.take({} as never)).toBeUndefined();
  });

  it('close() is safe before any request, may be called twice, and resolves with the same work', async () => {
    const server = createTerminalServer(options());
    const first = server.close();
    const second = server.close();
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });

  it('close() resolves at once with no socket open (nothing waits for a grace period)', async () => {
    const spy = vi.useFakeTimers();
    try {
      const server = createTerminalServer(options());
      let done = false;
      void server.close().then(() => {
        done = true;
      });
      await spy.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
