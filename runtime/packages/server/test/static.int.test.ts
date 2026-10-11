// Static hosting of the web build and the history fallback (04 3.1 rule 4, 12.2, ADR 0039; registry section 3 "static"):
// the CSP of the HTML, the cache rules, `.vite/` and every other file that must not be served, path traversal on static
// paths, the methods, the guards on static paths, and the in-memory copy. A real instance and a real HTTP server.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  defaultSkillDir,
  initWorkspace,
  readSmallFile,
  type InstanceContext,
  type Logger,
} from '@mcs/engine';
import { ErrorEnvelopeSchema, RUNTIME_VERSION } from '@mcs/shared';
import { allocatePort, assertPortClosed, FakeClock, httpRequest, makeJunction, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp, createHttpServer, loadStaticSite, type StaticSite } from '../src/app.ts';
import { readLegacyTask } from '../src/routes/meta.ts';

/** The reply of the HTTP helper of the testkit (its type is not exported). */
type HttpReply = Awaited<ReturnType<typeof httpRequest>>;

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 11, 14, 5, 7);
const ID = '11111111-1111-4111-8111-111111111111';
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const INDEX_HTML =
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Claude session monitor</title>' +
  '<link rel="icon" href="data:,"><script src="/theme-init.js"></script>' +
  '<script type="module" src="/assets/index-abc123.js"></script></head><body><div id="root"></div></body></html>\n';

/** A synthetic web build, with the files that must never be served next to the ones that must. */
function buildDist(root: string): string {
  const dist = path.join(root, 'dist');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  mkdirSync(path.join(dist, '.vite'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), INDEX_HTML);
  writeFileSync(path.join(dist, 'theme-init.js'), '/* theme */\n');
  writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log("app");\n');
  writeFileSync(path.join(dist, 'assets', 'index-abc123.css'), 'body{margin:0}\n');
  writeFileSync(path.join(dist, 'assets', 'index-abc123.js.map'), '{"SECRET":"MAP-SENTINEL"}');
  writeFileSync(path.join(dist, '.vite', 'manifest.json'), '{"SECRET":"MANIFEST-SENTINEL"}');
  writeFileSync(path.join(dist, 'build-report.json'), '{"SECRET":"REPORT-SENTINEL"}');
  writeFileSync(path.join(root, 'secret.txt'), 'SECRET-OUTSIDE');
  return dist;
}

interface Running {
  readonly ctx: InstanceContext;
  readonly port: number;
  readonly root: string;
  readonly dist: string;
}

const live: { server: Server; ctx: InstanceContext; port: number }[] = [];
afterEach(async () => {
  for (const { server, ctx, port } of live.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    ctx.db.close();
    await assertPortClosed(port);
  }
});

function silentLogger(): Logger {
  const none = (): void => undefined;
  return {
    debug: none,
    info: none,
    warn: none,
    error: none,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

async function startInstance(withSite = true): Promise<Running> {
  const root = makeTemp('static-int').path;
  const dist = buildDist(root);
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => ID });
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: silentLogger(),
  });
  const site: StaticSite | null = withSite ? await loadStaticSite(dist) : null;
  const port = await allocatePort();
  const app = createApp({ ctx, port: () => port, nudge: () => undefined, task: await readLegacyTask(ws.dir), site });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  live.push({ server, ctx, port });
  return { ctx, port, root, dist };
}

function get(run: Running, route: string, accept?: string): Promise<HttpReply> {
  return httpRequest(run.port, route, accept === undefined ? {} : { headers: { Accept: accept } });
}

function isEnvelope404(reply: HttpReply): boolean {
  return reply.status === 404 && ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body)).success;
}

describe('the pages (04 12.1, 12.2)', () => {
  it('serves index.html at / and /index.html with the CSP of ADR 0039, no-store, nosniff and no referrer', async () => {
    const run = await startInstance();
    for (const route of ['/', '/index.html']) {
      const reply = await get(run, route);
      expect(reply.status, route).toBe(200);
      expect(reply.body, route).toBe(INDEX_HTML);
      expect(reply.headers['content-type'], route).toBe('text/html; charset=utf-8');
      expect(reply.headers['cache-control'], route).toBe('no-store');
      expect(reply.headers['content-security-policy'], route).toBe(CSP);
      expect(reply.headers['x-content-type-options'], route).toBe('nosniff');
      expect(reply.headers['referrer-policy'], route).toBe('no-referrer');
      expect(reply.headers['x-frame-options'], route).toBe('DENY');
    }
  });

  it('keeps the CSP free of inline script, inline style, remote sources and eval', async () => {
    const run = await startInstance();
    const csp = (await get(run, '/')).headers['content-security-policy'] ?? '';
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('serves theme-init.js no-store, and the hashed assets as immutable with their media types', async () => {
    const run = await startInstance();
    const theme = await get(run, '/theme-init.js');
    expect(theme.status).toBe(200);
    expect(theme.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(theme.headers['cache-control']).toBe('no-store');
    expect(theme.headers['content-security-policy']).toBeUndefined();
    const js = await get(run, '/assets/index-abc123.js');
    expect(js.status).toBe(200);
    expect(js.body).toBe('console.log("app");\n');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    const css = await get(run, '/assets/index-abc123.css');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const svg = await get(run, '/favicon.svg');
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['cache-control']).toBe('no-store');
  });

  it('answers 404 for an unknown file under /assets/, with no history fallback, even for a browser', async () => {
    const run = await startInstance();
    for (const route of ['/assets/missing.js', '/assets/', '/assets', '/assets/sub/missing.css']) {
      for (const accept of [undefined, HTML_ACCEPT]) {
        const reply = await get(run, route, accept);
        expect(isEnvelope404(reply), `${route} ${accept ?? ''}`).toBe(true);
        expect(reply.body, route).not.toContain('<html');
      }
    }
  });
});

describe('the history fallback (04 3.1 rule 4)', () => {
  it('returns index.html for a page path that accepts text/html, with no-store and the CSP', async () => {
    const run = await startInstance();
    for (const route of [
      '/sessions',
      '/sessions/6f1c0f1e-0000-4000-8000-000000000001',
      '/settings',
      '/tasks',
      '/health',
      '/a/b/c/d',
      '/sessions/',
    ]) {
      const reply = await get(run, route, HTML_ACCEPT);
      expect(reply.status, route).toBe(200);
      expect(reply.body, route).toBe(INDEX_HTML);
      expect(reply.headers['cache-control'], route).toBe('no-store');
      expect(reply.headers['content-security-policy'], route).toBe(CSP);
    }
    const query = await get(run, '/sessions?tab=transcript&i=3', HTML_ACCEPT);
    expect(query.status).toBe(200);
    expect(query.body).toBe(INDEX_HTML);
  });

  it('answers 404 JSON for a path that does not accept text/html', async () => {
    const run = await startInstance();
    for (const accept of [undefined, 'application/json', '*/*', 'image/png', 'text/css']) {
      const reply = await get(run, '/sessions', accept);
      expect(isEnvelope404(reply), accept ?? 'no Accept').toBe(true);
    }
  });

  it('never falls back for /api paths: an unknown route is the JSON 404 envelope, also for a browser', async () => {
    const run = await startInstance();
    for (const route of ['/api/v3/nope', '/api/sessions', '/api', '/api/', '/api/v3/', '/api/v3/sessions/x/nope']) {
      const reply = await get(run, route, HTML_ACCEPT);
      expect(isEnvelope404(reply), route).toBe(true);
      expect(reply.headers['cache-control'], route).toBe('no-store');
    }
  });

  it('serves the API routes as before when a site is mounted', async () => {
    const run = await startInstance();
    const reply = await get(run, '/api/health', HTML_ACCEPT);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ ok: true, engine: 'node' });
  });
});

describe('what is never served', () => {
  const SENTINELS = ['MANIFEST-SENTINEL', 'MAP-SENTINEL', 'REPORT-SENTINEL', 'SECRET-OUTSIDE', '"SECRET"'];

  it('.vite/, source maps and build-report.json: not by name, not by listing, not for a browser either', async () => {
    const run = await startInstance();
    const routes = [
      '/.vite/manifest.json',
      '/.vite/',
      '/.vite',
      '/%2evite/manifest.json',
      '/assets/../.vite/manifest.json',
      '/assets/index-abc123.js.map',
      '/build-report.json',
      '/.git/config',
      '/.env',
    ];
    for (const route of routes) {
      for (const accept of [undefined, HTML_ACCEPT]) {
        const reply = await get(run, route, accept);
        for (const sentinel of SENTINELS) expect(reply.body, `${route} ${sentinel}`).not.toContain(sentinel);
        if (accept === undefined) expect(reply.status, route).toBe(404);
        else expect(reply.body === INDEX_HTML || reply.status === 404, route).toBe(true);
      }
    }
  });

  it('path traversal on static paths: nothing outside the build, nothing but index.html or a 404', async () => {
    const run = await startInstance();
    const hostile = [
      '/../secret.txt',
      '/../../secret.txt',
      '/assets/../../secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/%2e%2e/secret.txt',
      '/..%5csecret.txt',
      '/assets/..%5c..%5csecret.txt',
      '/assets/%2E%2E%2F%2E%2E%2Fsecret.txt',
      '/%252e%252e/secret.txt',
      '/%00',
      '/assets/%00index-abc123.js',
      '/assets/index-abc123.js%00.png',
      '//secret.txt',
      '/assets//index-abc123.js',
      '/assets/./index-abc123.js',
      '/assets/index-abc123.js/',
      '/assets/index-abc123.js/..',
      '/secret.txt',
      '/dist/../secret.txt',
      '/C:/secret.txt',
      '/C%3A%5Csecret.txt',
      '/%c0%ae%c0%ae/secret.txt',
      '/assets/%ZZ',
      '/assets/index-abc123.js%2f..%2f..%2fsecret.txt',
    ];
    for (const route of hostile) {
      for (const accept of [undefined, HTML_ACCEPT]) {
        let reply: HttpReply;
        try {
          reply = await get(run, route, accept);
        } catch {
          continue; // the HTTP client itself refused to send it
        }
        for (const sentinel of SENTINELS) expect(reply.body, `${route} ${sentinel}`).not.toContain(sentinel);
        expect([200, 400, 404], route).toContain(reply.status);
        if (reply.status === 200) expect(reply.body, route).toBe(INDEX_HTML);
      }
    }
  });

  it('does not load a file behind a link inside the build', async () => {
    const root = makeTemp('static-link').path;
    const dist = buildDist(root);
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'leak.js'), 'SECRET-OUTSIDE');
    makeJunction(path.join(dist, 'assets', 'linked'), outside);
    const site = await loadStaticSite(dist);
    expect(site).not.toBeNull();
    expect([...(site?.files.keys() ?? [])].sort()).toEqual([
      '/assets/index-abc123.css',
      '/assets/index-abc123.js',
      '/favicon.svg',
      '/index.html',
      '/theme-init.js',
    ]);
  });
});

describe('methods and guards on static paths', () => {
  it('answers HEAD like GET without a body, POST to a known file with 405, and POST to an unknown path with 404', async () => {
    const run = await startInstance();
    const head = await httpRequest(run.port, '/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(INDEX_HTML)));
    for (const route of ['/', '/assets/index-abc123.js', '/theme-init.js']) {
      const reply = await httpRequest(run.port, route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(reply.status, route).toBe(405);
      expect(reply.headers['allow'], route).toBe('GET, HEAD');
    }
    const unknown = await httpRequest(run.port, '/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(isEnvelope404(unknown)).toBe(true);
    const preflight = await httpRequest(run.port, '/', { method: 'OPTIONS' });
    expect(preflight.status).toBe(405);
    expect(Object.keys(preflight.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
  });

  it('applies the Host and Origin guards to pages and assets', async () => {
    const run = await startInstance();
    for (const route of ['/', '/assets/index-abc123.js', '/sessions', '/theme-init.js']) {
      expect((await httpRequest(run.port, route, { host: 'evil.example' })).status, route).toBe(403);
      expect((await httpRequest(run.port, route, { origin: 'http://evil.example' })).status, route).toBe(403);
    }
    // a module script sends the Origin of the page: that is allowed
    const sameOrigin = await httpRequest(run.port, '/assets/index-abc123.js', {
      origin: `http://127.0.0.1:${String(run.port)}`,
    });
    expect(sameOrigin.status).toBe(200);
  });
});

describe('the in-memory copy and loadStaticSite', () => {
  it('keeps serving after the build folder was deleted (a rebuild or clean under a running server)', async () => {
    const run = await startInstance();
    rmSync(run.dist, { recursive: true, force: true });
    const page = await get(run, '/');
    expect(page.status).toBe(200);
    expect(page.body).toBe(INDEX_HTML);
    expect((await get(run, '/assets/index-abc123.js')).status).toBe(200);
  });

  it('answers 404 for the pages when no web build was loaded, and still serves the API', async () => {
    const run = await startInstance(false);
    expect(isEnvelope404(await get(run, '/', HTML_ACCEPT))).toBe(true);
    expect(isEnvelope404(await get(run, '/theme-init.js'))).toBe(true);
    expect((await get(run, '/api/health')).status).toBe(200);
  });

  it('is null for a missing folder and for a folder without index.html, and skips dot files, maps and the report', async () => {
    const root = makeTemp('static-load').path;
    expect(await loadStaticSite(path.join(root, 'does-not-exist'))).toBeNull();
    const empty = path.join(root, 'empty');
    mkdirSync(empty);
    writeFileSync(path.join(empty, 'theme-init.js'), 'x');
    expect(await loadStaticSite(empty)).toBeNull();
    const dist = buildDist(root);
    const site = await loadStaticSite(dist);
    const keys = [...(site?.files.keys() ?? [])];
    expect(keys.some((key) => key.includes('.vite') || key.endsWith('.map') || key.endsWith('build-report.json'))).toBe(
      false,
    );
    expect(keys).toContain('/index.html');
    expect(keys).toContain('/assets/index-abc123.js');
  });

  it('is null only when the folder or its index.html is absent: a folder that is a file, or lies under one, is absent too', async () => {
    const root = makeTemp('static-absent').path;
    const dist = buildDist(root);
    const aFile = path.join(dist, 'theme-init.js');
    expect(await loadStaticSite(aFile)).toBeNull();
    expect(await loadStaticSite(path.join(aFile, 'below'))).toBeNull();
  });

  it('rejects instead of answering "no build" when a file of the build cannot be read (a locked file is not an absent web UI)', async () => {
    const root = makeTemp('static-busy').path;
    const dist = buildDist(root);
    const busy = Object.assign(new Error('the file is busy'), { code: 'EBUSY' });
    const failOn =
      (name: string) =>
      async (file: string, maxBytes: number): Promise<Buffer> => {
        if (path.basename(file) === name) throw busy;
        return readSmallFile(file, maxBytes);
      };
    await expect(loadStaticSite(dist, failOn('index-abc123.js'))).rejects.toBe(busy);
    await expect(loadStaticSite(dist, failOn('index.html'))).rejects.toBe(busy);
    // the same folder loads when nothing fails: the failure above is the only reason for the rejection
    expect((await loadStaticSite(dist, failOn('nothing-is-called-this')))?.files.has('/index.html')).toBe(true);
  });

  it('refuses a file above 8 MiB', async () => {
    const root = makeTemp('static-big').path;
    const dist = buildDist(root);
    writeFileSync(path.join(dist, 'assets', 'huge.js'), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(loadStaticSite(dist)).rejects.toThrow(RangeError);
  });
});
