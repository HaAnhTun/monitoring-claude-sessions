// The dev server proxy of the web package (design 04 section 11, ADR 0097): `/api` also carries the terminal WebSocket, so the proxy
// upgrades connections (`ws: true`) and, on the upgrade request, presents the target's origin as it already does for plain requests:
// the server compares Origin with its own on the handshake (ADR 0087), and the browser's Origin is the dev server's.
import { describe, expect, it, vi } from 'vitest';

import viteConfig from '../../packages/web/vite.config.ts';

const ENV = { command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false } as const;

type Handler = (...args: never[]) => void;

interface FakeRequest {
  headers: Map<string, string>;
  getHeader(name: string): string | undefined;
  setHeader(name: string, value: string): void;
}

function fakeRequest(headers: Record<string, string> = {}): FakeRequest {
  const map = new Map(Object.entries(headers));
  return {
    headers: map,
    getHeader: (name) => map.get(name.toLowerCase()),
    setHeader: (name, value) => {
      map.set(name.toLowerCase(), value);
    },
  };
}

interface ApiProxy {
  target?: string;
  ws?: boolean;
  changeOrigin?: boolean;
  configure?: (proxy: unknown, options: unknown) => void;
}

function apiProxy(): ApiProxy {
  const proxy = viteConfig(ENV).server?.proxy?.['/api'];
  if (proxy === undefined || typeof proxy === 'string') throw new Error('the /api proxy is not an options object');
  return proxy as ApiProxy;
}

/** Runs `configure` against a recorder and returns the handlers it registered, by event name. */
function registered(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const recorder = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return recorder;
    },
  };
  apiProxy().configure?.(recorder, {});
  return handlers;
}

describe('the /api dev proxy', () => {
  it('forwards WebSocket upgrades, for the terminal socket', () => {
    expect(apiProxy().ws).toBe(true);
  });

  it('keeps rewriting the Host header to the target', () => {
    expect(apiProxy().changeOrigin).toBe(true);
  });

  it('points at the dev API, never at the legacy monitor port', () => {
    const target = apiProxy().target ?? '';
    expect(target).toBe('http://127.0.0.1:18765');
    expect(target).not.toMatch(/:8765$/);
  });

  it('registers a handler for plain requests and one for the upgrade request', () => {
    expect([...registered().keys()].sort()).toEqual(['proxyReq', 'proxyReqWs']);
  });

  it('presents the target origin on a plain request that has one', () => {
    const req = fakeRequest({ origin: 'http://127.0.0.1:18766' });
    (registered().get('proxyReq') as unknown as (r: FakeRequest) => void)(req);
    expect(req.getHeader('origin')).toBe(apiProxy().target);
  });

  it('presents the target origin on the WebSocket handshake that has one', () => {
    const req = fakeRequest({ origin: 'http://127.0.0.1:18766' });
    (registered().get('proxyReqWs') as unknown as (r: FakeRequest) => void)(req);
    expect(req.getHeader('origin')).toBe('http://127.0.0.1:18765');
  });

  it('adds no origin to a handshake that had none (a non-browser client keeps its own request)', () => {
    const req = fakeRequest();
    (registered().get('proxyReqWs') as unknown as (r: FakeRequest) => void)(req);
    expect(req.getHeader('origin')).toBeUndefined();
    const plain = fakeRequest();
    (registered().get('proxyReq') as unknown as (r: FakeRequest) => void)(plain);
    expect(plain.getHeader('origin')).toBeUndefined();
  });

  it('follows MCS_DEV_API for both requests', () => {
    vi.stubEnv('MCS_DEV_API', 'http://127.0.0.1:18999');
    try {
      const req = fakeRequest({ origin: 'http://127.0.0.1:18766' });
      (registered().get('proxyReqWs') as unknown as (r: FakeRequest) => void)(req);
      expect(req.getHeader('origin')).toBe('http://127.0.0.1:18999');
      expect(apiProxy().target).toBe('http://127.0.0.1:18999');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
