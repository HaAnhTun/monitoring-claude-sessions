// The session cookie of the user instance (CAW design 02 4.3, amendment A2, ADR 0084). The exact strings are built in two functions
// and nowhere else, and the parser reads only its own name:
//   - the name is `caw_` and the first eight hex characters of the instance id: cookies are scoped by host, not by port, so the
//     servers on `127.0.0.1:7690` and `127.0.0.1:8765` share one jar and each must read only its own cookie;
//   - `Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`, no `Domain` (host only), no `Secure` (plain-HTTP loopback cannot rely on
//     it in every browser, and `__Host-` needs it), no `Expires`;
//   - the value is a credential of the access service: 43 base64url characters, never the access code.
// The parser is small on purpose (no `cookie` dependency): split on `;`, trim, the first exact name wins, the value must have the
// shape of a credential or the cookie is absent, and a header over 4 KiB is absent.
import { UUID_V4_RE } from '@mcs/shared';

/** The cookie lives as long as the credential does: 24 hours (A2). */
export const COOKIE_MAX_AGE_SECONDS = 86_400;

/** A `Cookie` header longer than this is treated as absent (Node's own limit for all headers is 16 KiB). */
export const COOKIE_HEADER_MAX_CHARS = 4096;

/** The shape of a credential: 32 random bytes in base64url. An access code (32 to 128 characters) is not one. */
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{43}$/;

const ATTRIBUTES = 'Path=/; HttpOnly; SameSite=Strict';

/** `caw_<first 8 hex characters of the instance id>`; a value that is not a lowercase uuid v4 is a programming error. */
export function cookieName(instanceId: string): string {
  if (!UUID_V4_RE.test(instanceId)) throw new RangeError('cookieName: the instance id is not a lowercase uuid v4');
  return `caw_${instanceId.slice(0, 8)}`;
}

/** The `Set-Cookie` value that signs a browser in: `<name>=<credential>; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`. */
export function setCookieHeader(credential: string, instanceId: string): string {
  // a value that could carry a second attribute or a second header is refused before it is written; its text is never repeated
  if (!CREDENTIAL_RE.test(credential)) throw new RangeError('setCookieHeader: the value is not a credential');
  return `${cookieName(instanceId)}=${credential}; ${ATTRIBUTES}; Max-Age=${String(COOKIE_MAX_AGE_SECONDS)}`;
}

/** The `Set-Cookie` value that signs a browser out: the same name, path and flags, an empty value and `Max-Age=0`. */
export function clearCookieHeader(instanceId: string): string {
  return `${cookieName(instanceId)}=; ${ATTRIBUTES}; Max-Age=0`;
}

/**
 * The credential in the `Cookie` header under exactly `name`, or `null`. The first cookie of that name decides: when its value is
 * not a credential the answer is `null` and later cookies of the same name are not tried. A header over 4 KiB, a missing
 * header and a header that is not a string are absent.
 */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (typeof header !== 'string' || header.length > COOKIE_HEADER_MAX_CHARS) return null;
  for (const pair of header.split(';')) {
    const entry = pair.trim();
    const equals = entry.indexOf('=');
    if (equals < 0 || entry.slice(0, equals) !== name) continue;
    const value = entry.slice(equals + 1);
    return CREDENTIAL_RE.test(value) ? value : null;
  }
  return null;
}
