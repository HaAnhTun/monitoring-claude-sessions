// The auth routes of the user instance (CAW-19, design 02 4.1 and 4.4, ADR 0085): whether the page is signed in, the one exchange
// of the access code for the session cookie, and the logout. A task instance never mounts them (the boot code mounts this module
// only beside an access service).
//   - `authSession` is open and answers `{authenticated}` and nothing else: it reads the cookie of this instance, never the control
//     token and never a code.
//   - `authExchange` is a `ticket` route: the guards ahead of it (Host, Origin, csrf, a strict 4 KiB body) have passed, so the code
//     reaches the service only from the page. The service decides; the route adds no lock of its own, so a valid code redeems even
//     while the failure limiter answers wrong codes with 429 (design 02 amendment A3). The cookie is set with `append`, so it
//     never replaces another header.
//   - `authLogout` is a `session` route: the credential the guard admitted is revoked (its sockets and streams close through the
//     service listeners) and the cookie is cleared.
// Logging: only the events `ticket_exchanged` and `access_rate_limited`, with a count. A code, a credential, a cookie, a body and a
// refused (wrong) code are never logged.
import type { AccessService } from '@mcs/engine';
import { routes } from '@mcs/shared';

import { ApiError, sendError } from '../errors.ts';
import { accessOf, createAccessVerifier } from '../http/access-guard.ts';
import { clearCookieHeader, setCookieHeader } from '../http/cookie.ts';
import { registerRoute, type RouteModule } from '../route-adapter.ts';

/** What the routes ask of the access service. */
export type AuthAccess = Pick<AccessService, 'exchange' | 'verify' | 'verifyBearer' | 'revoke'>;

export interface AuthRoutesOptions {
  /** The access service of the user instance. */
  readonly access: AuthAccess;
  /** The instance id: it names the cookie. */
  readonly instanceId: string;
}

/** The module that mounts the three auth routes; `app.ts` or the boot code adds it beside the verifier of the same service. */
export function createAuthRoutes(options: AuthRoutesOptions): RouteModule {
  const { access, instanceId } = options;
  const verifier = createAccessVerifier(access, instanceId);
  return (app, { ctx }) => {
    registerRoute(app, routes.authSession, ({ req }) => ({ authenticated: verifier.verify(req) !== null }));

    registerRoute(app, routes.authExchange, ({ body, res }) => {
      const outcome = access.exchange(body.code);
      if (outcome.ok) {
        res.append('Set-Cookie', setCookieHeader(outcome.credential, instanceId));
        ctx.logger.info('ticket_exchanged', { count: 1 });
        return { authenticated: true };
      }
      if (outcome.reason === 'rate_limited') {
        ctx.logger.info('access_rate_limited', { count: 1 });
        // the wait goes into Retry-After, which `ApiError` cannot carry: the envelope is sent here and the adapter sees a response
        // that has begun, so the value returned below is never validated or written
        sendError(res, 'access_rate_limited', { retryAfterSeconds: outcome.retryAfterMs / 1000 });
        return { authenticated: true };
      }
      throw new ApiError('access_code_invalid');
    });

    registerRoute(app, routes.authLogout, ({ res }) => {
      const admitted = accessOf(res);
      // the session guard admits a cookie only; anything else here is a wiring fault and gets no answer of a signed-in kind
      if (admitted?.via !== 'cookie') throw new ApiError('access_required');
      access.revoke(admitted.session.credentialId);
      res.append('Set-Cookie', clearCookieHeader(instanceId));
      return { authenticated: false };
    });
  };
}
