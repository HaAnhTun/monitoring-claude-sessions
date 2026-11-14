// The access guard and the verifier of the user instance (CAW design 02 3, 4.3 to 4.5, amendment A1, ADR 0084).
//   - `session`: a live session cookie of this instance, nothing else. The control token is not accepted here.
//   - `reader`: a live session cookie, or on GET and HEAD only the control token of `run/control.token` as `Authorization: Bearer`.
//     The header is never accepted on a write: a leaked token must not be able to start or stop anything through the API.
//   - `ticket`: no credential (the handler redeems the access code), only the Origin requirement.
// `requireOrigin` (every write, and the terminal socket) wants the `Origin` header present and exactly one of the two allowed
// origins; it runs first, so a request from another page is `403 origin_not_allowed` whatever it carries. A refused write is
// answered with the connection closed: its body is never read. A refusal repeats nothing the client sent and writes no log line
// (the access log has the route id, the status and the duration only).
// The guard says who was admitted in `res.locals.access`; `accessOf(res)` reads it.
import type { AccessService, AccessSession } from '@mcs/engine';
import type { RouteAccess } from '@mcs/shared';
import type { Request, RequestHandler, Response } from 'express';

import { sendError } from '../errors.ts';
import { cookieName, cookieValue } from './cookie.ts';
import { headerText, isAllowedOrigin, portOf, type PortSource } from './guards.ts';

/** What the guard needs to know about a request's credentials: the cookie of this instance and the Bearer value. */
export interface AccessVerifier {
  /** The live session of the cookie this instance set, or `null` (no cookie, another instance's cookie, junk, expired, revoked). */
  verify(req: Pick<Request, 'headers'>): AccessSession | null;
  /** True when the `Authorization` header is `Bearer <control token>`. */
  verifyBearer(req: Pick<Request, 'headers'>): boolean;
}

/** The verifier of one instance over the access service. A cookie of another name is never read and never reaches the service. */
export function createAccessVerifier(
  service: Pick<AccessService, 'verify' | 'verifyBearer'>,
  instanceId: string,
): AccessVerifier {
  const name = cookieName(instanceId);
  return {
    verify: (req) => {
      const credential = cookieValue(headerText(req.headers.cookie), name);
      return credential === null ? null : service.verify(credential);
    },
    verifyBearer: (req) => service.verifyBearer(headerText(req.headers.authorization)),
  };
}

/** Who was admitted: a session cookie, the control token, or nobody (the ticket route redeems a code in its handler). */
export type AccessContext =
  { readonly via: 'cookie'; readonly session: AccessSession } | { readonly via: 'bearer' } | { readonly via: 'ticket' };

/** What the guard recorded for this response, or `undefined` when no access guard admitted the request. */
export function accessOf(res: Pick<Response, 'locals'>): AccessContext | undefined {
  const value: unknown = res.locals['access'];
  if (typeof value !== 'object' || value === null) return undefined;
  const via: unknown = Reflect.get(value, 'via');
  if (via === 'bearer' || via === 'ticket') return { via };
  const session: unknown = Reflect.get(value, 'session');
  if (via === 'cookie' && typeof session === 'object' && session !== null) {
    const credentialId: unknown = Reflect.get(session, 'credentialId');
    const expiresAtMs: unknown = Reflect.get(session, 'expiresAtMs');
    if (typeof credentialId === 'string' && typeof expiresAtMs === 'number') {
      return { via: 'cookie', session: { credentialId, expiresAtMs } };
    }
  }
  return undefined;
}

export interface AccessGuardOptions {
  /** Which rule applies; `open` routes have no guard. */
  readonly access: Exclude<RouteAccess, 'open'>;
  /** The `Origin` header must be present and exact (every write, the socket). */
  readonly requireOrigin: boolean;
  /** The bound port, or a function that reads it when a request arrives. */
  readonly port: PortSource;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** The guard of one route; see the top of this file for the rules and the order of the checks. */
export function accessGuard(verifier: AccessVerifier, options: AccessGuardOptions): RequestHandler {
  return (req, res, next) => {
    const safe = SAFE_METHODS.has(req.method);
    // the body of a refused write is never read, so the connection is not kept for the next request
    const refusal = safe ? {} : { closeConnection: true };
    if (options.requireOrigin && !isAllowedOrigin(headerText(req.headers.origin), portOf(options.port))) {
      sendError(res, 'origin_not_allowed', refusal);
      return;
    }
    if (options.access === 'ticket') {
      res.locals['access'] = { via: 'ticket' } satisfies AccessContext;
      next();
      return;
    }
    const session = verifier.verify(req);
    if (session !== null) {
      res.locals['access'] = { via: 'cookie', session } satisfies AccessContext;
      next();
      return;
    }
    if (options.access === 'reader' && safe && verifier.verifyBearer(req)) {
      res.locals['access'] = { via: 'bearer' } satisfies AccessContext;
      next();
      return;
    }
    sendError(res, 'access_required', refusal);
  };
}
