// Request guards of the local server (05 5.3 S-NET, ADR 0045; the codes and the envelope are 03 5.2). The server binds
// 127.0.0.1 and holds transcripts, so a web page in the user's browser is the attacker: DNS rebinding (an evil name that
// resolves to 127.0.0.1), CSRF (a page that POSTs here) and cross-origin reads. The defence is exact, not clever:
//   - `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (ASCII case folded, nothing else, one Host header);
//   - `Origin`, when present, must be `http://127.0.0.1:<port>` or `http://localhost:<port>` and nothing else (`null`
//     and an empty value are refused); the list has no configuration key (I-31), dev mode works because the Vite proxy
//     rewrites `Origin`;
//   - `Sec-Fetch-Site: cross-site` is refused on every method, `same-site` on every method but GET (another localhost
//     port is same-site);
//   - the URL is at most 8192 characters;
//   - a mutation (any method but GET and HEAD) needs `Content-Type: application/json` and `X-MCS-Request: 1`; the route adapter
//     mounts `csrfGuard` on every POST except the hook nudge, so a new write route cannot skip it (ADR 0084);
//   - the hook nudge is the one data-free POST: JSON, no `Origin` header at all, at most 256 bytes, `{"instanceId"}` of
//     this server and nothing else;
//   - no response ever carries an `Access-Control-*` header: nothing here sets one.
// Order (03 5.2): requestContext, hostGuard, originGuard, uriLimit, then route matching (`optionsGuard`,
// `methodNotAllowed`), then the guards of single routes (`csrfGuard`, `nudgeGuard`). `guardChain` is the first four.
// Every refusal is the uniform envelope `{ error: { code, message, requestId } }` with a fixed English message per
// code: never request data, never a path, never a stack.
import { randomInt } from 'node:crypto';

import {
  ERROR_HTTP_STATUS,
  NudgeBodySchema,
  REQUEST_ID_RE,
  UUID_V4_RE,
  systemClock,
  type Clock,
  type ErrorCode,
  type ErrorDetail,
  type ErrorEnvelope,
} from '@mcs/shared';
import type { Request, RequestHandler, Response } from 'express';

/** Longest URL (`req.originalUrl`, query string included) the server answers. */
export const MAX_URL_LENGTH = 8192;
/** Largest body of the hook nudge, in bytes. */
export const NUDGE_MAX_BODY_BYTES = 256;

const REQUEST_ID_HEADER = 'X-Request-Id';
const MUTATION_HEADER = 'x-mcs-request';

// ---- the envelope -----------------------------------------------------------------------------------------------------

/** The codes the guards can send. Every one is a value of the shared `ErrorCode`. */
export type GuardErrorCode = Extract<
  ErrorCode,
  | 'host_not_allowed'
  | 'origin_not_allowed'
  | 'cross_site_request'
  | 'csrf_rejected'
  | 'uri_too_long'
  | 'method_not_allowed'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'body_invalid_json'
  | 'validation_failed'
  | 'instance_mismatch'
>;

/** One fixed English sentence per code (03 5.2: numbers allowed, never request values). */
export const GUARD_ERROR_MESSAGES: Readonly<Record<GuardErrorCode, string>> = {
  host_not_allowed: 'The Host header is not allowed.',
  origin_not_allowed: 'The Origin header is not allowed.',
  cross_site_request: 'Cross-site requests are not allowed.',
  csrf_rejected: 'A JSON content type and the X-MCS-Request header are required.',
  uri_too_long: `The request URL is longer than ${String(MAX_URL_LENGTH)} characters.`,
  method_not_allowed: 'This method is not allowed for this path.',
  unsupported_media_type: 'The request body must be application/json.',
  payload_too_large: 'The request body is too large.',
  body_invalid_json: 'The request body is not valid JSON.',
  validation_failed: 'The request does not have the expected shape.',
  instance_mismatch: 'The instance id does not belong to this server.',
};

export interface GuardErrorOptions {
  /** The `Allow` header of a 405. */
  readonly allow?: readonly string[];
  /** `{ path, issue }` entries: where and the validation issue code, never the rejected value. */
  readonly details?: readonly ErrorDetail[];
  /** Ask the client to drop the connection (a body that was refused unread). */
  readonly closeConnection?: boolean;
}

function newRequestId(): string {
  let id = 'r-';
  for (let i = 0; i < 12; i += 1) id += randomInt(36).toString(36);
  return id;
}

/** The request id of this response: the one `requestContext` set, or a new one stamped now. */
function requestIdOf(res: Response): string {
  const current = res.getHeader(REQUEST_ID_HEADER);
  if (typeof current === 'string' && REQUEST_ID_RE.test(current)) return current;
  const id = newRequestId();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/** Sends the uniform error envelope for a guard code (status from the shared catalogue) and ends the response. */
export function sendGuardError(res: Response, code: GuardErrorCode, opts: GuardErrorOptions = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const error: ErrorEnvelope['error'] = {
    code,
    message: GUARD_ERROR_MESSAGES[code],
    requestId: requestIdOf(res),
  };
  const envelope: ErrorEnvelope =
    opts.details === undefined || opts.details.length === 0
      ? { error }
      : { error: { ...error, details: [...opts.details] } };
  if (opts.allow !== undefined) res.setHeader('Allow', opts.allow.join(', '));
  if (opts.closeConnection === true) res.setHeader('Connection', 'close');
  res.status(ERROR_HTTP_STATUS[code]).json(envelope);
}

// ---- request context --------------------------------------------------------------------------------------------------

export interface RequestInfo {
  readonly requestId: string;
  /** Logger-clock time at which the request reached `requestContext`. */
  readonly startedAtMs: number;
}

const infos = new WeakMap<object, RequestInfo>();

/** What `requestContext` recorded for this response (request id and start time), for logging and handlers. */
export function requestInfo(res: Response): RequestInfo | undefined {
  return infos.get(res);
}

export interface RequestContextOptions {
  /** `instanceId` of the instance this server runs (`X-MCS-Instance`). */
  readonly instanceId: string;
  /** `<runtimeVersion>+<codeStamp>` (`X-MCS-Runtime`). */
  readonly runtime: string;
  readonly clock?: Clock;
  /** Tests only: the id generator (`r-` and twelve base36 characters). */
  readonly newRequestId?: () => string;
}

const RUNTIME_STAMP_RE = /^[\w.+-]{1,128}$/;

/** 03 5.2 step 1: request id, start time, `X-MCS-Instance`, `X-MCS-Runtime` on every response. */
export function requestContext(opts: RequestContextOptions): RequestHandler {
  if (!UUID_V4_RE.test(opts.instanceId)) throw new RangeError('requestContext: instanceId is not a lowercase uuid v4');
  if (!RUNTIME_STAMP_RE.test(opts.runtime)) throw new RangeError('requestContext: runtime is not a version stamp');
  const clock = opts.clock ?? systemClock;
  const makeId = opts.newRequestId ?? newRequestId;
  return (_req, res, next) => {
    const requestId = makeId();
    infos.set(res, { requestId, startedAtMs: clock.now() });
    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.setHeader('X-MCS-Instance', opts.instanceId);
    res.setHeader('X-MCS-Runtime', opts.runtime);
    next();
  };
}

// ---- Host and Origin --------------------------------------------------------------------------------------------------

/** The bound port, or a function that reads it when a request arrives (the server may scan for a free port first). */
export type PortSource = number | (() => number);

/** The port a `PortSource` names right now. */
export function portOf(source: PortSource): number {
  return typeof source === 'function' ? source() : source;
}

/** ASCII-only lower-casing: no other character may fold into the letters of `localhost` (Unicode case folding would). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/** The only two `Host` values the server answers. */
export function allowedHosts(port: number): readonly [string, string] {
  return [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
}

/** The only two `Origin` values the server accepts: exactly these, no configuration. */
export function allowedOrigins(port: number): readonly [string, string] {
  return [`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`];
}

/** `Host` equals one of `allowedHosts(port)`, ignoring ASCII case. Absent, empty and every other value are refused. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const lower = asciiLower(host);
  return allowedHosts(port).includes(lower);
}

/** `Origin` equals one of `allowedOrigins(port)` exactly. `null`, an empty value and an absent header are refused here. */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return origin !== undefined && allowedOrigins(port).includes(origin);
}

/** How many headers of this name the request really carried (the parsed `req.headers` keeps one of several). */
function countHeader(req: Request, name: string): number {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (asciiLower(req.rawHeaders[i] ?? '') === name) count += 1;
  }
  return count;
}

/**
 * 03 5.2 step 2 (S-NET-2): DNS-rebinding defence. One Host header, exactly an allowed value. A page that reached the
 * server through a rebound name is same-origin with its own name and can read the refusal, so that refusal carries no
 * instance id and no runtime stamp: only the request id stays.
 */
export function hostGuard(source: PortSource): RequestHandler {
  return (req, res, next) => {
    if (countHeader(req, 'host') !== 1 || !isAllowedHost(req.headers.host, portOf(source))) {
      res.removeHeader('X-MCS-Instance');
      res.removeHeader('X-MCS-Runtime');
      sendGuardError(res, 'host_not_allowed');
      return;
    }
    next();
  };
}

/** The first value of a header that Node may have joined (`a, b`); here any join is already a mismatch. */
export function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * 03 5.2 step 3 (S-NET-3, S-NET-4): `Origin` when present, then fetch metadata. A present but empty `Origin` is a
 * present one, and is refused.
 */
export function originGuard(source: PortSource): RequestHandler {
  return (req, res, next) => {
    const origin = headerText(req.headers.origin);
    if (origin !== undefined && !isAllowedOrigin(origin, portOf(source))) {
      sendGuardError(res, 'origin_not_allowed');
      return;
    }
    const site = headerText(req.headers['sec-fetch-site']);
    if (site !== undefined) {
      const value = asciiLower(site);
      if (value === 'cross-site' || (value === 'same-site' && req.method !== 'GET')) {
        sendGuardError(res, 'cross_site_request');
        return;
      }
    }
    next();
  };
}

/** 03 5.2 step 4 (S-NET-6): `req.originalUrl` longer than `max` (default 8192) is 414. */
export function uriLimit(max: number = MAX_URL_LENGTH): RequestHandler {
  return (req, res, next) => {
    if (req.originalUrl.length > max) {
      sendGuardError(res, 'uri_too_long');
      return;
    }
    next();
  };
}

export interface GuardChainOptions extends RequestContextOptions {
  readonly port: PortSource;
}

/** Steps 1 to 4 of 03 5.2, in order: `app.use(...guardChain(...))` before anything else. */
export function guardChain(opts: GuardChainOptions): RequestHandler[] {
  return [requestContext(opts), hostGuard(opts.port), originGuard(opts.port), uriLimit()];
}

// ---- methods ----------------------------------------------------------------------------------------------------------

const DEFAULT_ALLOW: readonly string[] = ['GET', 'HEAD'];

/** A handler for a known path that does not take this method: 405 with `Allow`, and no CORS header. */
export function methodNotAllowed(allow: readonly string[]): RequestHandler {
  return (_req, res) => {
    sendGuardError(res, 'method_not_allowed', { allow });
  };
}

/**
 * `OPTIONS` is never answered the way Express does by default (200 with `Allow`): it is 405 with `Allow` and no CORS
 * header, so a preflight can never succeed. `allowFor` names the methods of a path (default GET, HEAD).
 */
export function optionsGuard(allowFor: (req: Request) => readonly string[] = () => DEFAULT_ALLOW): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'OPTIONS') {
      next();
      return;
    }
    sendGuardError(res, 'method_not_allowed', { allow: allowFor(req) });
  };
}

// ---- mutations --------------------------------------------------------------------------------------------------------

/** `application/json`, with or without parameters (`; charset=utf-8`), ASCII case folded. Nothing like `jsonx`. */
export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const mediaType = asciiLower(value.split(';', 1)[0] ?? '').trim();
  return mediaType === 'application/json';
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * S-NET-5: a request from the UI that changes anything needs `Content-Type: application/json` and `X-MCS-Request: 1`;
 * a plain HTML form or a simple cross-origin request can send neither. `registerRoute` mounts it on every POST route except
 * the hook nudge (which has its own guard). A refusal closes the connection: the body of a refused write is never read.
 */
export function csrfGuard(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const marker = headerText(req.headers[MUTATION_HEADER]);
    if (!isJsonContentType(req.headers['content-type']) || marker !== '1') {
      sendGuardError(res, 'csrf_rejected', { closeConnection: true });
      return;
    }
    next();
  };
}

// ---- the hook nudge ---------------------------------------------------------------------------------------------------

export type BodyRead = { kind: 'ok'; bytes: Buffer } | { kind: 'too_large' } | { kind: 'aborted' };

/**
 * Reads at most `maxBytes` of the request body, deciding from `Content-Length` first and from the bytes after. A body that
 * is too large or a connection that ends first stops the reading at once: nothing past the limit is buffered. The caller
 * answers `too_large` with the connection closed and says nothing for `aborted` (nobody is listening).
 */
export function readCapped(req: Request, maxBytes: number): Promise<BodyRead> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > maxBytes) return Promise.resolve({ kind: 'too_large' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAborted);
      req.off('close', onAborted);
      if (result.kind !== 'ok') req.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += bytes.length;
      if (total > maxBytes) finish({ kind: 'too_large' });
      else chunks.push(bytes);
    };
    const onEnd = (): void => {
      finish({ kind: 'ok', bytes: Buffer.concat(chunks, total) });
    };
    const onAborted = (): void => {
      finish({ kind: 'aborted' });
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onAborted);
    req.once('close', onAborted);
  });
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Strict UTF-8 JSON: invalid bytes, a byte order mark, an empty body and trailing text are all "not JSON". */
export function parseJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    // Strict UTF-8 and no BOM: anything else is "not JSON". The parser's own message is never kept (E12: it echoes input).
    return { ok: true, value: JSON.parse(UTF8.decode(bytes)) };
  } catch {
    return { ok: false };
  }
}

async function checkNudge(req: Request, res: Response, instanceId: string, next: () => void): Promise<void> {
  if (!isJsonContentType(req.headers['content-type'])) {
    sendGuardError(res, 'unsupported_media_type');
    return;
  }
  if (req.headers.origin !== undefined) {
    sendGuardError(res, 'origin_not_allowed');
    return;
  }
  const body = await readCapped(req, NUDGE_MAX_BODY_BYTES);
  if (body.kind === 'aborted') return;
  if (body.kind === 'too_large') {
    sendGuardError(res, 'payload_too_large', { closeConnection: true });
    return;
  }
  const parsed = parseJson(body.bytes);
  if (!parsed.ok) {
    sendGuardError(res, 'body_invalid_json');
    return;
  }
  const shape = NudgeBodySchema.safeParse(parsed.value);
  if (!shape.success) {
    const details = shape.error.issues
      .slice(0, 10)
      .map((issue): ErrorDetail => ({ path: issue.path.map(String).join('.'), issue: issue.code }));
    sendGuardError(res, 'validation_failed', { details });
    return;
  }
  if (shape.data.instanceId !== instanceId) {
    sendGuardError(res, 'instance_mismatch');
    return;
  }
  // the body is consumed: the route adapter (`bodyConsumed`) takes the validated value from here instead of reading it again
  res.locals['body'] = shape.data;
  next();
}

export interface NudgeGuardOptions {
  /** The `instanceId` of this server; the only value a nudge may carry. */
  readonly instanceId: string;
}

/**
 * `POST /api/v3/ingest/nudge` (03 5.2 step 7, 02 2.8): answers every refusal itself and calls `next()` only for a valid
 * nudge. In this order: not JSON 415, any `Origin` header 403 (a browser always sends one on a cross-site POST; the hook
 * handler is not a browser), more than 256 bytes 413, not JSON text 400 `body_invalid_json`, not `{"instanceId"}` 400
 * `validation_failed`, another instance 409. The body is consumed here; the route handler answers 204 and schedules a drain.
 */
export function nudgeGuard(opts: NudgeGuardOptions): RequestHandler {
  return (req, res, next) => {
    checkNudge(req, res, opts.instanceId, next).catch((error: unknown) => {
      next(error);
    });
  };
}
