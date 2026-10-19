// The Express app of one instance (03 5.1, 5.2, 13; 04 3.1 rule 4 and 12.2; ADR 0039, ADR 0045): the guards in the order of
// 03 5.2, the headers of every response, route matching with 404 and 405, the route modules, the static web build with the
// history fallback, and the error mapper at the end of the chain. One process serves one instance, bound to 127.0.0.1 by the
// boot code (WP-18), which creates the HTTP server with `createHttpServer` (the limits and timeouts of ADR 0045).
//
// The route modules that work packages add are listed in `ROUTE_MODULES`. A package adds its modules in its own marked block
// below, at the top level of this file, with the import and the registration (plan section 4.2):
//   (inside its own marked block)
//   import { sessionRoutes } from './routes/sessions.ts';
//   ROUTE_MODULES.push(sessionRoutes);
import { lstat, readdir, stat } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import path from 'node:path';

import { readSmallFile, type Logger } from '@mcs/engine';
import type { RouteDefinition } from '@mcs/shared';
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { mapError, sendError } from './errors.ts';
import { guardChain, methodNotAllowed, optionsGuard, type PortSource } from './http/guards.ts';
import {
  bindRouteServices,
  defaultValidateResponses,
  mountedRoutes,
  type RouteDeps,
  type RouteModule,
} from './route-adapter.ts';
import { ingestRoutes } from './routes/ingest.ts';
import { metaRoutes } from './routes/meta.ts';

export type { LegacyTask, RouteDeps } from './route-adapter.ts';

/** The content security policy of every HTML response (04 12.2, ADR 0039): same-origin only, no inline script. */
export const HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

/** Limits and timeouts of the HTTP server (05 5.3 S-NET-6, ADR 0045). */
export const SERVER_LIMITS = {
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5000,
  /**
   * How often Node looks at `headersTimeout` and `requestTimeout`. It is a constructor option and cannot be changed later,
   * and its default of 30 s would turn the limit of 10 s into 30 s: a stalled client would hold a connection that long.
   */
  checkIntervalMs: 1000,
  maxHeadersCount: 64,
  maxConnections: 128,
} as const;

/** The three timings that a test may shorten; every other limit is fixed. All in milliseconds. */
export interface ServerTiming {
  readonly headersTimeoutMs?: number;
  readonly keepAliveTimeoutMs?: number;
  readonly checkIntervalMs?: number;
}

/**
 * The HTTP server of an instance, created with the limits of ADR 0045; the boot code listens on 127.0.0.1. `requestTimeoutMs`
 * is `server.requestTimeoutMs` (01 1.6, 1000..600000). The headers timeout never exceeds it (Node refuses a longer one). The
 * HTTP parser is never the lenient one (`insecureHTTPParser` stays off).
 */
export function createHttpServer(
  listener: RequestListener,
  requestTimeoutMs: number,
  timing: ServerTiming = {},
): Server {
  const server = createServer(
    {
      headersTimeout: Math.min(timing.headersTimeoutMs ?? SERVER_LIMITS.headersTimeoutMs, requestTimeoutMs),
      requestTimeout: requestTimeoutMs,
      keepAliveTimeout: timing.keepAliveTimeoutMs ?? SERVER_LIMITS.keepAliveTimeoutMs,
      connectionsCheckingInterval: timing.checkIntervalMs ?? SERVER_LIMITS.checkIntervalMs,
      insecureHTTPParser: false,
    },
    listener,
  );
  server.maxHeadersCount = SERVER_LIMITS.maxHeadersCount;
  server.maxConnections = SERVER_LIMITS.maxConnections;
  return server;
}

// ---- the static web build -------------------------------------------------------------------------------------------------

export interface StaticFile {
  readonly type: string;
  readonly body: Buffer;
}

/** The web build kept in memory (registry section 3 "static"): a rebuild or a `clean` under a running server changes nothing here. */
export interface StaticSite {
  /** Keyed by the URL path: `/index.html`, `/theme-init.js`, `/assets/app-1a2b3c.js`. */
  readonly files: ReadonlyMap<string, StaticFile>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const MAX_STATIC_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STATIC_TOTAL_BYTES = 64 * 1024 * 1024;
const NEVER_SERVED = new Set(['build-report.json']);

function contentTypeOf(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Reads one file of the build; the default is `readSmallFile` of the engine (it retries a busy file, ADR 0058). */
export type StaticReader = (file: string, maxBytes: number) => Promise<Buffer>;

function isAbsent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/**
 * Reads the web build (`packages/web/dist`) into memory. Dot files and folders (`.vite/`), source maps, `build-report.json`
 * and links are never loaded, so they can never be served (04 12.2); a file above 8 MiB or a build above 64 MiB is refused
 * (`RangeError`). `null` only when the folder or its `index.html` is absent: the API still works, the pages answer 404.
 * Any other failure (a file that stays locked by a scanner on Windows, a permission error, a folder that vanishes during the
 * walk) rejects, so that the boot code can log it instead of silently serving no web UI (ADR 0058 retries a busy file first).
 */
export async function loadStaticSite(webRoot: string, read: StaticReader = readSmallFile): Promise<StaticSite | null> {
  try {
    if (!(await stat(webRoot)).isDirectory()) return null;
  } catch (error: unknown) {
    if (isAbsent(error)) return null;
    throw error;
  }
  const files = new Map<string, StaticFile>();
  let total = 0;
  async function walk(dir: string, urlPrefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (name.startsWith('.') || NEVER_SERVED.has(name) || name.endsWith('.map')) continue;
      const file = path.join(dir, name);
      const info = await lstat(file);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(file, `${urlPrefix}${name}/`);
      } else if (info.isFile()) {
        if (info.size > MAX_STATIC_FILE_BYTES) throw new RangeError('a file of the web build is larger than 8 MiB');
        total += info.size;
        if (total > MAX_STATIC_TOTAL_BYTES) throw new RangeError('the web build is larger than 64 MiB');
        files.set(`${urlPrefix}${name}`, { type: contentTypeOf(name), body: await read(file, MAX_STATIC_FILE_BYTES) });
      }
    }
  }
  await walk(webRoot, '/');
  return files.has('/index.html') ? { files } : null;
}

const ASSET_CACHE = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store';

function isHtml(file: StaticFile): boolean {
  return file.type.startsWith('text/html');
}

function sendStatic(res: Response, file: StaticFile, cache: string): void {
  res.locals['routeId'] = 'static';
  res.setHeader('Content-Type', file.type);
  res.setHeader('Cache-Control', cache);
  if (isHtml(file)) res.setHeader('Content-Security-Policy', HTML_CSP);
  res.status(200).send(file.body);
}

/** `null` for a path that cannot be a key of the site: bad escapes, NUL, backslash, an empty, `.` or `..` segment. */
function staticKeyOf(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (
    !decoded.startsWith('/') ||
    decoded.includes(String.fromCharCode(0)) ||
    decoded.includes(String.fromCharCode(92))
  ) {
    return null;
  }
  const segments = decoded.slice(1).split('/');
  const last = segments.length - 1;
  // a trailing slash leaves one empty last segment (`/sessions/` is a page path); any other empty segment is refused
  const bad = segments.some(
    (segment, index) => segment === '.' || segment === '..' || (segment === '' && index !== last),
  );
  return bad ? null : decoded;
}

function isApiPath(urlPath: string): boolean {
  return urlPath === '/api' || urlPath.startsWith('/api/');
}

/**
 * 04 3.1 rule 4 and 12.2: `GET /` and the files of the build; `/assets/*` immutable; `index.html` and `theme-init.js` no-store;
 * an unknown file under `/assets/` is a 404 (no fallback); any other path that accepts `text/html` gets `index.html` (the
 * single page application routes it); nothing under `/api/`. Every answer comes from memory: no path reaches the file system.
 */
function staticMiddleware(site: StaticSite): RequestHandler {
  const index = site.files.get('/index.html');
  return (req, res, next) => {
    const key = staticKeyOf(req.path);
    if (key === null || isApiPath(key) || index === undefined) {
      next();
      return;
    }
    const file = key === '/' ? index : site.files.get(key);
    const isAsset = key === '/assets' || key.startsWith('/assets/');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (file !== undefined) sendError(res, 'method_not_allowed', { allow: ['GET', 'HEAD'] });
      else next();
      return;
    }
    if (file !== undefined) {
      sendStatic(res, file, isAsset ? ASSET_CACHE : NO_STORE);
      return;
    }
    if (isAsset) {
      next();
      return;
    }
    const accept = req.headers.accept ?? '';
    if (accept.toLowerCase().includes('text/html')) sendStatic(res, index, NO_STORE);
    else next();
  };
}

// ---- the app --------------------------------------------------------------------------------------------------------------

export interface AppDeps extends RouteDeps {
  /** The bound port (a number, or a function that reads it when a request arrives: the server may scan for a free port first). */
  readonly port: PortSource;
  /** The web build, or `null`/absent for an API-only server. */
  readonly site?: StaticSite | null;
  /** Default: on unless `NODE_ENV === 'production'` (registry N3). */
  readonly validateResponses?: boolean;
  /** Route modules mounted after the built-in ones, under the same guards and error mapper (tests and tooling). */
  readonly extraModules?: readonly RouteModule[];
}

/** The route modules `createApp` mounts, in this order; the blocks below add the modules of later work packages. */
const ROUTE_MODULES: RouteModule[] = [metaRoutes, ingestRoutes];

// @wp-begin WP-29
import { completionRoutes } from './routes/completion.ts';

ROUTE_MODULES.push(completionRoutes);
// @wp-end WP-29

// @wp-begin WP-30
import { agentRoutes } from './routes/agents.ts';
import { eventRoutes } from './routes/events.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { toolCallRoutes } from './routes/tool-calls.ts';

ROUTE_MODULES.push(sessionRoutes, agentRoutes, eventRoutes, toolCallRoutes);
// @wp-end WP-30

// @wp-begin WP-31
import { alertRoutes } from './routes/alerts.ts';
import { errorRoutes } from './routes/errors.ts';
import { overviewRoutes } from './routes/overview.ts';
import { workItemRoutes } from './routes/work-items.ts';

ROUTE_MODULES.push(overviewRoutes, workItemRoutes, alertRoutes, errorRoutes);
// @wp-end WP-31

// @wp-begin WP-33
import { transcriptRoutes } from './routes/transcript.ts';

ROUTE_MODULES.push(transcriptRoutes);
// @wp-end WP-33

// @wp-begin WP-36
import { streamRoutes } from './stream/sse.ts';

ROUTE_MODULES.push(streamRoutes);
// @wp-end WP-36

// @wp-begin WP-41
import { panelRoutes } from './routes/panels.ts';

ROUTE_MODULES.push(panelRoutes);
// @wp-end WP-41

// @wp-begin WP-57
import { searchRoutes } from './routes/search.ts';

ROUTE_MODULES.push(searchRoutes);
// @wp-end WP-57

// @wp-begin WP-58
import { analyticsRoutes } from './routes/analytics.ts';
import { sessionUsageRoutes } from './routes/sessions.ts';

ROUTE_MODULES.push(analyticsRoutes, sessionUsageRoutes);
// @wp-end WP-58

// @wp-begin WP-60
import { exportRoutes } from './routes/export.ts';

ROUTE_MODULES.push(exportRoutes);
// @wp-end WP-60

/** Every response: nosniff, no referrer, same-origin policies, no framing (03 5.1, ADR 0045); `/api/*` is never cached. */
const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (isApiPath(req.path)) res.setHeader('Cache-Control', 'no-store');
  next();
};

function routeIdOf(res: Response): string {
  const id: unknown = res.locals['routeId'];
  return typeof id === 'string' ? id : 'unmatched';
}

/**
 * One line per finished request: route id, method, status, duration and the request id of the `X-Request-Id` header. Nothing
 * else: the logger never sees a query string, a path value, a body or a search text (03 5.1 "Request id", DA-T-PRIV-4).
 * Successes are debug, client errors info, 5xx error.
 */
function accessLog(logger: Pick<Logger, 'debug' | 'info' | 'error'>, now: () => number): RequestHandler {
  return (req, res, next) => {
    const startedAtMs = now();
    res.once('finish', () => {
      const requestId = res.getHeader('X-Request-Id');
      const fields = {
        route: routeIdOf(res),
        method: req.method,
        status: res.statusCode,
        durationMs: Math.max(0, now() - startedAtMs),
        ...(typeof requestId === 'string' ? { requestId } : {}),
      };
      if (res.statusCode >= 500) logger.error('http_request', fields);
      else if (res.statusCode >= 400) logger.info('http_request', fields);
      else logger.debug('http_request', fields);
    });
    next();
  };
}

/** The methods a mounted path answers: GET also answers HEAD. */
function allowOf(routes: readonly RouteDefinition[]): ReadonlyMap<string, readonly string[]> {
  const methods = new Map<string, string[]>();
  for (const route of routes) {
    const list = methods.get(route.path) ?? [];
    list.push(...(route.method === 'GET' ? ['GET', 'HEAD'] : [route.method]));
    methods.set(route.path, list);
  }
  return methods;
}

const PATH_CHARACTERS = /^[A-Za-z0-9/:_-]+$/;

/** A matcher for the mounted paths, `:name` matching one segment: used to answer 405 with the right `Allow`. */
function pathMatcher(
  table: ReadonlyMap<string, readonly string[]>,
): (urlPath: string) => readonly string[] | undefined {
  const compiled = [...table].map(([routePath, methods]) => {
    if (!PATH_CHARACTERS.test(routePath))
      throw new Error(`route path ${routePath} has a character that is not allowed`);
    return { pattern: new RegExp(`^${routePath.replace(/:[A-Za-z0-9_]+/g, '[^/]+')}/?$`), methods };
  });
  return (urlPath) => compiled.find((entry) => entry.pattern.test(urlPath))?.methods;
}

const SHUTDOWN_EXEMPT = new Set(['/api/health', '/api/v3/health']);

/** Builds the Express app of an instance. The caller creates the HTTP server with `createHttpServer` and listens on 127.0.0.1. */
export function createApp(deps: AppDeps): Express {
  const { ctx } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('query parser', 'simple'); // a repeated key arrives as an array and is refused (param_repeated)
  app.set('case sensitive routing', true);
  bindRouteServices(app, {
    errors: ctx.errors,
    logger: ctx.logger,
    validateResponses: deps.validateResponses ?? defaultValidateResponses(),
  });

  app.use(securityHeaders);
  app.use(accessLog(ctx.logger, () => ctx.clock.now())); // before the guards: a refused request is logged too
  app.use(
    ...guardChain({
      instanceId: ctx.instanceId,
      runtime: `${ctx.process.runtimeVersion}+${ctx.process.bootCodeStamp}`,
      port: deps.port,
      clock: ctx.clock,
    }),
  );

  let allowed: (urlPath: string) => readonly string[] | undefined = () => undefined;
  const staticPaths = deps.site === undefined || deps.site === null ? undefined : deps.site.files;
  app.use(
    optionsGuard((req) => {
      const known = allowed(req.path) ?? (staticPaths?.has(req.path) === true ? ['GET', 'HEAD'] : undefined);
      return known ?? ['GET', 'HEAD'];
    }),
  );

  // a stopping server still answers the health routes: the CLI and the legacy readers probe them (01 4.10)
  app.use((req, res, next) => {
    if (isApiPath(req.path) && !SHUTDOWN_EXEMPT.has(req.path) && ctx.process.phase() === 'stopping') {
      sendError(res, 'shutting_down');
      return;
    }
    next();
  });

  const routeDeps: RouteDeps = { ctx, nudge: deps.nudge, task: deps.task, runtime: deps.runtime };
  for (const mount of [...ROUTE_MODULES, ...(deps.extraModules ?? [])]) mount(app, routeDeps);

  const table = allowOf(mountedRoutes(app));
  allowed = pathMatcher(table);
  for (const [routePath, methods] of table) app.all(routePath, methodNotAllowed(methods));

  if (deps.site !== undefined && deps.site !== null) app.use(staticMiddleware(deps.site));

  app.use((_req: Request, res: Response) => {
    sendError(res, 'route_not_found');
  });

  const failure: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      // the answer began before the failure: the default handler of Express closes the connection
      next(error);
      return;
    }
    const mapped = mapError(error);
    if (mapped.internal) {
      const where = routeIdOf(res);
      ctx.errors.push({ source: 'server', code: 'INTERNAL', where, message: 'unexpected error in the HTTP layer' });
      ctx.logger.error('route_failed', { route: where, code: 'INTERNAL' });
    }
    sendError(res, mapped.code, mapped.details === undefined ? {} : { details: mapped.details });
  };
  app.use(failure);
  return app;
}
